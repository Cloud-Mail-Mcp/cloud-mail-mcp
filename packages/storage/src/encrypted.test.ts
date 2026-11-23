import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EncryptedBlobStore } from "./encrypted";
import { FsBlobStore } from "./fs";

test("round-trips, compresses, and never writes plaintext", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailmcp-blob-"));
  try {
    const store = new EncryptedBlobStore(new FsBlobStore(dir));
    const key = randomBytes(32);
    const mail = Buffer.from(
      `Subject: Invoice 4471\r\n\r\n${"Please find attached. ".repeat(500)}`,
    );

    await store.put("org/acct/raw/ab/x.eml", mail, key);
    const onDisk = await readFile(join(dir, "org/acct/raw/ab/x.eml"));
    assert.ok(!onDisk.includes(Buffer.from("Invoice 4471")), "plaintext leaked to disk");
    assert.ok(onDisk.length < mail.length / 5, "expected zstd compression");
    assert.deepEqual(await store.get("org/acct/raw/ab/x.eml", key), mail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects wrong key and blobs moved to another key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailmcp-blob-"));
  try {
    const inner = new FsBlobStore(dir);
    const store = new EncryptedBlobStore(inner);
    const key = randomBytes(32);
    await store.put("a/b/1", Buffer.from("secret"), key);
    await assert.rejects(store.get("a/b/1", randomBytes(32)));
    await inner.put("a/b/2", (await inner.get("a/b/1"))!);
    await assert.rejects(store.get("a/b/2", key), "AAD should bind ciphertext to its key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs store refuses path traversal", async () => {
  const store = new FsBlobStore("/tmp/mailmcp-never");
  await assert.rejects(store.put("../escape", Buffer.from("x")));
});
