export interface BlobStore {
  put(key: string, data: Buffer, opts?: { contentType?: string }): Promise<void>;
  /** Returns undefined if the key doesn't exist. */
  get(key: string): Promise<Buffer | undefined>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Delete everything under a prefix (e.g. an account being removed). */
  deletePrefix(prefix: string): Promise<void>;
}
