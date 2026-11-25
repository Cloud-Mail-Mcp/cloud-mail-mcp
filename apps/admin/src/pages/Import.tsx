import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { Link } from "wouter";
import { Alert, Button, Card, PageHeader } from "../components/ui";
import { type AccountSummary, api } from "../lib/api";

/** One spreadsheet row, in the shape POST /accounts/bulk takes (plus a key for the table). */
interface Row {
  key: string;
  address: string;
  password?: string;
  displayName?: string;
  label?: string;
  username?: string;
  provider?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  /** Set per row when its address is already connected (overrides the choice for all). */
  ifExists?: IfExists;
}
type Field = Exclude<keyof Row, "key" | "ifExists">;
/** What to do with a row whose address is already connected. */
type IfExists = "update" | "add" | "skip";

type Result =
  | { address: string; status: "added"; accountId: string; working?: false; note?: string }
  | { address: string; status: "updated"; accountId: string; working?: false; note?: string }
  | { address: string; status: "skipped"; note: string }
  | { address: string; status: "waiting_for_password"; draftId: string; note?: string }
  | { address: string; status: "error"; error: string; canAddAnyway?: boolean };

const IF_EXISTS: Record<IfExists, { label: string; help: string }> = {
  update: {
    label: "Update",
    help: "Use the new password and any servers, name or label in the file. Mail already synced is kept.",
  },
  add: {
    label: "Add another login",
    help: "Connect it again as a separate mailbox (e.g. the same address on a new host).",
  },
  skip: { label: "Skip", help: "Leave the existing mailbox as it is." },
};

/** Column titles people use, by field (compared lower case, letters and digits only). */
const COLUMNS: Record<Field, string[]> = {
  address: ["email", "emailaddress", "address", "mailbox", "account", "emailaccount"],
  password: ["password", "pass", "pw", "pwd", "apppassword", "mailboxpassword"],
  displayName: ["name", "displayname", "fullname", "sendername", "fromname"],
  label: ["label", "tag", "group"],
  username: ["username", "user", "login", "loginname", "userid"],
  provider: ["provider", "type", "service"],
  imapHost: ["imaphost", "imapserver", "imap", "incomingserver", "incominghost", "incoming"],
  imapPort: ["imapport", "incomingport"],
  smtpHost: ["smtphost", "smtpserver", "smtp", "outgoingserver", "outgoinghost", "outgoing"],
  smtpPort: ["smtpport", "outgoingport"],
};
const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimal CSV: commas or semicolons, quoted fields with "" escapes, CRLF or LF. */
function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Turn a sheet into rows: find the header (or the email column if there's no header). */
function toRows(sheet: unknown[][]): { rows: Row[]; columns: Partial<Record<Field, number>> } {
  const header = sheet[0] ?? [];
  const columns: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(COLUMNS) as Array<[Field, string[]]>)
      if (columns[field] === undefined && names.includes(n)) columns[field] = i;
  });
  let body = sheet.slice(1);
  if (columns.address === undefined) {
    // No recognisable header: the first column holding an email address, the next one the password.
    const i = header.findIndex((c) => EMAIL.test(String(c ?? "").trim()));
    if (i === -1) return { rows: [], columns };
    columns.address = i;
    if (header.length > i + 1) columns.password = i + 1;
    body = sheet;
  }
  const get = (r: unknown[], f: Field) => {
    const i = columns[f];
    const v = i === undefined ? "" : String(r[i] ?? "").trim();
    return v || undefined;
  };
  const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const rows = body
    .map((r, n) => ({
      key: `row-${n}`,
      address: (get(r, "address") ?? "").toLowerCase(),
      password: get(r, "password"),
      displayName: get(r, "displayName"),
      label: get(r, "label"),
      username: get(r, "username"),
      provider: get(r, "provider")?.toLowerCase(),
      imapHost: get(r, "imapHost"),
      imapPort: num(get(r, "imapPort")),
      smtpHost: get(r, "smtpHost"),
      smtpPort: num(get(r, "smtpPort")),
    }))
    .filter((r) => r.address);
  return { rows, columns };
}

export function ImportPage() {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
  });
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [found, setFound] = useState<Field[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [running, setRunning] = useState(false);
  /** The choice for every row whose address is already connected (asked before importing). */
  const [ifExists, setIfExists] = useState<IfExists | null>(null);

  // Addresses already connected (from before this import: rows added now don't count).
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const exists = (r: Row) => connected.has(r.address);
  const matching = rows.filter(exists);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setErr(null);
    setRows([]);
    setResults({});
    setIfExists(null);
    if (!f) return;
    setFile(f.name);
    try {
      let sheet: unknown[][];
      if (/\.xlsx$/i.test(f.name)) {
        const { readSheet } = await import("read-excel-file/universal");
        sheet = (await readSheet(await f.arrayBuffer())) as unknown[][];
      } else if (/\.(csv|txt)$/i.test(f.name)) {
        sheet = parseCsv(await f.text());
      } else {
        setErr(
          "Choose an Excel file (.xlsx) or a CSV file. Older .xls files: save as .xlsx first.",
        );
        return;
      }
      const parsed = toRows(sheet);
      if (!parsed.rows.length) {
        setErr(
          'No email addresses found. Put them in a column titled "Email" (and passwords in "Password").',
        );
        return;
      }
      const latest = await qc.fetchQuery({
        queryKey: ["accounts"],
        queryFn: () => api<{ accounts: AccountSummary[] }>("/accounts"),
      });
      setConnected(new Set(latest.accounts.map((a) => a.address.toLowerCase())));
      setRows(parsed.rows);
      setFound(Object.keys(parsed.columns) as Field[]);
    } catch (e2) {
      setErr(`Couldn't read that file: ${(e2 as Error).message}`);
    }
  };

  /** Import the given rows, a few at a time (each one with a password is a real login test). */
  const run = async (indexes: number[], extra: { addIfFails?: boolean } = {}) => {
    setRunning(true);
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const i = indexes[next++] as number;
        const { key: _key, ifExists: own, ...row } = rows[i] as Row;
        const choice = exists(rows[i] as Row) ? (own ?? ifExists ?? undefined) : undefined;
        try {
          const r = await api<{ results: Result[] }>("/accounts/bulk", {
            method: "POST",
            body: { mailboxes: [{ ...row, ...(choice ? { ifExists: choice } : {}), ...extra }] },
          });
          setResults((s) => ({ ...s, [i]: r.results[0] as Result }));
        } catch (e) {
          setResults((s) => ({
            ...s,
            [i]: { address: row.address, status: "error", error: (e as Error).message },
          }));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setRunning(false);
    await qc.invalidateQueries({ queryKey: ["accounts"] });
    await qc.invalidateQueries({ queryKey: ["drafts"] });
  };

  const start = () => {
    setResults({});
    return run(rows.map((_, i) => i));
  };
  const setRowChoice = (i: number, v: IfExists) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ifExists: v } : r)));

  const done = Object.values(results);
  const count = (s: Result["status"]) => done.filter((r) => r.status === s).length;
  const notWorking = done.filter(
    (r) => (r.status === "added" || r.status === "updated") && r.working === false,
  ).length;
  const failedIdx = Object.entries(results)
    .filter(([, r]) => r.status === "error" && r.canAddAnyway)
    .map(([i]) => Number(i));
  const withPasswords = rows.filter((r) => r.password).length;
  const needsChoice = matching.length > 0 && !ifExists;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/accounts" className="text-zinc-500 hover:underline">
          ← Accounts
        </Link>
      </div>
      <PageHeader
        title="Import mailboxes"
        description="Add many mailboxes at once from an Excel or CSV file."
      />
      <div className="space-y-6">
        <Card title="1. Choose the file">
          <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-300">
            <p>
              One mailbox per row, with a header row. MailMCP recognises columns such as{" "}
              <strong>Email</strong>, <strong>Password</strong>, <strong>Name</strong>,{" "}
              <strong>Label</strong>, <strong>Username</strong>, <strong>IMAP server</strong>,{" "}
              <strong>IMAP port</strong>, <strong>SMTP server</strong> and{" "}
              <strong>SMTP port</strong>. Only Email is required: server settings are guessed from
              the address (Gmail, iCloud, otherwise <code>mail.yourdomain</code>), and rows without
              a password wait for you to enter it.
            </p>
            <p>
              The file is read in your browser. Passwords go straight to your MailMCP server, are
              tested, and are stored encrypted, so there's no need to share them with an AI.
            </p>
            <label className="inline-flex cursor-pointer items-center gap-3">
              <span className="rounded-md border border-zinc-300 bg-white px-3.5 py-2 font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                Choose file…
              </span>
              <input
                type="file"
                accept=".xlsx,.csv,.txt"
                onChange={onFile}
                disabled={running}
                className="sr-only"
              />
              <span>{file ?? "No file chosen"}</span>
            </label>
            {err && <Alert tone="error" title={err} />}
            {accountsQ.isError && (
              <Alert tone="warning" title="Couldn't load your mailboxes to check for duplicates." />
            )}
          </div>
        </Card>

        {matching.length > 0 && (
          <Card
            title={`${matching.length} ${matching.length === 1 ? "mailbox is" : "mailboxes are"} already connected`}
          >
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
              What should happen to {matching.length === 1 ? "it" : "them"}? You can change it for a
              single row in the table below.
            </p>
            <fieldset className="grid gap-2 sm:grid-cols-3" disabled={running}>
              <legend className="sr-only">Already connected mailboxes</legend>
              {(Object.keys(IF_EXISTS) as IfExists[]).map((k) => (
                <label
                  key={k}
                  className={`flex cursor-pointer gap-2.5 rounded-md border p-3 text-sm ${
                    ifExists === k
                      ? "border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="ifExists"
                    className="mt-0.5 accent-blue-600"
                    checked={ifExists === k}
                    onChange={() => setIfExists(k)}
                  />
                  <span>
                    <span className="block font-medium text-zinc-900 dark:text-zinc-100">
                      {IF_EXISTS[k].label}
                    </span>
                    <span className="text-zinc-500 dark:text-zinc-400">{IF_EXISTS[k].help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </Card>
        )}

        {rows.length > 0 && (
          <Card title={`2. Check and import · ${rows.length} mailboxes`}>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
              Columns found: {found.join(", ")}. {withPasswords} with a password (tested and added),{" "}
              {rows.length - withPasswords} without (they'll wait for a password).
            </p>
            <div className="max-h-[28rem] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                  <tr>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Password</th>
                    <th className="px-3 py-2 font-medium">Server</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map((r, i) => {
                    const res = results[i];
                    return (
                      <tr key={r.key}>
                        <td className="px-3 py-2 font-mono text-[13px]">
                          {r.address}
                          {r.label && <span className="ml-2 text-zinc-500">· {r.label}</span>}
                          {exists(r) && (
                            <div className="mt-1 flex items-center gap-2 font-sans text-xs text-zinc-500">
                              Already connected:
                              <select
                                aria-label={`What to do with ${r.address}`}
                                value={r.ifExists ?? ifExists ?? ""}
                                disabled={running}
                                onChange={(e) => setRowChoice(i, e.target.value as IfExists)}
                                className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                              >
                                {!r.ifExists && !ifExists && <option value="">Choose…</option>}
                                {(Object.keys(IF_EXISTS) as IfExists[]).map((k) => (
                                  <option key={k} value={k}>
                                    {IF_EXISTS[k].label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{r.password ? "••••••" : "—"}</td>
                        <td className="px-3 py-2 text-zinc-500">{r.imapHost ?? "automatic"}</td>
                        <td className="px-3 py-2">
                          <ResultCell
                            res={res}
                            running={running}
                            onAddAnyway={() => run([i], { addIfFails: true })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {done.length > 0 && (
              <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
                {done.length} of {rows.length} done · {count("added")} added
                {count("updated") > 0 && <> · {count("updated")} updated</>}
                {count("skipped") > 0 && <> · {count("skipped")} skipped</>} ·{" "}
                {count("waiting_for_password")} waiting for a password · {count("error")} failed
                {notWorking > 0 && <> · {notWorking} not working yet</>}
              </p>
            )}
            {!running && failedIdx.length > 0 && (
              <div className="mt-4">
                <Alert
                  tone="warning"
                  title={`${failedIdx.length} ${failedIdx.length === 1 ? "mailbox" : "mailboxes"} couldn't log in`}
                >
                  <p>
                    Often the password has changed. You can add{" "}
                    {failedIdx.length === 1 ? "it" : "them"} anyway, marked as not working, and then
                    fix each login on the Accounts page. Until then a rejected password is retried
                    only once an hour, so the mail server doesn't block you for too many failed
                    logins.
                  </p>
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      onClick={() => run(failedIdx, { addIfFails: true })}
                    >
                      Add {failedIdx.length === 1 ? "it" : `all ${failedIdx.length}`} anyway, not
                      working
                    </Button>
                  </div>
                </Alert>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button busy={running} disabled={running || needsChoice} onClick={start}>
                {done.length ? "Import again" : `Import ${rows.length} mailboxes`}
              </Button>
              {needsChoice && (
                <span className="text-sm text-amber-700 dark:text-amber-400">
                  Choose what to do with the mailboxes that are already connected.
                </span>
              )}
              {!running && done.length > 0 && (
                <Link
                  href="/accounts"
                  className="rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  {notWorking
                    ? "Fix the logins that aren't working"
                    : count("waiting_for_password")
                      ? "Enter the missing passwords"
                      : "Done"}
                </Link>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function ResultCell({
  res,
  running,
  onAddAnyway,
}: {
  res?: Result;
  running: boolean;
  onAddAnyway: () => void;
}) {
  if (!res) return <span className="text-zinc-400">{running ? "…" : ""}</span>;
  if ((res.status === "added" || res.status === "updated") && res.working === false)
    return (
      <span className="text-amber-700 dark:text-amber-400" title={res.note}>
        {res.status === "added" ? "Added" : "Updated"}, not working
        <Link href={`/accounts/${res.accountId}`} className="ml-2 text-blue-600 hover:underline">
          Fix login
        </Link>
      </span>
    );
  if (res.status === "added")
    return <span className="text-green-700 dark:text-green-400">Added</span>;
  if (res.status === "updated")
    return <span className="text-green-700 dark:text-green-400">Updated</span>;
  if (res.status === "skipped") return <span className="text-zinc-500">Skipped · {res.note}</span>;
  if (res.status === "waiting_for_password")
    return <span className="text-amber-700 dark:text-amber-400">Waiting for password</span>;
  return (
    <span className="text-red-700 dark:text-red-400">
      {res.error}
      {res.canAddAnyway && !running && (
        <button
          type="button"
          onClick={onAddAnyway}
          className="ml-2 font-medium text-blue-600 hover:underline"
        >
          Add anyway
        </button>
      )}
    </span>
  );
}
