import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

const IdParams = z.object({ id: z.uuid() });

/** Copy mail between accounts (moving hosts), once or continuously, one way or both. */
export async function migrationRoutes(app: FastifyInstance, d: AppDeps) {
  const admin = [requireUser(d.db), requireRole("owner", "admin")];

  app.get("/api/v1/migrations", { preHandler: admin }, async (req) => ({
    migrations: await d.migrations.list(req.user.orgId),
  }));

  app.post("/api/v1/migrations/preview", { preHandler: admin }, async (req) => {
    const b = z
      .object({ fromAccountId: z.uuid(), toAccountId: z.uuid(), twoWay: z.boolean().optional() })
      .parse(req.body);
    return d.migrations.preview(req.user.orgId, b.fromAccountId, b.toAccountId, b.twoWay);
  });

  app.post("/api/v1/migrations", { preHandler: admin }, async (req, reply) => {
    const b = z
      .object({
        fromAccountId: z.uuid(),
        toAccountId: z.uuid(),
        twoWay: z.boolean().optional(),
        continuous: z.boolean().optional(),
      })
      .parse(req.body);
    reply.code(201);
    return { migration: await d.migrations.create(req.user.orgId, req.user.id, b) };
  });

  app.patch("/api/v1/migrations/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({
        status: z.enum(["active", "paused", "finished"]).optional(),
        twoWay: z.boolean().optional(),
        continuous: z.boolean().optional(),
        reverse: z.boolean().optional(),
      })
      .parse(req.body);
    return { migration: await d.migrations.update(req.user.orgId, req.user.id, id, b) };
  });

  app.post("/api/v1/migrations/:id/run", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await d.migrations.runNow(req.user.orgId, id);
    return { queued: true };
  });

  app.delete("/api/v1/migrations/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await d.migrations.remove(req.user.orgId, req.user.id, id);
    return { ok: true };
  });
}
