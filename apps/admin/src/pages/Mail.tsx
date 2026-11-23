import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui";
import {
  type AccountSummary,
  accountName,
  addr,
  api,
  type MailFolder,
  type MessageDetail,
  type MessagePage,
  type MessageSummary,
  shortDate,
  type UnsubscribeOutcome,
} from "../lib/api";

const ROLE_LABEL: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
  spam: "Spam",
  all: "All Mail",
  starred: "Starred",
  important: "Important",
};
const ROLE_ORDER = [
  "inbox",
  "starred",
  "important",
  "drafts",
  "sent",
  "archive",
  "all",
  "spam",
  "trash",
];

interface View {
  accountId?: string;
  folder: string; // role, path or id
  label: string;
}

// ───────────────────────────── HTML body (sandboxed) ─────────────────────────────

/**
 * Renders untrusted email HTML in a sandboxed iframe: no scripts, no forms, no same-origin
 * access. Remote images load unless Settings → Mail blocks them (tracking pixels), in which case
 * a CSP keeps them out until the user clicks "Show images".
 */
function HtmlBody({ html }: { html: string }) {
  const prefs = useQuery({
    queryKey: ["settings", "mail"],
    queryFn: () => api<{ value: { blockRemoteImages?: boolean } }>("/settings/mail"),
    staleTime: 60_000,
  });
  const [allowed, setAllowed] = useState(false);
  // Until the preference loads nothing remote is fetched; if it can't load, use the default (show).
  const block = prefs.data?.value.blockRemoteImages === true;
  const showImages = allowed || (!prefs.isLoading && !block);
  const ref = useRef<HTMLIFrameElement>(null);
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(html);
  const csp = showImages
    ? "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline'; font-src https: data:"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;color:#18181b;margin:0;padding:4px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;

  const resize = () => {
    const f = ref.current;
    if (f?.contentDocument?.body)
      f.style.height = `${f.contentDocument.documentElement.scrollHeight + 8}px`;
  };

  return (
    <div>
      {hasRemote && !showImages && !prefs.isLoading && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          Remote images are blocked to prevent tracking.
          <button
            type="button"
            onClick={() => setAllowed(true)}
            className="font-medium text-blue-600 hover:underline"
          >
            Show images
          </button>
        </div>
      )}
      <iframe
        ref={ref}
        title="Message content"
        // allow-same-origin only so we can measure height; scripts stay disabled.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        onLoad={resize}
        className="w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-700"
        style={{ minHeight: 120 }}
      />
    </div>
  );
}

// ───────────────────────────── Message view ─────────────────────────────

function MessageCard({
  m,
  expanded,
  onToggle,
}: {
  m: MessageDetail;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [plain, setPlain] = useState(!m.html);
  return (
    <article className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {addr(m.from)}{" "}
            <span className="font-normal text-zinc-500">&lt;{m.from?.email}&gt;</span>
          </p>
          {expanded ? (
            <p className="truncate text-xs text-zinc-500">
              to {m.to.map(addr).join(", ")}
              {m.cc.length > 0 && <> · cc {m.cc.map(addr).join(", ")}</>}
            </p>
          ) : (
            <p className="truncate text-xs text-zinc-500">{m.snippet}</p>
          )}
        </div>
        <time className="shrink-0 text-xs text-zinc-500" dateTime={m.date}>
          {new Date(m.date).toLocaleString()}
        </time>
      </button>
      {expanded && (
        <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
          {m.html && (
            <div className="mb-2 text-right">
              <button
                type="button"
                onClick={() => setPlain((p) => !p)}
                className="text-xs text-zinc-500 hover:underline"
              >
                {plain ? "Show formatted" : "Show plain text"}
              </button>
            </div>
          )}
          {m.html && !plain ? (
            <HtmlBody html={m.html} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-zinc-800 dark:text-zinc-200">
              {m.text || "(no text)"}
            </pre>
          )}
          {m.attachments.filter((a) => !a.inline).length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {m.attachments
                .filter((a) => !a.inline)
                .map((a) => (
                  <li key={a.id}>
                    <a
                      href={`/api/v1/mail/messages/${m.id}/attachments/${a.id}`}
                      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      📎 {a.filename ?? "attachment"}
                      {a.size ? (
                        <span className="text-zinc-400">{Math.ceil(a.size / 1024)} KB</span>
                      ) : null}
                    </a>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/** Leave the mailing list a message came from (List-Unsubscribe). */
function UnsubscribeButton({
  m,
  busy,
  onUnsubscribe,
}: {
  m: MessageDetail;
  busy: boolean;
  onUnsubscribe: () => void;
}) {
  const u = m.unsubscribe!;
  const sender = m.from?.name || m.from?.email || "this sender";
  if (u.unsubscribedAt)
    return (
      <Button
        variant="secondary"
        disabled
        title={`Unsubscribed ${new Date(u.unsubscribedAt).toLocaleString()}`}
      >
        Unsubscribed
      </Button>
    );
  if (u.method === "website" && u.website)
    return (
      <a
        href={u.website}
        target="_blank"
        rel="noopener noreferrer nofollow"
        title={`Opens ${sender}'s unsubscribe page`}
        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
      >
        Unsubscribe ↗
      </a>
    );
  return (
    <Button
      variant="secondary"
      busy={busy}
      title={
        u.method === "one_click"
          ? `Unsubscribe from ${sender} with their one-click link`
          : `Send ${sender} an unsubscribe email`
      }
      onClick={() => {
        if (
          window.confirm(
            `Unsubscribe from ${sender}?\n\n${
              u.method === "one_click"
                ? "MailMCP will use the sender's one-click unsubscribe link."
                : "MailMCP will send the sender an unsubscribe email from this account."
            }`,
          )
        )
          onUnsubscribe();
      }}
    >
      Unsubscribe
    </Button>
  );
}

function Reader({
  id,
  onClose,
  onChanged,
  onRemove,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
  /** Delete or archive: the page hides the message and opens the next one right away. */
  onRemove: (kind: "trash" | "archive") => void;
}) {
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ["thread", id],
    queryFn: () => api<{ messages: MessageDetail[] }>(`/mail/messages/${id}/thread`),
  });
  const [open, setOpen] = useState<Set<number>>(new Set([id]));
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const msgs = thread.data?.messages ?? [];
  const current = msgs.find((m) => m.id === id) ?? msgs.at(-1);

  useEffect(() => {
    setOpen(new Set([id]));
    setReplying(false);
    setReply("");
    setNote(null);
    setErr(null);
  }, [id]);

  const act = useMutation({
    mutationFn: async (a: { kind: "read" | "unread" | "flag" | "unflag" }) => {
      const body =
        a.kind === "read" || a.kind === "unread"
          ? { read: a.kind === "read" }
          : { flagged: a.kind === "flag" };
      return api("/mail/messages/mark", { method: "POST", body: { ids: [id], ...body } });
    },
    onMutate: () => setErr(null),
    onSuccess: async () => {
      onChanged();
      await qc.invalidateQueries({ queryKey: ["thread", id] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const unsubscribe = useMutation({
    mutationFn: (messageId: number) =>
      api<UnsubscribeOutcome>(`/mail/messages/${messageId}/unsubscribe`, { method: "POST" }),
    onMutate: () => {
      setErr(null);
      setNote(null);
    },
    onSuccess: (r, messageId) => {
      setNote(r.note);
      if (r.status === "unsubscribed") {
        const at = new Date().toISOString();
        qc.setQueryData<{ messages: MessageDetail[] }>(
          ["thread", id],
          (t) =>
            t && {
              messages: t.messages.map((m) =>
                m.id === messageId && m.unsubscribe
                  ? { ...m, unsubscribe: { ...m.unsubscribe, unsubscribedAt: at } }
                  : m,
              ),
            },
        );
      }
      void qc.invalidateQueries({ queryKey: ["thread", id] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const send = useMutation({
    mutationFn: () => api(`/mail/messages/${id}/reply`, { method: "POST", body: { text: reply } }),
    onSuccess: () => {
      setReplying(false);
      setReply("");
      setNote("Reply sent.");
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });

  if (thread.isLoading) return <Spinner />;
  if (thread.error)
    return (
      <Alert tone="error" title="Couldn't open this message">
        {(thread.error as Error).message}
      </Alert>
    );
  if (!current) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="mb-1 text-xs text-zinc-500 hover:underline lg:hidden"
          >
            ← Back to list
          </button>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {current.subject || "(no subject)"}
          </h2>
          <p className="text-xs text-zinc-500">
            {current.account}
            {current.accountLabel && <> ({current.accountLabel})</>} · {current.folders.join(", ")}
            {msgs.length > 1 && <> · {msgs.length} messages</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            onClick={() => act.mutate({ kind: current.unread ? "read" : "unread" })}
          >
            Mark {current.unread ? "read" : "unread"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => act.mutate({ kind: current.flagged ? "unflag" : "flag" })}
          >
            {current.flagged ? "Unflag" : "Flag"}
          </Button>
          {current.unsubscribe && (
            <UnsubscribeButton
              m={current}
              busy={unsubscribe.isPending}
              onUnsubscribe={() => unsubscribe.mutate(current.id)}
            />
          )}
          <Button variant="secondary" onClick={() => onRemove("archive")}>
            Archive
          </Button>
          <Button
            variant="secondary"
            onClick={() => onRemove("trash")}
            title="Delete (Delete key)"
            aria-keyshortcuts="Delete"
          >
            Delete
          </Button>
        </div>
      </div>
      {err && <Alert tone="error" title={err} />}
      {note && <Alert tone="success" title={note} />}
      {msgs.map((m) => (
        <MessageCard
          key={m.id}
          m={m}
          expanded={open.has(m.id) || msgs.length === 1}
          onToggle={() =>
            setOpen((s) => {
              const n = new Set(s);
              n.has(m.id) ? n.delete(m.id) : n.add(m.id);
              return n;
            })
          }
        />
      ))}
      {replying ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            send.mutate();
          }}
          className="space-y-2"
        >
          <label htmlFor="reply" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Reply to {addr(current.replyTo[0] ?? current.from)}
          </label>
          <textarea
            id="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={6}
            className="w-full rounded-md border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="flex gap-2">
            <Button type="submit" busy={send.isPending} disabled={!reply.trim()}>
              Send reply
            </Button>
            <Button type="button" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setReplying(true)}>
          Reply
        </Button>
      )}
    </div>
  );
}

// ───────────────────────────── Page ─────────────────────────────

export function MailPage() {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
  });
  const foldersQ = useQuery({
    queryKey: ["mail-folders"],
    queryFn: () => api<{ folders: MailFolder[] }>("/mail/folders"),
  });
  const [view, setView] = useState<View>({ folder: "inbox", label: "All inboxes" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  // Multi-select: checked rows, and the last row clicked (shift-click selects the range to it).
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const byAccountRef = useRef<Map<string, MailFolder[]>>(new Map());
  const [sort, setSort] = useState<string>(() => {
    try {
      return localStorage.getItem("mailmcp.sort") ?? "date:desc";
    } catch {
      return "date:desc";
    }
  });
  const changeSort = (v: string) => {
    setSort(v);
    setSelected(null);
    setChecked(new Set());
    try {
      localStorage.setItem("mailmcp.sort", v);
    } catch {
      // storage unavailable (private mode): keep it for this session only
    }
  };
  const [sortField, sortOrder] = sort.split(":") as [string, string];
  const [unreadOnly, setUnreadOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mailmcp.unreadOnly") === "1";
    } catch {
      return false;
    }
  });
  const toggleUnread = () => {
    const v = !unreadOnly;
    setUnreadOnly(v);
    setSelected(null);
    setChecked(new Set());
    try {
      localStorage.setItem("mailmcp.unreadOnly", v ? "1" : "0");
    } catch {
      // storage unavailable: keep it for this visit only
    }
  };

  const listKey = ["mail-list", view.accountId ?? "all", view.folder, query, sort, unreadOnly];
  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (view.accountId) p.set("accountId", view.accountId);
      if (pageParam) p.set("cursor", pageParam);
      p.set("limit", "50");
      p.set("sort", sortField);
      p.set("order", sortOrder);
      if (query) {
        p.set("q", unreadOnly ? `${query} is:unread` : query);
        return api<MessagePage>(`/mail/search?${p}`);
      }
      p.set("folder", view.folder);
      if (unreadOnly) p.set("unread", "true");
      return api<MessagePage>(`/mail/messages?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  // Messages deleted/archived from here disappear at once; the server call runs behind.
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const rows: MessageSummary[] = useMemo(
    () => (list.data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => !removed.has(m.id)),
    [list.data, removed],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mail-list"] });
    qc.invalidateQueries({ queryKey: ["mail-folders"] });
  };

  const viewFolder = (foldersQ.data?.folders ?? []).find((f) => String(f.id) === view.folder);
  const inTrash = viewFolder?.role === "trash";
  const confirmErase = (n: number) =>
    !inTrash ||
    window.confirm(
      `Permanently delete ${n === 1 ? "this message" : `${n} messages`}? They're already in Trash, so this can't be undone.`,
    );

  /** Change rows in every cached list at once (instant feedback before the server confirms). */
  const patchRows = (ids: number[], patch: Partial<MessageSummary>) => {
    const set = new Set(ids);
    qc.setQueriesData<InfiniteData<MessagePage>>({ queryKey: ["mail-list"] }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              messages: pg.messages.map((m) => (set.has(m.id) ? { ...m, ...patch } : m)),
            })),
          }
        : old,
    );
  };

  type BulkKind = "read" | "unread" | "flag" | "unflag" | "archive" | "trash" | "move";
  const LABELS: Record<BulkKind, string> = {
    read: "mark as read",
    unread: "mark as unread",
    flag: "flag",
    unflag: "unflag",
    archive: "archive",
    trash: "delete",
    move: "move",
  };

  /**
   * Apply an action to messages. Moves (delete/archive/move) hide them at once and, if the open
   * message is among them, open the next one; the server calls run behind (500 per request).
   */
  const act = async (ids: number[], kind: BulkKind, folder?: string | number) => {
    if (!ids.length) return;
    if (kind === "trash" && !confirmErase(ids.length)) return;
    const removes = kind === "archive" || kind === "trash" || kind === "move";
    setRemoveErr(null);
    if (removes) {
      const gone = new Set(ids);
      if (selected != null && gone.has(selected)) {
        const i = rows.findIndex((r) => r.id === selected);
        const next =
          rows.slice(i + 1).find((r) => !gone.has(r.id)) ??
          rows
            .slice(0, Math.max(0, i))
            .reverse()
            .find((r) => !gone.has(r.id));
        setSelected(next?.id ?? null);
      }
      setRemoved((s) => new Set([...s, ...ids]));
    }
    setChecked((c) => {
      const n = new Set(c);
      for (const id of ids) n.delete(id);
      return n;
    });
    if (!removes) {
      // Show the new read/flag state right away; the refresh afterwards confirms it.
      patchRows(
        ids,
        kind === "read" || kind === "unread"
          ? { unread: kind === "unread" }
          : { flagged: kind === "flag" },
      );
    }
    setBulkBusy(true);
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        if (kind === "trash")
          await api("/mail/messages/delete", { method: "POST", body: { ids: chunk } });
        else if (removes)
          await api("/mail/messages/move", {
            method: "POST",
            body: { ids: chunk, folder: kind === "archive" ? "archive" : folder },
          });
        else
          await api("/mail/messages/mark", {
            method: "POST",
            body:
              kind === "read" || kind === "unread"
                ? { ids: chunk, read: kind === "read" }
                : { ids: chunk, flagged: kind === "flag" },
          });
      }
    } catch (e) {
      if (removes)
        setRemoved((s) => {
          const n = new Set(s);
          for (const id of ids) n.delete(id);
          return n;
        });
      setRemoveErr(
        `Couldn't ${LABELS[kind]} ${ids.length === 1 ? "that message" : `${ids.length} messages`}: ${(e as Error).message}`,
      );
    } finally {
      setBulkBusy(false);
      refresh();
      if (selected != null) qc.invalidateQueries({ queryKey: ["thread", selected] });
    }
  };
  const removeMessage = (id: number, kind: "trash" | "archive") => act([id], kind);
  const checkedIds = rows.filter((r) => checked.has(r.id)).map((r) => r.id);

  /** Click a checkbox (or Ctrl/⌘-click a row); with Shift, select everything up to the last one. */
  const toggleCheck = (id: number, shift: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      const a = anchor == null ? -1 : rows.findIndex((r) => r.id === anchor);
      const b = rows.findIndex((r) => r.id === id);
      if (shift && a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          const rid = (rows[i] as MessageSummary).id;
          on ? next.add(rid) : next.delete(rid);
        }
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setAnchor(id);
  };
  const allChecked = rows.length > 0 && checkedIds.length === rows.length;
  const someChecked = checkedIds.length > 0 && !allChecked;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked;
  }, [someChecked]);

  // Folders the checked messages can move to: by id within one account, by name across several.
  const moveTargets = useMemo(() => {
    const accountIds = [...new Set(rows.filter((r) => checked.has(r.id)).map((r) => r.accountId))];
    if (!accountIds.length) return [];
    const usable = (f: MailFolder) => f.role !== "all" && f.role !== "drafts";
    const label = (f: MailFolder) => (f.role ? (ROLE_LABEL[f.role] ?? f.path) : f.path);
    if (accountIds.length === 1)
      return (byAccountRef.current.get(accountIds[0] as string) ?? [])
        .filter(usable)
        .map((f) => ({ value: String(f.id), label: label(f) }));
    const lists = accountIds.map((id) => (byAccountRef.current.get(id) ?? []).filter(usable));
    const keyOf = (f: MailFolder) => f.role ?? f.path.toLowerCase();
    const first = lists[0] ?? [];
    return first
      .filter((f) => lists.every((l) => l.some((g) => keyOf(g) === keyOf(f))))
      .map((f) => ({ value: `name:${keyOf(f)}`, label: label(f) }));
  }, [rows, checked]);

  // Keyboard: Delete/Backspace deletes the open message, J/K move down/up the list.
  const keyState = useRef({ selected, rows, removeMessage, checkedIds, act, toggleCheck });
  keyState.current = { selected, rows, removeMessage, checkedIds, act, toggleCheck };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"))
        return;
      const k = keyState.current;
      const { selected: sel, rows: list, removeMessage: remove } = k;
      if ((e.key === "Delete" || e.key === "Backspace") && k.checkedIds.length) {
        e.preventDefault();
        void k.act(k.checkedIds, "trash");
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel != null) {
        e.preventDefault();
        void remove(sel, "trash");
      } else if (e.key === "x" && sel != null) {
        e.preventDefault();
        k.toggleCheck(sel, false);
      } else if (e.key === "Escape" && k.checkedIds.length) {
        e.preventDefault();
        setChecked(new Set());
      } else if (e.key === "j" || e.key === "k") {
        const i = sel == null ? -1 : list.findIndex((r) => r.id === sel);
        const target = e.key === "j" ? list[i + 1] : list[Math.max(0, i - 1)];
        if (target) {
          e.preventDefault();
          setSelected(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (selected != null)
      document.getElementById(`msg-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Opening an unread message marks it read once it has been open for a moment (so skimming
  // past with J/K doesn't). The row stays in an "Unread only" list until the list refreshes.
  const openState = useRef({ rows, patchRows });
  openState.current = { rows, patchRows };
  useEffect(() => {
    if (selected == null) return;
    const row = openState.current.rows.find((r) => r.id === selected);
    if (!row?.unread) return;
    const t = setTimeout(async () => {
      openState.current.patchRows([selected], { unread: false });
      try {
        await api("/mail/messages/mark", { method: "POST", body: { ids: [selected], read: true } });
      } catch {
        // e.g. no permission to change flags: the next refresh shows the real state
      }
      qc.invalidateQueries({ queryKey: ["mail-folders"] });
      qc.invalidateQueries({ queryKey: ["thread", selected] });
    }, 700);
    return () => clearTimeout(t);
  }, [selected, qc]);

  // Folder list: each account folds away. With many accounts, start folded except the open one.
  const [expanded, setExpanded] = useState<Set<string> | null>(() => {
    try {
      const v = localStorage.getItem("mailmcp.expanded");
      return v ? new Set(JSON.parse(v) as string[]) : null;
    } catch {
      return null;
    }
  });
  const accountList = accountsQ.data?.accounts ?? [];
  const isOpen = (id: string) =>
    expanded ? expanded.has(id) : accountList.length <= 3 || view.accountId === id;
  const saveExpanded = (next: Set<string>) => {
    setExpanded(next);
    try {
      localStorage.setItem("mailmcp.expanded", JSON.stringify([...next]));
    } catch {
      // storage unavailable: remember for this visit only
    }
  };
  const toggleAccount = (id: string) => {
    const next = new Set(accountList.filter((a) => isOpen(a.id)).map((a) => a.id));
    next.has(id) ? next.delete(id) : next.add(id);
    saveExpanded(next);
  };
  const allOpen = accountList.length > 0 && accountList.every((a) => isOpen(a.id));

  const byAccount = useMemo(() => {
    const m = new Map<string, MailFolder[]>();
    for (const f of foldersQ.data?.folders ?? [])
      m.set(f.accountId, [...(m.get(f.accountId) ?? []), f]);
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ra = a.role ? ROLE_ORDER.indexOf(a.role) : 99;
        const rb = b.role ? ROLE_ORDER.indexOf(b.role) : 99;
        return ra - rb || a.path.localeCompare(b.path);
      });
    }
    return m;
  }, [foldersQ.data]);
  byAccountRef.current = byAccount;
  const totalUnread = (foldersQ.data?.folders ?? [])
    .filter((f) => f.role === "inbox")
    .reduce((n, f) => n + f.unreadCount, 0);

  const pick = (v: View) => {
    setChecked(new Set());
    setAnchor(null);
    setRemoved(new Set());
    setRemoveErr(null);
    setView(v);
    setQuery("");
    setSearch("");
    setSelected(null);
  };

  const navItem = (active: boolean) =>
    `flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm ${
      active
        ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
    }`;

  if (accountsQ.data && accountsQ.data.accounts.length === 0) {
    return (
      <Alert tone="info" title="No accounts yet">
        Add an account under Accounts to start browsing mail.
      </Alert>
    );
  }

  return (
    <div className="flex h-full min-h-[600px]">
      {/* Folders */}
      <nav
        aria-label="Mailboxes"
        className="hidden w-60 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-3 md:block dark:border-zinc-800 dark:bg-zinc-900"
      >
        <button
          type="button"
          className={navItem(!view.accountId && view.folder === "inbox" && !query)}
          onClick={() => pick({ folder: "inbox", label: "All inboxes" })}
        >
          All inboxes
          {totalUnread > 0 && (
            <span className="text-xs tabular-nums">{totalUnread.toLocaleString()}</span>
          )}
        </button>
        {accountList.length > 1 && (
          <div className="mt-3 flex justify-end px-1">
            <button
              type="button"
              onClick={() => saveExpanded(new Set(allOpen ? [] : accountList.map((a) => a.id)))}
              className="text-xs text-zinc-500 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        )}
        {accountList.map((a) => {
          const open = isOpen(a.id);
          const folders = byAccount.get(a.id) ?? [];
          const unread = folders
            .filter((f) => f.role === "inbox")
            .reduce((n, f) => n + f.unreadCount, 0);
          return (
            <div key={a.id} className="mt-2">
              <button
                type="button"
                onClick={() => toggleAccount(a.id)}
                aria-expanded={open}
                aria-controls={`folders-${a.id}`}
                title={a.address}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                  className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                >
                  <path d="M7.2 4.2a.75.75 0 0 1 1.06 0l5.25 5.25a.75.75 0 0 1 0 1.06L8.26 15.8a.75.75 0 1 1-1.06-1.06L11.94 10 7.2 5.26a.75.75 0 0 1 0-1.06Z" />
                </svg>
                <span className="min-w-0 flex-1 truncate">
                  {a.displayName ?? a.address}
                  {a.label && (
                    <span className="ml-1.5 font-normal normal-case tracking-normal text-zinc-400 dark:text-zinc-500">
                      {a.label}
                    </span>
                  )}
                </span>
                {!open && unread > 0 && (
                  <span className="text-xs font-normal normal-case tabular-nums text-blue-600 dark:text-blue-400">
                    {unread.toLocaleString()}
                  </span>
                )}
              </button>
              {open && (
                <div id={`folders-${a.id}`} className="mt-0.5">
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={navItem(
                        view.accountId === a.id && view.folder === String(f.id) && !query,
                      )}
                      onClick={() =>
                        pick({
                          accountId: a.id,
                          folder: String(f.id),
                          label: `${accountName(a)} · ${f.role ? ROLE_LABEL[f.role] : f.path}`,
                        })
                      }
                    >
                      <span className="truncate pl-4">{f.role ? ROLE_LABEL[f.role] : f.path}</span>
                      {f.unreadCount > 0 && f.role !== "trash" && f.role !== "spam" && (
                        <span className="text-xs tabular-nums">
                          {f.unreadCount.toLocaleString()}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* List */}
      <section
        className={`flex w-full flex-col border-r border-zinc-200 lg:w-96 lg:shrink-0 dark:border-zinc-800 ${selected ? "hidden lg:flex" : "flex"}`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            setSelected(null);
            setChecked(new Set());
          }}
          className="border-b border-zinc-200 p-3 dark:border-zinc-800"
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search: invoice from:dana has:attachment"
            aria-label="Search mail"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-xs text-zinc-500">
              {query
                ? `Results for “${query}”${view.accountId ? ` in ${view.label.split(" · ")[0]}` : ""}`
                : view.label}
            </p>
            <button
              type="button"
              onClick={toggleUnread}
              aria-pressed={unreadOnly}
              className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${
                unreadOnly
                  ? "border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              Unread only
            </button>
            <label className="flex shrink-0 items-center gap-1 text-xs text-zinc-500">
              <span className="sr-only sm:not-sr-only">Sort</span>
              <select
                value={sort}
                onChange={(e) => changeSort(e.target.value)}
                className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                <option value="date:desc">Newest first</option>
                <option value="date:asc">Oldest first</option>
                <option value="from:asc">Sender A→Z</option>
                <option value="from:desc">Sender Z→A</option>
                <option value="subject:asc">Subject A→Z</option>
                <option value="subject:desc">Subject Z→A</option>
              </select>
            </label>
          </div>
        </form>
        {rows.length > 0 && (
          <div
            role="toolbar"
            aria-label="Selected messages"
            className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
          >
            <label className="mr-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allChecked}
                onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
                className="size-4 accent-blue-600"
              />
              {checkedIds.length ? `${checkedIds.length} selected` : "Select all"}
            </label>
            {checkedIds.length > 0 && (
              <>
                {(
                  [
                    ["read", "Read"],
                    ["unread", "Unread"],
                    ["flag", "Flag"],
                    ["unflag", "Unflag"],
                    ["archive", "Archive"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void act(checkedIds, k)}
                    className="rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {label}
                  </button>
                ))}
                {moveTargets.length > 0 && (
                  <select
                    aria-label="Move selected to folder"
                    value=""
                    disabled={bulkBusy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      void act(checkedIds, "move", v.startsWith("name:") ? v.slice(5) : Number(v));
                    }}
                    className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    <option value="">Move to…</option>
                    {moveTargets.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void act(checkedIds, "trash")}
                  className="rounded border border-red-300 px-1.5 py-0.5 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {inTrash ? "Delete forever" : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setChecked(new Set())}
                  className="ml-auto text-zinc-500 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}
        {removeErr && (
          <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
            <Alert tone="error" title={removeErr} />
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-3">
              <Alert tone="error" title="Couldn't load messages">
                {(list.error as Error).message}
              </Alert>
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-zinc-500">
              {query
                ? "No matches."
                : unreadOnly
                  ? "No unread messages here."
                  : "No messages here yet. New accounts fill in as they sync."}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((m) => (
                <li
                  key={m.id}
                  id={`msg-${m.id}`}
                  className={`flex items-start ${
                    selected === m.id
                      ? "bg-blue-50 dark:bg-blue-950/40"
                      : checked.has(m.id)
                        ? "bg-amber-50/70 dark:bg-amber-950/20"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(m.id)}
                    onChange={() => {}}
                    onClick={(e) => toggleCheck(m.id, e.shiftKey)}
                    aria-label={`Select: ${m.subject || "(no subject)"}`}
                    className="ml-3 mt-3.5 size-4 shrink-0 cursor-pointer accent-blue-600"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      // Ctrl/⌘-click toggles selection, Shift-click selects a range; plain click opens.
                      if (e.metaKey || e.ctrlKey || e.shiftKey) {
                        e.preventDefault();
                        window.getSelection()?.removeAllRanges();
                        toggleCheck(m.id, e.shiftKey);
                      } else setSelected(m.id);
                    }}
                    aria-pressed={selected === m.id}
                    className="block min-w-0 flex-1 py-3 pl-2.5 pr-4 text-left"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-sm ${m.unread ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-300"}`}
                      >
                        {m.unread && (
                          <>
                            <span
                              className="mr-1.5 inline-block size-2 rounded-full bg-blue-600"
                              aria-hidden="true"
                            />
                            <span className="sr-only">Unread: </span>
                          </>
                        )}
                        {(sortField === "from" ? m.from?.email : addr(m.from)) ||
                          "(unknown sender)"}
                      </span>
                      <time className="shrink-0 text-xs text-zinc-500" dateTime={m.date}>
                        {shortDate(m.date)}
                      </time>
                    </div>
                    <p
                      className={`truncate text-sm ${m.unread ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}
                    >
                      {m.flagged && (
                        <>
                          <span aria-hidden="true">⚑ </span>
                          <span className="sr-only">Flagged: </span>
                        </>
                      )}
                      {m.subject || "(no subject)"}
                      {m.hasAttachments && (
                        <>
                          <span aria-hidden="true"> 📎</span>
                          <span className="sr-only"> (has attachments)</span>
                        </>
                      )}
                    </p>
                    <p className="truncate text-xs text-zinc-500">{m.snippet ?? ""}</p>
                    {!view.accountId && (accountsQ.data?.accounts.length ?? 0) > 1 && (
                      <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                        {m.account}
                        {m.accountLabel && ` · ${m.accountLabel}`}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="p-3 text-center">
              <Button
                variant="ghost"
                busy={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Reader */}
      <section
        className={`min-w-0 flex-1 overflow-y-auto bg-zinc-50 p-4 sm:p-6 dark:bg-zinc-950 ${selected ? "block" : "hidden lg:block"}`}
      >
        {selected ? (
          <Reader
            id={selected}
            onClose={() => setSelected(null)}
            onChanged={refresh}
            onRemove={(kind) => void removeMessage(selected, kind)}
          />
        ) : (
          <div className="mt-20 text-center text-sm text-zinc-500">
            <p>Select a message to read it.</p>
            <p className="mx-auto mt-2 max-w-sm text-xs text-zinc-400">
              Shortcuts: <kbd className="font-sans">J</kbd> / <kbd className="font-sans">K</kbd>{" "}
              next and previous · <kbd className="font-sans">Delete</kbd> deletes (the selected
              messages, or the open one) · <kbd className="font-sans">X</kbd> selects the open
              message · <kbd className="font-sans">Esc</kbd> clears the selection · Shift-click
              selects a range, Ctrl/⌘-click adds one
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
