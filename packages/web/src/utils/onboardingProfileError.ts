/**
 * Which onboarding step a failed profile call came from (authStore's
 * uploadAvatar and completeProfile; AccountIdentitySetupPage reads it).
 */
type OnboardingProfileStep = "avatar" | "profile";

export function markOnboardingProfileError(error: unknown, onboardingStep: OnboardingProfileStep): unknown {
  if (typeof error === "object" && error !== null) {
    (error as { onboardingStep?: OnboardingProfileStep }).onboardingStep = onboardingStep;
    return error;
  }
  return Object.assign(new Error(String(error)), { onboardingStep });
}
