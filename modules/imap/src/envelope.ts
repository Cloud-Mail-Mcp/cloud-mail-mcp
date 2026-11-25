import type {
  AttachmentInfo,
  EmailAddress,
  MessageEnvelope,
  MessageFlags,
  RemoteFolder,
} from "@cloud-mail-mcp/module-sdk";
import type {
  FetchMessageObject,
  FetchQueryObject,
  MessageAddressObject,
  MessageStructureObject,
} from "imapflow";

export const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  emailId: true,
  threadId: true,
  headers: ["references"],
};

const addrs = (list?: MessageAddressObject[]): EmailAddress[] =>
  (list ?? [])
    .filter((a) => a.address)
    .map((a) => ({ email: (a.address as string).toLowerCase(), name: a.name || undefined }));

export function toFlags(set?: Set<string>): MessageFlags {
  const f = set ?? new Set<string>();
  return {
    seen: f.has("\\Seen"),
    flagged: f.has("\\Flagged"),
    answered: f.has("\\Answered"),
    draft: f.has("\\Draft"),
    keywords: [...f].filter((k) => !k.startsWith("\\")),
  };
}

/** Walk BODYSTRUCTURE and collect real attachments (not the text/html bodies). */
export function attachmentsFrom(node?: MessageStructureObject): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const walk = (n: MessageStructureObject) => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
    const isBody =
      !filename &&
      n.disposition !== "attachment" &&
      (n.type === "text/plain" || n.type === "text/html");
    if (isBody || n.type.startsWith("multipart/")) return;
    if (!filename && n.disposition !== "attachment" && !n.id) return;
    out.push({
      partId: n.part ?? "1",
      filename,
      mime: n.type,
      size: n.size,
      contentId: n.id?.replace(/^<|>$/g, ""),
      inline: n.disposition === "inline" || (!!n.id && n.disposition !== "attachment"),
    });
  };
  if (node) walk(node);
  return out;
}

const MSGID = /<[^<>\s]+>/g;

export function toEnvelope(
  msg: FetchMessageObject,
  folder: RemoteFolder,
  uidValidity: string,
): MessageEnvelope {
  const env = msg.envelope ?? {};
  const references = msg.headers?.toString("utf8").match(MSGID) ?? [];
  const date = env.date ?? msg.internalDate;
  const parsedDate = date ? new Date(date) : new Date(0);
  const attachments = attachmentsFrom(msg.bodyStructure);
  return {
    // Gmail (X-GM-MSGID) and OBJECTID servers give a folder-independent id; otherwise
    // the id is scoped to this folder + UIDVALIDITY.
    remoteId: msg.emailId ? `eid:${msg.emailId}` : `${folder.remoteId}:${uidValidity}:${msg.uid}`,
    remoteUid: msg.uid,
    remoteThreadId: msg.threadId ? `tid:${msg.threadId}` : undefined,
    messageId: env.messageId,
    inReplyTo: env.inReplyTo,
    references,
    subject: env.subject,
    date: Number.isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate,
    from: addrs(env.from)[0],
    to: addrs(env.to),
    cc: addrs(env.cc),
    bcc: addrs(env.bcc),
    replyTo: addrs(env.replyTo),
    flags: toFlags(msg.flags),
    size: msg.size,
    hasAttachments: attachments.some((a) => !a.inline),
    attachments,
  };
}

/** Compress a UID list into an IMAP sequence set: [1,2,3,7] → "1:3,7". */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const u of sorted.slice(1)) {
    if (prev !== undefined && u === prev + 1) {
      prev = u;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = u;
    prev = u;
  }
  if (start !== undefined) parts.push(start === prev ? `${start}` : `${start}:${prev}`);
  return parts.join(",");
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
