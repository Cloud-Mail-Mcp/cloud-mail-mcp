import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The master key wraps every account's data key. It must NOT live in the database
 * (a DB dump alone must not be enough to decrypt credentials or mail).
 *
 * Resolution order:
 *   1. MAILMCP_MASTER_KEY env (base64, 32 bytes) — for Docker secrets / KMS-injected keys
 *   2. <dataDir>/master.key — auto-generated on first start (chmod 600). BACK THIS FILE UP.
 */
export async function loadOrCreateMasterKey(
  dataDir: string,
  env = process.env,
): Promise<{ key: Buffer; source: "env" | "file" | "generated"; path?: string }> {
  if (env.MAILMCP_MASTER_KEY) {
    const key = Buffer.from(env.MAILMCP_MASTER_KEY, "base64");
    if (key.length !== 32) throw new Error("MAILMCP_MASTER_KEY must be 32 bytes, base64-encoded");
    return { key, source: "env" };
  }
  const path = join(dataDir, "master.key");
  try {
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64");
    if (key.length !== 32) throw new Error(`${path} is corrupt (expected 32 bytes base64)`);
    return { key, source: "file", path };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dataDir, { recursive: true });
  const key = randomBytes(32);
  try {
    // "wx" = fail if it exists: if the server and worker start together, exactly one wins.
    await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return loadOrCreateMasterKey(dataDir, env); // the other process created it: use that one
  }
  await chmod(path, 0o600);
  process.stderr.write(
    `\n  A new encryption key was generated at ${path}\n` +
      "  BACK THIS FILE UP. Without it, saved mail passwords and stored mail cannot be decrypted.\n\n",
  );
  return { key, source: "generated", path };
}
