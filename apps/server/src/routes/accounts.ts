import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

const TestBody = z.object({
  moduleId: z.string(),
  address: z.email(),
  config: z.record(z.string(), z.unknown()),
});
const CreateBody = TestBody.extend({ displayName: z.string().max(100).optional() });
const UpdateBody = z.object({
  displayName: z.string().max(100).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().max(4000).nullable().optional(),
});
const IdParams = z.object({ id: z.uuid() });

export async function accountRoutes(
  app: FastifyInstance,
  { db, registry, accounts, jobs, pool }: AppDeps,
) {
  const auth = requireUser(db);
  const admin = [auth, requireRole("owner", "admin")];

  app.get("/api/v1/modules", { preHandler: auth }, async () => ({
    modules: registry.list().map((m) => registry.describe(m)),
  }));

  app.get("/api/v1/accounts", { preHandler: auth }, async (req) => ({
    accounts: await accounts.list(req.user.orgId),
  }));

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
    if (b.config) await pool.evict(id); // reconnect with the new settings
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
