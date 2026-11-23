import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { BlobStore } from "./types";

const MAGIC = Buffer.from("MMB1"); // MailMCP blob, format v1
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Compresses (zstd) then encrypts (AES-256-GCM) every blob before it reaches the
 * underlying store, so disk/S3 never sees plaintext mail. The data key is per account:
 * destroying it crypto-shreds that account's blobs.
 *
 * Layout: MAGIC(4) | IV(12) | TAG(16) | ciphertext
 */
export class EncryptedBlobStore {
  constructor(private inner: BlobStore) {}

  async put(key: string, plaintext: Buffer, dataKey: Buffer): Promise<void> {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(Buffer.from(key)); // binds ciphertext to its key: no swapping blobs
    const body = Buffer.concat([cipher.update(zstdCompressSync(plaintext)), cipher.final()]);
    await this.inner.put(key, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]));
  }

  async get(key: string, dataKey: Buffer): Promise<Buffer | undefined> {
    const blob = await this.inner.get(key);
    if (!blob) return undefined;
    if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error(`unknown blob format: ${key}`);
    const iv = blob.subarray(4, 4 + IV_LEN);
    const tag = blob.subarray(4 + IV_LEN, 4 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([
      decipher.update(blob.subarray(4 + IV_LEN + TAG_LEN)),
      decipher.final(),
    ]);
    return zstdDecompressSync(compressed);
  }

  has = (key: string) => this.inner.has(key);
  delete = (key: string) => this.inner.delete(key);
  deletePrefix = (prefix: string) => this.inner.deletePrefix(prefix);
}
