import { appSettings, type Db, eq } from "@mailmcp/db";
import { z } from "zod";
import { audit } from "./audit";
import { decryptJson, encryptJson } from "./crypto";
import { clone, deletePath, getPath, setPath } from "./paths";

/**
 * Instance settings managed in the admin panel (stored in `app_settings`).
 * Each definition says which fields are secret: those are encrypted with the master key
 * and never returned to the browser.
 */
export const settingDefs = {
  general: {
    schema: z.object({
      instanceName: z.string().trim().max(100).default("MailMCP"),
      /** How AI clients reach this server (used in connection instructions). Empty = browser origin. */
      publicUrl: z
        .string()
        .trim()
        .max(500)
        .refine(
          (v) => v === "" || /^https?:\/\/[^\s/]+/.test(v),
          "Must start with http:// or https://",
        )
        .transform((v) => v.replace(/\/+$/, ""))
        .default(""),
      /** Ask GitHub for new versions (the only outbound call MailMCP makes on its own). */
      checkForUpdates: z.boolean().default(true),
    }),
    secretFields: [],
  },
  /** First-run wizard state. The wizard shows until `completedAt` is set. */
  setup: {
    schema: z.object({ completedAt: z.string().nullable().default(null) }),
    secretFields: [],
  },
  storage: {
    schema: z.object({
      driver: z.enum(["fs", "s3"]).default("fs"),
      fs: z.object({ root: z.string().min(1).default("blobs") }).default({ root: "blobs" }),
      s3: z
        .object({
          endpoint: z.string().optional(),
          region: z.string().default("auto"),
          bucket: z.string().default(""),
          forcePathStyle: z.boolean().default(false),
          accessKeyId: z.string().default(""),
          secretAccessKey: z.string().default(""),
        })
        .default({
          region: "auto",
          bucket: "",
          forcePathStyle: false,
          accessKeyId: "",
          secretAccessKey: "",
        }),
      cacheMaxMb: z.number().int().min(0).default(2048),
    }),
    secretFields: ["s3.secretAccessKey"],
  },
  sync: {
    schema: z.object({
      /** Fetch full bodies for mail newer than this many months; older = headers only. */
      bodyBackfillMonths: z.number().int().min(0).max(600).default(12),
      /** How far back to sync headers at all (0 = everything). */
      headerBackfillMonths: z.number().int().min(0).max(600).default(0),
      /** Accounts syncing in parallel. */
      concurrency: z.number().int().min(1).max(50).default(5),
    }),
    secretFields: [],
  },
} as const;

export type SettingKey = keyof typeof settingDefs;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingDefs)[K]["schema"]>;

const AAD = (key: string) => `setting:${key}`;

export class SettingsService {
  constructor(
    private db: Db,
    private master: Buffer,
  ) {}

  /** Full value including secrets — server-side use only. */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const def = settingDefs[key];
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, key));
    const value = clone((row?.value ?? {}) as Record<string, unknown>);
    if (row?.secretEnc) {
      const secrets = decryptJson<Record<string, unknown>>(this.master, row.secretEnc, AAD(key));
      for (const [p, v] of Object.entries(secrets)) setPath(value, p, v);
    }
    return def.schema.parse(value) as SettingValue<K>;
  }

  /** Value safe for the browser: secrets replaced by a "set" marker. */
  async getPublic<K extends SettingKey>(key: K) {
    const full = (await this.get(key)) as Record<string, unknown>;
    const out = clone(full);
    const secretsSet: Record<string, boolean> = {};
    for (const f of settingDefs[key].secretFields) {
      secretsSet[f] = Boolean(getPath(full, f));
      deletePath(out, f);
    }
    return { value: out, secretsSet };
  }

  /** Blank/omitted secret fields keep their stored value. */
  async put<K extends SettingKey>(key: K, input: unknown, ctx: { orgId: string; userId: string }) {
    const def = settingDefs[key];
    const current = (await this.get(key)) as Record<string, unknown>;
    const merged = clone((input ?? {}) as Record<string, unknown>);
    for (const f of def.secretFields) {
      const v = getPath(merged, f);
      if (v === undefined || v === "") setPath(merged, f, getPath(current, f));
    }
    const parsed = def.schema.parse(merged) as Record<string, unknown>;
    const secrets: Record<string, unknown> = {};
    const plain = clone(parsed);
    for (const f of def.secretFields) {
      secrets[f] = getPath(parsed, f);
      deletePath(plain, f);
    }
    const secretEnc = def.secretFields.length ? encryptJson(this.master, secrets, AAD(key)) : null;
    await this.db
      .insert(appSettings)
      .values({ key, value: plain, secretEnc, updatedBy: ctx.userId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: plain, secretEnc, updatedBy: ctx.userId, updatedAt: new Date() },
      });
    await audit(this.db, {
      orgId: ctx.orgId,
      actorType: "user",
      actorId: ctx.userId,
      action: "settings.update",
      target: key,
    });
    return this.getPublic(key);
  }
}
