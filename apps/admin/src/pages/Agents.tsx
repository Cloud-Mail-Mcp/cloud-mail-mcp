import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  RadioGroup,
  Spinner,
} from "../components/ui";
import {
  type AccountSummary,
  type AgentDetail,
  type AgentSummary,
  type ApiError,
  accountName,
  api,
  type Grant,
  relTime,
  type SendPolicy,
} from "../lib/api";

const SCOPE_LABELS: Array<[string, string, string]> = [
  ["mail:read", "Read", "List, search and read mail and attachments"],
  ["mail:organize", "Organize", "Mark read/unread, flag, move between folders"],
  ["mail:draft", "Drafts", "Save drafts for you to review"],
  ["mail:send", "Send", "Send, reply and forward (see send policy)"],
  ["mail:unsubscribe", "Unsubscribe", "Leave mailing lists with the sender's unsubscribe link"],
  ["mail:delete", "Delete", "Move mail to Trash"],
  ["mail:delete:permanent", "Delete permanently", "Erase mail for good"],
  ["folders:manage", "Manage folders", "Create, rename and delete folders"],
];

export const PRESETS: Record<string, { label: string; scopes: string[]; sendPolicy: SendPolicy }> =
  {
    none: { label: "No access", scopes: [], sendPolicy: "deny" },
    read: { label: "Read only", scopes: ["mail:read"], sendPolicy: "deny" },
    assistant: {
      label: "Assistant (read, organize, drafts, unsubscribe)",
      scopes: ["mail:read", "mail:organize", "mail:draft", "mail:unsubscribe"],
      sendPolicy: "deny",
    },
    sender: {
      label: "Assistant + send with approval",
      scopes: ["mail:read", "mail:organize", "mail:draft", "mail:unsubscribe", "mail:send"],
      sendPolicy: "approve",
    },
  };

/** MCP endpoint: the configured public URL (Settings → Server), or this browser's origin. */
function useMcpUrl() {
  const q = useQuery({
    queryKey: ["settings", "general"],
    queryFn: () => api<{ value: { publicUrl?: string } }>("/settings/general"),
    staleTime: 60_000,
  });
  return `${q.data?.value.publicUrl || window.location.origin}/mcp`;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</p>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="text-xs text-blue-600 hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">{text}</pre>
    </div>
  );
}

/** Shown once, right after a key is created. */
export function KeyReveal({ apiKey, onDone }: { apiKey: string; onDone?: () => void }) {
  const url = useMcpUrl();
  const desktop = JSON.stringify(
    {
      mcpServers: {
        "cloud-mail-mcp": {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", "Authorization:${CLOUD_MAIL_MCP_AUTH}"],
          env: { CLOUD_MAIL_MCP_AUTH: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
  return (
    <Card title="Your API key">
      <div className="space-y-4">
        <Alert tone="warning" title="Copy this key now. It won't be shown again.">
          Anyone with this key can use the mailboxes and permissions you give this agent. Revoke it
          any time on this page.
        </Alert>
        <CopyBlock label="API key" text={apiKey} />
        <CopyBlock
          label="Claude Code"
          text={`claude mcp add --transport http cloud-mail-mcp ${url} --header "Authorization: Bearer ${apiKey}"`}
        />
        <CopyBlock label="Claude Desktop (claude_desktop_config.json)" text={desktop} />
        <CopyBlock
          label="Any MCP client (Streamable HTTP)"
          text={`URL:    ${url}\nHeader: Authorization: Bearer ${apiKey}`}
        />
        {onDone && <Button onClick={onDone}>Done</Button>}
      </div>
    </Card>
  );
}

// ───────────────────────────── List ─────────────────────────────

/** The easy path: paste one URL into the AI app and approve on Cloud Mail MCP's sign-in page. */
function ConnectAppCard() {
  const url = useMcpUrl();
  const [open, setOpen] = useState<string | null>(null);
  const steps: Array<[string, ReactNode]> = [
    [
      "Claude (claude.ai, Desktop, mobile)",
      <>
        Settings → <b>Connectors</b> → <b>Add custom connector</b>. Name it “Cloud Mail MCP”, paste
        the URL, click <b>Add</b>, then <b>Connect</b>. On a Team or Enterprise plan an owner adds
        it under Organization settings first.
      </>,
    ],
    [
      "ChatGPT",
      <>
        Settings → <b>Apps &amp; Connectors</b> → <b>Advanced settings</b> → turn on{" "}
        <b>Developer mode</b>. Then <b>Create</b> (or <b>Add connector</b>), paste the URL, choose{" "}
        <b>OAuth</b> authentication, and connect. Menu names vary by plan.
      </>,
    ],
    [
      "Claude Code",
      <>
        Run{" "}
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
          claude mcp add --transport http cloud-mail-mcp {url}
        </code>
        , then type <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">/mcp</code> in
        Claude Code and choose <b>Authenticate</b>.
      </>,
    ],
    [
      "Cursor, VS Code and others",
      <>
        Add a remote (HTTP) MCP server with this URL. Clients that support MCP sign-in open this
        server's approval page automatically. For clients that don't, create an agent with an API
        key below.
      </>,
    ],
  ];
  return (
    <Card title="Connect an AI app" className="mb-6">
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Paste this URL into your AI app. You'll be sent here to sign in and choose which mailboxes
          it can use. It then shows up in the list below.
        </p>
        <CopyBlock label="MCP server URL" text={url} />
        {!url.startsWith("https://") && (
          <Alert tone="warning" title="Claude and ChatGPT need an https:// address">
            Set your public https URL in Settings → Server, or put Cloud Mail MCP behind HTTPS.
          </Alert>
        )}
        <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {steps.map(([name, body]) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => setOpen(open === name ? null : name)}
                aria-expanded={open === name}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/50"
              >
                {name}
                <span className="text-zinc-400">{open === name ? "−" : "+"}</span>
              </button>
              {open === name && (
                <p className="px-3 pb-3 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function AgentsPage() {
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentSummary[] }>("/agents"),
  });
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ agent: AgentSummary; apiKey: string }>("/agents", {
        method: "POST",
        body: { name, description: description || undefined },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      setCreated({ id: r.agent.id, key: r.apiKey });
      setCreating(false);
      setName("");
      setDescription("");
    },
  });

  if (created) {
    return (
      <>
        <PageHeader
          title="Agent created"
          description="Next, give it access to some accounts on the agent's page."
        />
        <KeyReveal apiKey={created.key} onDone={() => navigate(`/agents/${created.id}`)} />
      </>
    );
  }

  const agents = q.data?.agents ?? [];
  return (
    <>
      <PageHeader
        title="Agents"
        description="AI assistants and apps that can use your mail through MCP, each with its own permissions."
        actions={
          !creating && (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              New agent with API key
            </Button>
          )
        }
      />
      <ConnectAppCard />
      {creating && (
        <Card title="New agent" className="mb-6">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="an" hint="e.g. “Claude Desktop” or “Support bot”">
                <Input
                  id="an"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Description" htmlFor="ad">
                <Input
                  id="ad"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </div>
            {create.error && <Alert tone="error" title={(create.error as Error).message} />}
            <div className="flex gap-2">
              <Button type="submit" busy={create.isPending}>
                Create and get key
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : agents.length === 0 && !creating ? (
        <Card>
          <div className="py-8 text-center">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">No agents yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Connect an app with the URL above, or create an agent with an API key.
            </p>
          </div>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Accounts</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Keys</th>
                <th className="px-4 py-2.5 font-medium">Last used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/agents/${a.id}`}
                      className="font-medium text-zinc-900 hover:text-blue-600 dark:text-zinc-100"
                    >
                      {a.name}
                    </Link>
                    {a.kind === "oauth" && (
                      <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] uppercase text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        signed in
                      </span>
                    )}
                    {a.disabled && (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">
                        disabled
                      </span>
                    )}
                    {a.description && <p className="text-xs text-zinc-500">{a.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{a.accountCount}</td>
                  <td className="hidden px-4 py-3 font-mono text-xs text-zinc-500 sm:table-cell">
                    {a.keys.map((k) => `${k.prefix}…`).join(", ") ||
                      (a.kind === "oauth" ? "OAuth" : "none")}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {relTime(a.lastUsedAt)}
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

// ───────────────────────────── Grant editor ─────────────────────────────

const lines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function GrantEditor({
  agentId,
  account,
  grant,
}: {
  agentId: string;
  account: AccountSummary;
  grant?: Grant;
}) {
  const qc = useQueryClient();
  const [scopes, setScopes] = useState<Set<string>>(new Set(grant?.scopes ?? []));
  const [sendPolicy, setSendPolicy] = useState<SendPolicy>(grant?.sendPolicy ?? "approve");
  const [folderAllow, setFolderAllow] = useState((grant?.folderAllow ?? []).join("\n"));
  const [folderDeny, setFolderDeny] = useState((grant?.folderDeny ?? []).join("\n"));
  const [recipients, setRecipients] = useState((grant?.recipientAllow ?? []).join("\n"));
  const [perHour, setPerHour] = useState(
    grant?.rateLimit?.perHour ? String(grant.rateLimit.perHour) : "",
  );
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api(`/agents/${agentId}/grants/${account.id}`, {
        method: "PUT",
        body: {
          scopes: [...scopes],
          sendPolicy,
          folderAllow: lines(folderAllow),
          folderDeny: lines(folderDeny),
          recipientAllow: lines(recipients),
          rateLimit: perHour ? { perHour: Number(perHour) } : null,
        },
      }),
    onMutate: () => setSaved(false),
    onSuccess: async () => {
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["agent", agentId] });
    },
  });
  const toggle = (s: string, on: boolean) =>
    setScopes((cur) => {
      const n = new Set(cur);
      on ? n.add(s) : n.delete(s);
      return n;
    });
  const applyPreset = (k: string) => {
    const p = PRESETS[k]!;
    setScopes(new Set(p.scopes));
    setSendPolicy(p.sendPolicy);
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {accountName(account)}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {scopes.size === 0
              ? "No access"
              : SCOPE_LABELS.filter(([s]) => scopes.has(s))
                  .map(([, l]) => l)
                  .join(", ")}
            {scopes.has("mail:send") &&
              ` · sending: ${sendPolicy === "approve" ? "needs approval" : sendPolicy === "allow" ? "allowed" : "blocked"}`}
          </p>
        </div>
        <span className="text-xs text-zinc-500">{open ? "Close" : "Edit"}</span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex flex-wrap gap-2">
            {Object.entries(PRESETS).map(([k, p]) => (
              <Button key={k} type="button" variant="secondary" onClick={() => applyPreset(k)}>
                {p.label}
              </Button>
            ))}
          </div>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Permissions
            </legend>
            {SCOPE_LABELS.map(([s, label, help]) => (
              <div key={s}>
                <Checkbox
                  id={`${account.id}-${s}`}
                  label={label}
                  checked={scopes.has(s)}
                  onChange={(v) => toggle(s, v)}
                />
                <p className="ml-6 text-xs text-zinc-500">{help}</p>
              </div>
            ))}
          </fieldset>
          {scopes.has("mail:send") && (
            <>
              <RadioGroup
                name={`sp-${account.id}`}
                label="When this agent sends mail"
                value={sendPolicy}
                onChange={(v) => setSendPolicy(v as SendPolicy)}
                options={[
                  { value: "approve", label: "Hold for my approval" },
                  { value: "allow", label: "Send immediately" },
                  { value: "deny", label: "Block sending" },
                ]}
              />
              <Field
                label="Only allow sending to (optional)"
                htmlFor={`ra-${account.id}`}
                hint="One per line: a domain (example.com) or an address. Empty = anyone."
              >
                <textarea
                  id={`ra-${account.id}`}
                  rows={2}
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </Field>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Only these folders (optional)"
              htmlFor={`fa-${account.id}`}
              hint="One per line. Names, roles (inbox, sent) or globs like Projects/*. Empty = all."
            >
              <textarea
                id={`fa-${account.id}`}
                rows={2}
                value={folderAllow}
                onChange={(e) => setFolderAllow(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </Field>
            <Field
              label="Never these folders"
              htmlFor={`fd-${account.id}`}
              hint="e.g. Legal/** or HR"
            >
              <textarea
                id={`fd-${account.id}`}
                rows={2}
                value={folderDeny}
                onChange={(e) => setFolderDeny(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </Field>
          </div>
          <div className="max-w-xs">
            <Field label="Max actions per hour (optional)" htmlFor={`rl-${account.id}`}>
              <Input
                id={`rl-${account.id}`}
                type="number"
                min={1}
                value={perHour}
                onChange={(e) => setPerHour(e.target.value)}
              />
            </Field>
          </div>
          {save.error && <Alert tone="error" title={(save.error as ApiError).message} />}
          {saved && (
            <Alert tone="success" title="Saved. Takes effect on the agent's next request." />
          )}
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            Save permissions
          </Button>
        </div>
      )}
    </div>
  );
}

/** Every permission there is. */
const ALL_SCOPES = SCOPE_LABELS.map(([s]) => s);

/**
 * Save one set of permissions to several mailboxes. Each mailbox keeps its own folder limits,
 * recipient limits and rate limit; only the permissions and send policy change.
 */
async function applyGrants(
  agentId: string,
  accounts: AccountSummary[],
  grants: Grant[],
  scopes: string[],
  sendPolicy: SendPolicy,
) {
  for (const a of accounts) {
    const g = grants.find((x) => x.accountId === a.id);
    await api(`/agents/${agentId}/grants/${a.id}`, {
      method: "PUT",
      body: {
        scopes,
        sendPolicy,
        folderAllow: g?.folderAllow ?? null,
        folderDeny: g?.folderDeny ?? null,
        recipientAllow: g?.recipientAllow ?? null,
        rateLimit: g?.rateLimit ?? null,
      },
    });
  }
}

/** Change several mailboxes' permissions at once. */
function BulkGrantEditor({
  agent,
  accounts,
  onDone,
}: {
  agent: AgentDetail;
  accounts: AccountSummary[];
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(accounts.map((a) => a.id)));
  const [scopes, setScopes] = useState<Set<string>>(new Set(PRESETS.assistant!.scopes));
  const [sendPolicy, setSendPolicy] = useState<SendPolicy>("approve");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const flip = (set: Set<string>, v: string, on: boolean) => {
    const n = new Set(set);
    on ? n.add(v) : n.delete(v);
    return n;
  };
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await applyGrants(
        agent.id,
        accounts.filter((a) => picked.has(a.id)),
        agent.grants,
        [...scopes],
        scopes.has("mail:send") ? sendPolicy : "deny",
      );
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 space-y-4 rounded-lg border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-900/60 dark:bg-blue-950/20">
      <fieldset>
        <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Mailboxes
          <span className="space-x-3 text-xs font-normal">
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => setPicked(new Set(accounts.map((a) => a.id)))}
            >
              All
            </button>
            <button
              type="button"
              className="text-blue-600 hover:underline"
              onClick={() => setPicked(new Set())}
            >
              None
            </button>
          </span>
        </legend>
        <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {accounts.map((a) => (
            <Checkbox
              key={a.id}
              id={`bulk-a-${a.id}`}
              label={accountName(a)}
              checked={picked.has(a.id)}
              onChange={(v) => setPicked((p) => flip(p, a.id, v))}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {Object.entries(PRESETS).map(([k, p]) => (
          <Button
            key={k}
            type="button"
            variant="secondary"
            onClick={() => {
              setScopes(new Set(p.scopes));
              setSendPolicy(p.sendPolicy === "deny" ? "approve" : p.sendPolicy);
            }}
          >
            {p.label}
          </Button>
        ))}
        <Button type="button" variant="secondary" onClick={() => setScopes(new Set(ALL_SCOPES))}>
          All permissions
        </Button>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Permissions
        </legend>
        {SCOPE_LABELS.map(([s, label]) => (
          <Checkbox
            key={s}
            id={`bulk-s-${s}`}
            label={label}
            checked={scopes.has(s)}
            onChange={(v) => setScopes((cur) => flip(cur, s, v))}
          />
        ))}
      </fieldset>
      {scopes.has("mail:send") && (
        <RadioGroup
          name="bulk-sp"
          label="When this agent sends mail"
          value={sendPolicy}
          onChange={(v) => setSendPolicy(v as SendPolicy)}
          options={[
            { value: "approve", label: "Hold for my approval" },
            { value: "allow", label: "Send immediately" },
          ]}
        />
      )}
      {err && <Alert tone="error" title={err} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button busy={busy} disabled={!picked.size} onClick={go}>
          Apply to {picked.size} {picked.size === 1 ? "mailbox" : "mailboxes"}
        </Button>
        <span className="text-xs text-zinc-500">
          Folder, recipient and rate limits already set on a mailbox are kept.
        </span>
      </div>
    </div>
  );
}

/** Every permission on every mailbox, after saying plainly what that allows. */
function AllPermissions({
  agent,
  accounts,
  onDone,
  onCancel,
}: {
  agent: AgentDetail;
  accounts: AccountSummary[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [approve, setApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mb-4">
      <Alert
        tone="warning"
        title={`Give “${agent.name}” every permission on all ${accounts.length} ${accounts.length === 1 ? "mailbox" : "mailboxes"}?`}
      >
        <p>
          It will be able to read, organize, draft, send, unsubscribe, delete (including
          permanently) and manage folders in every mailbox. Everything it does is in the audit log.
        </p>
        <div className="mt-3">
          <Checkbox
            id="all-approve"
            label="Still hold each email it sends for my approval (recommended)"
            checked={approve}
            onChange={setApprove}
          />
        </div>
        {err && <p className="mt-2 text-red-700 dark:text-red-400">{err}</p>}
        <div className="mt-3 flex gap-2">
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await applyGrants(
                  agent.id,
                  accounts,
                  agent.grants,
                  ALL_SCOPES,
                  approve ? "approve" : "allow",
                );
                onDone();
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Give all permissions
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Alert>
    </div>
  );
}

// ───────────────────────────── Detail ─────────────────────────────

export function AgentDetailPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const q = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api<{ agent: AgentDetail }>(`/agents/${id}`),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
  });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [accessMode, setAccessMode] = useState<"bulk" | "all" | null>(null);
  const [accessSaved, setAccessSaved] = useState<string | null>(null);
  const mcpUrl = useMcpUrl();

  const refresh = () => qc.invalidateQueries({ queryKey: ["agent", id] });
  const issue = useMutation({
    mutationFn: () => api<{ apiKey: string }>(`/agents/${id}/keys`, { method: "POST" }),
    onSuccess: (r) => {
      setNewKey(r.apiKey);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) => api(`/agents/${id}/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (disabled: boolean) =>
      api(`/agents/${id}`, { method: "PATCH", body: { disabled } }),
    onSuccess: refresh,
  });
  const canAdd = useMutation({
    mutationFn: (canAddAccounts: boolean) =>
      api(`/agents/${id}`, { method: "PATCH", body: { canAddAccounts } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/agents/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["agents"] });
      navigate("/agents");
    },
  });

  if (q.isLoading || accountsQ.isLoading) return <Spinner />;
  const agent = q.data?.agent;
  if (!agent) return <Alert tone="error" title="Agent not found" />;
  const activeKeys = agent.keys.filter((k) => !k.revokedAt);

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/agents" className="text-zinc-500 hover:underline">
          ← Agents
        </Link>
      </div>
      <PageHeader
        title={agent.name}
        description={
          agent.disabled
            ? "Disabled: all requests from this agent are refused."
            : (agent.description ?? "")
        }
        actions={
          <Button
            variant="secondary"
            busy={toggle.isPending}
            onClick={() => toggle.mutate(!agent.disabled)}
          >
            {agent.disabled ? "Enable" : "Disable"}
          </Button>
        }
      />
      <div className="space-y-6">
        {newKey && <KeyReveal apiKey={newKey} onDone={() => setNewKey(null)} />}

        <Card title="Adding mailboxes">
          <div className="space-y-2">
            <Checkbox
              id="can-add"
              label="Can add mailboxes"
              checked={agent.canAddAccounts}
              onChange={(v) => canAdd.mutate(v)}
            />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Lets this agent add email accounts, for example from a list you give it (its{" "}
              <code>add_mailboxes</code> tool). New mailboxes wait under Accounts → Waiting for
              password until you enter the password, unless Settings → AI agents allows agents to
              send passwords.
            </p>
          </div>
        </Card>

        <Card
          title="Mailbox access"
          actions={
            (accountsQ.data?.accounts ?? []).length > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setAccessMode(accessMode === "bulk" ? null : "bulk")}
                >
                  Change several…
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setAccessMode(accessMode === "all" ? null : "all")}
                >
                  Give all permissions
                </Button>
              </div>
            )
          }
        >
          <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
            The agent can only see accounts you grant here, and only do what's checked. Every action
            is recorded in the audit log.
          </p>
          {accessSaved && (
            <div className="mb-4">
              <Alert tone="success" title={accessSaved} />
            </div>
          )}
          {accessMode === "bulk" && (
            <BulkGrantEditor
              agent={agent}
              accounts={accountsQ.data?.accounts ?? []}
              onDone={async () => {
                setAccessMode(null);
                setAccessSaved("Permissions saved. They apply on the agent's next request.");
                await refresh();
              }}
            />
          )}
          {accessMode === "all" && (
            <AllPermissions
              agent={agent}
              accounts={accountsQ.data?.accounts ?? []}
              onCancel={() => setAccessMode(null)}
              onDone={async () => {
                setAccessMode(null);
                setAccessSaved(`“${agent.name}” now has every permission on all mailboxes.`);
                await refresh();
              }}
            />
          )}
          <div className="space-y-3">
            {(accountsQ.data?.accounts ?? []).map((a) => (
              <GrantEditor
                key={`${a.id}-${q.dataUpdatedAt}`}
                agentId={id}
                account={a}
                grant={agent.grants.find((g) => g.accountId === a.id)}
              />
            ))}
            {(accountsQ.data?.accounts ?? []).length === 0 && (
              <p className="text-sm text-zinc-500">Add an account first.</p>
            )}
          </div>
        </Card>

        <Card
          title="API keys"
          actions={
            <Button variant="secondary" busy={issue.isPending} onClick={() => issue.mutate()}>
              New key
            </Button>
          }
        >
          {activeKeys.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No active keys. Create one to connect this agent.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {activeKeys.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span className="font-mono text-zinc-800 dark:text-zinc-200">{k.prefix}…</span>
                    <span className="ml-3 text-xs text-zinc-500">
                      created {relTime(k.createdAt)} · last used {relTime(k.lastUsedAt)}
                    </span>
                  </div>
                  <Button variant="ghost" onClick={() => revoke.mutate(k.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            MCP endpoint:{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{mcpUrl}</code>
          </p>
        </Card>

        <Card title="Delete agent" className="border-red-200 dark:border-red-900/60">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                Delete “{agent.name}”, its keys and permissions?
              </p>
              <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
                Yes, delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete agent
            </Button>
          )}
        </Card>
      </div>
    </>
  );
}

// ───────────────────────────── Permissions overview ─────────────────────────────

export function PermissionsPage() {
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentSummary[] }>("/agents"),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
  });
  const details = useQuery({
    queryKey: ["agent-details", agentsQ.data?.agents.map((a) => a.id).join(",")],
    enabled: !!agentsQ.data,
    queryFn: async () =>
      Promise.all(
        (agentsQ.data?.agents ?? []).map((a) =>
          api<{ agent: AgentDetail }>(`/agents/${a.id}`).then((r) => r.agent),
        ),
      ),
  });
  if (agentsQ.isLoading || accountsQ.isLoading || details.isLoading) return <Spinner />;
  const accounts = accountsQ.data?.accounts ?? [];
  const agents = details.data ?? [];
  const cell = (g?: Grant) => {
    if (!g) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
    const s = new Set(g.scopes);
    const parts = [
      s.has("mail:read") && "read",
      s.has("mail:organize") && "organize",
      s.has("mail:draft") && "drafts",
      s.has("mail:unsubscribe") && "unsubscribe",
      s.has("mail:send") &&
        (g.sendPolicy === "approve" ? "send (approval)" : g.sendPolicy === "allow" ? "send" : null),
      (s.has("mail:delete") || s.has("mail:delete:permanent")) && "delete",
    ].filter(Boolean);
    return <span className="text-xs text-zinc-700 dark:text-zinc-300">{parts.join(", ")}</span>;
  };
  return (
    <>
      <PageHeader
        title="Permissions"
        description="Who can do what in each mailbox. Click an agent to change its access."
      />
      {agents.length === 0 || accounts.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500">
            Add at least one account and one agent to manage permissions.
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                {accounts.map((a) => (
                  <th key={a.id} className="px-4 py-2.5 font-medium normal-case">
                    {accountName(a)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {agents.map((ag) => (
                <tr key={ag.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/agents/${ag.id}`}
                      className="font-medium text-zinc-900 hover:text-blue-600 dark:text-zinc-100"
                    >
                      {ag.name}
                    </Link>
                  </td>
                  {accounts.map((a) => (
                    <td key={a.id} className="px-4 py-3">
                      {cell(ag.grants.find((g) => g.accountId === a.id))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
