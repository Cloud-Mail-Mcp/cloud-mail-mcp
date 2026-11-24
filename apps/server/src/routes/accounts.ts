import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

const TestBody = z.object({
  moduleId: z.string(),
  address: z.email(),
  config: z.record(z.string(), z.unknown()),
});
const CreateBody = TestBody.extend({
  displayName: z.string().max(100).optional(),
  label: z.string().max(60).optional(),
});
const UpdateBody = z.object({
  displayName: z.string().max(100).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().max(4000).nullable().optional(),
  skipTest: z.boolean().optional(),
});
const IdParams = z.object({ id: z.uuid() });
const Mailbox = z.object({
  address: z.string().trim().max(320),
  displayName: z.string().max(100).optional(),
  label: z.string().max(60).optional(),
  provider: z.string().max(20).optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  username: z.string().max(320).optional(),
  password: z.string().max(1000).optional(),
});

export async function accountRoutes(
  app: FastifyInstance,
  { db, registry, accounts, jobs, pool, drafts }: AppDeps,
) {
  const auth = requireUser(db);
  const admin = [auth, requireRole("owner", "admin")];

  app.get("/api/v1/modules", { preHandler: auth }, async () => ({
    modules: registry.list().map((m) => registry.describe(m)),
  }));

  app.get("/api/v1/accounts", { preHandler: auth }, async (req) => ({
    accounts: await accounts.list(req.user.orgId),
  }));

  /**
   * Add many mailboxes (spreadsheet import): rows with a password are tested and added, the rest
   * wait for a password. The browser sends a few rows per request to show progress.
   */
  app.post("/api/v1/accounts/bulk", { preHandler: admin }, async (req) => {
    const b = z.object({ mailboxes: z.array(Mailbox).min(1).max(50) }).parse(req.body);
    return {
      results: await drafts.add(req.user.orgId, { type: "user", id: req.user.id }, b.mailboxes),
    };
  });

  /** Mailboxes waiting for a password (added by an agent or an import without passwords). */
  app.get("/api/v1/accounts/drafts", { preHandler: auth }, async (req) => ({
    drafts: await drafts.list(req.user.orgId),
  }));

  app.post("/api/v1/accounts/drafts/:id/complete", { preHandler: admin }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({
        password: z.string().min(1).max(1000),
        access: z.enum(["none", "read", "assistant", "send_approval"]).nullable().optional(),
      })
      .parse(req.body);
    reply.code(201);
    return { account: await drafts.complete(req.user.orgId, req.user.id, id, b) };
  });

  app.delete("/api/v1/accounts/drafts/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await drafts.remove(req.user.orgId, req.user.id, id);
    return { ok: true };
  });

  /** Try settings without saving. */
  app.post("/api/v1/accounts/test", { preHandler: admin }, async (req) => {
    const b = TestBody.parse(req.body);
    return accounts.test(b.moduleId, b.address, b.config);
  });

  app.post("/api/v1/accounts", { preHandler: admin }, async (req, reply) => {
    const b = CreateBody.parse(req.body);
    reply.code(201);
    const account = await accounts.create(req.user.orgId, req.user.id, b);
    await jobs.enqueueSync({ accountId: account.id, reason: "created" }).catch(() => {});
    return { account };
  });

  app.get("/api/v1/accounts/:id", { preHandler: auth }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return { account: await accounts.get(req.user.orgId, id) };
  });

  app.patch("/api/v1/accounts/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = UpdateBody.parse(req.body);
    const account = await accounts.update(req.user.orgId, req.user.id, id, b);
    if (b.config) {
      await pool.evict(id); // reconnect with the new settings
      await jobs.enqueueSync({ accountId: id, reason: "settings" }).catch(() => {});
    }
    return { account };
  });

  app.post("/api/v1/accounts/:id/refresh-folders", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return { account: await accounts.refreshFolders(req.user.orgId, id) };
  });

  /** Queue a sync now (optionally a full reconcile of flags and deletions). */
  app.post("/api/v1/accounts/:id/sync", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { full } = z.object({ full: z.boolean().optional() }).parse(req.body ?? {});
    await accounts.row(req.user.orgId, id);
    await jobs.enqueueSync({ accountId: id, full, reason: "manual" });
    return { queued: true };
  });

  app.delete("/api/v1/accounts/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await accounts.remove(req.user.orgId, req.user.id, id);
    return { ok: true };
  });
}
