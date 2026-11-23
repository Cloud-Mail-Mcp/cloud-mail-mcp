import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = ReturnType<typeof createDb>["db"];

/** Apply pending migrations (idempotent; safe to run on every start). */
export async function runMigrations(url: string, migrationsFolder: string) {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 20 });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end() };
}

// Single drizzle-orm instance for the whole workspace: import query helpers from here,
// not from "drizzle-orm" directly (avoids duplicate copies with mismatched types).
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { type SQL as _SQL, sql as _sql } from "drizzle-orm";

type PgArrayType = "uuid" | "bigint" | "int" | "text" | "bool" | "timestamptz";

/**
 * Pass a JS array as ONE Postgres array parameter (drizzle would otherwise expand it into a
 * tuple of separate parameters). Values are encoded as an array literal and cast:
 *   sql`... = ANY(${pgArray(ids, "bigint")})`
 */
export function pgArray(
  values: ReadonlyArray<string | number | boolean | Date | null | undefined>,
  type: PgArrayType,
): _SQL {
  const enc = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "boolean") return v ? "t" : "f";
    if (typeof v === "number") return String(v);
    const s = v instanceof Date ? v.toISOString() : v;
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return _sql`${`{${enc.join(",")}}`}::${_sql.raw(type)}[]`;
}
