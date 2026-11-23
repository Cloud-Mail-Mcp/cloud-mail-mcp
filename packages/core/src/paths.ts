/** Read/write values in nested config objects by dot path ("imap.host"). */
export function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1] as string] = value;
}

export function deletePath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  const parent = getPath(obj, keys.slice(0, -1).join("."));
  if (keys.length === 1) delete obj[keys[0] as string];
  else if (parent && typeof parent === "object")
    delete (parent as Record<string, unknown>)[keys.at(-1) as string];
}

export const clone = <T>(v: T): T => structuredClone(v);
