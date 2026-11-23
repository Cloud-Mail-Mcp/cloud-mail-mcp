import { accounts, and, type Db, desc, eq, inArray, migrations, or, sql } from "@mailmcp/db";
import type { Connector, InventoryItem, RemoteFolder } from "@mailmcp/module-sdk";
import type { AccountRow, AccountService } from "./accounts";
import { audit } from "./audit";
import { friendlyError } from "./errors";
import type { Jobs } from "./jobs";
import { createLogger } from "./logger";

type Logger = ReturnType<typeof createLogger>;

/** Folders that are views of other folders (Gmail): copying them would duplicate mail. */
const VIRTUAL_ROLES = new Set(["important", "starred"]);
/** The same Gmail views by name, for servers that don't flag them. */
const GMAIL_VIRTUAL = /^\[(gmail|google mail)\][/.](important|starred)$/i;
/**
 * Gmail's "All Mail" holds every message, including archived mail that's in no other folder.
 * Only those are copied (to Archive), after everything else, so nothing is duplicated.
 */
const isAllMail = (f: RemoteFolder) =>
  f.role === "all" || /^\[(gmail|google mail)\][/.]all mail$/i.test(f.path);
/** Roles worth matching across servers whatever the folders are called. */
const MATCH_ROLES = new Set(["inbox", "sent", "drafts", "trash", "spam", "archive"]);
/** Messages copied per round trip. */
const BATCH = 20;

export type MigrationRow = typeof migrations.$inferSelect;

/** Progress of one source folder in one direction. */
export interface FolderState {
  from: string;
  source: string;
  target: string;
  uidValidity: string | null;
  /** Highest source position handled; newer mail is above it. */
  lastUid: number;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  /** Everything in the folder has been looked at once. */
  done: boolean;
  lastError?: string;
}

export interface FolderPlan {
  source: RemoteFolder;
  targetPath: string;
  targetExists: boolean;
  /** Copy only messages that aren't anywhere else on the target (Gmail All Mail → Archive). */
  archiveOnly?: boolean;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const stateKey = (accountId: string, path: string) => `${accountId}|${path}`;

/** Key that identifies the same message on two servers. */
function messageKey(m: Pick<InventoryItem, "messageId" | "date" | "size">): string {
  if (m.messageId) return `id:${m.messageId.toLowerCase()}`;
  return `d:${m.date ? Math.floor(m.date.getTime() / 1000) : "?"}|${m.size}`;
}

/** Per-message server refusals (too big, bad message…) vs. connection trouble. */
function perMessageError(err: unknown): boolean {
  const e = err as { responseStatus?: string; serverResponseCode?: string };
  return e?.responseStatus === "NO" || e?.responseStatus === "BAD";
}

/**
 * Decide where each source folder goes on the target: special folders (Inbox, Sent, Trash…) by
 * role, everything else by name, adapting to the target's separator and "INBOX." prefix.
 */
export function planFolders(source: RemoteFolder[], target: RemoteFolder[]): FolderPlan[] {
  const sep = target.find((f) => f.delimiter)?.delimiter ?? "/";
  const others = target.filter((f) => f.path.toUpperCase() !== "INBOX");
  const inboxPrefix =
    others.length > 0 && others.every((f) => f.path.toUpperCase().startsWith(`INBOX${sep}`));
  const byRole = new Map(target.filter((f) => f.role).map((f) => [f.role as string, f]));
  const byPath = new Map(target.map((f) => [f.path.toLowerCase(), f]));

  const plan: FolderPlan[] = [];
  const used = new Set<string>();
  for (const f of source) {
    if (!f.selectable || (f.role && VIRTUAL_ROLES.has(f.role)) || GMAIL_VIRTUAL.test(f.path))
      continue;
    const archiveOnly = isAllMail(f);
    const role = archiveOnly ? "archive" : f.role;
    const roleMatch = role && MATCH_ROLES.has(role) ? byRole.get(role) : undefined;
    let targetPath: string;
    if (roleMatch) targetPath = roleMatch.path;
    else {
      const srcSep = f.delimiter || "/";
      let parts = archiveOnly ? ["Archive"] : f.path.split(srcSep).filter(Boolean);
      if (parts.length > 1 && parts[0]?.toUpperCase() === "INBOX") parts = parts.slice(1);
      if (parts.length > 1 && /^\[gmail\]$/i.test(parts[0] ?? "")) parts = parts.slice(1);
      parts = parts.map((p) => p.split(sep).join("-"));
      if (inboxPrefix && parts[0]?.toUpperCase() !== "INBOX") parts = ["INBOX", ...parts];
      targetPath = parts.join(sep);
      targetPath = byPath.get(targetPath.toLowerCase())?.path ?? targetPath;
    }
    const key = `${f.path}→${targetPath}`;
    if (used.has(key)) continue;
    used.add(key);
    plan.push({
      source: f,
      targetPath,
      targetExists: byPath.has(targetPath.toLowerCase()),
      ...(archiveOnly ? { archiveOnly } : {}),
    });
  }
  // All Mail last: by then everything that's in a real folder is already on the target.
  return [...plan.filter((p) => !p.archiveOnly), ...plan.filter((p) => p.archiveOnly)];
}

export class MigrationService {
  private log: Logger;

  constructor(
    private db: Db,
    private accountsSvc: AccountService,
    private jobs: Jobs,
    log?: Logger,
  ) {
    this.log = log ?? createLogger("migrate");
  }

  // ───────────────────────────── management ─────────────────────────────

  async list(orgId: string) {
    return this.db
      .select()
      .from(migrations)
      .where(eq(migrations.orgId, orgId))
      .orderBy(desc(migrations.createdAt));
  }

  async get(orgId: string, id: string): Promise<MigrationRow> {
    const [row] = await this.db
      .select()
      .from(migrations)
      .where(and(eq(migrations.orgId, orgId), eq(migrations.id, id)));
    if (!row) throw new MigrationError("Migration not found.", 404);
    return row;
  }

  private async pair(orgId: string, fromId: string, toId: string) {
    if (fromId === toId) throw new MigrationError("Choose two different accounts.");
    const rows = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), inArray(accounts.id, [fromId, toId])));
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from || !to) throw new MigrationError("Account not found.", 404);
    return { from, to };
  }

  /** What a migration would do: the folder mapping and how much mail is on each side. */
  async preview(orgId: string, fromId: string, toId: string, twoWay = false) {
    const { from, to } = await this.pair(orgId, fromId, toId);
    return this.withConnectors(from, to, async (src, dst) => {
      const [a, b] = await Promise.all([src.listFolders(), dst.listFolders()]);
      const describe = (plan: FolderPlan[]) =>
        plan.map((p) => ({
          source: p.source.path,
          target: p.targetPath,
          targetExists: p.targetExists,
          archiveOnly: p.archiveOnly ?? false,
          messages: p.source.messageCount ?? null,
        }));
      return {
        forward: describe(planFolders(a, b)),
        backward: twoWay ? describe(planFolders(b, a)) : [],
      };
    });
  }

  async create(
    orgId: string,
    userId: string,
    input: { fromAccountId: string; toAccountId: string; twoWay?: boolean; continuous?: boolean },
  ): Promise<MigrationRow> {
    const { from, to } = await this.pair(orgId, input.fromAccountId, input.toAccountId);
    const clash = await this.db
      .select({ id: migrations.id })
      .from(migrations)
      .where(
        and(
          eq(migrations.orgId, orgId),
          sql`${migrations.status} <> 'finished'`,
          or(
            and(eq(migrations.fromAccountId, from.id), eq(migrations.toAccountId, to.id)),
            and(eq(migrations.fromAccountId, to.id), eq(migrations.toAccountId, from.id)),
          ),
        ),
      );
    if (clash.length)
      throw new MigrationError("These two accounts already have a migration running.", 409);
    const [row] = await this.db
      .insert(migrations)
      .values({
        orgId,
        fromAccountId: from.id,
        toAccountId: to.id,
        twoWay: input.twoWay ?? false,
        continuous: input.continuous ?? true,
        createdBy: userId,
      })
      .returning();
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: to.id,
      action: "migration.create",
      target: `${from.address} → ${to.address}`,
      detail: { twoWay: row!.twoWay, continuous: row!.continuous },
    });
    await this.jobs.enqueueMigration(row!.id).catch(() => {});
    return row!;
  }

  /**
   * Change a migration: pause/resume/finish, both ways or not, keep syncing or not, or
   * reverse its direction (copy from the other account from now on).
   */
  async update(
    orgId: string,
    userId: string,
    id: string,
    input: {
      status?: "active" | "paused" | "finished";
      twoWay?: boolean;
      continuous?: boolean;
      reverse?: boolean;
    },
  ): Promise<MigrationRow> {
    const row = await this.get(orgId, id);
    const patch: Partial<typeof migrations.$inferInsert> = {};
    if (input.status) patch.status = input.status;
    if (input.twoWay !== undefined) patch.twoWay = input.twoWay;
    if (input.continuous !== undefined) patch.continuous = input.continuous;
    if (input.reverse) {
      patch.fromAccountId = row.toAccountId;
      patch.toAccountId = row.fromAccountId;
      patch.initialDoneAt = null;
    }
    if (input.status === "active" && row.status !== "active") patch.lastError = null;
    const [next] = await this.db
      .update(migrations)
      .set(patch)
      .where(eq(migrations.id, id))
      .returning();
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: next!.toAccountId,
      action: "migration.update",
      target: id,
      detail: input,
    });
    if (next!.status === "active") await this.jobs.enqueueMigration(id).catch(() => {});
    return next!;
  }

  async remove(orgId: string, userId: string, id: string) {
    const row = await this.get(orgId, id);
    await this.db.delete(migrations).where(eq(migrations.id, id));
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: row.toAccountId,
      action: "migration.delete",
      target: id,
    });
  }

  async runNow(orgId: string, id: string) {
    const row = await this.get(orgId, id);
    if (row.status !== "active") throw new MigrationError("Resume the migration first.");
    await this.jobs.enqueueMigration(id);
  }

  /**
   * Forget passes that were running when the process stopped (call once when the worker
   * starts; MailMCP runs one worker).
   */
  async releaseAll() {
    await this.db.update(migrations).set({ running: false }).where(eq(migrations.running, true));
  }

  /** Active migrations that are due another pass (used by the worker's scheduler). */
  async due(everyMs: number): Promise<string[]> {
    const rows = await this.db
      .select({
        id: migrations.id,
        continuous: migrations.continuous,
        initialDoneAt: migrations.initialDoneAt,
        lastRunAt: migrations.lastRunAt,
        running: migrations.running,
      })
      .from(migrations)
      .where(eq(migrations.status, "active"));
    const now = Date.now();
    return rows
      .filter((r) => {
        const since = r.lastRunAt ? now - r.lastRunAt.getTime() : Number.POSITIVE_INFINITY;
        if (r.running) return since > 5 * 60_000; // no heartbeat: the pass died
        // One-off copies retry after errors until their first pass completes.
        if (!r.continuous && r.initialDoneAt) return false;
        return since > everyMs;
      })
      .map((r) => r.id);
  }

  // ───────────────────────────── copying ─────────────────────────────

  private async withConnectors<T>(
    from: AccountRow,
    to: AccountRow,
    fn: (src: Connector, dst: Connector) => Promise<T>,
  ): Promise<T> {
    const src = await this.accountsSvc.connectorFor(
      from,
      undefined,
      this.log.child({ from: from.id }),
    );
    try {
      const dst = await this.accountsSvc.connectorFor(to, undefined, this.log.child({ to: to.id }));
      try {
        for (const [c, a] of [
          [src, from],
          [dst, to],
        ] as const) {
          if (!c.inventory || !c.append || !c.fetchMessages || !c.createFolder)
            throw new MigrationError(`${a.address} (${a.moduleId}) can't be used for migrations.`);
        }
        return await fn(src, dst);
      } finally {
        await dst.close().catch(() => {});
      }
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(friendlyError(err).message, 502);
    } finally {
      await src.close().catch(() => {});
    }
  }

  /**
   * One pass: copy whatever is missing, folder by folder, for up to `budgetMs`. Returns
   * `more: true` when it stopped early and should continue right away. Never deletes.
   */
  async runPass(id: string, budgetMs = 4 * 60_000): Promise<{ more: boolean; copied: number }> {
    // Take the lease: one pass at a time. A running pass refreshes lastRunAt after every batch,
    // so a lease without a heartbeat for 5 minutes belongs to a pass that died.
    const [m] = await this.db
      .update(migrations)
      .set({ running: true, lastRunAt: new Date() })
      .where(
        and(
          eq(migrations.id, id),
          eq(migrations.status, "active"),
          sql`(${migrations.running} = false OR ${migrations.lastRunAt} < now() - interval '5 minutes')`,
        ),
      )
      .returning();
    if (!m) return { more: false, copied: 0 };

    const deadline = Date.now() + budgetMs;
    const state = { ...(m.state as Record<string, FolderState>) };
    let copied = 0;
    let more = false;
    let error: string | null = null;
    const save = async () => {
      await this.db
        .update(migrations)
        .set({
          state: sql`${migrations.state} || ${JSON.stringify(state)}::jsonb`,
          lastRunAt: new Date(), // heartbeat
        })
        .where(eq(migrations.id, id));
    };
    const stillActive = async () => {
      const [r] = await this.db
        .select({ status: migrations.status, from: migrations.fromAccountId })
        .from(migrations)
        .where(eq(migrations.id, id));
      return r?.status === "active" && r.from === m.fromAccountId;
    };

    try {
      const [from, to] = await Promise.all([
        this.accountsSvc.byId(m.fromAccountId),
        this.accountsSvc.byId(m.toAccountId),
      ]);
      await this.withConnectors(from, to, async (a, b) => {
        const directions: Array<[AccountRow, Connector, Connector]> = [[from, a, b]];
        if (m.twoWay) directions.push([to, b, a]);
        for (const [srcRow, src, dst] of directions) {
          const [srcFolders, dstFolders] = await Promise.all([
            src.listFolders(),
            dst.listFolders(),
          ]);
          const dstByPath = new Map(dstFolders.map((f) => [f.path.toLowerCase(), f]));
          for (const p of planFolders(srcFolders, dstFolders)) {
            if (Date.now() > deadline || !(await stillActive())) {
              more = Date.now() > deadline;
              return;
            }
            const key = stateKey(srcRow.id, p.source.path);
            const st: FolderState = state[key] ?? {
              from: srcRow.id,
              source: p.source.path,
              target: p.targetPath,
              uidValidity: null,
              lastUid: 0,
              total: 0,
              copied: 0,
              skipped: 0,
              failed: 0,
              done: false,
            };
            st.target = p.targetPath;
            st.total = p.source.messageCount ?? st.total;
            state[key] = st;
            let target = dstByPath.get(p.targetPath.toLowerCase());
            if (!target) {
              target = await (dst.createFolder as NonNullable<Connector["createFolder"]>)(
                p.targetPath,
              );
              dstByPath.set(p.targetPath.toLowerCase(), target);
            }
            const r = await this.copyFolder(src, dst, p.source, target, st, deadline, save, {
              // All Mail: skip anything already in any folder on the target.
              compareWith: p.archiveOnly
                ? [...dstByPath.values()].filter((f) => f.selectable)
                : undefined,
            });
            copied += r.copied;
            await save();
            if (r.more) {
              more = true;
              return;
            }
          }
        }
      });
    } catch (err) {
      error = err instanceof MigrationError ? err.message : friendlyError(err).message;
      this.log.warn("migration pass failed", { id, err: error });
    }

    const forwardDone = Object.values(state)
      .filter((s) => s.from === m.fromAccountId)
      .every((s) => s.done);
    const finishedNow = !error && !more && forwardDone;
    await this.db
      .update(migrations)
      .set({
        state: sql`${migrations.state} || ${JSON.stringify(state)}::jsonb`,
        running: false,
        lastRunAt: new Date(),
        lastError: error,
        ...(finishedNow && !m.initialDoneAt ? { initialDoneAt: new Date() } : {}),
        ...(finishedNow && !m.continuous ? { status: "finished" } : {}),
      })
      .where(eq(migrations.id, id));
    // Show copied mail in MailMCP soon.
    if (copied) {
      await this.jobs
        .enqueueSync({ accountId: m.toAccountId, reason: "migration" })
        .catch(() => {});
      if (m.twoWay)
        await this.jobs
          .enqueueSync({ accountId: m.fromAccountId, reason: "migration" })
          .catch(() => {});
    }
    return { more: more && !error, copied };
  }

  private async copyFolder(
    src: Connector,
    dst: Connector,
    folder: RemoteFolder,
    target: RemoteFolder,
    st: FolderState,
    deadline: number,
    save: () => Promise<void>,
    opts: { compareWith?: RemoteFolder[] } = {},
  ): Promise<{ copied: number; more: boolean }> {
    const inventory = src.inventory as NonNullable<Connector["inventory"]>;
    let inv = await inventory.call(src, folder, { afterUid: st.lastUid });
    if (st.uidValidity && inv.uidValidity !== st.uidValidity) {
      // The server renumbered the folder: start over (already-copied mail is skipped).
      st.lastUid = 0;
      inv = await inventory.call(src, folder, {});
    }
    st.uidValidity = inv.uidValidity;
    if (!inv.items.length) {
      st.done = true;
      return { copied: 0, more: false };
    }

    // What the target already has. A first pass reads the whole folder; later passes only
    // need the days the new mail is from.
    const oldest = Math.min(...inv.items.map((i) => i.date?.getTime() ?? 0));
    const since =
      st.lastUid > 0 && oldest > 0 ? new Date(oldest - 2 * 24 * 60 * 60_000) : undefined;
    const have = new Set<string>();
    for (const f of opts.compareWith ?? [target])
      for (const it of (await inventory.call(dst, f, since ? { since } : {})).items)
        have.add(messageKey(it));

    let copied = 0;
    for (let i = 0; i < inv.items.length; i += BATCH) {
      if (Date.now() > deadline) return { copied, more: true };
      const batch = inv.items.slice(i, i + BATCH);
      const todo = batch.filter((it) => !have.has(messageKey(it)));
      st.skipped += batch.length - todo.length;
      if (todo.length) {
        const byUid = new Map(todo.map((t) => [t.uid, t]));
        const fetchMessages = src.fetchMessages as NonNullable<Connector["fetchMessages"]>;
        for await (const { ref, raw } of fetchMessages.call(
          src,
          folder,
          todo.map((t) => ({ remoteId: String(t.uid), remoteUid: t.uid })),
        )) {
          const it = byUid.get(ref.remoteUid as number);
          if (!it) continue;
          byUid.delete(it.uid);
          try {
            await (dst.append as NonNullable<Connector["append"]>).call(dst, target, raw, {
              flags: {
                seen: it.flags.seen,
                flagged: it.flags.flagged,
                answered: it.flags.answered,
                draft: it.flags.draft,
              },
              date: it.date ?? undefined,
            });
            have.add(messageKey(it));
            st.copied++;
            copied++;
          } catch (err) {
            if (!perMessageError(err)) throw err;
            st.failed++;
            st.lastError = `${(err as Error).message}`.slice(0, 300);
          }
        }
        // Messages deleted from the source while we worked: nothing to copy.
        st.skipped += byUid.size;
      }
      st.lastUid = batch[batch.length - 1]!.uid;
      await save();
    }
    st.done = true;
    return { copied, more: false };
  }
}
