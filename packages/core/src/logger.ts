import type { Logger } from "@cloud-mail-mcp/module-sdk";

/** Minimal structured logger (JSON lines) so worker and server logs are greppable. */
export function createLogger(
  scope: string,
  base: Record<string, unknown> = {},
): Logger & {
  child(extra: Record<string, unknown>): ReturnType<typeof createLogger>;
} {
  const level = process.env.LOG_LEVEL ?? "info";
  const order = ["debug", "info", "warn", "error"];
  const enabled = (l: string) => order.indexOf(l) >= order.indexOf(level);
  const write = (l: string) => (msg: string, data?: Record<string, unknown>) => {
    if (!enabled(l)) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level: l,
      scope,
      msg,
      ...base,
      ...data,
    });
    (l === "error" || l === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (extra) => createLogger(scope, { ...base, ...extra }),
  };
}
