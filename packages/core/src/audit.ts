import { auditLog, type Db } from "@mailmcp/db";

export interface AuditEntry {
  orgId: string;
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  accountId?: string | null;
  action: string;
  target?: string | null;
  allowed?: boolean;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({ ...e, allowed: e.allowed ?? true });
}
