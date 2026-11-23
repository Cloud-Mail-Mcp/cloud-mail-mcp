// Throwaway (not committed): local MailMCP with embedded worker on :8899, test database.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorker } from "@mailmcp/core";
import { createDb } from "@mailmcp/db";
import { prepareTestDatabase } from "@mailmcp/db/testing";
import { buildApp } from "./src/app";
import { config } from "./src/config";

const url = await prepareTestDatabase(config.databaseUrl);
const d = createDb(url);
const built = await buildApp({
  db: d.db,
  config: { ...config, databaseUrl: url, dataDir: join(tmpdir(), "mailmcp-uitest") },
  masterKey: Buffer.alloc(32, 9),
  masterKeyInfo: { source: "env" },
});
await built.app.listen({ host: "127.0.0.1", port: 8899 });
await startWorker(built.deps as never, { embedded: true });
console.log("listening");
