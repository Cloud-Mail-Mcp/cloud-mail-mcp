/** A small dollar amount: "$0.0042", "$0.12", "$3.40". */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public hint?: string,
    public fields?: Record<string, string>,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.hint,
      data.fields,
      data.code,
    );
  }
  return data as T;
}

// ─────────── Types mirrored from the server ───────────

export type AccountStatus =
  | "pending"
  | "syncing"
  | "ok"
  | "auth_error"
  | "throttled"
  | "error"
  | "disabled";

export interface AccountSummary {
  id: string;
  moduleId: string;
  address: string;
  displayName: string | null;
  /** Tells two logins for the same address apart, e.g. "Old host". */
  label: string | null;
  status: AccountStatus;
  statusMessage: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  folderCount: number;
  messageCount: number;
  unreadCount: number;
}

export interface Folder {
  id: number;
  path: string;
  role: string | null;
  messageCount: number;
  unreadCount: number;
  syncedAt: string | null;
}

export interface AccountDetail
  extends Omit<AccountSummary, "folderCount" | "messageCount" | "unreadCount"> {
  settings: Record<string, unknown>;
  config: Record<string, unknown>;
  instructions: string | null;
  folders: Folder[];
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  presets: Array<{
    id: string;
    name: string;
    domains: string[];
    defaults: Record<string, unknown>;
    help?: string;
    steps?: Array<{ text: string; link?: { label: string; url: string } }>;
  }>;
  ui: {
    secretFields: string[];
    advancedFields?: string[];
    usernameField?: string;
    labels?: Record<string, string>;
  };
  configSchema: JsonSchema;
}

export interface TestResult {
  ok: boolean;
  error?: { message: string; hint?: string; code?: string };
  folders?: Array<{ path: string; role?: string; messageCount?: number; unreadCount?: number }>;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  role: string;
}

// ─────────── Mail ───────────

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface MessageSummary {
  id: number;
  accountId: string;
  account: string;
  accountLabel: string | null;
  threadId: number | null;
  folders: string[];
  subject: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  date: string;
  snippet: string | null;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  /** What the message is (AI sorter or a person), e.g. ["newsletter"]. */
  tags: string[];
}

/** Sender checks and spam score reported by the receiving mail server. */
export interface MessageChecks {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  spamScore: number | null;
  spamThreshold: number | null;
  spamFlag: boolean;
  verdict: "verified" | "suspicious" | "spam" | "unknown";
}

/** A tag from Settings → AI sorting, with inbox counts. */
export interface MailTag {
  id: string;
  name: string;
  action: "none" | "mark_read" | "archive" | "spam" | "folder";
  inbox: number;
  unread: number;
}

export interface MessageDetail extends MessageSummary {
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  messageIdHeader: string | null;
  text: string | null;
  html: string | null;
  /** Mailing-list unsubscribe option (null: not from a list). */
  unsubscribe: {
    method: "one_click" | "email" | "website";
    website: string | null;
    unsubscribedAt: string | null;
  } | null;
  checks: MessageChecks | null;
  attachments: Array<{
    id: number;
    filename: string | null;
    mime: string | null;
    size: number | null;
    inline: boolean;
  }>;
}

export type UnsubscribeOutcome =
  | { status: "unsubscribed"; method: "one_click" | "email"; note: string }
  | { status: "open_website"; method: "website"; url: string; note: string }
  | { status: "pending_approval"; pendingId: string; note: string };

export interface MailFolder {
  id: number;
  accountId: string;
  path: string;
  role: string | null;
  messageCount: number;
  unreadCount: number;
}

export interface MessagePage {
  messages: MessageSummary[];
  nextCursor?: string;
}

// ─────────── Agents ───────────

export type SendPolicy = "allow" | "approve" | "deny";

export interface Grant {
  id: string;
  agentId: string;
  accountId: string;
  address: string;
  scopes: string[];
  folderAllow: string[] | null;
  folderDeny: string[] | null;
  sendPolicy: SendPolicy;
  recipientAllow: string[] | null;
  rateLimit: { perMinute?: number; perHour?: number; perDay?: number } | null;
  expiresAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt?: string | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  disabled: boolean;
  /** "oauth" = connected by signing in from the AI app; "api_key" = created here with a key. */
  kind: "api_key" | "oauth";
  /** May add mailboxes (people enter the passwords unless Settings allow agents to). */
  canAddAccounts: boolean;
  createdAt: string;
  keys: ApiKeyInfo[];
  accountCount: number;
  lastUsedAt: string | null;
}

/** A mailbox waiting for its password (added by an agent, or imported without one). */
export interface AccountDraft {
  id: string;
  address: string;
  displayName: string | null;
  label: string | null;
  config: { imap?: { host?: string }; username?: string };
  access: "none" | "read" | "assistant" | "send_approval" | null;
  agentId: string | null;
  agentName: string | null;
  createdAt: string;
}

export interface AgentDetail extends Omit<AgentSummary, "accountCount" | "lastUsedAt"> {
  grants: Grant[];
}

export interface PendingAction {
  id: string;
  kind: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  agentName: string | null;
  account: string;
  accountId: string;
  payload: Record<string, any>;
  result: Record<string, any> | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AuditEntry {
  id: number;
  actorType: string;
  actor: string;
  account: string | null;
  action: string;
  target: string | null;
  allowed: boolean;
  detail: Record<string, unknown> | null;
  ip: string | null;
  at: string;
}

export const relTime = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};

export const shortDate = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === today.getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

export const addr = (a: EmailAddress | null | undefined) => (a ? a.name || a.email : "");

/** How to name an account in the UI: its display name or address, plus its label. */
export function accountName(a: {
  address: string;
  displayName?: string | null;
  label?: string | null;
}): string {
  const base = a.displayName || a.address;
  return a.label ? `${base} · ${a.label}` : base;
}
