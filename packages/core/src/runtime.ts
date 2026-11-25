import "./env-compat";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How this copy of Cloud Mail MCP was installed. Each install type keeps its files in a different
 * place, so every path the app needs is resolved here.
 *
 * - source:  a git checkout (development)
 * - docker:  the Docker image run by a panel (Easypanel, Coolify, …) or `docker run`
 * - compose: the Docker image under deploy/compose.yml (has the updater container)
 * - bundle:  the prebuilt Node.js bundle (shared hosting: Enhance, cPanel, Plesk, …)
 */
export type InstallType = "source" | "docker" | "compose" | "bundle";

const install = (process.env.CLOUD_MAIL_MCP_INSTALL ?? "source") as InstallType;
const bundled = install === "bundle";

/** App root: the repo root for source/Docker, the unpacked folder for the bundle. */
const home =
  process.env.CLOUD_MAIL_MCP_HOME ?? fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Persistent data (encryption key, local mail storage, saved DB connection). For the bundle it
 * lives OUTSIDE the app folder (~/cloud-mail-mcp-data) so redeploys never touch it.
 */
const dataDir = (() => {
  // Bundles installed before the rename keep their data in ~/mailmcp-data.
  const bundleDir = existsSync(join(homedir(), "cloud-mail-mcp-data"))
    ? join(homedir(), "cloud-mail-mcp-data")
    : existsSync(join(homedir(), "mailmcp-data"))
      ? join(homedir(), "mailmcp-data")
      : join(homedir(), "cloud-mail-mcp-data");
  const d = process.env.CLOUD_MAIL_MCP_DATA_DIR ?? (bundled ? bundleDir : "data");
  return isAbsolute(d) ? d : resolve(home, d);
})();

const DEV_DATABASE_URL = "postgres://mailmcp:mailmcp@localhost:5433/mailmcp";

export const runtime = {
  install,
  home,
  /** @deprecated use `home` */
  repoRoot: home,
  dataDir,
  /** Database URL saved by the web installer (loaded at startup if DATABASE_URL isn't set). */
  configFile: join(dataDir, "config.env"),
  adminDist:
    process.env.CLOUD_MAIL_MCP_ADMIN_DIST ?? join(home, bundled ? "admin" : "apps/admin/dist"),
  migrationsDir:
    process.env.CLOUD_MAIL_MCP_MIGRATIONS_DIR ??
    join(home, bundled ? "drizzle" : "packages/db/drizzle"),
  /**
   * Read at call time: the web installer sets it after startup. Source checkouts fall back to
   * the dev database; every other install type must be configured (or use the installer).
   */
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL || (install === "source" ? DEV_DATABASE_URL : undefined);
  },
};

/**
 * Load the database connection saved by the web installer (and, for the bundle, an optional
 * `.env` next to the app). Never overrides variables already set in the environment.
 * Returns true if DATABASE_URL is available afterwards.
 */
export function loadSavedConfig(): boolean {
  const files = [runtime.configFile, ...(install === "bundle" ? [join(home, ".env")] : [])];
  for (const f of files) {
    if (existsSync(f)) process.loadEnvFile(f);
  }
  return Boolean(runtime.databaseUrl);
}
