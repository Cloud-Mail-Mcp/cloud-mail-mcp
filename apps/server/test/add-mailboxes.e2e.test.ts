/**
 * End-to-end: agents adding mailboxes (password entered by a person, or sent by the agent when
 * allowed) and the spreadsheet import endpoint, against GreenMail (dave/erin mailboxes, read only).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDb, eq, memberships, orgs, users } from "@mailmcp/db";
import { prepareTestDatabase } from "@mailmcp/db/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type AppDeps, buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { config } from "../src/config";

const DAVE = { user: "dave@example.test", pass: "dave-pass-246" };
const ERIN = { user: "erin@example.test", pass: "erin-pass-135" };
const reachable = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect(port, "127.0.0.1", () => {
      s.destroy();
      res(true);
    }).on("error", () => res(false));
  });
const up = (await reachable(3143)) && (await reachable(5433));
const skip = !up && "GreenMail/Postgres not running";

let base = "";
let cookie = "";
let deps: AppDeps;
let closeAll: () => Promise<void>;
let orgId = "";
let ownerEmail = "";
let agentId = "";
let apiKey = "";

/** GreenMail's servers, given explicitly (the addresses' domain has no mail.<domain>). */
const servers = {
  imap_host: "127.0.0.1",
  imap_port: 3143,
  imap_tls: false,
  smtp_host: "127.0.0.1",
  smtp_port: 3025,
  smtp_tls: false,
};

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

async function mcp() {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = r.content[0]?.text ?? "";
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
};

before(async () => {
  if (!up) return;
  const testUrl = await prepareTestDatabase(config.databaseUrl);
  const d = createDb(testUrl);
  const built = await buildApp({
    db: d.db,
    config: { ...config, databaseUrl: testUrl, dataDir: join(tmpdir(), "mailmcp-e2e-add") },
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
    .values({ name: `e2e-${randomUUID()}` })
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
  const created = await api("POST", "/agents", { name: "Setup helper" });
  agentId = created.agent.id;
  apiKey = created.apiKey;
});

after(async () => {
  if (!up) return;
  try {
    for (const a of (await api("GET", "/accounts")).accounts)
      await api("DELETE", `/accounts/${a.id}`).catch(() => {});
    await deps.db.delete(orgs).where(eq(orgs.id, orgId));
    await deps.db.delete(users).where(eq(users.email, ownerEmail));
  } finally {
    await closeAll();
  }
});

test("agents can't add mailboxes unless allowed", { skip }, async () => {
  const client = await mcp();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.includes("add_mailboxes"));
  await client.close();
  const r = await api("PATCH", `/agents/${agentId}`, { canAddAccounts: true });
  assert.equal(r.agent.canAddAccounts, true);
});

test("added without a password: waits for a person, who enters it", { skip }, async () => {
  const client = await mcp();
  const added = await call(client, "add_mailboxes", {
    mailboxes: [{ address: ERIN.user, label: "New host", ...servers }],
    access: "assistant",
  });
  assert.equal(added.data.waiting_for_password, 1, added.text);
  assert.match(added.data.next_step, /\/admin\/accounts/);

  // A password from the agent isn't used (or kept) while the setting is off.
  const again = await call(client, "add_mailboxes", {
    mailboxes: [{ address: ERIN.user, password: ERIN.pass, ...servers }],
  });
  assert.equal(again.data.results[0].status, "waiting_for_password");
  assert.match(again.data.results[0].note, /turned off/);
  const waiting = await call(client, "list_waiting_mailboxes");
  assert.equal(waiting.data.mailboxes.length, 1, "asking twice keeps one entry");

  const { drafts } = await api("GET", "/accounts/drafts");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].agentName, "Setup helper");
  assert.equal(JSON.stringify(drafts[0]).includes(ERIN.pass), false, "no password stored");

  // The person enters the password (and narrows the agent's access to read only).
  const done = await api("POST", `/accounts/drafts/${drafts[0].id}/complete`, {
    password: ERIN.pass,
    access: "read",
  });
  assert.equal(done.account.address, ERIN.user);
  assert.equal((await api("GET", "/accounts/drafts")).drafts.length, 0);
  const agent = (await api("GET", `/agents/${agentId}`)).agent;
  assert.deepEqual(
    agent.grants.find((g: { accountId: string }) => g.accountId === done.account.id).scopes,
    ["mail:read"],
  );
  // The agent now sees the mailbox.
  const client2 = await mcp();
  const accounts = await call(client2, "list_accounts");
  assert.ok(accounts.data.accounts.some((a: { address: string }) => a.address === ERIN.user));
  await client.close();
  await client2.close();
});

test("with passwords allowed, an agent adds a mailbox in one step", { skip }, async () => {
  await api("PUT", "/settings/agentAccounts", { allowPasswords: true });
  const client = await mcp();
  const added = await call(client, "add_mailboxes", {
    mailboxes: [{ address: DAVE.user, password: DAVE.pass, ...servers }],
    access: "assistant",
  });
  assert.equal(added.data.added, 1, added.text);
  const id = added.data.results[0].accountId;
  const agent = (await api("GET", `/agents/${agentId}`)).agent;
  assert.deepEqual(
    agent.grants.find((g: { accountId: string }) => g.accountId === id).scopes.sort(),
    ["mail:draft", "mail:organize", "mail:read", "mail:unsubscribe"],
  );
  const { entries } = await api("GET", "/audit?limit=50");
  assert.ok(
    entries.some(
      (e: { action: string; actorType: string }) =>
        e.action === "account.create" && e.actorType === "agent",
    ),
    "recorded as added by the agent",
  );
  await client.close();
  await api("PUT", "/settings/agentAccounts", { allowPasswords: false });
});

test("spreadsheet import endpoint: bad rows and duplicates are reported per row", {
  skip,
}, async () => {
  const r = await api("POST", "/accounts/bulk", {
    mailboxes: [
      { address: "not-an-email" },
      {
        address: DAVE.user,
        password: DAVE.pass,
        imapHost: "127.0.0.1",
        imapPort: 3143,
        imapSecure: false,
        smtpHost: "127.0.0.1",
        smtpPort: 3025,
        smtpSecure: false,
      },
      { address: "someone@example.org" },
    ],
  });
  assert.deepEqual(
    r.results.map((x: { status: string }) => x.status),
    ["error", "error", "waiting_for_password"],
  );
  assert.match(r.results[1].error, /already connected/);
  const { drafts } = await api("GET", "/accounts/drafts");
  assert.equal(drafts[0].config.imap.host, "mail.example.org", "servers guessed from the domain");
  await api("DELETE", `/accounts/drafts/${drafts[0].id}`);
});
