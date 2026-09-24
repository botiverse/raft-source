import assert from "node:assert/strict";
import { test } from "vitest";
import { getServerSettings } from "./serverSettingsService.js";

test("general settings uses each existing onboarding reader once and adds feedback without another reader", async () => {
  const calls = { onboard: 0, member: 0, feedback: 0 };
  const payload = await getServerSettings("server-1", "user-1", {
    getOnboardSettings: async () => {
      calls.onboard += 1;
      return {
        onboardingAgentId: null,
        agentAllChannelGreetingEnabled: true,
        onboardingWizardEnabled: true,
      };
    },
    getMemberOnboardPreferences: async () => {
      calls.member += 1;
      return {
        setupModalReminderOptOut: false,
        dismissedAddComputerStepAt: null,
        dismissedCreateAgentStepAt: null,
        dismissedInviteStepAt: null,
        dismissedCommunityStepAt: null,
        dismissedNotificationStepAt: null,
        onboardingWizardCurrentStep: null,
        onboardingDmSentAt: null,
        onboardingDmSentByAgentId: null,
        onboardingOwnerOpenerV2SentAt: null,
        onboardingOwnerOpenerV2SentByAgentId: null,
        onboardingOwnerOpenerV2MessageIds: [],
        onboardingOwnerOpenerV2Version: null,
        onboardingOwnerOpenerV2Topics: [],
        crossChannelHintShownAt: null,
        allChannelUnlockInstructionSentAt: null,
      };
    },
    isFeedbackEnabled: () => {
      calls.feedback += 1;
      return true;
    },
  });

  assert.deepEqual(calls, { onboard: 1, member: 1, feedback: 1 });
  assert.equal(payload?.settings.feedbackSettings.enabled, true);
  assert.equal(payload?.settings.onboardSettings.onboardingAgentId, null);
});

test("member preferences remain the membership boundary without a separate precheck", async () => {
  const calls = { onboard: 0, member: 0, feedback: 0 };
  const payload = await getServerSettings("server-1", "outsider", {
    getOnboardSettings: async () => {
      calls.onboard += 1;
      return {
        onboardingAgentId: null,
        agentAllChannelGreetingEnabled: true,
        onboardingWizardEnabled: true,
      };
    },
    getMemberOnboardPreferences: async () => {
      calls.member += 1;
      return null;
    },
    isFeedbackEnabled: () => {
      calls.feedback += 1;
      return true;
    },
  });

  assert.equal(payload, null);
  assert.deepEqual(calls, { onboard: 1, member: 1, feedback: 0 });
});
