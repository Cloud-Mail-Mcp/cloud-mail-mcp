import { aiUsage, and, type Db, eq, gte, sql } from "@cloud-mail-mcp/db";

/**
 * Anthropic list prices in US dollars per million tokens (November 2026). Cache writes cost 1.25×
 * the input price. Haiku 5.5 is priced higher for prompts over 100K tokens. Costs shown in the
 * app are estimates from these prices; the Anthropic invoice is what counts.
 */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}
const PRICES: Record<string, Price & { over100k?: Price }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    over100k: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
};
export const PRICES_AS_OF = "2026-11";

export type AiFeature = "sorter" | "chat";

/** The `usage` block of an Anthropic Messages API response. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Estimated cost of one API call, in millionths of a dollar (null: unknown model). */
export function costMicros(model: string, u: ApiUsage): number | null {
  const base = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  if (!base) return null;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const prompt = u.input_tokens + read + write;
  const p = base.over100k && prompt > 100_000 ? base.over100k : base;
  // $ per million tokens × tokens = millionths of a dollar.
  return Math.round(
    u.input_tokens * p.input +
      write * p.input * 1.25 +
      read * p.cacheRead +
      u.output_tokens * p.output,
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Add one API call (or an error) to today's totals for this feature and model. */
export async function recordAiUsage(
  db: Db,
  entry: {
    feature: AiFeature;
    model: string;
    usage?: ApiUsage;
    /** Messages the sorter tagged in this call. */
    messages?: number;
    error?: string;
  },
) {
  const u = entry.usage;
  const row = {
    requests: u ? 1 : 0,
    messages: entry.messages ?? 0,
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    costMicros: u ? (costMicros(entry.model, u) ?? 0) : 0,
    errors: entry.error ? 1 : 0,
  };
  await db
    .insert(aiUsage)
    .values({
      day: today(),
      feature: entry.feature,
      model: entry.model,
      ...row,
      lastError: entry.error ?? null,
    })
    .onConflictDoUpdate({
      target: [aiUsage.day, aiUsage.feature, aiUsage.model],
      set: {
        requests: sql`${aiUsage.requests} + ${row.requests}`,
        messages: sql`${aiUsage.messages} + ${row.messages}`,
        inputTokens: sql`${aiUsage.inputTokens} + ${row.inputTokens}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${row.outputTokens}`,
        cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${row.cacheReadTokens}`,
        cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${row.cacheWriteTokens}`,
        costMicros: sql`${aiUsage.costMicros} + ${row.costMicros}`,
        errors: sql`${aiUsage.errors} + ${row.errors}`,
        ...(entry.error ? { lastError: entry.error } : {}),
      },
    });
}

/** Messages the AI sorter has tagged today (for its daily limit). */
export async function sortedToday(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${aiUsage.messages}), 0)::int` })
    .from(aiUsage)
    .where(and(eq(aiUsage.day, today()), eq(aiUsage.feature, "sorter")));
  return r?.n ?? 0;
}

/** Usage for the last `days` days: one row per day, feature and model, newest first. */
export async function aiUsageSince(db: Db, days: number) {
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return db
    .select()
    .from(aiUsage)
    .where(gte(aiUsage.day, from))
    .orderBy(sql`${aiUsage.day} desc`, aiUsage.feature, aiUsage.model);
}
