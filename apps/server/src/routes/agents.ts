import { ALL_SCOPES, SCOPES } from "@mailmcp/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

const GrantBody = z.object({
  scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])),
  folderAllow: z.array(z.string().max(200)).max(50).nullable().optional(),
  folderDeny: z.array(z.string().max(200)).max(50).nullable().optional(),
  sendPolicy: z.enum(["allow", "approve", "deny"]).optional(),
  recipientAllow: z.array(z.string().max(200)).max(200).nullable().optional(),
  rateLimit: z
    .object({
      perMinute: z.number().int().positive().optional(),
      perHour: z.number().int().positive().optional(),
      perDay: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export async function agentRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);
  const admin = [auth, requireRole("owner", "admin")];
  const Id = z.object({ id: z.uuid() });

  app.get("/api/v1/scopes", { preHandler: auth }, async () => ({ scopes: SCOPES }));

  app.get("/api/v1/agents", { preHandler: auth }, async (req) => ({
    agents: await d.agents.list(req.user.orgId),
  }));

  app.post("/api/v1/agents", { preHandler: admin }, async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(500).optional(),
      })
      .parse(req.body);
    reply.code(201);
    return d.agents.create(req.user.orgId, req.user.id, b);
  });

  app.get("/api/v1/agents/:id", { preHandler: auth }, async (req) => {
    const { id } = Id.parse(req.params);
    return { agent: await d.agents.get(req.user.orgId, id) };
  });

  app.patch("/api/v1/agents/:id", { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        disabled: z.boolean().optional(),
        canAddAccounts: z.boolean().optional(),
      })
      .parse(req.body);
    return { agent: await d.agents.update(req.user.orgId, req.user.id, id, b) };
  });

  app.delete("/api/v1/agents/:id", { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    await d.agents.remove(req.user.orgId, req.user.id, id);
    return { ok: true };
  });

  app.post("/api/v1/agents/:id/keys", { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    const k = await d.agents.issueKey(req.user.orgId, req.user.id, id);
    return { apiKey: k.raw, prefix: k.prefix };
  });

  app.delete("/api/v1/agents/:id/keys/:keyId", { preHandler: admin }, async (req) => {
    const p = z.object({ id: z.uuid(), keyId: z.uuid() }).parse(req.params);
    await d.agents.revokeKey(req.user.orgId, req.user.id, p.id, p.keyId);
    return { ok: true };
  });

  app.put("/api/v1/agents/:id/grants/:accountId", { preHandler: admin }, async (req) => {
    const p = z.object({ id: z.uuid(), accountId: z.uuid() }).parse(req.params);
    const b = GrantBody.parse(req.body);
    const grant = await d.agents.setGrant(req.user.orgId, req.user.id, p.id, {
      ...b,
      accountId: p.accountId,
      scopes: b.scopes as never,
    });
    return { grant };
  });
}
