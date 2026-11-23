/** Permission scopes an agent can hold on an account (docs/SPEC.md §6). */
export const SCOPES = {
  "mail:read": "List, search and read messages, threads and attachments",
  "mail:draft": "Create, update and delete drafts",
  "mail:send": "Send, reply and forward (subject to the grant's send policy)",
  "mail:organize": "Move messages, mark read/unread/flagged, apply labels",
  "mail:delete": "Move messages to trash",
  "mail:delete:permanent": "Permanently delete (expunge) messages",
  "folders:manage": "Create, rename and delete folders",
} as const;

export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const isScope = (s: string): s is Scope => s in SCOPES;
