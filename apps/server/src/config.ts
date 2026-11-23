import { runtime } from "@mailmcp/core";

/** `--port 3000` / `--host 0.0.0.0` on the command line override the environment (for panels without env vars). */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

/**
 * Server settings from the environment. `.env` (or the web installer) only needs to say how to
 * reach the database; everything else — mail accounts, storage, sync — is set in the admin panel.
 */
export const config = {
  get databaseUrl(): string {
    const url = runtime.databaseUrl;
    if (!url) throw new Error("DATABASE_URL is not set");
    return url;
  },
  host: arg("host") ?? process.env.HOST ?? "127.0.0.1",
  port: Number(arg("port") ?? process.env.PORT ?? 8787),
  /**
   * Trust X-Forwarded-* from a reverse proxy. The bundle runs behind the hosting panel's proxy on
   * 127.0.0.1, so it trusts it by default; elsewhere set TRUST_PROXY=true when behind a proxy.
   */
  trustProxy: process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY === "true"
    : runtime.install === "bundle",
  dataDir: runtime.dataDir,
  adminDist: runtime.adminDist,
  /** Secure cookies require HTTPS; on by default when not bound to localhost. */
  secureCookies: process.env.SECURE_COOKIES
    ? process.env.SECURE_COOKIES === "true"
    : !["127.0.0.1", "localhost", "::1"].includes(arg("host") ?? process.env.HOST ?? "127.0.0.1"),
};
