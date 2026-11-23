import {
  accounts,
  agents,
  and,
  apiKeys,
  type Db,
  desc,
  eq,
  grants,
  inArray,
  isNull,
  max,
  oauthTokens,
} from "@mailmcp/db";
import { audit } from "./audit";
import { MailError } from "./mail";
import { newApiKey } from "./policy";
import { ALL_SCOPES, type Scope } from "./scopes";

export interface GrantInput {
  accountId: string;
  scopes: Scope[];
  folderAllow?: string[] | null;
  folderDeny?: string[] | null;
  sendPolicy?: "allow" | "approve" | "deny";
  recipientAllow?: string[] | null;
  rateLimit?: { perMinute?: number; perHour?: number; perDay?: number } | null;
  expiresAt?: string | null;
}

const clean = (list?: string[] | null) => {
  const v = (list ?? []).map((x) => x.trim()).filter(Boolean);
  return v.length ? v : null;
};

/** Agents (AI clients), their API keys, and their per-account grants. */
export class AgentService {
  constructor(private db: Db) {}

  async list(orgId: string) {
    const rows = await this.db
      .select()
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .orderBy(desc(agents.createdAt));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const keys = await this.db
      .select({
        id: apiKeys.id,
        agentId: apiKeys.agentId,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(inArray(apiKeys.agentId, ids), isNull(apiKeys.revokedAt)));
    const g = await this.db
      .select({ agentId: grants.agentId, accountId: grants.accountId })
      .from(grants)
      .where(inArray(grants.agentId, ids));
    const tokenUse = await this.db
      .select({ agentId: oauthTokens.agentId, lastUsedAt: max(oauthTokens.lastUsedAt) })
      .from(oauthTokens)
      .where(inArray(oauthTokens.agentId, ids))
      .groupBy(oauthTokens.agentId);
    return rows.map((a) => ({
      ...a,
      keys: keys.filter((k) => k.agentId === a.id),
      accountCount: g.filter((x) => x.agentId === a.id).length,
      lastUsedAt:
        [
          ...keys.filter((k) => k.agentId === a.id).map((k) => k.lastUsedAt),
          tokenUse.find((t) => t.agentId === a.id)?.lastUsedAt,
        ]
          .filter((d): d is Date => !!d)
          .sort((x, y) => x.getTime() - y.getTime())
          .at(-1) ?? null,
    }));
  }

  async get(orgId: string, id: string) {
    const [a] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, id)));
    if (!a) throw new MailError("Agent not found", 404);
    const keys = await this.db
      .select({
        id: apiKeys.id,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.agentId, id))
      .orderBy(desc(apiKeys.createdAt));
    const g = await this.db
      .select({ grant: grants, address: accounts.address })
      .from(grants)
      .innerJoin(accounts, eq(accounts.id, grants.accountId))
      .where(eq(grants.agentId, id));
    return { ...a, keys, grants: g.map((x) => ({ ...x.grant, address: x.address })) };
  }

  /** Create an agent and its first API key. The raw key is returned once and never stored. */
  async create(orgId: string, userId: string, input: { name: string; description?: string }) {
    const [a] = await this.db
      .insert(agents)
      .values({
        orgId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        createdBy: userId,
      })
      .returning();
    const key = await this.issueKey(orgId, userId, a!.id);
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "agent.create",
      target: a!.name,
    });
    return { agent: a!, apiKey: key.raw };
  }

  async update(
    orgId: string,
    userId: string,
    id: string,
    input: { name?: string; description?: string | null; disabled?: boolean },
  ) {
    await this.get(orgId, id);
    await this.db
      .update(agents)
      .set({
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description?.trim() || null }),
        ...(input.disabled !== undefined && { disabled: input.disabled }),
      })
      .where(eq(agents.id, id));
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "agent.update",
      target: id,
      detail: input,
    });
    return this.get(orgId, id);
  }

  async remove(orgId: string, userId: string, id: string) {
    const a = await this.get(orgId, id);
    await this.db.delete(agents).where(eq(agents.id, id));
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "agent.delete",
      target: a.name,
    });
  }

  async issueKey(orgId: string, userId: string, agentId: string, expiresAt?: Date) {
    await this.get(orgId, agentId);
    const k = newApiKey();
    await this.db.insert(apiKeys).values({ agentId, prefix: k.prefix, keyHash: k.hash, expiresAt });
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "apikey.create",
      target: k.prefix,
    });
    return k;
  }

  async revokeKey(orgId: string, userId: string, agentId: string, keyId: string) {
    await this.get(orgId, agentId);
    await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.agentId, agentId)));
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      action: "apikey.revoke",
      target: keyId,
    });
  }

  /** Replace an agent's grant on one account (empty scopes = remove access). */
  async setGrant(orgId: string, userId: string, agentId: string, input: GrantInput) {
    await this.get(orgId, agentId);
    const [acc] = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, input.accountId)));
    if (!acc) throw new MailError("Account not found", 404);
    const scopes = [...new Set(input.scopes)].filter((s) => (ALL_SCOPES as string[]).includes(s));
    if (!scopes.length) {
      await this.db
        .delete(grants)
        .where(and(eq(grants.agentId, agentId), eq(grants.accountId, input.accountId)));
      await audit(this.db, {
        orgId,
        actorType: "user",
        actorId: userId,
        accountId: input.accountId,
        action: "grant.remove",
        target: agentId,
      });
      return null;
    }
    const values = {
      agentId,
      accountId: input.accountId,
      scopes,
      folderAllow: clean(input.folderAllow),
      folderDeny: clean(input.folderDeny),
      sendPolicy: input.sendPolicy ?? "approve",
      recipientAllow: clean(input.recipientAllow),
      rateLimit: input.rateLimit ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    };
    const [g] = await this.db
      .insert(grants)
      .values(values)
      .onConflictDoUpdate({ target: [grants.agentId, grants.accountId], set: values })
      .returning();
    await audit(this.db, {
      orgId,
      actorType: "user",
      actorId: userId,
      accountId: input.accountId,
      action: "grant.set",
      target: agentId,
      detail: { scopes, sendPolicy: values.sendPolicy },
    });
    return g;
  }
}
