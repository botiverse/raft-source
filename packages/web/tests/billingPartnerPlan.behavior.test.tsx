import assert from "node:assert/strict";
import test from "node:test";
import {
  getBillingPlanPresentation,
  getBillingControlsState,
  getInternalBillingPlanCopy,
  getSettingsBillingPlanPresentation,
  isInternalBillingPlan,
} from "../src/utils/billingControls";

test("Partner billing controls remain internal even if a Stripe subscription row exists", () => {
  const cases = [
    { plan: "founder", subscriptionStatus: null },
    { plan: "founder", subscriptionStatus: "active" },
    { plan: "founder", subscriptionStatus: "past_due" },
    { plan: "partner", subscriptionStatus: null },
    { plan: "partner", subscriptionStatus: "active" },
    { plan: "partner", subscriptionStatus: "past_due" },
  ] as const;

  for (const input of cases) {
    assert.deepEqual(
      getBillingControlsState(input),
      {
        hasEntitlingSubscription: false,
        canCheckout: false,
        canUpdatePacks: false,
        canOpenPortal: false,
      },
      `${input.plan}/${input.subscriptionStatus ?? "none"} should not expose Stripe controls`,
    );
  }

  assert.deepEqual(getBillingControlsState({ plan: "pro", subscriptionStatus: "active" }), {
    hasEntitlingSubscription: true,
    canCheckout: false,
    canUpdatePacks: true,
    canOpenPortal: true,
  });
  assert.deepEqual(getBillingControlsState({ plan: "pro", subscriptionStatus: "past_due" }), {
    hasEntitlingSubscription: true,
    canCheckout: false,
    canUpdatePacks: true,
    canOpenPortal: true,
  });
  assert.deepEqual(getBillingControlsState({ plan: "free", subscriptionStatus: "active" }), {
    hasEntitlingSubscription: true,
    canCheckout: false,
    canUpdatePacks: false,
    canOpenPortal: true,
  });
  assert.deepEqual(getBillingControlsState({ plan: "free", subscriptionStatus: "past_due" }), {
    hasEntitlingSubscription: true,
    canCheckout: false,
    canUpdatePacks: false,
    canOpenPortal: true,
  });
  assert.deepEqual(getBillingControlsState({ plan: "free", subscriptionStatus: "canceled" }), {
    hasEntitlingSubscription: false,
    canCheckout: true,
    canUpdatePacks: false,
    canOpenPortal: false,
  });
});

// NOTE: `getBillingPlanPresentation` returns catalog ids, not display text, since
// the billing step-2 migration. These assertions therefore pin WHICH message each
// plan resolves to; the English wording itself is pinned in en.ts and exercised
// in tests/billingPlanPresentation.i18n.test.ts, which renders both locales.
test("Partner billing copy is distinct from Founder copy", () => {
  assert.equal(isInternalBillingPlan("founder"), true);
  assert.equal(isInternalBillingPlan("partner"), true);
  assert.equal(isInternalBillingPlan("pro"), false);
  assert.equal(isInternalBillingPlan("free"), false);
  assert.equal(isInternalBillingPlan(null), false);

  assert.deepEqual(getInternalBillingPlanCopy("founder"), {
    displayName: "billing.founder",
    description: "billing.grandfatheredUnlimitedAccess",
    includedFeatures: [
      "billing.everythingWithoutAnyLimitations",
    ],
  });

  assert.deepEqual(getInternalBillingPlanCopy("partner"), {
    displayName: "billing.partner",
    description: "billing.partnerAccessForTestingAndSponsoredUse",
    includedFeatures: [
      "billing.raftFeaturesEnabledForPartnerTestingAndSponsor",
    ],
  });

  assert.equal(getInternalBillingPlanCopy("free"), null);
  assert.equal(getInternalBillingPlanCopy("pro"), null);
});

test("billing plan presentation keeps Partner distinct from Founder, Pro, and Free", () => {
  assert.deepEqual(getBillingPlanPresentation({ plan: "partner", proAgentSeatFractionLabel: "0.1" }), {
    displayName: "billing.partner",
    description: "billing.partnerAccessForTestingAndSponsoredUse",
    includedFeatures: [
      "billing.raftFeaturesEnabledForPartnerTestingAndSponsor",
    ],
    notIncludedFeatures: [],
    hasProFeatures: true,
  });

  assert.deepEqual(getBillingPlanPresentation({ plan: "founder", proAgentSeatFractionLabel: "0.1" }), {
    displayName: "billing.founder",
    description: "billing.grandfatheredUnlimitedAccess",
    includedFeatures: [
      "billing.everythingWithoutAnyLimitations",
    ],
    notIncludedFeatures: [],
    hasProFeatures: true,
  });

  assert.deepEqual(getBillingPlanPresentation({ plan: "free", displayName: "Free", proAgentSeatFractionLabel: "0.1" }), {
    displayName: "billing.free",
    description: "billing.startBuildingWithAgents",
    includedFeatures: [
      "billing.channels",
      "billing.tasks",
      "billing.agentsOnYourOwnComputers",
      "billing.agentReminders",
      "billing.basicObservability",
      "billing.30DaysOfMessageHistory",
      "billing.100MbFileUploadsMonth",
      "billing.limitedTimeFreeJointChannel",
    ],
    notIncludedFeatures: [
      "billing.higherFileUploadLimits",
      "billing.unlimitedMessageHistory",
      "billing.unlimitedJointChannels",
      "billing.moreProfessionalFeaturesComingSoon",
    ],
    hasProFeatures: false,
  });
  assert.equal(
    getBillingPlanPresentation({ proAgentSeatFractionLabel: "0.1" }).displayName,
    "billing.free",
  );
  assert.equal(
    getBillingPlanPresentation({
      plan: "free",
      displayName: "Free",
      currentHumanSeats: 1,
      currentAgentSeats: 1,
      currentSeatQuantity: 1,
      proAgentSeatFractionLabel: "0.1",
    }).hasProFeatures,
    false,
  );

  assert.deepEqual(getBillingPlanPresentation({
    plan: "pro",
    proAgentSeatFractionLabel: "0.1",
  }), {
    displayName: "billing.pro",
    description: "billing.forBuildersAndTeamsScalingAgentCollaboration",
    includedFeatures: [
      "billing.everythingInFree",
      "billing.unlimitedMessageHistory",
      "billing.higherFileUploadLimits",
      "billing.unlimitedJointChannels",
      "billing.moreProfessionalFeaturesComingSoon",
    ],
    notIncludedFeatures: [],
    hasProFeatures: true,
  });

  assert.deepEqual(getBillingPlanPresentation({
    plan: "pro",
    displayName: "billing.pro",
    currentHumanSeats: 1,
    currentAgentSeats: 10,
    currentSeatQuantity: 1,
    proAgentSeatFractionLabel: "0.1",
  }), {
    displayName: "billing.pro",
    // Was a pre-built English template; now one ICU message plus its arguments,
    // which is what lets zh order the clause differently and drop the plural.
    description: "billing.proSeatsPurchased",
    descriptionValues: { count: 1, fraction: "0.1" },
    includedFeatures: [
      "billing.everythingInFree",
      "billing.unlimitedMessageHistory",
      "billing.higherFileUploadLimits",
      "billing.unlimitedJointChannels",
      "billing.moreProfessionalFeaturesComingSoon",
    ],
    notIncludedFeatures: [],
    hasProFeatures: true,
  });

  assert.equal(getBillingPlanPresentation({
    plan: "pro",
    currentHumanSeats: 2,
    currentAgentSeats: 0,
    currentSeatQuantity: 2,
    proAgentSeatFractionLabel: "0.1",
  }).description, "billing.proSeatsPurchased");
  // The rendered sentence (both locales, singular and plural) is asserted in
  // tests/billingPlanPresentation.i18n.test.ts; here we only pin WHICH message
  // the with-seats branch selects.

  assert.equal(getBillingPlanPresentation({
    plan: "pro",
    currentHumanSeats: 0,
    currentAgentSeats: 10,
    currentSeatQuantity: 1,
    proAgentSeatFractionLabel: "0.1",
  }).description, "billing.proSeatsPurchased");

  assert.deepEqual(
    getSettingsBillingPlanPresentation("partner", "Ignored", 0, 0, 0, "0.1"),
    getBillingPlanPresentation({ plan: "partner", displayName: "Ignored", currentHumanSeats: 0, currentAgentSeats: 0, currentSeatQuantity: 0, proAgentSeatFractionLabel: "0.1" }),
  );
});
