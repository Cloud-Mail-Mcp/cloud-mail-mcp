/**
 * MailMCP database schema. Design rules (see docs/SPEC.md §4 / §4a):
 *  - One shared table per entity (NOT one table per mailbox).
 *  - Every hot mail table's primary key and indexes lead with `account_id`.
 *  - Mail bodies / raw MIME / attachments live in the blob store, not here.
 *  - Normalize first; duplicate only columns that list views need
 *    (from_name/from_email on messages; date/seen on message_folders).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ───────────────────────────── Tenancy & users ─────────────────────────────

export const memberRole = pgEnum("member_role", ["owner", "admin", "member", "viewer"]);

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(), // argon2id
    totpSecretEnc: bytea("totp_secret_enc"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

// ───────────────────────────── Mail accounts ─────────────────────────────

export const accountStatus = pgEnum("account_status", [
  "pending",
  "syncing",
  "ok",
  "auth_error",
  "throttled",
  "error",
  "disabled",
]);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(), // e.g. "imap", "msgraph"
    address: text("address").notNull(),
    displayName: text("display_name"),
    /** Module config + secrets, AES-256-GCM encrypted with the account data key. */
    credentialsEnc: bytea("credentials_enc").notNull(),
    /** Per-account data key, wrapped (encrypted) by the master key. */
    dataKeyEnc: bytea("data_key_enc").notNull(),
    status: accountStatus("status").notNull().default("pending"),
    statusMessage: text("status_message"),
    settings: jsonb("settings").notNull().default({}), // backfill window, storage budget, ...
    instructions: text("instructions"), // guidance shown to agents
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("accounts_org_idx").on(t.orgId),
    uniqueIndex("accounts_org_address_uq").on(t.orgId, sql`lower(${t.address})`),
  ],
);

export const folderRole = pgEnum("folder_role", [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "spam",
  "archive",
  "all",
  "important",
  "starred",
]);

export const folders = pgTable(
  "folders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    remoteId: text("remote_id").notNull(), // IMAP path / provider folder id
    path: text("path").notNull(),
    delimiter: text("delimiter"),
    kind: text("kind").notNull().default("folder"), // "folder" | "label"
    role: folderRole("role"),
    /** Opaque per-module sync cursor (e.g. IMAP {uidValidity, uidNext, highestModseq}). */
    syncCursor: jsonb("sync_cursor"),
    messageCount: integer("message_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("folders_account_remote_uq").on(t.accountId, t.remoteId)],
);

// ───────────────────────────── Messages ─────────────────────────────

export const threads = pgTable(
  "threads",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    remoteThreadId: text("remote_thread_id"),
    subject: text("subject"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
  },
  (t) => [
    index("threads_account_last_idx").on(t.accountId, t.lastMessageAt.desc()),
    uniqueIndex("threads_account_remote_uq").on(t.accountId, t.remoteThreadId),
  ],
);

/** Normalized contacts, shared across an org's accounts. */
export const addresses = pgTable(
  "addresses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // stored lowercased
    name: text("name"),
  },
  (t) => [uniqueIndex("addresses_org_email_uq").on(t.orgId, t.email)],
);

export const bodyState = pgEnum("body_state", ["none", "fetched", "evicted"]);

export const messages = pgTable(
  "messages",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity(),
    threadId: bigint("thread_id", { mode: "number" }),
    /** Stable provider id (IMAP: "<uidValidity>:<uid>" of its primary folder, Gmail: message id). */
    remoteId: text("remote_id").notNull(),
    messageIdHdr: text("message_id_hdr"),
    inReplyTo: text("in_reply_to"),
    subject: text("subject"),
    date: timestamp("date", { withTimezone: true }).notNull(),
    // Denormalized for list views (source of truth: message_addresses role='from')
    fromAddressId: bigint("from_address_id", { mode: "number" }),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    answered: boolean("answered").notNull().default(false),
    draft: boolean("draft").notNull().default(false),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    snippet: text("snippet"),
    size: integer("size"),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    rawBlobKey: text("raw_blob_key"),
    bodyBlobKey: text("body_blob_key"),
    bodyState: bodyState("body_state").notNull().default("none"),
    headersExtra: jsonb("headers_extra"),
    /** Used by the `postgres` search driver; ignored by other drivers. */
    searchTsv: tsvector("search_tsv"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    uniqueIndex("messages_account_remote_uq").on(t.accountId, t.remoteId),
    index("messages_account_date_idx").on(t.accountId, t.date.desc()),
    // ids come from one sequence, so an id alone identifies a message (used by the API)
    uniqueIndex("messages_id_uq").on(t.id),
    index("messages_account_thread_idx").on(t.accountId, t.threadId),
    index("messages_account_msgid_idx").on(t.accountId, t.messageIdHdr),
    index("messages_search_tsv_idx").using("gin", t.searchTsv),
  ],
);

/**
 * Message ↔ folder/label membership. `date` and `seen` are duplicated from
 * `messages` so an inbox page is a single index scan.
 */
export const messageFolders = pgTable(
  "message_folders",
  {
    accountId: uuid("account_id").notNull(),
    folderId: bigint("folder_id", { mode: "number" })
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    /** Provider-side position in this folder (IMAP UID). */
    remoteUid: bigint("remote_uid", { mode: "number" }),
    date: timestamp("date", { withTimezone: true }).notNull(),
    seen: boolean("seen").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.folderId, t.messageId] }),
    index("message_folders_list_idx").on(t.accountId, t.folderId, t.date.desc()),
    index("message_folders_unread_idx").on(t.accountId, t.folderId).where(sql`NOT ${t.seen}`),
    index("message_folders_uid_idx").on(t.folderId, t.remoteUid),
  ],
);

export const addressRole = pgEnum("address_role", ["from", "to", "cc", "bcc", "reply_to"]);

export const messageAddresses = pgTable(
  "message_addresses",
  {
    accountId: uuid("account_id").notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    role: addressRole("role").notNull(),
    addressId: bigint("address_id", { mode: "number" })
      .notNull()
      .references(() => addresses.id),
    position: smallint("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.messageId, t.role, t.position] }),
    index("message_addresses_addr_idx").on(t.addressId, t.accountId),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid("account_id").notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    partId: text("part_id").notNull(), // MIME part path, e.g. "2.1"
    filename: text("filename"),
    mime: text("mime"),
    size: integer("size"),
    contentId: text("content_id"), // for inline images
    contentHash: text("content_hash"), // sha256, set once fetched
    blobKey: text("blob_key"), // null until fetched
  },
  (t) => [index("attachments_message_idx").on(t.accountId, t.messageId)],
);

// ───────────────────────────── Agents & permissions ─────────────────────────────

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    disabled: boolean("disabled").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("agents_org_idx").on(t.orgId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(), // first chars shown in UI, e.g. "mmcp_a1b2"
    keyHash: text("key_hash").notNull(), // sha256 hex
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash)],
);

export const sendPolicy = pgEnum("send_policy", ["allow", "approve", "deny"]);

/** What an agent may do on one account. Default deny: no grant = no access. */
export const grants = pgTable(
  "grants",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** mail:read, mail:draft, mail:send, mail:organize, mail:delete, mail:delete:permanent, folders:manage */
    scopes: text("scopes").array().notNull(),
    folderAllow: text("folder_allow").array(), // glob patterns; null = all
    folderDeny: text("folder_deny").array(),
    sendPolicy: sendPolicy("send_policy").notNull().default("approve"),
    recipientAllow: text("recipient_allow").array(), // domains/addresses; null = any
    rateLimit: jsonb("rate_limit"), // { perMinute, perHour, perDay }
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("grants_agent_account_uq").on(t.agentId, t.accountId)],
);

export const pendingStatus = pgEnum("pending_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
]);

/** Approval queue for held sends / destructive actions. */
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id").references(() => grants.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "send" | "reply" | "forward" | "delete" ...
    payload: jsonb("payload").notNull(),
    status: pendingStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result"),
    createdAt: createdAt(),
  },
  (t) => [index("pending_actions_org_status_idx").on(t.orgId, t.status, t.createdAt)],
);

/** Append-only audit trail of every allowed and denied action. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    actorType: text("actor_type").notNull(), // "user" | "agent" | "system"
    actorId: uuid("actor_id"),
    accountId: uuid("account_id"),
    action: text("action").notNull(), // e.g. "mail.send", "mail.read"
    target: text("target"),
    allowed: boolean("allowed").notNull(),
    detail: jsonb("detail"),
    ip: text("ip"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_org_at_idx").on(t.orgId, t.at.desc()),
    index("audit_actor_idx").on(t.actorId, t.at.desc()),
  ],
);

// ───────────────────────────── Modules & search state ─────────────────────────────

export const modulesInstalled = pgTable(
  "modules_installed",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    licenseKey: text("license_key"), // reserved for optional paid modules
    installedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.moduleId] })],
);

export const searchIndexState = pgTable("search_index_state", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  driver: text("driver").notNull(),
  lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
  pendingCount: integer("pending_count").notNull().default(0),
  version: integer("version").notNull().default(1),
});

// ───────────────────────────── Admin sessions & app settings ─────────────────────────────

/** Admin-panel login sessions. The cookie holds the raw token; we store only its sha256. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Instance-wide settings managed from the admin panel (storage driver, S3 credentials,
 * search driver, sync defaults...). `.env` only holds the database connection.
 * Values flagged secret are stored master-key-encrypted in `secret_enc`.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(), // e.g. "storage", "search", "sync"
  value: jsonb("value").notNull(), // non-secret part
  secretEnc: bytea("secret_enc"), // encrypted secret part (JSON)
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
