import type { Db } from "@mailmcp/db";
import type { ModuleManifest } from "@mailmcp/module-sdk";
import { PostgresSearchIndex, type SearchIndex } from "@mailmcp/search";
import { AccountService } from "./accounts";
import { BlobService } from "./blobs";
import { Jobs } from "./jobs";
import { MigrationService } from "./migrate";
import { ConnectorPool } from "./pool";
import { ModuleRegistry } from "./registry";
import { SettingsService } from "./settings";
import { SyncService } from "./sync";

export interface Services {
  db: Db;
  registry: ModuleRegistry;
  accounts: AccountService;
  settings: SettingsService;
  blobs: BlobService;
  search: SearchIndex;
  sync: SyncService;
  pool: ConnectorPool;
  jobs: Jobs;
  migrations: MigrationService;
}

/** Wire up every core service. Used by both the server and the worker. */
export function createServices(opts: {
  db: Db;
  masterKey: Buffer;
  modules: ModuleManifest[];
  dataDir: string;
  databaseUrl: string;
}): Services {
  const registry = new ModuleRegistry(opts.modules);
  const accounts = new AccountService(opts.db, opts.masterKey, registry);
  const settings = new SettingsService(opts.db, opts.masterKey);
  const blobs = new BlobService(settings, opts.dataDir);
  const search = new PostgresSearchIndex(opts.db);
  const sync = new SyncService({ db: opts.db, accounts, settings, blobs, search });
  const pool = new ConnectorPool(accounts);
  const jobs = new Jobs(opts.databaseUrl);
  const migrations = new MigrationService(opts.db, accounts, jobs);

  // Removing an account also removes its stored mail and live connections.
  accounts.onRemoved = async (row) => {
    await pool.evict(row.id);
    const store = await blobs.get();
    await store.deletePrefix(`${row.orgId}/${row.id}/`).catch(() => {});
  };

  return {
    db: opts.db,
    registry,
    accounts,
    settings,
    blobs,
    search,
    sync,
    pool,
    jobs,
    migrations,
  };
}
