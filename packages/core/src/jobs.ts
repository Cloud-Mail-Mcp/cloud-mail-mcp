import { PgBoss } from "pg-boss";

export const QUEUES = {
  /** One active + one queued per account (stately + singletonKey). */
  sync: "sync-account",
  /** Approved sends waiting to go out. */
  send: "send-message",
  /** One pass of an account → account migration (one at a time per migration). */
  migrate: "migrate-mail",
} as const;

export interface SyncJob {
  accountId: string;
  full?: boolean;
  reason?: string;
}

/** Thin wrapper over pg-boss used by both server (enqueue) and worker (process). */
export class Jobs {
  readonly boss: PgBoss;
  private ready?: Promise<void>;

  constructor(databaseUrl: string) {
    this.boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
    this.boss.on("error", (err) => process.stderr.write(`[pg-boss] ${(err as Error).message}\n`));
  }

  start(): Promise<void> {
    this.ready ??= (async () => {
      await this.boss.start();
      await this.boss.createQueue(QUEUES.sync, {
        policy: "stately",
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 60 * 60,
      });
      await this.boss.createQueue(QUEUES.migrate, {
        policy: "stately",
        retryLimit: 0,
        expireInSeconds: 30 * 60,
      });
      await this.boss.createQueue(QUEUES.send, {
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      });
    })();
    return this.ready;
  }

  async enqueueSync(job: SyncJob, opts: { delaySeconds?: number } = {}) {
    await this.start();
    return this.boss.send(QUEUES.sync, job, {
      singletonKey: job.accountId,
      startAfter: opts.delaySeconds,
    });
  }

  async enqueueMigration(migrationId: string, opts: { delaySeconds?: number } = {}) {
    await this.start();
    return this.boss.send(
      QUEUES.migrate,
      { migrationId },
      { singletonKey: migrationId, startAfter: opts.delaySeconds },
    );
  }

  async stop() {
    if (this.ready) await this.boss.stop({ graceful: true, timeout: 30_000 });
  }
}
