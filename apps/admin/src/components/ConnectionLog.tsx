import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Button, Card, Spinner } from "./ui";

interface AccountEvent {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  detail: Record<string, unknown> | null;
}

const KIND: Record<string, string> = {
  sync: "Sync",
  idle: "New-mail connection",
  login: "Login",
  folders: "Folders",
  send: "Sending",
};
const DOT: Record<AccountEvent["level"], string> = {
  info: "bg-green-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

/**
 * What happened between Cloud Mail MCP and this mailbox's server: syncs, the new-mail
 * connection, login changes and errors, with the server's own words.
 */
export function ConnectionLog({ accountId }: { accountId: string }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const q = useQuery({
    queryKey: ["account-events", accountId],
    queryFn: () => api<{ events: AccountEvent[] }>(`/accounts/${accountId}/events?limit=200`),
    refetchInterval: 15_000,
  });
  const events = (q.data?.events ?? []).filter((e) => !errorsOnly || e.level !== "info");
  const asText = () =>
    events
      .map((e) => {
        const d = (e.detail ?? {}) as { server?: string; command?: string };
        const extra = [d.server && `server: ${d.server}`, d.command && `command: ${d.command}`]
          .filter(Boolean)
          .join(" · ");
        return `${e.at} ${e.level.toUpperCase()} [${e.kind}] ${e.message}${extra ? ` (${extra})` : ""}`;
      })
      .join("\n");

  return (
    <Card
      title="Connection log"
      actions={
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="accent-blue-600"
            />
            Problems only
          </label>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={!events.length}
            onClick={async () => {
              await navigator.clipboard.writeText(asText()).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        Syncs that changed something, the always-on new-mail connection, login changes, and every
        error with what the mail server said. The newest 300 entries are kept.
      </p>
      {q.isLoading ? (
        <Spinner />
      ) : events.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {errorsOnly ? "No problems recorded." : "Nothing recorded yet."}
        </p>
      ) : (
        <ol className="max-h-[28rem] divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {events.map((e) => {
            const d = (e.detail ?? {}) as { server?: string; command?: string; hint?: string };
            return (
              <li key={e.id} className="flex gap-3 px-3 py-2 text-sm">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[e.level]}`}
                  aria-hidden="true"
                />
                <span className="sr-only">{e.level === "info" ? "OK" : e.level}:</span>
                <div className="min-w-0 flex-1">
                  <p className="text-zinc-800 dark:text-zinc-200">{e.message}</p>
                  {(d.server || d.command || d.hint) && (
                    <p className="mt-0.5 break-words font-mono text-[11px] text-zinc-500">
                      {[
                        d.server && `Server said: ${d.server}`,
                        d.command && `Command: ${d.command}`,
                        d.hint && `Tip: ${d.hint}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-zinc-500">
                  <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                  <p>{KIND[e.kind] ?? e.kind}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
