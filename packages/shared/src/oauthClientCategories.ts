/**
 * User-facing categories for Connected Apps.
 *
 * Keep this list broad and intent-based: it is shared by the API validation
 * boundary and every first-party picker/filter so the category contract does
 * not drift between clients.
 */
export const OAUTH_CLIENT_CATEGORIES = [
  "AI & Automation",
  "Communication",
  "Productivity & Collaboration",
  "Developer Tools",
  "Data & Analytics",
  "Business Ops",
  "Infrastructure",
  "Content & Creative",
  "Other",
] as const;

export type OAuthClientCategory = (typeof OAUTH_CLIENT_CATEGORIES)[number];

export const LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES = {
  Productivity: "Productivity & Collaboration",
  "Dev Tools": "Developer Tools",
  Storage: "Infrastructure",
  Scheduling: "Productivity & Collaboration",
  "Business & Operations": "Business Ops",
  "Infrastructure & Operations": "Infrastructure",
} as const satisfies Record<string, OAuthClientCategory>;

const OAUTH_CLIENT_CATEGORY_SET = new Set<string>(OAUTH_CLIENT_CATEGORIES);

/**
 * Resolves canonical and pre-taxonomy category values without guessing new
 * arbitrary strings. Callers decide whether null means a validation error or
 * an `Other` fallback for historical data.
 */
export function canonicalizeOAuthClientCategory(raw: unknown): OAuthClientCategory | null {
  if (typeof raw !== "string") return null;
  if (OAUTH_CLIENT_CATEGORY_SET.has(raw)) return raw as OAuthClientCategory;
  return LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES[
    raw as keyof typeof LEGACY_OAUTH_CLIENT_CATEGORY_ALIASES
  ] ?? null;
}
