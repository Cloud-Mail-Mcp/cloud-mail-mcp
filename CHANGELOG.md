# Changelog

What's new in each MailMCP version. New entries go under **Unreleased**; `pnpm release X.Y.Z`
turns that section into the new version, and it becomes the GitHub release notes that the admin
panel shows under Settings → Updates.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Connect AI apps by signing in

- Paste your server's `/mcp` URL into Claude (Settings → Connectors → Add custom connector),
  ChatGPT (developer mode connectors), Claude Code, Cursor or VS Code. The app sends you to a
  MailMCP page where you choose which mailboxes it can use and what it may do in each. No API key
  to copy.
- Connected apps appear under Agents with a "signed in" badge. Disabling or removing one cuts it
  off immediately.
- Built on the MCP authorization spec: OAuth 2.1 with PKCE, dynamic client registration, client
  metadata documents, and rotating refresh tokens (reusing an old one ends the session).
- The Agents page shows your MCP URL with step-by-step instructions for each app. API keys still
  work for apps that can't sign in.

### Chat with Claude inside MailMCP

- New **Chat** page. Add your own Anthropic API key under Settings → Assistant to turn it on
  (it's off without one).
- The chat acts as one of your agents, with exactly that agent's permissions: sends wait for
  approval if the agent's policy says so, and everything is recorded in the audit log.
- Choose Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5. The key is stored encrypted and is
  never sent back to the browser.

### Mail

- Each account's folder list folds away, so many mailboxes don't mean endless scrolling. Folded
  accounts show their unread count, and your choice is remembered. With more than three accounts,
  only the one you're viewing starts open.
- Press **Delete** to delete the open message and go straight to the next one. Delete and Archive
  buttons also move on to the next message.
- **J** / **K** move to the next / previous message.
- **Unread only** filter for folders and search.
- Select several messages to act on them together: tick the checkboxes, **Shift**-click to select
  a range, **Ctrl/⌘**-click to add or remove one, or **Select all**, then untick any you want to
  keep. Mark read or unread, flag, archive, move to a folder, or delete them in one go (across
  mailboxes too). **X** selects the open message, **Delete** deletes the selection, **Esc**
  clears it. In Trash, deleting asks first, because it's permanent.
- Opening an unread message marks it as read.
- Images in email now show by default. To stop senders from seeing when you open their mail,
  turn on **Block remote images** under Settings → Mail; then each message has a "Show images"
  button.
- Folder and unread counts update immediately when you read, move, archive or delete mail,
  instead of waiting for the next sync.
- **Unsubscribe** button on newsletters and other list mail (any message with a
  List-Unsubscribe header). It uses the sender's one-click unsubscribe when they support it,
  otherwise sends their unsubscribe email from your account, otherwise opens their unsubscribe
  page. Messages you've unsubscribed from show "Unsubscribed".
- AI agents can unsubscribe too, with the new **Unsubscribe** permission (`unsubscribe` tool).
  It's included in the Assistant presets. Unsubscribing by email counts as sending, so it
  follows the agent's send policy and can wait for your approval.

### Moving to a new mail host

- New **Migrations** page: copy all mail from one account to another, for example the same
  address on your old and new host. Every folder is copied (Inbox, Sent, Trash and the rest are
  matched across servers even when named differently; missing folders are created), with read
  and flagged state.
- Messages already in the other account are skipped, and nothing is ever deleted, so it's safe to
  run again. **Preview folders** shows the plan before you start.
- Keeps copying new mail every couple of minutes until you click **Finish**, so nothing is lost
  while DNS changes. Choose one way or **both ways**, reverse the direction, pause and resume.
- Gmail: archived mail (only in "All Mail") is copied to **Archive**, skipping anything already
  copied from another folder, so nothing is missed and nothing is duplicated. Gmail's
  "Important" and "Starred" views are skipped.
- A migration interrupted by a restart or crash picks up where it left off within a minute or
  two, without copying anything twice.
- The same address can be connected more than once with different logins (old and new server).
  Each gets a **label** (the server name by default, editable), shown in Mail, Accounts,
  Permissions and to AI agents.

### Accounts

- **Import from spreadsheet** (Accounts page): upload an Excel (.xlsx) or CSV file of mailboxes.
  Columns like Email, Password, Name, Label, Username and IMAP/SMTP server are recognised; only
  Email is required (servers are guessed: Gmail, iCloud, otherwise mail.yourdomain). Rows with a
  password are tested and added; the rest wait for a password. The file is read in your browser,
  so passwords never go through an AI.
- **AI agents can add mailboxes** when you allow it on the agent's page (`add_mailboxes` tool),
  for example from a list you give them. They're added without passwords and wait under
  **Waiting for password** on the Accounts page, where you type each one in; you also choose
  what access the agent gets. Settings → AI agents can let agents send passwords too (off by
  default: passwords shared with an AI stay in its chat history).

- Changing a password or a mail server's address is easier to find: the account page's **Login &
  server settings** (password, IMAP/SMTP server and ports, username), and a "Fix login" link and
  banner when an account can't log in.
- Settings are tested before saving. If the server is briefly unreachable you can **save without
  testing**.
- After a change, MailMCP syncs straight away and the new-mail listener reconnects with the new
  settings (it used to stay on the old server).
- **Accounts** moved down the menu, next to Settings.
- Fixed: after a restart or crash, an account's sync could be stuck for up to an hour.
- Fixed: Gmail's "Important" folder was treated as an ordinary folder. On servers that don't
  mark their special folders, "Trash", "Sent" and so on are now preferred over look-alikes
  such as "Deleted Messages".
- Choosing Gmail or iCloud when adding an account shows step-by-step instructions for creating
  an app password, with buttons that open the right Google or Apple page. The same steps appear
  on the account's settings page when its password needs replacing. Spaces in pasted Gmail app
  passwords are removed automatically.

### Install and updates

- Install on shared hosting and hosting panels: Enhance, cPanel and other Node.js hosts, plus
  Easypanel, Coolify, CapRover and Dokploy. Guides in `docs/install/`.
- Prebuilt Node.js bundle (`dist` branch and a zip on each release) that runs with `npm start`
  on port 3000. No build step and no Docker needed.
- Web installer: if no database is configured yet, the first page asks for the PostgreSQL
  connection, tests it, and saves it.
- Every install method updates together: one `pnpm release` publishes the Docker image, the
  bundle branch and the GitHub release at once, only after all of them have built.
- Hosting panels can update with one click through a redeploy webhook (Settings → Updates).

## [0.1.0] - 2026-11-22

First release.

- Connect IMAP/SMTP mailboxes (cPanel and other hosts, Gmail and iCloud with app passwords, and
  any standard IMAP server) and sync them into a fast local index, encrypted at rest.
- MCP server at `/mcp` for AI agents: search, read, organize, draft, send and delete mail, with
  attachments.
- Per-agent, per-mailbox permissions: scopes, allowed folders, recipient allow-lists, rate limits,
  and a send policy (allow, require approval, or deny).
- Approvals queue for sends that need a human, and an audit log of every agent action.
- Admin panel: accounts, mail browser with sorting by date, sender or subject, agents and API
  keys, permissions, approvals, audit log and settings.
- First-run setup wizard: owner account, server, storage, sync and your first mailbox.
- Install with Docker Compose (optional automatic HTTPS) or from source. In-app update checks and
  one-click updates for Docker installs; forks publish and update from their own repository.

[Unreleased]: https://github.com/Cloud-Mail-Mcp/mailmcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Cloud-Mail-Mcp/mailmcp/releases/tag/v0.1.0
