import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { pgArray } from "./index";

test("pgArray encodes one parameter with quoting", () => {
  const q = new PgDialect().sqlToQuery(pgArray(['a"b', "c\\d", null, "e,f {g}"], "text"));
  assert.equal(q.sql, "$1::text[]");
  assert.deepEqual(q.params, ['{"a\\"b","c\\\\d",NULL,"e,f {g}"}']);
  const n = new PgDialect().sqlToQuery(pgArray([1, 2, 3], "bigint"));
  assert.deepEqual(n.params, ["{1,2,3}"]);
});
