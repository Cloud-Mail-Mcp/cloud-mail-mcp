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
          <Link
            href="/accounts/new"
            className="rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add account
          </Link>
        }
      />
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
                    {a.displayName && <p className="text-xs text-zinc-500">{a.address}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={a.status} />
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

  const domain = email.includes("@") ? email.split("@")[1]!.toLowerCase() : "";
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
    config,
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
    <>
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
            <Field
              label="Display name"
              htmlFor="dn"
              hint="Optional, e.g. “Work” or “Store support”."
            >
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
            {preset?.help && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{preset.help}</p>
            )}
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
    </>
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

  const [displayName, setDisplayName] = useState("");
  const [config, setConfig] = useState<Obj>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");

  // Initialize the form once per account (polling must not overwrite edits in progress).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (account && loadedFor.current !== account.id) {
      loadedFor.current = account.id;
      setDisplayName(account.displayName ?? "");
      setConfig({ ...account.config, password: "" });
    }
  }, [account]);

  const refresh = async (data: { account: AccountDetail }) => {
    qc.setQueryData(["account", id], data);
    await qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const saveM = useMutation({
    mutationFn: () =>
      api<{ account: AccountDetail }>(`/accounts/${id}`, {
        method: "PATCH",
        body: { displayName: displayName || null, config },
      }),
    onMutate: () => {
      setErr(null);
      setSaved(false);
    },
    onSuccess: async (d) => {
      await refresh(d);
      setSaved(true);
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
            <StatusBadge status={account.status} />
            {account.statusMessage && <span>{account.statusMessage}</span>}
          </span>
        }
      />

      <div className="space-y-6">
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

        <Card title="Connection settings">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveM.mutate();
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
              </Alert>
            )}
            {saved && (
              <Alert tone="success" title="Saved. The new settings were tested and work." />
            )}
            <Button type="submit" busy={saveM.isPending}>
              Test & save
            </Button>
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
