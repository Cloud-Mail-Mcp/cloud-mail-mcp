import {
  createLogger,
  createServices,
  loadOrCreateMasterKey,
  QUEUES,
  runtime,
  type SyncJob,
} from "@mailmcp/core";
import { accounts, and, createDb, eq, folders, ne, sql } from "@mailmcp/db";
import imapModule from "@mailmcp/module-imap";
import type { ModuleManifest, RemoteFolder } from "@mailmcp/module-sdk";

/**
 * Background worker:
 *  - processes `sync-account` jobs (one at a time per account, N accounts in parallel)
 *  - schedules a sync for every account every few minutes, plus a daily full reconcile
 *  - keeps an IMAP IDLE connection on each INBOX for near-instant new-mail sync
 */
const log = createLogger("worker");
const SYNC_EVERY_MS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 300) * 1000;
const FULL_EVERY_MS = 24 * 60 * 60_000;

const { key } = await loadOrCreateMasterKey(runtime.dataDir);
const { db, close } = createDb(runtime.databaseUrl);
const svc = createServices({
  db,
  masterKey: key,
  modules: [imapModule as unknown as ModuleManifest],
  dataDir: runtime.dataDir,
  databaseUrl: runtime.databaseUrl,
});
const { jobs, sync } = svc;
await jobs.start();

const syncCfg = await svc.settings.get("sync");
await jobs.boss.work<SyncJob>(
  QUEUES.sync,
  { localConcurrency: syncCfg.concurrency, batchSize: 1 },
  async ([job]) => {
    if (!job) return;
    const { accountId, full } = job.data;
    try {
      const r = await sync.syncAccount(accountId, { fullReconcile: full, bodyBudgetMs: 120_000 });
      if (full) {
        // Remember when the last full reconcile ran.
        await db.execute(
          sql`UPDATE accounts SET settings = jsonb_set(settings, '{lastFullAt}', to_jsonb(now()::text)) WHERE id = ${accountId}`,
        );
      }
      // Keep downloading bodies in short slices so new mail is never stuck behind a backfill.
      if (r.moreBodies)
        await jobs.enqueueSync({ accountId, reason: "bodies" }, { delaySeconds: 2 });
    } catch (err) {
      const msg = (err as Error).message;
      // Account deleted mid-job: nothing to retry.
      if (/not found/i.test(msg)) return;
      throw err;
    }
  },
);

// ─────────── Scheduler ───────────
async function scheduleDue() {
  const rows = await db
    .select({
      id: accounts.id,
      lastSyncAt: accounts.lastSyncAt,
      status: accounts.status,
      settings: accounts.settings,
    })
    .from(accounts)
    .where(ne(accounts.status, "disabled"));
  for (const a of rows) {
    const lastFull = Date.parse((a.settings as { lastFullAt?: string })?.lastFullAt ?? "") || 0;
    const due = !a.lastSyncAt || Date.now() - a.lastSyncAt.getTime() > SYNC_EVERY_MS;
    const fullDue = a.lastSyncAt && Date.now() - lastFull > FULL_EVERY_MS;
    if (due || fullDue)
      await jobs.enqueueSync({ accountId: a.id, full: Boolean(fullDue), reason: "schedule" });
  }
}

// ─────────── IDLE watchers on INBOX ───────────
const watchers = new Map<string, () => Promise<void>>();
async function refreshWatchers() {
  const rows = await db
    .select({ account: accounts, inbox: folders })
    .from(accounts)
    .innerJoin(folders, and(eq(folders.accountId, accounts.id), eq(folders.role, "inbox")))
    .where(ne(accounts.status, "disabled"));
  const wanted = new Set(rows.map((r) => r.account.id));
  for (const [id, stop] of watchers) {
    if (!wanted.has(id)) {
      watchers.delete(id);
      await stop().catch(() => {});
    }
  }
  for (const { account, inbox } of rows) {
    if (watchers.has(account.id) || account.status === "auth_error") continue;
    try {
      const connector = await svc.accounts.connectorFor(
        account,
        undefined,
        log.child({ accountId: account.id, idle: true }),
      );
      if (!connector.watch) continue;
      const remote: RemoteFolder = {
        remoteId: inbox.remoteId,
        path: inbox.path,
        kind: "folder",
        selectable: true,
      };
      const stop = await connector.watch(remote, () => {
        log.info("new mail signal", { accountId: account.id });
        jobs.enqueueSync({ accountId: account.id, reason: "idle" }).catch(() => {});
      });
      watchers.set(account.id, async () => {
        await stop();
        await connector.close();
      });
    } catch (err) {
      log.warn("could not start IDLE watcher", {
        accountId: account.id,
        err: (err as Error).message,
      });
    }
  }
}

const tick = async () => {
  await scheduleDue().catch((e) => log.error("schedule failed", { err: (e as Error).message }));
  await refreshWatchers().catch((e) => log.error("watchers failed", { err: (e as Error).message }));
};
await tick();
const timer = setInterval(tick, 60_000);
log.info("worker started", {
  concurrency: syncCfg.concurrency,
  syncEverySeconds: SYNC_EVERY_MS / 1000,
});

const shutdown = async () => {
  log.info("shutting down");
  clearInterval(timer);
  for (const stop of watchers.values()) await stop().catch(() => {});
  await jobs.stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
