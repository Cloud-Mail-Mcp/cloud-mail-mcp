import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteFolder } from "@mailmcp/module-sdk";
import { assignNameRoles } from "./roles";

const f = (path: string, role?: RemoteFolder["role"]): RemoteFolder => ({
  remoteId: path,
  path,
  delimiter: ".",
  kind: "folder",
  role,
  selectable: true,
});
const roles = (list: RemoteFolder[]) => {
  assignNameRoles(list);
  return Object.fromEntries(list.filter((x) => x.role).map((x) => [x.role, x.path]));
};

test("the usual name wins over look-alikes, whatever the order", () => {
  assert.deepEqual(
    roles([f("INBOX", "inbox"), f("Deleted Messages"), f("Sent Mail"), f("Sent"), f("Trash")]),
    { inbox: "INBOX", trash: "Trash", sent: "Sent" },
  );
});

test("look-alikes still work alone, nested under INBOX. (cPanel)", () => {
  assert.deepEqual(
    roles([
      f("INBOX", "inbox"),
      f("INBOX.Deleted Items"),
      f("INBOX.Sent Items"),
      f("INBOX.Junk E-mail"),
      f("INBOX.Archives"),
    ]),
    {
      inbox: "INBOX",
      trash: "INBOX.Deleted Items",
      sent: "INBOX.Sent Items",
      spam: "INBOX.Junk E-mail",
      archive: "INBOX.Archives",
    },
  );
});

test("roles the server declared are kept; a user folder named like one isn't promoted", () => {
  assert.deepEqual(roles([f("INBOX", "inbox"), f("Bin", "trash"), f("Projects.Trash")]), {
    inbox: "INBOX",
    trash: "Bin",
  });
});
