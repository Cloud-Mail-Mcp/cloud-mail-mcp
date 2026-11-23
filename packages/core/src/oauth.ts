import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  agents,
  and,
  type Db,
  eq,
  gt,
  isNull,
  oauthClients,
  oauthCodes,
  oauthTokens,
  or,
} from "@mailmcp/db";
import type { AgentService } from "./agents";
import { audit } from "./audit";
import type { Access, PolicyService } from "./policy";
import type { Scope } from "./scopes";

/**
 * MailMCP's built-in OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Claude Code,
 * Cursor, VS Code…). Implements the MCP authorization spec: PKCE (S256), RFC 8707 resource
 * binding, Client ID Metadata Documents and Dynamic Client Registration (RFC 7591), and rotating
 * refresh tokens. An approved app becomes an agent with per-mailbox grants, like an API key.
 */

export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400,
  ) {
    super(description);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 60 * 60 * 24 * 30; // 30 days (rolling: each refresh issues a new one)
const CODE_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 15 * 60_000;
const CIMD_TTL_MS = 24 * 60 * 60_000;

export const ACCESS_PREFIX = "mmcp_at_";
export const REFRESH_PREFIX = "mmcp_rt_";
export const OAUTH_SCOPE = "mail";

/** What the user can pick per mailbox on the approval screen. */
export const GRANT_PRESETS = {
  none: { label: "No access", scopes: [] as Scope[], sendPolicy: "deny" as const },
  read: { label: "Read only", scopes: ["mail:read"] as Scope[], sendPolicy: "deny" as const },
  assistant: {
    label: "Read, organize & draft",
    scopes: ["mail:read", "mail:organize", "mail:draft"] as Scope[],
    sendPolicy: "deny" as const,
  },
  send_approval: {
    label: "…and send with my approval",
    scopes: ["mail:read", "mail:organize", "mail:draft", "mail:send"] as Scope[],
    sendPolicy: "approve" as const,
  },
} as const;
export type GrantPreset = keyof typeof GRANT_PRESETS;

// ───────────────────────────── redirect URIs ─────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https anywhere, or http only on loopback (native apps like Claude Code). */
export function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !LOOPBACK.has(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        LOOPBACK.has(reg.hostname) &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

// ───────────────────────────── SSRF guard for metadata documents ─────────────────────────────

function privateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return (
      v === "::1" ||
      v === "::" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe80") ||
      v.startsWith("::ffff:")
    );
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function fetchClientMetadata(url: string): Promise<Record<string, unknown>> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !u.pathname || u.pathname === "/")
    throw new OAuthError("invalid_client", "Client ID must be an https URL with a path.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) {
    throw new OAuthError("invalid_client", "Client metadata host is not publicly reachable.");
  }
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok)
    throw new OAuthError("invalid_client", `Couldn't fetch the client's metadata (${r.status}).`);
  const text = await r.text();
  if (text.length > 20_000)
    throw new OAuthError("invalid_client", "Client metadata document is too large.");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_client", "Client metadata document isn't valid JSON.");
  }
}

// ───────────────────────────── service ─────────────────────────────

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

interface PendingRequest {
  id: string;
  clientId: string;
  clientName: string;
  clientKind: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
  issuer: string;
  createdAt: number;
}

type ClientRow = typeof oauthClients.$inferSelect;

export class OAuthService {
  private pending = new Map<string, PendingRequest>();
  private registrations = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private db: Db,
    private policy: PolicyService,
    private agentsSvc: AgentService,
  ) {}

  // ─────────── clients ───────────

  /** RFC 7591 dynamic registration. Rate-limited per IP; public clients unless a secret is asked for. */
  async register(body: Record<string, unknown>, ip: string) {
    const now = Date.now();
    const r = this.registrations.get(ip);
    if (r && r.resetAt > now && r.count >= 20)
      throw new OAuthError(
        "invalid_client_metadata",
        "Too many registrations; try again later.",
        429,
      );
    this.registrations.set(
      ip,
      r && r.resetAt > now
        ? { count: r.count + 1, resetAt: r.resetAt }
        : { count: 1, resetAt: now + 3_600_000 },
    );

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (!redirectUris.length || !redirectUris.every(validRedirectUri)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "redirect_uris must be https URLs (or http on localhost).",
      );
    }
    const requested =
      typeof body.token_endpoint_auth_method === "string"
        ? body.token_endpoint_auth_method
        : "none";
    const method = ["client_secret_basic", "client_secret_post"].includes(requested)
      ? requested
      : "none";
    const clientId = `mmcp_client_${randomBytes(16).toString("base64url")}`;
    const secret = method === "none" ? undefined : token("mmcp_cs_");
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null;
    await this.db.insert(oauthClients).values({
      clientId,
      kind: "dcr",
      clientName,
      clientUri: typeof body.client_uri === "string" ? body.client_uri.slice(0, 500) : null,
      redirectUris,
      tokenAuthMethod: method,
      secretHash: secret ? sha256(secret) : null,
      metadata: body,
    });
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: clientName ?? undefined,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
  }

  /** Look up a client; URL-shaped client_ids are Client ID Metadata Documents (fetched, verified, cached). */
  async client(clientId: string): Promise<ClientRow> {
    const [row] = await this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId));
    const isUrl = /^https:\/\//.test(clientId);
    if (row && (!isUrl || (row.fetchedAt && Date.now() - row.fetchedAt.getTime() < CIMD_TTL_MS)))
      return row;
    if (!isUrl) throw new OAuthError("invalid_client", "Unknown client. Register it first.", 401);

    const doc = await fetchClientMetadata(clientId);
    if (doc.client_id !== clientId)
      throw new OAuthError(
        "invalid_client",
        "The metadata document's client_id doesn't match its URL.",
      );
    const redirectUris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u): u is string => typeof u === "string" && validRedirectUri(u))
      : [];
    if (!redirectUris.length)
      throw new OAuthError("invalid_client", "The client's metadata lists no valid redirect_uris.");
    const values = {
      clientId,
      kind: "cimd",
      clientName:
        typeof doc.client_name === "string"
          ? doc.client_name.slice(0, 100)
          : new URL(clientId).hostname,
      clientUri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 500) : null,
      redirectUris,
      tokenAuthMethod: "none",
      metadata: doc,
      fetchedAt: new Date(),
    };
    const [saved] = await this.db
      .insert(oauthClients)
      .values(values)
      .onConflictDoUpdate({ target: oauthClients.clientId, set: values })
      .returning();
    return saved as ClientRow;
  }

  // ─────────── authorization ───────────

  /**
   * Validate an /authorize request. Throws OAuthError with `redirect: false` problems (bad client or
   * redirect URI: never redirect to an unverified URI); returns a pending request id otherwise.
   */
  async startAuthorization(
    p: AuthorizeParams,
    issuer: string,
  ): Promise<{ requestId: string } | { redirect: string }> {
    if (!p.client_id) throw new OAuthError("invalid_request", "Missing client_id.");
    const client = await this.client(p.client_id);
    if (!p.redirect_uri || !redirectAllowed(client.redirectUris, p.redirect_uri)) {
      throw new OAuthError("invalid_request", "This redirect_uri isn't registered for the client.");
    }
    const fail = (error: string, description: string) => ({
      redirect: this.errorRedirect(p.redirect_uri as string, issuer, error, description, p.state),
    });
    if (p.response_type !== "code")
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!p.code_challenge || p.code_challenge_method !== "S256")
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");

    this.sweep();
    const id = randomUUID();
    this.pending.set(id, {
      id,
      clientId: client.clientId,
      clientName: client.clientName ?? "An app",
      clientKind: client.kind,
      redirectUri: p.redirect_uri,
      state: p.state,
      codeChallenge: p.code_challenge,
      resource: p.resource,
      scope: p.scope,
      issuer,
      createdAt: Date.now(),
    });
    return { requestId: id };
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending)
      if (now - v.createdAt > REQUEST_TTL_MS) this.pending.delete(k);
  }

  request(id: string): PendingRequest {
    this.sweep();
    const r = this.pending.get(id);
    if (!r)
      throw new OAuthError(
        "invalid_request",
        "This sign-in request expired. Start connecting again from your app.",
        404,
      );
    return r;
  }

  /** Error back to the client, with RFC 9207 `iss` so it can tell which server answered. */
  private errorRedirect(
    redirectUri: string,
    issuer: string,
    error: string,
    description: string,
    state?: string,
  ) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", issuer);
    return u.toString();
  }

  deny(id: string): string {
    const r = this.request(id);
    this.pending.delete(id);
    return this.errorRedirect(
      r.redirectUri,
      r.issuer,
      "access_denied",
      "The user declined access.",
      r.state,
    );
  }

  /**
   * The signed-in admin approved: create (or update) the app's agent with the chosen per-mailbox
   * access, and send the browser back to the app with a one-time code.
   */
  async approve(
    id: string,
    user: { id: string; orgId: string },
    input: {
      name: string;
      agentId?: string | null;
      accounts: Array<{ accountId: string; preset: GrantPreset }>;
    },
  ): Promise<string> {
    const r = this.request(id);
    let agentId = input.agentId ?? null;
    if (agentId) {
      const [a] = await this.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId), eq(agents.kind, "oauth")));
      if (!a) throw new OAuthError("invalid_request", "That connection no longer exists.", 404);
      await this.db
        .update(agents)
        .set({ name: input.name.trim() || a.name, oauthClientId: r.clientId, disabled: false })
        .where(eq(agents.id, agentId));
    } else {
      const [a] = await this.db
        .insert(agents)
        .values({
          orgId: user.orgId,
          name: input.name.trim() || r.clientName,
          description: `Connected with OAuth (${r.clientName})`,
          kind: "oauth",
          oauthClientId: r.clientId,
          createdBy: user.id,
        })
        .returning({ id: agents.id });
      agentId = (a as { id: string }).id;
    }
    for (const g of input.accounts) {
      const preset = GRANT_PRESETS[g.preset] ?? GRANT_PRESETS.none;
      await this.agentsSvc.setGrant(user.orgId, user.id, agentId, {
        accountId: g.accountId,
        scopes: preset.scopes,
        sendPolicy: preset.sendPolicy,
      });
    }

    const code = token("mmcp_code_");
    await this.db.insert(oauthCodes).values({
      codeHash: sha256(code),
      clientId: r.clientId,
      agentId,
      userId: user.id,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      resource: r.resource,
      scope: r.scope,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    this.pending.delete(id);
    await audit(this.db, {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: "oauth.approve",
      target: r.clientName,
      detail: { agentId, clientId: r.clientId },
    });

    const u = new URL(r.redirectUri);
    u.searchParams.set("code", code);
    if (r.state) u.searchParams.set("state", r.state);
    u.searchParams.set("iss", r.issuer);
    return u.toString();
  }

  // ─────────── token endpoint ───────────

  private async authenticateClient(
    clientId: string | undefined,
    secret: string | undefined,
  ): Promise<ClientRow> {
    if (!clientId) throw new OAuthError("invalid_client", "Missing client_id.", 401);
    const client = await this.client(clientId).catch(() => {
      throw new OAuthError("invalid_client", "Unknown client.", 401);
    });
    if (client.tokenAuthMethod !== "none") {
      const ok =
        !!secret &&
        !!client.secretHash &&
        timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(client.secretHash));
      if (!ok) throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return client;
  }

  private async issue(
    agentId: string,
    clientId: string,
    resource: string | null,
    scope: string | null,
    family: string = randomUUID(),
  ) {
    const access = token(ACCESS_PREFIX);
    const refresh = token(REFRESH_PREFIX);
    const now = Date.now();
    await this.db.insert(oauthTokens).values({
      agentId,
      clientId,
      family,
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      resource,
      scope,
      accessExpiresAt: new Date(now + ACCESS_TTL_S * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TTL_S * 1000),
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scope || OAUTH_SCOPE,
    };
  }

  async token(body: Record<string, string | undefined>, basic?: { id: string; secret: string }) {
    const clientId = basic?.id ?? body.client_id;
    const client = await this.authenticateClient(clientId, basic?.secret ?? body.client_secret);

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.code_verifier)
        throw new OAuthError("invalid_request", "code and code_verifier are required.");
      const [c] = await this.db
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, sha256(body.code)));
      if (!c || c.clientId !== client.clientId)
        throw new OAuthError("invalid_grant", "Unknown or expired code.");
      if (c.usedAt) {
        // Code replay: revoke whatever it produced (RFC 6749 §4.1.2).
        await this.db
          .update(oauthTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(oauthTokens.agentId, c.agentId), eq(oauthTokens.clientId, c.clientId)));
        throw new OAuthError("invalid_grant", "This code was already used.");
      }
      if (c.expiresAt.getTime() < Date.now())
        throw new OAuthError("invalid_grant", "This code expired.");
      if (body.redirect_uri !== c.redirectUri)
        throw new OAuthError(
          "invalid_grant",
          "redirect_uri doesn't match the authorization request.",
        );
      const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
      if (challenge !== c.codeChallenge)
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      if (body.resource && c.resource && trimSlash(body.resource) !== trimSlash(c.resource)) {
        throw new OAuthError("invalid_target", "resource doesn't match the authorization request.");
      }
      await this.db
        .update(oauthCodes)
        .set({ usedAt: new Date() })
        .where(eq(oauthCodes.codeHash, c.codeHash));
      return this.issue(
        c.agentId,
        c.clientId,
        body.resource ?? c.resource ?? null,
        c.scope ?? null,
      );
    }

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token)
        throw new OAuthError("invalid_request", "refresh_token is required.");
      const [t] = await this.db
        .select()
        .from(oauthTokens)
        .where(eq(oauthTokens.refreshHash, sha256(body.refresh_token)));
      if (!t || t.clientId !== client.clientId)
        throw new OAuthError("invalid_grant", "Unknown refresh token.");
      if (t.rotatedAt || t.revokedAt) {
        // Reuse of a rotated token means it leaked: end the whole session family.
        await this.db
          .update(oauthTokens)
          .set({ revokedAt: new Date() })
          .where(eq(oauthTokens.family, t.family));
        throw new OAuthError("invalid_grant", "This refresh token is no longer valid.");
      }
      if (t.refreshExpiresAt.getTime() < Date.now())
        throw new OAuthError("invalid_grant", "This refresh token expired.");
      const [agent] = await this.db.select().from(agents).where(eq(agents.id, t.agentId));
      if (!agent || agent.disabled)
        throw new OAuthError("invalid_grant", "This connection was disabled or removed.");
      await this.db
        .update(oauthTokens)
        .set({ rotatedAt: new Date() })
        .where(eq(oauthTokens.id, t.id));
      return this.issue(t.agentId, t.clientId, t.resource, t.scope, t.family);
    }

    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  /** RFC 7009: always succeeds; revokes the whole family the token belongs to. */
  async revoke(tokenValue: string | undefined) {
    if (!tokenValue) return;
    const h = sha256(tokenValue);
    const [t] = await this.db
      .select()
      .from(oauthTokens)
      .where(or(eq(oauthTokens.accessHash, h), eq(oauthTokens.refreshHash, h)));
    if (t)
      await this.db
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthTokens.family, t.family));
  }

  // ─────────── resource server side ───────────

  /** Resolve an OAuth access token to the agent's access; null if invalid, expired or for another server. */
  async accessForToken(accessToken: string, expectedResource: string): Promise<Access | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ t: oauthTokens, agent: agents })
      .from(oauthTokens)
      .innerJoin(agents, eq(agents.id, oauthTokens.agentId))
      .where(
        and(
          eq(oauthTokens.accessHash, sha256(accessToken)),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.accessExpiresAt, now),
        ),
      );
    if (!row || row.agent.disabled) return null;
    // Audience check (RFC 8707): only accept tokens issued for this server's MCP endpoint.
    if (row.t.resource && trimSlash(row.t.resource) !== trimSlash(expectedResource)) return null;
    if (!row.t.lastUsedAt || now.getTime() - row.t.lastUsedAt.getTime() > 60_000) {
      await this.db
        .update(oauthTokens)
        .set({ lastUsedAt: now })
        .where(eq(oauthTokens.id, row.t.id));
    }
    return this.policy.forAgent(row.agent.orgId, row.agent.id, row.agent.name);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");
