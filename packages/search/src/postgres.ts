import { type Db, pgArray, type SQL, sql } from "@cloud-mail-mcp/db";
import type { ParsedQuery } from "./query";
import {
  DEFAULT_SORT,
  decodeCursor,
  dir,
  keyCursor,
  offsetCursor,
  type Sort,
  sortKey,
} from "./sort";
import type { MailDoc, SearchHit, SearchIndex, SearchScope } from "./types";

const BODY_LIMIT = 100_000;

/** Turn free-text terms into a prefix-matching tsquery: invoic → 'invoic':* */
export function toTsQuery(terms: string[]): string | null {
  const lexemes = terms
    .flatMap((t) => t.toLowerCase().split(/[^\p{L}\p{N}@._-]+/u))
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `'${t.replace(/'/g, "''")}':*`);
  return lexemes.length ? lexemes.join(" & ") : null;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Search driver backed by Postgres full-text search on `messages.search_tsv`.
 * No extra services; fine for a few million messages. OpenSearch driver comes in v0.2.
 */
export class PostgresSearchIndex implements SearchIndex {
  readonly driver = "postgres";
  constructor(private db: Db) {}

  async upsert(docs: MailDoc[]): Promise<void> {
    if (!docs.length) return;
    const col = <T>(f: (d: MailDoc) => T) => docs.map(f);
    await this.db.execute(sql`
      UPDATE messages m SET search_tsv =
          setweight(to_tsvector('simple', coalesce(d.subject, '')), 'A')
       || setweight(to_tsvector('simple', coalesce(d.sender, '')), 'B')
       || setweight(to_tsvector('simple', coalesce(d.recipients, '')), 'C')
       || setweight(to_tsvector('simple', coalesce(d.body, '')), 'D')
      FROM (
        SELECT unnest(${pgArray(
          col((d) => d.accountId),
          "uuid",
        )}) AS account_id,
               unnest(${pgArray(
                 col((d) => d.messageId),
                 "bigint",
               )}) AS id,
               unnest(${pgArray(
                 col((d) => d.subject ?? ""),
                 "text",
               )}) AS subject,
               unnest(${pgArray(
                 col((d) => d.from ?? ""),
                 "text",
               )}) AS sender,
               unnest(${pgArray(
                 col((d) => [...d.to, ...d.cc].join(" ")),
                 "text",
               )}) AS recipients,
               unnest(${pgArray(
                 col(
                   (d) =>
                     `${(d.bodyText ?? "").slice(0, BODY_LIMIT)} ${d.attachmentNames.join(" ")}`,
                 ),
                 "text",
               )}) AS body
      ) d
      WHERE m.account_id = d.account_id AND m.id = d.id`);
  }

  async delete(): Promise<void> {
    // Rows are deleted with their message; nothing separate to remove.
  }

  async deleteAccount(): Promise<void> {}

  async search(
    q: ParsedQuery,
    scope: SearchScope,
    page: { limit: number; cursor?: string; sort?: Sort },
  ): Promise<{ hits: SearchHit[]; nextCursor?: string }> {
    const sort = page.sort ?? DEFAULT_SORT;
    const cursor = decodeCursor(page.cursor);
    if (!scope.accountIds.length) return { hits: [] };
    const limit = Math.min(Math.max(page.limit, 1), 200);
    const conds: SQL[] = [];

    const tsq = toTsQuery(q.text);
    if (tsq) conds.push(sql`m.search_tsv @@ to_tsquery('simple', ${tsq})`);
    for (const f of q.from)
      conds.push(sql`(m.from_email ILIKE ${like(f)} OR m.from_name ILIKE ${like(f)})`);
    for (const s of q.subject) conds.push(sql`m.subject ILIKE ${like(s)}`);
    for (const t of q.to) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM message_addresses ma JOIN addresses a ON a.id = ma.address_id
        WHERE ma.account_id = m.account_id AND ma.message_id = m.id
          AND ma.role IN ('to','cc','bcc') AND (a.email ILIKE ${like(t)} OR a.name ILIKE ${like(t)}))`);
    }
    if (q.after) conds.push(sql`m.date >= ${q.after.toISOString()}::timestamptz`);
    if (q.before) conds.push(sql`m.date < ${q.before.toISOString()}::timestamptz`);
    if (q.hasAttachment) conds.push(sql`m.has_attachments`);
    if (q.isUnread === true) conds.push(sql`NOT m.seen`);
    if (q.isUnread === false) conds.push(sql`m.seen`);
    if (q.isFlagged) conds.push(sql`m.flagged`);
    if (q.tags.length) conds.push(sql`m.tags @> ${pgArray(q.tags, "text")}`);

    // Folder filters: the agent's allowed folders (scope) and any `in:` operator.
    const folderConds: SQL[] = [];
    if (scope.folderIds) {
      const allowed = Object.entries(scope.folderIds);
      // Accounts not listed in folderIds keep access to all folders.
      folderConds.push(
        sql`(${sql.join(
          [
            sql`NOT (m.account_id = ANY(${pgArray(
              allowed.map(([a]) => a),
              "uuid",
            )}))`,
            ...allowed.map(
              ([a, ids]) =>
                sql`(m.account_id = ${a}::uuid AND mf.folder_id = ANY(${pgArray(ids, "bigint")}))`,
            ),
          ],
          sql` OR `,
        )})`,
      );
    }
    for (const name of q.in) {
      folderConds.push(sql`EXISTS (SELECT 1 FROM folders f WHERE f.id = mf.folder_id
        AND (lower(f.path) = ${name} OR f.role::text = ${name}))`);
    }
    if (folderConds.length) {
      conds.push(sql`EXISTS (SELECT 1 FROM message_folders mf
        WHERE mf.account_id = m.account_id AND mf.message_id = m.id AND ${sql.join(folderConds, sql` AND `)})`);
    }

    if (sort.field === "date" && cursor?.kind === "key") {
      const cmp = sql.raw(sort.order === "asc" ? ">" : "<");
      conds.push(
        sql`(m.date, m.id) ${cmp} (${cursor.date.toISOString()}::timestamptz, ${cursor.id})`,
      );
    }
    const where = conds.length ? sql`AND ${sql.join(conds, sql` AND `)}` : sql``;
    type Row = { account_id: string; id: string | number; date: string | Date };
    const toHits = (rows: Row[]) =>
      rows
        .slice(0, limit)
        .map((r) => ({ accountId: r.account_id, messageId: Number(r.id), date: new Date(r.date) }));

    if (sort.field === "date") {
      // Per-account top-N then merge (docs/SPEC.md §4a): never `account_id = ANY(...) ORDER BY date`.
      const d = dir(sort.order);
      const rows = (await this.db.execute(sql`
        SELECT r.account_id, r.id, r.date FROM unnest(${pgArray(scope.accountIds, "uuid")}) AS acc(id)
        CROSS JOIN LATERAL (
          SELECT m.account_id, m.id, m.date FROM messages m
          WHERE m.account_id = acc.id ${where}
          ORDER BY m.date ${d}, m.id ${d} LIMIT ${limit + 1}
        ) r
        ORDER BY r.date ${d}, r.id ${d} LIMIT ${limit + 1}`)) as unknown as Row[];
      const hits = toHits(rows);
      const last = hits.at(-1);
      return {
        hits,
        nextCursor: rows.length > limit && last ? keyCursor(last.date, last.messageId) : undefined,
      };
    }

    // Sender / subject: one ordered query with offset paging (results are already filtered).
    const offset = cursor?.kind === "offset" ? cursor.offset : 0;
    const rows = (await this.db.execute(sql`
      SELECT m.account_id, m.id, m.date FROM messages m
      WHERE m.account_id = ANY(${pgArray(scope.accountIds, "uuid")}) ${where}
      ORDER BY ${sortKey(sort.field)} ${dir(sort.order)} NULLS LAST, m.date DESC, m.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`)) as unknown as Row[];
    return {
      hits: toHits(rows),
      nextCursor: rows.length > limit ? offsetCursor(offset + limit) : undefined,
    };
  }
}
