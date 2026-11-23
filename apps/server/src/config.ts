import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * `.env` only carries how to reach the database (plus optional host/port/data dir).
 * Everything else — mail accounts, storage, sync — is configured in the admin panel.
 */
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://mailmcp:mailmcp@localhost:5433/mailmcp",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  dataDir: (() => {
    const d = process.env.MAILMCP_DATA_DIR ?? "data";
    return isAbsolute(d) ? d : resolve(repoRoot, d);
  })(),
  adminDist: resolve(repoRoot, "apps/admin/dist"),
  /** Secure cookies require HTTPS; on by default when not bound to localhost. */
  secureCookies: process.env.SECURE_COOKIES
    ? process.env.SECURE_COOKIES === "true"
    : !["127.0.0.1", "localhost", "::1"].includes(process.env.HOST ?? "127.0.0.1"),
};
