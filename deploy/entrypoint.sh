#!/bin/sh
# Runs database migrations, then starts the requested role(s).
set -e
cd /app
role="${1:-all}"
run() { exec node --import tsx "$@"; }

echo "[mailmcp] applying database migrations…"
(cd packages/db && node --import tsx src/migrate.ts)

case "$role" in
  server) cd apps/server && run src/index.ts ;;
  worker) cd apps/worker && run src/index.ts ;;
  all)
    (cd apps/worker && node --import tsx src/index.ts) &
    worker=$!
    trap 'kill -TERM $worker 2>/dev/null; kill -TERM $server 2>/dev/null' TERM INT
    (cd apps/server && node --import tsx src/index.ts) &
    server=$!
    # If either process dies, stop the container so it gets restarted.
    while kill -0 $worker 2>/dev/null && kill -0 $server 2>/dev/null; do sleep 2; done
    kill -TERM $worker $server 2>/dev/null || true
    wait
    exit 1
    ;;
  *) echo "usage: entrypoint.sh [server|worker|all]"; exit 64 ;;
esac
