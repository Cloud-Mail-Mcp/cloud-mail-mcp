import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "wouter";
import { Alert, Button, Card, Checkbox, Field, Input, PageHeader, Spinner } from "../components/ui";
import { type ApiError, api } from "../lib/api";

type Action = "none" | "mark_read" | "archive" | "spam" | "folder";
interface Tag {
  id: string;
  name: string;
  description: string;
  action: Action;
  /** For "folder": the folder the mail moves to. */
  folder: string;
}
interface Sorter {
  enabled: boolean;
  model: "claude-haiku-5-5" | "claude-sonnet-5-5";
  tags: Tag[];
  instructions: string;
  dailyLimit: number;
  backfillFrom: string | null;
}
interface Status {
  enabled: boolean;
  hasApiKey: boolean;
  dailyLimit: number;
  today: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    errors: number;
    lastError: string | null;
  };
}

const ACTIONS: Record<Action, string> = {
  none: "Leave in inbox",
  mark_read: "Mark as read",
  archive: "Archive",
  spam: "Move to Spam",
  folder: "Move to a folder…",
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
const fmt = (n: number) => n.toLocaleString();
const field =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export function SortingPage() {
  return (
    <>
      <PageHeader
        title="Spam & sorting"
        description="Sort new mail by what it is with Claude, and keep unwanted senders out of your inbox."
      />
      <div className="space-y-6">
        <SorterCards />
        <BackfillCard />
        <BlockedSendersCard />
        <LearnedCard />
        <TipsCard />
      </div>
    </>
  );
}

function SorterCards() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings", "sorter"],
    queryFn: () => api<{ value: Sorter }>("/settings/sorter"),
  });
  const status = useQuery({
    queryKey: ["sorter-status"],
    queryFn: () => api<Status>("/sorter/status"),
    refetchInterval: 30_000,
  });
  const [d, setD] = useState<Sorter | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setD(q.data.value);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (v: Sorter) =>
      api<{ value: Sorter }>("/settings/sorter", { method: "PUT", body: v }),
    onMutate: () => setSaved(false),
    onSuccess: (r) => {
      qc.setQueryData(["settings", "sorter"], r);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["sorter-status"] });
      void qc.invalidateQueries({ queryKey: ["mail-tags"] });
    },
  });
  if (q.isLoading || !d) return <Spinner />;
  const set = (patch: Partial<Sorter>) => {
    setSaved(false);
    setD({ ...d, ...patch });
  };
  const setTag = (i: number, patch: Partial<Tag>) =>
    set({ tags: d.tags.map((t, n) => (n === i ? { ...t, ...patch } : t)) });
  const s = status.data;
  const err = save.error as ApiError | null;

  return (
    <>
      <Card title="AI sorting">
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Claude reads each new message in your inboxes and tags it by what it is: personal,
            solicitation, newsletter, social media and so on. Filter your mail by tag, give each tag
            an action below, or ask Claude in Chat to act on a whole kind of mail at once. It uses
            the Anthropic API key from Settings → Assistant; usage is billed to your Anthropic
            account.
          </p>
          {s && !s.hasApiKey && (
            <Alert tone="warning" title="Add an Anthropic API key first">
              Under{" "}
              <Link href="/settings" className="font-medium underline">
                Settings → Assistant
              </Link>
              . Blocked senders below work without one.
            </Alert>
          )}
          <Checkbox
            id="sorter-on"
            label="Sort new mail with AI"
            checked={d.enabled}
            onChange={(v) => set({ enabled: v })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" htmlFor="sorter-model" hint="Haiku is fast and costs the least.">
              <select
                id="sorter-model"
                value={d.model}
                onChange={(e) => set({ model: e.target.value as Sorter["model"] })}
                className={field}
              >
                <option value="claude-haiku-5-5">Claude Haiku 5.5 (recommended)</option>
                <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (more careful)</option>
              </select>
            </Field>
            <Field
              label="Most messages per day"
              htmlFor="sorter-limit"
              hint="A cost limit. Mail beyond it waits until tomorrow."
            >
              <Input
                id="sorter-limit"
                type="number"
                min={0}
                value={d.dailyLimit}
                onChange={(e) => set({ dailyLimit: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
          <Field
            label="Anything Claude should know"
            htmlFor="sorter-notes"
            hint='For example: "Mail from @mycompany.example is from colleagues. Messages about the Smith project are personal."'
          >
            <textarea
              id="sorter-notes"
              rows={3}
              maxLength={2000}
              value={d.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              className={field}
            />
          </Field>
          {s && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Today: {fmt(s.today.messages)} of {fmt(s.dailyLimit)} messages sorted ·{" "}
              {fmt(s.today.inputTokens)} input and {fmt(s.today.outputTokens)} output tokens
            </p>
          )}
          {s?.today.lastError && (
            <Alert tone="error" title="Last problem">
              {s.today.lastError}
            </Alert>
          )}
        </div>
      </Card>

      <Card
        title="Tags"
        actions={
          <Button
            variant="ghost"
            onClick={() =>
              set({
                tags: [
                  ...d.tags,
                  { id: "", name: "", description: "", action: "none", folder: "" },
                ],
              })
            }
          >
            Add tag
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Each message gets one tag. The description tells Claude what belongs there. The action
            runs on new mail that gets the tag (changing a tag on a message never moves it). A
            folder that doesn't exist yet is created in each mailbox the first time it's needed.
          </p>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.tags.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, ids can change
              <li key={i} className="grid gap-2 py-3 sm:grid-cols-[10rem_1fr_10rem_auto]">
                <div>
                  <Input
                    aria-label="Tag name"
                    placeholder="Name"
                    value={t.name}
                    onChange={(e) =>
                      setTag(i, {
                        name: e.target.value,
                        // New tags get an id from their name; existing ones keep theirs.
                        ...(q.data?.value.tags.some((o) => o.id === t.id) && t.id
                          ? {}
                          : { id: slug(e.target.value) }),
                      })
                    }
                  />
                  <p className="mt-1 font-mono text-[11px] text-zinc-400">tag:{t.id || "…"}</p>
                </div>
                <textarea
                  aria-label={`What belongs in ${t.name || "this tag"}`}
                  rows={2}
                  maxLength={300}
                  value={t.description}
                  onChange={(e) => setTag(i, { description: e.target.value })}
                  className={field}
                />
                <div className="space-y-1.5 self-start">
                  <select
                    aria-label={`Action for ${t.name || "this tag"}`}
                    value={t.action}
                    onChange={(e) =>
                      setTag(i, {
                        action: e.target.value as Action,
                        // Suggest the tag's name as the folder.
                        ...(e.target.value === "folder" && !t.folder ? { folder: t.name } : {}),
                      })
                    }
                    className={field}
                  >
                    {(Object.keys(ACTIONS) as Action[]).map((a) => (
                      <option key={a} value={a}>
                        {ACTIONS[a]}
                      </option>
                    ))}
                  </select>
                  {t.action === "folder" && (
                    <Input
                      aria-label={`Folder for ${t.name || "this tag"}`}
                      placeholder="Folder name"
                      value={t.folder ?? ""}
                      onChange={(e) => setTag(i, { folder: e.target.value })}
                    />
                  )}
                </div>
                <Button
                  variant="ghost"
                  className="self-start"
                  disabled={d.tags.length === 1}
                  onClick={() => set({ tags: d.tags.filter((_, n) => n !== i) })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {err && <Alert tone="error" title={err.message} />}
          {saved && <Alert tone="success" title="Saved." />}
          <div className="flex flex-wrap gap-2">
            <Button
              busy={save.isPending}
              onClick={() => save.mutate({ ...d, tags: d.tags.filter((t) => t.name.trim()) })}
            >
              Save
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

function BackfillCard() {
  const qc = useQueryClient();
  const go = useMutation({
    mutationFn: (days: number) =>
      api<{ accounts: number }>("/sorter/backfill", { method: "POST", body: { days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "sorter"] }),
  });
  return (
    <Card title="Sort older mail">
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          New mail is sorted as it arrives. To tag what's already in your inboxes, choose how far
          back to go. Each message counts toward the daily limit.
        </p>
        <div className="flex flex-wrap gap-2">
          {[7, 30, 90].map((days) => (
            <Button
              key={days}
              variant="secondary"
              busy={go.isPending && go.variables === days}
              disabled={go.isPending}
              onClick={() => go.mutate(days)}
            >
              Last {days} days
            </Button>
          ))}
        </div>
        {go.isSuccess && (
          <Alert tone="success" title="Sorting started.">
            Tags appear in Mail over the next few minutes.
          </Alert>
        )}
        {go.error && <Alert tone="error" title={(go.error as Error).message} />}
      </div>
    </Card>
  );
}

function BlockedSendersCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["sorter-senders"],
    queryFn: () =>
      api<{
        senders: Array<{ id: string; pattern: string; account: string | null; createdAt: string }>;
      }>("/sorter/senders"),
  });
  const [pattern, setPattern] = useState("");
  const add = useMutation({
    mutationFn: () => api("/sorter/senders", { method: "POST", body: { pattern } }),
    onSuccess: () => {
      setPattern("");
      void qc.invalidateQueries({ queryKey: ["sorter-senders"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sorter/senders/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sorter-senders"] }),
  });
  const list = q.data?.senders ?? [];
  return (
    <Card title={`Blocked senders${list.length ? ` · ${list.length}` : ""}`}>
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          New mail from these goes straight to Spam (no AI needed). Add one from any message with{" "}
          <b>Spam → always send mail from…</b>, or here. Use <code>@example.com</code> for a whole
          domain. Marking a message <b>Not spam</b> unblocks its sender.
        </p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (pattern.trim()) add.mutate();
          }}
        >
          <Input
            aria-label="Address or @domain to block"
            placeholder="deals@shop.example or @shop.example"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" variant="secondary" busy={add.isPending}>
            Block
          </Button>
        </form>
        {add.error && <Alert tone="error" title={(add.error as Error).message} />}
        {list.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {list.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-mono">{s.pattern}</span>
                  <span className="ml-2 text-xs text-zinc-500">
                    {s.account ? `in ${s.account}` : "all mailboxes"}
                  </span>
                </span>
                <Button variant="ghost" onClick={() => remove.mutate(s.id)}>
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function LearnedCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["sorter-examples"],
    queryFn: () =>
      api<{
        examples: Array<{ id: string; fromEmail: string; subject: string | null; tag: string }>;
      }>("/sorter/examples"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sorter/examples/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sorter-examples"] }),
  });
  const list = q.data?.examples ?? [];
  return (
    <Card title={`What the sorter has learned${list.length ? ` · ${list.length}` : ""}`}>
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          When you change a message's tag or mark it as spam, Cloud Mail MCP remembers it for that
          sender: their next messages get the same tag without asking the AI, and the latest
          corrections are shown to Claude as examples for similar mail.
        </p>
        {list.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Nothing yet. Change a message's <b>Kind</b> in Mail to teach it.
          </p>
        ) : (
          <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {list.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-mono">{e.fromEmail}</span> →{" "}
                  <span className="font-medium">{e.tag}</span>
                  {e.subject && <span className="ml-2 text-xs text-zinc-500">“{e.subject}”</span>}
                </span>
                <Button variant="ghost" onClick={() => remove.mutate(e.id)}>
                  Forget
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function TipsCard() {
  return (
    <Card title="Ask Claude to act on a kind of mail">
      <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
        <p>
          In <b>Chat</b> (or any AI app connected to Cloud Mail MCP), Claude can find mail by tag
          and act on all of it. For example:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>“Delete all social media emails in my inbox.”</li>
          <li>“Reply ‘Not interested, thanks’ to every solicitation from this week.”</li>
          <li>“Unsubscribe me from the marketing emails I never open.”</li>
          <li>“Archive newsletters older than a week, and mark spam from my inbox.”</li>
        </ul>
        <p>
          It acts with the permissions of the agent the chat uses. Replies follow that agent's send
          policy, so they can wait for your approval under Approvals.
        </p>
      </div>
    </Card>
  );
}
