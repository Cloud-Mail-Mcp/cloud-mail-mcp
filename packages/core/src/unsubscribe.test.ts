import assert from "node:assert/strict";
import { test } from "node:test";
import { oneClickUnsubscribe, parseUnsubscribe, unsubscribeMethod } from "./unsubscribe";

const msg = (headers: string) =>
  Buffer.from(
    `From: a@example.com\r\nSubject: Hi\r\n${headers}\r\n\r\nList-Unsubscribe: <https://body.example/x>\r\n`,
  );

test("no List-Unsubscribe header: nothing to do", () => {
  assert.equal(parseUnsubscribe(msg("X-Other: 1")), null);
  assert.equal(unsubscribeMethod(null), null);
});

test("one-click needs https plus List-Unsubscribe-Post", () => {
  const u = parseUnsubscribe(
    msg(
      "List-Unsubscribe: <mailto:leave@list.example?subject=unsubscribe%20me>,\r\n <https://list.example/u/123>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click",
    ),
  );
  assert.deepEqual(u, {
    oneClick: "https://list.example/u/123",
    mailto: { to: "leave@list.example", subject: "unsubscribe me", body: null },
    web: "https://list.example/u/123",
  });
  assert.equal(unsubscribeMethod(u), "one_click");

  const noPost = parseUnsubscribe(msg("List-Unsubscribe: <https://list.example/u/123>"));
  assert.deepEqual(noPost, { oneClick: null, mailto: null, web: "https://list.example/u/123" });
  assert.equal(unsubscribeMethod(noPost), "website");

  const http = parseUnsubscribe(
    msg(
      "List-Unsubscribe: <http://list.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click",
    ),
  );
  assert.equal(http?.oneClick, null, "plain http is never one-click");
});

test("email before web page; header in the body is ignored; junk skipped", () => {
  const u = parseUnsubscribe(
    msg("List-Unsubscribe: <mailto:bad address>, <javascript:alert(1)>, <mailto:Out@List.Example>"),
  );
  assert.deepEqual(u?.mailto, { to: "out@list.example", subject: null, body: null });
  assert.equal(unsubscribeMethod(u), "email");
  assert.equal(parseUnsubscribe(msg("X-A: b")), null, "only the header block counts");
});

test("mailto subject can't inject headers", () => {
  const u = parseUnsubscribe(
    msg("List-Unsubscribe: <mailto:x@list.example?subject=a%0D%0ABcc:%20v@evil.example>"),
  );
  assert.equal(u?.mailto?.subject, "a Bcc: v@evil.example");
});

test("one-click refuses non-https and private hosts", async () => {
  await assert.rejects(oneClickUnsubscribe("http://list.example/u"), /isn't https/);
  await assert.rejects(oneClickUnsubscribe("https://127.0.0.1/u"), /private or unknown host/);
  await assert.rejects(oneClickUnsubscribe("https://[::1]/u"), /private or unknown host/);
  await assert.rejects(oneClickUnsubscribe("https://10.1.2.3/u"), /private or unknown host/);
});
