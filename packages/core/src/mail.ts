import {
  accounts,
  and,
  type Db,
  eq,
  folders,
  inArray,
  messageFolders,
  messages,
  pendingActions,
  pgArray,
  sql,
} from "@mailmcp/db";
import type { EmailAddress, MessageRef, OutboundMessage, RemoteFolder } from "@mailmcp/module-sdk";
import {
  DEFAULT_SORT,
  decodeCursor,
  dir,
  keyCursor,
  offsetCursor,
  parseQuery,
  type Sort,
  sortKey,
} from "@mailmcp/search";
import type { AccountRow } from "./accounts";
import { audit } from "./audit";
import { attachmentFromRaw } from "./parse";
import {
  type Access,
  AccessDenied,
  type AccountGrant,
  accountsWith,
  folderAllowed,
  type PolicyService,
  recipientAllowed,
  requireScope,
} from "./policy";
import type { Scope } from "./scopes";
import type { Services } from "./services";
import {
  oneClickUnsubscribe,
  parseUnsubscribe,
  type UnsubscribeInfo,
  type UnsubscribeMethod,
  unsubscribeMethod,
} from "./unsubscribe";

export class MailError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface MessageSummary {
  id: number;
  accountId: string;
  account: string;
  threadId: number | null;
  folders: string[];
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  date: string;
  snippet: string | null;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  messageIdHeader: string | null;
  text: string | null;
  html: string | null;
  /** How to unsubscribe from the list this came from (null: not a mailing list). */
  unsubscribe: {
    method: UnsubscribeMethod;
    /** The sender's unsubscribe web page, when there is one. Untrusted. */
    website: string | null;
    /** When it was unsubscribed through MailMCP. */
    unsubscribedAt: string | null;
  } | null;
  attachments: Array<{
    id: number;
    filename: string | null;
    mime: string | null;
    size: number | null;
    inline: boolean;
  }>;
}

export interface ComposeInput {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; contentType?: string; content: Buffer }>;
}

export type UnsubscribeOutcome =
  | { status: "unsubscribed"; method: "one_click" | "email"; note: string }
  | { status: "open_website"; method: "website"; url: string; note: string }
  | { status: "pending_approval"; pendingId: string; note: string };

type HeadersExtra = {
  references?: string[];
  unsubscribe?: UnsubscribeInfo | null;
  unsubscribedAt?: string;
} | null;

export type SendOutcome =
  | { status: "sent"; messageId: string; accepted: string[]; rejected: string[] }
  | { status: "pending_approval"; pendingId: string; note: string };

type FolderRow = typeof folders.$inferSelect;
const asRemote = (f: FolderRow): RemoteFolder => ({
  remoteId: f.remoteId,
  path: f.path,
  kind: "folder",
  selectable: true,
});

/** Where a message sits: one folder copy, its UID there, and whether that copy is read. */
type Place = { folder: FolderRow; uid: number | null; seen: boolean };

export class MailService {
  constructor(
    private s: Services,
    private policy: PolicyService,
  ) {}

  private get db(): Db {
    return this.s.db;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async folderFor(accountId: string, ref: string | number): Promise<FolderRow> {
    const rows = await this.db.select().from(folders).where(eq(folders.accountId, accountId));
    const want = String(ref).toLowerCase();
    const f =
      rows.find((r) => String(r.id) === want) ??
      rows.find((r) => r.role === want) ??
      rows.find((r) => r.path.toLowerCase() === want) ??
      rows.find((r) => r.path.toLowerCase().endsWith(`/${want}`));
    if (!f) throw new MailError(`Folder "${ref}" not found in this account.`, 404);
    return f;
  }

  /**
   * Keep folder totals and unread counts right immediately after a change made here. (They come
   * from the mail server on each sync, which would otherwise leave them stale until the next one.)
   */
  private async bumpCounts(deltas: Map<number, { total: number; unread: number }>) {
    for (const [id, d] of deltas) {
      if (!d.total && !d.unread) continue;
      await this.db
        .update(folders)
        .set({
          messageCount: sql`greatest(0, ${folders.messageCount} + ${d.total})`,
          unreadCount: sql`greatest(0, ${folders.unreadCount} + ${d.unread})`,
        })
        .where(eq(folders.id, id));
    }
  }

  /** Resolve message ids to accounts and check the actor's scope + folder rules. */
  private async resolve(access: Access, ids: number[], scope: Scope) {
    if (!ids.length) throw new MailError("No message ids given.");
    const rows = await this.db
      .select({ id: messages.id, accountId: messages.accountId, remoteId: messages.remoteId })
      .from(messages)
      .where(inArray(messages.id, ids));
    const found = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw new MailError(`Message(s) not found: ${missing.join(", ")}`, 404);

    const memberships = await this.db
      .select({
        messageId: messageFolders.messageId,
        uid: messageFolders.remoteUid,
        seen: messageFolders.seen,
        folder: folders,
      })
      .from(messageFolders)
      .innerJoin(folders, eq(folders.id, messageFolders.folderId))
      .where(inArray(messageFolders.messageId, ids));

    const byAccount = new Map<
      string,
      {
        grant: AccountGrant;
        items: Array<{
          id: number;
          remoteId: string;
          places: Place[];
        }>;
      }
    >();
    for (const id of ids) {
      const m = found.get(id)!;
      const grant = requireScope(access, m.accountId, scope);
      const places = memberships
        .filter((x) => x.messageId === id)
        .map((x) => ({ folder: x.folder, uid: x.uid, seen: x.seen }));
      if (
        places.length &&
        !places.some((p) => folderAllowed(grant, p.folder.path, p.folder.role))
      ) {
        throw new AccessDenied(`Message ${id} is in a folder you don't have access to.`);
      }
      const g = byAccount.get(m.accountId) ?? { grant, items: [] };
      g.items.push({ id, remoteId: m.remoteId, places });
      byAccount.set(m.accountId, g);
    }
    return byAccount;
  }

  private async row(accountId: string): Promise<AccountRow> {
    return this.s.accounts.byId(accountId);
  }

  private async log(
    access: Access,
    action: string,
    accountId: string | null,
    target: string | null,
    allowed = true,
    detail?: Record<string, unknown>,
  ) {
    await audit(this.db, {
      orgId: access.orgId,
      actorType: access.actor.type,
      actorId: access.actor.id,
      accountId,
      action,
      target,
      allowed,
      detail,
    });
  }

  /** Load summaries for (account, id) pairs, preserving order. */
  async hydrate(refs: Array<{ accountId: string; messageId: number }>): Promise<MessageSummary[]> {
    if (!refs.length) return [];
    const rows = (await this.db.execute(sql`
      SELECT m.id, m.account_id, a.address AS account, m.thread_id, m.subject, m.from_name, m.from_email, m.date,
             m.snippet, m.seen, m.flagged, m.answered, m.has_attachments,
             coalesce((SELECT array_agg(f.path ORDER BY f.path) FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
                       WHERE mf.account_id = m.account_id AND mf.message_id = m.id), '{}') AS folders,
             coalesce((SELECT json_agg(json_build_object('name', ad.name, 'email', ad.email) ORDER BY ma.position)
                       FROM message_addresses ma JOIN addresses ad ON ad.id = ma.address_id
                       WHERE ma.account_id = m.account_id AND ma.message_id = m.id AND ma.role = 'to'), '[]') AS to_list
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ANY(${pgArray(
        refs.map((r) => r.messageId),
        "bigint",
      )})`)) as unknown as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return refs
      .map((ref) => byId.get(ref.messageId))
      .filter((r): r is Record<string, unknown> => !!r)
      .map((r) => ({
        id: Number(r.id),
        accountId: r.account_id as string,
        account: r.account as string,
        threadId: r.thread_id ? Number(r.thread_id) : null,
        folders: r.folders as string[],
        subject: (r.subject as string) ?? null,
        from: r.from_email
          ? { name: (r.from_name as string) ?? undefined, email: r.from_email as string }
          : null,
        to: (r.to_list as EmailAddress[]).map((t) => ({
          name: t.name ?? undefined,
          email: t.email,
        })),
        date: new Date(r.date as string).toISOString(),
        snippet: (r.snippet as string) ?? null,
        unread: !r.seen,
        flagged: Boolean(r.flagged),
        answered: Boolean(r.answered),
        hasAttachments: Boolean(r.has_attachments),
      }));
  }

  // ───────────────────────────── reads ─────────────────────────────

  async listAccounts(access: Access) {
    const ids = [...access.grants.keys()];
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: accounts.id,
        address: accounts.address,
        displayName: accounts.displayName,
        status: accounts.status,
        instructions: accounts.instructions,
      })
      .from(accounts)
      .where(inArray(accounts.id, ids));
    return rows.map((r) => ({
      ...r,
      permissions: [...(access.grants.get(r.id)?.scopes ?? [])],
      sendPolicy: access.grants.get(r.id)?.sendPolicy,
    }));
  }

  async listFolders(access: Access, accountId?: string) {
    const ids = accountsWith(access, "mail:read").filter((a) => !accountId || a === accountId);
    if (accountId && !ids.length)
      throw new AccessDenied("You don't have read access to this account.");
    if (!ids.length) return [];
    const rows = await this.db
      .select({
        id: folders.id,
        accountId: folders.accountId,
        path: folders.path,
        role: folders.role,
        messageCount: folders.messageCount,
        unreadCount: folders.unreadCount,
      })
      .from(folders)
      .where(inArray(folders.accountId, ids))
      .orderBy(folders.accountId, folders.path);
    return rows.filter((f) =>
      folderAllowed(access.grants.get(f.accountId) as AccountGrant, f.path, f.role),
    );
  }

  /** Newest messages in a folder (default: each account's inbox), across accounts. */
  async list(
    access: Access,
    opts: {
      accountId?: string;
      folder?: string | number;
      unreadOnly?: boolean;
      limit?: number;
      cursor?: string;
      sort?: Sort;
    } = {},
  ): Promise<{ messages: MessageSummary[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const accountIds = accountsWith(access, "mail:read").filter(
      (a) => !opts.accountId || a === opts.accountId,
    );
    if (opts.accountId && !accountIds.length)
      throw new AccessDenied("You don't have read access to this account.");
    const pairs: Array<{ a: string; f: number }> = [];
    for (const a of accountIds) {
      const grant = access.grants.get(a) as AccountGrant;
      try {
        const f = await this.folderFor(a, opts.folder ?? "inbox");
        if (folderAllowed(grant, f.path, f.role)) pairs.push({ a, f: f.id });
      } catch {
        if (opts.accountId) throw new MailError(`Folder "${opts.folder}" not found.`, 404);
      }
    }
    if (!pairs.length) return { messages: [] };
    const sort = opts.sort ?? DEFAULT_SORT;
    const cursor = decodeCursor(opts.cursor);
    const unread = opts.unreadOnly ? sql`AND NOT mf.seen` : sql``;
    const pa = pgArray(
      pairs.map((p) => p.a),
      "uuid",
    );
    const pf = pgArray(
      pairs.map((p) => p.f),
      "bigint",
    );
    type Row = { account_id: string; message_id: string; date: string };
    const done = async (rows: Row[], next: (last: Row) => string) => {
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        messages: await this.hydrate(
          page.map((r) => ({ accountId: r.account_id, messageId: Number(r.message_id) })),
        ),
        nextCursor: rows.length > limit && last ? next(last) : undefined,
      };
    };

    if (sort.field === "date") {
      // Per-(account, folder) top-N on the list index, then merge.
      const d = dir(sort.order);
      const cmp = sql.raw(sort.order === "asc" ? ">" : "<");
      const keyset =
        cursor?.kind === "key"
          ? sql`AND (mf.date, mf.message_id) ${cmp} (${cursor.date.toISOString()}::timestamptz, ${cursor.id})`
          : sql``;
      const rows = (await this.db.execute(sql`
        SELECT r.account_id, r.message_id, r.date FROM unnest(${pa}, ${pf}) AS p(a, f)
        CROSS JOIN LATERAL (
          SELECT mf.account_id, mf.message_id, mf.date FROM message_folders mf
          WHERE mf.account_id = p.a AND mf.folder_id = p.f ${unread} ${keyset}
          ORDER BY mf.date ${d}, mf.message_id ${d} LIMIT ${limit + 1}
        ) r ORDER BY r.date ${d}, r.message_id ${d} LIMIT ${limit + 1}`)) as unknown as Row[];
      return done(rows, (l) => keyCursor(new Date(l.date), Number(l.message_id)));
    }

    // Sender / subject sort across the selected folders, offset paging.
    const offset = cursor?.kind === "offset" ? cursor.offset : 0;
    const rows = (await this.db.execute(sql`
      SELECT mf.account_id, mf.message_id, mf.date
      FROM unnest(${pa}, ${pf}) AS p(a, f)
      JOIN message_folders mf ON mf.account_id = p.a AND mf.folder_id = p.f
      JOIN messages m ON m.account_id = mf.account_id AND m.id = mf.message_id
      WHERE true ${unread}
      ORDER BY ${sortKey(sort.field)} ${dir(sort.order)} NULLS LAST, mf.date DESC, mf.message_id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`)) as unknown as Row[];
    return done(rows, () => offsetCursor(offset + limit));
  }

  async search(
    access: Access,
    query: string,
    opts: { accountId?: string; limit?: number; cursor?: string; sort?: Sort } = {},
  ) {
    const scope = await this.policy.searchScope(access, "mail:read", opts.accountId);
    if (opts.accountId && !scope.accountIds.length)
      throw new AccessDenied("You don't have read access to this account.");
    const r = await this.s.search.search(parseQuery(query), scope, {
      limit: opts.limit ?? 25,
      cursor: opts.cursor,
      sort: opts.sort,
    });
    return { messages: await this.hydrate(r.hits), nextCursor: r.nextCursor };
  }

  async get(
    access: Access,
    id: number,
    opts: { fetchBody?: boolean } = {},
  ): Promise<MessageDetail> {
    const byAccount = await this.resolve(access, [id], "mail:read");
    const [accountId] = [...byAccount.keys()] as [string];
    const row = await this.row(accountId);
    let [m] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.id, id)));
    if (!m) throw new MailError("Message not found", 404);
    if (m.bodyState !== "fetched" && opts.fetchBody !== false) {
      await this.s.pool
        .use(accountId, (c) => this.s.sync.bodies.fetch(row, c, id))
        .catch((e: Error) => {
          throw new MailError(`Couldn't download this message from the server: ${e.message}`, 502);
        });
      [m] = await this.db
        .select()
        .from(messages)
        .where(and(eq(messages.accountId, accountId), eq(messages.id, id)));
    }
    const body = await this.s.sync.bodies.load(row, m!.bodyBlobKey);
    const unsub = await this.unsubscribeInfo(row, m!);
    const method = unsubscribeMethod(unsub);
    const [summary] = await this.hydrate([{ accountId, messageId: id }]);
    const people = (await this.db.execute(sql`
      SELECT ma.role, ad.name, ad.email FROM message_addresses ma JOIN addresses ad ON ad.id = ma.address_id
      WHERE ma.account_id = ${accountId} AND ma.message_id = ${id} ORDER BY ma.position`)) as unknown as Array<{
      role: string;
      name: string | null;
      email: string;
    }>;
    const of = (role: string) =>
      people
        .filter((p) => p.role === role)
        .map((p) => ({ name: p.name ?? undefined, email: p.email }));
    const atts = (await this.db.execute(sql`
      SELECT id, filename, mime, size, content_id FROM attachments WHERE account_id = ${accountId} AND message_id = ${id} ORDER BY id`)) as unknown as Array<{
      id: string;
      filename: string | null;
      mime: string | null;
      size: number | null;
      content_id: string | null;
    }>;
    return {
      ...(summary as MessageSummary),
      cc: of("cc"),
      bcc: of("bcc"),
      replyTo: of("reply_to"),
      messageIdHeader: m!.messageIdHdr,
      text: body?.text ?? null,
      html: body?.html ?? null,
      unsubscribe: method
        ? {
            method,
            website: unsub?.web ?? null,
            unsubscribedAt: (m!.headersExtra as HeadersExtra)?.unsubscribedAt ?? null,
          }
        : null,
      attachments: atts.map((a) => ({
        id: Number(a.id),
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        inline: !!a.content_id && !a.filename,
      })),
    };
  }

  /** All messages in the thread of `id`, oldest first, with bodies. */
  async thread(access: Access, id: number) {
    const byAccount = await this.resolve(access, [id], "mail:read");
    const [accountId] = [...byAccount.keys()] as [string];
    const [m] = await this.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.id, id)));
    if (!m?.threadId) return { messages: [await this.get(access, id)] };
    const ids = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.threadId, m.threadId)))
      .orderBy(messages.date)
      .limit(100);
    // Fetch missing bodies in one batch first.
    const row = await this.row(accountId);
    const missing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.threadId, m.threadId),
          sql`${messages.bodyState} <> 'fetched'`,
        ),
      );
    if (missing.length) {
      await this.s.pool
        .use(accountId, (c) =>
          this.s.sync.bodies.fetchBatch(
            row,
            c,
            missing.map((x) => x.id),
          ),
        )
        .catch(() => {});
    }
    const out: MessageDetail[] = [];
    for (const x of ids) {
      try {
        out.push(await this.get(access, x.id, { fetchBody: false }));
      } catch (e) {
        if (!(e instanceof AccessDenied)) throw e; // skip messages in folders the actor can't see
      }
    }
    return { messages: out };
  }

  async attachment(access: Access, messageId: number, attachmentId: number) {
    const byAccount = await this.resolve(access, [messageId], "mail:read");
    const [accountId] = [...byAccount.keys()] as [string];
    const row = await this.row(accountId);
    const att = (await this.db.execute(sql`
      SELECT part_id, filename, mime FROM attachments WHERE account_id = ${accountId} AND message_id = ${messageId} AND id = ${attachmentId}`)) as unknown as Array<{
      part_id: string;
      filename: string | null;
      mime: string | null;
    }>;
    if (!att[0]) throw new MailError("Attachment not found", 404);
    let [m] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
    if (!m?.rawBlobKey) {
      await this.s.pool.use(accountId, (c) => this.s.sync.bodies.fetch(row, c, messageId));
      [m] = await this.db
        .select()
        .from(messages)
        .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
    }
    const raw = await this.s.sync.bodies.loadRaw(row, m?.rawBlobKey ?? null);
    if (!raw) throw new MailError("Message source unavailable", 502);
    // Attachment ids from header sync use MIME part numbers; after body download they're indexes.
    const index = att[0].part_id.startsWith("idx:") ? Number(att[0].part_id.slice(4)) : -1;
    const a = index >= 0 ? await attachmentFromRaw(raw, index) : null;
    if (!a) throw new MailError("Attachment not found in message", 404);
    return a;
  }

  // ───────────────────────────── actions (write-through) ─────────────────────────────

  async markMessages(access: Access, ids: number[], change: { read?: boolean; flagged?: boolean }) {
    const byAccount = await this.resolve(access, ids, "mail:organize");
    for (const [accountId, { grant, items }] of byAccount) {
      this.policy.checkRate(grant);
      const add: Record<string, boolean> = {};
      const remove: Record<string, boolean> = {};
      if (change.read !== undefined) (change.read ? add : remove).seen = true;
      if (change.flagged !== undefined) (change.flagged ? add : remove).flagged = true;
      // Group by folder: IMAP flags are per folder copy.
      const groups = new Map<number, { folder: FolderRow; refs: MessageRef[] }>();
      for (const it of items) {
        for (const p of it.places) {
          if (!p.uid) continue;
          const g = groups.get(p.folder.id) ?? { folder: p.folder, refs: [] };
          g.refs.push({ remoteId: it.remoteId, remoteUid: p.uid });
          groups.set(p.folder.id, g);
        }
      }
      await this.s.pool.use(accountId, async (c) => {
        for (const g of groups.values())
          await c.setFlags(asRemote(g.folder), g.refs, { add, remove });
      });
      const set: Partial<typeof messages.$inferInsert> = {};
      if (change.read !== undefined) set.seen = change.read;
      if (change.flagged !== undefined) set.flagged = change.flagged;
      const idList = items.map((i) => i.id);
      await this.db
        .update(messages)
        .set(set)
        .where(and(eq(messages.accountId, accountId), inArray(messages.id, idList)));
      if (change.read !== undefined) {
        const deltas = new Map<number, { total: number; unread: number }>();
        for (const it of items)
          for (const p of it.places) {
            if (p.seen === change.read) continue;
            const d = deltas.get(p.folder.id) ?? { total: 0, unread: 0 };
            d.unread += change.read ? -1 : 1;
            deltas.set(p.folder.id, d);
          }
        await this.bumpCounts(deltas);
        await this.db
          .update(messageFolders)
          .set({ seen: change.read })
          .where(
            and(eq(messageFolders.accountId, accountId), inArray(messageFolders.messageId, idList)),
          );
      }
      await this.log(access, "mail.mark", accountId, idList.join(","), true, change);
    }
    return { updated: ids.length };
  }

  async move(access: Access, ids: number[], target: string | number) {
    const byAccount = await this.resolve(access, ids, "mail:organize");
    for (const [accountId, { grant, items }] of byAccount) {
      this.policy.checkRate(grant);
      const dest = await this.folderFor(accountId, target);
      if (!folderAllowed(grant, dest.path, dest.role))
        throw new AccessDenied(`You can't move mail into "${dest.path}".`);
      await this.moveWithin(accountId, items, dest);
      await this.log(access, "mail.move", accountId, items.map((i) => i.id).join(","), true, {
        to: dest.path,
      });
    }
    return { moved: ids.length };
  }

  private async moveWithin(
    accountId: string,
    items: Array<{ id: number; remoteId: string; places: Place[] }>,
    dest: FolderRow,
  ) {
    const groups = new Map<number, { folder: FolderRow; refs: MessageRef[]; ids: number[] }>();
    for (const it of items) {
      for (const p of it.places) {
        if (!p.uid || p.folder.id === dest.id || p.folder.role === "all") continue;
        const g = groups.get(p.folder.id) ?? { folder: p.folder, refs: [], ids: [] };
        g.refs.push({ remoteId: it.remoteId, remoteUid: p.uid });
        g.ids.push(it.id);
        groups.set(p.folder.id, g);
      }
    }
    await this.s.pool.use(accountId, async (c) => {
      for (const g of groups.values()) await c.move(asRemote(g.folder), g.refs, asRemote(dest));
    });
    for (const g of groups.values()) {
      await this.db
        .delete(messageFolders)
        .where(
          and(
            eq(messageFolders.accountId, accountId),
            eq(messageFolders.folderId, g.folder.id),
            inArray(messageFolders.messageId, g.ids),
          ),
        );
    }
    const deltas = new Map<number, { total: number; unread: number }>();
    const bump = (folderId: number, total: number, unread: number) => {
      const d = deltas.get(folderId) ?? { total: 0, unread: 0 };
      d.total += total;
      d.unread += unread;
      deltas.set(folderId, d);
    };
    for (const it of items) {
      const moved = it.places.filter(
        (p) => p.uid && p.folder.id !== dest.id && p.folder.role !== "all",
      );
      if (!moved.length) continue;
      for (const p of moved) bump(p.folder.id, -1, p.seen ? 0 : -1);
      bump(dest.id, 1, moved.some((p) => !p.seen) ? 1 : 0);
    }
    await this.bumpCounts(deltas);
    // The destination copy gets a new UID; a quick sync picks it up (and cleans the old row).
    await this.s.jobs.enqueueSync({ accountId, reason: "move" }).catch(() => {});
  }

  /** Move to Trash, or permanently delete (needs mail:delete:permanent; also used for mail already in Trash). */
  async delete(access: Access, ids: number[], opts: { permanent?: boolean } = {}) {
    const byAccount = await this.resolve(
      access,
      ids,
      opts.permanent ? "mail:delete:permanent" : "mail:delete",
    );
    let trashed = 0;
    let deleted = 0;
    for (const [accountId, { grant, items }] of byAccount) {
      this.policy.checkRate(grant);
      const trash = await this.folderFor(accountId, "trash").catch(() => null);
      const inTrash = items.filter(
        (i) => i.places.length && i.places.every((p) => p.folder.role === "trash"),
      );
      const toTrash = opts.permanent ? [] : items.filter((i) => !inTrash.includes(i));
      const toExpunge = opts.permanent ? items : inTrash;
      if (toExpunge.length && !grant.scopes.has("mail:delete:permanent")) {
        throw new AccessDenied(
          "These messages are already in Trash; deleting them permanently needs the mail:delete:permanent permission.",
        );
      }
      if (toTrash.length) {
        if (!trash)
          throw new MailError("This account has no Trash folder; use permanent delete instead.");
        await this.moveWithin(accountId, toTrash, trash);
        trashed += toTrash.length;
      }
      if (toExpunge.length) {
        const groups = new Map<number, { folder: FolderRow; refs: MessageRef[] }>();
        for (const it of toExpunge) {
          for (const p of it.places) {
            if (!p.uid) continue;
            const g = groups.get(p.folder.id) ?? { folder: p.folder, refs: [] };
            g.refs.push({ remoteId: it.remoteId, remoteUid: p.uid });
            groups.set(p.folder.id, g);
          }
        }
        await this.s.pool.use(accountId, async (c) => {
          for (const g of groups.values()) await c.expunge(asRemote(g.folder), g.refs);
        });
        const idList = toExpunge.map((i) => i.id);
        const deltas = new Map<number, { total: number; unread: number }>();
        for (const it of toExpunge)
          for (const p of it.places) {
            const d = deltas.get(p.folder.id) ?? { total: 0, unread: 0 };
            d.total -= 1;
            d.unread -= p.seen ? 0 : 1;
            deltas.set(p.folder.id, d);
          }
        await this.bumpCounts(deltas);
        await this.db
          .delete(messageFolders)
          .where(
            and(eq(messageFolders.accountId, accountId), inArray(messageFolders.messageId, idList)),
          );
        await this.s.sync.cleanupOrphans(await this.row(accountId));
        deleted += toExpunge.length;
      }
      await this.log(
        access,
        opts.permanent ? "mail.delete.permanent" : "mail.delete",
        accountId,
        items.map((i) => i.id).join(","),
        true,
        { trashed, deleted },
      );
    }
    return { trashed, deleted };
  }

  // ───────────────────────────── unsubscribe ─────────────────────────────

  /**
   * The message's unsubscribe options. Bodies fetched before this feature existed don't have
   * them stored yet, so read them from the raw message once and remember the answer.
   */
  private async unsubscribeInfo(
    row: AccountRow,
    m: typeof messages.$inferSelect,
  ): Promise<UnsubscribeInfo | null> {
    const extra = (m.headersExtra ?? {}) as NonNullable<HeadersExtra>;
    if ("unsubscribe" in extra) return extra.unsubscribe ?? null;
    if (m.bodyState !== "fetched" || !m.rawBlobKey) return null;
    const raw = await this.s.sync.bodies.loadRaw(row, m.rawBlobKey).catch(() => null);
    if (!raw) return null;
    const info = parseUnsubscribe(raw);
    await this.db
      .update(messages)
      .set({
        headersExtra: sql`coalesce(${messages.headersExtra}, '{}'::jsonb) || ${JSON.stringify({ unsubscribe: info })}::jsonb`,
      })
      .where(and(eq(messages.accountId, m.accountId), eq(messages.id, m.id)));
    return info;
  }

  /**
   * Unsubscribe from the mailing list that sent `messageId`, using its List-Unsubscribe header:
   * a one-click POST when the sender supports it, otherwise an unsubscribe email (which counts
   * as sending, so the send policy applies), otherwise the sender's web page for a person to open.
   */
  async unsubscribe(
    access: Access,
    messageId: number,
    opts: { approved?: boolean } = {},
  ): Promise<UnsubscribeOutcome> {
    const byAccount = await this.resolve(access, [messageId], "mail:unsubscribe");
    const [accountId] = [...byAccount.keys()] as [string];
    const row = await this.row(accountId);
    let [m] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
    if (m && m.bodyState !== "fetched") {
      await this.s.pool
        .use(accountId, (c) => this.s.sync.bodies.fetch(row, c, messageId))
        .catch((e: Error) => {
          throw new MailError(`Couldn't download this message from the server: ${e.message}`, 502);
        });
      [m] = await this.db
        .select()
        .from(messages)
        .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
    }
    if (!m) throw new MailError("Message not found", 404);
    const info = await this.unsubscribeInfo(row, m);
    const method = unsubscribeMethod(info);
    if (!info || !method)
      throw new MailError("This message has no unsubscribe option (no List-Unsubscribe header).");

    const done = async (how: "one_click" | "email", target: string) => {
      await this.db
        .update(messages)
        .set({
          headersExtra: sql`coalesce(${messages.headersExtra}, '{}'::jsonb) || ${JSON.stringify({ unsubscribedAt: new Date().toISOString() })}::jsonb`,
        })
        .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
      await this.log(access, "mail.unsubscribe", accountId, target, true, {
        messageId,
        method: how,
      });
    };

    if (method === "one_click") {
      const link = info.oneClick as string;
      try {
        await oneClickUnsubscribe(link);
      } catch (e) {
        await this.log(access, "mail.unsubscribe", accountId, new URL(link).host, false, {
          messageId,
          method,
          error: (e as Error).message,
        });
        throw new MailError(
          `${(e as Error).message}${info.web && info.web !== link ? " You can try the sender's unsubscribe page instead." : ""}`,
          502,
        );
      }
      await done("one_click", new URL(link).host);
      return {
        status: "unsubscribed",
        method,
        note: "Unsubscribed. The sender may take a few days to stop sending.",
      };
    }

    if (method === "email") {
      const mt = info.mailto!;
      if (!opts.approved) {
        if (!access.grants.get(accountId)?.scopes.has("mail:send"))
          throw new AccessDenied(
            "This list only takes unsubscribe requests by email, which needs permission to send from this account. The user can unsubscribe from the MailMCP Mail page.",
          );
        const gated = await this.gateSend(
          access,
          accountId,
          "unsubscribe",
          { messageId, to: mt.to },
          [mt.to],
        );
        if (gated?.status === "pending_approval") return gated;
      }
      const sent = await this.s.pool.use(accountId, async (c) =>
        c.send({
          from: await this.fromAddress(accountId),
          to: [{ email: mt.to }],
          subject: mt.subject || "unsubscribe",
          text: mt.body || "unsubscribe",
        }),
      );
      if (!sent.accepted.length && sent.rejected.length)
        throw new MailError(`The mail server rejected the unsubscribe email to ${mt.to}.`, 502);
      await done("email", mt.to);
      return {
        status: "unsubscribed",
        method,
        note: `Sent an unsubscribe email to ${mt.to}. The sender may take a few days to stop sending.`,
      };
    }

    await this.log(access, "mail.unsubscribe.website", accountId, new URL(info.web!).host, true, {
      messageId,
    });
    return {
      status: "open_website",
      method,
      url: info.web!,
      note: "This sender only offers an unsubscribe web page. A person needs to open it in a browser to finish.",
    };
  }

  // ───────────────────────────── sending ─────────────────────────────

  private async fromAddress(accountId: string): Promise<EmailAddress> {
    const r = await this.row(accountId);
    return { email: r.address, name: r.displayName ?? undefined };
  }

  /**
   * Gate an outgoing message by the grant's send policy and recipient rules. Returns null
   * when it may go now, or a pending outcome when it was queued for approval.
   */
  private async gateSend(
    access: Access,
    accountId: string,
    kind: string,
    payload: Record<string, unknown>,
    recipients: string[],
  ): Promise<SendOutcome | null> {
    const grant = requireScope(access, accountId, "mail:send");
    this.policy.checkRate(grant);
    const blocked = recipients.filter((r) => !recipientAllowed(grant, r));
    if (blocked.length) {
      await this.log(access, `mail.${kind}`, accountId, blocked.join(","), false, {
        reason: "recipient not allowed",
      });
      throw new AccessDenied(`Not allowed to send to: ${blocked.join(", ")}`);
    }
    if (grant.sendPolicy === "deny")
      throw new AccessDenied("Sending is disabled for this account.");
    if (grant.sendPolicy === "approve" && access.actor.type === "agent") {
      const [p] = await this.db
        .insert(pendingActions)
        .values({
          orgId: access.orgId,
          grantId: grant.grantId,
          agentId: access.actor.id,
          accountId,
          kind,
          payload,
        })
        .returning({ id: pendingActions.id });
      await this.log(access, `mail.${kind}.queued`, accountId, recipients.join(","), true, {
        pendingId: p!.id,
      });
      return {
        status: "pending_approval",
        pendingId: p!.id,
        note: "A person must approve this message in the MailMCP admin panel before it is sent. Check with get_pending_action.",
      };
    }
    return null;
  }

  async send(
    access: Access,
    accountId: string,
    input: ComposeInput,
    opts: { approved?: boolean } = {},
  ): Promise<SendOutcome> {
    const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.email);
    if (!recipients.length) throw new MailError("Add at least one recipient.");
    if (!opts.approved) {
      const gated = await this.gateSend(
        access,
        accountId,
        "send",
        { accountId, input: serializeCompose(input) },
        recipients,
      );
      if (gated) return gated;
    }
    const msg: OutboundMessage = { ...input, from: await this.fromAddress(accountId) };
    return this.deliver(access, accountId, msg, "mail.send");
  }

  private async deliver(
    access: Access,
    accountId: string,
    msg: OutboundMessage,
    action: string,
  ): Promise<SendOutcome> {
    const sent = await this.folderFor(accountId, "sent").catch(() => null);
    const r = await this.s.pool.use(accountId, (c) =>
      c.send(msg, sent ? asRemote(sent) : undefined),
    );
    await this.log(
      access,
      action,
      accountId,
      [...msg.to, ...(msg.cc ?? [])].map((a) => a.email).join(","),
      true,
      { subject: msg.subject, messageId: r.messageId },
    );
    await this.s.jobs.enqueueSync({ accountId, reason: "sent" }).catch(() => {});
    return { status: "sent", ...r };
  }

  async reply(
    access: Access,
    messageId: number,
    input: { text: string; html?: string; replyAll?: boolean },
    opts: { approved?: boolean } = {},
  ): Promise<SendOutcome> {
    const orig = await this.get(access, messageId);
    const self = orig.account.toLowerCase();
    const to = orig.replyTo.length ? orig.replyTo : orig.from ? [orig.from] : [];
    const cc = input.replyAll
      ? [...orig.to, ...orig.cc].filter(
          (a) => a.email.toLowerCase() !== self && !to.some((t) => t.email === a.email),
        )
      : [];
    if (!to.length) throw new MailError("The original message has no sender to reply to.");
    if (!opts.approved) {
      const gated = await this.gateSend(
        access,
        orig.accountId,
        "reply",
        { messageId, input },
        [...to, ...cc].map((a) => a.email),
      );
      if (gated) return gated;
    }
    const [m] = await this.db
      .select({ headersExtra: messages.headersExtra })
      .from(messages)
      .where(eq(messages.id, messageId));
    const refs = ((m?.headersExtra as { references?: string[] } | null)?.references ?? []).concat(
      orig.messageIdHeader ? [orig.messageIdHeader] : [],
    );
    const quoted = `${input.text}\n\nOn ${new Date(orig.date).toUTCString()}, ${orig.from?.name ?? orig.from?.email ?? "someone"} wrote:\n${(
      orig.text ?? ""
    )
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}`;
    const out = await this.deliver(
      access,
      orig.accountId,
      {
        from: await this.fromAddress(orig.accountId),
        to,
        cc,
        subject: /^re:/i.test(orig.subject ?? "")
          ? (orig.subject as string)
          : `Re: ${orig.subject ?? ""}`,
        text: quoted,
        html: input.html,
        inReplyTo: orig.messageIdHeader ?? undefined,
        references: refs,
      },
      "mail.reply",
    );
    // Mark the original as answered (best effort).
    await this.markAnswered(orig.accountId, messageId).catch(() => {});
    return out;
  }

  private async markAnswered(accountId: string, messageId: number) {
    const places = await this.db
      .select({ uid: messageFolders.remoteUid, folder: folders, remoteId: messages.remoteId })
      .from(messageFolders)
      .innerJoin(folders, eq(folders.id, messageFolders.folderId))
      .innerJoin(
        messages,
        and(
          eq(messages.accountId, messageFolders.accountId),
          eq(messages.id, messageFolders.messageId),
        ),
      )
      .where(and(eq(messageFolders.accountId, accountId), eq(messageFolders.messageId, messageId)));
    await this.s.pool.use(accountId, async (c) => {
      for (const p of places)
        if (p.uid)
          await c.setFlags(asRemote(p.folder), [{ remoteId: p.remoteId, remoteUid: p.uid }], {
            add: { answered: true },
          });
    });
    await this.db
      .update(messages)
      .set({ answered: true })
      .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
  }

  async forward(
    access: Access,
    messageId: number,
    input: { to: EmailAddress[]; text?: string; includeAttachments?: boolean },
    opts: { approved?: boolean } = {},
  ): Promise<SendOutcome> {
    const orig = await this.get(access, messageId);
    if (!input.to.length) throw new MailError("Add at least one recipient.");
    if (!opts.approved) {
      const gated = await this.gateSend(
        access,
        orig.accountId,
        "forward",
        { messageId, input },
        input.to.map((a) => a.email),
      );
      if (gated) return gated;
    }
    const attachments: ComposeInput["attachments"] = [];
    if (input.includeAttachments !== false) {
      for (const a of orig.attachments.filter((x) => !x.inline)) {
        const file = await this.attachment(access, messageId, a.id).catch(() => null);
        if (file)
          attachments.push({
            filename: file.filename,
            contentType: file.mime,
            content: file.content,
          });
      }
    }
    const header = [
      "---------- Forwarded message ----------",
      `From: ${orig.from ? `${orig.from.name ?? ""} <${orig.from.email}>` : ""}`,
      `Date: ${new Date(orig.date).toUTCString()}`,
      `Subject: ${orig.subject ?? ""}`,
      `To: ${orig.to.map((t) => t.email).join(", ")}`,
    ].join("\n");
    return this.deliver(
      access,
      orig.accountId,
      {
        from: await this.fromAddress(orig.accountId),
        to: input.to,
        subject: /^fwd?:/i.test(orig.subject ?? "")
          ? (orig.subject as string)
          : `Fwd: ${orig.subject ?? ""}`,
        text: `${input.text ?? ""}\n\n${header}\n\n${orig.text ?? ""}`,
        attachments,
      },
      "mail.forward",
    );
  }

  async createDraft(access: Access, accountId: string, input: ComposeInput) {
    const grant = requireScope(access, accountId, "mail:draft");
    this.policy.checkRate(grant);
    const drafts = await this.folderFor(accountId, "drafts");
    const msg: OutboundMessage = { ...input, from: await this.fromAddress(accountId) };
    await this.s.pool.use(accountId, async (c) => {
      if (!c.saveDraft) throw new MailError("This account type doesn't support drafts.");
      await c.saveDraft(msg, asRemote(drafts));
    });
    await this.log(access, "mail.draft", accountId, input.subject);
    await this.s.jobs.enqueueSync({ accountId, reason: "draft" }).catch(() => {});
    return { saved: true, folder: drafts.path };
  }

  // ───────────────────────────── folders ─────────────────────────────

  private async refreshFolders(accountId: string) {
    const remote = await this.s.pool.use(accountId, (c) => c.listFolders());
    await this.s.accounts.upsertFolders(this.db, accountId, remote);
  }

  async createFolder(access: Access, accountId: string, path: string) {
    requireScope(access, accountId, "folders:manage");
    await this.s.pool.use(accountId, async (c) => {
      if (!c.createFolder) throw new MailError("Not supported for this account type.");
      await c.createFolder(path);
    });
    await this.refreshFolders(accountId);
    await this.log(access, "folder.create", accountId, path);
    return { created: path };
  }

  async renameFolder(access: Access, accountId: string, folder: string | number, newPath: string) {
    requireScope(access, accountId, "folders:manage");
    const f = await this.folderFor(accountId, folder);
    if (f.role) throw new MailError(`"${f.path}" is a system folder and can't be renamed.`);
    await this.s.pool.use(accountId, async (c) => {
      if (!c.renameFolder) throw new MailError("Not supported for this account type.");
      await c.renameFolder(asRemote(f), newPath);
    });
    await this.refreshFolders(accountId);
    await this.log(access, "folder.rename", accountId, `${f.path} → ${newPath}`);
    return { renamed: newPath };
  }

  async deleteFolder(access: Access, accountId: string, folder: string | number) {
    requireScope(access, accountId, "folders:manage");
    const f = await this.folderFor(accountId, folder);
    if (f.role) throw new MailError(`"${f.path}" is a system folder and can't be deleted.`);
    await this.s.pool.use(accountId, async (c) => {
      if (!c.deleteFolder) throw new MailError("Not supported for this account type.");
      await c.deleteFolder(asRemote(f));
    });
    await this.refreshFolders(accountId);
    await this.s.sync.cleanupOrphans(await this.row(accountId));
    await this.log(access, "folder.delete", accountId, f.path);
    return { deleted: f.path };
  }
}

/** Attachments are stored base64 in approval payloads. */
export function serializeCompose(c: ComposeInput) {
  return {
    ...c,
    attachments: c.attachments?.map((a) => ({ ...a, content: a.content.toString("base64") })),
  };
}
export function deserializeCompose(c: ReturnType<typeof serializeCompose>): ComposeInput {
  return {
    ...c,
    attachments: c.attachments?.map((a) => ({ ...a, content: Buffer.from(a.content, "base64") })),
  };
}
