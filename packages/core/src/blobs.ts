import { type BlobStore, blobStoreFromConfig, EncryptedBlobStore } from "@cloud-mail-mcp/storage";
import type { SettingsService } from "./settings";

/**
 * Resolves the blob store from admin-panel settings, cached briefly so a settings change
 * takes effect within seconds without restarting.
 */
export class BlobService {
  private cached?: { store: EncryptedBlobStore; raw: BlobStore; at: number; sig: string };
  constructor(
    private settings: SettingsService,
    private dataDir: string,
  ) {}

  async get(): Promise<EncryptedBlobStore> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.store;
    const cfg = await this.settings.get("storage");
    const sig = JSON.stringify(cfg);
    if (this.cached?.sig === sig) {
      this.cached.at = Date.now();
      return this.cached.store;
    }
    const raw = blobStoreFromConfig(cfg, this.dataDir);
    this.cached = { store: new EncryptedBlobStore(raw), raw, at: Date.now(), sig };
    return this.cached.store;
  }
}
