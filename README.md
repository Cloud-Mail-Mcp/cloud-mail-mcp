# MailMCP

Self-hosted email for AI agents. MailMCP connects all your mailboxes, keeps a fast local index of your mail, and lets AI agents (Claude, or your own app) read, search, organize and send mail over MCP. Each agent has its own permissions per mailbox, sends can wait for your approval, and every action is recorded in an audit log.

> **Status: v0.1, early but working end to end** for IMAP/SMTP mailboxes (cPanel and other hosting mail, Apple iCloud, Gmail via app password). Microsoft 365 and the Gmail API are next. See [docs/SPEC.md](docs/SPEC.md).

## Install on your server

You need a Linux server (or any machine) with Docker. If you run your own fork, use your repository in place of `Cloud-Mail-Mcp/mailmcp`.

```bash
# With your own domain: automatic HTTPS certificates (point the domain's DNS at the server first)
curl -fsSL https://github.com/Cloud-Mail-Mcp/mailmcp/releases/latest/download/install.sh | sh -s -- --domain mail.example.com

# Without a domain: plain HTTP on port 8787 (trusted networks only)
curl -fsSL https://github.com/Cloud-Mail-Mcp/mailmcp/releases/latest/download/install.sh | sh
```

The installer creates a `mailmcp/` folder with `compose.yml` and a `.env` (it generates a random database password), then starts everything. Open the address it prints and the **setup wizard** walks you through it:

1. **Your account:** the owner login.
2. **Server:** a name, and the public URL your AI clients will use.
3. **Mail storage:** this server's disk, or S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
4. **Sync:** how much mail to download.
5. **Finish:** back up the encryption key, then add your first mailbox.

The wizard only appears until it's finished. Everything after that is managed in the admin panel.

Installer options: `--domain NAME`, `--dir PATH`, `--port N`, `--edge` (follow every change instead of stable releases), `--auto-update` (apply updates daily), `--repo OWNER/NAME`.

> **Back up your encryption key.** It encrypts every saved mail password and all stored mail, and it is deliberately not in the database:
> `cd mailmcp && docker compose cp mailmcp:/data/master.key ./master.key.backup`

**Other ways to install:**

- **[Enhance](docs/install/enhance.md):** GitHub deploy plus Node.js; no build step, and updates arrive automatically.
- **[cPanel, Plesk or any Node.js host](docs/install/shared-hosting.md):** the prebuilt `mailmcp-node` zip.
- **[Easypanel, Coolify, Dokploy, CapRover, Portainer](docs/install/panels.md):** the Docker image.

### Updates

**Settings → Updates** shows the running version and whether a newer one exists. **Update now** pulls the new image and restarts MailMCP. Your data, settings and key are kept, and database changes apply automatically. You can also choose:

- **Stable releases** (tagged versions) or **Every change** (the `edge` build of `main`).
- Daily automatic updates (`AUTO_UPDATE=true` in `.env`).

From the command line: `cd mailmcp && docker compose pull && docker compose up -d`.

### Publishing your own version (forks)

Nothing is tied to one GitHub account. Fork the repo and the included workflows publish everything under your fork:

- Every push to `main` builds `ghcr.io/<you>/<repo>:edge`.
- Every tag like `v1.2.0` builds `:1.2.0` and `:latest`, and creates a GitHub release with `install.sh` and `compose.yml` attached, already pointing at your repository.
- Installs made from your releases check **your** repository for updates.

One-time step after the first build: on GitHub open **Packages → your image → Package settings** and set visibility to **Public**, so servers can pull it without logging in.

### Try it locally from source

```bash
git clone https://github.com/Cloud-Mail-Mcp/mailmcp mailmcp && cd mailmcp
docker compose -f deploy/docker-compose.yml up -d   # builds the image locally
```

Then open **http://localhost:8787**.

## Connect Claude

**Claude Code:**

```bash
claude mcp add --transport http mailmcp http://localhost:8787/mcp --header "Authorization: Bearer mmcp_…"
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mailmcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8787/mcp",
        "--header",
        "Authorization:${MAILMCP_AUTH}"
      ],
      "env": { "MAILMCP_AUTH": "Bearer mmcp_…" }
    }
  }
}
```

**Any MCP client:** Streamable HTTP at `/mcp` with `Authorization: Bearer <key>`.

### Tools agents get (filtered by their permissions)

| Read                                                                                                               | Organize                                            | Send                                                                   | Folders                                           |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `list_accounts`, `list_folders`, `list_messages`, `search_messages`, `get_message`, `get_thread`, `get_attachment` | `mark_messages`, `move_messages`, `delete_messages` | `send_email`, `reply`, `forward`, `create_draft`, `get_pending_action` | `create_folder`, `rename_folder`, `delete_folder` |

Search syntax: free text plus `from:` `to:` `subject:"…"` `in:<folder>` `after:YYYY-MM-DD` `before:` `has:attachment` `is:unread` `is:flagged`.
Prompts: `triage_inbox`, `summarize_thread`, `draft_reply`.

## How it's built

- **Postgres:** metadata, permissions, and the full-text search index. Shared tables keyed by account, benchmarked in [SPEC §4a](docs/SPEC.md).
- **Blob store:** message bodies, raw source and attachments, compressed and AES-256-GCM encrypted per account. Stored on local disk or any S3-compatible service (configured in **Settings**).
- **Worker:** pg-boss job queue, newest-first resumable sync, IMAP IDLE for instant new mail, a daily full reconcile, and Gmail's daily download limit respected.
- **Modules:** every provider is a plug-in module behind one [Module API](packages/module-sdk/src/index.ts).

```
apps/server        HTTP: MCP endpoint, REST API, admin panel
apps/worker        Sync jobs, IDLE watchers, scheduler
apps/admin         Admin panel (React + Vite + Tailwind)
packages/core      Sync engine, mail service, permissions, approvals, crypto
packages/db        Drizzle schema + migrations
packages/search    Search syntax + Postgres search driver
packages/storage   Blob store drivers (fs, s3) + encryption
packages/module-sdk  The Module API
modules/imap       IMAP/SMTP connector
deploy/            compose.yml (production), install.sh, docker-compose.yml (development)
.github/workflows  CI, and image/release publishing
```

## Development

Requires Node 22+ (`nvm use`), Docker, and pnpm (via `corepack enable`).

```bash
pnpm install
cp .env.example .env                       # only the database URL
pnpm db:up && pnpm db:migrate              # Postgres on localhost:5433
pnpm --filter @mailmcp/admin build
pnpm --filter @mailmcp/server start        # http://127.0.0.1:8787/admin/
pnpm --filter @mailmcp/worker start        # in another terminal
```

`pnpm dev` runs everything with live reload (admin on http://localhost:5173/admin/).

**Test mail server.** GreenMail provides three throwaway mailboxes (see `deploy/docker-compose.yml`):

```bash
docker compose -f deploy/docker-compose.yml --profile testmail up -d greenmail
pnpm --filter @mailmcp/worker seed -- --count 3000   # realistic mail for alice@example.test
pnpm --filter @mailmcp/worker sync-once              # sync all accounts in the foreground
```
In the admin panel choose _Other IMAP server_ with host `127.0.0.1`, IMAP 3143, SMTP 3025, TLS off, user `alice@example.test` / `alice-pass-123`.

The dev stack's Compose project is `mailmcp-dev`, so it never collides with a production install on the same machine.

**Checks:** `pnpm typecheck` · `pnpm lint` · `pnpm test`. Tests include integration and end-to-end suites against GreenMail; they skip themselves if it isn't running.

## Releasing a new version

One command updates every install method together:

```bash
pnpm release 0.2.0 --dry-run   # preview
pnpm release 0.2.0             # bump versions, check, tag v0.2.0, push
```

It checks that `main` is clean, in sync and green on CI. It then bumps the version (including the Easypanel template's pinned image), runs lint and typecheck, and pushes the tag. GitHub Actions builds the Docker image and the Node.js bundle. **Only if both succeed** does it publish them all at once:

- Docker image `:0.2.0` / `:latest`
- the `dist` branch for Enhance and git-deploy hosts
- the GitHub release with the installer, Compose file and zip

Installs see the update after that, through Settings → Updates, auto-deploy, or the updater. Every push to `main` publishes the `edge` image and the `dist-edge` branch the same way.

## License

[AGPL-3.0](LICENSE).
