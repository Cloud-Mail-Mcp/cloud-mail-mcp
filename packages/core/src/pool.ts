import type { Connector } from "@mailmcp/module-sdk";
import type { AccountService } from "./accounts";
import { createLogger } from "./logger";

/**
 * Keeps one live connector per account in the server process so reads/actions don't pay
 * a fresh IMAP login each time. Idle connectors close after `idleMs`.
 */
export class ConnectorPool {
  private items = new Map<string, { c: Promise<Connector>; timer?: NodeJS.Timeout }>();
  private log = createLogger("pool");
  constructor(
    private accounts: AccountService,
    private idleMs = 5 * 60_000,
  ) {}

  async use<T>(accountId: string, fn: (c: Connector) => Promise<T>): Promise<T> {
    let item = this.items.get(accountId);
    if (!item) {
      const c = this.accounts
        .byId(accountId)
        .then((row) => this.accounts.connectorFor(row, undefined, this.log.child({ accountId })));
      item = { c };
      this.items.set(accountId, item);
      c.catch(() => this.items.delete(accountId));
    }
    clearTimeout(item.timer);
    const connector = await item.c;
    try {
      return await fn(connector);
    } finally {
      const current = this.items.get(accountId);
      if (current === item) {
        item.timer = setTimeout(() => this.evict(accountId), this.idleMs);
        item.timer.unref?.();
      }
    }
  }

  /** Drop a cached connector (e.g. after its settings changed). */
  async evict(accountId: string) {
    const item = this.items.get(accountId);
    if (!item) return;
    this.items.delete(accountId);
    clearTimeout(item.timer);
    await item.c.then((c) => c.close()).catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.items.keys()].map((id) => this.evict(id)));
  }
}
