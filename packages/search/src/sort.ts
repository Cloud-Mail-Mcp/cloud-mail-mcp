import { type SQL, sql } from "@cloud-mail-mcp/db";

export type SortField = "date" | "from" | "subject";
export type SortOrder = "asc" | "desc";
export interface Sort {
  field: SortField;
  order: SortOrder;
}
export const DEFAULT_SORT: Sort = { field: "date", order: "desc" };
export const SORT_FIELDS: SortField[] = ["date", "from", "subject"];

/**
 * Sort key for text sorts. Subjects ignore reply/forward prefixes ("Re: Re: Fwd: Budget" sorts as
 * "budget"); empty values become NULL so they always sort last.
 */
export function sortKey(field: Exclude<SortField, "date">, m = "m"): SQL {
  const t = sql.raw(m);
  if (field === "from") return sql`nullif(lower(${t}.from_email), '')`;
  return sql`nullif(lower(regexp_replace(coalesce(${t}.subject, ''), '^\\s*((re|fwd?|aw|wg|sv|antw)(\\[\\d+\\])?\\s*:\\s*)+', '', 'i')), '')`;
}

export const dir = (o: SortOrder) => sql.raw(o === "asc" ? "ASC" : "DESC");

/**
 * Cursors: date sorts use keyset paging ("d:<iso>|<id>", fast at any depth); text sorts use
 * an offset ("o:<n>"). Cursors without a prefix are the original date format.
 */
export type Cursor = { kind: "key"; date: Date; id: number } | { kind: "offset"; offset: number };

export function decodeCursor(c?: string): Cursor | undefined {
  if (!c) return undefined;
  if (c.startsWith("o:")) return { kind: "offset", offset: Math.max(0, Number(c.slice(2)) || 0) };
  const [d, id] = (c.startsWith("d:") ? c.slice(2) : c).split("|");
  const date = new Date(d ?? "");
  if (Number.isNaN(date.getTime()) || !Number.isFinite(Number(id))) return undefined;
  return { kind: "key", date, id: Number(id) };
}

export const keyCursor = (date: Date, id: number) => `d:${date.toISOString()}|${id}`;
export const offsetCursor = (n: number) => `o:${n}`;

export function parseSort(field?: string, order?: string): Sort {
  const f = SORT_FIELDS.includes(field as SortField) ? (field as SortField) : "date";
  const o: SortOrder = order === "asc" || order === "desc" ? order : f === "date" ? "desc" : "asc";
  return { field: f, order: o };
}
