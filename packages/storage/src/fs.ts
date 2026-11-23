import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStore } from "./types";

/** Local-disk blob store. Writes are atomic (temp file + rename). */
export class FsBlobStore implements BlobStore {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid blob key: ${key}`);
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(join(this.root, prefix), { recursive: true, force: true });
  }
}
