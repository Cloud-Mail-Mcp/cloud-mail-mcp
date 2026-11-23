import type { ParsedQuery } from "./query";
import type { Sort } from "./sort";

/** Document shape every search driver indexes (docs/SPEC.md §8a). */
export interface MailDoc {
  accountId: string;
  messageId: number;
  folderIds: number[];
  threadId?: number;
  from?: string;
  to: string[];
  cc: string[];
  subject?: string;
  /** First ~100 KB of the plain-text body; empty until the body is fetched. */
  bodyText?: string;
  attachmentNames: string[];
  date: Date;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

/**
 * Permission scope, ALWAYS injected by the policy engine from the agent's grants and
 * applied inside the engine's query — never by filtering results afterwards.
 */
export interface SearchScope {
  accountIds: string[];
  /** Per-account folder restriction; absent = all folders of that account. */
  folderIds?: Record<string, number[]>;
}

export interface SearchHit {
  accountId: string;
  messageId: number;
  date: Date;
  score?: number;
  highlight?: string;
}

export interface SearchIndex {
  readonly driver: string;
  upsert(docs: MailDoc[]): Promise<void>;
  delete(refs: Array<{ accountId: string; messageId: number }>): Promise<void>;
  search(
    q: ParsedQuery,
    scope: SearchScope,
    page: { limit: number; cursor?: string; sort?: Sort },
  ): Promise<{
    hits: SearchHit[];
    nextCursor?: string;
  }>;
  semantic?(embedding: number[], scope: SearchScope, k: number): Promise<SearchHit[]>;
  deleteAccount(accountId: string): Promise<void>;
}
