import type { JsonSchema } from "./api";

export type Obj = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Obj)[k] : undefined), obj);
}

export function setPath<T extends Obj>(obj: T, path: string, value: unknown): T {
  const out = structuredClone(obj);
  const keys = path.split(".");
  let o: Obj = out;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Obj;
  }
  o[keys.at(-1) as string] = value;
  return out;
}

/** Fill defaults from a JSON schema (recursively). */
export function defaultsFromSchema(schema: JsonSchema): Obj {
  const out: Obj = {};
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (s.type === "object") out[k] = defaultsFromSchema(s);
    else if (s.default !== undefined) out[k] = s.default;
  }
  return out;
}

/** Deep merge b into a. */
export function merge(a: Obj, b: Obj): Obj {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object"
        ? merge(out[k] as Obj, v as Obj)
        : v;
  }
  return out;
}

/** Replace "{domain}" placeholders in preset values with the email's domain. */
export function fillDomain(value: Obj, domain: string): Obj {
  return JSON.parse(JSON.stringify(value).replaceAll("{domain}", domain)) as Obj;
}

export const humanize = (key: string) =>
  key
    .split(".")
    .at(-1)!
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase());
