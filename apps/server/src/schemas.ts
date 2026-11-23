import { z } from "zod";

/** Accepts "a@b.com", "Name <a@b.com>", or { name, email }. */
export const Address = z.union([
  z.string().transform((s, ctx) => {
    const m = s.trim().match(/^(?:"?([^"<]*?)"?\s*<)?([^<>\s]+@[^<>\s]+)>?$/);
    if (!m) {
      ctx.addIssue({ code: "custom", message: `Not an email address: ${s}` });
      return z.NEVER;
    }
    return { name: m[1]?.trim() || undefined, email: (m[2] as string).toLowerCase() };
  }),
  z.object({ name: z.string().optional(), email: z.email() }),
]);
export const AddressList = z.array(Address).max(100);

export const Attachment = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().optional(),
  /** base64 */
  content: z.string(),
});

export const Compose = z.object({
  to: AddressList.min(1),
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  subject: z.string().max(998),
  text: z.string().max(1_000_000).optional(),
  html: z.string().max(5_000_000).optional(),
  attachments: z.array(Attachment).max(20).optional(),
});

export const toCompose = (c: z.infer<typeof Compose>) => ({
  ...c,
  attachments: c.attachments?.map((a) => ({ ...a, content: Buffer.from(a.content, "base64") })),
});

export const IdList = z.array(z.coerce.number().int().positive()).min(1).max(500);
