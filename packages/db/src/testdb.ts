import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "./index";

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
  const { db, close } = createDb(testUrl);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  } finally {
    await close();
  }
  return testUrl;
}
