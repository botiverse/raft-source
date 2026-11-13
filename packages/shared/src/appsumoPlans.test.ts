import assert from "node:assert/strict";
import { APPSUMO_PLAN_LIMITS, isAppSumoTier, getBillingCapacity, getBillingCapacityLimitState, getBillingUsage } from "./index";

test("AppSumo tiers enforce independent human and agent boundaries", () => {
  for (const tier of [1, 2, 3, 4] as const) {
    const limits = APPSUMO_PLAN_LIMITS[tier];
    const capacity = getBillingCapacity({ plan: "pro", appsumo: { tier, lifetime: true } });
    assert.equal(capacity.maxUniversalSeats, -1);
    assert.equal(getBillingCapacityLimitState(capacity, getBillingUsage(limits.maxHumans - 1, limits.maxAgents), "human").reached, false);
    assert.equal(getBillingCapacityLimitState(capacity, getBillingUsage(limits.maxHumans, limits.maxAgents - 1), "agent").reached, false);
    assert.equal(getBillingCapacityLimitState(capacity, getBillingUsage(limits.maxHumans, 0), "human").reached, true);
    assert.equal(getBillingCapacityLimitState(capacity, getBillingUsage(0, limits.maxAgents), "agent").reached, true);
  }
  assert.equal(getBillingCapacity({ plan: "pro", proPackQuantity: 2 }).maxUniversalSeats, 2);
});

test("unknown AppSumo tiers are rejected at the provider boundary", () => {
  for (const value of [0, 5, -1, 1.5, "1", null, undefined]) assert.equal(isAppSumoTier(value), false);
  for (const value of [1, 2, 3, 4]) assert.equal(isAppSumoTier(value), true);
});
