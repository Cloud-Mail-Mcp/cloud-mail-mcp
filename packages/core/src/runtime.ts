import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Settings shared by server and worker. `.env` only needs DATABASE_URL. */
export const runtime = {
  repoRoot,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://mailmcp:mailmcp@localhost:5433/mailmcp",
  dataDir: (() => {
    const d = process.env.MAILMCP_DATA_DIR ?? "data";
    return isAbsolute(d) ? d : resolve(repoRoot, d);
  })(),
};
