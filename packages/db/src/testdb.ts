import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Arbitrary key for the advisory lock that serializes test-database migrations. */
const MIGRATE_LOCK = 7_310_241;

/**
 * Integration tests run against their own database (`<name>_test`) so they never share data,
 * settings or encryption keys with a development or production database. Creates and
 * migrates it on first use; returns its URL.
 */
export async function prepareTestDatabase(
  baseUrl = process.env.DATABASE_URL ?? "postgres://mailmcp:mailmcp@localhost:5433/mailmcp",
) {
  const url = new URL(baseUrl);
  const name = `${url.pathname.slice(1) || "mailmcp"}_test`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!exists.length)
      await admin
        .unsafe(`CREATE DATABASE "${name.replace(/"/g, "")}"`)
        .catch((e: { code?: string }) => {
          if (e.code !== "42P04") throw e; // created concurrently by the other test suite
        });
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  const testUrl = url.toString();
  // Test suites run in parallel (one per package): take a lock so only one migrates at a time.
  // On one connection, so the lock and the migration share a session.
  const client = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    await client`SELECT pg_advisory_lock(${MIGRATE_LOCK})`;
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await client`SELECT pg_advisory_unlock(${MIGRATE_LOCK})`.catch(() => {});
    await client.end();
  }
  return testUrl;
}
