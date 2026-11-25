import { GRANT_PRESETS, type GrantPreset, OAUTH_SCOPE, OAuthError } from "@cloud-mail-mcp/core";
import { accounts, eq } from "@cloud-mail-mcp/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

/**
 * OAuth 2.1 for MCP clients. Paste https://<server>/mcp into Claude, ChatGPT, Claude Code, Cursor…;
 * the client discovers these endpoints from the 401 on /mcp, registers itself, and sends the user
 * to /oauth/authorize, which hands over to the consent page in the admin panel.
 */

/** The public origin AI clients use: the configured public URL, else this request's origin. */
export async function baseUrl(d: AppDeps, req: FastifyRequest): Promise<string> {
  const { publicUrl } = await d.settings.get("general");
  return publicUrl || `${req.protocol}://${req.host}`;
}

export const resourceMetadataUrl = (base: string) =>
  `${base}/.well-known/oauth-protected-resource/mcp`;

/** Paths that browser-based MCP clients call cross-origin. */
export const CORS_PATHS = [/^\/\.well-known\//, /^\/oauth\/(token|register|revoke)$/, /^\/mcp$/];

function sendOAuthError(reply: FastifyReply, err: unknown) {
  if (err instanceof OAuthError) {
    if (err.status === 401) reply.header("www-authenticate", 'Basic realm="cloud-mail-mcp"');
    return reply.code(err.status).send({ error: err.error, error_description: err.description });
  }
  throw err;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Can't connect · Cloud Mail MCP</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#111;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:440px;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#444}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#eee}main{background:#181b21;border-color:#2a2e36}p{color:#bbb}}</style></head>
<body><main><h1>This app can't connect</h1><p>${esc(message)}</p></main></body></html>`);
}

/** Basic auth for confidential clients (RFC 6749 §2.3.1: form-urlencoded id and secret). */
function basicAuth(req: FastifyRequest) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m?.[1]) return undefined;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 0) return undefined;
  return {
    id: decodeURIComponent(raw.slice(0, i)),
    secret: decodeURIComponent(raw.slice(i + 1)),
  };
}

const flat = (body: unknown): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>))
    out[k] = typeof v === "string" ? v : undefined;
  return out;
};

export async function oauthRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);
  const admin = [auth, requireRole("owner", "admin")];

  // ─────────── discovery ───────────

  const protectedResource = async (req: FastifyRequest) => {
    const base = await baseUrl(d, req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Cloud Mail MCP",
      resource_documentation: "https://github.com/Cloud-Mail-Mcp/cloud-mail-mcp",
    };
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const authServer = async (req: FastifyRequest) => {
    const base = await baseUrl(d, req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
      scopes_supported: [OAUTH_SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  };
  app.get("/.well-known/oauth-authorization-server", authServer);
  app.get("/.well-known/oauth-authorization-server/mcp", authServer);
  app.get("/.well-known/openid-configuration", authServer);

  // ─────────── client registration (RFC 7591) ───────────

  app.post("/oauth/register", async (req, reply) => {
    try {
      const out = await d.oauth.register((req.body ?? {}) as Record<string, unknown>, req.ip);
      return reply.code(201).header("cache-control", "no-store").send(out);
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  // ─────────── authorization ───────────

  app.get("/oauth/authorize", async (req, reply) => {
    try {
      const base = await baseUrl(d, req);
      const r = await d.oauth.startAuthorization(flat(req.query), base);
      if ("redirect" in r) return reply.redirect(r.redirect);
      return reply.redirect(`/admin/connect?request=${encodeURIComponent(r.requestId)}`);
    } catch (err) {
      if (err instanceof OAuthError) return errorPage(reply, 400, err.description);
      req.log.error(err);
      return errorPage(reply, 500, "Something went wrong. Try connecting again.");
    }
  });

  /** What the consent page shows: the app, where it returns to, and the mailboxes to choose from. */
  app.get("/api/v1/oauth/requests/:id", { preHandler: admin }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    try {
      const r = d.oauth.request(id);
      const mailboxes = await d.db
        .select({
          id: accounts.id,
          address: accounts.address,
          displayName: accounts.displayName,
          label: accounts.label,
        })
        .from(accounts)
        .where(eq(accounts.orgId, req.user.orgId));
      const existing = (await d.agents.list(req.user.orgId))
        .filter((a) => a.kind === "oauth")
        .map((a) => ({ id: a.id, name: a.name, clientId: a.oauthClientId }));
      return {
        request: {
          id: r.id,
          clientName: r.clientName,
          clientId: r.clientId,
          clientKind: r.clientKind,
          redirectHost: new URL(r.redirectUri).host,
        },
        mailboxes,
        existing,
        presets: Object.entries(GRANT_PRESETS).map(([key, p]) => ({ key, label: p.label })),
      };
    } catch (err) {
      if (err instanceof OAuthError) return reply.code(err.status).send({ error: err.description });
      throw err;
    }
  });

  app.post("/api/v1/oauth/requests/:id", { preHandler: admin }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z
      .discriminatedUnion("decision", [
        z.object({ decision: z.literal("deny") }),
        z.object({
          decision: z.literal("approve"),
          name: z.string().trim().max(100).default(""),
          agentId: z.uuid().nullable().optional(),
          accounts: z
            .array(
              z.object({
                accountId: z.uuid(),
                preset: z.enum(Object.keys(GRANT_PRESETS) as [GrantPreset, ...GrantPreset[]]),
              }),
            )
            .max(500),
        }),
      ])
      .parse(req.body);
    try {
      if (b.decision === "deny") return { redirect: d.oauth.deny(id) };
      // Only this org's mailboxes can be granted.
      const own = new Set(
        (
          await d.db
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.orgId, req.user.orgId))
        ).map((a) => a.id),
      );
      const chosen = b.accounts.filter((a) => own.has(a.accountId));
      return { redirect: await d.oauth.approve(id, req.user, { ...b, accounts: chosen }) };
    } catch (err) {
      if (err instanceof OAuthError) return reply.code(err.status).send({ error: err.description });
      throw err;
    }
  });

  // ─────────── tokens ───────────

  app.post("/oauth/token", async (req, reply) => {
    reply.header("cache-control", "no-store").header("pragma", "no-cache");
    try {
      return await d.oauth.token(flat(req.body), basicAuth(req));
    } catch (err) {
      return sendOAuthError(reply, err);
    }
  });

  app.post("/oauth/revoke", async (req) => {
    await d.oauth.revoke(flat(req.body).token);
    return {};
  });
}
