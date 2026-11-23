import { createServices, loadOrCreateMasterKey, runtime, startWorker } from "@mailmcp/core";
import { createDb } from "@mailmcp/db";
import imapModule from "@mailmcp/module-imap";
import type { ModuleManifest } from "@mailmcp/module-sdk";

/** Standalone worker process (Docker / development). The logic lives in @mailmcp/core. */
const databaseUrl = runtime.databaseUrl;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Start the server first to run the web installer, or set DATABASE_URL.",
  );
  process.exit(1);
}
const { key } = await loadOrCreateMasterKey(runtime.dataDir);
const { db, close } = createDb(databaseUrl);
const svc = createServices({
  db,
  masterKey: key,
  modules: [imapModule as unknown as ModuleManifest],
  dataDir: runtime.dataDir,
  databaseUrl,
});
const stop = await startWorker(svc);

const shutdown = async () => {
  await stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
