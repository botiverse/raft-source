// IntlProviderWrapper — bridges the app's LocaleProvider context to react-intl.
//
// Reads the active display locale from `useLocale()` and hands react-intl the
// message map. The map is the en source-of-truth OVERLAID with the active
// locale: `{ ...en, ...catalog }`. react-intl does NOT fall back to
// `defaultLocale` for message *lookup* (defaultLocale only affects number/date
// formatting), so without this overlay a key missing from the active locale
// would render its raw id. Overlaying en as the base guarantees a missing
// translation degrades to the English string instead. That is the design for
// every catalog but zh-cn, which are `Partial` and backfilled in batches.
//
// Non-English catalogs load on demand. The entries preload the initial locale
// and LocaleProvider loads a new one before switching to it, so this normally
// finds the catalog ready; if not (a host that skipped the preload), it renders
// English, starts the load, and re-renders when the catalog arrives.
//
// Mounts directly under LocaleProvider, above App.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE } from "./locale";
import { useLocale } from "./LocaleProvider";
import {
  isLocaleMessagesComplete,
  isLocaleMessagesLoaded,
  loadLocaleMessages,
  mergedMessages,
  noteMissingIdShown,
  restCatalogReady,
  setShownLocale,
  subscribeLocaleMessages,
} from "./messages";
import { enFallbackMessages } from "./messages/enFallback";
import { initialLocaleLoadError } from "./preloadLocaleMessages";
import type { ReactNode } from "react";

/**
 * `recovery`: the refresh and crash screens (RootErrorBoundary). With the
 * shown locale's catalogs missing (the very failure that brought the screen
 * up), they read in English from enFallback instead of throwing again.
 */
export function IntlProviderWrapper({ children, recovery = false }: { children: ReactNode; recovery?: boolean }) {
  const { locale } = useLocale();
  // The messages object: a new one when a first part arrives, or a later part
  // after an id was shown without its words (messages/index.ts), so the app
  // renders again then; a later part otherwise fills the same object in place.
  const messages = useSyncExternalStore(
    subscribeLocaleMessages,
    () => mergedMessages(locale),
    () => mergedMessages(locale),
  );
  const loaded = isLocaleMessagesLoaded(locale);
  useEffect(() => {
    // Normally already in: the boot waits for the initial locale's catalogs and
    // LocaleProvider switches only once the next one's are. A failed chunk is
    // retried on the next locale change or reload.
    if (!loaded) loadLocaleMessages(locale).catch(() => {});
  }, [loaded, locale]);
  // An id the build did not find in the first download's code, shown before
  // the rest of the catalog is in (messages/catalogParts.ts): said in the
  // console (the app's own checks look for it), and the rest is asked for;
  // when it is in, the app renders again with the words. Otherwise as react-intl's own
  // handler: logged outside production.
  const onError = useCallback((error: { code?: string }) => {
    if (error.code === "MISSING_TRANSLATION" && !isLocaleMessagesComplete(locale)) {
      console.warn("[i18n] an id outside the catalog's first part was shown before the rest was in", error);
      noteMissingIdShown();
      restCatalogReady().catch(() => {});
      return;
    }
    if (import.meta.env.DEV) console.error(error);
  }, [locale]);
  // Words formatted outside React follow the language on screen
  // (shownLocaleMessages): a module-level note, the same on every render.
  setShownLocale(locale);
  // The boot could not load the catalogs this page opened in, twice: the app's
  // refresh screen (RootErrorBoundary) rather than a page of raw ids.
  if (!loaded && recovery) {
    return (
      <IntlProvider locale={DEFAULT_LOCALE} defaultLocale={DEFAULT_LOCALE} messages={enFallbackMessages}>
        {children}
      </IntlProvider>
    );
  }
  const bootError = loaded ? null : initialLocaleLoadError(locale);
  if (bootError) throw bootError;
  return (
    <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={messages} onError={onError}>
      {children}
    </IntlProvider>
  );
}
