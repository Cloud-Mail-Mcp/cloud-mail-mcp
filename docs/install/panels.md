# Install Cloud Mail MCP on a Docker hosting panel

For Easypanel, Coolify, Dokploy, CapRover, Portainer and similar panels. They all need the same few things:

| Setting     | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Image       | `ghcr.io/cloud-mail-mcp/cloud-mail-mcp:latest` (or a version such as `:0.1.0`)      |
| Port        | `8787` (HTTP; the panel adds HTTPS)                                                 |
| Volume      | persistent volume at **`/data`** (encryption key, stored mail, saved DB connection) |
| Database    | a PostgreSQL 13+ service (most panels create one in a click)                        |
| Environment | `DATABASE_URL=postgres://user:password@db-host:5432/dbname`, `TRUST_PROXY=true`     |

`DATABASE_URL` is optional: without it, Cloud Mail MCP shows its **Connect a database** page on first visit. The setup code is in `/data/setup-code.txt` and in the container log.

> **Mount `/data` as a persistent volume.** If it's lost, so is the encryption key, and saved mail passwords and stored mail become unreadable. Alternatively, set `CLOUD_MAIL_MCP_MASTER_KEY` to a 32-byte base64 value (`openssl rand -base64 32`) in the panel's environment settings, and keep a copy of it.

> **Status:** these templates follow each panel's documented format but haven't been run on every panel yet. Please report anything that needs adjusting.

## Updates from the admin panel

Panels redeploy containers themselves. To make **Settings → Updates → Update now** work, paste your panel's redeploy webhook there:

- **Coolify:** API URL `https://<coolify>/api/v1/deploy?uuid=<resource-uuid>&force=true`, with the Authorization header `Bearer <API token>`. API access must be enabled in Coolify.
- **Dokploy / Easypanel / CapRover:** use the deploy or webhook URL shown in the app's deployment settings, if your version provides one.

Otherwise, use the panel's own "Redeploy" or "Pull latest image" button.

## Easypanel

**Manually:** create a **Postgres** service, then an **App** service:

- **Source → Docker image:** `ghcr.io/cloud-mail-mcp/cloud-mail-mcp:latest`
- **Environment:**
  `DATABASE_URL=postgres://postgres:<password>@<project>_<postgres-service>:5432/<project>?sslmode=disable` and `TRUST_PROXY=true`
- **Mounts:** volume `data` → `/data`
- **Domains:** your domain → port `8787`

A template for Easypanel's catalogue is in [`deploy/panels/easypanel/`](../../deploy/panels/easypanel) (pending submission).

## Coolify

**New resource → Docker Compose**, and paste [`deploy/panels/coolify.compose.yml`](../../deploy/panels/coolify.compose.yml). Coolify generates the database password and gives the app a domain.

## Dokploy

**Create → Compose** with the contents of [`deploy/compose.yml`](../../deploy/compose.yml), minus the `updater` and `caddy` services (Dokploy provides routing and HTTPS). Set the variables in the **Environment** tab (`CLOUD_MAIL_MCP_IMAGE=ghcr.io/cloud-mail-mcp/cloud-mail-mcp`, `POSTGRES_PASSWORD`, `CLOUD_MAIL_MCP_BIND=0.0.0.0:8787`, `TRUST_PROXY=true`), since Dokploy writes them to a `.env` file.

## CapRover

1. Create a **PostgreSQL** one-click app.
2. Create an app:
   - **Deployment → Deploy via ImageName:** `ghcr.io/cloud-mail-mcp/cloud-mail-mcp:latest`. Or deploy a tarball containing [`deploy/panels/caprover/captain-definition`](../../deploy/panels/caprover/captain-definition).
   - **App Configs:** container HTTP port `8787`, a persistent directory `/data`, and the `DATABASE_URL` / `TRUST_PROXY=true` environment variables.

## Portainer (or plain Docker)

Use [`deploy/compose.yml`](../../deploy/compose.yml) as a stack. It includes Postgres, the updater, and optional Caddy HTTPS. Or run the image directly:

```bash
docker run -d --name cloud-mail-mcp -p 8787:8787 -v cloud-mail-mcp-data:/data \
  -e DATABASE_URL=postgres://… -e SECURE_COOKIES=false ghcr.io/cloud-mail-mcp/cloud-mail-mcp:latest
```

(`SECURE_COOKIES=false` only for plain-HTTP testing; leave it out behind HTTPS.)
