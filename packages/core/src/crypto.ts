import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption (docs/SPEC.md §9): the master key (env CLOUD_MAIL_MCP_MASTER_KEY) only
 * wraps per-account data keys; data keys encrypt credentials and blobs.
 */
const IV = 12;
const TAG = 16;

export function loadMasterKey(env = process.env): Buffer {
  const b64 = env.CLOUD_MAIL_MCP_MASTER_KEY;
  if (!b64)
    throw new Error("CLOUD_MAIL_MCP_MASTER_KEY is not set (generate: openssl rand -base64 32)");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32)
    throw new Error("CLOUD_MAIL_MCP_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(key: Buffer, plaintext: Buffer, aad?: string): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer, aad?: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()]);
}

/** New random data key for an account, plus its master-wrapped form for the DB. */
export function newDataKey(master: Buffer, accountId: string) {
  const dataKey = randomBytes(32);
  return { dataKey, wrapped: seal(master, dataKey, `dk:${accountId}`) };
}

export const unwrapDataKey = (master: Buffer, wrapped: Buffer, accountId: string) =>
  open(master, wrapped, `dk:${accountId}`);

export const encryptJson = (dataKey: Buffer, value: unknown, accountId: string) =>
  seal(dataKey, Buffer.from(JSON.stringify(value)), `cred:${accountId}`);

export const decryptJson = <T>(dataKey: Buffer, sealed: Buffer, accountId: string): T =>
  JSON.parse(open(dataKey, sealed, `cred:${accountId}`).toString()) as T;
