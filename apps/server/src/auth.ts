import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, type Db, eq, gt, memberships, sessions, users } from "@cloud-mail-mcp/db";
import type { FastifyReply, FastifyRequest } from "fastify";

const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 2 ** 15;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

/** scrypt (memory-hard, built into Node). Stored as "scrypt|N|r|p|salt|hash". */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("|");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("|");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(pw, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

export const SESSION_COOKIE = "cloud_mail_mcp_session";
/** The cookie's name before the rename; still accepted so nobody is signed out by the update. */
export const OLD_SESSION_COOKIE = "mailmcp_session";
export const sessionToken = (cookies: Record<string, string | undefined>) =>
  cookies[SESSION_COOKIE] ?? cookies[OLD_SESSION_COOKIE];
const SESSION_DAYS = 14;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(db: Db, userId: string, req: FastifyRequest) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt,
    ip: req.ip,
    userAgent: req.headers["user-agent"]?.slice(0, 300),
  });
  return { token, expiresAt };
}

export async function destroySession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  orgId: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export async function userFromSession(
  db: Db,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      orgId: memberships.orgId,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser;
  }
}

export function requireUser(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await userFromSession(db, sessionToken(req.cookies));
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    req.user = user;
  };
}

export function requireRole(...roles: SessionUser["role"][]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(req.user.role))
      return reply.code(403).send({ error: "Not allowed for your role" });
  };
}

/** Simple in-memory limiter for login attempts: N failures per window per key. */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60_000,
  ) {}
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && h.resetAt > Date.now() && h.count >= this.max;
  }
  fail(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt < now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}
