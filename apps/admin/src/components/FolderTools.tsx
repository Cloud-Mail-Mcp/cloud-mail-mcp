import { type FormEvent, useState } from "react";
import { api, type MailFolder } from "../lib/api";
import { Alert, Button } from "./ui";

const field =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/** A folder's own name: the last part of its path. */
export const folderName = (f: MailFolder) => {
  const sep = f.delimiter || "/";
  return f.path.slice(f.path.lastIndexOf(sep) + 1) || f.path;
};

/** "+ New folder" under a mailbox: a name, created at the top level. */
export function NewFolder({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-0.5 w-full rounded-md px-2.5 py-1 pl-6 text-left text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        + New folder
      </button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/mail/folders", { method: "POST", body: { accountId, name: name.trim() } });
      setName("");
      setOpen(false);
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-1 space-y-1.5 pl-4">
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on purpose by the person
        autoFocus
        aria-label="New folder name"
        placeholder="Folder name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className={field}
      />
      <div className="flex gap-1.5">
        <Button type="submit" busy={busy} disabled={!name.trim()} className="px-2.5 py-1 text-xs">
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="px-2.5 py-1 text-xs"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </form>
  );
}

/** Rename a folder in place. */
export function RenameFolder({
  folder,
  onDone,
  onCancel,
}: {
  folder: MailFolder;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(folderName(folder));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v || v === folderName(folder)) return onCancel();
    setBusy(true);
    setErr(null);
    try {
      await api(`/mail/folders/${folder.id}`, { method: "PATCH", body: { name: v } });
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-1 py-0.5 pl-4">
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on purpose by the person
        autoFocus
        aria-label={`New name for ${folder.path}`}
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onBlur={() => !busy && !err && onCancel()}
        className={field}
      />
      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
    </form>
  );
}

/**
 * Delete a folder. If it has mail, ask where the mail goes first: another folder in the same
 * mailbox, or Trash.
 */
export function DeleteFolderDialog({
  folder,
  others,
  onDone,
  onClose,
}: {
  folder: MailFolder;
  /** The mailbox's other folders (targets for its mail). */
  others: Array<{ id: number; label: string; role: string | null }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const hasMail = folder.messageCount > 0;
  const hasTrash = others.some((o) => o.role === "trash");
  const [choice, setChoice] = useState<"move" | "trash">(hasTrash ? "trash" : "move");
  const targets = others.filter((o) => o.role !== "trash" && o.role !== "all");
  const [moveTo, setMoveTo] = useState<number | "">(
    targets.find((o) => o.role === "inbox")?.id ?? targets[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    const q = new URLSearchParams();
    if (hasMail) {
      q.set("messages", choice);
      if (choice === "move") q.set("moveTo", String(moveTo));
    }
    try {
      await api(`/mail/folders/${folder.id}?${q}`, { method: "DELETE" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-folder-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2
          id="delete-folder-title"
          className="text-base font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Delete “{folder.path}”?
        </h2>
        {hasMail ? (
          <fieldset className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
            <legend className="mb-1">
              It has {folder.messageCount.toLocaleString()}{" "}
              {folder.messageCount === 1 ? "message" : "messages"}. What should happen to{" "}
              {folder.messageCount === 1 ? "it" : "them"}?
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-folder-mail"
                checked={choice === "move"}
                onChange={() => setChoice("move")}
                className="accent-blue-600"
              />
              Move to
              <select
                aria-label="Folder to move the mail to"
                value={moveTo}
                onChange={(e) => {
                  setMoveTo(Number(e.target.value));
                  setChoice("move");
                }}
                className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {targets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {hasTrash && (
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="delete-folder-mail"
                  checked={choice === "trash"}
                  onChange={() => setChoice("trash")}
                  className="accent-blue-600"
                />
                Move to Trash (you can still restore it from there)
              </label>
            )}
          </fieldset>
        ) : (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">The folder is empty.</p>
        )}
        {err && (
          <div className="mt-3">
            <Alert tone="error" title={err} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={hasMail && choice === "move" && moveTo === ""}
            onClick={go}
          >
            {hasMail ? "Move mail and delete folder" : "Delete folder"}
          </Button>
        </div>
      </div>
    </div>
  );
}
