import { randomUUID } from "node:crypto";
import {
  type AccountIdentity,
  type Connector,
  type FetchedMessage,
  type FolderRole,
  type Inventory,
  type MessageFlags,
  type MessageRef,
  type ModuleContext,
  type OutboundMessage,
  ProviderLimitError,
  type RemoteFolder,
  type SentResult,
  type SyncCursor,
  type SyncEvent,
  type SyncOptions,
} from "@mailmcp/module-sdk";
import { ImapFlow, type MailboxObject } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ImapConfig } from "./config";
import { chunk, FETCH_QUERY, toEnvelope, toFlags, uidSet } from "./envelope";
import { assignNameRoles } from "./roles";

const SPECIAL_USE: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Important": "important",
  "\\Flagged": "starred",
};

interface ImapCursor extends SyncCursor {
  uidValidity: string;
  /** Highest UID synced (everything above is "new mail"). */
  high: number;
  /** Lowest UID backfilled so far (backfill continues below this). */
  low: number;
  backfillDone: boolean;
  modseq?: string;
}

/** Gmail and others signal bandwidth/command quotas in the response text. */
function asLimitError(err: unknown): unknown {
  const text = `${(err as Error)?.message ?? ""} ${(err as { responseText?: string })?.responseText ?? ""}`;
  if (/OVERQUOTA|bandwidth|THROTTLED|too many (simultaneous )?connections|rate limit/i.test(text)) {
    return new ProviderLimitError(
      text.trim(),
      "QUOTA_EXCEEDED",
      new Date(Date.now() + 60 * 60_000),
    );
  }
  return err;
}

export class ImapConnector implements Connector {
  private client?: ImapFlow;
  private connecting?: Promise<ImapFlow>;

  constructor(private ctx: ModuleContext<ImapConfig>) {}

  private newClient(): ImapFlow {
    const { imap, username, password, allowInvalidCerts } = this.ctx.config;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      tls: { rejectUnauthorized: !allowInvalidCerts },
      auth: { user: username, pass: password },
      logger: false,
      socketTimeout: 5 * 60_000,
      connectionTimeout: 20_000,
    });
    client.on("error", (err: Error) =>
      this.ctx.log.warn("imap connection error", { err: err.message }),
    );
    return client;
  }

  private async imap(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.newClient();
        await client.connect();
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private smtp() {
    const { smtp, username, password, allowInvalidCerts } = this.ctx.config;
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      tls: { rejectUnauthorized: !allowInvalidCerts },
      auth: { user: username, pass: password },
      connectionTimeout: 20_000,
    });
  }

  private get isGmail() {
    return this.ctx.config.imap.host.endsWith("gmail.com");
  }

  /** Run `fn` with the folder selected (serialized per connection by imapflow locks). */
  private async inFolder<T>(
    folder: RemoteFolder,
    readOnly: boolean,
    fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ): Promise<T> {
    const client = await this.imap();
    const lock = await client.getMailboxLock(folder.remoteId, { readOnly });
    try {
      return await fn(client, client.mailbox as MailboxObject);
    } catch (err) {
      throw asLimitError(err);
    } finally {
      lock.release();
    }
  }

  async verify(): Promise<AccountIdentity> {
    const client = await this.imap();
    const transport = this.smtp();
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    const host = this.ctx.config.imap.host;
    return {
      address: this.ctx.address,
      traits: {
        gmail: host.endsWith("gmail.com"),
        icloud: host.endsWith("mail.me.com"),
        condstore: client.enabled.has("CONDSTORE"),
        qresync: client.enabled.has("QRESYNC"),
      },
    };
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const client = await this.imap();
    const list = await client.list({ statusQuery: { messages: true, unseen: true } });
    const guessed = new Map<string, FolderRole | undefined>();
    const folders = list.map((f) => {
      // Roles the server declares. imapflow reports standard special-use flags; Gmail also
      // marks \Important (and sometimes \All / \Flagged) as plain flags, so check those too.
      // imapflow's own guesses from folder names ("name") are only a fallback, below.
      const declared = f.specialUse && f.specialUseSource !== "name" ? f.specialUse : undefined;
      let role = declared ? SPECIAL_USE[declared] : undefined;
      if (!role) for (const flag of f.flags) role ??= SPECIAL_USE[flag];
      if (!role && f.specialUseSource === "name" && f.specialUse)
        guessed.set(f.path, SPECIAL_USE[f.specialUse]);
      if (f.path.toUpperCase() === "INBOX") role = "inbox";
      return {
        remoteId: f.path,
        path: f.path,
        delimiter: f.delimiter,
        kind: "folder" as const,
        role,
        selectable: !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"),
        messageCount: f.status?.messages,
        unreadCount: f.status?.unseen,
      } satisfies RemoteFolder;
    });
    // Name-based fallback, only for roles the server didn't declare: ours first (prefers
    // "Trash" over "Deleted Messages"), then imapflow's (knows many languages).
    assignNameRoles(folders);
    const taken = new Set(folders.map((f) => f.role).filter(Boolean));
    for (const f of folders) {
      const g = guessed.get(f.path);
      if (!f.role && g && !taken.has(g)) {
        f.role = g;
        taken.add(g);
      }
    }
    return folders;
  }

  // ───────────────────────────── Sync ─────────────────────────────

  async *sync(
    folder: RemoteFolder,
    cursor: SyncCursor | null,
    opts: SyncOptions = {},
  ): AsyncIterable<SyncEvent> {
    const client = await this.imap();
    const lock = await client.getMailboxLock(folder.remoteId, { readOnly: true });
    const batchSize = opts.batchSize ?? 250;
    try {
      const mb = client.mailbox as MailboxObject;
      const uidValidity = String(mb.uidValidity);
      const modseq = mb.highestModseq !== undefined ? String(mb.highestModseq) : undefined;
      let c = cursor as ImapCursor | null;

      if (c && c.uidValidity !== uidValidity) {
        yield { type: "reset" };
        c = null;
      }
      // First sync: everything that exists now is "backfill"; anything above is "new".
      if (!c) {
        c = {
          uidValidity,
          high: mb.uidNext - 1,
          low: mb.uidNext,
          backfillDone: mb.exists === 0,
          modseq,
        };
        yield { type: "cursor", cursor: { ...c } };
      }

      const fetchEnvelopes = async function* (uids: number[]) {
        for await (const msg of client.fetch(uidSet(uids), FETCH_QUERY, { uid: true })) {
          yield { type: "upsert", envelope: toEnvelope(msg, folder, uidValidity) } as SyncEvent;
        }
      };
      let fetched = 0;

      // Phase A — new mail above `high`, newest first.
      if (mb.uidNext - 1 > c.high) {
        const found = (await client.search({ uid: `${c.high + 1}:*` }, { uid: true })) || [];
        // "n:*" matches the last message even when n > max UID; keep only truly new UIDs.
        const fresh = found.filter((u) => u > c.high).sort((a, b) => b - a);
        for (const part of chunk(fresh, batchSize)) {
          for await (const ev of fetchEnvelopes(part)) {
            fetched++;
            yield ev;
          }
        }
        c.high = Math.max(c.high, mb.uidNext - 1, ...fresh);
        yield { type: "cursor", cursor: { ...c } };
      }

      // Phase B — backfill below `low`, newest first, checkpointing every batch.
      if (!c.backfillDone) {
        const query: Record<string, unknown> = { uid: `1:${Math.max(1, c.low - 1)}` };
        if (opts.since) query.since = opts.since;
        const older = c.low > 1 ? (await client.search(query, { uid: true })) || [] : [];
        const todo = older.filter((u) => u < c.low).sort((a, b) => b - a);
        let done = 0;
        for (const part of chunk(todo, batchSize)) {
          for await (const ev of fetchEnvelopes(part)) {
            fetched++;
            yield ev;
          }
          done += part.length;
          c.low = Math.min(...part);
          yield { type: "progress", done, total: todo.length };
          yield { type: "cursor", cursor: { ...c } };
        }
        c.backfillDone = true;
        yield { type: "cursor", cursor: { ...c } };
      }

      // Phase C — flag changes on mail we already have.
      if (modseq && c.modseq && modseq !== c.modseq && !opts.fullReconcile) {
        for await (const msg of client.fetch(
          `1:${c.high}`,
          { uid: true, flags: true },
          { uid: true, changedSince: BigInt(c.modseq) },
        )) {
          yield { type: "flags", remoteUid: msg.uid, flags: toFlags(msg.flags) };
        }
      } else if (!modseq || opts.fullReconcile) {
        // No CONDSTORE: refresh flags for the most recent ~500 messages each sync,
        // and for everything on a full reconcile.
        // Sequence numbers (not UIDs): "the last 500 messages" regardless of UID gaps.
        const range = opts.fullReconcile ? "1:*" : `${Math.max(1, mb.exists - 499)}:*`;
        if (mb.exists > 0) {
          for await (const msg of client.fetch(range, { uid: true, flags: true })) {
            yield { type: "flags", remoteUid: msg.uid, flags: toFlags(msg.flags) };
          }
        }
      }
      c.modseq = modseq;

      // Deletions — only pay for a full UID listing when counts disagree.
      const expected = (opts.knownCount ?? 0) + fetched;
      if (opts.fullReconcile || opts.knownCount === undefined || expected !== mb.exists) {
        const query: Record<string, unknown> = { all: true };
        if (opts.since) query.since = opts.since;
        const uids = mb.exists > 0 ? (await client.search(query, { uid: true })) || [] : [];
        yield { type: "present", fromUid: 1, uids };
      }
      yield { type: "cursor", cursor: { ...c } };
    } catch (err) {
      throw asLimitError(err);
    } finally {
      lock.release();
    }
  }

  async fetchMessage(folder: RemoteFolder, ref: MessageRef): Promise<FetchedMessage> {
    if (!ref.remoteUid) throw new Error("imap: fetchMessage needs a folder UID");
    return this.inFolder(folder, true, async (client) => {
      const dl = await client.download(String(ref.remoteUid), undefined, { uid: true });
      if (!dl.content) throw new Error("Message no longer exists on the server");
      const chunks: Buffer[] = [];
      for await (const c of dl.content) chunks.push(c as Buffer);
      return { raw: Buffer.concat(chunks) };
    });
  }

  async *fetchMessages(
    folder: RemoteFolder,
    refs: MessageRef[],
  ): AsyncIterable<{ ref: MessageRef; raw: Buffer }> {
    const byUid = new Map(refs.filter((r) => r.remoteUid).map((r) => [r.remoteUid as number, r]));
    if (!byUid.size) return;
    const client = await this.imap();
    const lock = await client.getMailboxLock(folder.remoteId, { readOnly: true });
    try {
      for await (const msg of client.fetch(
        uidSet([...byUid.keys()]),
        { uid: true, source: true },
        { uid: true },
      )) {
        const ref = byUid.get(msg.uid);
        if (ref && msg.source) yield { ref, raw: msg.source };
      }
    } catch (err) {
      throw asLimitError(err);
    } finally {
      lock.release();
    }
  }

  // ───────────────────────────── Sending ─────────────────────────────

  private compose(msg: OutboundMessage, messageId: string, keepBcc: boolean): Promise<Buffer> {
    const fmt = (a: { name?: string; email: string }) =>
      a.name ? { name: a.name, address: a.email } : a.email;
    const mail = new MailComposer({
      messageId,
      from: fmt(msg.from),
      to: msg.to.map(fmt),
      cc: msg.cc?.map(fmt),
      bcc: msg.bcc?.map(fmt),
      replyTo: msg.replyTo?.map(fmt),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    }).compile();
    mail.keepBcc = keepBcc;
    return mail.build();
  }

  async send(msg: OutboundMessage, sentFolder?: RemoteFolder): Promise<SentResult> {
    const domain = msg.from.email.split("@")[1] ?? "mailmcp.local";
    const messageId = `<${randomUUID()}@${domain}>`;
    const wire = await this.compose(msg, messageId, false);
    const recipients = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])].map((a) => a.email);
    const transport = this.smtp();
    let info: { accepted: unknown[]; rejected: unknown[] };
    try {
      info = await transport.sendMail({
        envelope: { from: msg.from.email, to: recipients },
        raw: wire,
      });
    } catch (err) {
      throw asLimitError(err);
    } finally {
      transport.close();
    }
    // Gmail files sent mail itself; everyone else needs an explicit copy in Sent.
    if (sentFolder && !this.isGmail) {
      const copy = await this.compose(msg, messageId, true);
      const client = await this.imap();
      await client
        .append(sentFolder.remoteId, copy, ["\\Seen"])
        .catch((err: Error) =>
          this.ctx.log.warn("could not file copy in Sent", { err: err.message }),
        );
    }
    return {
      messageId,
      accepted: info.accepted.map(String),
      rejected: info.rejected.map(String),
    };
  }

  async saveDraft(msg: OutboundMessage, drafts: RemoteFolder, replace?: MessageRef): Promise<void> {
    const domain = msg.from.email.split("@")[1] ?? "mailmcp.local";
    const raw = await this.compose(msg, `<${randomUUID()}@${domain}>`, true);
    const client = await this.imap();
    await client.append(drafts.remoteId, raw, ["\\Draft", "\\Seen"]);
    if (replace?.remoteUid) await this.expunge(drafts, [replace]);
  }

  // ───────────────────────────── Actions ─────────────────────────────

  private uids(refs: MessageRef[]): string {
    const uids = refs.map((r) => r.remoteUid).filter((u): u is number => !!u);
    if (!uids.length) throw new Error("imap: no folder UIDs given");
    return uidSet(uids);
  }

  async move(from: RemoteFolder, refs: MessageRef[], to: RemoteFolder): Promise<void> {
    await this.inFolder(from, false, (client) =>
      client.messageMove(this.uids(refs), to.remoteId, { uid: true }),
    );
  }

  async setFlags(
    folder: RemoteFolder,
    refs: MessageRef[],
    change: {
      add?: Partial<Omit<MessageFlags, "keywords">>;
      remove?: Partial<Omit<MessageFlags, "keywords">>;
      keywords?: { add?: string[]; remove?: string[] };
    },
  ): Promise<void> {
    const names: Record<string, string> = {
      seen: "\\Seen",
      flagged: "\\Flagged",
      answered: "\\Answered",
      draft: "\\Draft",
    };
    const pick = (o?: Partial<Record<string, boolean>>) =>
      Object.entries(o ?? {})
        .filter(([, v]) => v)
        .map(([k]) => names[k])
        .filter((v): v is string => !!v);
    // Keywords are atoms: no spaces, parentheses, quotes, % * ] or backslashes.
    const kw = (list?: string[]) => (list ?? []).filter((k) => /^\$?[A-Za-z0-9_.-]{1,64}$/.test(k));
    const add = [...pick(change.add), ...kw(change.keywords?.add)];
    const remove = [...pick(change.remove), ...kw(change.keywords?.remove)];
    await this.inFolder(folder, false, async (client) => {
      const range = this.uids(refs);
      if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
    });
  }

  async expunge(folder: RemoteFolder, refs: MessageRef[]): Promise<void> {
    await this.inFolder(folder, false, (client) =>
      client.messageDelete(this.uids(refs), { uid: true }),
    );
  }

  // ───────────────────────────── Copying between accounts ─────────────────────────────

  async inventory(
    folder: RemoteFolder,
    opts: { afterUid?: number; since?: Date } = {},
  ): Promise<Inventory> {
    return this.inFolder(folder, true, async (client, mb) => {
      const uidValidity = String(mb.uidValidity);
      if (mb.exists === 0) return { uidValidity, items: [] };
      const query: Record<string, unknown> = {};
      if (opts.afterUid) query.uid = `${opts.afterUid + 1}:*`;
      if (opts.since) query.since = opts.since;
      if (!Object.keys(query).length) query.all = true;
      const found = ((await client.search(query, { uid: true })) || []).filter(
        (u) => !opts.afterUid || u > opts.afterUid,
      );
      const items: Inventory["items"] = [];
      for (const part of chunk(found, 1000)) {
        for await (const msg of client.fetch(
          uidSet(part),
          { uid: true, flags: true, size: true, internalDate: true, envelope: true },
          { uid: true },
        )) {
          const d = msg.internalDate;
          items.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId?.trim() || null,
            date: d ? new Date(d) : null,
            size: msg.size ?? 0,
            flags: toFlags(msg.flags),
          });
        }
      }
      items.sort((a, b) => a.uid - b.uid);
      return { uidValidity, items };
    });
  }

  async append(
    folder: RemoteFolder,
    raw: Buffer,
    opts: { flags?: Partial<Omit<MessageFlags, "keywords">>; date?: Date } = {},
  ): Promise<void> {
    const names: Record<string, string> = {
      seen: "\\Seen",
      flagged: "\\Flagged",
      answered: "\\Answered",
      draft: "\\Draft",
    };
    const flags = Object.entries(opts.flags ?? {})
      .filter(([, v]) => v)
      .map(([k]) => names[k])
      .filter((v): v is string => !!v);
    const client = await this.imap();
    try {
      await client.append(folder.remoteId, raw, flags, opts.date);
    } catch (err) {
      throw asLimitError(err);
    }
  }

  async createFolder(path: string): Promise<RemoteFolder> {
    const client = await this.imap();
    const r = await client.mailboxCreate(path);
    return { remoteId: r.path, path: r.path, kind: "folder", selectable: true };
  }

  async renameFolder(folder: RemoteFolder, newPath: string): Promise<RemoteFolder> {
    const client = await this.imap();
    const r = await client.mailboxRename(folder.remoteId, newPath);
    return { ...folder, remoteId: r.newPath, path: r.newPath };
  }

  async deleteFolder(folder: RemoteFolder): Promise<void> {
    const client = await this.imap();
    await client.mailboxDelete(folder.remoteId);
  }

  // ───────────────────────────── Push (IDLE) ─────────────────────────────

  /**
   * Keeps a dedicated connection IDLE-ing on `folder` and calls `onChange` (debounced)
   * when mail arrives, is expunged or flags change. Reconnects with backoff.
   */
  async watch(folder: RemoteFolder, onChange: () => void): Promise<() => Promise<void>> {
    let stopped = false;
    let client: ImapFlow | undefined;
    let timer: NodeJS.Timeout | undefined;
    let backoff = 5_000;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 2_000);
    };
    const connect = async () => {
      while (!stopped) {
        try {
          client = this.newClient();
          client.on("exists", fire);
          client.on("expunge", fire);
          client.on("flags", fire);
          client.on("close", () => {
            if (!stopped) setTimeout(connect, backoff);
          });
          await client.connect();
          await client.mailboxOpen(folder.remoteId, { readOnly: true });
          backoff = 5_000;
          return; // imapflow IDLEs automatically while no command is running
        } catch (err) {
          this.ctx.log.warn("idle connect failed", { err: (err as Error).message });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 5 * 60_000);
        }
      }
    };
    await connect();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await client?.logout().catch(() => {});
      client?.close();
    };
  }

  async close(): Promise<void> {
    const client = this.client ?? (await this.connecting?.catch(() => undefined));
    this.client = undefined;
    if (!client) return;
    // logout() can leave the socket open in some states; close() guarantees it's gone.
    await client.logout().catch(() => {});
    client.close();
  }
}
