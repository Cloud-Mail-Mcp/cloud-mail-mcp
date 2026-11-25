import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, formatUsd } from "../lib/api";
import { Card, Spinner } from "./ui";

interface UsageRow {
  day: string;
  feature: string;
  model: string;
  requests: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  errors: number;
}

const FEATURES: Record<string, string> = { sorter: "AI sorting", chat: "Chat" };
const MODELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
};
const fmt = (n: number) => n.toLocaleString();
const tokensOf = (r: UsageRow) =>
  r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;

/** What the Anthropic API key has been used for, and what it cost (estimated). */
export function AiUsageCard() {
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["ai-usage", days],
    queryFn: () => api<{ pricesAsOf: string; rows: UsageRow[] }>(`/ai/usage?days=${days}`),
  });
  const rows = q.data?.rows ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const total = (list: UsageRow[]) => ({
    cost: list.reduce((n, r) => n + r.costUsd, 0),
    tokens: list.reduce((n, r) => n + tokensOf(r), 0),
  });
  const all = total(rows);
  const todays = total(rows.filter((r) => r.day === today));

  // One line per feature and model over the period.
  const groups = new Map<string, UsageRow>();
  for (const r of rows) {
    const k = `${r.feature}|${r.model}`;
    const g = groups.get(k);
    groups.set(
      k,
      g
        ? {
            ...g,
            requests: g.requests + r.requests,
            messages: g.messages + r.messages,
            inputTokens: g.inputTokens + r.inputTokens,
            outputTokens: g.outputTokens + r.outputTokens,
            cacheReadTokens: g.cacheReadTokens + r.cacheReadTokens,
            cacheWriteTokens: g.cacheWriteTokens + r.cacheWriteTokens,
            costUsd: g.costUsd + r.costUsd,
          }
        : { ...r },
    );
  }
  // Cost per day, newest first.
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.costUsd);
  const maxDay = Math.max(0.000001, ...perDay.values());

  return (
    <div id="ai-usage">
      <Card
        title="AI usage and cost"
        actions={
          <select
            aria-label="Period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      >
        {q.isLoading ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Today"
                value={formatUsd(todays.cost)}
                sub={`${fmt(todays.tokens)} tokens`}
              />
              <Stat
                label={`Last ${days} days`}
                value={formatUsd(all.cost)}
                sub={`${fmt(all.tokens)} tokens`}
              />
              <Stat
                label="Average per day"
                value={formatUsd(all.cost / days)}
                sub={`over ${days} days`}
              />
            </div>
            {groups.size === 0 ? (
              <p className="text-sm text-zinc-500">
                No AI usage yet. Chat and AI sorting use your Anthropic API key from Assistant
                above.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/50">
                      <tr>
                        <th className="px-3 py-2 font-medium">Used for</th>
                        <th className="px-3 py-2 font-medium">Model</th>
                        <th className="px-3 py-2 text-right font-medium">Requests</th>
                        <th className="px-3 py-2 text-right font-medium">Tokens in / out</th>
                        <th className="px-3 py-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {[...groups.values()].map((g) => (
                        <tr key={`${g.feature}|${g.model}`}>
                          <td className="px-3 py-2">
                            {FEATURES[g.feature] ?? g.feature}
                            {g.feature === "sorter" && g.messages > 0 && (
                              <span className="ml-1.5 text-xs text-zinc-500">
                                {fmt(g.messages)} messages
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                            {MODELS[g.model] ?? (g.model || "Unknown")}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmt(g.requests)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                            {fmt(g.inputTokens + g.cacheReadTokens + g.cacheWriteTokens)} /{" "}
                            {fmt(g.outputTokens)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">
                            {formatUsd(g.costUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Cost per day
                  </p>
                  <ul className="space-y-1">
                    {[...perDay].map(([day, cost]) => (
                      <li key={day} className="flex items-center gap-3 text-xs">
                        <span className="w-20 shrink-0 tabular-nums text-zinc-500">{day}</span>
                        <span className="h-2 flex-1 rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <span
                            className="block h-2 rounded-full bg-blue-600"
                            style={{ width: `${Math.max(2, (cost / maxDay) * 100)}%` }}
                          />
                        </span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                          {formatUsd(cost)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
            <p className="text-xs text-zinc-500">
              Estimated from Anthropic's list prices ({q.data?.pricesAsOf}). Your Anthropic invoice
              is the exact figure. Usage before this update counted tokens only, so it shows no
              cost.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</p>
      <p className="text-xs text-zinc-500">{sub}</p>
    </div>
  );
}
