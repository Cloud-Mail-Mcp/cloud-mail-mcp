# Installing MailMCP

Pick the option that matches where you'll run it. They're all the same app; only the packaging differs.

| Where                                            | Use                                                                    | Guide                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| A server or VPS with Docker                      | One-line installer: Docker Compose, automatic HTTPS, one-click updates | [Main README](../../README.md#install-on-your-server) |
| **Enhance** (GitHub deploy + Node.js)            | The ready-to-run `dist` branch: no build step, auto-updates on release | [enhance.md](enhance.md)                              |
| cPanel, Plesk, or any host that runs Node.js     | The `mailmcp-node` zip from Releases                                   | [shared-hosting.md](shared-hosting.md)                |
| Easypanel, Coolify, Dokploy, CapRover, Portainer | The Docker image `ghcr.io/cloud-mail-mcp/mailmcp`                      | [panels.md](panels.md)                                |

**Every install needs:**

- **PostgreSQL 13 or newer.** Most panels can create one for you, or use a managed one (Neon, Supabase, …).
- **Persistent storage for MailMCP's data folder.** It holds the encryption key (`master.key`), local mail storage, and the saved database connection. **Back up `master.key`**: without it, saved mail passwords and stored mail can't be decrypted.

**First start.** If no database is configured, MailMCP shows a **Connect a database** page. It asks for a one-time setup code, which proves you control the server; you'll find it in the data folder (`setup-code.txt`) and in the app log. It then asks for your PostgreSQL details, tests them, saves them, and continues to the setup wizard.

**What each install type supports:**

|                 | Docker installer            | Enhance / Node bundle          | Docker panels                                |
| --------------- | --------------------------- | ------------------------------ | -------------------------------------------- |
| Database setup  | Automatic                   | Web installer                  | Panel env var or web installer               |
| Background sync | Built in                    | Built in (same process)        | Built in                                     |
| Updates         | "Update now" button         | Auto-deploy from `dist` branch | Panel redeploy, or webhook from "Update now" |
| HTTPS           | Built-in Caddy (`--domain`) | Your panel                     | Your panel                                   |
