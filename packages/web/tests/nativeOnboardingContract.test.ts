import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_ONBOARDING_CONTRACT_VERSION,
  readNativeOnboardingGeneration,
} from "../src/embed/nativeOnboarding";

test("Native onboarding v1 accepts and echoes only bounded opaque generations", () => {
  assert.equal(NATIVE_ONBOARDING_CONTRACT_VERSION, "raft-onboarding-v1");
  assert.equal(readNativeOnboardingGeneration("?generation=account_1%3Aserver-2.view-3"), "account_1:server-2.view-3");
  assert.equal(readNativeOnboardingGeneration("?generation="), null);
  assert.equal(readNativeOnboardingGeneration(""), null);
  assert.equal(readNativeOnboardingGeneration("?generation=contains%20space"), null);
  assert.equal(readNativeOnboardingGeneration(`?generation=${"a".repeat(129)}`), null);
});
