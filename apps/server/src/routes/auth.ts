import { audit } from "@mailmcp/core";
import { count, memberships, orgs, sql, users } from "@mailmcp/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import {
  AttemptLimiter,
  createSession,
  destroySession,
  hashPassword,
  requireRole,
  requireUser,
  SESSION_COOKIE,
  userFromSession,
  verifyPassword,
} from "../auth";

const SetupBody = z.object({
  orgName: z.string().trim().min(1).max(100).default("My MailMCP"),
  name: z.string().trim().max(100).optional(),
  email: z.email(),
  password: z.string().min(10, "Use at least 10 characters"),
});

const LoginBody = z.object({ email: z.string().trim().min(1), password: z.string().min(1) });

export async function authRoutes(app: FastifyInstance, { db, config, settings }: AppDeps) {
  const limiter = new AttemptLimiter();
  // Secure when configured, or whenever this request arrived over HTTPS (also via a trusted proxy).
  const cookieOpts = (req: { protocol: string }) => ({
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.secureCookies || req.protocol === "https",
  });

  const needsSetup = async () => {
    const [row] = await db.select({ n: count() }).from(users);
    return (row?.n ?? 0) === 0;
  };

  /**
   * The setup wizard shows until it's finished: step 1 (create the owner) needs no login,
   * the remaining steps (server, storage, sync) run signed in.
   */
  app.get("/api/v1/setup/status", async () => {
    const hasUsers = !(await needsSetup());
    const { completedAt } = await settings.get("setup");
    return { needsSetup: !completedAt, hasUsers, completedAt };
  });

  app.post(
    "/api/v1/setup/complete",
    { preHandler: [requireUser(db), requireRole("owner", "admin")] },
    async (req) => {
      const cur = await settings.get("setup");
      if (cur.completedAt) return { completedAt: cur.completedAt };
      const r = await settings.put(
        "setup",
        { completedAt: new Date().toISOString() },
        { orgId: req.user.orgId, userId: req.user.id },
      );
      return { completedAt: (r.value as { completedAt: string }).completedAt };
    },
  );

  /** First-run: create the organization and owner account. Only works while no users exist. */
  app.post("/api/v1/setup", async (req, reply) => {
    const body = SetupBody.parse(req.body);
    // Serialize concurrent setup attempts; only the first can succeed.
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(4242001)`);
      const [row] = await tx.select({ n: count() }).from(users);
      if ((row?.n ?? 0) > 0) return null;
      const [org] = await tx.insert(orgs).values({ name: body.orgName }).returning();
      const [user] = await tx
        .insert(users)
        .values({
          email: body.email.toLowerCase(),
          name: body.name || null,
          passwordHash: await hashPassword(body.password),
        })
        .returning();
      await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: "owner" });
      return { org: org!, user: user! };
    });
    if (!created) return reply.code(409).send({ error: "Setup has already been completed." });
    await audit(db, {
      orgId: created.org.id,
      actorType: "user",
      actorId: created.user.id,
      action: "setup.complete",
      ip: req.ip,
    });
    const s = await createSession(db, created.user.id, req);
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts(req), expires: s.expiresAt });
    return { ok: true };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const key = `${req.ip}|${body.email.toLowerCase()}`;
    if (limiter.blocked(key)) {
      return reply.code(429).send({ error: "Too many attempts. Try again in 15 minutes." });
    }
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`);
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !ok) {
      limiter.fail(key);
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    limiter.reset(key);
    const s = await createSession(db, user.id, req);
    reply.setCookie(SESSION_COOKIE, s.token, { ...cookieOpts(req), expires: s.expiresAt });
    const me = await userFromSession(db, s.token);
    if (me) {
      await audit(db, {
        orgId: me.orgId,
        actorType: "user",
        actorId: me.id,
        action: "auth.login",
        ip: req.ip,
      });
    }
    return { ok: true };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: requireUser(db) }, async (req) => ({ user: req.user }));
}
