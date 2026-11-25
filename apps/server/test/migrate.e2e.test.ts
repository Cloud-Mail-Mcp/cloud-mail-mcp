/**
 * End-to-end: copying mail between two accounts (moving hosts) against GreenMail.
 * Uses its own mailboxes (dave = old host, erin = new host) so it can run beside other suites.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDb, eq, memberships, orgs, users } from "@cloud-mail-mcp/db";
import { prepareTestDatabase } from "@cloud-mail-mcp/db/testing";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { type AppDeps, buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { config } from "../src/config";

const OLD = { user: "dave@example.test", pass: "dave-pass-246" };
/** A nested folder that's new on every run (folders aren't deleted between runs). */
const NESTED = `Y${randomUUID().slice(0, 6)}`;
const isNested = (path: string) => new RegExp(`Projects.${NESTED}$`).test(path);
const NEW = { user: "erin@example.test", pass: "erin-pass-135" };
const reachable = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect(port, "127.0.0.1", () => {
      s.destroy();
      res(true);
    }).on("error", () => res(false));
  });
const up = (await reachable(3143)) && (await reachable(5433));
let usersExist = false;

let base = "";
let cookie = "";
let deps: AppDeps;
let closeAll: () => Promise<void>;
let orgId = "";
let ownerEmail = "";
let oldId = "";
let newId = "";
let migrationId = "";

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

async function withImap<T>(u: typeof OLD, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = await imapFor(u);
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
    c.close();
  }
}

const mail = (subject: string, opts: { messageId?: string; daysAgo?: number } = {}) =>
  new MailComposer({
    from: "Someone <someone@example.test>",
    to: OLD.user,
    subject,
    text: `${subject} body`,
    messageId: opts.messageId,
    date: new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000),
  })
    .compile()
    .build();

/** Subjects in a folder, sorted, plus flags by subject. */
async function folderOf(u: typeof OLD, path: string) {
  return withImap(u, async (c) => {
    const lock = await c.getMailboxLock(path);
    try {
      const out: Array<{ subject: string; flags: string[] }> = [];
      if ((c.mailbox as { exists: number }).exists)
        for await (const m of c.fetch("1:*", { envelope: true, flags: true }))
          out.push({ subject: m.envelope?.subject ?? "", flags: [...(m.flags ?? [])].sort() });
      return out.sort((a, b) => a.subject.localeCompare(b.subject));
    } finally {
      lock.release();
    }
  });
}
const subjects = async (u: typeof OLD, path: string) =>
  (await folderOf(u, path)).map((m) => m.subject);

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

const imapConfig = (u: typeof OLD, host = "127.0.0.1") => ({
  imap: { host, port: 3143, secure: false },
  smtp: { host, port: 3025, secure: false },
  username: u.user,
  password: u.pass,
});

before(async () => {
  if (!up) return;
  // dave/erin exist only in a GreenMail started with the current docker-compose.yml.
  usersExist = await withImap(OLD, async () => true).catch(() => false);
  if (!usersExist) return;

  for (const u of [OLD, NEW]) {
    await withImap(u, async (c) => {
      // Empty every folder (GreenMail can crash on DELETE, so folders are kept).
      for (const f of await c.list()) {
        if (f.flags.has("\\Noselect")) continue;
        const lock = await c.getMailboxLock(f.path);
        try {
          if ((c.mailbox as { exists: number }).exists) await c.messageDelete("1:*");
        } finally {
          lock.release();
        }
      }
    });
  }
  // Old host: Inbox, Sent, a nested folder; one message already on the new host too.
  await withImap(OLD, async (c) => {
    await c.mailboxCreate("Sent").catch(() => {});
    await c.mailboxCreate(["Projects", NESTED]);
    for (let i = 1; i <= 4; i++) await c.append("INBOX", await mail(`Old inbox ${i}`), []);
    await c.append(
      "INBOX",
      await mail("Already moved", { messageId: "<already-moved@example.test>" }),
      ["\\Seen"],
    );
    await c.append("Sent", await mail("Old sent"), ["\\Seen"]);
    const nested = (await c.list()).find((f) => isNested(f.path))!.path;
    await c.append(nested, await mail("Project plan", { daysAgo: 400 }), ["\\Seen", "\\Flagged"]);
    await c.append(nested, await mail("Project budget"), []);
  });
  await withImap(NEW, async (c) => {
    await c.mailboxCreate("Sent").catch(() => {});
    await c.append(
      "INBOX",
      await mail("Already moved", { messageId: "<already-moved@example.test>" }),
      ["\\Seen"],
    );
  });

  const testUrl = await prepareTestDatabase(config.databaseUrl);
  const d = createDb(testUrl);
  const built = await buildApp({
    db: d.db,
    config: {
      ...config,
      databaseUrl: testUrl,
      dataDir: join(tmpdir(), "cloud-mail-mcp-e2e-migrate"),
    },
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
});

after(async () => {
  if (!up || !usersExist) return;
  try {
    for (const id of [oldId, newId]) if (id) await api("DELETE", `/accounts/${id}`).catch(() => {});
    await deps.db.delete(orgs).where(eq(orgs.id, orgId));
    await deps.db.delete(users).where(eq(users.email, ownerEmail));
  } finally {
    await closeAll();
  }
});

const skip = () =>
  !up ? "GreenMail/Postgres not running" : !usersExist && "GreenMail lacks dave/erin (recreate it)";

test("the same address can be connected twice through different servers", async (t) => {
  if (skip()) return t.skip(skip() as string);
  const a = await api("POST", "/accounts", {
    moduleId: "imap",
    address: OLD.user,
    config: imapConfig(OLD),
  });
  oldId = a.account.id;
  assert.equal(a.account.label, null, "a single login needs no label");

  // Same address, different server name: allowed, and both get labelled.
  const dup = await api("POST", "/accounts", {
    moduleId: "imap",
    address: OLD.user,
    config: imapConfig(OLD, "localhost"),
  });
  assert.equal(dup.account.label, "localhost");
  const { accounts } = await api("GET", "/accounts");
  assert.equal(accounts.find((x: { id: string }) => x.id === oldId).label, "127.0.0.1");

  // Same login again: refused.
  await assert.rejects(
    api("POST", "/accounts", { moduleId: "imap", address: OLD.user, config: imapConfig(OLD) }),
    /409.*already connected with this login/,
  );
  const renamed = await api("PATCH", `/accounts/${oldId}`, { label: "Old host" });
  assert.equal(renamed.account.label, "Old host");
  await api("DELETE", `/accounts/${dup.account.id}`);

  const b = await api("POST", "/accounts", {
    moduleId: "imap",
    address: NEW.user,
    config: imapConfig(NEW),
  });
  newId = b.account.id;
});

test("preview maps folders by role and by name", async (t) => {
  if (skip()) return t.skip(skip() as string);
  const p = await api("POST", "/migrations/preview", { fromAccountId: oldId, toAccountId: newId });
  const by = new Map(p.forward.map((f: { source: string }) => [f.source, f]));
  assert.equal((by.get("INBOX") as { target: string }).target, "INBOX");
  assert.equal((by.get("Sent") as { targetExists: boolean }).targetExists, true);
  const nested = p.forward.find((f: { source: string }) => isNested(f.source));
  assert.ok(nested && !nested.targetExists && isNested(nested.target), "nested folder to create");
});

test("first pass copies everything missing, keeps flags, skips what's there", async (t) => {
  if (skip()) return t.skip(skip() as string);
  const { migration } = await api("POST", "/migrations", {
    fromAccountId: oldId,
    toAccountId: newId,
  });
  migrationId = migration.id;
  assert.equal(migration.continuous, true);
  await assert.rejects(
    api("POST", "/migrations", { fromAccountId: newId, toAccountId: oldId }),
    /409/,
    "one migration per pair",
  );

  const r = await deps.migrations.runPass(migrationId);
  assert.deepEqual(r, { more: false, copied: 7 });
  assert.deepEqual(await subjects(NEW, "INBOX"), [
    "Already moved",
    "Old inbox 1",
    "Old inbox 2",
    "Old inbox 3",
    "Old inbox 4",
  ]);
  assert.deepEqual(await subjects(NEW, "Sent"), ["Old sent"]);
  const nestedPath = await withImap(
    NEW,
    async (c) => (await c.list()).find((f) => isNested(f.path))?.path,
  );
  assert.ok(nestedPath, "nested folder created on the new host");
  const nested = await folderOf(NEW, nestedPath as string);
  assert.deepEqual(
    nested.map((m) => [m.subject, m.flags.filter((f) => f.startsWith("\\")).join(" ")]),
    [
      ["Project budget", ""],
      ["Project plan", "\\Flagged \\Seen"],
    ],
    "read and flagged state copied",
  );

  const { migrations } = await api("GET", "/migrations");
  const m = migrations.find((x: { id: string }) => x.id === migrationId);
  assert.ok(m.initialDoneAt, "first copy marked done");
  assert.equal(m.running, false);
  const states = Object.values(m.state) as Array<{ copied: number; skipped: number }>;
  assert.equal(
    states.reduce((n, s) => n + s.copied, 0),
    7,
  );
  assert.equal(
    states.reduce((n, s) => n + s.skipped, 0),
    1,
  );
});

test("later passes copy only new mail, and never twice", async (t) => {
  if (skip()) return t.skip(skip() as string);
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 0, "nothing new");
  await withImap(OLD, async (c) => c.append("INBOX", await mail("Arrived at old host"), []));
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 1);
  assert.ok((await subjects(NEW, "INBOX")).includes("Arrived at old host"));
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 0);
});

test("both ways: mail landing on the new host is copied back, without ping-pong", async (t) => {
  if (skip()) return t.skip(skip() as string);
  await api("PATCH", `/migrations/${migrationId}`, { twoWay: true });
  await withImap(NEW, async (c) => c.append("INBOX", await mail("Arrived at new host"), []));
  await withImap(OLD, async (c) => c.append("INBOX", await mail("Another at old host"), []));
  const r = await deps.migrations.runPass(migrationId);
  // First two-way pass also looks at everything already on the new host: all of it is skipped.
  assert.equal(r.copied, 2);
  assert.ok((await subjects(OLD, "INBOX")).includes("Arrived at new host"));
  assert.ok((await subjects(NEW, "INBOX")).includes("Another at old host"));
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 0, "stable");
  const inbox = await subjects(OLD, "INBOX");
  assert.equal(inbox.length, new Set(inbox).size, "no duplicates on the old host");
  const newInbox = await subjects(NEW, "INBOX");
  assert.equal(newInbox.length, new Set(newInbox).size, "no duplicates on the new host");
});

test("reverse, pause and finish", async (t) => {
  if (skip()) return t.skip(skip() as string);
  const rev = await api("PATCH", `/migrations/${migrationId}`, { twoWay: false, reverse: true });
  assert.deepEqual([rev.migration.fromAccountId, rev.migration.toAccountId], [newId, oldId]);
  await api("PATCH", `/migrations/${migrationId}`, { status: "paused" });
  await withImap(NEW, async (c) => c.append("INBOX", await mail("While paused"), []));
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 0, "paused: no copying");
  await assert.rejects(api("POST", `/migrations/${migrationId}/run`), /Resume/);
  await api("PATCH", `/migrations/${migrationId}`, { status: "active" });
  assert.equal((await deps.migrations.runPass(migrationId)).copied, 1);
  assert.ok((await subjects(OLD, "INBOX")).includes("While paused"));

  const fin = await api("PATCH", `/migrations/${migrationId}`, { status: "finished" });
  assert.equal(fin.migration.status, "finished");
  assert.ok(
    !(await deps.migrations.due(0)).includes(migrationId),
    "finished migrations aren't scheduled",
  );
  await api("DELETE", `/migrations/${migrationId}`);
  assert.equal((await api("GET", "/migrations")).migrations.length, 0);
});

test("login and server settings can be changed after a password or server move", async (t) => {
  if (skip()) return t.skip(skip() as string);
  // (Unreachable ports stand in for bad settings: GreenMail leaks a busy thread for every
  // failed login, which would slow every later test.)
  const unreachable = { ...imapConfig(NEW), imap: { host: "127.0.0.1", port: 1, secure: false } };
  // New settings that don't work are tested first and refused; nothing is saved.
  await assert.rejects(api("PATCH", `/accounts/${newId}`, { config: unreachable }), /422/);
  // …unless saved without testing (e.g. the server is briefly down).
  const untested = await api("PATCH", `/accounts/${newId}`, {
    config: unreachable,
    skipTest: true,
  });
  assert.match(untested.account.statusMessage, /without testing/);
  await assert.rejects(deps.sync.syncAccount(newId), "the unreachable server is what's stored now");

  // The server's address changed; the password field is left blank, so the saved one is kept.
  const moved = await api("PATCH", `/accounts/${newId}`, {
    config: { ...imapConfig(NEW, "localhost"), password: "" },
  });
  assert.equal(moved.account.config.imap.host, "localhost");
  assert.equal(moved.account.config.password, undefined, "password never sent back");
  assert.equal(moved.account.status, "pending");
  const r = await deps.sync.syncAccount(newId);
  assert.ok(!r.skipped);
  const { accounts } = await api("GET", "/accounts");
  assert.equal(accounts.find((a: { id: string }) => a.id === newId).status, "ok");
});
