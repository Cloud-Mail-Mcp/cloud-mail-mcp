import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { AccountStatus } from "../lib/api";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export function Button({
  variant = "primary",
  busy,
  className,
  children,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean;
}) {
  return (
    <button
      {...p}
      disabled={p.disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-blue-600 text-white hover:bg-blue-700",
        variant === "secondary" &&
          "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        variant === "ghost" &&
          "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
        className,
      )}
    >
      {busy && (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Input({
  className,
  invalid,
  ...p
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...p}
      className={cx(
        "w-full rounded-md border bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400",
        "focus:outline-2 focus:outline-blue-500 dark:bg-zinc-900 dark:text-zinc-100",
        invalid ? "border-red-500" : "border-zinc-300 dark:border-zinc-700",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-zinc-800 dark:text-zinc-200"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  id,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-zinc-300 accent-blue-600"
      />
      {label}
    </label>
  );
}

export function Card({
  children,
  className,
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cx(
        "rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Alert({
  tone,
  title,
  children,
}: {
  tone: "error" | "success" | "warning" | "info";
  title: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    error:
      "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200",
    success:
      "border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/40 dark:text-green-200",
    warning:
      "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-md border px-4 py-3 text-sm", tones[tone])}
    >
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 opacity-90">{children}</div>}
    </div>
  );
}

const statusStyle: Record<AccountStatus, [string, string]> = {
  pending: ["Waiting for sync", "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"],
  syncing: ["Syncing", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"],
  ok: ["Up to date", "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"],
  auth_error: ["Login failed", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"],
  throttled: ["Rate limited", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
  error: ["Error", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"],
  disabled: ["Disabled", "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"],
};

export function StatusBadge({ status }: { status: AccountStatus }) {
  const [label, style] = statusStyle[status];
  return (
    <span className={cx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", style)}>
      {label}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center p-10">
      <span className="size-6 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600" />
    </div>
  );
}

export const fmt = (n: number) => n.toLocaleString();

/** Pill-style single choice built on native radio inputs (keyboard arrows work). */
export function RadioGroup({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 has-checked:border-blue-600 has-checked:bg-blue-50 has-checked:text-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-blue-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:has-checked:bg-blue-950/50 dark:has-checked:text-blue-300"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
