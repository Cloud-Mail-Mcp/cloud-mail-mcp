import type { ModuleManifest } from "@cloud-mail-mcp/module-sdk";
import { z } from "zod";

export interface ModuleDescription {
  id: string;
  name: string;
  version: string;
  description?: string;
  auth: ModuleManifest["auth"];
  presets: NonNullable<ModuleManifest["presets"]>;
  capabilities: ModuleManifest["capabilities"];
  ui: NonNullable<ModuleManifest["ui"]>;
  /** JSON Schema of the module's config, used to render the connection form. */
  configSchema: unknown;
}

export class ModuleRegistry {
  private modules = new Map<string, ModuleManifest>();

  constructor(modules: ModuleManifest[]) {
    for (const m of modules) {
      if (this.modules.has(m.id)) throw new Error(`duplicate module id: ${m.id}`);
      this.modules.set(m.id, m);
    }
  }

  get(id: string): ModuleManifest {
    const m = this.modules.get(id);
    if (!m) throw new Error(`unknown module: ${id}`);
    return m;
  }

  list(): ModuleManifest[] {
    return [...this.modules.values()];
  }

  describe(m: ModuleManifest): ModuleDescription {
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      auth: m.auth,
      presets: m.presets ?? [],
      capabilities: m.capabilities,
      ui: m.ui ?? { secretFields: [] },
      configSchema: z.toJSONSchema(m.configSchema, { io: "input" }),
    };
  }
}
