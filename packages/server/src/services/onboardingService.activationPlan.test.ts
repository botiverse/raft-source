import assert from "node:assert/strict";
import { test } from "vitest";
import { isOwnerOnboardingActivationEligible } from "./onboardingService.js";

test("skip -> create normal agent -> activation: owner onboarding should NOT trigger", () => {
  const serverOnboardingAgentId = null;
  const activatedAgentId = "agent-normal";
  assert.equal(
    isOwnerOnboardingActivationEligible(serverOnboardingAgentId, activatedAgentId),
    false,
  );
});

test("skip -> create onboarding agent -> activation: owner onboarding should trigger", () => {
  const serverOnboardingAgentId = "agent-cindy";
  const activatedAgentId = "agent-cindy";
  assert.equal(
    isOwnerOnboardingActivationEligible(serverOnboardingAgentId, activatedAgentId),
    true,
  );
});

