import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function privateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return (
      v === "::1" ||
      v === "::" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe80") ||
      v.startsWith("::ffff:")
    );
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/**
 * True when every address `url`'s host resolves to is public. Guards server-side requests to
 * URLs that came from outside (client metadata documents, unsubscribe links) against SSRF.
 */
export async function publicHost(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && !addrs.some((a) => privateAddress(a.address));
  } catch {
    return false;
  }
}
