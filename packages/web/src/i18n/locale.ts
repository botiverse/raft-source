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

import { DISPLAY_LOCALES } from "@botiverse/raft-shared";
import type { DisplayLocale } from "@botiverse/raft-shared";

/**
 * Supported UI display locales. Single-sourced from `@botiverse/raft-shared`
 * DISPLAY_LOCALES — the set the app ships a catalog for — so the client and the
 * server's display-language validator can never diverge. Starts narrow (en +
 * zh-cn) per @Wug's P0 guidance; expand by adding a locale there + a catalog.
 */
export type Locale = DisplayLocale;

export const DEFAULT_LOCALE: Locale = "en";

export const SUPPORTED_LOCALES: readonly Locale[] = DISPLAY_LOCALES;

/** Human-readable label shown in the display-language selector, in-language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-cn": "简体中文",
};

export const HTML_LANG_BY_LOCALE: Record<Locale, string> = {
  en: "en",
  "zh-cn": "zh-CN",
};

export function htmlLangForLocale(locale: Locale): string {
  return HTML_LANG_BY_LOCALE[locale];
}

/**
 * localStorage key for the client-side display-language cache. Server-persisted
 * user preference (P0b) takes precedence when present; this is the pre-auth /
 * offline fallback and the fast-path so first paint doesn't flash the wrong
 * language while the user record loads.
 */
export const DISPLAY_LOCALE_STORAGE_KEY = "slock.displayLanguage";

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "zh-cn";
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
  for (const language of languages ?? []) {
    const normalized = language.toLowerCase();
    if (normalized === "zh" || normalized.startsWith("zh-") || normalized.startsWith("zh_")) {
      // All Chinese variants fold to zh-cn until zh-tw is added to the set.
      return "zh-cn";
    }
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolve the initial display locale before the server user record is known.
 * A navigation override wins, then an explicit stored choice, then the
 * browser's ordered preferences, with English as the final fallback.
 * Once the authenticated user's persisted preference loads, LocaleProvider
 * reconciles only when that account value is an explicit supported locale.
 */
const CHINESE_LANGUAGE_RE = /^zh(?:-|$)/i;

/**
 * Resolve the `?lang=` navigation parameter, or null when it is absent.
 *
 * This exists because the Android app embeds settings (notably the billing
 * flow) in a WebView and passes the device language this way — see #4602,
 * "localize embedded billing flow". Storage is empty in a fresh WebView and the
 * user record has not loaded yet, so without this the embedded surface falls
 * back to English on a Chinese device.
 *
 * `lang=system` means the HOST explicitly asked to follow the device language.
 * It remains a separate path from automatic browser detection because the
 * navigation instruction deliberately outranks a cached user choice.
 *
 * Semantics are kept identical to the billing-only resolver this replaces, so
 * migrating that surface to the catalog cannot change what an embedded host sees.
 */
export function resolveLangParamLocale(
  search: string | undefined,
  browserLanguages: readonly string[] | undefined,
): Locale | null {
  if (!search) return null;
  const requested = new URLSearchParams(search).get("lang")?.trim();
  if (!requested) return null;
  if (requested === "system") {
    return (browserLanguages ?? []).some((language) => CHINESE_LANGUAGE_RE.test(language))
      ? "zh-cn"
      : "en";
  }
  return CHINESE_LANGUAGE_RE.test(requested) ? "zh-cn" : "en";
}

/**
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
