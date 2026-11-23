import { isModelScopedUsageWindow } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageAccount, RuntimeAccountUsageWindow } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";

/**
 * Whether an account keeps running on credits once a window is used up
 * (Codex: its weekly limit reached, the work goes on and spends credits).
 * Such a window still says `limit_reached`; the account is not used up.
 * Unknown credits (absent) count as none, as before credits were read.
 * Per account: Raft carries the credits of Codex's account bucket and
 * assumes a model's own bucket can spend the same balance.
 */
export function usageOnCredits(account: Pick<RuntimeAccountUsageAccount, "credits"> | null | undefined): boolean {
  return account?.credits?.available === true;
}

/** A window to list on its own (RuntimeUsageWindowList), and whether its account runs on credits once it is used up. */
export type RuntimeUsageListWindow = RuntimeAccountUsageWindow & { onCredits?: boolean };

/**
 * A whole balance of up to 15 digits (exact as a number) Intl formats with the
 * locale's grouping ("30784" → "30,784").
 * Any other shape ("12.3456", "1,234.5") is shown as the runtime wrote it, so
 * no digit is rounded away (a tiny "0.0004" never reads "0 credits").
 */
const PLAIN_NUMBER = /^-?\d{1,15}$/;

/**
 * The account's credits as its usage card says them beside the account:
 * "30,784 credits", "Unlimited credits", "No credits left"; null when the
 * account does not say (the runtime did not report them).
 */
export function usageCreditsText(
  credits: RuntimeAccountUsageAccount["credits"],
  formatMessage: IntlShape["formatMessage"],
): string | null {
  if (!credits) return null;
  if (!credits.available) return formatMessage({ id: "machine.runtimeUsage.credits.none" });
  if (credits.unlimited) return formatMessage({ id: "machine.runtimeUsage.credits.unlimited" });
  const { balance } = credits;
  if (balance === undefined) return formatMessage({ id: "machine.runtimeUsage.credits.available" });
  const count = PLAIN_NUMBER.test(balance) ? Number(balance) : Number.NaN;
  return Number.isFinite(count)
    ? formatMessage({ id: "machine.runtimeUsage.credits.balance" }, { count })
    : formatMessage({ id: "machine.runtimeUsage.credits.balanceText" }, { balance });
}

/**
 * Whether an account's usage needs attention on the runtime chip: not healthy,
 * or a window not ok, except a full window of an account running on credits
 * (its agents keep working).
 */
export function usageAccountNeedsAttention(account: Pick<RuntimeAccountUsageAccount, "credits" | "health" | "windows">): boolean {
  return account.health !== "ok"
    || account.windows.some((window) => window.status !== "ok" && !(window.status === "limit_reached" && usageOnCredits(account)));
}

/**
 * Whether every model group an account reports (a `models` scope; Antigravity's
 * "Gemini Models", "Claude and GPT models") has a window at its limit, on an
 * account of model groups only. OAR still says not rate limited when agy has
 * AI credits left, so its agents run on credits (Cindy, #oar-raft bf7c6b31);
 * OAR may not report those credits yet.
 */
export function usageModelGroupsAllUsedUp(account: Pick<RuntimeAccountUsageAccount, "windows">): boolean {
  const groups = new Map<string, boolean>();
  for (const window of account.windows) {
    if (window.scope?.kind !== "models") return false;
    const key = window.scope.name.toLowerCase();
    groups.set(key, (groups.get(key) ?? false) || window.status === "limit_reached");
  }
  return groups.size > 0 && [...groups.values()].every(Boolean);
}

/**
 * The usage card's chip for an account fine on the all-models basis whose
 * model or model group windows say otherwise (Cindy, #oar-raft bf7c6b31);
 * OAR's `rateLimited` alone means the whole account ("used up"):
 * - every group used up while OAR says not rate limited: agy's AI credits
 *   carry its agents. Unreported credits (OAR #core:#314 adds them): "may be
 *   on credits"; reported, each row says "on credits" as Codex's, no chip;
 *   reported as none: "used up", whatever OAR's flag says;
 * - a model's or group's own window used up while the account runs others
 *   (agy's Gemini Models): "some models used up", its row saying which; none
 *   on credits (its agents keep working).
 */
export function modelLimitChip(account: Pick<RuntimeAccountUsageAccount, "credits" | "windows">): "maybeOnCredits" | "rate_limited" | "someModelsUsedUp" | null {
  if (usageModelGroupsAllUsedUp(account)) {
    if (account.credits === undefined) return "maybeOnCredits";
    return account.credits.available ? null : "rate_limited";
  }
  if (usageOnCredits(account)) return null;
  return account.windows.some((window) => window.status === "limit_reached" && isModelScopedUsageWindow(window)) ? "someModelsUsedUp" : null;
}
