import { aiUsageSince, PRICES_AS_OF } from "@cloud-mail-mcp/core";
import { accounts, and, desc, eq, senderRules, sorterExamples, sql } from "@cloud-mail-mcp/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

/** Settings → AI sorting: usage, sorting older mail, blocked senders and remembered corrections. */
export async function sorterRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);
  const admin = [auth, requireRole("owner", "admin")];
  const IdParams = z.object({ id: z.uuid() });

  app.get("/api/v1/sorter/status", { preHandler: auth }, async () => d.sorter.status());

  /** Sort inbox mail from the last `days` days too (it's otherwise only new mail). */
  app.post("/api/v1/sorter/backfill", { preHandler: admin }, async (req) => {
    const { days } = z.object({ days: z.number().int().min(1).max(365) }).parse(req.body);
    const current = await d.settings.get("sorter");
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    await d.settings.put(
      "sorter",
      { ...current, backfillFrom: from },
      { orgId: req.user.orgId, userId: req.user.id },
    );
    const rows = await d.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.orgId, req.user.orgId));
    for (const a of rows) await d.jobs.enqueueSort(a.id).catch(() => {});
    return { backfillFrom: from, accounts: rows.length };
  });

  /** Each mailbox and whether the AI sorter tags its mail (on unless switched off). */
  app.get("/api/v1/sorter/accounts", { preHandler: auth }, async (req) => ({
    accounts: (
      await d.db
        .select({
          id: accounts.id,
          address: accounts.address,
          label: accounts.label,
          settings: accounts.settings,
        })
        .from(accounts)
        .where(eq(accounts.orgId, req.user.orgId))
        .orderBy(accounts.address)
    ).map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label,
      aiSorting: (a.settings as { aiSorting?: boolean } | null)?.aiSorting !== false,
    })),
  }));

  app.put("/api/v1/sorter/accounts/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { aiSorting } = z.object({ aiSorting: z.boolean() }).parse(req.body);
    await d.db
      .update(accounts)
      .set({
        settings: sql`${accounts.settings} || ${JSON.stringify({ aiSorting })}::jsonb`,
      })
      .where(and(eq(accounts.orgId, req.user.orgId), eq(accounts.id, id)));
    return { id, aiSorting };
  });

  /** Anthropic API usage and estimated cost (AI sorting and Chat), per day, feature and model. */
  app.get("/api/v1/ai/usage", { preHandler: auth }, async (req) => {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(366).default(30) })
      .parse(req.query);
    const rows = await aiUsageSince(d.db, days);
    return {
      pricesAsOf: PRICES_AS_OF,
      days,
      rows: rows.map((r) => ({
        day: r.day,
        feature: r.feature,
        model: r.model,
        requests: r.requests,
        messages: r.messages,
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        cacheReadTokens: Number(r.cacheReadTokens),
        cacheWriteTokens: Number(r.cacheWriteTokens),
        costUsd: Number(r.costMicros) / 1_000_000,
        errors: r.errors,
      })),
    };
  });

  app.get("/api/v1/sorter/senders", { preHandler: auth }, async (req) => ({
    senders: await d.db
      .select({
        id: senderRules.id,
        pattern: senderRules.pattern,
        accountId: senderRules.accountId,
        account: accounts.address,
        createdAt: senderRules.createdAt,
      })
      .from(senderRules)
      .leftJoin(accounts, eq(accounts.id, senderRules.accountId))
      .where(eq(senderRules.orgId, req.user.orgId))
      .orderBy(desc(senderRules.createdAt)),
  }));

  /** Block an address ("someone@example.com") or a whole domain ("@example.com"). */
  app.post("/api/v1/sorter/senders", { preHandler: admin }, async (req, reply) => {
    const b = z
      .object({
        pattern: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^([^\s@]+)?@[^\s@]+\.[^\s@]+$/, "Enter an address or @domain"),
        accountId: z.uuid().nullable().optional(),
      })
      .parse(req.body);
    const [row] = await d.db
      .insert(senderRules)
      .values({
        orgId: req.user.orgId,
        accountId: b.accountId ?? null,
        pattern: b.pattern,
        createdBy: req.user.id,
      })
      .onConflictDoNothing()
      .returning();
    reply.code(201);
    return { sender: row ?? null };
  });

  app.delete("/api/v1/sorter/senders/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await d.db
      .delete(senderRules)
      .where(and(eq(senderRules.orgId, req.user.orgId), eq(senderRules.id, id)));
    return { ok: true };
  });

  app.get("/api/v1/sorter/examples", { preHandler: auth }, async (req) => ({
    examples: await d.db
      .select()
      .from(sorterExamples)
      .where(eq(sorterExamples.orgId, req.user.orgId))
      .orderBy(desc(sorterExamples.createdAt))
      .limit(500),
  }));

  app.delete("/api/v1/sorter/examples/:id", { preHandler: admin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await d.db
      .delete(sorterExamples)
      .where(and(eq(sorterExamples.orgId, req.user.orgId), eq(sorterExamples.id, id)));
    return { ok: true };
  });
}
