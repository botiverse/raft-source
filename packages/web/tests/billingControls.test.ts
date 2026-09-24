import assert from "node:assert/strict";
import test from "node:test";
import { getBillingControlsState } from "../src/utils/billingControls";

test("billing controls allow checkout for non-entitling subscription rows", () => {
  for (const subscriptionStatus of ["canceled", "incomplete", null] as const) {
    const state = getBillingControlsState({ plan: "free", subscriptionStatus });
    assert.equal(state.hasEntitlingSubscription, false);
    assert.equal(state.canCheckout, true);
    assert.equal(state.canUpdatePacks, false);
    assert.equal(state.canOpenPortal, false);
  }
});

test("billing controls reserve pack updates for entitling Pro subscriptions", () => {
  const activePro = getBillingControlsState({ plan: "pro", subscriptionStatus: "active" });
  assert.equal(activePro.canCheckout, false);
  assert.equal(activePro.canUpdatePacks, true);
  assert.equal(activePro.canOpenPortal, true);

  const pastDuePro = getBillingControlsState({ plan: "pro", subscriptionStatus: "past_due" });
  assert.equal(pastDuePro.canCheckout, false);
  assert.equal(pastDuePro.canUpdatePacks, true);
  assert.equal(pastDuePro.canOpenPortal, true);

  const activeFreeProjection = getBillingControlsState({ plan: "free", subscriptionStatus: "active" });
  assert.equal(activeFreeProjection.canCheckout, false);
  assert.equal(activeFreeProjection.canUpdatePacks, false);
  assert.equal(activeFreeProjection.canOpenPortal, true);
});

test("billing controls do not expose checkout for internal entitlement states", () => {
  for (const plan of ["founder", "partner"] as const) {
    const internalEntitlement = getBillingControlsState({ plan, subscriptionStatus: null });
    assert.equal(internalEntitlement.hasEntitlingSubscription, false);
    assert.equal(internalEntitlement.canCheckout, false);
    assert.equal(internalEntitlement.canUpdatePacks, false);
    assert.equal(internalEntitlement.canOpenPortal, false);

    const withSubscription = getBillingControlsState({ plan, subscriptionStatus: "active" });
    assert.equal(withSubscription.hasEntitlingSubscription, false);
    assert.equal(withSubscription.canCheckout, false);
    assert.equal(withSubscription.canUpdatePacks, false);
    assert.equal(withSubscription.canOpenPortal, false);
  }
});
