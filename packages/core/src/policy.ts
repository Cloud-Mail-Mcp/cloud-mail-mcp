import { createHash, randomBytes } from "node:crypto";
import {
  accounts,
  agents,
  and,
  apiKeys,
  type Db,
  eq,
  folders,
  grants,
  gt,
  inArray,
  isNull,
  or,
} from "@cloud-mail-mcp/db";
import type { SearchScope } from "@cloud-mail-mcp/search";
import { ALL_SCOPES, type Scope } from "./scopes";

export type SendPolicy = "allow" | "approve" | "deny";

export interface AccountGrant {
  grantId: string | null;
  scopes: Set<Scope>;
  folderAllow: string[] | null;
  folderDeny: string[] | null;
  sendPolicy: SendPolicy;
  recipientAllow: string[] | null;
  rateLimit: { perMinute?: number; perHour?: number; perDay?: number } | null;
}

/** Everything an actor (admin user or agent) may do, resolved once per request. */
export interface Access {
  orgId: string;
  /** "system": Cloud Mail MCP itself (the AI sorter acting on its own). */
  actor: { type: "user" | "agent" | "system"; id: string; name: string };
  grants: Map<string, AccountGrant>;
  /** May add mailboxes (people always; agents when allowed on their page). */
  canAddAccounts?: boolean;
}

export class AccessDenied extends Error {
  status = 403;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Folder glob: "Projects/*" matches one level, "Projects/**" any depth; case-insensitive. */
export function folderMatches(pattern: string, path: string): boolean {
  const re = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`, "i").test(path);
}

export function folderAllowed(g: AccountGrant, path: string, role?: string | null): boolean {
  const names = [path, role ?? ""].filter(Boolean);
  if (g.folderDeny?.some((p) => names.some((n) => folderMatches(p, n)))) return false;
  if (!g.folderAllow?.length) return true;
  return g.folderAllow.some((p) => names.some((n) => folderMatches(p, n)));
}

export function recipientAllowed(g: AccountGrant, email: string): boolean {
  if (!g.recipientAllow?.length) return true;
  const e = email.toLowerCase();
  return g.recipientAllow.some((r) => {
    const rule = r.toLowerCase().trim();
    return rule.includes("@") ? e === rule : e.endsWith(`@${rule.replace(/^@/, "")}`);
  });
}

/** Which accounts the actor can use for `scope`. */
export function accountsWith(access: Access, scope: Scope): string[] {
  return [...access.grants].filter(([, g]) => g.scopes.has(scope)).map(([id]) => id);
}

export function requireScope(access: Access, accountId: string, scope: Scope): AccountGrant {
  const g = access.grants.get(accountId);
  if (!g) throw new AccessDenied("You don't have access to this account.");
  if (!g.scopes.has(scope))
    throw new AccessDenied(`Missing permission "${scope}" on this account.`);
  return g;
}

export class PolicyService {
  private counters = new Map<
    string,
    { minute: [number, number]; hour: [number, number]; day: [number, number] }
  >();
  private lastUsedWrites = new Map<string, number>();

  constructor(private db: Db) {}

  /** Admin-panel users get full access to every account in their org. */
  async forUser(user: {
    id: string;
    orgId: string;
    email: string;
    name: string | null;
  }): Promise<Access> {
    const rows = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.orgId, user.orgId));
    const full: AccountGrant = {
      grantId: null,
      scopes: new Set(ALL_SCOPES),
      folderAllow: null,
      folderDeny: null,
      sendPolicy: "allow",
      recipientAllow: null,
      rateLimit: null,
    };
    return {
      orgId: user.orgId,
      canAddAccounts: true,
      actor: { type: "user", id: user.id, name: user.name ?? user.email },
      grants: new Map(rows.map((r) => [r.id, full])),
    };
  }

  /** Resolve an agent's API key to its access, or null if invalid/revoked/expired. */
  async forApiKey(rawKey: string): Promise<Access | null> {
    // cmcp_ keys; mmcp_ keys were issued before the rename and keep working.
    if (!rawKey.startsWith("cmcp_") && !rawKey.startsWith("mmcp_")) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ keyId: apiKeys.id, agent: agents })
      .from(apiKeys)
      .innerJoin(agents, eq(agents.id, apiKeys.agentId))
      .where(
        and(
          eq(apiKeys.keyHash, sha256(rawKey)),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        ),
      );
    if (!row || row.agent.disabled) return null;

    // Record usage at most once a minute per key.
    const last = this.lastUsedWrites.get(row.keyId) ?? 0;
    if (Date.now() - last > 60_000) {
      this.lastUsedWrites.set(row.keyId, Date.now());
      await this.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.keyId));
    }
    return this.forAgent(row.agent.orgId, row.agent.id, row.agent.name);
  }

  async forAgent(orgId: string, agentId: string, name: string): Promise<Access> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(grants)
      .innerJoin(accounts, eq(accounts.id, grants.accountId))
      .where(
        and(
          eq(grants.agentId, agentId),
          eq(accounts.orgId, orgId),
          or(isNull(grants.expiresAt), gt(grants.expiresAt, now)),
        ),
      );
    const [flags] = await this.db
      .select({ canAddAccounts: agents.canAddAccounts })
      .from(agents)
      .where(eq(agents.id, agentId));
    return {
      orgId,
      canAddAccounts: flags?.canAddAccounts ?? false,
      actor: { type: "agent", id: agentId, name },
      grants: new Map(
        rows.map(({ grants: g }) => [
          g.accountId,
          {
            grantId: g.id,
            scopes: new Set(
              g.scopes.filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s)),
            ),
            folderAllow: g.folderAllow,
            folderDeny: g.folderDeny,
            sendPolicy: g.sendPolicy,
            recipientAllow: g.recipientAllow,
            rateLimit: g.rateLimit as AccountGrant["rateLimit"],
          },
        ]),
      ),
    };
  }

  /**
   * Count one action against the grant's rate limit (in-memory, per process).
   * Throws AccessDenied when over the limit.
   */
  checkRate(g: AccountGrant) {
    if (!g.grantId || !g.rateLimit) return;
    const now = Date.now();
    const c = this.counters.get(g.grantId) ?? { minute: [now, 0], hour: [now, 0], day: [now, 0] };
    const windows = [
      ["minute", 60_000, g.rateLimit.perMinute],
      ["hour", 3_600_000, g.rateLimit.perHour],
      ["day", 86_400_000, g.rateLimit.perDay],
    ] as const;
    for (const [k, ms, limit] of windows) {
      if (now - c[k][0] >= ms) c[k] = [now, 0];
      if (limit && c[k][1] >= limit)
        throw new AccessDenied(`Rate limit reached (${limit} per ${k}). Try again later.`);
    }
    for (const [k] of windows) c[k][1]++;
    this.counters.set(g.grantId, c);
  }

  /**
   * Build the search scope for an actor: allowed accounts plus, where folder rules exist,
   * the explicit list of allowed folder ids (enforced inside the search query).
   */
  async searchScope(access: Access, scope: Scope, onlyAccount?: string): Promise<SearchScope> {
    let ids = accountsWith(access, scope);
    if (onlyAccount) ids = ids.filter((i) => i === onlyAccount);
    const restricted = ids.filter((id) => {
      const g = access.grants.get(id);
      return Boolean(g?.folderAllow?.length || g?.folderDeny?.length);
    });
    if (!restricted.length) return { accountIds: ids };
    const rows = await this.db
      .select({
        id: folders.id,
        accountId: folders.accountId,
        path: folders.path,
        role: folders.role,
      })
      .from(folders)
      .where(inArray(folders.accountId, restricted));
    const folderIds: Record<string, number[]> = {};
    for (const id of restricted) {
      const g = access.grants.get(id) as AccountGrant;
      folderIds[id] = rows
        .filter((f) => f.accountId === id && folderAllowed(g, f.path, f.role))
        .map((f) => f.id);
    }
    return { accountIds: ids, folderIds };
  }
}

/** Create a new API key: returns the raw key (show once) plus what to store. */
export function newApiKey() {
  const raw = `cmcp_${randomBytes(32).toString("base64url")}`;
  return { raw, prefix: raw.slice(0, 12), hash: sha256(raw) };
}
