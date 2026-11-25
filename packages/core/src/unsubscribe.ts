import { publicHost } from "./net";

/**
 * How a mailing list lets you leave, from its List-Unsubscribe (RFC 2369) and
 * List-Unsubscribe-Post (RFC 8058) headers. Values come from the sender: untrusted.
 */
export interface UnsubscribeInfo {
  /** https URL that unsubscribes with a single POST (RFC 8058 one-click). */
  oneClick: string | null;
  /** Address (and optional subject/body) to email to unsubscribe. */
  mailto: { to: string; subject: string | null; body: string | null } | null;
  /** Web page where a person finishes unsubscribing. */
  web: string | null;
}

export type UnsubscribeMethod = "one_click" | "email" | "website";

/** Preferred way to unsubscribe: one click, then email, then a web page. */
export function unsubscribeMethod(u: UnsubscribeInfo | null): UnsubscribeMethod | null {
  if (!u) return null;
  if (u.oneClick) return "one_click";
  if (u.mailto) return "email";
  if (u.web) return "website";
  return null;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Raw header block → lowercased name → unfolded values. Stops at the first blank line. */
export function headerFields(raw: Buffer): Map<string, string[]> {
  const head = raw.subarray(0, 256 * 1024).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out = new Map<string, string[]>();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return out;
}

function parseMailto(uri: string): UnsubscribeInfo["mailto"] {
  const q = uri.indexOf("?");
  let to: string;
  try {
    to = decodeURIComponent(uri.slice("mailto:".length, q === -1 ? undefined : q)).trim();
  } catch {
    return null;
  }
  if (!EMAIL.test(to)) return null;
  const params = new URLSearchParams(q === -1 ? "" : uri.slice(q + 1));
  const clip = (v: string | null, n: number) => (v ? v.replace(/\0/g, "").slice(0, n) : null);
  return {
    to: to.toLowerCase(),
    subject: clip(params.get("subject"), 200)?.replace(/[\r\n]+/g, " ") ?? null,
    body: clip(params.get("body"), 1000),
  };
}

/** Read the unsubscribe options from a raw message, or null if it has none. */
export function parseUnsubscribe(raw: Buffer): UnsubscribeInfo | null {
  const h = headerFields(raw);
  const list = h.get("list-unsubscribe")?.join(",");
  if (!list) return null;
  const oneClickPost = (h.get("list-unsubscribe-post") ?? []).some((v) =>
    /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(v),
  );
  const info: UnsubscribeInfo = { oneClick: null, mailto: null, web: null };
  for (const [, uri] of list.matchAll(/<\s*([^>]+?)\s*>/g)) {
    const u = (uri ?? "").replace(/\s+/g, "");
    if (/^mailto:/i.test(u)) {
      info.mailto ??= parseMailto(u);
      continue;
    }
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (url.protocol === "https:" && oneClickPost) info.oneClick ??= url.href;
    else if (url.protocol === "https:" || url.protocol === "http:") info.web ??= url.href;
  }
  // A one-click link also works as a web page if there's no other.
  if (info.oneClick && !info.web) info.web = info.oneClick;
  return info.oneClick || info.mailto || info.web ? info : null;
}

/**
 * Do an RFC 8058 one-click unsubscribe: POST `List-Unsubscribe=One-Click` to the link.
 * Refuses non-https and non-public hosts, doesn't follow redirects, and doesn't send cookies.
 */
export async function oneClickUnsubscribe(link: string): Promise<void> {
  const url = new URL(link);
  if (url.protocol !== "https:") throw new Error("The unsubscribe link isn't https.");
  if (!(await publicHost(url)))
    throw new Error("The unsubscribe link points to a private or unknown host.");
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Cloud Mail MCP (List-Unsubscribe one-click)",
      },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const err = e as Error;
    throw new Error(
      err.name === "TimeoutError"
        ? "The sender's unsubscribe server didn't answer."
        : `Couldn't reach the sender's unsubscribe server: ${err.message}`,
    );
  }
  await r.body?.cancel().catch(() => {});
  if (r.status >= 400)
    throw new Error(`The sender's unsubscribe server refused the request (HTTP ${r.status}).`);
}
