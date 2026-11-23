import { existsSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  AccessDenied,
  AccountError,
  AgentService,
  ApprovalService,
  createServices,
  MailError,
  MailService,
  MigrationError,
  OAuthService,
  PolicyService,
  type Services,
} from "@mailmcp/core";
import { type Db, sql } from "@mailmcp/db";
import imapModule from "@mailmcp/module-imap";
import type { ModuleManifest } from "@mailmcp/module-sdk";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { config as appConfig } from "./config";
import { mcpRoutes } from "./mcp";
import { accountRoutes } from "./routes/accounts";
import { agentRoutes } from "./routes/agents";
import { approvalRoutes } from "./routes/approvals";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { mailRoutes } from "./routes/mail";
import { migrationRoutes } from "./routes/migrations";
import { CORS_PATHS, oauthRoutes } from "./routes/oauth";
import { settingsRoutes } from "./routes/settings";
import { systemRoutes } from "./routes/system";

/** Installed connector modules. Phase 2 adds msgraph / gmail here. */
export const installedModules: ModuleManifest[] = [imapModule as unknown as ModuleManifest];

export interface AppDeps extends Services {
  config: typeof appConfig;
  policy: PolicyService;
  mail: MailService;
  agents: AgentService;
  approvals: ApprovalService;
  oauth: OAuthService;
  masterKeyInfo: { source: "env" | "file" | "generated"; path?: string };
}

export async function buildApp(opts: {
  db: Db;
  config: typeof appConfig;
  masterKey: Buffer;
  masterKeyInfo: AppDeps["masterKeyInfo"];
  logger?: boolean;
}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: opts.config.trustProxy,
    bodyLimit: 30 * 1024 * 1024, // room for base64 attachments on send
  });

  const services = createServices({
    db: opts.db,
    masterKey: opts.masterKey,
    modules: installedModules,
    dataDir: opts.config.dataDir,
    databaseUrl: opts.config.databaseUrl,
  });
  const policy = new PolicyService(opts.db);
  const mail = new MailService(services, policy);
  const agentsSvc = new AgentService(opts.db);
  const deps: AppDeps = {
    ...services,
    config: opts.config,
    policy,
    mail,
    agents: agentsSvc,
    oauth: new OAuthService(opts.db, policy, agentsSvc),
    approvals: new ApprovalService(opts.db, mail, policy),
    masterKeyInfo: opts.masterKeyInfo,
  };

  await app.register(fastifyCookie);

  // Accept an empty body with content-type JSON (e.g. DELETE / logout from fetch helpers).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error("Request body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // OAuth token/registration/revocation requests are form-encoded (RFC 6749).
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  // MCP clients that run in a browser call discovery, OAuth and /mcp cross-origin. These answer
  // to bearer tokens only (never cookies), so any origin may call them.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!CORS_PATHS.some((re) => re.test(path))) return;
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-expose-headers", "www-authenticate, mcp-session-id");
    if (req.method === "OPTIONS") {
      return reply
        .code(204)
        .header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
        .header(
          "access-control-allow-headers",
          "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
        )
        .header("access-control-max-age", "86400")
        .send();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const i of err.issues) fields[i.path.join(".")] = i.message;
      return reply.code(400).send({ error: "Some fields are invalid.", fields });
    }
    if (err instanceof AccountError)
      return reply.code(err.status).send({ error: err.message, ...err.detail });
    if (err instanceof AccessDenied || err instanceof MailError || err instanceof MigrationError)
      return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply
      .code(status)
      .send({ error: status >= 500 ? "Internal server error" : (err as Error).message });
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await opts.db.execute(sql`select 1`);
      return { ok: true, db: "up" };
    } catch (err) {
      reply.code(503);
      return { ok: false, db: "down", error: (err as Error).message };
    }
  });

  await app.register(async (r) => authRoutes(r, deps));
  await app.register(async (r) => accountRoutes(r, deps));
  await app.register(async (r) => settingsRoutes(r, deps));
  await app.register(async (r) => systemRoutes(r, deps));
  await app.register(async (r) => mailRoutes(r, deps));
  await app.register(async (r) => agentRoutes(r, deps));
  await app.register(async (r) => approvalRoutes(r, deps));
  await app.register(async (r) => auditRoutes(r, deps));
  await app.register(async (r) => oauthRoutes(r, deps));
  await app.register(async (r) => chatRoutes(r, deps));
  await app.register(async (r) => migrationRoutes(r, deps));
  await app.register(async (r) => mcpRoutes(r, deps));

  // Serve the built admin panel at /admin (in dev, Vite serves it on :5173 instead).
  if (existsSync(opts.config.adminDist)) {
    // Files are looked up per request (wildcard), so a rebuild is picked up without restart.
    await app.register(fastifyStatic, { root: opts.config.adminDist, prefix: "/admin/" });
    app.get("/", (_req, reply) => reply.redirect("/admin/"));
  }

  // SPA fallback: unknown /admin/* pages get index.html; missing assets and APIs get a 404.
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    const isPage =
      path.startsWith("/admin") && !path.startsWith("/admin/assets/") && !/\.\w+$/.test(path);
    if (isPage && existsSync(opts.config.adminDist)) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });

  app.addHook("onClose", async () => {
    await services.pool.closeAll();
    await services.jobs.stop();
  });

  return { app, deps };
}
