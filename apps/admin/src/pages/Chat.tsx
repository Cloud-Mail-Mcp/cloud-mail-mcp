import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Alert, Button, Card, PageHeader, Spinner } from "../components/ui";
import { type AgentSummary, api, formatUsd } from "../lib/api";

type Part = { key: string } & (
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; state: "running" | "ok" | "error" }
  | { kind: "notice"; text: string }
  | { kind: "usage"; tokens: number; costUsd: number }
);
type Turn = { key: string } & (
  | { role: "user"; text: string }
  | { role: "assistant"; parts: Part[] }
);
let seq = 0;
const nextKey = () => `k${++seq}`;

type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string }
  | { type: "tool_result"; id: string; isError: boolean }
  | { type: "notice"; text: string }
  | { type: "usage"; tokens: number; costUsd: number }
  | { type: "error"; message: string }
  | { type: "done"; history: unknown[] };

const toolLabel = (name: string) => name.replace(/_/g, " ");

/** Chat with Claude about your mail, acting as one of your agents (Settings → Assistant). */
export function ChatPage() {
  const status = useQuery({
    queryKey: ["chat-status"],
    queryFn: () => api<{ configured: boolean; model: string }>("/chat/status"),
  });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentSummary[] }>("/agents"),
  });
  const usable = (agentsQ.data?.agents ?? []).filter((a) => !a.disabled);
  const [agentId, setAgentId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentId && usable[0]) setAgentId(usable[0].id);
  }, [agentId, usable]);
  // Follow the conversation as it streams in.
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const reset = () => {
    stop.current?.abort();
    setTurns([]);
    setHistory([]);
    setErr(null);
  };

  /** Apply one streamed event to the assistant turn being written. */
  const apply = (e: ChatEvent) =>
    setTurns((ts) => {
      const last = ts.at(-1);
      if (!last || last.role !== "assistant") return ts;
      const parts = [...last.parts];
      if (e.type === "text") {
        const p = parts.at(-1);
        if (p?.kind === "text") parts[parts.length - 1] = { ...p, text: p.text + e.delta };
        else parts.push({ key: nextKey(), kind: "text", text: e.delta });
      } else if (e.type === "tool") {
        parts.push({ key: nextKey(), kind: "tool", id: e.id, name: e.name, state: "running" });
      } else if (e.type === "tool_result") {
        const i = parts.findIndex((p) => p.kind === "tool" && p.id === e.id);
        const p = parts[i];
        if (p?.kind === "tool") parts[i] = { ...p, state: e.isError ? "error" : "ok" };
      } else if (e.type === "notice") {
        parts.push({ key: nextKey(), kind: "notice", text: e.text });
      } else if (e.type === "usage") {
        parts.push({ key: nextKey(), kind: "usage", tokens: e.tokens, costUsd: e.costUsd });
      }
      return [...ts.slice(0, -1), { ...last, parts }];
    });

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const message = text.trim();
    if (!message || busy || !agentId) return;
    setErr(null);
    setText("");
    setBusy(true);
    setTurns((ts) => [
      ...ts,
      { key: nextKey(), role: "user", text: message },
      { key: nextKey(), role: "assistant", parts: [] },
    ]);
    const ctrl = new AbortController();
    stop.current = ctrl;
    try {
      const res = await fetch("/api/v1/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, text: message, history }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Chat failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          if (!line) continue;
          const e = JSON.parse(line) as ChatEvent;
          if (e.type === "done") setHistory(e.history);
          else if (e.type === "error") setErr(e.message);
          else apply(e);
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setErr((e as Error).message);
    } finally {
      setBusy(false);
      stop.current = null;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  if (status.isLoading || agentsQ.isLoading) return <Spinner />;
  if (!status.data?.configured) {
    return (
      <>
        <PageHeader title="Chat" description="Ask Claude about your mail." />
        <Card>
          <div className="space-y-3 py-4 text-center">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">Chat is off</p>
            <p className="mx-auto max-w-md text-sm text-zinc-500">
              Add your Anthropic API key in Settings → Assistant to chat with Claude here. Prefer
              not to? Connect Claude or ChatGPT from the Agents page instead.
            </p>
            <Link href="/settings" className="text-sm text-blue-600 hover:underline">
              Open Settings
            </Link>
          </div>
        </Card>
      </>
    );
  }
  if (usable.length === 0) {
    return (
      <>
        <PageHeader title="Chat" description="Ask Claude about your mail." />
        <Alert tone="info" title="Create an agent first">
          The chat acts as one of your agents, with that agent's mailbox permissions.{" "}
          <Link href="/agents" className="underline">
            Go to Agents
          </Link>
        </Alert>
      </>
    );
  }

  return (
    <div className="flex h-full min-h-[600px] flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Chat</h1>
          <p className="text-sm text-zinc-500">
            Claude works with your mail using the permissions of the agent you pick. Sends wait for
            approval if that agent's policy says so.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            Acting as
            <select
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                reset();
              }}
              disabled={busy}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="secondary" onClick={reset} disabled={turns.length === 0}>
            New chat
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {turns.length === 0 && (
          <div className="py-10 text-center text-sm text-zinc-500">
            <p>
              Try: “What came in from my bank this week?” or “Summarize unread mail in my work
              inbox.”
            </p>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={t.key} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">
                {t.text}
              </p>
            </div>
          ) : (
            <div key={t.key} className="max-w-[92%] space-y-2">
              {t.parts.length === 0 && busy && i === turns.length - 1 && (
                <p className="text-sm text-zinc-400">Thinking…</p>
              )}
              {t.parts.map((p) =>
                p.kind === "text" ? (
                  <p
                    key={p.key}
                    className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200"
                  >
                    {p.text}
                  </p>
                ) : p.kind === "tool" ? (
                  <p
                    key={p.key}
                    className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    <span aria-hidden="true">
                      {p.state === "running" ? "…" : p.state === "ok" ? "✓" : "✗"}
                    </span>
                    {toolLabel(p.name)}
                    {p.state === "error" && <span className="sr-only">(failed)</span>}
                  </p>
                ) : p.kind === "usage" ? (
                  <p
                    key={p.key}
                    className="text-[11px] text-zinc-400"
                    title="Estimated from Anthropic's list prices. Totals: Settings → AI usage."
                  >
                    {p.tokens.toLocaleString()} tokens · about {formatUsd(p.costUsd)}
                  </p>
                ) : (
                  <p key={p.key} className="text-xs italic text-zinc-500">
                    {p.text}
                  </p>
                ),
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      {err && (
        <div className="mt-3">
          <Alert tone="error" title={err} />
        </div>
      )}

      <form onSubmit={submit} className="mt-3 flex items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder="Ask about your mail… (Enter to send, Shift+Enter for a new line)"
          className="min-h-[44px] flex-1 resize-y rounded-md border border-zinc-300 bg-white p-2.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        {busy ? (
          <Button type="button" variant="secondary" onClick={() => stop.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!text.trim()}>
            Send
          </Button>
        )}
      </form>
    </div>
  );
}
