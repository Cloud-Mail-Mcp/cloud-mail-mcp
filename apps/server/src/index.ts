import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  loadOrCreateMasterKey,
  loadSavedConfig,
  runtime,
  startWorker,
} from "@mailmcp/core";
import { createDb, runMigrations } from "@mailmcp/db";
import { buildApp } from "./app";
import { config } from "./config";
import { runInstaller } from "./installer";

const log = createLogger("server");

// 1. Database: environment → saved installer config → web installer (first run).
if (!loadSavedConfig()) {
  await runInstaller({ host: config.host, port: config.port });
  log.info("database connected via installer");
}

// 2. Schema is always brought up to date on start (idempotent).
if (process.env.MAILMCP_AUTO_MIGRATE !== "false") {
  await runMigrations(config.databaseUrl, runtime.migrationsDir);
}

const { key, ...masterKeyInfo } = await loadOrCreateMasterKey(config.dataDir);
const { db, close } = createDb(config.databaseUrl);
const { app, deps } = await buildApp({ db, config, masterKey: key, masterKeyInfo });

// 3. Single-process hosting (bundle, or Docker's default) runs the sync worker in this process.
const embedded = process.env.MAILMCP_EMBEDDED_WORKER === "true" || runtime.install === "bundle";
const stopWorker = embedded ? await startWorker(deps, { embedded: true }) : null;

await app.listen({ host: config.host, port: config.port });

let shuttingDown = false;
const shutdown = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopWorker?.().catch(() => {});
  await app.close();
  await close();
  process.exit(code);
};
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

// 4. Git-deployed bundles (e.g. Enhance "GitHub deploy"): when a new deploy replaces the
//    `deploys/current` link, exit so the panel's process manager starts the new version.
if (runtime.install === "bundle") {
  const link = process.env.MAILMCP_DEPLOY_LINK ?? join(homedir(), "deploys", "current");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = real(runtime.home);
  if (existsSync(link) && real(link) === self) {
    log.info("watching for new deploys", { link });
    setInterval(() => {
      const now = real(link);
      if (now && now !== self) {
        log.info("new version deployed; restarting onto it", { from: self, to: now });
        void shutdown(0);
      }
    }, 30_000).unref();
  }
}
