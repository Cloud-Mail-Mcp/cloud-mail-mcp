import { isAbsolute, join } from "node:path";
import { FsBlobStore } from "./fs";
import { S3BlobStore } from "./s3";
import type { BlobStore } from "./types";

export * from "./encrypted";
export * from "./fs";
export * from "./keys";
export * from "./s3";
export * from "./types";

export interface StorageConfig {
  driver: "fs" | "s3";
  fs: { root: string };
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/** Build the blob store from admin-panel settings. Relative fs roots resolve against dataDir. */
export function blobStoreFromConfig(cfg: StorageConfig, dataDir: string): BlobStore {
  if (cfg.driver === "fs") {
    return new FsBlobStore(isAbsolute(cfg.fs.root) ? cfg.fs.root : join(dataDir, cfg.fs.root));
  }
  if (!cfg.s3.bucket) throw new Error("S3 bucket is required");
  return new S3BlobStore({
    bucket: cfg.s3.bucket,
    region: cfg.s3.region,
    endpoint: cfg.s3.endpoint || undefined,
    forcePathStyle: cfg.s3.forcePathStyle,
    accessKeyId: cfg.s3.accessKeyId || undefined,
    secretAccessKey: cfg.s3.secretAccessKey || undefined,
  });
}

/** Write, read back and delete a probe object. */
export async function testBlobStore(store: BlobStore): Promise<void> {
  const key = `_cloud_mail_mcp_probe/${Date.now()}`;
  const data = Buffer.from("cloud-mail-mcp storage probe");
  await store.put(key, data);
  const back = await store.get(key);
  await store.delete(key);
  if (!back?.equals(data)) throw new Error("Read-back did not match what was written");
}
