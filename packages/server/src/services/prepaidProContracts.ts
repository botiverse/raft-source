// Prepaid Pro's Stripe contract (task #19; docs/billing/prepaid-pro.md), in
// a module with no runtime dependencies so the Checkout scan can use it too.
import type Stripe from "stripe";
import type { ProPrepaidMonths } from "@botiverse/raft-shared";

/** Marks Raft's prepaid Checkout sessions (metadata.pricingContract). */
export const PREPAID_PRO_PRICING_CONTRACT = "raft-pro-prepaid-v1";

/** Stripe lookup_key of the one-time Price for each period (per seat). */
export const PREPAID_PRO_PRICE_LOOKUP_KEYS: Readonly<Record<ProPrepaidMonths, string>> = {
  1: "raft_pro_prepaid_1m",
  12: "raft_pro_prepaid_12m",
};

export function isPrepaidCheckoutSession(session: Pick<Stripe.Checkout.Session, "mode" | "metadata">): boolean {
  return session.mode === "payment" && session.metadata?.pricingContract === PREPAID_PRO_PRICING_CONTRACT;
}
