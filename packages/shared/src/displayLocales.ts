// UI display locales — the app-chrome languages the web app can actually render
// (react-intl catalogs under packages/web/src/i18n/messages). This is the single
// source of truth for the renderable set; the web `Locale` union / SUPPORTED_LOCALES
// derive from DISPLAY_LOCALES.
//
// DELIBERATELY distinct from the message-TRANSLATION taxonomy
// (translationLanguages.ts): those are targets for translating other people's
// chat messages and include languages with no shipped UI catalog (fr, ja,
// zh-tw, …). A display locale MUST have a shipped catalog, so this set is small
// and its normalizer refuses base-language widening — `fr-FR` and `zh-TW`
// (Traditional) are rejected, not coerced, because we cannot render them.

export const DISPLAY_LOCALES = ["en", "zh-cn"] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];

/**
 * Normalize an arbitrary language tag to a renderable display locale, or null if
 * we do not ship a catalog for it. Region/script variants collapse ONLY within a
 * shipped base:
 *   - `en`, `en-US`, `en-GB`, … → `en`
 *   - `zh`, `zh-CN`, `zh-Hans`, `zh-Hans-CN` → `zh-cn`
 * Everything else (`fr`, `fr-FR`, `zh-TW`, `zh-Hant`, `ja`, …) → null. No
 * split-on-`-` base widening — accepting a base we can't render would persist a
 * preference that silently no-ops on read.
 */
export function normalizeDisplayLocale(
  raw: string | null | undefined,
): DisplayLocale | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "en" || value.startsWith("en-")) return "en";
  if (value === "zh-cn" || value === "zh" || value === "zh-hans" || value === "zh-hans-cn") {
    return "zh-cn";
  }
  return null;
}

/** Type guard: is `value` already a canonical display locale? */
export function isDisplayLocale(value: string | null | undefined): value is DisplayLocale {
  return value === "en" || value === "zh-cn";
}
