import { accountDrafts, agents, and, type Db, desc, eq, sql } from "@cloud-mail-mcp/db";
import type { AccountService } from "./accounts";
import { AccountError } from "./accounts";
import type { AgentService } from "./agents";
import { audit } from "./audit";
import type { Jobs } from "./jobs";
import { GRANT_PRESETS, type GrantPreset } from "./oauth";
import type { ModuleRegistry } from "./registry";
import type { SettingsService } from "./settings";

type Obj = Record<string, unknown>;

/** What's needed to add one mailbox. Server settings are guessed from the address when left out. */
export interface MailboxInput {
  address: string;
  displayName?: string;
  label?: string;
  /** "gmail", "icloud", "cpanel", or "other" (then the servers must be given). */
  provider?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** Login username, when it isn't the address. */
  username?: string;
  password?: string;
  /**
   * When the address is already connected (people importing a spreadsheet only):
   * "update" its login and settings, "add" another login for it, or "skip" the row.
   */
  ifExists?: "update" | "add" | "skip";
  /** Save it even if the login test fails, as not working, to fix later (people only). */
  addIfFails?: boolean;
}

export type Actor = { type: "user"; id: string } | { type: "agent"; id: string };

export type AddResult =
  | { address: string; status: "added"; accountId: string; working?: false; note?: string }
  | { address: string; status: "updated"; accountId: string; working?: false; note?: string }
  | { address: string; status: "skipped"; note: string }
  | { address: string; status: "waiting_for_password"; draftId: string; note?: string }
  /** canAddAnyway: the login test failed; it can be saved as not working with addIfFails. */
  | { address: string; status: "error"; error: string; canAddAnyway?: boolean };

/** A login or connection test failed (as opposed to bad input or a duplicate). */
const testFailed = (e: unknown) => e instanceof AccountError && e.status === 422;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Deep merge, ignoring undefined values at any depth. */
function merge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v))
      out[k] = merge(out[k] && typeof out[k] === "object" ? (out[k] as Obj) : {}, v as Obj);
    else out[k] = v;
  }
  return out;
}

/**
 * Mailboxes added by agents or imported in bulk. With a password (from a person, or from an agent
 * when Settings allow it) the mailbox is tested and added right away; without one it waits as a
 * draft until a person enters the password in the admin panel. Drafts hold no secrets.
 */
export class AccountDraftService {
  constructor(
    private db: Db,
    private registry: ModuleRegistry,
    private accounts: AccountService,
    private agentsSvc: AgentService,
    private settings: SettingsService,
    private jobs: Jobs,
  ) {}

  /** Connection settings (no password) for an address: provider preset, then any overrides. */
  configFor(input: MailboxInput, moduleId = "imap"): { config: Obj; provider: string } {
    const manifest = this.registry.get(moduleId);
    const address = input.address.trim().toLowerCase();
    const domain = address.split("@")[1] ?? "";
    const presets = manifest.presets ?? [];
    const wanted = input.provider?.toLowerCase();
    const preset =
      (wanted && wanted !== "other" ? presets.find((p) => p.id === wanted) : undefined) ??
      (wanted === "other" ? undefined : presets.find((p) => p.domains.includes(domain))) ??
      (wanted === "other" ? undefined : presets.find((p) => p.id === "cpanel"));
    const base = preset
      ? (JSON.parse(JSON.stringify(preset.defaults).replaceAll("{domain}", domain)) as Obj)
      : {};
    const config = merge(base, {
      imap: { host: input.imapHost, port: input.imapPort, secure: input.imapSecure },
      smtp: { host: input.smtpHost, port: input.smtpPort, secure: input.smtpSecure },
      username: input.username?.trim() || address,
    });
    return { config, provider: preset?.id ?? "other" };
  }

  async list(orgId: string) {
    return this.db
      .select({
        id: accountDrafts.id,
        moduleId: accountDrafts.moduleId,
        address: accountDrafts.address,
        displayName: accountDrafts.displayName,
        label: accountDrafts.label,
        config: accountDrafts.config,
        access: accountDrafts.access,
        note: accountDrafts.note,
        agentId: accountDrafts.agentId,
        agentName: agents.name,
        createdAt: accountDrafts.createdAt,
      })
      .from(accountDrafts)
      .leftJoin(agents, eq(agents.id, accountDrafts.agentId))
      .where(eq(accountDrafts.orgId, orgId))
      .orderBy(desc(accountDrafts.createdAt));
  }

  /**
   * Add mailboxes. Each one with a password is tested and added (if `passwords` allows it for this
   * actor); the rest wait for a password. `access` is what the asking agent gets on each new
   * mailbox (at most "send with approval").
   */
  async add(
    orgId: string,
    actor: Actor,
    items: MailboxInput[],
    opts: { access?: GrantPreset } = {},
  ): Promise<AddResult[]> {
    const passwordsAllowed =
      actor.type === "user" || (await this.settings.get("agentAccounts")).allowPasswords;
    const access = opts.access && opts.access in GRANT_PRESETS ? opts.access : undefined;
    const out: AddResult[] = [];
    for (const item of items) {
      const address = item.address?.trim().toLowerCase() ?? "";
      if (!EMAIL.test(address)) {
        out.push({ address, status: "error", error: "Not an email address." });
        continue;
      }
      let built: ReturnType<AccountDraftService["configFor"]>;
      try {
        built = this.configFor(item);
      } catch (e) {
        out.push({ address, status: "error", error: (e as Error).message });
        continue;
      }
      const imap = built.config.imap as Obj | undefined;
      if (!imap?.host || !(built.config.smtp as Obj | undefined)?.host) {
        out.push({ address, status: "error", error: "Give the IMAP and SMTP servers." });
        continue;
      }
      const password = item.password?.trim() ? item.password : undefined;
      // Choices only people get (spreadsheet import), not agents.
      const ifExists = actor.type === "user" ? item.ifExists : undefined;
      const addIfFails = actor.type === "user" && item.addIfFails === true;
      if (ifExists === "skip" || ifExists === "update") {
        const existing = await this.accounts.findByAddress(orgId, address);
        if (existing.length && ifExists === "skip") {
          out.push({ address, status: "skipped", note: "Already connected." });
          continue;
        }
        if (existing.length) {
          out.push(await this.updateExisting(orgId, actor.id, address, item, existing, addIfFails));
          continue;
        }
        // Not connected yet: add it as usual.
      }
      if (password && passwordsAllowed) {
        try {
          const account = await this.accounts.create(
            orgId,
            actor.id,
            {
              moduleId: "imap",
              address,
              displayName: item.displayName,
              label: item.label,
              config: { ...built.config, password },
            },
            { actorType: actor.type, addIfFails },
          );
          if (actor.type === "agent" && access) await this.grant(orgId, actor, account.id, access);
          if (account.status === "pending") {
            await this.jobs
              .enqueueSync({ accountId: account.id, reason: "created" })
              .catch(() => {});
            out.push({ address, status: "added", accountId: account.id });
          } else
            out.push({
              address,
              status: "added",
              accountId: account.id,
              working: false,
              note: account.statusMessage ?? undefined,
            });
        } catch (e) {
          out.push({
            address,
            status: "error",
            error: (e as Error).message,
            ...(testFailed(e) && actor.type === "user" ? { canAddAnyway: true } : {}),
          });
        }
        continue;
      }
      const draft = await this.saveDraft(orgId, actor, address, item, built.config, access);
      out.push({
        address,
        status: "waiting_for_password",
        draftId: draft.id,
        ...(password && !passwordsAllowed
          ? {
              note: "Passwords from agents are turned off (Settings → AI agents), so it wasn't used or kept.",
            }
          : {}),
      });
    }
    return out;
  }

  /**
   * Update an existing mailbox from an imported row: only what the row gives (password, servers,
   * username, name, label) changes; everything else is kept.
   */
  private async updateExisting(
    orgId: string,
    userId: string,
    address: string,
    item: MailboxInput,
    existing: Array<{ id: string; imapHost: string | null }>,
    addIfFails: boolean,
  ): Promise<AddResult> {
    const host = item.imapHost?.trim().toLowerCase();
    const match =
      existing.length === 1
        ? existing[0]
        : host
          ? existing.find((a) => a.imapHost?.toLowerCase() === host)
          : undefined;
    if (!match)
      return {
        address,
        status: "error",
        error: `${existing.length} mailboxes use this address. Choose "Add" or "Skip", or update it on the Accounts page.`,
      };
    const overrides = merge(
      {},
      {
        imap: { host: item.imapHost, port: item.imapPort, secure: item.imapSecure },
        smtp: { host: item.smtpHost, port: item.smtpPort, secure: item.smtpSecure },
        username: item.username?.trim() || undefined,
        password: item.password?.trim() ? item.password : undefined,
      },
    );
    const changes = {
      ...(item.displayName?.trim() ? { displayName: item.displayName } : {}),
      ...(item.label?.trim() ? { label: item.label } : {}),
    };
    const hasConfig = Object.keys(overrides).some((k) =>
      k === "imap" || k === "smtp" ? Object.keys(overrides[k] as Obj).length > 0 : true,
    );
    if (!hasConfig && !Object.keys(changes).length)
      return { address, status: "skipped", note: "Already connected; nothing to change." };
    const current = hasConfig ? (await this.accounts.get(orgId, match.id)).config : undefined;
    const run = (skipTest: boolean) =>
      this.accounts.update(orgId, userId, match.id, {
        ...changes,
        ...(current ? { config: merge(current as Obj, overrides), skipTest } : {}),
      });
    try {
      await run(false);
    } catch (e) {
      if (!testFailed(e)) return { address, status: "error", error: (e as Error).message };
      if (!addIfFails)
        return { address, status: "error", error: (e as Error).message, canAddAnyway: true };
      // Save the new settings anyway, marked as not working, so the person can fix them.
      await run(true);
      await this.accounts.markFailed(match.id, e as AccountError);
      return {
        address,
        status: "updated",
        accountId: match.id,
        working: false,
        note: `Saved without a working login: ${(e as Error).message}`,
      };
    }
    if (hasConfig)
      await this.jobs.enqueueSync({ accountId: match.id, reason: "settings" }).catch(() => {});
    return { address, status: "updated", accountId: match.id };
  }

  private async saveDraft(
    orgId: string,
    actor: Actor,
    address: string,
    item: MailboxInput,
    config: Obj,
    access?: GrantPreset,
  ) {
    const host = String((config.imap as Obj).host ?? "").toLowerCase();
    // One draft per address and server: asking again updates it.
    const [existing] = await this.db
      .select({ id: accountDrafts.id })
      .from(accountDrafts)
      .where(
        and(
          eq(accountDrafts.orgId, orgId),
          sql`lower(${accountDrafts.address}) = ${address}`,
          sql`lower(${accountDrafts.config}->'imap'->>'host') = ${host}`,
        ),
      );
    const values = {
      orgId,
      moduleId: "imap",
      address,
      displayName: item.displayName?.trim() || null,
      label: item.label?.trim() || null,
      config,
      agentId: actor.type === "agent" ? actor.id : null,
      access: actor.type === "agent" ? (access ?? null) : null,
    };
    const [row] = existing
      ? await this.db
          .update(accountDrafts)
          .set(values)
          .where(eq(accountDrafts.id, existing.id))
          .returning()
      : await this.db.insert(accountDrafts).values(values).returning();
    await audit(this.db, {
      orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: "account.draft",
      target: address,
    });
    return row!;
  }

  /** A person enters the password: test, add the mailbox, give the asking agent its access. */
  async complete(
    orgId: string,
    userId: string,
    id: string,
    input: { password: string; access?: GrantPreset | null },
  ) {
    const [d] = await this.db
      .select()
      .from(accountDrafts)
      .where(and(eq(accountDrafts.orgId, orgId), eq(accountDrafts.id, id)));
    if (!d) throw new AccountError("This mailbox isn't waiting for a password any more.", 404);
    const account = await this.accounts.create(orgId, userId, {
      moduleId: d.moduleId,
      address: d.address,
      displayName: d.displayName ?? undefined,
      label: d.label ?? undefined,
      config: { ...(d.config as Obj), password: input.password },
    });
    const access = input.access === undefined ? (d.access as GrantPreset | null) : input.access;
    if (d.agentId && access && access in GRANT_PRESETS)
      await this.grant(orgId, { type: "user", id: userId }, account.id, access, d.agentId);
    await this.db.delete(accountDrafts).where(eq(accountDrafts.id, id));
    await this.jobs.enqueueSync({ accountId: account.id, reason: "created" }).catch(() => {});
    return account;
  }

  async remove(orgId: string, userId: string, id: string) {
    const [d] = await this.db
      .delete(accountDrafts)
      .where(and(eq(accountDrafts.orgId, orgId), eq(accountDrafts.id, id)))
      .returning({ address: accountDrafts.address });
    if (d)
      await audit(this.db, {
        orgId,
        actorType: "user",
        actorId: userId,
        action: "account.draft.delete",
        target: d.address,
      });
  }

  private async grant(
    orgId: string,
    actor: Actor,
    accountId: string,
    access: GrantPreset,
    agentId = actor.id,
  ) {
    const preset = GRANT_PRESETS[access];
    if (!preset.scopes.length) return;
    await this.agentsSvc.setGrant(
      orgId,
      actor.id,
      agentId,
      { accountId, scopes: [...preset.scopes], sendPolicy: preset.sendPolicy },
      actor.type,
    );
  }
}
