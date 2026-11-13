import * as serverService from "./serverService";
import { isProductFeedbackEnabled } from "./productFeedbackSendService";

type ServerSettingsDependencies = {
  getOnboardSettings: typeof serverService.getServerOnboardingSettings;
  getMemberOnboardPreferences: typeof serverService.getMemberOnboardingPreferences;
  isFeedbackEnabled: () => boolean;
};

const defaultDependencies: ServerSettingsDependencies = {
  getOnboardSettings: serverService.getServerOnboardingSettings,
  getMemberOnboardPreferences: serverService.getMemberOnboardingPreferences,
  isFeedbackEnabled: isProductFeedbackEnabled,
};

export async function getServerSettings(
  serverId: string,
  userId: string,
  dependencies: ServerSettingsDependencies = defaultDependencies,
) {
  const [onboarding, prefs] = await Promise.all([
    dependencies.getOnboardSettings(serverId),
    dependencies.getMemberOnboardPreferences(serverId, userId),
  ]);
  if (!onboarding || !prefs) return null;

  return {
    settings: {
      onboardSettings: {
        onboardingAgentId: onboarding.onboardingAgentId ?? null,
        agentAllChannelGreetingEnabled: onboarding.agentAllChannelGreetingEnabled,
        onboardingWizardEnabled: onboarding.onboardingWizardEnabled,
        setupModalReminderOptOut: prefs.setupModalReminderOptOut,
        // Backward-compatible alias for older clients.
        onboardingReminderOptOut: prefs.setupModalReminderOptOut,
        dismissedAddComputerStepAt: prefs.dismissedAddComputerStepAt,
        dismissedCreateAgentStepAt: prefs.dismissedCreateAgentStepAt,
        dismissedInviteStepAt: prefs.dismissedInviteStepAt,
        dismissedCommunityStepAt: prefs.dismissedCommunityStepAt,
        dismissedNotificationStepAt: prefs.dismissedNotificationStepAt,
        onboardingWizardCurrentStep: prefs.onboardingWizardCurrentStep,
        onboardingDmSentAt: prefs.onboardingDmSentAt,
        onboardingDmSentByAgentId: prefs.onboardingDmSentByAgentId,
      },
      feedbackSettings: {
        enabled: dependencies.isFeedbackEnabled(),
      },
    },
  };
}
