import { createServices, loadOrCreateMasterKey, runtime, startWorker } from "@cloud-mail-mcp/core";
import { createDb } from "@cloud-mail-mcp/db";
import imapModule from "@cloud-mail-mcp/module-imap";
import type { ModuleManifest } from "@cloud-mail-mcp/module-sdk";

/** Standalone worker process (Docker / development). The logic lives in @cloud-mail-mcp/core. */
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
