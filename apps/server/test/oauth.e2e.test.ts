/**
 * End-to-end OAuth for MCP clients, driven by the MCP SDK's own OAuth client (the same discovery,
 * dynamic registration and PKCE flow Claude, ChatGPT and Claude Code use).
 * Needs Postgres only (docker compose up -d).  pnpm --filter @mailmcp/server test
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDb, eq, memberships, orgs, users } from "@mailmcp/db";
import { prepareTestDatabase } from "@mailmcp/db/testing";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type AppDeps, buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { config } from "../src/config";

const up = await new Promise<boolean>((res) => {
  const s = connect(5433, "127.0.0.1", () => {
    s.destroy();
    res(true);
  }).on("error", () => res(false));
});
const skip = !up && "Postgres not running";

const REDIRECT = "http://localhost:7777/callback";
let base = "";
let cookie = "";
let deps: AppDeps;
let closeAll: () => Promise<void>;
let orgId = "";
let ownerEmail = "";

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return {
      client_name: "E2E OAuth client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j)}`);
  return j as T;
}

const form = (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

/** Browser part of the flow: open the authorize URL, approve on the consent API, return the code. */
async function approveInBrowser(authUrl: URL, name = "Claude (test)") {
  const r = await fetch(authUrl, { redirect: "manual" });
  assert.equal(r.status, 302);
  const consent = new URL(r.headers.get("location") ?? "", base);
  assert.equal(consent.pathname, "/admin/connect");
  const id = consent.searchParams.get("request") ?? "";
  const info = await api("GET", `/oauth/requests/${id}`);
  assert.equal(info.request.clientName, "E2E OAuth client");
  assert.equal(info.request.redirectHost, "localhost:7777");
  const { redirect } = await api("POST", `/oauth/requests/${id}`, {
    decision: "approve",
    name,
    accounts: [],
  });
  const back = new URL(redirect);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), authUrl.searchParams.get("state"));
  assert.equal(back.searchParams.get("iss"), base);
  return back.searchParams.get("code") ?? "";
}

const mcpStatus = async (token: string) =>
  (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "1" },
        },
      }),
    })
  ).status;

before(async () => {
  if (!up) return;
  const testUrl = await prepareTestDatabase(config.databaseUrl);
  const d = createDb(testUrl);
  const built = await buildApp({
    db: d.db,
    config: { ...config, databaseUrl: testUrl, dataDir: join(tmpdir(), "mailmcp-oauth-e2e") },
    masterKey: Buffer.alloc(32, 9),
    masterKeyInfo: { source: "env" },
    logger: false,
  });
  deps = built.deps;
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  closeAll = async () => {
    await built.app.close();
    await d.close();
  };
  const [org] = await d.db
    .insert(orgs)
    .values({ name: `oauth-e2e-${randomUUID()}` })
    .returning();
  orgId = org!.id;
  ownerEmail = `owner-${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await d.db
    .insert(users)
    .values({ email: ownerEmail, passwordHash: await hashPassword("e2e-password-123") })
    .returning();
  await d.db.insert(memberships).values({ orgId, userId: u!.id, role: "owner" });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "e2e-password-123" }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

after(async () => {
  if (!up) return;
  try {
    await deps.db.delete(orgs).where(eq(orgs.id, orgId));
    await deps.db.delete(users).where(eq(users.email, ownerEmail));
  } finally {
    await closeAll();
  }
});

test("discovery: 401 on /mcp points at metadata; both metadata documents are consistent", {
  skip,
}, async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
  const challenge = r.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
  assert.equal(prmUrl, `${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");

  const prm = await (await fetch(prmUrl)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [base]);

  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));

  const pre = await fetch(`${base}/oauth/token`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
});

test("SDK client: register, sign in, approve, then use MCP; refresh rotates; revoke cuts off", {
  skip,
}, async () => {
  const provider = new TestProvider();
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    authProvider: provider,
  });
  const client = new Client({ name: "oauth-e2e", version: "1" });
  await assert.rejects(client.connect(transport), UnauthorizedError);
  assert.ok(provider.info?.client_id.startsWith("mmcp_client_"), "registered dynamically");
  assert.ok(provider.authUrl, "sent the user to authorize");
  assert.equal(provider.authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(provider.authUrl.searchParams.get("resource"), `${base}/mcp`);

  const code = await approveInBrowser(provider.authUrl);
  await transport.finishAuth(code);
  const t1 = provider.saved as OAuthTokens;
  assert.match(t1.access_token, /^mmcp_at_/);
  assert.match(t1.refresh_token ?? "", /^mmcp_rt_/);

  const client2 = new Client({ name: "oauth-e2e", version: "1" });
  await client2.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }),
  );
  await client2.listTools();
  await client2.close();

  // The approved app is an agent in the admin list.
  const { agents } = await api("GET", "/agents");
  const agent = agents.find((a: { kind: string; name: string }) => a.kind === "oauth");
  assert.equal(agent?.name, "Claude (test)");

  // Refresh rotates; reusing the old refresh token ends the whole session.
  const r1 = await form("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: t1.refresh_token!,
    client_id: provider.info!.client_id,
  });
  assert.equal(r1.status, 200);
  const t2 = await r1.json();
  assert.notEqual(t2.refresh_token, t1.refresh_token);
  assert.equal(await mcpStatus(t2.access_token), 200);

  const reuse = await form("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: t1.refresh_token!,
    client_id: provider.info!.client_id,
  });
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal(await mcpStatus(t2.access_token), 401, "family revoked after reuse");

  // A fresh sign-in; replaying its code is refused and revokes what the code produced.
  const pr = new TestProvider();
  pr.info = provider.info;
  const trr = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: pr });
  await assert.rejects(new Client({ name: "x", version: "1" }).connect(trr), UnauthorizedError);
  const code2 = await approveInBrowser(pr.authUrl!);
  await trr.finishAuth(code2);
  assert.equal(await mcpStatus(pr.saved!.access_token), 200);
  const replay = await form("/oauth/token", {
    grant_type: "authorization_code",
    code: code2,
    code_verifier: pr.verifier,
    redirect_uri: REDIRECT,
    client_id: provider.info!.client_id,
  });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.equal(await mcpStatus(pr.saved!.access_token), 401, "replay revokes the code's tokens");

  // A fresh sign-in, then revocation.
  const p2 = new TestProvider();
  p2.info = provider.info;
  const tr = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p2 });
  await assert.rejects(new Client({ name: "x", version: "1" }).connect(tr), UnauthorizedError);
  await tr.finishAuth(await approveInBrowser(p2.authUrl!));
  const t3 = p2.saved as OAuthTokens;
  assert.equal(await mcpStatus(t3.access_token), 200);
  assert.equal((await form("/oauth/revoke", { token: t3.refresh_token! })).status, 200);
  assert.equal(await mcpStatus(t3.access_token), 401);

  // Disabling the agent in the admin cuts off its tokens too.
  const p3 = new TestProvider();
  p3.info = provider.info;
  const tr3 = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: p3 });
  await assert.rejects(new Client({ name: "x", version: "1" }).connect(tr3), UnauthorizedError);
  await tr3.finishAuth(await approveInBrowser(p3.authUrl!));
  assert.equal(await mcpStatus(p3.saved!.access_token), 200);
  const agentsNow = (await api("GET", "/agents")).agents.filter(
    (a: { kind: string }) => a.kind === "oauth",
  );
  for (const a of agentsNow) await api("PATCH", `/agents/${a.id}`, { disabled: true });
  assert.equal(await mcpStatus(p3.saved!.access_token), 401);
});

test("authorize: rejects unknown redirect URIs, missing PKCE and a wrong verifier", {
  skip,
}, async () => {
  const reg = await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "E2E OAuth client", redirect_uris: [REDIRECT] }),
    })
  ).json();
  const clientId = reg.client_id as string;

  // Unregistered redirect: an error page, never a redirect.
  const bad = await fetch(
    `${base}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      code_challenge: "x",
      code_challenge_method: "S256",
    })}`,
    { redirect: "manual" },
  );
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get("content-type") ?? "", /html/);

  // Loopback redirects may use any port.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const otherPort = "http://127.0.0.1:9999/callback";
  const regLoop = await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "E2E OAuth client",
        redirect_uris: ["http://127.0.0.1/callback"],
      }),
    })
  ).json();
  const authUrl = new URL(
    `${base}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: regLoop.client_id,
      redirect_uri: otherPort,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    })}`,
  );

  // Missing PKCE: error goes back to the (valid) redirect URI.
  const noPkce = new URL(authUrl);
  noPkce.searchParams.delete("code_challenge");
  const np = await fetch(noPkce, { redirect: "manual" });
  assert.equal(np.status, 302);
  assert.equal(new URL(np.headers.get("location")!).searchParams.get("error"), "invalid_request");

  const r = await fetch(authUrl, { redirect: "manual" });
  const id = new URL(r.headers.get("location")!, base).searchParams.get("request")!;
  const { redirect } = await api("POST", `/oauth/requests/${id}`, {
    decision: "approve",
    name: "loopback",
    accounts: [],
  });
  const code = new URL(redirect).searchParams.get("code")!;
  const wrong = await form("/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: randomBytes(32).toString("base64url"),
    redirect_uri: otherPort,
    client_id: regLoop.client_id,
  });
  assert.equal((await wrong.json()).error, "invalid_grant");

  // Denying sends access_denied back to the app.
  const r2 = await fetch(authUrl, { redirect: "manual" });
  const id2 = new URL(r2.headers.get("location")!, base).searchParams.get("request")!;
  const denied = await api("POST", `/oauth/requests/${id2}`, { decision: "deny" });
  assert.equal(new URL(denied.redirect).searchParams.get("error"), "access_denied");
  assert.equal(new URL(denied.redirect).searchParams.get("state"), "s1");
});
