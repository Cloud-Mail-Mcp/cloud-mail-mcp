/**
 * Integration test: sync engine against the GreenMail dev server (docker compose --profile testmail).
 * Skips automatically if GreenMail or Postgres isn't reachable.
 *   pnpm --filter @mailmcp/worker test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServices, runtime, type Services } from "@mailmcp/core";
import { and, count, createDb, eq, folders, messageFolders, messages, orgs } from "@mailmcp/db";
import { prepareTestDatabase } from "@mailmcp/db/testing";
import imapModule from "@mailmcp/module-imap";
import type { ModuleManifest } from "@mailmcp/module-sdk";
import { parseQuery } from "@mailmcp/search";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const USER = "bob@example.test";
const PASS = "bob-pass-456";
const reachable = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect(port, "127.0.0.1", () => {
      s.destroy();
      res(true);
    }).on("error", () => res(false));
  });
const up = (await reachable(3143)) && (await reachable(5433));

let svc: Services;
let close: () => Promise<void>;
let imap: ImapFlow;
let orgId: string;
let accountId: string;

const mail = (i: number, extra: Record<string, unknown> = {}) =>
  new MailComposer({
    messageId: `<itest-${i}-${randomUUID()}@example.test>`,
    date: new Date(Date.now() - (100 - i) * 3_600_000),
    from: { name: `Sender ${i}`, address: `sender${i}@example.test` },
    to: USER,
    subject: `Integration message ${i}`,
    text: `Body of message ${i}.`,
    ...extra,
  })
    .compile()
    .build();

async function clearMailbox() {
  for (const f of await imap.list()) {
    if (f.flags.has("\\Noselect")) continue;
    const lock = await imap.getMailboxLock(f.path);
    try {
      if ((imap.mailbox as { exists: number }).exists > 0) await imap.messageDelete("1:*");
    } finally {
      lock.release();
    }
  }
}

/** Sync, waiting if another process (e.g. a running worker) holds the account's sync lease. */
async function syncNow(id: string, opts: { bodyBudgetMs?: number } = {}) {
  for (let i = 0; i < 120; i++) {
    const r = await svc.sync.syncAccount(id, opts);
    if (!r.skipped) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("sync lease never became free");
}

const local = async (path: string) => {
  const [r] = await svc.db
    .select({ n: count() })
    .from(messageFolders)
    .innerJoin(folders, eq(folders.id, messageFolders.folderId))
    .where(and(eq(folders.accountId, accountId), eq(folders.path, path)));
  return r?.n ?? 0;
};

before(async () => {
  if (!up) return;
  const testUrl = await prepareTestDatabase(runtime.databaseUrl);
  const d = createDb(testUrl);
  close = d.close;
  svc = createServices({
    db: d.db,
    masterKey: Buffer.alloc(32, 7),
    modules: [imapModule as unknown as ModuleManifest],
    dataDir: join(tmpdir(), "mailmcp-itest"),
    databaseUrl: testUrl,
  });
  imap = new ImapFlow({
    host: "127.0.0.1",
    port: 3143,
    secure: false,
    auth: { user: USER, pass: PASS },
    logger: false,
  });
  await imap.connect();
  await clearMailbox();
  await imap.mailboxCreate("Archive").catch(() => {});
  for (let i = 0; i < 20; i++) await imap.append("INBOX", await mail(i), i < 5 ? ["\\Seen"] : []);
  await imap.append(
    "INBOX",
    await mail(99, {
      subject: "Quarterly notes",
      text: "The zebrafish migration plan is attached.",
    }),
  );

  const [org] = await svc.db
    .insert(orgs)
    .values({ name: `itest-${randomUUID()}` })
    .returning();
  orgId = org!.id;
  const acc = await svc.accounts.create(orgId, randomUUID(), {
    moduleId: "imap",
    address: USER,
    config: {
      imap: { host: "127.0.0.1", port: 3143, secure: false },
      smtp: { host: "127.0.0.1", port: 3025, secure: false },
      username: USER,
      password: PASS,
    },
  });
  accountId = acc.id;
});

after(async () => {
  if (!up) return;
  try {
    // Real removal path (also clears message_addresses / attachments / blobs).
    if (accountId) await svc.accounts.remove(orgId, randomUUID(), accountId);
    await svc.db.delete(orgs).where(eq(orgs.id, orgId));
  } finally {
    await imap.logout().catch(() => {});
    imap.close();
    await svc.pool.closeAll();
    await close();
  }
});

test("first sync indexes every message, newest first, with flags", {
  skip: !up && "GreenMail/Postgres not running",
}, async () => {
  await syncNow(accountId, { bodyBudgetMs: 0 });
  assert.equal(await local("INBOX"), 21);
  const [unread] = await svc.db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.seen, false)));
  assert.equal(unread?.n, 16);
});

test("incremental sync: new mail, read elsewhere, deleted, moved", {
  skip: !up && "GreenMail/Postgres not running",
}, async () => {
  for (let i = 20; i < 23; i++) await imap.append("INBOX", await mail(i));
  const lock = await imap.getMailboxLock("INBOX");
  try {
    await imap.messageFlagsAdd("6:7", ["\\Seen"]); // read in another client
    await imap.messageDelete("1:4"); // deleted in another client
    await imap.messageMove("1:2", "Archive"); // (seq renumbered after expunge)
  } finally {
    lock.release();
  }
  await syncNow(accountId, { bodyBudgetMs: 0 });
  assert.equal(await local("INBOX"), 21 + 3 - 4 - 2, "INBOX count after changes");
  assert.equal(await local("Archive"), 2, "moved messages appear in Archive");
  const [total] = await svc.db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.accountId, accountId));
  assert.equal(total?.n, 20, "deleted messages are gone, moved ones are not duplicated");
  const [unread] = await svc.db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.seen, false)));
  // Invariant: local unread count equals the server's, across both folders.
  const status = await imap.status("INBOX", { unseen: true });
  const archive = await imap.status("Archive", { unseen: true });
  assert.equal(
    unread?.n,
    (status.unseen ?? 0) + (archive.unseen ?? 0),
    "unread state matches server",
  );
});

test("bodies: downloaded in batch, searchable by body text", {
  skip: !up && "GreenMail/Postgres not running",
}, async () => {
  const before = await svc.search.search(
    parseQuery("zebrafish"),
    { accountIds: [accountId] },
    { limit: 10 },
  );
  assert.equal(before.hits.length, 0, "body text not searchable before download");
  await syncNow(accountId, { bodyBudgetMs: 30_000 });
  const [pending] = await svc.db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.bodyState, "none")));
  assert.equal(pending?.n, 0, "all bodies downloaded");
  const hit = await svc.search.search(
    parseQuery("zebrafish"),
    { accountIds: [accountId] },
    { limit: 10 },
  );
  assert.equal(hit.hits.length, 1);
  const subj = await svc.search.search(
    parseQuery('subject:"integration message" is:unread'),
    { accountIds: [accountId] },
    { limit: 50 },
  );
  assert.ok(subj.hits.length > 0, "operator search works");
  const none = await svc.search.search(
    parseQuery("zebrafish"),
    { accountIds: [randomUUID()] },
    { limit: 10 },
  );
  assert.equal(none.hits.length, 0, "scope excludes other accounts");
});
