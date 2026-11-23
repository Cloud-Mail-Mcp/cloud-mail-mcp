import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  fmt,
  PageHeader,
  RadioGroup,
  Spinner,
} from "../components/ui";
import { type AccountSummary, accountName, api, relTime } from "../lib/api";

interface FolderState {
  from: string;
  source: string;
  target: string;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  done: boolean;
  lastError?: string;
}

interface Migration {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  twoWay: boolean;
  continuous: boolean;
  status: "active" | "paused" | "finished";
  running: boolean;
  state: Record<string, FolderState>;
  lastRunAt: string | null;
  initialDoneAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface Preview {
  forward: Array<{
    source: string;
    target: string;
    targetExists: boolean;
    messages: number | null;
  }>;
  backward: Preview["forward"];
}

const selectCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

function totals(states: FolderState[]) {
  return states.reduce(
    (t, s) => ({
      total: t.total + s.total,
      copied: t.copied + s.copied,
      skipped: t.skipped + s.skipped,
      failed: t.failed + s.failed,
      done: t.done && s.done,
    }),
    { total: 0, copied: 0, skipped: 0, failed: 0, done: true },
  );
}

function statusOf(m: Migration): [string, string] {
  if (m.status === "finished")
    return ["Finished", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"];
  if (m.status === "paused")
    return ["Paused", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"];
  if (m.running)
    return ["Copying…", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"];
  if (m.lastError)
    return ["Will retry", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"];
  if (!m.initialDoneAt)
    return ["Starting", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"];
  return ["Keeping in sync", "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"];
}

function NewMigration({ accounts }: { accounts: AccountSummary[] }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(accounts[0]?.id ?? "");
  const [to, setTo] = useState(accounts[1]?.id ?? "");
  const [twoWay, setTwoWay] = useState(false);
  const [continuous, setContinuous] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountName(a) : "";
  };
  const body = { fromAccountId: from, toAccountId: to, twoWay, continuous };
  const previewM = useMutation({
    mutationFn: () => api<Preview>("/migrations/preview", { method: "POST", body }),
    onMutate: () => {
      setErr(null);
      setPreview(null);
    },
    onSuccess: setPreview,
    onError: (e) => setErr((e as Error).message),
  });
  const startM = useMutation({
    mutationFn: () => api("/migrations", { method: "POST", body }),
    onMutate: () => setErr(null),
    onSuccess: () => {
      setPreview(null);
      qc.invalidateQueries({ queryKey: ["migrations"] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const valid = from && to && from !== to;

  return (
    <Card title="New migration">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          startM.mutate();
        }}
      >
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Field label="Copy from (old)" htmlFor="mig-from">
            <select
              id="mig-from"
              className={selectCls}
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPreview(null);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountName(a)}
                </option>
              ))}
            </select>
          </Field>
          <Button
            type="button"
            variant="secondary"
            title="Swap direction"
            aria-label="Swap from and to"
            onClick={() => {
              setFrom(to);
              setTo(from);
              setPreview(null);
            }}
          >
            ⇄
          </Button>
          <Field label="Copy to (new)" htmlFor="mig-to">
            <select
              id="mig-to"
              className={selectCls}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPreview(null);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountName(a)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {from === to && from && <Alert tone="warning" title="Choose two different accounts." />}
        <RadioGroup
          name="mig-direction"
          label="Direction"
          value={twoWay ? "both" : "one"}
          options={[
            { value: "one", label: "One way: from → to" },
            { value: "both", label: "Both ways" },
          ]}
          onChange={(v) => {
            setTwoWay(v === "both");
            setPreview(null);
          }}
        />
        <p className="-mt-3 text-xs text-zinc-500">
          {twoWay
            ? "New mail on either side is copied to the other. Useful while DNS changes and mail can still land on the old server."
            : `Mail in ${name(from) || "the first account"} is copied to ${name(to) || "the second"}.`}
        </p>
        <Checkbox
          id="mig-cont"
          label="Keep copying new mail every few minutes until I finish the migration"
          checked={continuous}
          onChange={setContinuous}
        />
        <p className="text-xs text-zinc-500">
          Every folder is copied, with read and flagged status. Messages already in the other
          account are skipped, so it's safe to run again. Nothing is ever deleted.
        </p>
        {err && <Alert tone="error" title={err} />}
        {preview && (
          <div className="space-y-3">
            <PreviewTable title={`${name(from)} → ${name(to)}`} rows={preview.forward} />
            {twoWay && (
              <PreviewTable title={`${name(to)} → ${name(from)}`} rows={preview.backward} />
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!valid}
            busy={previewM.isPending}
            onClick={() => previewM.mutate()}
          >
            Preview folders
          </Button>
          <Button type="submit" disabled={!valid} busy={startM.isPending}>
            Start migration
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PreviewTable({ title, rows }: { title: string; rows: Preview["forward"] }) {
  const total = rows.reduce((n, r) => n + (r.messages ?? 0), 0);
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
      <p className="border-b border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-800 dark:border-zinc-800 dark:text-zinc-200">
        {title}{" "}
        <span className="font-normal text-zinc-500">
          · {rows.length} folders, {fmt(total)} messages
        </span>
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-zinc-500">
          <tr>
            <th className="px-3 py-1.5 font-medium">Folder</th>
            <th className="px-3 py-1.5 font-medium">Goes to</th>
            <th className="px-3 py-1.5 text-right font-medium">Messages</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.source}>
              <td className="px-3 py-1.5">{r.source}</td>
              <td className="px-3 py-1.5">
                {r.target}
                {!r.targetExists && <span className="ml-1.5 text-xs text-zinc-500">(new)</span>}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {r.messages === null ? "—" : fmt(r.messages)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stats({ label, states }: { label: string; states: FolderState[] }) {
  const t = totals(states);
  const handled = t.copied + t.skipped + t.failed;
  const pct = t.done ? 100 : t.total ? Math.min(99, Math.floor((handled / t.total) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
        <span className="text-xs tabular-nums text-zinc-500">
          {fmt(t.copied)} copied · {fmt(t.skipped)} already there
          {t.failed > 0 && <span className="text-red-600"> · {fmt(t.failed)} failed</span>} ·{" "}
          {fmt(t.total)} in source
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        role="progressbar"
        aria-label={`${label}: first copy progress`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full ${t.done ? "bg-green-500" : "bg-blue-600"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function MigrationCard({ m, accounts }: { m: Migration; accounts: AccountSummary[] }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const name = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountName(a) : "(removed account)";
  };
  const done = () => qc.invalidateQueries({ queryKey: ["migrations"] });
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api(`/migrations/${m.id}`, { method: "PATCH", body: b }),
    onMutate: () => setErr(null),
    onSuccess: done,
    onError: (e) => setErr((e as Error).message),
  });
  const run = useMutation({
    mutationFn: () => api(`/migrations/${m.id}/run`, { method: "POST" }),
    onMutate: () => setErr(null),
    onSuccess: done,
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/migrations/${m.id}`, { method: "DELETE" }),
    onSuccess: done,
    onError: (e) => setErr((e as Error).message),
  });
  const states = Object.values(m.state);
  const forward = states.filter((s) => s.from === m.fromAccountId);
  const backward = states.filter((s) => s.from === m.toAccountId);
  const [label, style] = statusOf(m);
  const busy = patch.isPending || run.isPending || remove.isPending;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {name(m.fromAccountId)} {m.twoWay ? "⇄" : "→"} {name(m.toAccountId)}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>{label}</span>
        </span>
      }
    >
      <div className="space-y-4">
        <Stats label={`${name(m.fromAccountId)} → ${name(m.toAccountId)}`} states={forward} />
        {(m.twoWay || backward.length > 0) && (
          <Stats label={`${name(m.toAccountId)} → ${name(m.fromAccountId)}`} states={backward} />
        )}
        <p className="text-xs text-zinc-500">
          {m.lastRunAt ? `Last checked ${relTime(m.lastRunAt)}` : "Not run yet"}
          {m.initialDoneAt && ` · first copy finished ${relTime(m.initialDoneAt)}`}
          {m.status === "active" &&
            m.continuous &&
            " · checks for new mail every couple of minutes"}
        </p>
        {m.lastError && m.status !== "finished" && (
          <Alert tone="error" title="The last run stopped with an error">
            {m.lastError} It will try again automatically.
          </Alert>
        )}
        {err && <Alert tone="error" title={err} />}
        {m.status === "active" && m.continuous && m.initialDoneAt && (
          <Alert tone="info" title="Switching hosts?">
            Once your domain's MX records point to the new server and mail has stopped arriving at
            the old one (allow a day or two for DNS), click <strong>Finish</strong>.
          </Alert>
        )}
        {states.length > 0 && (
          <details className="rounded-md border border-zinc-200 dark:border-zinc-800">
            <summary className="cursor-pointer px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300">
              Folders ({states.length})
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Folder</th>
                    <th className="px-3 py-1.5 font-medium">To</th>
                    <th className="px-3 py-1.5 text-right font-medium">Copied</th>
                    <th className="px-3 py-1.5 text-right font-medium">Already there</th>
                    <th className="px-3 py-1.5 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {states.map((s) => (
                    <tr key={`${s.from}|${s.source}`} title={s.lastError}>
                      <td className="px-3 py-1.5">
                        {m.twoWay && (
                          <span className="mr-1 text-xs text-zinc-500">
                            {s.from === m.fromAccountId ? "→" : "←"}
                          </span>
                        )}
                        {s.source}
                        {!s.done && <span className="ml-1.5 text-xs text-blue-600">copying</span>}
                      </td>
                      <td className="px-3 py-1.5">{s.target}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.copied)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.skipped)}</td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${s.failed ? "text-red-600" : ""}`}
                      >
                        {fmt(s.failed)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          {m.status === "active" && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => run.mutate()}>
                Sync now
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => patch.mutate({ status: "paused" })}
              >
                Pause
              </Button>
            </>
          )}
          {m.status !== "active" && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => patch.mutate({ status: "active" })}
            >
              {m.status === "paused" ? "Resume" : "Start again"}
            </Button>
          )}
          {m.status !== "finished" && (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                title={m.twoWay ? "Copy one way only" : "Also copy new mail back the other way"}
                onClick={() => patch.mutate({ twoWay: !m.twoWay })}
              >
                {m.twoWay ? "One way only" : "Sync both ways"}
              </Button>
              {!m.twoWay && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  title={`Copy from ${name(m.toAccountId)} to ${name(m.fromAccountId)} instead`}
                  onClick={() => patch.mutate({ reverse: true })}
                >
                  Reverse direction
                </Button>
              )}
              <Button disabled={busy} onClick={() => patch.mutate({ status: "finished" })}>
                Finish
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Remove this migration from the list? Mail that was already copied stays where it is.",
                )
              )
                remove.mutate();
            }}
          >
            Remove
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function MigrationsPage() {
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
  });
  const q = useQuery({
    queryKey: ["migrations"],
    queryFn: () => api<{ migrations: Migration[] }>("/migrations"),
    refetchInterval: (query) =>
      query.state.data?.migrations.some((m) => m.status === "active") ? 3000 : false,
  });
  const accounts = accountsQ.data?.accounts ?? [];
  const list = q.data?.migrations ?? [];

  return (
    <>
      <PageHeader
        title="Migrations"
        description="Copy mail from one account to another, for example the same address on your old and new host."
      />
      {accountsQ.isLoading || q.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {q.error && <Alert tone="error" title={(q.error as Error).message} />}
          {accounts.length < 2 ? (
            <Card>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Add both accounts first: the old login and the new one. The same address can be
                added twice with different server settings; each gets a label so you can tell them
                apart.{" "}
                <Link href="/accounts/new" className="text-blue-600 hover:underline">
                  Add an account
                </Link>
              </p>
            </Card>
          ) : (
            <NewMigration accounts={accounts} />
          )}
          {list.map((m) => (
            <MigrationCard key={m.id} m={m} accounts={accounts} />
          ))}
        </div>
      )}
    </>
  );
}
