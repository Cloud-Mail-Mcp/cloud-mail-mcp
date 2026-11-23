/**
 * One search syntax for every account and provider (docs/SPEC.md §7), e.g.
 *   from:alice subject:"q3 invoice" has:attachment after:2026-01-01 in:inbox is:unread budget
 */
export interface ParsedQuery {
  text: string[]; // free-text terms (quoted phrases kept whole)
  from: string[];
  to: string[];
  subject: string[];
  in: string[]; // folder path or role
  after?: Date;
  before?: Date;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isFlagged?: boolean;
}

const TOKEN = /(-?)(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g;

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { text: [], from: [], to: [], subject: [], in: [] };
  for (const m of input.matchAll(TOKEN)) {
    const [, , field, rawValue, phrase, word] = m;
    if (field && rawValue !== undefined) {
      const value = rawValue.replace(/^"|"$/g, "");
      switch (field.toLowerCase()) {
        case "from":
          q.from.push(value);
          break;
        case "to":
          q.to.push(value);
          break;
        case "subject":
          q.subject.push(value);
          break;
        case "in":
          q.in.push(value.toLowerCase());
          break;
        case "after":
          q.after = parseDate(value) ?? q.after;
          break;
        case "before":
          q.before = parseDate(value) ?? q.before;
          break;
        case "has":
          if (value === "attachment") q.hasAttachment = true;
          break;
        case "is":
          if (value === "unread") q.isUnread = true;
          else if (value === "read") q.isUnread = false;
          else if (value === "flagged" || value === "starred") q.isFlagged = true;
          break;
        default:
          q.text.push(`${field}:${value}`); // unknown operator → treat as text
      }
    } else if (phrase !== undefined) {
      if (phrase) q.text.push(phrase);
    } else if (word) {
      q.text.push(word);
    }
  }
  return q;
}

function parseDate(s: string): Date | undefined {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
