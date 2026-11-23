# MailMCP — one image for server + worker.
#   docker build -t mailmcp .
#   docker run -e DATABASE_URL=postgres://... -v mailmcp-data:/data -p 8787:8787 mailmcp
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/admin/package.json apps/admin/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/module-sdk/package.json packages/module-sdk/
COPY packages/search/package.json packages/search/
COPY packages/storage/package.json packages/storage/
COPY modules/imap/package.json modules/imap/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @mailmcp/admin build

FROM base AS runtime
# Set by the release workflow so a running install knows its version and where updates come from.
ARG MAILMCP_VERSION=""
ARG MAILMCP_REVISION=""
ARG MAILMCP_REPO=""
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 MAILMCP_DATA_DIR=/data \
    MAILMCP_VERSION=$MAILMCP_VERSION MAILMCP_REVISION=$MAILMCP_REVISION MAILMCP_REPO=$MAILMCP_REPO
LABEL org.opencontainers.image.title="MailMCP" \
      org.opencontainers.image.description="Self-hosted email server for AI agents (MCP)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=build /app /app
RUN mkdir -p /data /control && chown -R node:node /data /control
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
# server | worker | all
CMD ["all"]
