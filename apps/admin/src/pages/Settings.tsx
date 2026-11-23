import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import { type ApiError, api } from "../lib/api";
import { getPath, type Obj, setPath } from "../lib/config";

interface PublicSetting {
  value: Obj;
  secretsSet: Record<string, boolean>;
}

function useSetting(key: string, onSaved?: () => void) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings", key],
    queryFn: () => api<PublicSetting>(`/settings/${key}`),
  });
  const [draft, setDraft] = useState<Obj>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setDraft(q.data.value);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<PublicSetting>(`/settings/${key}`, { method: "PUT", body: draft }),
    onMutate: () => {
      setErr(null);
      setSaved(false);
    },
    onSuccess: (d) => {
      qc.setQueryData(["settings", key], d);
      setSaved(true);
      onSaved?.();
    },
    onError: (e) => setErr(e as ApiError),
  });
  const set = (path: string, v: unknown) => {
    setSaved(false);
    setDraft((d) => setPath(d, path, v));
  };
  return { q, draft, set, save, err, saved };
}

interface CardProps {
  /** Called after a successful save (the setup wizard uses it to advance). */
  onSaved?: () => void;
  saveLabel?: string;
}

export function StorageCard({ onSaved, saveLabel = "Save" }: CardProps = {}) {
  const s = useSetting("storage", onSaved);
  const [test, setTest] = useState<{ ok: boolean; error?: { message: string } } | null>(null);
  const testM = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; error?: { message: string } }>("/settings/storage/test", {
        method: "POST",
        body: s.draft,
      }),
    onMutate: () => setTest(null),
    onSuccess: setTest,
  });
  if (s.q.isLoading) return <Spinner />;
  const driver = getPath(s.draft, "driver") as string;
  const str = (p: string) => (getPath(s.draft, p) as string | undefined) ?? "";
  const secretSaved = s.q.data?.secretsSet["s3.secretAccessKey"];

  return (
    <Card title="Mail storage">
      <div className="space-y-5">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Where full message bodies and attachments are kept. Everything is compressed and encrypted
          before it's written.
        </p>
        <RadioGroup
          name="storage-driver"
          label="Store mail on"
          value={driver}
          onChange={(v) => s.set("driver", v)}
          options={[
            { value: "fs", label: "This server's disk" },
            { value: "s3", label: "S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO)" },
          ]}
        />

        {driver === "fs" ? (
          <div className="max-w-md">
            <Field
              label="Folder"
              htmlFor="fsroot"
              hint="Relative paths are inside the data directory (see System below)."
            >
              <Input
                id="fsroot"
                value={str("fs.root")}
                onChange={(e) => s.set("fs.root", e.target.value)}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Endpoint"
              htmlFor="ep"
              hint="Leave blank for AWS. R2: https://<account>.r2.cloudflarestorage.com"
            >
              <Input
                id="ep"
                value={str("s3.endpoint")}
                onChange={(e) => s.set("s3.endpoint", e.target.value)}
              />
            </Field>
            <Field label="Bucket" htmlFor="bk">
              <Input
                id="bk"
                value={str("s3.bucket")}
                onChange={(e) => s.set("s3.bucket", e.target.value)}
              />
            </Field>
            <Field label="Region" htmlFor="rg" hint="“auto” for R2.">
              <Input
                id="rg"
                value={str("s3.region")}
                onChange={(e) => s.set("s3.region", e.target.value)}
              />
            </Field>
            <Field label="Access key ID" htmlFor="ak">
              <Input
                id="ak"
                value={str("s3.accessKeyId")}
                onChange={(e) => s.set("s3.accessKeyId", e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Secret access key" htmlFor="sk">
              <Input
                id="sk"
                type="password"
                autoComplete="new-password"
                placeholder={secretSaved ? "Saved. Leave blank to keep." : ""}
                value={str("s3.secretAccessKey")}
                onChange={(e) => s.set("s3.secretAccessKey", e.target.value)}
              />
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox
                id="pathstyle"
                label="Path-style URLs (needed for MinIO)"
                checked={Boolean(getPath(s.draft, "s3.forcePathStyle"))}
                onChange={(v) => s.set("s3.forcePathStyle", v)}
              />
            </div>
          </div>
        )}

        <div className="max-w-xs">
          <Field
            label="Local cache size (MB)"
            htmlFor="cache"
            hint="Recently read mail is kept on local disk for speed."
          >
            <Input
              id="cache"
              type="number"
              min={0}
              value={String(getPath(s.draft, "cacheMaxMb") ?? "")}
              onChange={(e) => s.set("cacheMaxMb", Number(e.target.value))}
            />
          </Field>
        </div>

        {test &&
          (test.ok ? (
            <Alert
              tone="success"
              title="Storage works: wrote, read back, and deleted a test file."
            />
          ) : (
            <Alert tone="error" title="Storage test failed">
              {test.error?.message}
            </Alert>
          ))}
        {s.err && <Alert tone="error" title={s.err.message} />}
        {s.saved && <Alert tone="success" title="Storage settings saved." />}
        <div className="flex gap-2">
          <Button variant="secondary" busy={testM.isPending} onClick={() => testM.mutate()}>
            Test storage
          </Button>
          <Button busy={s.save.isPending} onClick={() => s.save.mutate()}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function SyncCard({ onSaved, saveLabel = "Save" }: CardProps = {}) {
  const s = useSetting("sync", onSaved);
  if (s.q.isLoading) return <Spinner />;
  const num = (p: string) => String(getPath(s.draft, p) ?? "");
  return (
    <Card title="Sync">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Download full bodies for the last (months)"
            htmlFor="bb"
            hint="Older mail is indexed by headers; bodies load on demand."
          >
            <Input
              id="bb"
              type="number"
              min={0}
              value={num("bodyBackfillMonths")}
              onChange={(e) => s.set("bodyBackfillMonths", Number(e.target.value))}
            />
          </Field>
          <Field label="Index headers for the last (months)" htmlFor="hb" hint="0 = all mail.">
            <Input
              id="hb"
              type="number"
              min={0}
              value={num("headerBackfillMonths")}
              onChange={(e) => s.set("headerBackfillMonths", Number(e.target.value))}
            />
          </Field>
          <Field label="Accounts syncing at once" htmlFor="cc">
            <Input
              id="cc"
              type="number"
              min={1}
              max={50}
              value={num("concurrency")}
              onChange={(e) => s.set("concurrency", Number(e.target.value))}
            />
          </Field>
        </div>
        {s.err && <Alert tone="error" title={s.err.message} />}
        {s.saved && <Alert tone="success" title="Sync settings saved." />}
        <Button busy={s.save.isPending} onClick={() => s.save.mutate()}>
          {saveLabel}
        </Button>
      </div>
    </Card>
  );
}

export function SystemCard() {
  const q = useQuery({
    queryKey: ["system"],
    queryFn: () =>
      api<{ dataDir: string; version: string; masterKey: { source: string; path?: string } }>(
        "/system",
      ),
  });
  if (!q.data) return null;
  const { masterKey } = q.data;
  return (
    <Card title="System">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-zinc-500">Data directory</dt>
        <dd className="break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">
          {q.data.dataDir}
        </dd>
        <dt className="text-zinc-500">Encryption key</dt>
        <dd className="break-all text-zinc-800 dark:text-zinc-200">
          {masterKey.source === "env" ? (
            "From MAILMCP_MASTER_KEY environment variable"
          ) : (
            <span className="font-mono text-xs">{masterKey.path}</span>
          )}
        </dd>
      </dl>
      {masterKey.source !== "env" && (
        <div className="mt-4">
          <Alert tone="warning" title="Back up your encryption key file">
            Saved mail passwords and stored mail can only be decrypted with this file. Keep a copy
            somewhere safe, separate from your database backups.
          </Alert>
        </div>
      )}
    </Card>
  );
}

export function GeneralCard({ onSaved, saveLabel = "Save" }: CardProps = {}) {
  const s = useSetting("general", onSaved);
  if (s.q.isLoading) return <Spinner />;
  const str = (p: string) => (getPath(s.draft, p) as string | undefined) ?? "";
  const url = str("publicUrl");
  const insecure = url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url);
  return (
    <Card title="Server">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Server name" htmlFor="iname" hint="Shown in the admin panel and to agents.">
            <Input
              id="iname"
              value={str("instanceName")}
              onChange={(e) => s.set("instanceName", e.target.value)}
            />
          </Field>
          <Field
            label="Public URL"
            htmlFor="purl"
            hint="The address your AI clients use to reach this server. Agent setup instructions use it."
          >
            <Input
              id="purl"
              type="url"
              placeholder={window.location.origin}
              value={url}
              onChange={(e) => s.set("publicUrl", e.target.value)}
            />
          </Field>
        </div>
        <Checkbox
          id="checkupd"
          label="Check for new versions automatically (asks GitHub; nothing about your mail is sent)"
          checked={getPath(s.draft, "checkForUpdates") !== false}
          onChange={(v) => s.set("checkForUpdates", v)}
        />
        {insecure && (
          <Alert tone="warning" title="Use HTTPS for anything beyond this computer">
            API keys and mail travel over this connection. Put MailMCP behind HTTPS (the Docker
            install can do it automatically with a domain name).
          </Alert>
        )}
        {s.err && (
          <Alert tone="error" title={s.err.message}>
            {s.err.fields && Object.values(s.err.fields).join(" ")}
          </Alert>
        )}
        {s.saved && !onSaved && <Alert tone="success" title="Saved." />}
        <Button busy={s.save.isPending} onClick={() => s.save.mutate()}>
          {saveLabel}
        </Button>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Instance-wide settings, stored in the database." />
      <div className="space-y-6">
        <GeneralCard />
        <UpdatesCard />
        <StorageCard />
        <SyncCard />
        <SystemCard />
      </div>
    </>
  );
}

interface SystemInfo {
  version: string;
  revision: string | null;
  repo: string | null;
  channel: "stable" | "edge";
  updater: {
    available: boolean;
    online: boolean;
    status: { state: string; message?: string; at?: string } | null;
  };
}
interface UpdateInfo {
  disabled?: boolean;
  channel: "stable" | "edge";
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
  error?: string;
}

/** Version, update check, and one-click updates through the updater container. */
export function UpdatesCard() {
  const sys = useQuery({ queryKey: ["system"], queryFn: () => api<SystemInfo>("/system") });
  const [force, setForce] = useState(false);
  const check = useQuery({
    queryKey: ["updates", force],
    queryFn: () => api<UpdateInfo>(`/system/updates${force ? "?force=1" : ""}`),
    enabled: !!sys.data,
  });
  const [channel, setChannel] = useState<"stable" | "edge" | null>(null);
  const [updating, setUpdating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api("/system/update", {
        method: "POST",
        body: channel && channel !== sys.data?.channel ? { channel } : {},
      }),
    onMutate: () => setErr(null),
    onSuccess: () => setUpdating(true),
    onError: (e) => setErr((e as Error).message),
  });

  // While updating, poll until the server comes back with a different version (or reports failure).
  useEffect(() => {
    if (!updating || !sys.data) return;
    const before = `${sys.data.version}|${sys.data.revision}`;
    const t = setInterval(async () => {
      try {
        const now = await api<SystemInfo>("/system");
        if (`${now.version}|${now.revision}` !== before) window.location.reload();
        if (now.updater.status?.state === "failed") {
          setUpdating(false);
          setErr(now.updater.status.message ?? "The update failed.");
        }
      } catch {
        // server restarting — keep waiting
      }
    }, 3000);
    return () => clearInterval(t);
  }, [updating, sys.data]);

  if (!sys.data) return null;
  const d = sys.data;
  const u = check.data;
  const ch = channel ?? d.channel;
  return (
    <Card title="Updates">
      <div className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-zinc-500">Running</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">
            {d.version}
            {d.revision && (
              <span className="ml-2 font-mono text-xs text-zinc-500">{d.revision.slice(0, 7)}</span>
            )}
          </dd>
          <dt className="text-zinc-500">Updates from</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">
            {d.repo ? (
              <a
                href={`https://github.com/${d.repo}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                github.com/{d.repo}
              </a>
            ) : (
              "Not installed from a published image"
            )}
            {d.repo && (
              <span className="text-zinc-500">
                {" "}
                · {d.channel === "edge" ? "every change (edge)" : "stable releases"}
              </span>
            )}
          </dd>
        </dl>

        {u?.disabled ? (
          <p className="text-sm text-zinc-500">
            Automatic update checks are off (Server settings).
          </p>
        ) : u?.error ? (
          <Alert tone="info" title="Couldn't check for updates">
            {u.error}
          </Alert>
        ) : u?.updateAvailable ? (
          <Alert tone="success" title={`Update available: ${u.latest}`}>
            {u.publishedAt && (
              <span>Published {new Date(u.publishedAt).toLocaleDateString()}. </span>
            )}
            {u.url && (
              <a href={u.url} target="_blank" rel="noreferrer" className="underline">
                What's new
              </a>
            )}
            {u.notes && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-xs">
                {u.notes.slice(0, 2000)}
              </pre>
            )}
          </Alert>
        ) : u ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You're on the latest {u.channel === "edge" ? "build" : "release"}.
          </p>
        ) : null}

        {d.updater.available && d.updater.online ? (
          <div className="space-y-3">
            <RadioGroup
              name="channel"
              label="Follow"
              value={ch}
              onChange={(v) => setChannel(v as "stable" | "edge")}
              options={[
                { value: "stable", label: "Stable releases (recommended)" },
                { value: "edge", label: "Every change (edge)" },
              ]}
            />
            {updating ? (
              <Alert tone="info" title="Updating…">
                {d.updater.status?.message ??
                  "Downloading the new version. MailMCP restarts automatically and this page reloads when it's back."}
              </Alert>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button busy={start.isPending} onClick={() => start.mutate()}>
                  {ch !== d.channel ? "Switch and update" : "Update now"}
                </Button>
                <Button
                  variant="secondary"
                  busy={check.isFetching}
                  onClick={() => (force ? check.refetch() : setForce(true))}
                >
                  Check again
                </Button>
              </div>
            )}
            <p className="text-xs text-zinc-500">
              Your data, settings and encryption key are kept. Database changes are applied
              automatically on start.
            </p>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              {d.updater.available
                ? "The updater container isn't running, so update from the server's command line:"
                : "Update from the server's command line:"}
            </p>
            <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">
              {d.repo
                ? "cd ~/mailmcp   # your install folder\ndocker compose pull && docker compose up -d"
                : "git pull && pnpm install && pnpm db:migrate\n# then restart the server and worker"}
            </pre>
            <Button
              variant="secondary"
              busy={check.isFetching}
              onClick={() => (force ? check.refetch() : setForce(true))}
            >
              Check for updates
            </Button>
          </div>
        )}
        {err && <Alert tone="error" title={err} />}
      </div>
    </Card>
  );
}
