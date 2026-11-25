import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteFolder } from "@cloud-mail-mcp/module-sdk";
import { planFolders } from "./migrate";

const f = (path: string, delimiter: string, role?: RemoteFolder["role"], selectable = true) =>
  ({ remoteId: path, path, delimiter, role, kind: "folder", selectable }) as RemoteFolder;
const map = (src: RemoteFolder[], dst: RemoteFolder[]) =>
  Object.fromEntries(planFolders(src, dst).map((p) => [p.source.path, p.targetPath]));

test("cPanel (INBOX. prefix) → plain slash server", () => {
  const src = [
    f("INBOX", "."),
    f("INBOX.Sent", ".", "sent"),
    f("INBOX.Clients", "."),
    f("INBOX.Clients.Acme", "."),
  ];
  const dst = [f("INBOX", "/"), f("Sent Items", "/", "sent"), f("Archive", "/", "archive")];
  assert.deepEqual(map(src, dst), {
    INBOX: "INBOX",
    "INBOX.Sent": "Sent Items",
    "INBOX.Clients": "Clients",
    "INBOX.Clients.Acme": "Clients/Acme",
  });
});

test("plain server → cPanel keeps the INBOX. prefix and reuses existing folders", () => {
  const src = [f("INBOX", "/"), f("Projects/2025", "/"), f("Trash", "/", "trash")];
  const dst = [
    f("INBOX", "."),
    f("INBOX.Trash", ".", "trash"),
    f("INBOX.projects", "."),
    f("INBOX.Sent", ".", "sent"),
  ];
  assert.deepEqual(map(src, dst), {
    INBOX: "INBOX",
    "Projects/2025": "INBOX.Projects.2025",
    Trash: "INBOX.Trash",
  });
  const existing = planFolders([f("Projects", "/")], dst)[0]!;
  assert.deepEqual([existing.targetPath, existing.targetExists], ["INBOX.projects", true]);
});

test("Gmail: All Mail → Archive (last), views skipped, [Gmail] prefix dropped", () => {
  const src = [
    f("INBOX", "/", "inbox"),
    f("[Gmail]", "/", undefined, false),
    f("[Gmail]/All Mail", "/", "all"),
    f("[Gmail]/Important", "/", "important"),
    f("[Gmail]/Starred", "/", "starred"),
    f("[Gmail]/Sent Mail", "/", "sent"),
    f("[Gmail]/Notes", "/"),
    f("[Gmail]/Important", "/"), // not flagged by every server: skipped by name too
    f("Receipts", "/"),
  ];
  const dst = [f("INBOX", "."), f("Sent", ".", "sent")];
  assert.deepEqual(map(src, dst), {
    INBOX: "INBOX",
    "[Gmail]/Sent Mail": "Sent",
    "[Gmail]/Notes": "Notes",
    Receipts: "Receipts",
    "[Gmail]/All Mail": "Archive",
  });
  const plan = planFolders(src, dst);
  assert.equal(plan.at(-1)?.source.path, "[Gmail]/All Mail", "All Mail goes last");
  assert.equal(plan.at(-1)?.archiveOnly, true);
  // An existing archive folder on the target is used.
  const cp = planFolders(src, [f("INBOX", "."), f("INBOX.Archive", ".", "archive")]);
  assert.equal(cp.at(-1)?.targetPath, "INBOX.Archive");
});

test("a target separator inside a source name doesn't create extra levels", () => {
  assert.deepEqual(map([f("v1.2 notes", "/")], [f("INBOX", "."), f("Sent", ".")]), {
    "v1.2 notes": "v1-2 notes",
  });
});
