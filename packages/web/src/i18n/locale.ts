// Web-app UI display-language (i18n) core — library-agnostic locale model.
//
// This module owns only the `Locale` union, labels, and the preference
// resolution used to seed the initial locale. The message runtime itself is
// react-intl (FormatJS): messages live as flat ICU catalogs in `i18n/messages/`
// and are rendered via `IntlProviderWrapper` / `useIntl().formatMessage`. Locale
// lives in a React context (see LocaleProvider), not in the URL path.
//
// Distinct from message-content translation (translationStore): that
// translates other people's chat messages; THIS is the app's own UI chrome.
// Locale codes are kept aligned with the shared translation-language taxonomy
// (`@botiverse/raft-shared` SUPPORTED_TRANSLATION_LANGUAGES) so the two systems never
// diverge on language identifiers.

import {
  DISPLAY_LOCALE_INFO,
  DISPLAY_LOCALES,
  displayLocaleTag,
  isDisplayLocale,
  matchDisplayLocale,
  matchDisplayLocaleFromList,
  matchSystemDisplayLocale,
} from "@botiverse/raft-shared";
import type { DisplayLocale } from "@botiverse/raft-shared";

/**
 * Supported UI display locales. Single-sourced from the `@botiverse/raft-shared`
 * locale registry (DISPLAY_LOCALES / DISPLAY_LOCALE_INFO) — the set the app ships
 * a catalog for, in picker order — so the client and the server's
 * display-language validator can never diverge.
 */
export type Locale = DisplayLocale;

export const DEFAULT_LOCALE: Locale = "en";

export const SUPPORTED_LOCALES: readonly Locale[] = DISPLAY_LOCALES;

/** Label shown in the display-language selector: the language's own name. */
export const LOCALE_LABELS: Record<Locale, string> = Object.fromEntries(
  DISPLAY_LOCALES.map((locale) => [locale, DISPLAY_LOCALE_INFO[locale].nativeName]),
) as Record<Locale, string>;

export function htmlLangForLocale(locale: Locale): string {
  return displayLocaleTag(locale);
}

/**
 * localStorage key for the client-side display-language cache. Server-persisted
 * user preference (P0b) takes precedence when present; this is the pre-auth /
 * offline fallback and the fast-path so first paint doesn't flash the wrong
 * language while the user record loads.
 */
export const DISPLAY_LOCALE_STORAGE_KEY = "slock.displayLanguage";

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return isDisplayLocale(value);
}

/** Read the cached display locale from storage, or null if unset/invalid. */
export function getStoredLocale(storage: Storage | undefined): Locale | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(DISPLAY_LOCALE_STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Persist the display locale to storage; swallow storage failures. */
export function rememberLocale(locale: Locale, storage: Storage | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(DISPLAY_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures so language selection still applies in-session.
  }
}

/**
 * Map the browser's ordered language preferences onto a supported locale.
 * This is both the automatic fallback for a user without an explicit choice
 * and suggestion metadata for language pickers.
 */
export function getBrowserPreferredLocale(languages: readonly string[] | undefined): Locale {
  // Browsers report BCP 47; older ones were seen sending `zh_CN`, so accept that too.
  return matchDisplayLocaleFromList((languages ?? []).map((language) => language.replace(/_/g, "-")))
    ?? DEFAULT_LOCALE;
}

// `?lang=` tag → locale; anything unmatched resolves to English. Underscore tags
// (`zh_TW`) deliberately do not match: that is the frozen billing-resolver
// behaviour an Android host already relies on (see localeLangParam.test).
function langParamTagLocale(tag: string): Locale | null {
  return matchDisplayLocale(tag);
}

/**
 * Resolve the `?lang=` navigation parameter, or null when it is absent.
 *
 * This exists because the Android app embeds settings (notably the billing
 * flow) in a WebView and passes the device language this way — see #4602,
 * "localize embedded billing flow". Storage is empty in a fresh WebView and the
 * user record has not loaded yet, so without this the embedded surface falls
 * back to English on a Chinese device.
 *
 * `lang=system` means the HOST explicitly asked to follow the device language:
 * `matchSystemDisplayLocale` (the first device language with a catalog; English
 * listed first yields only to a later Chinese language), else English. It remains a separate path from automatic browser detection because
 * the navigation instruction deliberately outranks a cached user choice.
 *
 * For en/zh the semantics are kept identical to the billing-only resolver this
 * replaces, so migrating that surface to the catalog cannot change what an
 * embedded host sees; every other shipped locale follows the same rule.
 */
export function resolveLangParamLocale(
  search: string | undefined,
  browserLanguages: readonly string[] | undefined,
): Locale | null {
  if (!search) return null;
  const requested = new URLSearchParams(search).get("lang")?.trim();
  if (!requested) return null;
  if (requested === "system") return matchSystemDisplayLocale(browserLanguages);
  return langParamTagLocale(requested) ?? DEFAULT_LOCALE;
}

/**
 * Resolve the initial display locale before the server user record is known.
 * A navigation override wins, then an explicit stored choice, then the
 * browser's ordered preferences, with English as the final fallback.
 * Once the authenticated user's persisted preference loads, LocaleProvider
 * reconciles only when that account value is an explicit supported locale.
 *
 * `?lang=` wins over the cached choice and is deliberately NOT persisted: it is
 * a per-navigation instruction from an embedding host, and writing it to storage
 * would let one embedded visit silently rewrite the user's own setting.
 */
export function resolveInitialLocale({
  storage,
  languages,
  search,
}: {
  storage?: Storage;
  languages?: readonly string[];
  search?: string;
}): Locale {
  return resolveLangParamLocale(search, languages)
    ?? getStoredLocale(storage)
    ?? getBrowserPreferredLocale(languages);
}

/**
 * Account locale becomes authoritative only after auth has settled with a real
 * user record. Signed-out state is not an account preference and must not
 * rewrite an explicit cached choice (for example during logout).
 */
export function shouldReconcileAccountLocale({
  initialized,
  userId,
}: {
  initialized: boolean;
  userId: string | null | undefined;
}): boolean {
  return initialized && Boolean(userId);
}
