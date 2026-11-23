import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptJson, encryptJson, newDataKey, unwrapDataKey } from "./crypto";

test("envelope encryption round-trip, bound to account id", () => {
  const master = randomBytes(32);
  const { dataKey, wrapped } = newDataKey(master, "acct-1");
  assert.deepEqual(unwrapDataKey(master, wrapped, "acct-1"), dataKey);
  assert.throws(
    () => unwrapDataKey(master, wrapped, "acct-2"),
    "wrapped key must not move accounts",
  );

  const sealed = encryptJson(dataKey, { password: "hunter2" }, "acct-1");
  assert.ok(!sealed.includes(Buffer.from("hunter2")));
  assert.deepEqual(decryptJson(dataKey, sealed, "acct-1"), { password: "hunter2" });
});
