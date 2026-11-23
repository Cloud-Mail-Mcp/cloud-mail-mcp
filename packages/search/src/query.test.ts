import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery } from "./query";

test("parses operators, phrases and free text", () => {
  const q = parseQuery(
    'from:alice subject:"q3 invoice" has:attachment after:2026-01-01 in:INBOX is:unread budget "net 30"',
  );
  assert.deepEqual(q.from, ["alice"]);
  assert.deepEqual(q.subject, ["q3 invoice"]);
  assert.deepEqual(q.in, ["inbox"]);
  assert.equal(q.hasAttachment, true);
  assert.equal(q.isUnread, true);
  assert.equal(q.after?.toISOString().slice(0, 10), "2026-01-01");
  assert.deepEqual(q.text, ["budget", "net 30"]);
});

test("unknown operators and bad dates degrade to text / ignored", () => {
  const q = parseQuery("label:work after:notadate hello");
  assert.deepEqual(q.text, ["label:work", "hello"]);
  assert.equal(q.after, undefined);
});

import { toTsQuery } from "./postgres";

test("tsquery: prefix match, sanitized, emails kept whole", () => {
  assert.equal(toTsQuery(["Invoic", "q3"]), "'invoic':* & 'q3':*");
  assert.equal(toTsQuery(["it's"]), "'it':* & 's':*");
  assert.equal(toTsQuery(["bob@example.com"]), "'bob@example.com':*");
  assert.equal(toTsQuery(["!!!"]), null);
});
