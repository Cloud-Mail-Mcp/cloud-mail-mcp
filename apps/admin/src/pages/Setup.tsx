import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { Alert, Button, Card } from "../components/ui";
import { type AccountDetail, api } from "../lib/api";
import { AddAccountForm } from "./Accounts";
import { OwnerForm } from "./Auth";
import { GeneralCard, StorageCard, SyncCard, SystemCard } from "./Settings";

const STEPS = [
  { title: "Your account", blurb: "Create the owner login for this server." },
  { title: "Server", blurb: "Name this server and set the address your AI clients will use." },
  {
    title: "Mail storage",
    blurb: "Choose where message bodies and attachments are kept. You can change this later.",
  },
  { title: "Sync", blurb: "How much mail to download. The defaults work well for most mailboxes." },
  {
    title: "Mailbox",
    blurb: "Connect the first mailbox MailMCP should index. You can add more any time under Accounts.",
  },
  { title: "Finish", blurb: "Back up your encryption key, then connect your AI." },
];

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-3" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={s.title}
            className="flex items-center gap-2"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                done
                  ? "bg-blue-600 text-white"
                  : active
                    ? "border-2 border-blue-600 text-blue-700 dark:text-blue-300"
                    : "border border-zinc-300 text-zinc-500 dark:border-zinc-700"
              }`}
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              className={`text-sm ${active ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-500"}`}
            >
              {s.title}
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className="mx-1 hidden h-px w-6 bg-zinc-300 sm:block dark:bg-zinc-700"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * First-run setup. Shown until it's completed (stored in settings as `setup.completedAt`).
 * Step 1 runs signed out; once the owner exists the wizard resumes at step 2 after sign-in.
 */
export function SetupWizard({ hasUsers }: { hasUsers: boolean }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(hasUsers ? 1 : 0);
  const next = () => {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
    window.scrollTo({ top: 0 });
  };
  const complete = useMutation({
    mutationFn: () => api("/setup/complete", { method: "POST" }),
    onSuccess: async (_d, to: string) => {
      navigate(to);
      await qc.invalidateQueries();
    },
  });
  const info = STEPS[step] as (typeof STEPS)[number];
  const [connected, setConnected] = useState<AccountDetail[]>([]);
  const [adding, setAdding] = useState(true);
  const [formKey, setFormKey] = useState(0);

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-10 dark:bg-zinc-950">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-blue-600 text-lg font-bold text-white">
            M
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Set up MailMCP
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This takes about two minutes and only happens once.
            </p>
          </div>
        </div>
        <Stepper current={step} />

        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{info.title}</h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">{info.blurb}</p>

        {step === 0 && (
          <Card>
            <div className="max-w-md">
              <OwnerForm />
            </div>
          </Card>
        )}
        {step === 1 && <GeneralCard onSaved={next} saveLabel="Save and continue" />}
        {step === 2 && <StorageCard onSaved={next} saveLabel="Save and continue" />}
        {step === 3 && <SyncCard onSaved={next} saveLabel="Save and continue" />}
        {step === 4 && (
          <div className="space-y-4">
            {connected.length > 0 && (
              <Alert tone="success" title={`Connected: ${connected.map((c) => c.address).join(", ")}`}>
                Syncing has started in the background.
              </Alert>
            )}
            {adding ? (
              <AddAccountForm
                key={formKey}
                onSaved={(a) => {
                  setConnected((c) => [...c, a]);
                  setAdding(false);
                }}
                secondary={
                  <Button type="button" variant="ghost" onClick={next}>
                    {connected.length ? "Done adding" : "Skip for now"}
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={next}>Continue</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFormKey((k) => k + 1);
                    setAdding(true);
                  }}
                >
                  Add another mailbox
                </Button>
              </div>
            )}
          </div>
        )}
        {step === 5 && (
          <div className="space-y-6">
            <SystemCard />
            <Card title="You're ready">
              <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                {connected.length
                  ? "Your mail is indexing in the background; the newest messages are searchable within minutes. "
                  : "You haven't connected a mailbox yet; add one under Accounts. "}
                Next, create an agent to connect Claude or your own AI app.
              </p>
              {complete.error && (
                <div className="mb-3">
                  <Alert tone="error" title={(complete.error as Error).message} />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  busy={complete.isPending && complete.variables === "/agents"}
                  onClick={() => complete.mutate("/agents")}
                >
                  Connect an AI agent
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => complete.mutate(connected.length ? "/mail" : "/accounts/new")}
                >
                  {connected.length ? "Open my mail" : "Add a mailbox"}
                </Button>
              </div>
            </Card>
          </div>
        )}

        {step > 1 && (
          <div className="mt-4">
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
              ← Back
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
