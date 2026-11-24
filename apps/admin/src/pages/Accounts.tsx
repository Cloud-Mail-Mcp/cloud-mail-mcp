import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { SchemaFields } from "../components/SchemaFields";
import {
  Alert,
  Button,
  Card,
  Field,
  fmt,
  Input,
  PageHeader,
  RadioGroup,
  Spinner,
  StatusBadge,
} from "../components/ui";
import {
  type AccountDetail,
  type AccountDraft,
  type AccountSummary,
  type ApiError,
  api,
  type ModuleInfo,
  type TestResult,
} from "../lib/api";
import { defaultsFromSchema, fillDomain, merge, type Obj, setPath } from "../lib/config";

const useModules = () =>
  useQuery({
    queryKey: ["modules"],
    queryFn: () => api<{ modules: ModuleInfo[] }>("/modules"),
    staleTime: Infinity,
  });

// ───────────────────────────── List ─────────────────────────────

const ACCESS_LABELS: Record<string, string> = {
  none: "No access",
  read: "Read only",
  assistant: "Read, organize, draft & unsubscribe",
  send_approval: "…and send with my approval",
};

/** Mailboxes added by an agent or an import without passwords: enter each password to finish. */
function WaitingForPassword() {
  const q = useQuery({
    queryKey: ["drafts"],
    queryFn: () => api<{ drafts: AccountDraft[] }>("/accounts/drafts"),
    refetchInterval: 15_000,
  });
  const drafts = q.data?.drafts ?? [];
  if (!drafts.length) return null;
  return (
    <Card
      className="mb-6"
      title={
        <span id="waiting">
          Waiting for password <span className="font-normal text-zinc-500">· {drafts.length}</span>
        </span>
      }
    >
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        These mailboxes were added without a password. Enter each one here; MailMCP tests it and
        adds the mailbox. Passwords typed here are never shown to agents.
      </p>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {drafts.map((d) => (
          <DraftRow key={d.id} draft={d} />
        ))}
      </ul>
    </Card>
  );
}

function DraftRow({ draft: d }: { draft: AccountDraft }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<string>(d.access ?? "none");
  const [err, setErr] = useState<ApiError | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["drafts"] });
    await qc.invalidateQueries({ queryKey: ["accounts"] });
  };
  const add = useMutation({
    mutationFn: () =>
      api(`/accounts/drafts/${d.id}/complete`, {
        method: "POST",
        body: { password, ...(d.agentId ? { access } : {}) },
      }),
    onMutate: () => setErr(null),
    onSuccess: refresh,
    onError: (e) => setErr(e as ApiError),
  });
  const remove = useMutation({
    mutationFn: () => api(`/accounts/drafts/${d.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const pwId = `pw-${d.id}`;
  return (
    <li className="py-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) add.mutate();
        }}
      >
        <div className="min-w-56 flex-1">
          <p className="font-mono text-[13px] text-zinc-900 dark:text-zinc-100">
            {d.address}
            {d.label && <span className="ml-2 font-sans text-zinc-500">· {d.label}</span>}
          </p>
          <p className="text-xs text-zinc-500">
            {d.config.imap?.host ?? "?"}
            {d.agentName ? ` · added by ${d.agentName}` : ""}
          </p>
        </div>
        {d.agentId && (
          <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            {d.agentName ?? "Agent"} gets
            <select
              value={access}
              onChange={(e) => setAccess(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              {Object.entries(ACCESS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <label
          htmlFor={pwId}
          className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400"
        >
          Password
          <Input
            id={pwId}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-56"
          />
        </label>
        <Button type="submit" busy={add.isPending} disabled={!password}>
          Test &amp; add
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          aria-label={`Remove ${d.address} from the waiting list`}
        >
          Remove
        </Button>
      </form>
      {err && (
        <div className="mt-2">
          <Alert tone="error" title={err.message}>
            {err.hint}
          </Alert>
        </div>
      )}
    </li>
  );
}

export function AccountsPage() {
  const q = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
    refetchInterval: (query) =>
      query.state.data?.accounts.some((a) => a.status === "syncing" || a.status === "pending")
        ? 4000
        : false,
  });
  const accounts = q.data?.accounts ?? [];
  const totals = accounts.reduce(
    (t, a) => ({ messages: t.messages + a.messageCount, unread: t.unread + a.unreadCount }),
    { messages: 0, unread: 0 },
  );

  return (
    <>
      <PageHeader
        title="Accounts"
        description={
          accounts.length
            ? `${accounts.length} connected · ${fmt(totals.messages)} messages · ${fmt(totals.unread)} unread in inboxes`
            : "Connect the mailboxes MailMCP should index and make available to agents."
        }
        actions={
          <>
            <Link
              href="/accounts/import"
              className="rounded-md border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Import from spreadsheet
            </Link>
            <Link
              href="/accounts/new"
              className="rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Add account
            </Link>
          </>
        }
      />
      <WaitingForPassword />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <Alert tone="error" title="Couldn't load accounts">
          {(q.error as Error).message}
        </Alert>
      ) : accounts.length === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">No accounts yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Add iCloud, Gmail (app password), or any cPanel/IMAP mailbox.
            </p>
            <Link
              href="/accounts/new"
              className="mt-4 inline-block rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Add your first account
            </Link>
          </div>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2.5 font-medium">Account</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Folders</th>
                <th className="px-4 py-2.5 text-right font-medium">Messages</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Unread</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {accounts.map((a) => (
                <tr key={a.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/accounts/${a.id}`}
                      className="font-medium text-zinc-900 hover:text-blue-600 dark:text-zinc-100"
                    >
                      {a.displayName ?? a.address}
                    </Link>
                    {a.label && (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {a.label}
                      </span>
                    )}
                    {a.displayName && <p className="text-xs text-zinc-500">{a.address}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={a.status} />
                    {(a.status === "auth_error" || a.status === "error") && (
                      <Link
                        href={`/accounts/${a.id}`}
                        className="ml-2 text-xs text-blue-600 hover:underline"
                      >
                        Fix login
                      </Link>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-zinc-600 sm:table-cell dark:text-zinc-400">
                    {fmt(a.folderCount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {fmt(a.messageCount)}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-zinc-600 sm:table-cell dark:text-zinc-400">
                    {fmt(a.unreadCount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ───────────────────────────── Test result ─────────────────────────────

function TestOutcome({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="error" title={result.error?.message ?? "Connection failed"}>
        {result.error?.hint}
      </Alert>
    );
  }
  const folders = result.folders ?? [];
  const total = folders.reduce((n, f) => n + (f.messageCount ?? 0), 0);
  return (
    <Alert tone="success" title="Connected: login and sending both work.">
      Found {folders.length} folder{folders.length === 1 ? "" : "s"} with {fmt(total)} messages
      {folders.length > 0 && (
        <>
          {" "}
          (
          {folders
            .slice(0, 6)
            .map((f) => f.path)
            .join(", ")}
          {folders.length > 6 ? ", …" : ""})
        </>
      )}
      .
    </Alert>
  );
}

// ───────────────────────────── Add ─────────────────────────────

type Preset = ModuleInfo["presets"][number];

/** How to get a working password for this provider (app passwords for Gmail and iCloud). */
function ProviderSteps({ preset }: { preset: Preset }) {
  if (!preset.help && !preset.steps?.length) return null;
  return (
    <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
      {preset.help && <p>{preset.help}</p>}
      {preset.steps?.length ? (
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          {preset.steps.map((s) => (
            <li key={s.text}>
              {s.text}
              {s.link && (
                <a
                  href={s.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 inline-flex items-center rounded border border-blue-300 bg-white px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
                >
                  {s.link.label} ↗
                </a>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Gmail shows app passwords as "abcd efgh ijkl mnop"; the spaces aren't part of it. */
function cleanPassword(presetId: string | null | undefined, config: Obj): Obj {
  const pw = config.password;
  if (
    presetId === "gmail" &&
    typeof pw === "string" &&
    /^[a-z]{4}( ?[a-z]{4}){3}$/i.test(pw.trim())
  )
    return { ...config, password: pw.replace(/\s+/g, "") };
  return config;
}

/** The connection form: provider detection, test, save. Used by Accounts and the setup wizard. */
export function AddAccountForm({
  onSaved,
  secondary,
}: {
  onSaved: (account: AccountDetail) => void;
  /** Extra controls next to the Save button (e.g. Cancel or Skip). */
  secondary?: ReactNode;
}) {
  const modulesQ = useModules();
  const qc = useQueryClient();

  const module = modulesQ.data?.modules.find((m) => m.id === "imap");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetPicked, setPresetPicked] = useState(false);
  const [config, setConfig] = useState<Obj>({});
  const [advancedTouched, setAdvancedTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const detected = useMemo(
    () => module?.presets.find((p) => p.domains.includes(domain))?.id ?? (domain ? "cpanel" : null),
    [module, domain],
  );
  const activePresetId = presetPicked ? presetId : detected;
  const preset = module?.presets.find((p) => p.id === activePresetId);

  // Re-derive server settings from the preset until the user edits them by hand.
  useEffect(() => {
    if (!module || advancedTouched) return;
    const base = defaultsFromSchema(module.configSchema);
    const fromPreset = preset ? fillDomain(preset.defaults, domain || "example.com") : {};
    setConfig((c) => ({ ...merge(base, fromPreset), username: email, password: c.password ?? "" }));
  }, [module, preset, domain, email, advancedTouched]);

  const body = () => ({
    moduleId: "imap",
    address: email,
    displayName: displayName || undefined,
    config: cleanPassword(activePresetId, config),
  });

  const testM = useMutation({
    mutationFn: () => api<TestResult>("/accounts/test", { method: "POST", body: body() }),
    onMutate: () => {
      setTest(null);
      setErr(null);
    },
    onSuccess: setTest,
    onError: (e) => setErr(e as ApiError),
  });
  const saveM = useMutation({
    mutationFn: () =>
      api<{ account: AccountDetail }>("/accounts", { method: "POST", body: body() }),
    onMutate: () => setErr(null),
    onSuccess: async ({ account }) => {
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      onSaved(account);
    },
    onError: (e) => setErr(e as ApiError),
  });

  if (modulesQ.isLoading) return <Spinner />;
  if (!module) return <Alert tone="error" title="IMAP module not available" />;

  const onField = (path: string, v: unknown) => {
    setAdvancedTouched(true);
    setConfig((c) => setPath(c, path, v));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveM.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card title="Mailbox">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email address" htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value.trim())}
              required
              autoFocus
            />
          </Field>
          <Field label="Display name" htmlFor="dn" hint="Optional, e.g. “Work” or “Store support”.">
            <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        </div>

        <div className="mt-5">
          <RadioGroup
            name="provider"
            label="Provider"
            value={activePresetId ?? (presetPicked ? "other" : "")}
            options={[
              ...module.presets.map((p) => ({ value: p.id, label: p.name })),
              { value: "other", label: "Other IMAP server" },
            ]}
            onChange={(v) => {
              setPresetPicked(true);
              if (v === "other") {
                setPresetId(null);
                setShowAdvanced(true);
              } else {
                setPresetId(v);
                setAdvancedTouched(false);
              }
            }}
          />
          {preset && <ProviderSteps preset={preset} />}
        </div>

        <div className="mt-5 max-w-sm">
          <SchemaFields
            module={module}
            paths={module.ui.secretFields}
            value={config}
            onChange={(p, v) => setConfig((c) => setPath(c, p, v))}
            errors={err?.fields}
          />
        </div>
      </Card>

      <Card
        title="Server settings"
        actions={
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowAdvanced((s) => !s)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? "Hide" : "Show"}
          </Button>
        }
      >
        {showAdvanced ? (
          <SchemaFields
            module={module}
            paths={module.ui.advancedFields ?? []}
            value={config}
            onChange={onField}
            errors={err?.fields}
          />
        ) : (
          <p className="text-sm text-zinc-500">
            {config.imap && (config.imap as Obj).host
              ? `IMAP ${(config.imap as Obj).host}:${(config.imap as Obj).port} · SMTP ${(config.smtp as Obj).host}:${(config.smtp as Obj).port}`
              : "Filled in automatically from the provider."}
          </p>
        )}
      </Card>

      {test && <TestOutcome result={test} />}
      {err && (
        <Alert tone="error" title={err.message}>
          {err.hint}
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          busy={testM.isPending}
          onClick={() => testM.mutate()}
          disabled={!email || !config.password}
        >
          Test connection
        </Button>
        <Button type="submit" busy={saveM.isPending} disabled={!email || !config.password}>
          Save account
        </Button>
        {secondary}
      </div>
    </form>
  );
}

export function AddAccountPage() {
  const [, navigate] = useLocation();
  return (
    <>
      <PageHeader
        title="Add account"
        description="Settings are tested before saving. Passwords are stored encrypted."
      />
      <AddAccountForm
        onSaved={(a) => navigate(`/accounts/${a.id}`)}
        secondary={
          <Link
            href="/accounts"
            className="px-3 py-2 text-sm text-zinc-600 hover:underline dark:text-zinc-400"
          >
            Cancel
          </Link>
        }
      />
    </>
  );
}

// ───────────────────────────── Detail ─────────────────────────────

export function AccountDetailPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const modulesQ = useModules();
  const q = useQuery({
    queryKey: ["account", id],
    queryFn: () => api<{ account: AccountDetail }>(`/accounts/${id}`),
    // Poll while a sync is running so progress shows live.
    refetchInterval: (query) =>
      ["syncing", "pending"].includes(query.state.data?.account.status ?? "") ? 3000 : false,
  });
  const account = q.data?.account;
  const module = modulesQ.data?.modules.find((m) => m.id === account?.moduleId);
  // The provider this account uses (Gmail, iCloud…), to show how to get a new app password.
  const imapHost = (cfg?: Record<string, unknown>) =>
    ((cfg?.imap as { host?: string } | undefined)?.host ?? "").toLowerCase();
  const preset = module?.presets.find(
    (p) => imapHost(p.defaults) && imapHost(p.defaults) === imapHost(account?.config),
  );

  const [displayName, setDisplayName] = useState("");
  const [label, setLabel] = useState("");
  const [config, setConfig] = useState<Obj>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<false | "tested" | "untested">(false);
  const [confirmDelete, setConfirmDelete] = useState("");

  // Initialize the form once per account (polling must not overwrite edits in progress).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (account && loadedFor.current !== account.id) {
      loadedFor.current = account.id;
      setDisplayName(account.displayName ?? "");
      setLabel(account.label ?? "");
      setConfig({ ...account.config, password: "" });
    }
  }, [account]);

  const refresh = async (data: { account: AccountDetail }) => {
    qc.setQueryData(["account", id], data);
    await qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const saveM = useMutation({
    mutationFn: (opts: { skipTest?: boolean } = {}) =>
      api<{ account: AccountDetail }>(`/accounts/${id}`, {
        method: "PATCH",
        body: {
          displayName: displayName || null,
          label: label || null,
          config: cleanPassword(preset?.id, config),
          skipTest: opts.skipTest,
        },
      }),
    onMutate: () => {
      setErr(null);
      setSaved(false);
    },
    onSuccess: async (d, opts) => {
      await refresh(d);
      setSaved(opts?.skipTest ? "untested" : "tested");
      setConfig((c) => setPath(c, "password", ""));
    },
    onError: (e) => setErr(e as ApiError),
  });
  const syncM = useMutation({
    mutationFn: () => api(`/accounts/${id}/sync`, { method: "POST" }),
    onSuccess: () => {
      // Show "syncing" right away; the worker updates the real status within seconds.
      qc.setQueryData<{ account: AccountDetail }>(["account", id], (d) =>
        d ? { account: { ...d.account, status: "pending", statusMessage: "Sync queued…" } } : d,
      );
    },
    onError: (e) => setErr(e as ApiError),
  });
  const foldersM = useMutation({
    mutationFn: () =>
      api<{ account: AccountDetail }>(`/accounts/${id}/refresh-folders`, { method: "POST" }),
    onSuccess: refresh,
    onError: (e) => setErr(e as ApiError),
  });
  const deleteM = useMutation({
    mutationFn: () => api(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      navigate("/accounts");
    },
  });

  if (q.isLoading || modulesQ.isLoading) return <Spinner />;
  if (!account || !module) return <Alert tone="error" title="Account not found" />;

  const totalMessages = account.folders.reduce((n, f) => n + f.messageCount, 0);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/accounts" className="text-zinc-500 hover:underline">
          ← Accounts
        </Link>
      </div>
      <PageHeader
        title={account.displayName ?? account.address}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {account.displayName && <span>{account.address}</span>}
            {account.label && (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {account.label}
              </span>
            )}
            <StatusBadge status={account.status} />
            {account.statusMessage && <span>{account.statusMessage}</span>}
          </span>
        }
      />

      <div className="space-y-6">
        {(account.status === "auth_error" || account.status === "error") && (
          <Alert
            tone="error"
            title={
              account.status === "auth_error"
                ? "MailMCP can't log in to this mailbox"
                : "MailMCP can't reach this mailbox"
            }
          >
            If the password changed or the mail server moved,{" "}
            <a href="#connection" className="font-medium underline">
              update the login and server settings
            </a>
            .
          </Alert>
        )}
        <Card
          title={`Folders · ${fmt(totalMessages)} messages`}
          actions={
            <div className="flex gap-2">
              <Button
                variant="secondary"
                busy={foldersM.isPending}
                onClick={() => foldersM.mutate()}
              >
                Refresh folders
              </Button>
              <Button busy={syncM.isPending} onClick={() => syncM.mutate()}>
                Sync now
              </Button>
            </div>
          }
        >
          {account.folders.length === 0 ? (
            <p className="text-sm text-zinc-500">No folders found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Folder</th>
                  <th className="pb-2 text-right font-medium">Messages</th>
                  <th className="pb-2 text-right font-medium">Unread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {account.folders.map((f) => (
                  <tr key={f.id}>
                    <td className="py-2 text-zinc-800 dark:text-zinc-200">
                      {f.path}
                      {f.role && (
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">
                          {f.role}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {fmt(f.messageCount)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {fmt(f.unreadCount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <InstructionsCard accountId={id} initial={account.instructions ?? ""} onSaved={refresh} />

        <Card title="Login & server settings" className="scroll-mt-6">
          <p id="connection" className="-mt-1 mb-4 scroll-mt-6 text-sm text-zinc-500">
            Changed your password, or did the mail server's address change? Update it here. MailMCP
            logs in with the new settings before saving them.
          </p>
          {preset?.steps?.length ? (
            <div className="mb-5">
              <ProviderSteps preset={preset} />
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveM.mutate({});
            }}
            className="space-y-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name" htmlFor="dn">
                <Input
                  id="dn"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
              <Field
                label="Label"
                htmlFor="acct-label"
                hint='Optional. Tells logins for the same address apart, e.g. "Old host".'
              >
                <Input
                  id="acct-label"
                  value={label}
                  maxLength={60}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </Field>
              <SchemaFields
                module={module}
                paths={module.ui.secretFields}
                value={config}
                onChange={(p, v) => setConfig((c) => setPath(c, p, v))}
                secretPlaceholder="Saved. Leave blank to keep."
                errors={err?.fields}
              />
            </div>
            <SchemaFields
              module={module}
              paths={module.ui.advancedFields ?? []}
              value={config}
              onChange={(p, v) => setConfig((c) => setPath(c, p, v))}
              errors={err?.fields}
            />
            {err && (
              <Alert tone="error" title={err.message}>
                {err.hint}
                {err.status === 422 && (
                  <p className="mt-1">
                    If you're sure the settings are right (for example the server is briefly down),
                    you can save them without testing.
                  </p>
                )}
              </Alert>
            )}
            {saved === "tested" && (
              <Alert tone="success" title="Saved. The new settings were tested and work." />
            )}
            {saved === "untested" && (
              <Alert
                tone="warning"
                title="Saved without testing. The next sync will show whether they work."
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={saveM.isPending}>
                Test & save
              </Button>
              {err?.status === 422 && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saveM.isPending}
                  onClick={() => saveM.mutate({ skipTest: true })}
                >
                  Save without testing
                </Button>
              )}
            </div>
          </form>
        </Card>

        <Card title="Remove account" className="border-red-200 dark:border-red-900/60">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Removes this mailbox from MailMCP, including its local index and stored copies. Mail on
            the server is not touched.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label={`Type ${account.address} to confirm`} htmlFor="del">
              <Input
                id="del"
                value={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.value)}
                className="sm:w-80"
              />
            </Field>
            <Button
              variant="danger"
              busy={deleteM.isPending}
              disabled={confirmDelete.trim().toLowerCase() !== account.address}
              onClick={() => deleteM.mutate()}
            >
              Remove account
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

/** Free-text guidance every agent sees for this mailbox (returned by list_accounts). */
function InstructionsCard({
  accountId,
  initial,
  onSaved,
}: {
  accountId: string;
  initial: string;
  onSaved: (d: { account: AccountDetail }) => void;
}) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api<{ account: AccountDetail }>(`/accounts/${accountId}`, {
        method: "PATCH",
        body: { instructions: text || null },
      }),
    onMutate: () => setSaved(false),
    onSuccess: (d) => {
      setSaved(true);
      onSaved(d);
    },
  });
  return (
    <Card title="Instructions for agents">
      <div className="space-y-3">
        <Field
          label="Agents read this before working in this mailbox"
          htmlFor={`instr-${accountId}`}
          hint="e.g. “Never reply to anyone at legal@. Archive newsletters instead of deleting them.”"
        >
          <textarea
            id={`instr-${accountId}`}
            rows={4}
            maxLength={4000}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
        {save.error && <Alert tone="error" title={(save.error as Error).message} />}
        {saved && <Alert tone="success" title="Saved." />}
        <Button variant="secondary" busy={save.isPending} onClick={() => save.mutate()}>
          Save instructions
        </Button>
      </div>
    </Card>
  );
}
