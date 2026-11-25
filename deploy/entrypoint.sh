#!/bin/sh
# Starts Cloud Mail MCP in the container. The server applies database migrations itself on start,
# and shows a web installer if no database is configured yet.
#   all     (default) one process: web server + background sync worker
#   server  web server only (run a separate `worker` container to scale sync)
#   worker  background sync worker only
set -e
cd /app
role="${1:-all}"

case "$role" in
  all)
    cd apps/server
    CLOUD_MAIL_MCP_EMBEDDED_WORKER=true exec node --import tsx src/index.ts
    ;;
  server) cd apps/server && exec node --import tsx src/index.ts ;;
  worker) cd apps/worker && exec node --import tsx src/index.ts ;;
  *) echo "usage: entrypoint.sh [all|server|worker]"; exit 64 ;;
esac
