import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOrCreateMasterKey } from "./masterkey";

test("concurrent first starts agree on one key (no EEXIST crash)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailmcp-key-"));
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateMasterKey(dir, {})),
    );
    const keys = new Set(results.map((r) => r.key.toString("hex")));
    assert.equal(keys.size, 1, "all callers got the same key");
    assert.equal(
      results.filter((r) => r.source === "generated").length,
      1,
      "exactly one generated it",
    );
    assert.equal(
      (await stat(join(dir, "master.key"))).mode & 0o777,
      0o600,
      "owner-only permissions",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env key wins and is validated", async () => {
  const k = Buffer.alloc(32, 1).toString("base64");
  assert.equal(
    (await loadOrCreateMasterKey("/nonexistent", { MAILMCP_MASTER_KEY: k })).source,
    "env",
  );
  await assert.rejects(loadOrCreateMasterKey("/nonexistent", { MAILMCP_MASTER_KEY: "c2hvcnQ=" }));
});
