import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api, type Me } from "../lib/api";

const nav: Array<{ href: string; label: string; soon?: boolean }> = [
  { href: "/accounts", label: "Accounts" },
  { href: "/mail", label: "Mail" },
  { href: "/chat", label: "Chat" },
  { href: "/agents", label: "Agents" },
  { href: "/permissions", label: "Permissions" },
  { href: "/approvals", label: "Approvals" },
  { href: "/audit", label: "Audit log" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const [location] = useLocation();
  const qc = useQueryClient();
  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    // Drop every cached response (mail data included) and re-check the session.
    await qc.resetQueries();
  };

  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-blue-600 text-sm font-bold text-white">
            M
          </div>
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">MailMCP</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main">
          {nav.map((n) => {
            const active = location === n.href || location.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                  active
                    ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {n.label}
                {n.soon && (
                  <span className="text-[10px] uppercase tracking-wide text-zinc-400">soon</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-200 px-5 py-4 text-sm dark:border-zinc-800">
          <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">
            {me.name ?? me.email}
          </p>
          <p className="truncate text-xs text-zinc-500">{me.email}</p>
          <button
            type="button"
            onClick={logout}
            className="mt-2 text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 overflow-x-auto border-b border-zinc-200 bg-white px-4 py-2 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
          {nav
            .filter((n) => !n.soon)
            .map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="whitespace-nowrap rounded px-2 py-1 text-sm text-zinc-700 dark:text-zinc-300"
              >
                {n.label}
              </Link>
            ))}
          <button type="button" onClick={logout} className="ml-auto text-sm text-zinc-500">
            Sign out
          </button>
        </header>
        {location.startsWith("/mail") ? (
          <main className="min-h-0 flex-1">{children}</main>
        ) : (
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">{children}</main>
        )}
      </div>
    </div>
  );
}
