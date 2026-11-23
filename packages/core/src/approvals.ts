import { accounts, agents, and, type Db, desc, eq, pendingActions } from "@mailmcp/db";
import { audit } from "./audit";
import { deserializeCompose, MailError, type MailService } from "./mail";
import type { Access, PolicyService } from "./policy";

/**
 * Held actions (sends from agents whose grant says "approve"). Approving re-runs the exact
 * request with the agent's permissions; rejecting just records the decision.
 */
export class ApprovalService {
  constructor(
    private db: Db,
    private mail: MailService,
    private policy: PolicyService,
  ) {}

  async list(orgId: string, status: "pending" | "all" = "pending") {
    const rows = await this.db
      .select({ p: pendingActions, agentName: agents.name, account: accounts.address })
      .from(pendingActions)
      .leftJoin(agents, eq(agents.id, pendingActions.agentId))
      .innerJoin(accounts, eq(accounts.id, pendingActions.accountId))
      .where(
        status === "pending"
          ? and(eq(pendingActions.orgId, orgId), eq(pendingActions.status, "pending"))
          : eq(pendingActions.orgId, orgId),
      )
      .orderBy(desc(pendingActions.createdAt))
      .limit(200);
    return rows.map((r) => ({
      ...r.p,
      agentName: r.agentName,
      account: r.account,
      payload: redactPayload(r.p.payload),
    }));
  }

  async get(orgId: string, id: string) {
    const [r] = await this.db
      .select()
      .from(pendingActions)
      .where(and(eq(pendingActions.orgId, orgId), eq(pendingActions.id, id)));
    if (!r) throw new MailError("Pending action not found", 404);
    return r;
  }

  async decide(orgId: string, userId: string, id: string, approve: boolean) {
    const p = await this.get(orgId, id);
    if (p.status !== "pending") throw new MailError(`Already ${p.status}.`, 409);
    if (!approve) {
      await this.db
        .update(pendingActions)
        .set({ status: "rejected", decidedBy: userId, decidedAt: new Date() })
        .where(eq(pendingActions.id, id));
      await audit(this.db, {
        orgId,
        actorType: "user",
        actorId: userId,
        accountId: p.accountId,
        action: "approval.reject",
        target: id,
      });
      return { status: "rejected" };
    }
    // Execute with the agent's own (current) permissions; approval only lifts the hold.
    const [agent] = p.agentId
      ? await this.db.select().from(agents).where(eq(agents.id, p.agentId))
      : [];
    if (!agent) throw new MailError("The agent that requested this no longer exists.", 409);
    const access: Access = await this.policy.forAgent(orgId, agent.id, agent.name);
    await this.db
      .update(pendingActions)
      .set({ status: "approved", decidedBy: userId, decidedAt: new Date() })
      .where(eq(pendingActions.id, id));
    try {
      const payload = p.payload as Record<string, any>;
      let result: unknown;
      if (p.kind === "send")
        result = await this.mail.send(
          access,
          payload.accountId,
          deserializeCompose(payload.input),
          { approved: true },
        );
      else if (p.kind === "reply")
        result = await this.mail.reply(access, payload.messageId, payload.input, {
          approved: true,
        });
      else if (p.kind === "forward")
        result = await this.mail.forward(access, payload.messageId, payload.input, {
          approved: true,
        });
      else throw new MailError(`Unknown action kind: ${p.kind}`);
      await this.db
        .update(pendingActions)
        .set({ status: "executed", result: result as object })
        .where(eq(pendingActions.id, id));
      await audit(this.db, {
        orgId,
        actorType: "user",
        actorId: userId,
        accountId: p.accountId,
        action: "approval.approve",
        target: id,
      });
      return { status: "executed", result };
    } catch (err) {
      await this.db
        .update(pendingActions)
        .set({ status: "failed", result: { error: (err as Error).message } })
        .where(eq(pendingActions.id, id));
      throw err;
    }
  }

  /** What an agent sees when it checks on its own request. */
  async statusForAgent(access: Access, id: string) {
    const [r] = await this.db
      .select({
        id: pendingActions.id,
        status: pendingActions.status,
        kind: pendingActions.kind,
        result: pendingActions.result,
        createdAt: pendingActions.createdAt,
        decidedAt: pendingActions.decidedAt,
      })
      .from(pendingActions)
      .where(and(eq(pendingActions.id, id), eq(pendingActions.agentId, access.actor.id)));
    if (!r) throw new MailError("No such pending action for this agent.", 404);
    return r;
  }
}

/** Don't ship attachment bytes to the browser list view. */
function redactPayload(payload: unknown) {
  const p = structuredClone(payload) as Record<string, any>;
  if (p?.input?.attachments) {
    p.input.attachments = p.input.attachments.map((a: { filename: string; content?: string }) => ({
      filename: a.filename,
      size: a.content ? Math.floor((a.content.length * 3) / 4) : undefined,
    }));
  }
  return p;
}
