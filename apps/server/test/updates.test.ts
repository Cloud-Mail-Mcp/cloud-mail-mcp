import assert from "node:assert/strict";
import { test } from "node:test";
import { newerThan } from "../src/updates";

test("version comparison for update checks", () => {
  assert.equal(newerThan("v0.2.0", "0.1.9"), true);
  assert.equal(newerThan("0.10.0", "0.9.0"), true, "numeric, not lexical");
  assert.equal(newerThan("v1.0.0", "1.0.0"), false, "same version");
  assert.equal(newerThan("0.1.0", "0.1.1"), false, "older");
  assert.equal(newerThan("v0.2.0", "0.2.0-dev"), false, "pre-release suffix ignored");
  assert.equal(newerThan("1.2", "1.1.9"), true, "missing parts count as 0");
});
