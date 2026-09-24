import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  PRO_PACK_AGENT_SEATS,
  PRO_PACK_ANNUAL_DISCOUNT_PERCENT,
  PRO_PACK_ANNUAL_MONTHLY_USD,
  PRO_PACK_ANNUAL_USD,
  PRO_PACK_HUMAN_SEATS,
  PRO_PACK_MONTHLY_USD,
  PRO_SEAT_MONTHLY_USD,
  PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES,
  TRIAL_END_DATE,
  calculateAgentSeatBlockQuantity,
  calculateProPrice,
  calculateProMonthlyPrice,
  calculateProPackQuantity,
  calculateProSeatPrice,
  canUseProBillingFeatures,
  formatBillingCapacityLimitMessage,
  formatProAgentSeatFraction,
  getBillingCapacity,
  getBillingCapacityLimitState,
  getBillingUsage,
  getEffectiveLimits,
  getFinitePlanLimitExcess,
  getSingleFileUploadLimitBytes,
  getSingleFileUploadLimitLabel,
  isTrialActive,
} from "./index.js";

test("Pro pricing follows single seat semantics", () => {
  assert.equal(PRO_SEAT_MONTHLY_USD, 10);
  assert.equal(PRO_AGENT_SEAT_BLOCK_SIZE, 10);
  assert.equal(PRO_PACK_MONTHLY_USD, 10);
  assert.equal(PRO_PACK_ANNUAL_MONTHLY_USD, 8.8);
  assert.equal(PRO_PACK_ANNUAL_USD, 105.6);
  assert.equal(PRO_PACK_ANNUAL_DISCOUNT_PERCENT, 12);
  assert.equal(PRO_PACK_HUMAN_SEATS, 1);
  assert.equal(PRO_PACK_AGENT_SEATS, 10);

  assert.equal(calculateProPackQuantity(1, 0), 1);
  assert.equal(calculateProPackQuantity(1, 10), 2);
  assert.equal(calculateProPackQuantity(2, 10), 3);
  assert.equal(calculateProPackQuantity(1, 25), 4);
  assert.equal(calculateProPackQuantity(3, 25), 6);
  assert.equal(calculateAgentSeatBlockQuantity(0), 0);
  assert.equal(calculateAgentSeatBlockQuantity(1), 1);
  assert.equal(calculateAgentSeatBlockQuantity(12), 2);
  assert.equal(formatProAgentSeatFraction(), "0.1");

  assert.deepEqual(calculateProMonthlyPrice(1), {
    billingInterval: "monthly",
    monthlyUsd: 10,
    annualUsd: null,
    discountPercent: 0,
    baseMonthlyUsd: 10,
    overageMonthlyUsd: 0,
    seatQuantity: 1,
    packQuantity: 1,
    humanSeatQuantity: 1,
    agentSeatQuantity: 10,
    agentSeatBlockQuantity: 1,
  });
  assert.deepEqual(calculateProMonthlyPrice(3), {
    billingInterval: "monthly",
    monthlyUsd: 30,
    annualUsd: null,
    discountPercent: 0,
    baseMonthlyUsd: 30,
    overageMonthlyUsd: 0,
    seatQuantity: 3,
    packQuantity: 3,
    humanSeatQuantity: 3,
    agentSeatQuantity: 30,
    agentSeatBlockQuantity: 3,
  });
  assert.deepEqual(calculateProSeatPrice(2, 12, "monthly"), {
    billingInterval: "monthly",
    monthlyUsd: 40,
    annualUsd: null,
    discountPercent: 0,
    baseMonthlyUsd: 40,
    overageMonthlyUsd: 0,
    seatQuantity: 4,
    packQuantity: 4,
    humanSeatQuantity: 2,
    agentSeatQuantity: 40,
    agentSeatBlockQuantity: 2,
  });
  assert.deepEqual(calculateProPrice(2, "annual"), {
    billingInterval: "annual",
    monthlyUsd: 17.6,
    annualUsd: 211.2,
    discountPercent: 12,
    baseMonthlyUsd: 17.6,
    overageMonthlyUsd: 0,
    seatQuantity: 2,
    packQuantity: 2,
    humanSeatQuantity: 2,
    agentSeatQuantity: 20,
    agentSeatBlockQuantity: 2,
  });
});

test("billing capacity helper centralizes human and agent seat increments", () => {
  const capacity = { maxHumans: -1, maxAgents: -1, maxUniversalSeats: 1 };

  assert.deepEqual(getBillingUsage(1, 0), {
    humans: 1,
    agents: 0,
    universalSeats: 1,
  });
  assert.equal(getBillingCapacityLimitState(capacity, getBillingUsage(0, 9), "agent").reached, false);
  const agentLimit = getBillingCapacityLimitState(capacity, getBillingUsage(0, 10), "agent");
  assert.deepEqual(agentLimit, {
    reached: true,
    limitType: "universal",
    usage: 1,
    limit: 1,
    nextUsage: 1.1,
  });
  assert.equal(formatBillingCapacityLimitMessage("agent", agentLimit, "Pro", " Upgrade for more."), "Seat limit reached (1/1 on Pro plan). Upgrade for more.");

  const humanLimit = getBillingCapacityLimitState(capacity, getBillingUsage(1, 0), "human");
  assert.deepEqual(humanLimit, {
    reached: true,
    limitType: "universal",
    usage: 1,
    limit: 1,
    nextUsage: 2,
  });
  assert.equal(formatBillingCapacityLimitMessage("human", humanLimit, "Pro"), "Seat limit reached (1/1 on Pro plan).");
});

test("billing capacities reflect Free Pro Founder contract", () => {
  const postTrial = new Date("2026-06-23T12:00:00Z");

  assert.equal(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, 100 * 1024 * 1024);
  assert.equal(FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES, 50 * 1024 * 1024);
  assert.equal(PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES, 200 * 1024 * 1024);
  assert.equal(getSingleFileUploadLimitBytes("free", postTrial), FREE_SINGLE_FILE_UPLOAD_LIMIT_BYTES);
  assert.equal(getSingleFileUploadLimitLabel("free", postTrial), "50MB");
  assert.equal(getSingleFileUploadLimitBytes("pro", postTrial), PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES);
  assert.equal(getSingleFileUploadLimitLabel("pro", postTrial), "200MB");
  assert.equal(getEffectiveLimits("free", postTrial).messageHistoryDays, 30);
  assert.equal(getEffectiveLimits("free", postTrial).maxAgents, -1);
  assert.equal(getBillingCapacity({ plan: "free" }, postTrial).maxAgents, -1);
  assert.equal(canUseProBillingFeatures("free", postTrial), false);
  assert.deepEqual(getBillingCapacity({ plan: "founder" }), {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: -1,
  });
  assert.deepEqual(getBillingCapacity({ plan: "partner" }), {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: -1,
  });
  assert.equal(canUseProBillingFeatures("partner", postTrial), true);
  assert.equal(getEffectiveLimits("partner", postTrial).messageHistoryDays, -1);
  assert.deepEqual(getBillingCapacity({ plan: "pro", provisionedHumanSeats: 4, provisionedAgentSeats: 10, proPackQuantity: 4 }), {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: 4,
  });
  assert.deepEqual(getBillingCapacity({ plan: "pro", proPackQuantity: 1 }), {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: 1,
  });
});

test("plan limit excess treats negative limits as unlimited", () => {
  assert.equal(getFinitePlanLimitExcess(3, -1), 0);
  assert.equal(getFinitePlanLimitExcess(1, -1), 0);
  assert.equal(getFinitePlanLimitExcess(4, 3), 1);
  assert.equal(getFinitePlanLimitExcess(3, 3), 0);
});

test("full-featured trial remains active through June 22 in every time zone", () => {
  assert.equal(TRIAL_END_DATE.toISOString(), "2026-06-23T12:00:00.000Z");
  assert.equal(isTrialActive(new Date("2026-06-23T11:59:59.999Z")), true);
  assert.equal(isTrialActive(new Date("2026-06-23T12:00:00.000Z")), false);
});

test("billing state matrix pins limits and Pro feature access", () => {
  const duringTrial = new Date("2026-06-14T00:00:00Z");
  const postTrial = new Date("2026-06-23T12:00:00Z");

  const cases = [
    {
      label: "Free after trial",
      plan: "free" as const,
      now: postTrial,
      proPackQuantity: undefined,
      proFeatures: false,
      messageHistoryDays: 30,
      capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 },
    },
    {
      label: "Free during full-featured trial",
      plan: "free" as const,
      now: duringTrial,
      proPackQuantity: undefined,
      proFeatures: true,
      messageHistoryDays: -1,
      capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 },
    },
    {
      label: "paid Pro",
      plan: "pro" as const,
      now: postTrial,
      proPackQuantity: 2,
      proFeatures: true,
      messageHistoryDays: -1,
      capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: 2 },
    },
    {
      label: "Founder",
      plan: "founder" as const,
      now: postTrial,
      proPackQuantity: undefined,
      proFeatures: true,
      messageHistoryDays: -1,
      capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 },
    },
    {
      label: "Partner",
      plan: "partner" as const,
      now: postTrial,
      proPackQuantity: undefined,
      proFeatures: true,
      messageHistoryDays: -1,
      capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 },
    },
  ];

  for (const scenario of cases) {
    assert.equal(
      canUseProBillingFeatures(scenario.plan, scenario.now),
      scenario.proFeatures,
      `${scenario.label}: Pro feature gate`,
    );
    assert.equal(
      getEffectiveLimits(scenario.plan, scenario.now).messageHistoryDays,
      scenario.messageHistoryDays,
      `${scenario.label}: message history limit`,
    );
    assert.deepEqual(
      getBillingCapacity({
        plan: scenario.plan,
        proPackQuantity: scenario.proPackQuantity,
      }, scenario.now),
      scenario.capacity,
      `${scenario.label}: capacity`,
    );
  }
});

test("active full-featured trial keeps Free workspaces unlimited until the trial end", () => {
  const duringTrial = new Date("2026-06-14T00:00:00Z");

  assert.equal(getEffectiveLimits("free", duringTrial).messageHistoryDays, -1);
  assert.equal(getEffectiveLimits("free", duringTrial).maxAgents, -1);
  assert.equal(getBillingCapacity({ plan: "free" }, duringTrial).maxAgents, -1);
  assert.equal(canUseProBillingFeatures("free", duringTrial), true);
});
