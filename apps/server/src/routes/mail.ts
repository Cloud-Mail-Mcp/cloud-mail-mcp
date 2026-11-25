import { MailError } from "@cloud-mail-mcp/core";
import { parseSort } from "@cloud-mail-mcp/search";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";
import { AddressList, Compose, IdList, toCompose } from "../schemas";

/** Mail viewer API for the admin panel (acts as the signed-in user: full org access). */
export async function mailRoutes(app: FastifyInstance, d: AppDeps) {
  const auth = requireUser(d.db);
  const writer = [auth, requireRole("owner", "admin", "member")];
  const access = (req: FastifyRequest) => d.policy.forUser(req.user);
  const Id = z.object({ id: z.coerce.number().int().positive() });

  app.get("/api/v1/mail/folders", { preHandler: auth }, async (req) => {
    const q = z.object({ accountId: z.uuid().optional() }).parse(req.query);
    return { folders: await d.mail.listFolders(await access(req), q.accountId) };
  });

  app.get("/api/v1/mail/messages", { preHandler: auth }, async (req) => {
    const q = z
      .object({
        accountId: z.uuid().optional(),
        folder: z.string().optional(),
        unread: z.coerce.boolean().optional(),
        tag: z.string().max(30).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        sort: z.enum(["date", "from", "subject"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
      })
      .parse(req.query);
    return d.mail.list(await access(req), {
      ...q,
      unreadOnly: q.unread,
      sort: parseSort(q.sort, q.order),
    });
  });

  app.get("/api/v1/mail/search", { preHandler: auth }, async (req) => {
    const q = z
      .object({
        q: z.string().min(1),
        accountId: z.uuid().optional(),
        limit: z.coerce.number().optional(),
        cursor: z.string().optional(),
        sort: z.enum(["date", "from", "subject"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
      })
      .parse(req.query);
    return d.mail.search(await access(req), q.q, { ...q, sort: parseSort(q.sort, q.order) });
  });

  app.get("/api/v1/mail/messages/:id", { preHandler: auth }, async (req) => {
    const { id } = Id.parse(req.params);
    return { message: await d.mail.get(await access(req), id) };
  });

  app.get("/api/v1/mail/messages/:id/thread", { preHandler: auth }, async (req) => {
    const { id } = Id.parse(req.params);
    return d.mail.thread(await access(req), id);
  });

  app.get(
    "/api/v1/mail/messages/:id/attachments/:attId",
    { preHandler: auth },
    async (req, reply) => {
      const p = z.object({ id: z.coerce.number(), attId: z.coerce.number() }).parse(req.params);
      const a = await d.mail.attachment(await access(req), p.id, p.attId);
      reply
        .header("content-type", a.mime || "application/octet-stream")
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        )
        .header("x-content-type-options", "nosniff");
      return reply.send(a.content);
    },
  );

  app.post("/api/v1/mail/messages/mark", { preHandler: writer }, async (req) => {
    const b = z
      .object({ ids: IdList, read: z.boolean().optional(), flagged: z.boolean().optional() })
      .parse(req.body);
    return d.mail.markMessages(await access(req), b.ids, b);
  });

  app.post("/api/v1/mail/messages/move", { preHandler: writer }, async (req) => {
    const b = z.object({ ids: IdList, folder: z.union([z.string(), z.number()]) }).parse(req.body);
    return d.mail.move(await access(req), b.ids, b.folder);
  });

  app.post("/api/v1/mail/messages/spam", { preHandler: writer }, async (req) => {
    const b = z
      .object({ ids: IdList, spam: z.boolean().default(true), blockSender: z.boolean().optional() })
      .parse(req.body);
    return d.mail.markSpam(await access(req), b.ids, b);
  });

  app.post("/api/v1/mail/messages/tags", { preHandler: writer }, async (req) => {
    const b = z.object({ ids: IdList, tags: z.array(z.string().max(30)).max(5) }).parse(req.body);
    const known = new Set((await d.settings.get("sorter")).tags.map((t) => t.id));
    const unknown = b.tags.filter((t) => !known.has(t));
    if (unknown.length) throw new MailError(`Unknown tag: ${unknown.join(", ")}`, 400);
    return d.mail.setTags(await access(req), b.ids, b.tags);
  });

  /** The configured tags with inbox counts, for the mail view's tag filter. */
  app.get("/api/v1/mail/tags", { preHandler: auth }, async (req) => {
    const cfg = await d.settings.get("sorter");
    const counts = new Map((await d.mail.tagCounts(await access(req))).map((c) => [c.tag, c]));
    return {
      enabled: cfg.enabled,
      tags: cfg.tags.map((t) => ({
        id: t.id,
        name: t.name,
        action: t.action,
        inbox: counts.get(t.id)?.total ?? 0,
        unread: counts.get(t.id)?.unread ?? 0,
      })),
    };
  });

  app.post("/api/v1/mail/messages/delete", { preHandler: writer }, async (req) => {
    const b = z.object({ ids: IdList, permanent: z.boolean().optional() }).parse(req.body);
    return d.mail.delete(await access(req), b.ids, b);
  });

  app.post("/api/v1/mail/messages/:id/unsubscribe", { preHandler: writer }, async (req) => {
    const { id } = Id.parse(req.params);
    return d.mail.unsubscribe(await access(req), id);
  });

  app.post("/api/v1/mail/send", { preHandler: writer }, async (req) => {
    const b = Compose.extend({ accountId: z.uuid() }).parse(req.body);
    return d.mail.send(await access(req), b.accountId, toCompose(b));
  });

  app.post("/api/v1/mail/messages/:id/reply", { preHandler: writer }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z
      .object({
        text: z.string().min(1),
        html: z.string().optional(),
        replyAll: z.boolean().optional(),
      })
      .parse(req.body);
    return d.mail.reply(await access(req), id, b);
  });

  app.post("/api/v1/mail/messages/:id/forward", { preHandler: writer }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = z.object({ to: AddressList.min(1), text: z.string().optional() }).parse(req.body);
    return d.mail.forward(await access(req), id, b);
  });
}
