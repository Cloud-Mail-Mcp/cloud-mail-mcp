import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChecks } from "./checks";

const msg = (headers: string) => Buffer.from(`${headers}\r\nSubject: hi\r\n\r\nbody`);

test("Authentication-Results: the topmost header counts", () => {
  const c = parseChecks(
    msg(
      [
        "Authentication-Results: mx.example.net; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=shop.example; dmarc=pass header.from=shop.example",
        // Added further down (could be written by the sender): ignored.
        "Authentication-Results: evil.example; dmarc=fail",
      ].join("\r\n"),
    ),
  );
  assert.equal(c?.dmarc, "pass");
  assert.equal(c?.verdict, "verified");
});

test("a failed DMARC check is suspicious", () => {
  const c = parseChecks(
    msg("Authentication-Results: mx.example.net; spf=softfail; dkim=none; dmarc=fail (p=REJECT)"),
  );
  assert.equal(c?.verdict, "suspicious");
  assert.equal(c?.spf, "softfail");
});

test("SpamAssassin and Rspamd scores", () => {
  const sa = parseChecks(msg("X-Spam-Status: Yes, score=7.1 required=5.0 tests=BAYES_99"));
  assert.deepEqual(
    [sa?.spamScore, sa?.spamThreshold, sa?.spamFlag, sa?.verdict],
    [7.1, 5, true, "spam"],
  );
  const rs = parseChecks(msg("X-Spamd-Result: default: False [1.20 / 15.00]; R_SPF_ALLOW(-0.2)"));
  assert.deepEqual([rs?.spamScore, rs?.spamThreshold, rs?.verdict], [1.2, 15, "unknown"]);
  assert.equal(parseChecks(msg("From: a@example.org")), null);
});
