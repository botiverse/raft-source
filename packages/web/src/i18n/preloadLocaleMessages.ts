import { DEFAULT_LOCALE, resolveInitialLocale } from "./locale";
import type { Locale } from "./locale";
import { isLocaleMessagesLoaded, loadLocaleMessages, setShownLocale } from "./messages";
import { tellServiceWorkerLocale } from "./serviceWorkerLocale";

// The app entries hold their first render until the initial locale's catalogs
// are in memory: its own, and en under a partial locale (messages/index.ts).
// The boot script has already asked for them with modulepreload from the page
// (boot/bootInlineScript.ts), so this is usually a moment, and the service
// worker keeps them for the next open. There is no English to fall back to (en
// is a chunk like the others), so a failed load is tried once more, and a
// second failure is kept for IntlProviderWrapper, which throws it into
// RootErrorBoundary: the app's refresh screen, never a page of raw ids.

let initialLocale: Locale = DEFAULT_LOCALE;
let initialLoadError: unknown = null;

/** The catalog load that failed twice at boot, for IntlProviderWrapper to throw while those catalogs are still missing. */
export function initialLocaleLoadError(locale: Locale): unknown {
  return locale === initialLocale ? initialLoadError : null;
}

/** The pending load of the initial locale's catalogs, or null when there is nothing to wait for. Never rejects. */
export function preloadInitialLocaleMessages(): Promise<void> | null {
  if (typeof window === "undefined") return null;
  let locale: Locale = DEFAULT_LOCALE;
  try {
    locale = resolveInitialLocale({
      storage: window.localStorage,
      languages: window.navigator?.languages,
      search: window.location?.search,
    });
  } catch {
    // Storage or navigator unreadable: the default locale, as resolveInitialLocale would.
  }
  initialLocale = locale;
  initialLoadError = null;
  setShownLocale(locale);
  tellServiceWorkerLocale(locale);
  if (isLocaleMessagesLoaded(locale)) return null;
  return loadLocaleMessages(locale)
    .catch(() => loadLocaleMessages(locale))
    .catch((error: unknown) => {
      initialLoadError = error;
    });
}
