/**
 * MailMCP Module API (v1).
 *
 * Every mail provider, including the built-in IMAP module, is a module. The core never
 * imports provider code directly; it loads modules and talks to them through these types.
 * Modules get only what `ModuleContext` hands them: no database access and no visibility
 * into other accounts.
 */
import type { z } from "zod";

export const MODULE_API_VERSION = 1 as const;

// ───────────────────────────── Manifest ─────────────────────────────

export type AuthMethod =
  | { type: "password"; label?: string; help?: string }
  | {
      type: "oauth2";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      /** Provider data-center variants, e.g. Zoho "com" | "eu". */
      regions?: string[];
    };

export interface ModuleCapabilities {
  folders: boolean;
  /** Messages can live in several containers at once (Gmail labels). */
  labels: boolean;
  threads: boolean;
  serverSearch: boolean;
  push: "idle" | "webhook" | false;
  send: boolean;
  drafts: boolean;
  deleteModes: ReadonlyArray<"trash" | "permanent">;
}

export interface ModuleManifest<Config extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof MODULE_API_VERSION;
  kind: "connector";
  description?: string;
  /** Reserved for optional paid modules. Free modules omit it. */
  license?: { required: boolean; entitlement: string };
  auth: AuthMethod[];
  /** Non-secret + secret settings; drives the admin-panel connection form. */
  configSchema: Config;
  /** Hints for well-known hosts (autodetect by email domain). */
  presets?: ProviderPreset[];
  /** Admin-panel form hints. Paths use dots for nesting, e.g. "imap.host". */
  ui?: {
    /** Never returned by the API once saved; blank on edit = keep existing. */
    secretFields: string[];
    /** Shown under an "Advanced" toggle (presets usually fill these). */
    advancedFields?: string[];
    /** Field to pre-fill with the account's email address. */
    usernameField?: string;
    labels?: Record<string, string>;
  };
  capabilities: ModuleCapabilities;
  create(ctx: ModuleContext<z.infer<Config>>): Connector;
}

export interface ProviderPreset {
  id: string; // "icloud"
  name: string; // "Apple iCloud"
  domains: string[]; // ["icloud.com", "me.com", "mac.com"]
  defaults: Record<string, unknown>;
  help?: string; // e.g. "Create an app-specific password at appleid.apple.com"
}

export function defineModule<Config extends z.ZodTypeAny>(
  manifest: ModuleManifest<Config>,
): ModuleManifest<Config> {
  return manifest;
}

// ───────────────────────────── Context handed to a module ─────────────────────────────

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ModuleContext<Config> {
  accountId: string;
  address: string;
  /** Decrypted config + secrets for THIS account only. */
  config: Config;
  /** Persist updated secrets (e.g. refreshed OAuth tokens). */
  saveConfig(next: Config): Promise<void>;
  /** Small per-account key/value scratch space for the module. */
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
  log: Logger;
  /** Aborted when the account is disabled or the process shuts down. */
  signal: AbortSignal;
}

// ───────────────────────────── Data shapes ─────────────────────────────

export type FolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "spam"
  | "archive"
  | "all"
  | "important"
  | "starred";

export interface RemoteFolder {
  remoteId: string;
  path: string;
  delimiter?: string;
  kind: "folder" | "label";
  role?: FolderRole;
  /** Folder cannot hold messages (IMAP \Noselect). */
  selectable: boolean;
  messageCount?: number;
  unreadCount?: number;
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  keywords: string[];
}

/** Everything needed to list and search a message without its body. */
export interface MessageEnvelope {
  remoteId: string;
  /** Position inside the folder being synced (IMAP UID). */
  remoteUid?: number;
  remoteThreadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  subject?: string;
  date: Date;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  flags: MessageFlags;
  size?: number;
  hasAttachments?: boolean;
  attachments?: AttachmentInfo[];
  snippet?: string;
}

export interface AttachmentInfo {
  partId: string;
  filename?: string;
  mime?: string;
  size?: number;
  contentId?: string;
  inline?: boolean;
}

/** Opaque, module-defined sync position for one folder. Stored as JSON. */
export type SyncCursor = Record<string, unknown>;

/** Identifies a message inside a specific folder (IMAP needs the folder UID). */
export interface MessageRef {
  remoteId: string;
  remoteUid?: number;
}

export type SyncEvent =
  | { type: "upsert"; envelope: MessageEnvelope }
  | { type: "flags"; remoteUid: number; flags: MessageFlags }
  | { type: "delete"; remoteUid: number }
  /**
   * Authoritative list of every UID currently in the folder at or above `fromUid`.
   * Core removes local memberships in that range that aren't listed (expunged elsewhere).
   */
  | { type: "present"; fromUid: number; uids: number[] }
  /** Folder was reset server-side (IMAP UIDVALIDITY change): core drops its local copy. */
  | { type: "reset" }
  /** Progress hint for the admin panel. */
  | { type: "progress"; done: number; total: number }
  /** Checkpoint: core persists the cursor so a crash resumes from here. */
  | { type: "cursor"; cursor: SyncCursor };

export interface SyncOptions {
  /** Ignore mail older than this (header backfill window). */
  since?: Date;
  /** Max envelopes per batch before a cursor checkpoint. */
  batchSize?: number;
  /** How many messages core currently has for this folder (to detect deletions cheaply). */
  knownCount?: number;
  /** Force a full flags + deletion reconcile. */
  fullReconcile?: boolean;
}

export interface FetchedMessage {
  /** Full RFC 5322 source. Core parses it and stores it encrypted. */
  raw: Buffer;
}

export interface OutboundAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

export interface OutboundMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutboundAttachment[];
}

export interface SentResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface AccountIdentity {
  address: string;
  displayName?: string;
  /** Provider quirks the core should know about, e.g. { gmail: true }. */
  traits?: Record<string, boolean>;
}

/** Throw this when the provider throttles us; core backs off until `retryAt`. */
export class ProviderLimitError extends Error {
  constructor(
    message: string,
    public code: "RATE_LIMITED" | "QUOTA_EXCEEDED",
    public retryAt?: Date,
  ) {
    super(message);
  }
}

/** One message in a folder listing used to copy mail between accounts. */
export interface InventoryItem {
  /** Position in the folder (IMAP UID). Increases as mail arrives. */
  uid: number;
  /** Message-ID header, used to recognise the same message on both sides. */
  messageId: string | null;
  /** When the server received it (kept when copying). */
  date: Date | null;
  size: number;
  flags: MessageFlags;
}

export interface Inventory {
  /** Changes when the server renumbers the folder; positions are only valid within one. */
  uidValidity: string;
  items: InventoryItem[];
}

// ───────────────────────────── The connector ─────────────────────────────

export interface Connector {
  /** Test credentials and return the identity. Called on connect and periodically. */
  verify(): Promise<AccountIdentity>;
  listFolders(): Promise<RemoteFolder[]>;

  /**
   * Stream changes for one folder since `cursor` (null = first sync).
   * Must emit `cursor` checkpoints regularly so sync is resumable.
   * Initial sync must be newest-first so recent mail is usable within minutes.
   */
  sync(
    folder: RemoteFolder,
    cursor: SyncCursor | null,
    opts?: SyncOptions,
  ): AsyncIterable<SyncEvent>;

  fetchMessage(folder: RemoteFolder, ref: MessageRef): Promise<FetchedMessage>;
  /** Optional batched download (one round trip for many messages). */
  fetchMessages?(
    folder: RemoteFolder,
    refs: MessageRef[],
  ): AsyncIterable<{ ref: MessageRef; raw: Buffer }>;

  /** Send, and file a copy in Sent if the provider doesn't do that itself. */
  send(msg: OutboundMessage, sentFolder?: RemoteFolder): Promise<SentResult>;
  saveDraft?(msg: OutboundMessage, drafts: RemoteFolder, replace?: MessageRef): Promise<void>;

  move(from: RemoteFolder, refs: MessageRef[], to: RemoteFolder): Promise<void>;
  setFlags(
    folder: RemoteFolder,
    refs: MessageRef[],
    change: {
      add?: Partial<Omit<MessageFlags, "keywords">>;
      remove?: Partial<Omit<MessageFlags, "keywords">>;
    },
  ): Promise<void>;
  /** Permanently remove (expunge). Moving to trash is done by core via `move`. */
  expunge(folder: RemoteFolder, refs: MessageRef[]): Promise<void>;

  /**
   * List a folder's messages with their Message-IDs, for copying mail to another account.
   * `afterUid` lists only newer mail; `since` only mail received on or after that date.
   */
  inventory?(folder: RemoteFolder, opts?: { afterUid?: number; since?: Date }): Promise<Inventory>;
  /** Store a complete message (RFC 5322 source) in a folder, keeping its flags and date. */
  append?(
    folder: RemoteFolder,
    raw: Buffer,
    opts?: { flags?: Partial<Omit<MessageFlags, "keywords">>; date?: Date },
  ): Promise<void>;

  createFolder?(path: string): Promise<RemoteFolder>;
  renameFolder?(folder: RemoteFolder, newPath: string): Promise<RemoteFolder>;
  deleteFolder?(folder: RemoteFolder): Promise<void>;

  /** Subscribe to live changes (IMAP IDLE / webhooks). Returns an unsubscribe fn. */
  watch?(folder: RemoteFolder, onChange: () => void): Promise<() => Promise<void>>;

  close(): Promise<void>;
}
