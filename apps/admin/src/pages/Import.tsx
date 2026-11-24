import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { Link } from "wouter";
import { Alert, Button, Card, PageHeader } from "../components/ui";
import { api } from "../lib/api";

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
}
type Field = Exclude<keyof Row, "key">;

type Result =
  | { address: string; status: "added"; accountId: string }
  | { address: string; status: "waiting_for_password"; draftId: string; note?: string }
  | { address: string; status: "error"; error: string };

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
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [found, setFound] = useState<Field[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [running, setRunning] = useState(false);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setErr(null);
    setRows([]);
    setResults({});
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
      setRows(parsed.rows);
      setFound(Object.keys(parsed.columns) as Field[]);
    } catch (e2) {
      setErr(`Couldn't read that file: ${(e2 as Error).message}`);
    }
  };

  const start = async () => {
    setRunning(true);
    setResults({});
    let next = 0;
    // A few at a time: each one with a password is a real login test.
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const { key: _key, ...row } = rows[i] as Row;
        try {
          const r = await api<{ results: Result[] }>("/accounts/bulk", {
            method: "POST",
            body: { mailboxes: [row] },
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

  const done = Object.values(results);
  const count = (s: Result["status"]) => done.filter((r) => r.status === s).length;
  const withPasswords = rows.filter((r) => r.password).length;

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
          </div>
        </Card>

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
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{r.password ? "••••••" : "—"}</td>
                        <td className="px-3 py-2 text-zinc-500">{r.imapHost ?? "automatic"}</td>
                        <td className="px-3 py-2">
                          {!res ? (
                            <span className="text-zinc-400">{running ? "…" : ""}</span>
                          ) : res.status === "added" ? (
                            <span className="text-green-700 dark:text-green-400">Added</span>
                          ) : res.status === "waiting_for_password" ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              Waiting for password
                            </span>
                          ) : (
                            <span className="text-red-700 dark:text-red-400">{res.error}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {done.length > 0 && (
              <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
                {done.length} of {rows.length} done · {count("added")} added ·{" "}
                {count("waiting_for_password")} waiting for a password · {count("error")} failed
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button busy={running} disabled={running} onClick={start}>
                {done.length ? "Import again" : `Import ${rows.length} mailboxes`}
              </Button>
              {!running && done.length > 0 && (
                <Link
                  href="/accounts"
                  className="rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  {count("waiting_for_password") ? "Enter the missing passwords" : "Done"}
                </Link>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
