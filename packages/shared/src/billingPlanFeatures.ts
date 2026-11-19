/**
 * Narrow leaf for server plan identifiers and Pro-cohort feature eligibility
 * so pure evaluators (including the Feature Flag Admin Worker) can share plan
 * cohort semantics without importing the `@botiverse/raft-shared` root.
 */

/** Plan identifiers stored in the database. */
export type ServerPlan = "free" | "founder" | "partner" | "pro";

/** Start date of the extended free trial for Free plan users. */
export const TRIAL_START_DATE = new Date("2026-04-18T00:00:00Z");

/**
 * End instant of the free full-featured trial.
 * 2026-06-05: extended +7 (51 -> 58) per @tygg #proj-release directive (task #7) —
 * trial end 2026-06-08 -> 2026-06-15 UTC; TRIAL_START_DATE unchanged.
 * 2026-06-13: final billing acceptance window ends 2026-06-22 UTC (58 -> 65);
 * 2026-06-21: keep the trial active through all of 2026-06-22 in every time zone.
 */
export const TRIAL_END_DATE = new Date("2026-06-23T12:00:00Z");

/** Duration retained for UI/compatibility consumers; the actual cutoff is TRIAL_END_DATE. */
export const TRIAL_DURATION_DAYS = (TRIAL_END_DATE.getTime() - TRIAL_START_DATE.getTime()) / (24 * 60 * 60 * 1000);

/** Check if the free trial period is currently active. */
export function isTrialActive(now: Date = new Date()): boolean {
  return now >= TRIAL_START_DATE && now < TRIAL_END_DATE;
}

export function canUseProBillingFeatures(plan: ServerPlan, now: Date = new Date()): boolean {
  return plan === "pro" || plan === "founder" || plan === "partner" || (plan === "free" && isTrialActive(now));
}

export const canUseTeamBillingFeatures = canUseProBillingFeatures;
