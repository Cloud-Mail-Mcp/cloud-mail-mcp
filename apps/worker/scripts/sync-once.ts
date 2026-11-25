/** Dev: run one sync for an account (or all) in the foreground and print timings. */
import { createServices, loadOrCreateMasterKey, runtime } from "@cloud-mail-mcp/core";
import { accounts, createDb } from "@cloud-mail-mcp/db";
import imapModule from "@cloud-mail-mcp/module-imap";
import type { ModuleManifest } from "@cloud-mail-mcp/module-sdk";

const { key } = await loadOrCreateMasterKey(runtime.dataDir);
const databaseUrl = runtime.databaseUrl as string;
const { db, close } = createDb(databaseUrl);
const svc = createServices({
  db,
  masterKey: key,
  modules: [imapModule as unknown as ModuleManifest],
  dataDir: runtime.dataDir,
  databaseUrl,
});
const ids = process.argv[2]
  ? [process.argv[2]]
  : (await db.select({ id: accounts.id }).from(accounts)).map((a) => a.id);
const full = process.argv.includes("--full");
for (const id of ids) {
  const t = Date.now();
  const r = await svc.sync.syncAccount(id, {
    fullReconcile: full,
    bodyBudgetMs: Number(process.env.BODY_BUDGET_MS ?? 60_000),
  });
  console.log(JSON.stringify({ account: id, ...r, seconds: ((Date.now() - t) / 1000).toFixed(1) }));
}
await close();
