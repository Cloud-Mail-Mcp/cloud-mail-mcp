# Install MailMCP on Enhance

This uses Enhance's **GitHub deploy** and **Node.js** features. Enhance deploys the ready-to-run `dist` branch of the MailMCP repository, so there is no build step, and new releases deploy automatically.

> **Status:** this flow was tested in a local simulation of Enhance's folder layout (`~/deploys/<id>` + `deploys/current`). If any panel label below differs on your Enhance version, please open an issue.

## Before you start

On your Enhance hosting package, make sure that:

- **Node.js** is enabled (Advanced → Node.js should be available on the website).
- **Allow worker processes** is enabled (GitHub deploy requires it).
- **PostgreSQL** is available (your host installs Enhance's PostgreSQL role, version 16).

## 1. Create a PostgreSQL database

In the website's **Databases** section, create a **PostgreSQL** database and a user with full rights on it. Note the **host**, **port** (usually 5432), **database name**, **username** and **password**.

## 2. Deploy from GitHub

1. Open the website → **GitHub** and connect your GitHub account if asked.
2. Repository: **`Cloud-Mail-Mcp/mailmcp`**
3. Branch:
   - **`dist`** for stable releases (recommended), or
   - **`dist-edge`** to get every change as soon as it's merged.
4. **Build command:** leave empty. The branch is already built.
5. **Publish directory:** leave empty.
6. Turn **auto deploy** on, so each new release installs itself.
7. Deploy. The files land in `~/deploys/<id>`, with `~/deploys/current` pointing at the latest deploy.

## 3. Run it as a Node.js app

Open the website → **Advanced** → **Node.js** → **Deploy app**:

| Setting           | Value                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Node.js version   | **22** (MailMCP needs 22.15 or newer)                                                      |
| Working directory | `deploys/current`                                                                          |
| Startup command   | `node server.mjs`                                                                          |
| Port              | `8787` (any free port ≥ 1024 works; if you change it, use `node server.mjs --port <port>`) |
| Proxy             | the whole website                                                                          |
| Startup mode      | **Automatic** (Enhance restarts it if it stops)                                            |

## 4. Connect the database and finish setup

1. Open your website. You'll see **Connect a database**.
2. **Setup code:** in **File Manager**, open `mailmcp-data/setup-code.txt` in the website's home folder (it's also in the app log, `persistent_app_*.log`).
3. Enter the PostgreSQL details from step 1. Use **SSL: Off** if the database runs on your Enhance cluster. Click **Test connection**, then **Save and continue**.
4. The **setup wizard** opens: create your admin login, then:
   - **Server:** set the public URL to `https://your-domain`;
   - **Mail storage:** this server's disk is fine;
   - **Sync:** keep the defaults;
   - **Mailbox:** connect your first one.

## 5. Back up your encryption key

In **File Manager**, download **`mailmcp-data/master.key`** and keep it somewhere safe, separate from database backups. Without it, saved mail passwords and stored mail can't be decrypted.

## Updates

With auto deploy on, publishing a new release updates the `dist` branch. Enhance deploys it, and within about a minute MailMCP notices the new `deploys/current` and restarts onto it. Database changes apply automatically on start. Your data in `~/mailmcp-data` is never touched by deploys.

## Where things are

| Path (in the website's home folder) | What                                           |
| ----------------------------------- | ---------------------------------------------- |
| `deploys/current/`                  | The running version (replaced on every deploy) |
| `mailmcp-data/master.key`           | Encryption key. **Back it up.**                |
| `mailmcp-data/config.env`           | Saved database connection (private)            |
| `mailmcp-data/blobs/`               | Stored mail (if using this server's disk)      |
| `persistent_app_*.log`              | App log                                        |

## Troubleshooting

- **"MailMCP needs Node.js 22.15 or newer"** in the log: choose a newer Node version in the Node.js app settings.
- **"Port 8787 is already in use"**: pick another port in Enhance and add `--port <port>` to the startup command.
- **The site still shows Enhance's default page:** check that the Node.js app proxies the whole website and its startup mode is Automatic.
- **Forgot the setup code:** restart the app (switch startup mode to Manual and back to Automatic). A new code is written each time the installer starts.
