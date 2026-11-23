import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

export async function approvalRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);
  const admin = [auth, requireRole("owner", "admin")];

  app.get("/api/v1/approvals", { preHandler: auth }, async (req) => {
    const q = z.object({ status: z.enum(["pending", "all"]).default("pending") }).parse(req.query);
    return { approvals: await d.approvals.list(req.user.orgId, q.status) };
  });

  app.post("/api/v1/approvals/:id/:decision", { preHandler: admin }, async (req) => {
    const p = z.object({ id: z.uuid(), decision: z.enum(["approve", "reject"]) }).parse(req.params);
    return d.approvals.decide(req.user.orgId, req.user.id, p.id, p.decision === "approve");
  });
}
