import {
  accounts,
  and,
  attachments,
  type Db,
  eq,
  folders,
  messageAddresses,
  notInArray,
  sql,
} from "@mailmcp/db";
import type {
  Connector,
  Logger,
  ModuleContext,
  ModuleManifest,
  RemoteFolder,
} from "@mailmcp/module-sdk";
import { audit } from "./audit";
import { decryptJson, encryptJson, newDataKey, unwrapDataKey } from "./crypto";
import { friendlyError } from "./errors";
import { clone, deletePath, getPath, setPath } from "./paths";
import type { ModuleRegistry } from "./registry";

type Config = Record<string, unknown>;
export type AccountRow = typeof accounts.$inferSelect;

export class AccountError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: { code?: string; hint?: string; fields?: Record<string, string> },
  ) {
    super(message);
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: { message: string; hint?: string; code?: string };
  folders?: Array<Pick<RemoteFolder, "path" | "role" | "messageCount" | "unreadCount">>;
  traits?: Record<string, boolean>;
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export class AccountService {
  /** Called after an account is deleted (e.g. to remove its stored blobs). */
  onRemoved?: (row: AccountRow) => Promise<void>;

  constructor(
    private db: Db,
    private master: Buffer,
    private registry: ModuleRegistry,
  ) {}

  // ─────────── config helpers ───────────

  private parseConfig(manifest: ModuleManifest, input: unknown): Config {
    const r = manifest.configSchema.safeParse(input);
    if (!r.success) {
      const fields: Record<string, string> = {};
      for (const issue of r.error.issues) fields[issue.path.join(".")] = issue.message;
      throw new AccountError("Some settings are missing or invalid.", 400, {
        code: "INVALID_CONFIG",
        fields,
      });
    }
    return r.data as Config;
  }

  /** Remove secret fields before returning config to the admin panel. */
  private redact(manifest: ModuleManifest, config: Config): Config {
    const out = clone(config);
    for (const f of manifest.ui?.secretFields ?? []) deletePath(out, f);
    return out;
  }

  private ctx(
    accountId: string,
    address: string,
    config: Config,
    signal?: AbortSignal,
  ): ModuleContext<Config> {
    const kv = new Map<string, unknown>();
    return {
      accountId,
      address,
      config,
      saveConfig: async () => {},
      kv: { get: async (k) => kv.get(k) as never, set: async (k, v) => void kv.set(k, v) },
      log: silentLog,
      signal: signal ?? new AbortController().signal,
    };
  }

  private async withConnector<T>(
    manifest: ModuleManifest,
    accountId: string,
    address: string,
    config: Config,
    fn: (c: Connector) => Promise<T>,
  ): Promise<T> {
    const connector = manifest.create(this.ctx(accountId, address, config));
    try {
      return await fn(connector);
    } finally {
      await connector.close().catch(() => {});
    }
  }

  private async probe(manifest: ModuleManifest, address: string, config: Config) {
    return this.withConnector(manifest, "test", address, config, async (c) => {
      const identity = await c.verify();
      const remote = await c.listFolders();
      return { identity, remote };
    });
  }

  // ─────────── public API ───────────

  /** Try the settings without saving anything. */
  async test(moduleId: string, address: string, rawConfig: unknown): Promise<ConnectionTestResult> {
    const manifest = this.registry.get(moduleId);
    const config = this.parseConfig(manifest, rawConfig);
    try {
      const { identity, remote } = await this.probe(manifest, address, config);
      return {
        ok: true,
        traits: identity.traits,
        folders: remote.map((f) => ({
          path: f.path,
          role: f.role,
          messageCount: f.messageCount,
          unreadCount: f.unreadCount,
        })),
      };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  }

  async create(
    orgId: string,
    userId: string,
    input: {
      moduleId: string;
      address: string;
      displayName?: string;
      label?: string;
      config: unknown;
    },
    opts: { actorType?: "user" | "agent" } = {},
  ) {
    const manifest = this.registry.get(input.moduleId);
    const config = this.parseConfig(manifest, input.config);
    const address = input.address.trim().toLowerCase();

    // The same address may be connected more than once through different servers (moving
    // hosts), but not twice with the same login.
    const existing = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), sql`lower(${accounts.address}) = ${address}`));
    const login = loginKey(config);
    for (const row of existing) {
      let same = false;
      try {
        same = row.moduleId === manifest.id && loginKey(this.decrypt(row)) === login;
      } catch {
        // Unreadable credentials: treat as a different login.
      }
      if (same)
        throw new AccountError(
          `${address} is already connected with this login${row.label ? ` (${row.label})` : ""}.`,
          409,
          { code: "DUPLICATE" },
        );
    }

    let probe: Awaited<ReturnType<AccountService["probe"]>>;
    try {
      probe = await this.probe(manifest, address, config);
    } catch (err) {
      const f = friendlyError(err);
      throw new AccountError(f.message, 422, { code: f.code, hint: f.hint });
    }

    const id = crypto.randomUUID();
    const { dataKey, wrapped } = newDataKey(this.master, id);
    await this.db.transaction(async (tx) => {
      await tx.insert(accounts).values({
        id,
        orgId,
        moduleId: manifest.id,
        address,
        displayName: input.displayName?.trim() || null,
        label: input.label?.trim() || (existing.length ? serverName(config) : null),
        credentialsEnc: encryptJson(dataKey, config, id),
        dataKeyEnc: wrapped,
        status: "pending",
        statusMessage: "Connected. Waiting for first sync.",
        settings: { traits: probe.identity.traits ?? {} },
      });
      await this.upsertFolders(tx as unknown as Db, id, probe.remote);
      // Give the other logins for this address a label too, so they can be told apart.
      for (const row of existing) {
        if (row.label) continue;
        let name: string | null = null;
        try {
          name = serverName(this.decrypt(row));
        } catch {}
        await tx
          .update(accounts)
          .set({ label: name ?? "Previous login" })
          .where(eq(accounts.id, row.id));
      }
    });
    await audit(this.db, {
      orgId,
      actorType: opts.actorType ?? "user",
      actorId: userId,
      accountId: id,
      action: "account.create",
      target: address,
      detail: { module: manifest.id },
    });
    return this.get(orgId, id);
  }

  async list(orgId: string) {
    const rows = await this.db
      .select({
        id: accounts.id,
        moduleId: accounts.moduleId,
        address: accounts.address,
        displayName: accounts.displayName,
        label: accounts.label,
        status: accounts.status,
        statusMessage: accounts.statusMessage,
        lastSyncAt: accounts.lastSyncAt,
        createdAt: accounts.createdAt,
        folderCount: sql<number>`count(${folders.id})::int`,
        messageCount: sql<number>`coalesce(sum(${folders.messageCount}), 0)::int`,
        unreadCount: sql<number>`coalesce(sum(${folders.unreadCount}) filter (where ${folders.role} = 'inbox'), 0)::int`,
      })
      .from(accounts)
      .leftJoin(folders, eq(folders.accountId, accounts.id))
      .where(eq(accounts.orgId, orgId))
      .groupBy(accounts.id)
      .orderBy(accounts.address, accounts.createdAt);
    return rows;
  }

  /** Load an account row without an org check (worker / internal use). */
  async byId(id: string): Promise<AccountRow> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id));
    if (!row) throw new AccountError("Account not found.", 404);
    return row;
  }

  /** The account's plaintext data key (encrypts its credentials and stored mail). */
  dataKey(row: AccountRow): Buffer {
    return unwrapDataKey(this.master, row.dataKeyEnc, row.id);
  }

  async row(orgId: string, id: string): Promise<AccountRow> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, id)));
    if (!row) throw new AccountError("Account not found.", 404);
    return row;
  }

  private decrypt(row: AccountRow): Config {
    const dataKey = unwrapDataKey(this.master, row.dataKeyEnc, row.id);
    return decryptJson<Config>(dataKey, row.credentialsEnc, row.id);
  }

  async get(orgId: string, id: string) {
    const row = await this.row(orgId, id);
    const manifest = this.registry.get(row.moduleId);
    const folderRows = await this.db
      .select({
        id: folders.id,
        path: folders.path,
        role: folders.role,
        messageCount: folders.messageCount,
        unreadCount: folders.unreadCount,
        syncedAt: folders.syncedAt,
      })
      .from(folders)
      .where(eq(folders.accountId, id))
      .orderBy(sql`${folders.role} is null`, folders.path);
    return {
      id: row.id,
      moduleId: row.moduleId,
      address: row.address,
      displayName: row.displayName,
      label: row.label,
      status: row.status,
      statusMessage: row.statusMessage,
      lastSyncAt: row.lastSyncAt,
      createdAt: row.createdAt,
      instructions: row.instructions,
      settings: row.settings,
      config: this.redact(manifest, this.decrypt(row)),
      folders: folderRows,
    };
  }

  /**
   * Update display name and/or connection settings. Secret fields left blank keep their
   * stored value. Changed connection settings are re-verified before saving.
   */
  async update(
    orgId: string,
    userId: string,
    id: string,
    input: {
      displayName?: string | null;
      label?: string | null;
      config?: Config;
      instructions?: string | null;
      /** Save connection settings without logging in first (e.g. server briefly down). */
      skipTest?: boolean;
    },
  ) {
    const row = await this.row(orgId, id);
    const manifest = this.registry.get(row.moduleId);
    const patch: Partial<typeof accounts.$inferInsert> = {};

    if (input.displayName !== undefined) patch.displayName = input.displayName?.trim() || null;
    if (input.label !== undefined) patch.label = input.label?.trim() || null;
    if (input.instructions !== undefined) patch.instructions = input.instructions?.trim() || null;

    if (input.config) {
      const merged = clone(input.config);
      const current = this.decrypt(row);
      for (const f of manifest.ui?.secretFields ?? []) {
        const v = getPath(merged, f);
        if (v === undefined || v === "") setPath(merged, f, getPath(current, f));
      }
      const config = this.parseConfig(manifest, merged);
      let probe: Awaited<ReturnType<AccountService["probe"]>> | null = null;
      if (!input.skipTest) {
        try {
          probe = await this.probe(manifest, row.address, config);
        } catch (err) {
          const f = friendlyError(err);
          throw new AccountError(f.message, 422, { code: f.code, hint: f.hint });
        }
      }
      const dataKey = unwrapDataKey(this.master, row.dataKeyEnc, row.id);
      patch.credentialsEnc = encryptJson(dataKey, config, row.id);
      if (row.status !== "disabled") {
        patch.status = "pending";
        patch.statusMessage = probe
          ? "Settings updated. Waiting for sync."
          : "Settings saved without testing. Waiting for sync.";
      }
      if (probe) await this.upsertFolders(this.db, id, probe.remote);
    }

    if (Object.keys(patch).length)
      await this.db.update(accounts).set(patch).where(eq(accounts.id, id));
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: id,
      action: "account.update",
      target: row.address,
      detail: { fields: Object.keys(patch) },
    });
    return this.get(orgId, id);
  }

  async refreshFolders(orgId: string, id: string) {
    const row = await this.row(orgId, id);
    const manifest = this.registry.get(row.moduleId);
    try {
      const remote = await this.withConnector(
        manifest,
        row.id,
        row.address,
        this.decrypt(row),
        (c) => c.listFolders(),
      );
      await this.upsertFolders(this.db, id, remote);
    } catch (err) {
      const f = friendlyError(err);
      await this.db
        .update(accounts)
        .set({
          status: f.code === "AUTH_FAILED" ? "auth_error" : "error",
          statusMessage: f.message,
        })
        .where(eq(accounts.id, id));
      throw new AccountError(f.message, 422, { code: f.code, hint: f.hint });
    }
    return this.get(orgId, id);
  }

  async remove(orgId: string, userId: string, id: string) {
    const row = await this.row(orgId, id);
    await this.db.transaction(async (tx) => {
      // These tables have no FK to accounts (kept lean for bulk inserts).
      await tx.delete(messageAddresses).where(eq(messageAddresses.accountId, id));
      await tx.delete(attachments).where(eq(attachments.accountId, id));
      await tx.delete(accounts).where(eq(accounts.id, id));
    });
    await this.onRemoved?.(row);
    // Blobs are crypto-shredded: the data key was in the deleted row. Physical blob cleanup
    // runs as a background job once the worker exists.
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: id,
      action: "account.delete",
      target: row.address,
    });
  }

  /** Build a live connector for the worker (sync) and mail actions. */
  async connectorFor(row: AccountRow, signal?: AbortSignal, log?: Logger): Promise<Connector> {
    const manifest = this.registry.get(row.moduleId);
    const config = this.decrypt(row);
    const ctx = this.ctx(row.id, row.address, config, signal);
    if (log) ctx.log = log;
    ctx.saveConfig = async (next) => {
      const dataKey = unwrapDataKey(this.master, row.dataKeyEnc, row.id);
      await this.db
        .update(accounts)
        .set({ credentialsEnc: encryptJson(dataKey, next, row.id) })
        .where(eq(accounts.id, row.id));
    };
    return manifest.create(ctx);
  }

  async upsertFolders(db: Db, accountId: string, remote: RemoteFolder[]) {
    const selectable = remote.filter((f) => f.selectable);
    for (const f of selectable) {
      await db
        .insert(folders)
        .values({
          accountId,
          remoteId: f.remoteId,
          path: f.path,
          delimiter: f.delimiter,
          kind: f.kind,
          role: f.role,
          messageCount: f.messageCount ?? 0,
          unreadCount: f.unreadCount ?? 0,
        })
        .onConflictDoUpdate({
          target: [folders.accountId, folders.remoteId],
          set: {
            path: f.path,
            role: f.role ?? null,
            messageCount: f.messageCount ?? 0,
            unreadCount: f.unreadCount ?? 0,
          },
        });
    }
    const keep = selectable.map((f) => f.remoteId);
    await db
      .delete(folders)
      .where(
        keep.length
          ? and(eq(folders.accountId, accountId), notInArray(folders.remoteId, keep))
          : eq(folders.accountId, accountId),
      );
  }
}

/** Which server and user an account logs in as (module config; IMAP-shaped when present). */
function loginKey(config: Config): string {
  const host = getPath(config, "imap.host") ?? getPath(config, "host") ?? "";
  const user = getPath(config, "username") ?? getPath(config, "user") ?? "";
  return `${String(host).toLowerCase()}|${String(user).toLowerCase()}`;
}

/** A short name for the server an account uses, e.g. "mail.example.com". */
function serverName(config: Config): string | null {
  const host = getPath(config, "imap.host") ?? getPath(config, "host");
  return typeof host === "string" && host ? host.toLowerCase() : null;
}
