import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Alert, Button, Field, Input } from "../components/ui";
import { type ApiError, api } from "../lib/api";

function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-blue-600 text-lg font-bold text-white">
            M
          </div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{title}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Step 1 of the setup wizard: create the workspace and its owner (signs you in). */
export function OwnerForm() {
  const qc = useQueryClient();
  const [f, setF] = useState({
    orgName: "My MailMCP",
    name: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/setup", {
        method: "POST",
        body: { orgName: f.orgName, name: f.name, email: f.email, password: f.password },
      });
      await qc.invalidateQueries();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={submit} className="space-y-4">
        {err && !err.fields && <Alert tone="error" title={err.message} />}
        <Field label="Workspace name" htmlFor="org">
          <Input id="org" value={f.orgName} onChange={set("orgName")} required />
        </Field>
        <Field label="Your name" htmlFor="name">
          <Input id="name" value={f.name} onChange={set("name")} autoComplete="name" />
        </Field>
        <Field label="Email" htmlFor="email" error={err?.fields?.email}>
          <Input
            id="email"
            type="email"
            value={f.email}
            onChange={set("email")}
            autoComplete="email"
            required
          />
        </Field>
        <Field
          label="Password"
          htmlFor="pw"
          hint="At least 10 characters."
          error={err?.fields?.password}
        >
          <Input
            id="pw"
            type="password"
            value={f.password}
            onChange={set("password")}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </Field>
        <Field
          label="Confirm password"
          htmlFor="pw2"
          error={mismatch ? "Passwords don't match" : undefined}
        >
          <Input
            id="pw2"
            type="password"
            value={f.confirm}
            onChange={set("confirm")}
            autoComplete="new-password"
            invalid={mismatch}
            required
          />
        </Field>
        <Button type="submit" busy={busy} className="w-full">
          Create account
        </Button>
      </form>
    </>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/auth/login", { method: "POST", body: { email, password } });
      await qc.invalidateQueries();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in to MailMCP" subtitle="Admin panel">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert tone="error" title={err} />}
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </Field>
        <Field label="Password" htmlFor="pw">
          <Input
            id="pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" busy={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
