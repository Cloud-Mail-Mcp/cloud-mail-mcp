import { loadOrCreateMasterKey } from "@mailmcp/core";
import { createDb } from "@mailmcp/db";
import { buildApp } from "./app";
import { config } from "./config";

const { key, ...masterKeyInfo } = await loadOrCreateMasterKey(config.dataDir);

const { db, close } = createDb(config.databaseUrl);
const { app } = await buildApp({ db, config, masterKey: key, masterKeyInfo });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
