import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import {
  defaultRuntimeAccountUsageCacheBackend,
  runtimeAccountUsageCacheService,
  type RuntimeAccountUsageCacheBackend,
} from "./runtimeAccountUsageCacheService";

/**
 * "A read already spent this account's 5-hour reset" (docs/contracts/
 * runtime-account-usage.md, "Read spent the 5-hour reset"). On Claude's older
 * program a read with consent at the 5-hour limit spends the 5-hour reset
 * (`fiveHourSpent`). A later `five_hour` use with a new idempotency key (a
 * card still showing the limit until its usage refreshes, mobile 1.26's
 * included) is then answered `nothing_to_reset` by the server without asking
 * the Computer, instead of relying on Claude's own once-a-week rule.
 *
 * Keyed by Computer and Claude account: both limit-reset routes act on the
 * Computer's default Claude account (no env; agents' own account folders are
 * never it), so the account is that account's `accountKey` in the cached
 * usage snapshot, read when the record is written and again when a use is
 * checked. A different account signed in since (a snapshot naming another
 * default account) is another key, so its use is forwarded. No single
 * default account in the cache: `unknown`, which a use matches only while the
 * cache still names none.
 *
 * Shared across replicas (the usage cache's backend: Redis, with this
 * process's map when Redis is down). Gone only after the TTL: a refresh right
 * after the read shows the account clear of its 5-hour limit precisely because
 * the read spent the reset, while a card may still offer the use (Tenny,
 * #proj-raft-computer:#115).
 */
export const CLAUDE_LIMIT_RESET_READ_SPENT_TTL_SECONDS = 20 * 60;
const KEY_PREFIX = "slock:claude-limit-reset:read-spent:v1";
const UNKNOWN_ACCOUNT = "unknown";

/** The default Claude account's key in a snapshot (the one limit resets act on), else `unknown`. */
function defaultClaudeAccountOf(snapshot: RuntimeAccountUsageSnapshot | null | undefined): string {
  if (snapshot?.provider !== "claude") return UNKNOWN_ACCOUNT;
  const defaults = snapshot.accounts.filter((account) => account.agentIds === undefined);
  return defaults.length === 1 ? defaults[0]!.accountKey : UNKNOWN_ACCOUNT;
}

function recordKey(machineId: string, account: string): string {
  return `${KEY_PREFIX}:${machineId}:${account}`;
}

export class ClaudeLimitResetReadSpentGuard {
  constructor(
    private readonly backend: RuntimeAccountUsageCacheBackend = defaultRuntimeAccountUsageCacheBackend(),
    private readonly cachedClaudeUsage: (machineId: string) => Promise<RuntimeAccountUsageSnapshot | null> = async (machineId) =>
      (await runtimeAccountUsageCacheService.read(machineId, "claude")).snapshot,
  ) {}

  private async currentAccount(machineId: string): Promise<string> {
    return defaultClaudeAccountOf(await this.cachedClaudeUsage(machineId));
  }

  /** A read on this Computer spent its default Claude account's 5-hour reset. */
  async recordReadSpent(machineId: string): Promise<void> {
    const account = await this.currentAccount(machineId);
    await this.backend.set(recordKey(machineId, account), "1", CLAUDE_LIMIT_RESET_READ_SPENT_TTL_SECONDS);
  }

  /** Whether a read spent the 5-hour reset of the account a use would act on now. */
  async readSpent(machineId: string): Promise<boolean> {
    const account = await this.currentAccount(machineId);
    return (await this.backend.get(recordKey(machineId, account))) !== null;
  }
}

export const claudeLimitResetReadSpentGuard = new ClaudeLimitResetReadSpentGuard();
