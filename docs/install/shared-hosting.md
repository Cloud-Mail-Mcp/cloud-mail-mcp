# Install MailMCP on shared hosting (cPanel, Plesk, any Node.js host)

MailMCP ships as a **ready-to-run Node.js bundle**: one `server.mjs` file plus the admin panel. No `npm install` or build step is needed, and the sync worker runs inside the same process, so a single "Node.js app" slot is enough.

> **Status:** the bundle itself is tested. The cPanel and Plesk steps follow their documented Node.js features but haven't been tried on those panels yet. Reports are welcome.

**You need:**

- Node.js **22.15 or newer**
- A **PostgreSQL 13+** database (from your host, or a managed one such as Neon or Supabase)
- An app that can keep running (not only serve requests on demand)

## 1. Get the bundle

Download `mailmcp-node-<version>.zip` from the [latest release](https://github.com/Cloud-Mail-Mcp/mailmcp/releases/latest) and extract it into a folder **outside** your public web root, for example `~/mailmcp`. (Hosts with Git deploy can deploy the `dist` branch instead.)

## 2. Create the app

**cPanel: "Setup Node.js App"**

- **Node.js version:** 22
- **Application root:** `mailmcp`
- **Application URL:** your (sub)domain
- **Application startup file:** `start.cjs` (a small starter that loads `server.mjs`; cPanel's Node support needs it)
- Create the app, then **Start** it. There's no need to run "NPM Install"; everything is bundled.

**Plesk: Node.js**

- **Document root / Application root:** the extracted folder
- **Application startup file:** `start.cjs`
- Enable Node.js and restart the app.

**Anything else:** run `node server.mjs` from the folder, and keep it running with your host's process manager. It listens on port 8787; change that with `--port <port>` or the `PORT` variable.

## 3. Connect the database

Open your site. MailMCP asks for:

- **A setup code:** found in `~/mailmcp-data/setup-code.txt` or the app log.
- **Your PostgreSQL connection.** For remote or managed databases, set **SSL: Required**.

After saving, the setup wizard continues.

## 4. Back up the encryption key

Download **`~/mailmcp-data/master.key`** and keep it safe. Your data folder lives outside the app folder, so updates never touch it.

## Updating

Download the new zip, replace the app folder's contents, and restart the app. `~/mailmcp-data` (key, saved database connection, stored mail) stays as it is, and database changes apply automatically on start.

## Notes

- Some hosts stop idle Node apps. MailMCP syncs mail in the background, so ask your host for an "always on" app, or add a cron job that opens your site every 5 minutes, for example: `curl -fsS https://your-domain/healthz > /dev/null`.
- If your host sets environment variables, `DATABASE_URL` works too and skips the installer page.
