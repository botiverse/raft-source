/**
 * Single authority for the coarse server paid-tier projection.
 * Every API surface that exposes "is this server paid" to apps must consume
 * this helper (xxchan 2026-08-12 ruling, PM Tao): closed vocabulary — any
 * non-free plan projects to "paid"; no Stripe/subscription detail leaks.
 *
 * Consumers with NO plan fact (missing field, unknown server) must treat the
 * tier as UNKNOWN and fail closed — never default to paid, and on the
 * display side never default to free either.
 */
export function projectCoarseServerPlan(plan: string): { is_paid: boolean; plan_tier: "free" | "paid" } {
  return { is_paid: plan !== "free", plan_tier: plan === "free" ? "free" : "paid" };
}
