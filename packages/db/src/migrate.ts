import { fileURLToPath } from "node:url";
import { runMigrations } from "./index";

await runMigrations(
  process.env.DATABASE_URL ?? "postgres://mailmcp:mailmcp@localhost:5433/mailmcp",
  process.env.CLOUD_MAIL_MCP_MIGRATIONS_DIR ??
    fileURLToPath(new URL("../drizzle", import.meta.url)),
);
console.log("migrations applied");
