/**
 * End-to-end: admin API + MCP endpoint (real MCP SDK client) against GreenMail.
 * Skips if GreenMail/Postgres aren't running (docker compose --profile testmail up -d).
 *   pnpm --filter @mailmcp/server test
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
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { type AppDeps, buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { config } from "../src/config";

const BOB = { user: "carol@example.test", pass: "carol-pass-789" }; // own mailbox: suites run in parallel
const ALICE = { user: "alice@example.test", pass: "alice-pass-123" };
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
let accountId = "";
let agentId = "";
let apiKey = "";
const marker = `zebrafish-${randomUUID().slice(0, 8)}`;

const imapFor = async (u: { user: string; pass: string }) => {
  const c = new ImapFlow({
    host: "127.0.0.1",
    port: 3143,
    secure: false,
    auth: { user: u.user, pass: u.pass },
    logger: false,
  });
  await c.connect();
  return c;
};

/** Sync, waiting if another process (e.g. a running worker) holds the account's sync lease. */
async function syncNow(id: string, opts: { bodyBudgetMs?: number } = {}) {
  for (let i = 0; i < 120; i++) {
    const r = await deps.sync.syncAccount(id, opts);
    if (!r.skipped) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("sync lease never became free");
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

async function mcp(key = apiKey) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
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
const imapCount = async (folder: string) => {
  const c = await imapFor(BOB);
  try {
    return (await c.status(folder, { messages: true })).messages ?? 0;
  } finally {
    await c.logout();
    c.close();
  }
};

before(async () => {
  if (!up) return;
  // Fresh mailbox for bob
  const c = await imapFor(BOB);
  for (const f of await c.list()) {
    if (f.flags.has("\\Noselect")) continue;
    const lock = await c.getMailboxLock(f.path);
    try {
      if ((c.mailbox as { exists: number }).exists) await c.messageDelete("1:*");
    } finally {
      lock.release();
    }
  }
  for (const f of ["Sent", "Trash", "Archive"]) await c.mailboxCreate(f).catch(() => {});
  for (let i = 0; i < 6; i++) {
    const raw = await new MailComposer({
      from: `Client ${i} <client${i}@example.test>`,
      to: BOB.user,
      subject: `Project update ${i}`,
      text: i === 3 ? `Notes about the ${marker} migration.` : `Update number ${i}.`,
      date: new Date(Date.now() - (10 - i) * 3600_000),
    })
      .compile()
      .build();
    await c.append("INBOX", raw, []);
  }
  await c.logout();
  c.close();

  const testUrl = await prepareTestDatabase(config.databaseUrl);
  const d = createDb(testUrl);
  const built = await buildApp({
    db: d.db,
    // Isolated from any dev install: own database, own data folder.
    config: { ...config, databaseUrl: testUrl, dataDir: join(tmpdir(), "mailmcp-e2e") },
    masterKey: Buffer.alloc(32, 9),
    masterKeyInfo: { source: "env" },
    logger: false,
  });
  deps = built.deps;
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = built.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  closeAll = async () => {
    await built.app.close();
    await d.close();
  };

  // Our own org + owner user, then log in through the API.
  const [org] = await d.db
    .insert(orgs)
    .values({ name: `e2e-${randomUUID()}` })
    .returning();
  orgId = org!.id;
  const email = `owner-${randomUUID().slice(0, 8)}@example.test`;
  ownerEmail = email;
  const [u] = await d.db
    .insert(users)
    .values({ email, passwordHash: await hashPassword("e2e-password-123") })
    .returning();
  await d.db.insert(memberships).values({ orgId, userId: u!.id, role: "owner" });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "e2e-password-123" }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
  assert.ok(cookie.startsWith("mailmcp_session="));
});

after(async () => {
  if (!up) return;
  try {
    if (accountId) await api("DELETE", `/accounts/${accountId}`);
    await deps.db.delete(orgs).where(eq(orgs.id, orgId));
    await deps.db.delete(users).where(eq(users.email, ownerEmail));
  } finally {
    await closeAll();
  }
});

test("admin: add account, sync it, create agent with read-only grant", { skip }, async () => {
  const { account } = await api("POST", "/accounts", {
    moduleId: "imap",
    address: BOB.user,
    config: {
      imap: { host: "127.0.0.1", port: 3143, secure: false },
      smtp: { host: "127.0.0.1", port: 3025, secure: false },
      username: BOB.user,
      password: BOB.pass,
    },
  });
  accountId = account.id;
  const roles = account.folders.map((f: { role: string | null }) => f.role);
  assert.ok(
    roles.includes("inbox") && roles.includes("sent") && roles.includes("trash"),
    "roles detected by folder name",
  );
  await syncNow(accountId, { bodyBudgetMs: 30_000 });

  const created = await api("POST", "/agents", { name: "E2E agent" });
  agentId = created.agent.id;
  apiKey = created.apiKey;
  assert.match(apiKey, /^mmcp_/);
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read"],
    sendPolicy: "deny",
  });
  await api("PATCH", `/accounts/${accountId}`, { instructions: "Never delete invoices." });
});

test("mcp: bad key is rejected", { skip }, async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer mmcp_nope", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 401);
});

test("mcp: tools are filtered by grant; reads work; email bodies marked untrusted", {
  skip,
}, async () => {
  const client = await mcp();
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("search_messages") && names.includes("get_message"));
  assert.ok(
    !names.includes("send_email") &&
      !names.includes("delete_messages") &&
      !names.includes("move_messages"),
    "write tools hidden",
  );

  const accs = await call(client, "list_accounts");
  assert.deepEqual(
    accs.data.accounts.map((a: { address: string }) => a.address),
    [BOB.user],
    "only granted account visible",
  );
  assert.equal(
    accs.data.accounts[0].instructions,
    "Never delete invoices.",
    "per-account instructions reach the agent",
  );

  const found = await call(client, "search_messages", { query: marker });
  assert.equal(found.data.messages.length, 1, "body text search");
  const msg = await call(client, "get_message", { id: found.data.messages[0].id });
  assert.match(msg.data.body, /<email_content untrusted="true">/);
  assert.match(msg.data.body, new RegExp(marker));

  const listed = await call(client, "list_messages", { limit: 3 });
  assert.equal(listed.data.messages.length, 3);
  assert.ok(listed.data.nextCursor, "paginates");
  await client.close();
});

test("mcp: sort by date, sender and subject, with paging", { skip }, async () => {
  const client = await mcp();
  const sorted = (xs: string[], dir: 1 | -1) => [...xs].sort((a, b) => dir * a.localeCompare(b));

  // Oldest first, paged 4 at a time: every message exactly once, in order.
  const p1 = await call(client, "list_messages", { sort: "date", order: "asc", limit: 4 });
  const p2 = await call(client, "list_messages", {
    sort: "date",
    order: "asc",
    limit: 4,
    cursor: p1.data.nextCursor,
  });
  const dates = [...p1.data.messages, ...p2.data.messages].map((m: { date: string }) => m.date);
  assert.equal(dates.length, 6, "two pages cover all six messages");
  assert.deepEqual(dates, [...dates].sort(), "ascending dates");
  assert.equal(p2.data.nextCursor, undefined);

  const bySender = await call(client, "list_messages", { sort: "from", limit: 3 });
  const bySender2 = await call(client, "list_messages", {
    sort: "from",
    limit: 3,
    cursor: bySender.data.nextCursor,
  });
  const emails = [...bySender.data.messages, ...bySender2.data.messages].map(
    (m: { from: { email: string } }) => m.from.email,
  );
  assert.deepEqual(emails, sorted(emails, 1), "sender A→Z across pages");
  assert.equal(new Set(emails).size, 6, "no duplicates across offset pages");

  const bySubject = await call(client, "search_messages", {
    query: "update",
    sort: "subject",
    order: "desc",
  });
  const subjects = bySubject.data.messages.map((m: { subject: string }) => m.subject.toLowerCase());
  assert.equal(subjects.length, 6);
  assert.deepEqual(subjects, sorted(subjects, -1), "subject Z→A");
  await client.close();
});

test("mcp: organize + delete are write-through to the mail server", { skip }, async () => {
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read", "mail:organize", "mail:delete"],
    sendPolicy: "deny",
  });
  const client = await mcp();
  const { data } = await call(client, "list_messages", { limit: 10 });
  const [a, b, c] = data.messages.map((m: { id: number }) => m.id);

  // Folder counts follow changes made here right away, without waiting for a sync.
  const counts = async () => {
    const { folders } = await api("GET", `/mail/folders?accountId=${accountId}`);
    const by = (role: string) => folders.find((f: { role: string }) => f.role === role);
    return {
      inbox: by("inbox").messageCount as number,
      unread: by("inbox").unreadCount as number,
      trash: by("trash").messageCount as number,
    };
  };
  await api("POST", "/mail/messages/mark", { ids: [a, b, c], read: false });
  const before = await counts();

  await call(client, "mark_messages", { ids: [a], read: true, flagged: true });
  assert.equal((await counts()).unread, before.unread - 1, "reading lowers the unread count");
  const imap = await imapFor(BOB);
  const lock = await imap.getMailboxLock("INBOX");
  const flagged = (await imap.search({ flagged: true, seen: true }, { uid: true })) || [];
  lock.release();
  await imap.logout();
  imap.close();
  assert.equal(flagged.length, 1, "flags written to IMAP");

  const moved = await call(client, "move_messages", { ids: [b], folder: "archive" });
  assert.ok(!moved.isError, moved.text);
  assert.equal(await imapCount("Archive"), 1, "moved on server");

  const del = await call(client, "delete_messages", { ids: [c] });
  assert.deepEqual(del.data, { trashed: 1, deleted: 0 });
  assert.equal(await imapCount("Trash"), 1, "trashed on server");
  const after = await counts();
  assert.equal(after.inbox, before.inbox - 2, "moving and deleting lower the inbox total");
  assert.equal(after.unread, before.unread - 3, "…and its unread count");
  assert.equal(after.trash, before.trash + 1, "Trash goes up");

  const perm = await call(client, "delete_messages", { ids: [a], permanent: true });
  assert.ok(
    perm.isError && /permanent/.test(perm.text),
    "permanent delete needs its own permission",
  );
  await client.close();
});

test("mcp: send held for approval, then delivered after a human approves", { skip }, async () => {
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read", "mail:send"],
    sendPolicy: "approve",
    recipientAllow: ["example.test"],
  });
  const client = await mcp();
  const blocked = await call(client, "send_email", {
    account_id: accountId,
    to: ["someone@elsewhere.test"],
    subject: "x",
    body: "x",
  });
  assert.ok(
    blocked.isError && /Not allowed to send/.test(blocked.text),
    "recipient allow-list enforced",
  );

  const subject = `Approval test ${randomUUID().slice(0, 6)}`;
  const sent = await call(client, "send_email", {
    account_id: accountId,
    to: [`Alice <${ALICE.user}>`],
    subject,
    body: "Hello from the e2e agent.",
  });
  assert.equal(sent.data.status, "pending_approval");
  const pendingId = sent.data.pendingId;

  const { approvals } = await api("GET", "/approvals");
  assert.ok(
    approvals.some((p: { id: string }) => p.id === pendingId),
    "visible in approval queue",
  );
  const decided = await api("POST", `/approvals/${pendingId}/approve`);
  assert.equal(decided.status, "executed");

  const status = await call(client, "get_pending_action", { id: pendingId });
  assert.equal(status.data.status, "executed");

  const alice = await imapFor(ALICE);
  const lock = await alice.getMailboxLock("INBOX");
  const hits = (await alice.search({ subject }, { uid: true })) || [];
  lock.release();
  await alice.logout();
  alice.close();
  assert.equal(hits.length, 1, "delivered to recipient");
  assert.equal(await imapCount("Sent"), 1, "copy filed in Sent");
  await client.close();
});

test("mcp: folder restrictions hide other folders", { skip }, async () => {
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read"],
    folderAllow: ["INBOX"],
    sendPolicy: "deny",
  });
  await syncNow(accountId, { bodyBudgetMs: 10_000 });
  const client = await mcp();
  const folders = await call(client, "list_folders");
  assert.deepEqual(
    folders.data.folders.map((f: { path: string }) => f.path),
    ["INBOX"],
  );
  const archived = await call(client, "list_messages", { folder: "archive" });
  assert.ok(archived.isError || archived.data.messages.length === 0, "archive not listable");
  const all = await call(client, "search_messages", { query: "Project update" });
  assert.ok(
    all.data.messages.every((m: { folders: string[] }) => m.folders.includes("INBOX")),
    "search limited to INBOX",
  );
  await client.close();
});

test("unsubscribe: one-click, email (with approval) and web-page lists", { skip }, async () => {
  const tag = randomUUID().slice(0, 6);
  const unsubSubject = `unsub-${tag}`;
  const lists = {
    email: {
      subject: `Weekly digest ${tag}`,
      header: `<mailto:${ALICE.user}?subject=${unsubSubject}>`,
    },
    oneClick: {
      subject: `Deals ${tag}`,
      header: "<https://127.0.0.1/u/abc>, <mailto:nobody@example.test>",
    },
    web: { subject: `Offers ${tag}`, header: "<http://unsubscribe.example.test/u?id=1>" },
  };
  const c = await imapFor(BOB);
  for (const [kind, l] of Object.entries(lists)) {
    const raw = await new MailComposer({
      from: `News <news@example.test>`,
      to: BOB.user,
      subject: l.subject,
      text: "Newsletter body",
      headers: {
        "List-Unsubscribe": l.header,
        ...(kind === "oneClick" ? { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}),
      },
    })
      .compile()
      .build();
    await c.append("INBOX", raw, []);
  }
  await c.logout();
  c.close();
  await syncNow(accountId);
  const idOf = async (subject: string) => {
    const r = await api("GET", `/mail/search?q=${encodeURIComponent(`subject:"${subject}"`)}`);
    assert.equal(r.messages.length, 1, `found ${subject}`);
    return r.messages[0].id as number;
  };
  const ids = {
    email: await idOf(lists.email.subject),
    oneClick: await idOf(lists.oneClick.subject),
    web: await idOf(lists.web.subject),
  };

  // Message details say how to unsubscribe.
  const detail = async (id: number) => (await api("GET", `/mail/messages/${id}`)).message;
  assert.deepEqual((await detail(ids.email)).unsubscribe, {
    method: "email",
    website: null,
    unsubscribedAt: null,
  });
  assert.equal((await detail(ids.oneClick)).unsubscribe.method, "one_click");
  const [first] = (await api("GET", `/mail/search?q=${encodeURIComponent("Project update")}`))
    .messages;
  assert.equal((await detail(first.id)).unsubscribe, null, "ordinary mail has none");

  // Web page only: hand the link to a person.
  const web = await api("POST", `/mail/messages/${ids.web}/unsubscribe`);
  assert.deepEqual(
    [web.status, web.url],
    ["open_website", "http://unsubscribe.example.test/u?id=1"],
  );

  // One-click never reaches private addresses.
  await assert.rejects(
    api("POST", `/mail/messages/${ids.oneClick}/unsubscribe`),
    /502.*private or unknown host/,
  );

  // Agents need the unsubscribe permission; email unsubscribes also follow the send policy.
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read"],
    sendPolicy: "deny",
  });
  let client = await mcp();
  assert.ok(
    !(await client.listTools()).tools.some((t) => t.name === "unsubscribe"),
    "no unsubscribe tool without the permission",
  );
  await client.close();
  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read", "mail:unsubscribe"],
    sendPolicy: "deny",
  });
  client = await mcp();
  const noSend = await call(client, "unsubscribe", { id: ids.email });
  assert.ok(noSend.isError && /permission to send/.test(noSend.text), noSend.text);
  await client.close();

  await api("PUT", `/agents/${agentId}/grants/${accountId}`, {
    scopes: ["mail:read", "mail:unsubscribe", "mail:send"],
    sendPolicy: "approve",
    recipientAllow: ["example.test"],
  });
  client = await mcp();
  const queued = await call(client, "unsubscribe", { id: ids.email });
  assert.equal(queued.data.status, "pending_approval", queued.text);
  const { approvals } = await api("GET", "/approvals");
  const p = approvals.find((a: { id: string }) => a.id === queued.data.pendingId);
  assert.deepEqual([p.kind, p.payload.to], ["unsubscribe", ALICE.user]);
  const decided = await api("POST", `/approvals/${queued.data.pendingId}/approve`);
  assert.equal(decided.status, "executed");
  assert.equal(decided.result.status, "unsubscribed");
  await client.close();

  const alice = await imapFor(ALICE);
  const lock = await alice.getMailboxLock("INBOX");
  const hits = (await alice.search({ subject: unsubSubject }, { uid: true })) || [];
  lock.release();
  await alice.logout();
  alice.close();
  assert.equal(hits.length, 1, "unsubscribe email delivered to the list address");
  assert.ok((await detail(ids.email)).unsubscribe.unsubscribedAt, "remembered as unsubscribed");
});

test("audit log records agent activity, including denials", { skip }, async () => {
  const { entries } = await api("GET", "/audit?limit=200");
  const actions = entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes("mcp.get_message"));
  assert.ok(actions.includes("mail.send"), "the approved send was logged");
  assert.ok(actions.includes("mail.unsubscribe"), "unsubscribes are logged");
  assert.ok(
    entries.some((e: { allowed: boolean }) => e.allowed === false),
    "denied attempts logged",
  );
});
