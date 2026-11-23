import type { RuntimeAuthAccount } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";

// OAR forwards Claude's `subscription_type` and Codex's `planType` verbatim in
// lowercase ("pro", "max", "team", ...). Normalise known tier words so they
// read as subscription plans rather than bare workspace/account names; keep
// provider-branded names ("SuperGrok", "Moderato", ...) as sent.
const KNOWN_PLAN_NAMES = new Map<string, string>([
  ["free", "Free"],
  ["go", "Go"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["max", "Max"],
  ["team", "Team"],
  ["business", "Business"],
  ["enterprise", "Enterprise"],
  ["edu", "Edu"],
]);

export function formatRuntimePlanName(planLabel: string | null | undefined): string | null {
  const trimmed = planLabel?.trim();
  if (!trimmed) return null;
  return KNOWN_PLAN_NAMES.get(trimmed.toLowerCase()) ?? trimmed;
}

/**
 * Heading for an account on the runtime usage card: "Team plan" / "Team 套餐"
 * (rather than a bare lowercase "team" that reads like an account name).
 * Falls back to the generic account label when no plan is reported, and avoids
 * repeating "plan" / "套餐" when the provider's name already carries it.
 */
export function formatRuntimePlanHeading(
  planLabel: string | null | undefined,
  formatMessage: IntlShape["formatMessage"],
): string {
  const plan = formatRuntimePlanName(planLabel);
  if (!plan) return formatMessage({ id: "machine.runtimeUsage.accountFallback" });
  if (/\bplan\b/i.test(plan) || plan.includes("套餐")) return plan;
  return formatMessage({ id: "machine.runtimeUsage.planHeading" }, { plan });
}

export function accountText(account: RuntimeAuthAccount | undefined): string | null {
  const parts = [account?.maskedLabel, formatRuntimePlanName(account?.planLabel)].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
