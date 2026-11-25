# MailMCP — Product & Architecture Spec

Status: **v0.1 implemented** · Spec date: 2026-11-17 · Updated: 2026-11-20

> **v0.1 status (2026-11-20).**
> - **Built and tested:** IMAP/SMTP module, newest-first resumable sync with IDLE push, a cross-process sync lease and a daily reconcile, order-independent threading, batched encrypted body storage (fs/S3), Postgres search, the mail service (read, search, thread, attachments, mark, move, trash or permanently delete, send, reply, forward, drafts, folders), agents with API keys, per-account grants (scopes, folder allow/deny, send policy, recipient allow-list, rate limit), the approval queue, the audit log, the MCP endpoint (Streamable HTTP, stateless, tools filtered by grant), the admin panel (accounts, mail viewer, agents, permissions, approvals, audit, settings), and the Docker image.
> - **Tests:** unit tests, sync integration tests, and MCP end-to-end tests using the real MCP SDK client against GreenMail.
> - **Not in v0.1 yet:** the local LRU disk cache in front of S3 (§8a); OpenSearch; MCP OAuth 2.1 (API keys only); the Microsoft and Gmail API modules; anything commercial.

> **Current priority: personal use.** The first user is the author: about 20 accounts across cPanel IMAP, Gmail/Workspace, Microsoft 365/Outlook and Apple iCloud, with the largest mailbox under 100k messages (roughly 1–2M messages total). Other tools failed on **volume**. Commercial pieces (licensing, billing, `ee/`, paid modules) are **deferred**. The module architecture stays so that selling modules (one-time purchase) remains an option, but every module may simply ship free.

### Design targets for the first user

- 20+ accounts syncing in parallel without one slow or broken account blocking the others.
- **Headers first, newest first.** Every account is searchable by sender/subject/date within minutes; bodies backfill afterwards.
- **Respect provider limits.** Gmail allows roughly 2.5 GB/day of IMAP downloads per account, so body backfill is throttled and resumable across days. Microsoft/Apple throttling is detected with automatic backoff.
- **Resumable everywhere.** A crash, restart or dropped connection resumes from the stored cursor and never starts over.
- **Integrity checks.** Periodically reconcile counts and UIDs against the server. No silent gaps, no duplicates.

---

## 1. What we're building

MailMCP is a self-hostable server that connects many email accounts, keeps a searchable local index of their mail, and exposes it to AI agents over the Model Context Protocol (MCP) with fine-grained, per-account permissions. It ships with an admin panel for viewing mail, connecting accounts, registering agents and setting permissions.

Three ways to use it:

| Mode                    | Who                                             | How                                                                                                                                                     |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted**         | Individuals, companies, agencies                | `docker compose up` on their own server. Free (AGPL-3.0).                                                                                               |
| **Embedded**            | Developers building their own AI agents or SaaS | Run MailMCP beside their app and talk to it via MCP, the REST API, or the TypeScript SDK. Closed-source products embedding it buy a commercial license. |
| **Hosted (commercial)** | Non-technical users and teams                   | Our cloud. Managed Google/Microsoft OAuth, billing, teams, premium modules, and later a Superhuman-style web client.                                    |

### Goals

- Any mailbox, one interface: IMAP/SMTP, Gmail, Microsoft 365 in the core; more providers through **modules**.
- A local index: fast full-text and semantic search and thread context that doesn't depend on provider rate limits.
- Safe agent access: every agent gets explicit scopes on each account, with approval for sends, an audit log and rate limits.
- Multi-tenant from day one, so the hosted product runs the same codebase.

### Non-goals (for v0.x)

- Being a mail server (we connect to existing mailboxes; we don't host MX/SMTP delivery).
- A full end-user mail client in the open-source core. The admin panel _views_ mail; the polished client is a commercial extension.
- Calendar/contacts sync (possible future modules).

---

## 2. Licensing & business model

- **Core: AGPL-3.0.** Anyone can self-host and modify it. Anyone who offers a modified version as a network service must publish their changes.
- **Commercial license**, for companies that want to embed MailMCP in a closed-source product or host it without the AGPL obligations. Sold by us.
- **CLA required** for outside contributors, so we keep the right to dual-license.
- **Module exception:** the AGPL core includes a _linking exception for modules_ that use only the public Module API (§5). That lets us and third parties ship closed-source paid modules (e.g. Zoho) without forcing them open.
- Paid modules and hosted-only features live in `ee/` (source-available, commercial license) or in a private repo.

### Revenue streams

1. **Hosted plans:** per-mailbox tiers, similar to mcpemails.com ($0 / $9 / $15 / $39).
2. **Premium modules:** e.g. a Zoho Mail module at $25 (one-time vs monthly is undecided, see §13). They work on hosted _and_ self-hosted installs via a license key.
3. **Commercial licenses** for embedding.
4. Later: support contracts and an enterprise edition (SSO/SAML, retention policies, eDiscovery export).

> **Heads-up on Gmail for the hosted product:** using Google's restricted Gmail scopes for public users requires Google OAuth verification **plus an annual CASA security assessment** (several weeks and several thousand dollars). Self-hosters avoid this by creating their own Google Cloud OAuth app or using an app password over IMAP. Budget for this before launching hosted Gmail OAuth.

---

## 3. High-level architecture

```
                ┌──────────────────────────────────────────────────────┐
  AI agents ───►│  MCP endpoint  /mcp   (Streamable HTTP, OAuth 2.1,    │
 (Claude, etc.) │                         API keys)                     │
                │                                                      │
  Apps / SDK ──►│  REST API      /api/v1                               │
                │                                                      │
  Admin UI  ───►│  Admin panel   /admin (React SPA, session auth)      │
                ├──────────────────────────────────────────────────────┤
                │  Policy engine (grants, scopes, approvals, limits)   │
                │  Mail service  (search, read, act — write-through)   │
                ├──────────────────────────────────────────────────────┤
                │  Module host   ── imap ── gmail ── msgraph ── zoho*  │
                │  Sync workers  (pg-boss job queue)                   │
                ├──────────────────┬─────────────────┬─────────────────┤
                │  Postgres        │  Blob store     │  Search index   │
                │  metadata, perms,│  raw MIME,      │  full-text +    │
                │  headers, flags, │  bodies,        │  vectors        │
                │  threads, jobs   │  attachments    │                 │
                │                  │  disk | S3 / R2 │  postgres |     │
                │                  │  / B2 / MinIO   │  opensearch     │
                │                  │  + local cache  │  / elastic      │
                └──────────────────┴─────────────────┴─────────────────┘
                                         * paid module
```

- **One process type, two roles.** The same image runs as `web` (HTTP: MCP, REST, admin) or `worker` (sync and outbound jobs). Small installs run both in one container.
- **Three storage layers, each matched to its job** (details in §8a):
  - **Postgres** holds small, relational, frequently-queried data: accounts, permissions, headers, flags, threads and the job queue (`pg-boss`, so no Redis).
  - **Blob store** holds the large, write-once bytes: raw MIME, parsed bodies and attachments. It runs on local disk or any S3-compatible service.
  - **Search index** handles full-text and semantic search through a swappable driver: Postgres by default, OpenSearch/Elasticsearch at scale.
- **Pluggable, with simple defaults.** A minimal self-host is **Postgres + local disk**, with no extra services. Hosted runs **Postgres + S3/R2 + OpenSearch**. The code is the same; only the config differs.
- **No document database (Mongo).** The slow paths are search and message bytes, and the blob store and search index already cover them. The remaining data is relational, and Postgres JSONB covers the semi-structured parts (headers, provider extras).
- **Write-through actions:** move/delete/send go to the provider first; the index is updated only once the provider confirms. The provider is always the source of truth.

### Repo layout (pnpm + Turborepo)

```
apps/
  server/         Fastify app: MCP endpoint, REST API, auth, serves admin build
  worker/         Sync + outbound job runners (thin; logic lives in packages)
  admin/          React + Vite + TanStack Router/Query + shadcn/ui
packages/
  core/           Mail service, policy engine, sync orchestration, types
  db/             Drizzle schema, migrations, query helpers
  storage/        BlobStore interface + drivers: fs, s3 (S3/R2/B2/MinIO/Wasabi), LRU disk cache
  search/         SearchIndex interface + drivers: postgres (FTS + pgvector), opensearch (also ES 8.x)
  module-sdk/     Public Module API (types, test harness) — published to npm
  sdk/            Client SDK for embedders (REST + typed helpers) — npm
  mcp-tools/      MCP tool definitions mapped to core services
modules/
  imap/           IMAP/SMTP (imapflow + nodemailer)        — core, free
  gmail/          Gmail API (OAuth)                          — core, free
  msgraph/        Microsoft Graph (OAuth)                    — core, free
ee/               Commercial-licensed: billing, metering, license server,
                  team SSO, premium modules (zoho, …)
deploy/           docker-compose.yml, Helm chart (later), .env.example
docs/
```

---

## 4. Data model (Postgres, every row scoped by `org_id`)

| Table                | Key columns                                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgs`               | id, name, plan                                                                                                                                                                                                                                                                                                      | Self-hosted installs have exactly one org.                                                                                                                                         |
| `users`              | id, email, password_hash (argon2id), mfa                                                                                                                                                                                                                                                                            | Admin panel users.                                                                                                                                                                 |
| `memberships`        | org_id, user_id, role (`owner`/`admin`/`member`/`viewer`)                                                                                                                                                                                                                                                           |                                                                                                                                                                                    |
| `accounts`           | id, org_id, module_id, address, display_name, credentials_enc, status, last_sync_at, settings                                                                                                                                                                                                                       | One connected mailbox. Credentials are encrypted (§9).                                                                                                                             |
| `folders`            | id, account_id, remote_id, path, role (`inbox`/`sent`/`drafts`/`trash`/`spam`/`archive`/null), sync_cursor                                                                                                                                                                                                          | Gmail labels are stored as folders with `kind='label'`.                                                                                                                            |
| `threads`            | id, account_id, remote_thread_id, subject, last_message_at, message_count                                                                                                                                                                                                                                           |                                                                                                                                                                                    |
| `messages`           | (account_id, id) PK, thread_id, remote_id, message_id_hdr, in_reply_to, subject, date, from_address_id, from_name, from_email, seen, flagged, answered, draft, keywords[], snippet (≤300 chars), size, has_attachments, raw_blob_key, body_blob_key, body_state (`none`/`fetched`/`evicted`), headers_extra (jsonb) | **Rows stay small** (about 1 KB each). Bodies live in the blob store. `from_name`/`from_email` are deliberately duplicated from `addresses` so inbox lists don't need a join.      |
| `message_folders`    | (account_id, folder_id, message_id) PK, date, seen                                                                                                                                                                                                                                                                  | Many-to-many link between messages and folders/labels (a Gmail message can carry several labels). `date`/`seen` are copied from `messages` so an inbox page is **one index scan**. |
| `addresses`          | id, org_id, email (lowercased, unique per org), name                                                                                                                                                                                                                                                                | Normalized contacts, shared across accounts.                                                                                                                                       |
| `message_addresses`  | (account_id, message_id, role, address_id)                                                                                                                                                                                                                                                                          | role = `from`/`to`/`cc`/`bcc`/`reply_to`. Powers "all mail with X" queries and contact lookups.                                                                                    |
| `attachments`        | id, message_id, filename, mime, size, content_hash, blob_key (nullable until fetched)                                                                                                                                                                                                                               | Fetched lazily and deduplicated by hash across the org.                                                                                                                            |
| `search_index_state` | account_id, driver, last_indexed_at, pending_count, version                                                                                                                                                                                                                                                         | Tracks index freshness and drives reindexing.                                                                                                                                      |

### 4a. Table layout decision: shared tables, not one table per mailbox

We considered giving each mailbox its own table and benchmarked it on 2026-11-17 against a single shared table. The test used Postgres 17 in Docker on a dev laptop, 20 mailboxes × 100k messages (2M rows, 757 MB), 8 concurrent clients and 15 s per test. Laptop numbers vary by roughly ±30% between runs.

| Query                                 | One shared table            | Table per mailbox      |
| ------------------------------------- | --------------------------- | ---------------------- |
| Inbox page (50 newest, random offset) | **3.7–5.5 ms**              | 10.6 ms                |
| Unread count in inbox                 | **8.3–11.8 ms**             | 14.0 ms                |
| Unified inbox across all 20 accounts  | **11.8 ms** (LATERAL query) | 15.6 ms (20-way UNION) |

**Why one table wins:**

- An index on `(account_id, folder_id, date DESC)` jumps straight to one mailbox's rows. The other 19 accounts' rows are never read, so lookup cost barely grows with table size.
- 20 separate tables mean 20 sets of indexes competing for the same memory cache, which is why per-mailbox tables were slower.
- Per-mailbox tables would need dynamic table names (no ORM support), migrations run N times, a UNION for every cross-account search, and they would hit Postgres catalog limits at hosted scale (100k mailboxes would mean hundreds of thousands of tables and indexes).

**Rules this sets:**

1. Every hot table's primary key and indexes **lead with `account_id`**.
2. Cross-account queries (unified inbox, an agent with access to several mailboxes) use the **`LATERAL` per-account top-N pattern**, never `account_id = ANY(...) ORDER BY date`. That naive form fell back to a full scan and took **4.6 s** in the benchmark, about 400× slower.
3. **No partitioning in v0.1.** Hash partitioning by `account_id` was slightly _slower_ at this size (5.5 ms vs 3.7 ms). Because every primary key already leads with `account_id`, hosted can switch to `PARTITION BY HASH (account_id)` later without schema changes, if vacuum/maintenance at scale needs it.
4. **Normalize first, duplicate only for hot paths.** Contacts, folder membership and threads are their own tables. Fields that every list view needs (`from_name`, `date`, `seen`) are copied onto the row that list queries scan, and the sync engine keeps the copies consistent.
   | `agents` | id, org_id, name, kind (`api_key`/`oauth_client`), created_by | An AI agent / integration. |
   | `api_keys` | id, agent_id, prefix, key_hash (sha256), last_used_at, expires_at | Shown once at creation. |
   | `oauth_clients` / `oauth_tokens` | | For MCP OAuth 2.1 + Dynamic Client Registration. |
   | `grants` | id, agent_id, account_id, scopes[], folder_allow[], folder_deny[], send_policy (`allow`/`approve`/`deny`), rate_limit, expires_at | **The permission model** (§6). |
   | `pending_actions` | id, grant_id, kind (`send`/`delete`/…), payload, status, decided_by, decided_at | Approval queue. |
   | `audit_log` | id, org_id, actor (user/agent), account_id, action, target, result, ip, at | Append-only. |
   | `modules_installed` | org_id, module_id, version, enabled, license_id | |
   | `licenses` | id, org_id, key (signed JWT), entitlements[], expires_at | §5.4. |
   | `instructions` | account_id, text | Per-account guidance for agents ("never reply to legal@…"). |

---

## 5. Module system (connector modules)

Every mail provider, including the built-in ones, is a **module**. The core never imports provider code directly; it talks to modules through the Module API. That gives us one code path to test, and paid modules (Zoho, Yahoo/AOL OAuth, Exchange EWS, JMAP/Fastmail, ProtonMail Bridge…) plug in the same way as the free ones.

### 5.1 Manifest

```ts
export default defineModule({
  id: "zoho-mail",
  name: "Zoho Mail",
  version: "1.0.0",
  apiVersion: 1,                     // Module API version it targets
  kind: "connector",
  license: { required: true, entitlement: "module:zoho-mail" },
  auth: [
    { type: "oauth2", authorizeUrl: "...", tokenUrl: "...", scopes: [...],
      regions: ["com", "eu", "in", "com.au", "jp"] },
  ],
  configSchema: z.object({ region: z.enum([...]) }),   // drives the admin form
  capabilities: {
    folders: true, labels: false, threads: true,
    serverSearch: true, push: "webhook" | "idle" | false,
    send: true, drafts: true, deleteMode: ["trash", "permanent"],
  },
  create: (ctx) => new ZohoConnector(ctx),
});
```

### 5.2 Connector interface (what a module implements)

```ts
interface Connector {
  verify(): Promise<AccountIdentity>;                 // test credentials
  listFolders(): Promise<RemoteFolder[]>;
  sync(folder, cursor | null): AsyncIterable<SyncEvent>; // upsert/delete/flags + new cursor
  fetchMessage(remoteId, opts): Promise<RawMessage>;   // full MIME or parsed parts
  fetchAttachment(remoteId, partId): Promise<Readable>;
  send(msg: OutboundMessage): Promise<SentResult>;
  saveDraft / updateDraft / deleteDraft(...)
  move(ids, toFolder); setFlags(ids, flags); setLabels?(ids, add, remove);
  delete(ids, mode: "trash" | "permanent");
  createFolder? / renameFolder? / deleteFolder?
  search?(query): Promise<RemoteId[]>;                 // optional server-side fallback
  watch?(onChange): Unsubscribe;                       // IDLE / webhook / poll
}
```

The **module context (`ctx`)** gives a module only what it needs: decrypted credentials for _its_ account, a token-refresh callback, a logger, an HTTP client, and a scratch key-value store. Modules get no database access and no view of other accounts.

### 5.3 Loading & distribution

- Modules are npm packages (`@mailmcp/module-*`, or a third-party scope) or signed tarballs from our module registry.
- They are installed from the admin panel (**Modules** page) or the CLI (`mailmcp module add zoho-mail`).
- v1 runs modules in-process. Later: isolated worker threads with a capability-scoped RPC boundary for third-party modules.
- `packages/module-sdk` ships a **conformance test suite**. A module has to pass it to be listed in the registry.

### 5.4 Licensing paid modules

- A purchase issues a **license key**: a JWT signed with our Ed25519 key, containing `org`, `entitlements: ["module:zoho-mail"]`, `expires_at` and `instance_id`.
- Keys are verified **offline** using the public key bundled in the core, so self-hosted installs need no phone-home. They can refresh online periodically if they choose.
- The paid module's own code also checks the entitlement. Its code is closed, so a self-hoster can't strip the check out of the AGPL core.
- On hosted, entitlements come from the Stripe subscription automatically.

> **Product note:** Zoho (and most providers) already work for free through the generic IMAP module with an app password. A paid Zoho module therefore has to offer more than IMAP: OAuth sign-in (no app passwords), data-center region support, Zoho's native API sync (faster, more reliable), and Zoho-specific features (tags, shared mailboxes for org admins). The same applies to any paid module.

### 5.5 Other module kinds (later)

- `tools`: adds MCP tools (e.g. calendar extraction, CRM lookup).
- `hooks`: reacts to new mail (rules, AI triage, webhooks).
- `embedder`: plugs in an embedding provider for semantic search (OpenAI, Voyage, local).

---

## 6. Permission model

Default is **deny**: an agent sees nothing until it has a **grant** on an account.

**Scopes** (per grant):

| Scope                   | Allows                                                    |
| ----------------------- | --------------------------------------------------------- |
| `mail:read`             | list/search/read messages & threads, download attachments |
| `mail:draft`            | create/update/delete drafts                               |
| `mail:send`             | send, reply, forward (subject to `send_policy`)           |
| `mail:organize`         | move, mark read/unread/flagged, label                     |
| `mail:unsubscribe`      | leave mailing lists via the sender's List-Unsubscribe     |
| `mail:delete`           | move to trash                                             |
| `mail:delete:permanent` | expunge (separate scope on purpose)                       |
| `folders:manage`        | create/rename/delete folders                              |

**Grant modifiers**

- `folder_allow` / `folder_deny`: e.g. an agent sees only `INBOX` and `Support/*`.
- `send_policy`: `allow` · `approve` (held in the **Approval queue** until a human accepts) · `deny`.
- `recipient_allow` (optional): sending is restricted to listed domains/addresses.
- `rate_limit`: actions per minute/hour/day.
- `expires_at`: time-boxed access.

**Enforcement**

- The policy engine runs in `core`, so MCP, REST and the SDK all enforce the same rules.
- MCP `tools/list` is **filtered per agent**: an agent without `mail:send` never sees `send_message`.
- Every allowed _and_ denied action is written to `audit_log`.

---

## 7. MCP interface

- **Transport:** Streamable HTTP at `/mcp`, targeting the current MCP spec via the official TypeScript SDK. A stdio shim (`npx @mailmcp/cli connect`) bridges to remote servers for clients that only speak stdio.
- **Auth:** OAuth 2.1 + PKCE + Dynamic Client Registration (for Claude, ChatGPT and other OAuth-capable clients) **or** a bearer API key. On the OAuth consent screen the user picks which accounts and scopes to grant.

### v0.1 tool set (≈20)

| Group    | Tools                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------- |
| Discover | `list_accounts`, `list_folders`, `get_account_instructions`                                     |
| Read     | `search_messages`, `list_messages`, `get_message`, `get_thread`, `get_attachment`, `list_tags`  |
| Compose  | `create_draft`, `update_draft`, `send_draft`, `send_message`, `reply`, `forward`                |
| Organize | `move_messages`, `mark_messages`, `mark_spam`, `tag_messages`                                   |
| Delete   | `delete_messages` (trash; `permanent: true` needs the extra scope)                              |
| Lists    | `unsubscribe` (one-click POST, else unsubscribe email under the send policy, else the web link) |
| Folders  | `create_folder`, `rename_folder`, `delete_folder`                                               |
| Status   | `get_pending_action` (agent checks whether a held send was approved)                            |

- **Resources:** `mailmcp://accounts`, `mailmcp://account/{id}/unread`.
- **Prompts:** `triage_inbox`, `summarize_thread`, `draft_reply`.

**Search syntax.** One query language across providers, compiled to SQL against the index: `from:alice subject:"invoice" has:attachment after:2026-01-01 in:inbox is:unread`, with optional `semantic: true` for pgvector search.

**Prompt-injection hygiene.** Email bodies returned to agents are wrapped as untrusted content (`<email_content untrusted="true">…`). Tool descriptions remind the model that email text is data, not instructions. Send approval is the backstop.

---

## 8. Sync & indexing

| Provider | Initial sync                     | Incremental                                                | Push                                                 |
| -------- | -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| IMAP     | UID FETCH by batch, newest first | CONDSTORE/QRESYNC if supported, otherwise UID + flags diff | IDLE on INBOX (configurable folders)                 |
| Gmail    | `messages.list` pages            | `history.list` from stored historyId                       | Pub/Sub watch (hosted) / polling (self-host default) |
| Graph    | `/messages` pages per folder     | `delta` queries                                            | Change-notification subscriptions (hosted) / polling |

- **Backfill window:** configurable per account (default: last 12 months full bodies, older mail as headers only, everything searchable by header).
- **Storage budget:** per account. Bodies of old mail are evicted first, then attachments. Headers are always kept.
- **Jobs:** `sync.account`, `sync.folder`, `fetch.body`, `fetch.attachment`, `index.message`, `index.rebuild`, `send.outbound`, `embed.message`. All are idempotent and retried with backoff by pg-boss.

### 8a. Storage & search layers (performance design)

**Blob store (`packages/storage`)**

- Drivers: `fs` (default, local volume) and `s3` (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO; any S3-compatible endpoint).
- Objects:
  - `{org}/{account}/raw/{sha256}.eml.zst`: the original MIME, zstd-compressed (mail typically shrinks 3–5×).
  - `{org}/{account}/body/{message_id}.json.zst`: the parsed body (text, sanitized HTML, part map), so the server doesn't parse MIME on every read.
  - `{org}/att/{sha256}`: attachments, content-addressed and deduplicated across an org's accounts.
- **Encryption:** objects are encrypted client-side (AES-256-GCM with the account's data key) _before_ upload. The storage provider never sees plaintext mail, and deleting an account's data key crypto-shreds its blobs.
- **Hot cache:** an LRU cache on local disk (default 2 GB) in front of S3. Recent and frequently-read messages are served from local disk (~1 ms) instead of S3 (~20–100 ms).
- **Prefetch:** when an agent lists an inbox, bodies for the first N results are warmed into the cache in the background.

**Search index (`packages/search`)**

```ts
interface SearchIndex {
  upsert(docs: MailDoc[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  search(
    q: ParsedQuery,
    scope: { accountIds: string[]; folderIds?: string[] },
    page: Page,
  ): Promise<SearchHit[]>;
  semantic?(embedding: number[], scope, k: number): Promise<SearchHit[]>;
  reindexAccount(accountId: string): Promise<void>;
}
```

| Driver                           | When                                                              | Notes                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` (default)             | Self-host, up to roughly a few million messages                   | `tsvector` + GIN index, `pgvector` for semantic search. No extra service.                                                                                                                                   |
| `opensearch`                     | Hosted and large installs                                         | Apache-2.0 and AWS-managed if wanted. The driver also targets Elasticsearch 8.x. BM25 ranking, k-NN vectors, highlighting, horizontal scale. Uses index-per-shard-group with `org_id`/`account_id` routing. |
| `meilisearch` (community, later) | Small or medium self-hosts that want typo-tolerant instant search | Optional third-party driver.                                                                                                                                                                                |

- **Indexed document:** `id, org_id, account_id, folder_ids, thread_id, from, to, cc, subject, body_text (first 100 KB), attachment_names, date, flags, labels`.
- **Permissions are enforced inside the search query.** The policy engine always injects the `accountIds`/`folderIds` filter from the agent's grants. A search can never return a message the agent can't read; results are not filtered afterwards.
- **The index is derived data.** It can always be rebuilt from Postgres + blobs (`index.rebuild` job), so switching drivers is a reindex, not a migration.
- **Latency targets** (p95, hosted): inbox list < 50 ms · search < 150 ms · open cached message < 30 ms · open uncached message < 200 ms.
- **Health:** per-account status (`ok`/`auth_error`/`throttled`/`error`) shown in the admin panel. Auth errors trigger a re-connect prompt.

---

## 9. Security

- **Configuration lives in the database, not `.env`.** `.env` only says how to reach Postgres. Mail accounts, storage (including S3 credentials) and sync settings are managed in the admin panel and stored in `accounts` / `app_settings`, with secrets encrypted.
- **Credentials:** AES-256-GCM envelope encryption. Each account has a data key, encrypted by the master key. The master key is **never stored in the database** (a DB dump alone must not decrypt anything). It comes from `data/master.key`, auto-generated with mode 600 on first start, or from `MAILMCP_MASTER_KEY` (env, for Docker secrets) or a KMS on hosted. The admin panel shows a warning to back up the key file. Keys can be rotated.
- **Admin auth:** argon2id passwords, TOTP MFA, secure session cookies. OIDC/SAML SSO is an `ee` feature.
- **API keys:** random 32 bytes with a recognizable prefix (`mmcp_…`), stored as a sha256 hash and shown once.
- **Mail viewer:** HTML is sanitized (DOMPurify) and rendered in a sandboxed iframe. Remote images are blocked by default and proxied when allowed.
- **Network:** bind to localhost unless a public URL is configured, Host-header allowlist, CORS locked to the admin origin, rate limiting on auth endpoints.
- **Data at rest:** blobs (bodies, raw MIME, attachments) are encrypted client-side before they reach disk or S3 (§8a). Postgres holds headers and snippets, so docs recommend disk/volume encryption there. "Metadata-only" mode skips storing bodies. Note that the search index holds body text: OpenSearch should run with encryption at rest and stay on a private network.
- **Deletion safety:** `delete_messages` defaults to trash. Permanent delete needs a separate scope and is always audited.

---

## 10. Admin panel (v0.1)

1. **First-run setup:** shown while no users exist; creates the workspace and owner login. The master key file is generated automatically by the server.
2. **Accounts:** add a connection (choose module → form generated from the module's `configSchema` / OAuth button), test it, see sync status, re-auth, remove.
3. **Mail viewer:** account/folder tree, message list, thread view, unified search, attachments. Read-only actions in v0.1, plus move/delete.
4. **Agents:** create agent → API key or "Connect via OAuth" instructions with copy-paste config for Claude Desktop / Claude Code / Cursor / ChatGPT.
5. **Permissions:** matrix of agents × accounts, with a scope editor per grant.
6. **Approval queue:** held sends with a preview → approve / edit / reject.
7. **Audit log:** filterable by agent, account and action.
8. **Modules:** installed/available modules, enter license key.
9. **Settings:** users & roles, storage limits, embedding provider, backups.

---

## 11. Embedding (for developers)

- **REST API** `/api/v1`: the same operations as the MCP tools plus admin operations (create account, create agent, set grants), documented with OpenAPI.
- **`@mailmcp/sdk`:** a typed TypeScript client. Typical embed flow: the host app creates an org per customer → starts an account connection (hosted OAuth URL returned) → creates an agent + grant → hands the agent's MCP URL/key to its AI.
- **Webhooks:** `message.received`, `account.status_changed`, `action.pending`, signed with HMAC.
- **White-label OAuth:** embedders can supply their own Google/Microsoft OAuth app credentials per org.

---

## 12. Hosted / commercial extension (`ee/`)

- Stripe billing, plans, per-mailbox metering, usage limits (actions/month)
- Managed Google/Microsoft OAuth apps (verified)
- Module marketplace & license issuing server
- Teams: SSO (OIDC/SAML), granular roles, org-level approval policies
- Gmail Pub/Sub and Graph webhooks for real-time sync at scale
- Morning brief, follow-up reminders, snooze (mcpemails-style features)
- **Later:** Superhuman-style web client (keyboard-first, AI drafts, split inbox) built on the same API

---

## 13. Roadmap

| Milestone                                  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0.1 — Usable core (personal)**          | Monorepo, DB schema, module host, **IMAP/SMTP module** (cPanel/hosting IMAP, Apple iCloud with app-specific password, Gmail via app password), sync, **BlobStore (fs + s3 drivers, encrypted, disk cache)**, **SearchIndex (postgres driver)**, policy engine, MCP endpoint with API-key auth, ~20 tools, admin panel (setup, accounts, viewer, agents, permissions, audit), Docker Compose (optional MinIO profile) |
| **v0.2 — OAuth everywhere + scale search** | **Microsoft module** (Graph + OAuth, bring your own Entra app registration; required because Microsoft has turned off password IMAP), Gmail API module, MCP OAuth 2.1 + DCR, approval queue, REST API + OpenAPI, SDK, **OpenSearch/Elasticsearch driver** (compose profile)                                                                                                                                          |
| **v0.3 — Smarter**                         | pgvector semantic search, webhooks, hooks modules, per-account instructions, stdio shim                                                                                                                                                                                                                                                                                                                              |
| **Later (optional): Commercial**           | License keys (one-time module purchases), module registry, Zoho module, `ee/` billing, multi-tenant hosted deploy, Google CASA. Only if we decide to sell.                                                                                                                                                                                                                                                           |

---

## 14. Open questions

1. ~~Module pricing~~: **resolved.** If modules are ever sold, it's a one-time purchase. They may stay free; the decision is deferred.
2. **Product name / domain:** "MailMCP" is the working name. Check trademark and domain before any public launch.
3. **Embedding provider default** for semantic search: none (opt-in), a local model, or an API?
4. **Hosted data policy:** mcpemails stores no mail; we index it. That means a privacy policy and data processing agreement (DPA), and possibly a per-account "no local index" option for hosted users.
5. **Repository hosting:** a public GitHub org for the core + a private repo for `ee/`, or one repo with `ee/` source-available?
