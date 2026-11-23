import { accounts, and, eq, folders, ne, sql } from "@mailmcp/db";
import type { RemoteFolder } from "@mailmcp/module-sdk";
import { QUEUES, type SyncJob } from "./jobs";
import { createLogger } from "./logger";
import type { Services } from "./services";

/**
 * The background worker, usable as its own process (Docker, development) or embedded in the
 * web server (single-process hosting such as Enhance, cPanel or Plesk):
 *  - processes `sync-account` jobs (one at a time per account, N accounts in parallel)
 *  - schedules a sync for every account every few minutes, plus a daily full reconcile
 *  - keeps an IMAP IDLE connection on each INBOX for near-instant new-mail sync
 *
 * Returns a function that stops it cleanly.
 */
export async function startWorker(svc: Services, opts: { embedded?: boolean } = {}) {
  const log = createLogger(opts.embedded ? "worker(embedded)" : "worker");
  const SYNC_EVERY_MS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 300) * 1000;
  const FULL_EVERY_MS = 24 * 60 * 60_000;
  const { db, jobs, sync } = svc;
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
        // Account deleted mid-job: nothing to retry.
        if (/not found/i.test((err as Error).message)) return;
        throw err;
      }
    },
  );

  // ─────────── Scheduler ───────────
  async function scheduleDue() {
    const rows = await db
      .select({ id: accounts.id, lastSyncAt: accounts.lastSyncAt, settings: accounts.settings })
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
    await refreshWatchers().catch((e) =>
      log.error("watchers failed", { err: (e as Error).message }),
    );
  };
  await tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  log.info("worker started", {
    concurrency: syncCfg.concurrency,
    syncEverySeconds: SYNC_EVERY_MS / 1000,
  });

  return async function stopWorker() {
    log.info("worker stopping");
    clearInterval(timer);
    for (const stop of watchers.values()) await stop().catch(() => {});
    watchers.clear();
    await jobs.stop();
  };
}
