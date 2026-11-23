import { allModelsUsageAccount } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageAccount } from "@botiverse/raft-shared";

/** A limit reset is offered from this share of any window used (the usage meter turns orange there). */
export const LIMIT_RESET_OFFER_RATIO = 0.8;

/**
 * Whether the usage card offers the account's limit reset, and as what
 * (#oar-raft:3a3f8fc1). A reset is spent once used, so it is not offered at
 * 56% with days to go: only once a window is nearly used up (a quiet button),
 * and as the card's main action once the account is limited (also on credits
 * past a full window: a reset then saves the credits it would spend). Limited
 * is on the all-models basis (`allModelsUsageAccount`): only a model's or a
 * model group's own window used up (Codex's Spark) is a quiet button, as the
 * card's chip says "some models used up", not that its agents wait. Null:
 * no button; how many resets are left is still shown.
 */
export function limitResetOffer(account: RuntimeAccountUsageAccount): { primary: boolean } | null {
  const basis = allModelsUsageAccount(account).account;
  const primary = basis.health === "rate_limited" || basis.windows.some((window) => window.status === "limit_reached");
  if (primary) return { primary };
  return account.windows.some((window) => window.status === "limit_reached" || (window.usedRatio ?? 0) >= LIMIT_RESET_OFFER_RATIO) ? { primary: false } : null;
}
