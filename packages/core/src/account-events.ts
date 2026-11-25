import { accountEvents, and, type Db, desc, eq, lt, sql } from "@cloud-mail-mcp/db";
import type { Logger } from "@cloud-mail-mcp/module-sdk";
import { friendlyError } from "./errors";

/** How many events each mailbox keeps (the oldest go first). */
const KEEP = 300;

export type AccountEventKind = "sync" | "idle" | "login" | "folders" | "send";
export interface AccountEvent {
  level: "info" | "warn" | "error";
  kind: AccountEventKind;
  message: string;
  detail?: Record<string, unknown>;
}

/** Add an event to a mailbox's connection log. Never throws: logging must not break mail. */
export async function recordAccountEvent(db: Db, accountId: string, e: AccountEvent) {
  try {
    await db.insert(accountEvents).values({
      accountId,
      level: e.level,
      kind: e.kind,
      message: e.message.slice(0, 1000),
      detail: e.detail ?? null,
    });
    // Trim to the newest KEEP (cheap: the index is (account_id, id desc)).
    await db.execute(sql`
      DELETE FROM account_events WHERE account_id = ${accountId} AND id < (
        SELECT id FROM account_events WHERE account_id = ${accountId}
        ORDER BY id DESC OFFSET ${KEEP - 1} LIMIT 1)`);
  } catch {
    // e.g. the account was deleted meanwhile
  }
}

/** A failure as a log event: the readable message, plus the technical details. */
export function errorEvent(kind: AccountEventKind, prefix: string, err: unknown): AccountEvent {
  const f = friendlyError(err);
  const e = err as { code?: string; responseText?: string; executedCommand?: string };
  return {
    level: "error",
    kind,
    message: `${prefix}: ${f.message}`,
    detail: {
      code: f.code,
      hint: f.hint,
      error: (err as Error)?.message,
      server: e?.responseText,
      command: e?.executedCommand?.replace(/^\S+\s+/, "").slice(0, 200),
    },
  };
}

export async function listAccountEvents(
  db: Db,
  accountId: string,
  opts: { limit?: number; before?: number } = {},
) {
  return db
    .select()
    .from(accountEvents)
    .where(
      and(
        eq(accountEvents.accountId, accountId),
        opts.before ? lt(accountEvents.id, opts.before) : undefined,
      ),
    )
    .orderBy(desc(accountEvents.id))
    .limit(Math.min(opts.limit ?? 100, KEEP));
}

/**
 * A logger for one mailbox's connector that also writes its warnings and errors (e.g. the
 * new-mail connection dropping or failing to reconnect) to the mailbox's connection log.
 */
export function accountEventLogger(
  db: Db,
  accountId: string,
  base: Logger,
  kind: AccountEventKind,
): Logger {
  const write = (level: "warn" | "error") => (msg: string, data?: Record<string, unknown>) => {
    base[level](msg, data);
    const err = typeof data?.err === "string" ? data.err : undefined;
    void recordAccountEvent(db, accountId, {
      level,
      kind,
      message: err ? `${msg}: ${err}` : msg,
      detail: data,
    });
  };
  return {
    debug: (m, d) => base.debug(m, d),
    info: (m, d) => base.info(m, d),
    warn: write("warn"),
    error: write("error"),
  };
}
