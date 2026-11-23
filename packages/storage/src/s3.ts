import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BlobStore } from "./types";

export interface S3Options {
  bucket: string;
  region?: string;
  /** Custom endpoint for R2 / B2 / MinIO / Wasabi. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Required by MinIO and some others. */
  forcePathStyle?: boolean;
}

/** Any S3-compatible object store: AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi. */
export class S3BlobStore implements BlobStore {
  private s3: S3Client;
  private bucket: string;

  constructor(o: S3Options) {
    this.bucket = o.bucket;
    this.s3 = new S3Client({
      region: o.region ?? "auto",
      endpoint: o.endpoint,
      forcePathStyle: o.forcePathStyle ?? !!o.endpoint,
      credentials:
        o.accessKeyId && o.secretAccessKey
          ? { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, data: Buffer, opts?: { contentType?: string }): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: opts?.contentType ?? "application/octet-stream",
      }),
    );
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return undefined;
      throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
