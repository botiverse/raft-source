import type { User } from "../store/authStore";

export function accountBootstrapPreviewUser(provider: "google" | "github" | "apple" | null): User {
  return {
    id: "account-preview-user",
    email: "cindy@example.com",
    name: "pending_1234567890abcdef",
    displayName: provider ? "Cindy Rui" : null,
    description: null,
    // A new email account starts with a random built pixel avatar (the server
    // stores one at sign-up); a social one with the provider's photo.
    avatarUrl: provider ? "https://api.dicebear.com/9.x/notionists-neutral/png?seed=Cindy" : "pixel-human:v1:mint.3.side.brown.happy.headphones.none",
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
