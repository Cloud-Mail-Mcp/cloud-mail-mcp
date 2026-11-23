import { accounts, agents, and, auditLog, desc, eq, ilike, lt, type SQL, users } from "@mailmcp/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireUser } from "../auth";

export async function auditRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);

  app.get("/api/v1/audit", { preHandler: auth }, async (req) => {
    const q = z
      .object({
        action: z.string().max(100).optional(),
        accountId: z.uuid().optional(),
        actorType: z.enum(["user", "agent", "system"]).optional(),
        allowed: z.enum(["true", "false"]).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const conds: SQL[] = [eq(auditLog.orgId, req.user.orgId)];
    if (q.action) conds.push(ilike(auditLog.action, `${q.action.replace(/[%_\\]/g, "\\$&")}%`));
    if (q.accountId) conds.push(eq(auditLog.accountId, q.accountId));
    if (q.actorType) conds.push(eq(auditLog.actorType, q.actorType));
    if (q.allowed) conds.push(eq(auditLog.allowed, q.allowed === "true"));
    if (q.before) conds.push(lt(auditLog.id, q.before));
    const rows = await d.db
      .select({
        entry: auditLog,
        account: accounts.address,
        agentName: agents.name,
        userEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(accounts, eq(accounts.id, auditLog.accountId))
      .leftJoin(agents, eq(agents.id, auditLog.actorId))
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(...conds))
      .orderBy(desc(auditLog.id))
      .limit(q.limit);
    return {
      entries: rows.map((r) => ({
        ...r.entry,
        account: r.account,
        actor: r.agentName ?? r.userEmail ?? r.entry.actorType,
      })),
      nextBefore: rows.length === q.limit ? rows.at(-1)?.entry.id : undefined,
    };
  });
}
