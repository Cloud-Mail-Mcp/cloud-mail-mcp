import { headerFields } from "./unsubscribe";

/**
 * What the receiving mail server said about a message: sender checks (SPF, DKIM, DMARC) from
 * its Authentication-Results header, and a spam score from SpamAssassin or Rspamd headers.
 *
 * Only the topmost header of each kind is read: that's the one the person's own mail server
 * added. Lower ones can be written by anyone, including the sender.
 */
export interface MessageChecks {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  spamScore: number | null;
  spamThreshold: number | null;
  /** The server itself flagged it as spam. */
  spamFlag: boolean;
  /**
   * verified: the sender's domain is confirmed (DMARC, or SPF and DKIM pass).
   * suspicious: a check failed: the sender may not be who they claim.
   * spam: the server's spam filter flagged it.
   * unknown: the server didn't say.
   */
  verdict: "verified" | "suspicious" | "spam" | "unknown";
}

const RESULT = (name: string, value: string) => {
  const all = [...value.matchAll(new RegExp(`\\b${name}=([a-z]+)`, "gi"))].map((m) =>
    (m[1] as string).toLowerCase(),
  );
  if (!all.length) return null;
  // Several DKIM signatures: one passing is enough.
  return all.includes("pass") ? "pass" : (all[0] as string);
};

const num = (s: string | undefined) => {
  if (s === undefined) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

export function parseChecks(raw: Buffer): MessageChecks | null {
  const h = headerFields(raw);
  const first = (name: string) => h.get(name)?.[0];
  const auth = first("authentication-results") ?? first("arc-authentication-results");
  const spf = auth ? RESULT("spf", auth) : first("received-spf")?.split(/\s/)[0]?.toLowerCase();
  const dkim = auth ? RESULT("dkim", auth) : null;
  const dmarc = auth ? RESULT("dmarc", auth) : null;

  let spamScore: number | null = null;
  let spamThreshold: number | null = null;
  let spamFlag = false;
  // SpamAssassin: "Yes, score=7.1 required=5.0 tests=…"
  const status = first("x-spam-status");
  if (status) {
    spamFlag = /^\s*yes\b/i.test(status);
    spamScore = num(status.match(/score=(-?[\d.]+)/i)?.[1]);
    spamThreshold = num(status.match(/required=(-?[\d.]+)/i)?.[1]);
  }
  if (/^\s*yes\b/i.test(first("x-spam-flag") ?? "") || /^\s*yes\b/i.test(first("x-spam") ?? ""))
    spamFlag = true;
  spamScore ??= num(first("x-spam-score") ?? first("x-rspamd-score"));
  // Rspamd: "default: False [1.20 / 15.00]; …"
  const rspamd = first("x-spamd-result");
  if (rspamd) {
    const m = rspamd.match(/:\s*(true|false)\s*\[\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\]/i);
    if (m) {
      spamFlag ||= (m[1] as string).toLowerCase() === "true";
      spamScore ??= num(m[2]);
      spamThreshold ??= num(m[3]);
    }
  }

  if (!spf && !dkim && !dmarc && spamScore === null && !spamFlag) return null;
  const overThreshold = spamScore !== null && spamThreshold !== null && spamScore >= spamThreshold;
  const failed = (v: string | null | undefined) => v === "fail" || v === "softfail";
  const verdict: MessageChecks["verdict"] =
    spamFlag || overThreshold
      ? "spam"
      : failed(dmarc) || (failed(spf) && dkim !== "pass")
        ? "suspicious"
        : dmarc === "pass" || (spf === "pass" && dkim === "pass")
          ? "verified"
          : "unknown";
  return {
    spf: spf ?? null,
    dkim,
    dmarc,
    spamScore,
    spamThreshold,
    spamFlag,
    verdict,
  };
}
