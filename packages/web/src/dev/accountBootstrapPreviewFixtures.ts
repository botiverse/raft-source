import type { User } from "../store/authStore";

export function accountBootstrapPreviewUser(provider: "google" | "github" | "apple" | null): User {
  return {
    id: "account-preview-user",
    email: "cindy@example.com",
    gravatarHash: "preview",
    name: "pending_1234567890abcdef",
    displayName: provider ? "Cindy Rui" : null,
    description: null,
    avatarUrl: provider ? "https://api.dicebear.com/9.x/notionists-neutral/png?seed=Cindy" : null,
    emailVerified: true,
    profileSetupCompletedAt: null,
    profileSetupSuggestedHandle: provider ? "cindyrui2" : null,
    profileSetupProvider: provider,
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}
