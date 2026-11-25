#!/bin/sh
# Cloud Mail MCP installer — sets up the Docker stack in a folder and starts it.
#
#   curl -fsSL https://github.com/Cloud-Mail-Mcp/cloud-mail-mcp/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --domain mail.example.com
#
# Options:
#   --domain NAME     serve on https://NAME with automatic certificates (DNS must point here)
#   --dir PATH        install folder (default: ./cloud-mail-mcp)
#   --edge            follow every change on the main branch instead of stable releases
#   --auto-update     apply updates automatically once a day
#   --repo OWNER/NAME install from a different repository (forks)
#   --port N          port for plain-HTTP installs without a domain (default 8787)
#
# Advanced (mirrors / air-gapped): CLOUD_MAIL_MCP_IMAGE=registry/name, CLOUD_MAIL_MCP_COMPOSE_URL=<url or file://>
#
# Re-running in an existing folder upgrades compose.yml and restarts; .env is kept.
set -eu

REPO="${CLOUD_MAIL_MCP_REPO:-${MAILMCP_REPO:-__REPO__}}" # filled in by the release workflow
# Installs made before the rename live in ./mailmcp: re-running there upgrades that install.
DIR="./cloud-mail-mcp"
[ -d ./mailmcp ] && [ ! -d ./cloud-mail-mcp ] && DIR="./mailmcp"
DOMAIN=""
TAG="latest"
AUTO_UPDATE="false"
PORT="8787"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --edge) TAG="edge"; shift ;;
    --auto-update) AUTO_UPDATE="true"; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

case "$REPO" in
  __REPO__|"") [ -n "${CLOUD_MAIL_MCP_IMAGE:-${MAILMCP_IMAGE:-}}" ] && [ -n "${CLOUD_MAIL_MCP_COMPOSE_URL:-${MAILMCP_COMPOSE_URL:-}}" ] || die "Repository unknown. Use the install.sh from a GitHub release, or pass --repo owner/name." ;;
esac
command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."
command -v curl >/dev/null 2>&1 || die "curl is required."

REPO_LC=$(printf '%s' "$REPO" | tr 'A-Z' 'a-z')
IMAGE="${CLOUD_MAIL_MCP_IMAGE:-${MAILMCP_IMAGE:-ghcr.io/$REPO_LC}}"
COMPOSE_URL="${CLOUD_MAIL_MCP_COMPOSE_URL:-${MAILMCP_COMPOSE_URL:-https://github.com/$REPO/releases/latest/download/compose.yml}}"
mkdir -p "$DIR"
cd "$DIR"

say "Downloading compose.yml"
curl -fsSL "$COMPOSE_URL" -o compose.yml.new
mv compose.yml.new compose.yml

if [ ! -f .env ]; then
  say "Creating .env"
  PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  {
    echo "# Cloud Mail MCP settings for docker compose. Mail accounts and everything else are set in the admin panel."
    echo "CLOUD_MAIL_MCP_IMAGE=$IMAGE"
    echo "CLOUD_MAIL_MCP_TAG=$TAG"
    echo "POSTGRES_PASSWORD=$PW"
    echo "AUTO_UPDATE=$AUTO_UPDATE"
    if [ -n "$DOMAIN" ]; then
      echo "DOMAIN=$DOMAIN"
      echo "COMPOSE_PROFILES=https"
      echo "CLOUD_MAIL_MCP_BIND=127.0.0.1:8787"
      echo "SECURE_COOKIES=true"
      echo "TRUST_PROXY=true"
    else
      echo "# No domain: plain HTTP on port $PORT. Re-run with --domain for HTTPS."
      echo "CLOUD_MAIL_MCP_BIND=0.0.0.0:$PORT"
      echo "SECURE_COOKIES=false"
    fi
  } > .env
  chmod 600 .env
else
  say "Keeping existing .env"
  # The image moved with the project's new name (the old name keeps receiving updates too).
  sed -i.bak 's#ghcr.io/cloud-mail-mcp/mailmcp$#ghcr.io/cloud-mail-mcp/cloud-mail-mcp#' .env && rm -f .env.bak
fi

say "Pulling images"
docker compose pull
say "Starting Cloud Mail MCP"
docker compose up -d

URL="http://$(hostname 2>/dev/null || echo localhost):$PORT"
[ -n "$DOMAIN" ] && URL="https://$DOMAIN"
grep -q '^DOMAIN=' .env && URL="https://$(sed -n 's/^DOMAIN=//p' .env)"

cat <<EOF

  Cloud Mail MCP is starting. Open $URL and follow the setup wizard.

  Back up your encryption key once setup is done (it is NOT in the database):
    cd $(pwd) && docker compose cp mailmcp:/data/master.key ./master.key.backup

  Update later from Settings → Updates, or here with:
    docker compose pull && docker compose up -d
EOF
if [ -z "$DOMAIN" ] && ! grep -q '^DOMAIN=' .env; then
  echo "  Note: without --domain, traffic (including API keys) is not encrypted. Use it on a trusted network only."
fi
