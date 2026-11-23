import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Button, Card, PageHeader, RadioGroup, Spinner } from "../components/ui";
import { type AuditEntry, api, type EmailAddress, type PendingAction, relTime } from "../lib/api";

const fmtAddr = (list?: Array<EmailAddress | string>) =>
  (list ?? [])
    .map((a) => (typeof a === "string" ? a : a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

function Preview({ p }: { p: PendingAction }) {
  const input = p.payload.input ?? {};
  if (p.kind === "send") {
    return (
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-zinc-500">To</dt>
        <dd className="break-all">{fmtAddr(input.to)}</dd>
        {input.cc?.length > 0 && (
          <>
            <dt className="text-zinc-500">Cc</dt>
            <dd className="break-all">{fmtAddr(input.cc)}</dd>
          </>
        )}
        {input.bcc?.length > 0 && (
          <>
            <dt className="text-zinc-500">Bcc</dt>
            <dd className="break-all">{fmtAddr(input.bcc)}</dd>
          </>
        )}
        <dt className="text-zinc-500">Subject</dt>
        <dd className="font-medium">{input.subject}</dd>
        {input.attachments?.length > 0 && (
          <>
            <dt className="text-zinc-500">Attachments</dt>
            <dd>{input.attachments.map((a: { filename: string }) => a.filename).join(", ")}</dd>
          </>
        )}
        <dt className="sr-only">Body</dt>
        <dd className="sm:col-span-2">
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-sans text-sm dark:bg-zinc-800/60">
            {input.text ?? "(HTML only)"}
          </pre>
        </dd>
      </dl>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p>
        {p.kind === "reply" ? (input.replyAll ? "Reply all" : "Reply") : "Forward"} to message #
        {p.payload.messageId}
        {p.kind === "forward" && <> → {fmtAddr(input.to)}</>}
      </p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-sans text-sm dark:bg-zinc-800/60">
        {input.text ?? ""}
      </pre>
    </div>
  );
}

export function ApprovalsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const q = useQuery({
    queryKey: ["approvals", status],
    queryFn: () => api<{ approvals: PendingAction[] }>(`/approvals?status=${status}`),
    refetchInterval: 15_000,
  });
  const [err, setErr] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) =>
      api(`/approvals/${v.id}/${v.approve ? "approve" : "reject"}`, { method: "POST" }),
    onMutate: () => setErr(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
    onError: (e) => {
      setErr((e as Error).message);
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  const items = q.data?.approvals ?? [];
  const badge: Record<PendingAction["status"], string> = {
    pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    approved: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    executed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    rejected: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    expired: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800",
  };

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Mail that agents want to send, waiting for you. Nothing goes out until you approve it."
      />
      <div className="mb-4">
        <RadioGroup
          name="ap-status"
          label="Show"
          value={status}
          onChange={(v) => setStatus(v as "pending" | "all")}
          options={[
            { value: "pending", label: "Waiting" },
            { value: "all", label: "History" },
          ]}
        />
      </div>
      {err && (
        <div className="mb-4">
          <Alert tone="error" title="Couldn't complete that">
            {err}
          </Alert>
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-zinc-500">
            {status === "pending" ? "Nothing waiting for approval." : "No approval history yet."}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((p) => (
            <Card
              key={p.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {p.agentName ?? "Deleted agent"} wants to {p.kind === "send" ? "send" : p.kind}{" "}
                  from {p.account}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge[p.status]}`}
                  >
                    {p.status}
                  </span>
                </span>
              }
              actions={<span className="text-xs text-zinc-500">{relTime(p.createdAt)}</span>}
            >
              <Preview p={p} />
              {p.status === "failed" && p.result?.error && (
                <div className="mt-3">
                  <Alert tone="error" title="Sending failed">
                    {String(p.result.error)}
                  </Alert>
                </div>
              )}
              {p.status === "pending" && (
                <div className="mt-4 flex gap-2">
                  <Button
                    busy={
                      decide.isPending && decide.variables?.id === p.id && decide.variables.approve
                    }
                    onClick={() => decide.mutate({ id: p.id, approve: true })}
                  >
                    Approve and send
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => decide.mutate({ id: p.id, approve: false })}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export function AuditPage() {
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("");
  const [deniedOnly, setDeniedOnly] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["audit", action, actorType, deniedOnly],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "100" });
      if (action) p.set("action", action);
      if (actorType) p.set("actorType", actorType);
      if (deniedOnly) p.set("allowed", "false");
      if (pageParam) p.set("before", String(pageParam));
      return api<{ entries: AuditEntry[]; nextBefore?: number }>(`/audit?${p}`);
    },
    getNextPageParam: (l) => l.nextBefore,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const select =
    "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Everything people and agents did, including attempts that were blocked."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Action</span>
          <select className={select} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            <option value="mcp.">Agent tool calls</option>
            <option value="mail.send">Sent mail</option>
            <option value="mail.delete">Deletions</option>
            <option value="mail.move">Moves</option>
            <option value="approval.">Approvals</option>
            <option value="account.">Account changes</option>
            <option value="grant.">Permission changes</option>
            <option value="auth.">Sign-ins</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-600 dark:text-zinc-400">Who</span>
          <select
            className={select}
            value={actorType}
            onChange={(e) => setActorType(e.target.value)}
          >
            <option value="">Everyone</option>
            <option value="agent">Agents</option>
            <option value="user">People</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={deniedOnly}
            onChange={(e) => setDeniedOnly(e.target.checked)}
            className="size-4 accent-blue-600"
          />
          Blocked only
        </label>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-zinc-500">No entries.</p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Account</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((e) => (
                <tr key={e.id} className={e.allowed ? "" : "bg-red-50/60 dark:bg-red-950/20"}>
                  <td
                    className="whitespace-nowrap px-4 py-2 text-zinc-600 dark:text-zinc-400"
                    title={new Date(e.at).toLocaleString()}
                  >
                    {relTime(e.at)}
                  </td>
                  <td className="px-4 py-2 text-zinc-800 dark:text-zinc-200">{e.actor}</td>
                  <td className="px-4 py-2">
                    <code className="text-xs">{e.action}</code>
                    {!e.allowed && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-red-700 dark:bg-red-950 dark:text-red-300">
                        blocked
                      </span>
                    )}
                  </td>
                  <td className="hidden px-4 py-2 text-zinc-600 md:table-cell dark:text-zinc-400">
                    {e.account ?? ""}
                  </td>
                  <td
                    className="hidden max-w-md truncate px-4 py-2 font-mono text-xs text-zinc-500 lg:table-cell"
                    title={JSON.stringify(e.detail)}
                  >
                    {e.target ?? (e.detail ? JSON.stringify(e.detail) : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="ghost" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
