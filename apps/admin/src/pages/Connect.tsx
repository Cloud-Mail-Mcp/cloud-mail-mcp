import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert, Button, Card, Field, Input, Spinner } from "../components/ui";
import { ApiError, api } from "../lib/api";

type Preset = "none" | "read" | "assistant" | "send_approval";

interface ConsentInfo {
  request: {
    id: string;
    clientName: string;
    clientId: string;
    clientKind: string;
    redirectHost: string;
  };
  mailboxes: Array<{
    id: string;
    address: string;
    displayName: string | null;
    label: string | null;
  }>;
  existing: Array<{ id: string; name: string; clientId: string | null }>;
  presets: Array<{ key: Preset; label: string }>;
}

/**
 * OAuth consent: an AI app (Claude, ChatGPT…) asked to connect. The signed-in admin picks what it
 * can do in each mailbox, then the browser goes back to the app with a one-time code.
 */
export function ConnectPage() {
  const requestId = new URLSearchParams(window.location.search).get("request") ?? "";
  const info = useQuery({
    queryKey: ["oauth-request", requestId],
    queryFn: () => api<ConsentInfo>(`/oauth/requests/${requestId}`),
    enabled: !!requestId,
  });

  const [name, setName] = useState("");
  const [reuse, setReuse] = useState<string>("");
  const [allPreset, setAllPreset] = useState<Preset>("read");
  const [perBox, setPerBox] = useState<Record<string, Preset>>({});

  useEffect(() => {
    if (!info.data) return;
    setName(info.data.request.clientName);
    // Reconnecting the same app: offer to update its existing connection instead of adding one.
    const prior = info.data.existing.find((e) => e.clientId === info.data.request.clientId);
    if (prior) setReuse(prior.id);
  }, [info.data]);

  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api<{ redirect: string }>(`/oauth/requests/${requestId}`, {
        method: "POST",
        body:
          decision === "deny"
            ? { decision }
            : {
                decision,
                name,
                agentId: reuse || null,
                accounts: (info.data?.mailboxes ?? []).map((m) => ({
                  accountId: m.id,
                  preset: perBox[m.id] ?? allPreset,
                })),
              },
      }),
    onSuccess: (r) => window.location.assign(r.redirect),
  });

  if (!requestId)
    return (
      <Frame>
        <Alert tone="error" title="Nothing to approve here." />
      </Frame>
    );
  if (info.isLoading) return <Spinner />;
  if (info.error) {
    const expired = info.error instanceof ApiError && info.error.status === 404;
    return (
      <Frame>
        <Alert tone="error" title={expired ? "This request expired" : "Couldn't load the request"}>
          {expired
            ? "Go back to your AI app and start connecting again."
            : (info.error as Error).message}
        </Alert>
      </Frame>
    );
  }
  const d = info.data as ConsentInfo;
  const granted = d.mailboxes.filter((m) => (perBox[m.id] ?? allPreset) !== "none").length;

  return (
    <Frame>
      <Card>
        <div className="space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Connect {d.request.clientName} to your mail?
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              After you approve, you'll go back to{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                {d.request.redirectHost}
              </span>
              . You can change or remove this access any time under Agents.
            </p>
          </div>

          {d.existing.length > 0 && (
            <Field label="Connection" htmlFor="reuse">
              <select
                id="reuse"
                value={reuse}
                onChange={(e) => setReuse(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value="">Add a new connection</option>
                {d.existing.map((e) => (
                  <option key={e.id} value={e.id}>
                    Update “{e.name}”
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Name" htmlFor="name" hint="How this app appears in MailMCP's Agents list.">
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </Field>

          {d.mailboxes.length === 0 ? (
            <Alert tone="warning" title="No mailboxes yet">
              Add a mailbox in MailMCP first; this app would have nothing to read.
            </Alert>
          ) : (
            <div className="space-y-3">
              <Field label="Access to all mailboxes" htmlFor="all">
                <PresetSelect
                  id="all"
                  value={allPreset}
                  presets={d.presets}
                  onChange={(p) => {
                    setAllPreset(p);
                    setPerBox({});
                  }}
                />
              </Field>
              {d.mailboxes.length > 1 && (
                <details className="rounded-md border border-zinc-200 dark:border-zinc-800">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300">
                    Choose per mailbox ({granted} of {d.mailboxes.length} allowed)
                  </summary>
                  <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {d.mailboxes.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200">
                          {m.displayName ? `${m.displayName} · ` : ""}
                          {m.address}
                          {m.label && <span className="text-zinc-500"> · {m.label}</span>}
                        </span>
                        <PresetSelect
                          value={perBox[m.id] ?? allPreset}
                          presets={d.presets}
                          onChange={(p) => setPerBox((s) => ({ ...s, [m.id]: p }))}
                          label={`Access to ${m.address}`}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Sending always waits for your approval in MailMCP unless you change it later.
                Deleting mail isn't included in these choices; grant it per agent if you need it.
              </p>
            </div>
          )}

          {decide.error && <Alert tone="error" title={(decide.error as Error).message} />}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => decide.mutate("deny")}
              disabled={decide.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => decide.mutate("approve")}
              busy={decide.isPending}
              disabled={d.mailboxes.length > 0 && granted === 0}
            >
              Approve
            </Button>
          </div>
        </div>
      </Card>
    </Frame>
  );
}

function PresetSelect({
  id,
  value,
  presets,
  onChange,
  label,
}: {
  id?: string;
  value: Preset;
  presets: ConsentInfo["presets"];
  onChange: (p: Preset) => void;
  label?: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as Preset)}
      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {presets.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <div className="w-full max-w-lg">
        <p className="mb-4 text-center text-sm font-semibold text-zinc-500 dark:text-zinc-400">
          MailMCP
        </p>
        {children}
      </div>
    </main>
  );
}
