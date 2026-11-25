import { appSettings, type Db, eq } from "@cloud-mail-mcp/db";
import { z } from "zod";
import { audit } from "./audit";
import { decryptJson, encryptJson } from "./crypto";
import { clone, deletePath, getPath, setPath } from "./paths";
import { DEFAULT_TAGS, SorterTagSchema } from "./sorter-tags";

/**
 * Instance settings managed in the admin panel (stored in `app_settings`).
 * Each definition says which fields are secret: those are encrypted with the master key
 * and never returned to the browser.
 */
export const settingDefs = {
  general: {
    schema: z.object({
      instanceName: z.string().trim().max(100).default("Cloud Mail MCP"),
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
      /** Ask GitHub for new versions (the only outbound call Cloud Mail MCP makes on its own). */
      checkForUpdates: z.boolean().default(true),
    }),
    secretFields: [],
  },
  /**
   * For installs managed by a hosting panel (Coolify, Dokploy, Easypanel, CapRover…): "Update
   * now" calls the panel's redeploy webhook, which pulls the latest image.
   */
  updates: {
    schema: z.object({
      webhookUrl: z
        .string()
        .trim()
        .max(1000)
        .refine((v) => v === "" || /^https?:\/\//.test(v), "Must start with https:// (or http://)")
        .default(""),
      /** Optional Authorization header value, e.g. "Bearer <token>" for Coolify's API. */
      webhookAuth: z.string().max(2000).default(""),
    }),
    secretFields: ["webhookUrl", "webhookAuth"],
  },
  /**
   * In-app chat with Claude, using an Anthropic API key (off until a key is saved). The chat acts
   * as one of your agents, with exactly that agent's mailbox permissions.
   */
  assistant: {
    schema: z.object({
      apiKey: z.string().trim().max(500).default(""),
      model: z
        .enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
        .default("claude-opus-5-5"),
    }),
    secretFields: ["apiKey"],
  },
  /**
   * AI sorting: tags each new message by what it is (Settings → AI sorting), using the Anthropic
   * API key from Settings → Assistant. Tags can move mail on their own (e.g. spam → Spam).
   */
  sorter: {
    schema: z.object({
      enabled: z.boolean().default(false),
      model: z.enum(["claude-haiku-5-5", "claude-sonnet-5-5"]).default("claude-haiku-5-5"),
      tags: z
        .array(SorterTagSchema)
        .min(1)
        .max(30)
        .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "Each tag needs its own id.")
        .default(DEFAULT_TAGS),
      /** Extra guidance for the AI, e.g. "Mail from @mycompany.example is from colleagues". */
      instructions: z.string().trim().max(2000).default(""),
      /** Most messages the AI sorts per day (cost limit). */
      dailyLimit: z.number().int().min(0).max(100_000).default(2000),
      /** Also sort inbox mail from this date on (set by "Sort older mail"). */
      backfillFrom: z.string().nullable().default(null),
    }),
    secretFields: [],
  },
  /** How the admin panel shows mail. */
  mail: {
    schema: z.object({
      /** Block remote images (and the tracking pixels in them) until "Show images" is clicked. */
      blockRemoteImages: z.boolean().default(false),
    }),
    secretFields: [],
  },
  /** What AI agents may do beyond their mailbox grants. */
  agentAccounts: {
    schema: z.object({
      /**
       * Agents allowed to add mailboxes may also send the password, and the mailbox is added
       * right away. Off: they're added without it and wait for a person to enter it.
       */
      allowPasswords: z.boolean().default(false),
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
