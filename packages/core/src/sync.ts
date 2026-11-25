import { randomUUID } from "node:crypto";
import {
  accounts,
  addresses,
  and,
  attachments,
  type Db,
  desc,
  eq,
  folders,
  inArray,
  messageAddresses,
  messageFolders,
  messages,
  pgArray,
  sql,
  threads,
} from "@mailmcp/db";
import {
  type Connector,
  type EmailAddress,
  type Logger,
  type MessageEnvelope,
  type MessageFlags,
  type MessageRef,
  ProviderLimitError,
  type RemoteFolder,
} from "@mailmcp/module-sdk";
import type { MailDoc, SearchIndex } from "@mailmcp/search";
import { blobKeys } from "@mailmcp/storage";
import type { AccountRow, AccountService } from "./accounts";
import type { BlobService } from "./blobs";
import { friendlyError } from "./errors";
import { createLogger } from "./logger";
import { type ParsedBody, parseRaw, sha256, snippetOf } from "./parse";
import type { SettingsService } from "./settings";
import { parseUnsubscribe } from "./unsubscribe";

type FolderRow = typeof folders.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const ROLE_ORDER = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "starred",
  "important",
  null,
  "all",
  "spam",
  "trash",
];
const GMAIL_DAILY_BYTES = 2_000_000_000; // Gmail allows ~2.5 GB/day of IMAP download; keep headroom
const monthsAgo = (n: number) => new Date(Date.now() - n * 30.44 * 86_400_000);

/** Strip reply/forward prefixes so a thread keeps its original subject. */
export const baseSubject = (s?: string | null) =>
  (s ?? "").replace(/^\s*((re|fw|fwd|aw|wg|sv|antw)(\[\d+\])?\s*:\s*)+/i, "").trim() || null;

/** Thread key that's the same for every message in a conversation, in any arrival order. */
export function threadKey(e: MessageEnvelope): string {
  return (
    e.remoteThreadId ?? e.references?.[0] ?? e.inReplyTo ?? e.messageId ?? `solo:${e.remoteId}`
  );
}

export interface SyncDeps {
  db: Db;
  accounts: AccountService;
  settings: SettingsService;
  blobs: BlobService;
  search: SearchIndex;
  log?: Logger;
}

export interface SyncResult {
  skipped?: boolean;
  folders: number;
  upserts: number;
  removed: number;
  bodies: number;
  moreBodies: boolean;
}

// ───────────────────────────── Bodies ─────────────────────────────

export interface StoredBody extends ParsedBody {}

export class BodyService {
  constructor(private deps: SyncDeps) {}

  /** Best folder membership to fetch a message from (avoid Gmail "All Mail" when possible). */
  async locate(accountId: string, messageId: number) {
    return (await this.locateMany(accountId, [messageId])).get(messageId);
  }

  async locateMany(accountId: string, ids: number[]) {
    const rows = (await this.deps.db.execute(sql`
      SELECT DISTINCT ON (mf.message_id) mf.message_id, mf.remote_uid, f.id AS folder_id, f.remote_id, f.path, m.remote_id AS msg_remote_id
      FROM message_folders mf
      JOIN folders f ON f.id = mf.folder_id
      JOIN messages m ON m.account_id = mf.account_id AND m.id = mf.message_id
      WHERE mf.account_id = ${accountId} AND mf.message_id = ANY(${pgArray(ids, "bigint")})
      ORDER BY mf.message_id, (f.role IS NOT DISTINCT FROM 'all')`)) as unknown as Array<{
      message_id: string | number;
      remote_uid: string | number | null;
      folder_id: string | number;
      remote_id: string;
      path: string;
      msg_remote_id: string;
    }>;
    return new Map(
      rows.map((r) => [
        Number(r.message_id),
        {
          folder: {
            remoteId: r.remote_id,
            path: r.path,
            kind: "folder",
            selectable: true,
          } as RemoteFolder,
          folderId: Number(r.folder_id),
          ref: {
            remoteId: r.msg_remote_id,
            remoteUid: r.remote_uid ? Number(r.remote_uid) : undefined,
          },
        },
      ]),
    );
  }

  /** Download one message body now (used when someone opens a message that isn't cached). */
  async fetch(row: AccountRow, connector: Connector, messageId: number): Promise<number> {
    const r = await this.fetchBatch(row, connector, [messageId]);
    if (!r.stored.includes(messageId))
      throw new Error(r.errors.get(messageId) ?? "Message is not on the server any more");
    return r.bytes;
  }

  /**
   * Download many bodies with one round trip per folder, then parse/store/index them in
   * parallel. Returns which ids were stored and total bytes downloaded.
   */
  async fetchBatch(row: AccountRow, connector: Connector, ids: number[]) {
    const where = await this.locateMany(row.id, ids);
    const byFolder = new Map<
      string,
      { folder: RemoteFolder; items: Array<{ id: number; ref: MessageRef }> }
    >();
    for (const [id, w] of where) {
      const g = byFolder.get(w.folder.remoteId) ?? { folder: w.folder, items: [] };
      g.items.push({ id, ref: w.ref });
      byFolder.set(w.folder.remoteId, g);
    }
    const stored: number[] = [];
    const errors = new Map<number, string>();
    let bytes = 0;
    const pending: Promise<void>[] = [];
    const store = (id: number, raw: Buffer) =>
      this.store(row, id, raw).then(
        () => void stored.push(id),
        (e: Error) => void errors.set(id, e.message),
      );

    for (const { folder, items } of byFolder.values()) {
      const idByUid = new Map(items.map((i) => [i.ref.remoteUid, i.id]));
      if (connector.fetchMessages) {
        for await (const { ref, raw } of connector.fetchMessages(
          folder,
          items.map((i) => i.ref),
        )) {
          const id = idByUid.get(ref.remoteUid);
          if (id === undefined) continue;
          bytes += raw.length;
          pending.push(store(id, raw));
          if (pending.length >= 8) await Promise.all(pending.splice(0));
        }
      } else {
        for (const it of items) {
          const { raw } = await connector.fetchMessage(folder, it.ref);
          bytes += raw.length;
          pending.push(store(it.id, raw));
        }
      }
    }
    await Promise.all(pending);
    for (const id of ids)
      if (!stored.includes(id) && !errors.has(id)) errors.set(id, "Not found on server");
    return { stored, errors, bytes };
  }

  /** Parse, encrypt+store and index one raw message. */
  async store(row: AccountRow, messageId: number, raw: Buffer): Promise<void> {
    const { db, blobs, search, accounts: accountSvc } = this.deps;
    const parsed = await parseRaw(raw);
    const blobStore = await blobs.get();
    const key = accountSvc.dataKey(row);
    const rawKey = blobKeys.raw(row.orgId, row.id, sha256(raw));
    const bodyKey = blobKeys.body(row.orgId, row.id, messageId);
    await Promise.all([
      blobStore.put(rawKey, raw, key),
      blobStore.put(bodyKey, Buffer.from(JSON.stringify(parsed)), key),
    ]);

    const msg = await db.transaction(async (tx) => {
      const [m] = await tx
        .update(messages)
        .set({
          rawBlobKey: rawKey,
          bodyBlobKey: bodyKey,
          bodyState: "fetched",
          // Remember how to unsubscribe (null = no List-Unsubscribe header).
          headersExtra: sql`coalesce(${messages.headersExtra}, '{}'::jsonb) || ${JSON.stringify({
            unsubscribe: parseUnsubscribe(raw),
          })}::jsonb`,
          snippet: snippetOf(parsed.text),
          hasAttachments: parsed.attachments.some((a) => !a.inline),
        })
        .where(and(eq(messages.accountId, row.id), eq(messages.id, messageId)))
        .returning();
      await tx
        .delete(attachments)
        .where(and(eq(attachments.accountId, row.id), eq(attachments.messageId, messageId)));
      if (parsed.attachments.length) {
        await tx.insert(attachments).values(
          parsed.attachments.map((a) => ({
            accountId: row.id,
            messageId,
            partId: `idx:${a.index}`,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
            contentId: a.contentId,
            contentHash: a.sha256,
            blobKey: rawKey, // bytes live inside the raw message
          })),
        );
      }
      return m;
    });
    if (!msg) return;

    const recipients = await db
      .select({ email: addresses.email, name: addresses.name })
      .from(messageAddresses)
      .innerJoin(addresses, eq(addresses.id, messageAddresses.addressId))
      .where(
        and(eq(messageAddresses.accountId, row.id), eq(messageAddresses.messageId, messageId)),
      );
    await search.upsert([
      {
        accountId: row.id,
        messageId,
        folderIds: [],
        from: [msg.fromName, msg.fromEmail].filter(Boolean).join(" "),
        to: recipients.map((r) => [r.name, r.email].filter(Boolean).join(" ")),
        cc: [],
        subject: msg.subject ?? undefined,
        bodyText: parsed.text,
        attachmentNames: parsed.attachments.map((a) => a.filename).filter((f): f is string => !!f),
        date: msg.date,
        seen: msg.seen,
        flagged: msg.flagged,
        hasAttachments: parsed.attachments.length > 0,
      },
    ]);
  }

  /** Read a stored body; returns null if it hasn't been fetched yet. */
  async load(row: AccountRow, bodyBlobKey: string | null): Promise<StoredBody | null> {
    if (!bodyBlobKey) return null;
    const store = await this.deps.blobs.get();
    const buf = await store.get(bodyBlobKey, this.deps.accounts.dataKey(row));
    return buf ? (JSON.parse(buf.toString("utf8")) as StoredBody) : null;
  }

  async loadRaw(row: AccountRow, rawBlobKey: string | null): Promise<Buffer | null> {
    if (!rawBlobKey) return null;
    const store = await this.deps.blobs.get();
    return (await store.get(rawBlobKey, this.deps.accounts.dataKey(row))) ?? null;
  }
}

// ───────────────────────────── Sync ─────────────────────────────

export class SyncService {
  private log: Logger;
  readonly bodies: BodyService;

  constructor(private deps: SyncDeps) {
    this.log = deps.log ?? createLogger("sync");
    this.bodies = new BodyService(deps);
  }

  private async setStatus(
    accountId: string,
    status: (typeof accounts.$inferSelect)["status"],
    statusMessage: string | null,
    extra: Partial<typeof accounts.$inferInsert> = {},
  ) {
    await this.deps.db
      .update(accounts)
      .set({ status, statusMessage, ...extra })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Full sync of one account: folder list → each folder (headers, newest first) →
   * deletions/flags → orphan cleanup → body backfill within `bodyBudgetMs`.
   */
  async syncAccount(
    accountId: string,
    opts: { fullReconcile?: boolean; bodyBudgetMs?: number; signal?: AbortSignal } = {},
  ): Promise<SyncResult> {
    const { db, accounts: accountSvc, settings } = this.deps;
    const result: SyncResult = { folders: 0, upserts: 0, removed: 0, bodies: 0, moreBodies: false };
    const row = await accountSvc.byId(accountId);
    if (row.status === "disabled") return result;
    const log =
      (this.log as ReturnType<typeof createLogger>).child?.({ accountId, address: row.address }) ??
      this.log;
    const started = Date.now();

    // Cross-process lease: never run two syncs of the same account at once.
    const lease = randomUUID();
    if (!(await this.acquireLease(accountId, lease))) {
      log.info("sync skipped: already running elsewhere");
      return { ...result, skipped: true };
    }
    const heartbeat = setInterval(
      () => this.acquireLease(accountId, lease).catch(() => {}),
      60_000,
    );
    heartbeat.unref?.();

    await this.setStatus(accountId, "syncing", "Checking folders…");
    const connector = await accountSvc.connectorFor(row, opts.signal, log).catch(async (e) => {
      clearInterval(heartbeat);
      await this.releaseLease(accountId, lease);
      throw e;
    });
    try {
      const cfg = await settings.get("sync");
      const remote = await connector.listFolders();
      await accountSvc.upsertFolders(db, accountId, remote);
      const local = await db.select().from(folders).where(eq(folders.accountId, accountId));
      local.sort(
        (a, b) =>
          ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.path.localeCompare(b.path),
      );
      const since = cfg.headerBackfillMonths ? monthsAgo(cfg.headerBackfillMonths) : undefined;

      for (const folder of local) {
        if (opts.signal?.aborted) break;
        const rf = remote.find((r) => r.remoteId === folder.remoteId);
        if (!rf) continue;
        const r = await this.syncFolder(row, connector, folder, rf, {
          since,
          fullReconcile: opts.fullReconcile,
        });
        result.folders++;
        result.upserts += r.upserts;
        result.removed += r.removed;
      }
      result.removed += await this.cleanupOrphans(row);
      await this.repairThreads(row.id);

      await this.setStatus(accountId, "syncing", "Downloading message bodies…");
      const b = await this.backfillBodies(
        row,
        connector,
        cfg.bodyBackfillMonths,
        opts.bodyBudgetMs ?? 60_000,
        opts.signal,
      );
      result.bodies = b.fetched;
      result.moreBodies = b.more;

      const total = await this.countMessages(accountId);
      const note = b.limited
        ? "Gmail daily download limit reached; message bodies will continue tomorrow."
        : b.more
          ? `${total.toLocaleString()} messages indexed. Downloading message bodies…`
          : `${total.toLocaleString()} messages indexed.`;
      await this.setStatus(accountId, "ok", note, { lastSyncAt: new Date() });
      log.info("sync done", { ...result, ms: Date.now() - started });
      return result;
    } catch (err) {
      const f = friendlyError(err);
      if (err instanceof ProviderLimitError) {
        await this.setStatus(
          accountId,
          "throttled",
          `Provider rate limit: ${err.message}`.slice(0, 500),
        );
      } else {
        // failedAt: the scheduler retries a rejected login hourly, not every few minutes
        // (repeated failed logins can get this server blocked by the mail host).
        await this.setStatus(
          accountId,
          f.code === "AUTH_FAILED" ? "auth_error" : "error",
          f.message,
          {
            settings: sql`${accounts.settings} || ${JSON.stringify({ failedAt: new Date().toISOString() })}::jsonb`,
          },
        );
      }
      log.error("sync failed", { err: (err as Error).message, code: f.code });
      throw err;
    } finally {
      clearInterval(heartbeat);
      await connector.close();
      await this.releaseLease(accountId, lease);
    }
  }

  /** Take (or renew) the account's sync lease for 5 minutes. Returns false if someone else holds it. */
  private async acquireLease(accountId: string, lease: string): Promise<boolean> {
    const r = (await this.deps.db.execute(sql`
      UPDATE accounts SET settings = jsonb_set(settings, '{syncLease}',
        jsonb_build_object('id', ${lease}::text, 'until', (now() + interval '5 minutes')::text))
      WHERE id = ${accountId}
        AND (settings->'syncLease' IS NULL
             OR settings->'syncLease'->>'id' = ${lease}
             OR (settings->'syncLease'->>'until')::timestamptz < now())
      RETURNING id`)) as unknown as unknown[];
    return r.length > 0;
  }

  private async releaseLease(accountId: string, lease: string) {
    await this.deps.db.execute(sql`
      UPDATE accounts SET settings = settings - 'syncLease'
      WHERE id = ${accountId} AND settings->'syncLease'->>'id' = ${lease}`);
  }

  private async countMessages(accountId: string): Promise<number> {
    const [r] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    return r?.n ?? 0;
  }

  async syncFolder(
    row: AccountRow,
    connector: Connector,
    folder: FolderRow,
    remote: RemoteFolder,
    opts: { since?: Date; fullReconcile?: boolean },
  ): Promise<{ upserts: number; removed: number }> {
    const { db } = this.deps;
    const [known] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messageFolders)
      .where(and(eq(messageFolders.accountId, row.id), eq(messageFolders.folderId, folder.id)));
    let ups: MessageEnvelope[] = [];
    let flags: Array<{ uid: number; flags: MessageFlags }> = [];
    let upserts = 0;
    let removed = 0;
    let lastProgress = 0;

    const flush = async () => {
      if (ups.length) {
        await this.applyUpserts(row, folder, ups);
        upserts += ups.length;
        ups = [];
      }
      if (flags.length) {
        await this.applyFlags(row.id, folder.id, flags);
        flags = [];
      }
    };

    for await (const ev of connector.sync(
      remote,
      folder.syncCursor as Record<string, unknown> | null,
      {
        since: opts.since,
        batchSize: 250,
        knownCount: known?.n ?? 0,
        fullReconcile: opts.fullReconcile,
      },
    )) {
      switch (ev.type) {
        case "upsert":
          ups.push(ev.envelope);
          if (ups.length >= 250) await flush();
          break;
        case "flags":
          flags.push({ uid: ev.remoteUid, flags: ev.flags });
          if (flags.length >= 1000) await flush();
          break;
        case "delete":
          await flush();
          removed += await this.removeUids(row.id, folder.id, [ev.remoteUid]);
          break;
        case "present":
          await flush();
          removed += await this.removeMissing(row.id, folder.id, ev.fromUid, ev.uids);
          break;
        case "reset":
          await flush();
          await db
            .delete(messageFolders)
            .where(
              and(eq(messageFolders.accountId, row.id), eq(messageFolders.folderId, folder.id)),
            );
          break;
        case "progress":
          if (Date.now() - lastProgress > 2000 || ev.done === ev.total) {
            lastProgress = Date.now();
            await this.setStatus(
              row.id,
              "syncing",
              `Syncing ${folder.path}: ${ev.done.toLocaleString()} / ${ev.total.toLocaleString()}`,
            );
          }
          break;
        case "cursor":
          await flush();
          await db
            .update(folders)
            .set({ syncCursor: ev.cursor, syncedAt: new Date() })
            .where(eq(folders.id, folder.id));
          break;
      }
    }
    await flush();
    return { upserts, removed };
  }

  /** Insert/update a batch of envelopes in one transaction (addresses, threads, messages, links). */
  async applyUpserts(row: AccountRow, folder: FolderRow, input: MessageEnvelope[]) {
    const { db, search } = this.deps;
    const envs = [...new Map(input.map((e) => [e.remoteId, e])).values()];
    const docs: MailDoc[] = [];

    await db.transaction(async (tx) => {
      // 1. Addresses (normalized, org-wide)
      const people = new Map<string, string | null>();
      for (const e of envs) {
        for (const a of [e.from, ...e.to, ...e.cc, ...e.bcc, ...e.replyTo]) {
          if (a?.email && (!people.has(a.email) || (!people.get(a.email) && a.name)))
            people.set(a.email, a.name ?? null);
        }
      }
      const addrIds = new Map<string, number>();
      if (people.size) {
        const rows = await tx
          .insert(addresses)
          .values([...people].map(([email, name]) => ({ orgId: row.orgId, email, name })))
          .onConflictDoUpdate({
            target: [addresses.orgId, addresses.email],
            set: { name: sql`coalesce(${addresses.name}, excluded.name)` },
          })
          .returning({ id: addresses.id, email: addresses.email });
        for (const r of rows) addrIds.set(r.email, r.id);
      }

      // 2. Threads. If any ancestor (References, root first, then In-Reply-To) is already
      //    stored, join its thread: handles clients that truncate the References chain.
      const ancestors = (e: MessageEnvelope) =>
        [...(e.references ?? []), e.inReplyTo].filter((x): x is string => !!x);
      const allAncestors = [...new Set(envs.flatMap(ancestors))];
      const knownThread = new Map<string, string>();
      if (allAncestors.length) {
        const found = await tx
          .select({ hdr: messages.messageIdHdr, key: threads.remoteThreadId })
          .from(messages)
          .innerJoin(threads, eq(threads.id, messages.threadId))
          .where(and(eq(messages.accountId, row.id), inArray(messages.messageIdHdr, allAncestors)));
        for (const f of found) if (f.hdr && f.key) knownThread.set(f.hdr, f.key);
      }
      const keyOf = (e: MessageEnvelope) =>
        e.remoteThreadId ??
        ancestors(e)
          .map((a) => knownThread.get(a))
          .find(Boolean) ??
        threadKey(e);
      const keyed = new Map<string, { subject: string | null; last: Date }>();
      for (const e of envs) {
        const k = keyOf(e);
        const cur = keyed.get(k);
        if (!cur) keyed.set(k, { subject: baseSubject(e.subject), last: e.date });
        else if (e.date > cur.last) cur.last = e.date;
      }
      const threadRows = await tx
        .insert(threads)
        .values(
          [...keyed].map(([k, v]) => ({
            accountId: row.id,
            remoteThreadId: k,
            subject: v.subject,
            lastMessageAt: v.last,
          })),
        )
        .onConflictDoUpdate({
          target: [threads.accountId, threads.remoteThreadId],
          set: {
            lastMessageAt: sql`greatest(${threads.lastMessageAt}, excluded.last_message_at)`,
            subject: sql`coalesce(${threads.subject}, excluded.subject)`,
          },
        })
        .returning({ id: threads.id, key: threads.remoteThreadId });
      const threadIds = new Map(threadRows.map((t) => [t.key as string, t.id]));

      // 3. Messages
      const msgRows = await tx
        .insert(messages)
        .values(
          envs.map((e) => ({
            accountId: row.id,
            threadId: threadIds.get(keyOf(e)),
            remoteId: e.remoteId,
            messageIdHdr: e.messageId,
            inReplyTo: e.inReplyTo,
            subject: e.subject,
            date: e.date,
            fromAddressId: e.from ? addrIds.get(e.from.email) : undefined,
            fromName: e.from?.name,
            fromEmail: e.from?.email,
            seen: e.flags.seen,
            flagged: e.flags.flagged,
            answered: e.flags.answered,
            draft: e.flags.draft,
            keywords: e.flags.keywords,
            size: e.size,
            hasAttachments: e.hasAttachments ?? false,
            headersExtra: e.references?.length ? { references: e.references.slice(0, 50) } : null,
          })),
        )
        .onConflictDoUpdate({
          target: [messages.accountId, messages.remoteId],
          set: {
            seen: sql`excluded.seen`,
            flagged: sql`excluded.flagged`,
            answered: sql`excluded.answered`,
            draft: sql`excluded.draft`,
            keywords: sql`excluded.keywords`,
          },
        })
        .returning({
          id: messages.id,
          remoteId: messages.remoteId,
          inserted: sql<boolean>`(xmax = 0)`,
        });
      const byRemote = new Map(msgRows.map((m) => [m.remoteId, m]));

      // 4. Folder membership
      await tx
        .insert(messageFolders)
        .values(
          envs.map((e) => ({
            accountId: row.id,
            folderId: folder.id,
            messageId: byRemote.get(e.remoteId)!.id,
            remoteUid: e.remoteUid,
            date: e.date,
            seen: e.flags.seen,
          })),
        )
        .onConflictDoUpdate({
          target: [messageFolders.accountId, messageFolders.folderId, messageFolders.messageId],
          set: { remoteUid: sql`excluded.remote_uid`, seen: sql`excluded.seen` },
        });

      // 5. Recipients + attachment stubs for new messages only
      const addrRows: Array<typeof messageAddresses.$inferInsert> = [];
      const attRows: Array<typeof attachments.$inferInsert> = [];
      for (const e of envs) {
        const m = byRemote.get(e.remoteId);
        if (!m?.inserted) continue;
        const push = (
          role: "from" | "to" | "cc" | "bcc" | "reply_to",
          list: Array<EmailAddress | undefined>,
        ) =>
          list.forEach((a, position) => {
            const addressId = a ? addrIds.get(a.email) : undefined;
            if (addressId)
              addrRows.push({ accountId: row.id, messageId: m.id, role, addressId, position });
          });
        push("from", [e.from]);
        push("to", e.to);
        push("cc", e.cc);
        push("bcc", e.bcc);
        push("reply_to", e.replyTo);
        for (const a of e.attachments ?? []) {
          attRows.push({
            accountId: row.id,
            messageId: m.id,
            partId: a.partId,
            filename: a.filename,
            mime: a.mime,
            size: a.size,
            contentId: a.contentId,
          });
        }
        const fmt = (a?: EmailAddress) => (a ? [a.name, a.email].filter(Boolean).join(" ") : "");
        docs.push({
          accountId: row.id,
          messageId: m.id,
          folderIds: [folder.id],
          from: fmt(e.from),
          to: e.to.map(fmt),
          cc: e.cc.map(fmt),
          subject: e.subject,
          attachmentNames: (e.attachments ?? [])
            .map((a) => a.filename)
            .filter((f): f is string => !!f),
          date: e.date,
          seen: e.flags.seen,
          flagged: e.flags.flagged,
          hasAttachments: e.hasAttachments ?? false,
        });
      }
      if (addrRows.length) await tx.insert(messageAddresses).values(addrRows).onConflictDoNothing();
      if (attRows.length) await tx.insert(attachments).values(attRows);

      // 6. Thread counts for touched threads
      const touched = [...threadIds.values()];
      await tx.execute(sql`
        UPDATE threads t SET message_count = c.n
        FROM (SELECT thread_id, count(*)::int AS n FROM messages
              WHERE account_id = ${row.id} AND thread_id = ANY(${pgArray(touched, "bigint")}) GROUP BY thread_id) c
        WHERE t.id = c.thread_id`);
    });

    if (docs.length) await search.upsert(docs);
  }

  async applyFlags(
    accountId: string,
    folderId: number,
    list: Array<{ uid: number; flags: MessageFlags }>,
  ) {
    const col = <T>(f: (x: (typeof list)[number]) => T) => list.map(f);
    await this.deps.db.execute(sql`
      WITH d AS (
        SELECT * FROM unnest(${pgArray(
          col((x) => x.uid),
          "bigint",
        )}, ${pgArray(
          col((x) => x.flags.seen),
          "bool",
        )},
                             ${pgArray(
                               col((x) => x.flags.flagged),
                               "bool",
                             )}, ${pgArray(
                               col((x) => x.flags.answered),
                               "bool",
                             )},
                             ${pgArray(
                               col((x) => x.flags.draft),
                               "bool",
                             )}) AS d(uid, seen, flagged, answered, draft)
      ), mf AS (
        UPDATE message_folders mf SET seen = d.seen FROM d
        WHERE mf.account_id = ${accountId} AND mf.folder_id = ${folderId} AND mf.remote_uid = d.uid
        RETURNING mf.message_id, d.seen, d.flagged, d.answered, d.draft
      )
      UPDATE messages m SET seen = mf.seen, flagged = mf.flagged, answered = mf.answered, draft = mf.draft
      FROM mf WHERE m.account_id = ${accountId} AND m.id = mf.message_id`);
  }

  private async removeUids(accountId: string, folderId: number, uids: number[]): Promise<number> {
    const r = await this.deps.db
      .delete(messageFolders)
      .where(
        and(
          eq(messageFolders.accountId, accountId),
          eq(messageFolders.folderId, folderId),
          inArray(messageFolders.remoteUid, uids),
        ),
      )
      .returning({ id: messageFolders.messageId });
    return r.length;
  }

  private async removeMissing(
    accountId: string,
    folderId: number,
    fromUid: number,
    uids: number[],
  ): Promise<number> {
    const r = (await this.deps.db.execute(sql`
      DELETE FROM message_folders
      WHERE account_id = ${accountId} AND folder_id = ${folderId} AND remote_uid >= ${fromUid}
        AND NOT (remote_uid = ANY(${pgArray(uids, "bigint")}))
      RETURNING message_id`)) as unknown as unknown[];
    return r.length;
  }

  /**
   * Order-independent threading: a single-message thread whose ancestor (References /
   * In-Reply-To) arrived later from another folder joins the ancestor's thread.
   */
  async repairThreads(accountId: string): Promise<number> {
    const moved = (await this.deps.db.execute(sql`
      WITH solo AS (
        SELECT m.id, m.thread_id,
               coalesce(array(SELECT jsonb_array_elements_text(m.headers_extra->'references')), '{}'::text[])
                 || coalesce(array[m.in_reply_to], '{}'::text[]) AS anc
        FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.account_id = ${accountId} AND t.message_count = 1
          AND (m.in_reply_to IS NOT NULL OR m.headers_extra ? 'references')
      ), target AS (
        SELECT DISTINCT ON (s.id) s.id, p.thread_id AS new_thread
        FROM solo s JOIN messages p ON p.account_id = ${accountId} AND p.message_id_hdr = ANY(s.anc)
        WHERE p.thread_id <> s.thread_id
        ORDER BY s.id, array_position(s.anc, p.message_id_hdr)
      )
      UPDATE messages m SET thread_id = target.new_thread FROM target
      WHERE m.account_id = ${accountId} AND m.id = target.id
      RETURNING m.thread_id`)) as unknown as unknown[];
    if (moved.length) {
      await this.deps.db.execute(sql`
        UPDATE threads t SET message_count = c.n,
          last_message_at = c.last
        FROM (SELECT thread_id, count(*)::int AS n, max(date) AS last FROM messages WHERE account_id = ${accountId} GROUP BY thread_id) c
        WHERE t.account_id = ${accountId} AND t.id = c.thread_id AND t.message_count <> c.n`);
      await this.deps.db.execute(sql`
        DELETE FROM threads t WHERE t.account_id = ${accountId}
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id)`);
    }
    return moved.length;
  }

  /** Delete messages that are no longer in any folder, with their blobs. */
  async cleanupOrphans(row: AccountRow): Promise<number> {
    const { db, blobs } = this.deps;
    const gone = (await db.execute(sql`
      DELETE FROM messages m
      WHERE m.account_id = ${row.id}
        AND NOT EXISTS (SELECT 1 FROM message_folders mf WHERE mf.account_id = m.account_id AND mf.message_id = m.id)
      RETURNING m.id, m.raw_blob_key, m.body_blob_key`)) as unknown as Array<{
      id: string | number;
      raw_blob_key: string | null;
      body_blob_key: string | null;
    }>;
    if (!gone.length) return 0;
    const ids = gone.map((g) => Number(g.id));
    await db
      .delete(messageAddresses)
      .where(and(eq(messageAddresses.accountId, row.id), inArray(messageAddresses.messageId, ids)));
    await db
      .delete(attachments)
      .where(and(eq(attachments.accountId, row.id), inArray(attachments.messageId, ids)));
    await db.execute(sql`
      DELETE FROM threads t WHERE t.account_id = ${row.id}
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id = t.account_id AND m.thread_id = t.id)`);
    const store = await blobs.get();
    for (const g of gone) {
      for (const k of [g.raw_blob_key, g.body_blob_key])
        if (k) await store.delete(k).catch(() => {});
    }
    return gone.length;
  }

  /** Download bodies for recent mail, newest first, within a time budget and provider limits. */
  async backfillBodies(
    row: AccountRow,
    connector: Connector,
    months: number,
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<{ fetched: number; more: boolean; limited: boolean }> {
    const { db } = this.deps;
    if (months <= 0) return { fetched: 0, more: false, limited: false };
    const cutoff = monthsAgo(months);
    const deadline = Date.now() + budgetMs;
    const isGmail = Boolean((row.settings as { traits?: { gmail?: boolean } })?.traits?.gmail);
    let fetched = 0;

    const MAX_BATCH_BYTES = 50 * 1024 * 1024;
    while (Date.now() < deadline && !signal?.aborted) {
      const candidates = await db
        .select({ id: messages.id, size: messages.size })
        .from(messages)
        .where(
          and(
            eq(messages.accountId, row.id),
            eq(messages.bodyState, "none"),
            sql`${messages.date} >= ${cutoff.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(messages.date))
        .limit(50);
      if (!candidates.length) return { fetched, more: false, limited: false };
      // Cap a batch by size so one huge attachment run can't exhaust memory.
      const batch: number[] = [];
      let size = 0;
      for (const c of candidates) {
        if (batch.length && size + (c.size ?? 0) > MAX_BATCH_BYTES) break;
        batch.push(c.id);
        size += c.size ?? 0;
      }
      if (isGmail && (await this.bandwidthToday(row.id)) > GMAIL_DAILY_BYTES) {
        return { fetched, more: true, limited: true };
      }
      try {
        const r = await this.bodies.fetchBatch(row, connector, batch);
        await this.addBandwidth(row.id, r.bytes);
        fetched += r.stored.length;
        if (r.errors.size) {
          // Vanished or unparseable: mark evicted so we don't retry forever.
          await db
            .update(messages)
            .set({ bodyState: "evicted" })
            .where(and(eq(messages.accountId, row.id), inArray(messages.id, [...r.errors.keys()])));
          this.log.warn("some bodies failed", {
            accountId: row.id,
            failed: r.errors.size,
            sample: [...r.errors.values()][0],
          });
        }
      } catch (err) {
        if (err instanceof ProviderLimitError) return { fetched, more: true, limited: true };
        throw err;
      }
    }
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, row.id),
          eq(messages.bodyState, "none"),
          sql`${messages.date} >= ${cutoff.toISOString()}::timestamptz`,
        ),
      );
    return { fetched, more: (left?.n ?? 0) > 0, limited: false };
  }

  private async bandwidthToday(accountId: string): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    const [r] = await this.deps.db
      .select({
        bw: sql<{ day?: string; bytes?: number } | null>`${accounts.settings}->'bandwidth'`,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return r?.bw?.day === day ? (r.bw.bytes ?? 0) : 0;
  }

  private async addBandwidth(accountId: string, bytes: number) {
    const day = new Date().toISOString().slice(0, 10);
    await this.deps.db.execute(sql`
      UPDATE accounts SET settings = jsonb_set(settings, '{bandwidth}',
        CASE WHEN settings->'bandwidth'->>'day' = ${day}
          THEN jsonb_build_object('day', ${day}::text, 'bytes', coalesce((settings->'bandwidth'->>'bytes')::bigint, 0) + ${bytes})
          ELSE jsonb_build_object('day', ${day}::text, 'bytes', ${bytes}::bigint) END)
      WHERE id = ${accountId}`);
  }
}

export type { Tx };
