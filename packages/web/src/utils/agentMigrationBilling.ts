import {
  canUseProBillingFeatures,
  currentDate,
} from "@botiverse/raft-shared";
import type {
  ServerPlan,
} from "@botiverse/raft-shared";

export const MIGRATION_PRO_PLAN_REQUIRED_CODE = "MIGRATION_PRO_PLAN_REQUIRED";

const SERVER_PLANS = new Set<ServerPlan>(["free", "founder", "partner", "pro"]);

function isServerPlan(value: unknown): value is ServerPlan {
  return typeof value === "string" && SERVER_PLANS.has(value as ServerPlan);
}

/**
 * The billing projection is advisory UI state; the migration start route is
 * the authority. An unavailable or unrecognized projection must not make Web
 * invent a denial that the server cannot confirm.
 */
export function agentMigrationRequiresUpgrade(
  plan: unknown,
  now: Date = currentDate(),
): boolean {
  return isServerPlan(plan) && !canUseProBillingFeatures(plan, now);
}

export function isMigrationProPlanRequiredError(error: unknown): boolean {
  const response = (error as { response?: { data?: { code?: unknown } } } | null)?.response;
  return response?.data?.code === MIGRATION_PRO_PLAN_REQUIRED_CODE;
}
