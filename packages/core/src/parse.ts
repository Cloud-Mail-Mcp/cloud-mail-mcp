import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";

export interface ParsedBody {
  text: string;
  /** Original HTML. Sanitize before rendering (the admin panel renders it sandboxed). */
  html: string | null;
  attachments: Array<{
    index: number;
    filename: string | null;
    mime: string;
    size: number;
    contentId: string | null;
    inline: boolean;
    sha256: string;
  }>;
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Very small HTML→text fallback for HTML-only mail. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function snippetOf(text: string, len = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, len);
}

export async function parseRaw(raw: Buffer): Promise<ParsedBody> {
  const m = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const html = typeof m.html === "string" ? m.html : null;
  const text = m.text?.trim() || (html ? htmlToText(html) : "");
  return {
    text,
    html,
    attachments: m.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? null,
      mime: a.contentType,
      size: a.size,
      contentId: a.contentId?.replace(/^<|>$/g, "") ?? null,
      inline: a.contentDisposition === "inline" && !!a.contentId,
      sha256: sha256(a.content),
    })),
  };
}

/** Pull one attachment's bytes back out of the raw message. */
export async function attachmentFromRaw(raw: Buffer, index: number) {
  const m = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const a = m.attachments[index];
  if (!a) return null;
  return {
    filename: a.filename ?? `attachment-${index + 1}`,
    mime: a.contentType,
    content: a.content,
  };
}
