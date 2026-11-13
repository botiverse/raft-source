// LocaleProvider — app-root React context holding the active UI display locale.
//
// SPA adaptation of raft-landing's path-based locale: here the locale is a
// piece of client state (context), initialized from a navigation override,
// explicit stored choice, or browser preference, and
// switched live from Settings with no page reload. Server-persisted user
// preference (P0b) will be reconciled in via `setLocaleFromUser`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  htmlLangForLocale,
  isSupportedLocale,
  rememberLocale,
  resolveInitialLocale,
} from "./locale";
import type {
  Locale,
} from "./locale";
import { isLocaleReadyToShow, loadLocaleToShow } from "./messages";
import { tellServiceWorkerLocale } from "./serviceWorkerLocale";

type LocaleContextValue = {
  locale: Locale;
  /** User-initiated change (Settings selector). Persists to storage. */
  setLocale: (next: Locale) => void;
  /**
   * Reconcile to the authenticated user's server-persisted preference once it
   * loads. Missing, legacy, or unsupported values are not explicit choices and
   * preserve the locale already resolved from storage/browser state.
   */
  setLocaleFromUser: (next: string | null | undefined) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function syncDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = htmlLangForLocale(locale);
}

function readInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const locale = resolveInitialLocale({
    storage: window.localStorage,
    languages: window.navigator?.languages,
    search: window.location?.search,
  });
  syncDocumentLocale(locale);
  return locale;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);
  // The latest requested locale: a slower catalog load must not switch the app
  // back after a newer choice has already applied.
  const requestedLocale = useRef<Locale | null>(null);

  // Switch once the locale's catalogs are in memory (en too under a partial
  // locale; both parts once anything past the first screen has loaded, as an
  // open panel may show any id: messages/index.ts), so the UI goes straight from the old language to the new one
  // instead of flashing English or raw ids while the chunks load. A failed load
  // keeps the current language, with no app-wide refresh prompt (catalog loads
  // are importHandledLocally, i18n/messages/index.ts); choosing it again retries.
  const applyLocale = useCallback((next: Locale) => {
    requestedLocale.current = next;
    const commit = () => {
      if (requestedLocale.current !== next) return;
      syncDocumentLocale(next);
      setLocaleState(next);
      tellServiceWorkerLocale(next);
      if (typeof window !== "undefined") {
        rememberLocale(next, window.localStorage);
      }
    };
    if (isLocaleReadyToShow(next)) commit();
    else {
      loadLocaleToShow(next).then(commit, (error: unknown) => {
        if (requestedLocale.current === next) requestedLocale.current = null;
        console.warn("[i18n] could not load the catalog for", next, error);
      });
    }
  }, []);

  const setLocale = useCallback((next: Locale) => applyLocale(next), [applyLocale]);

  const setLocaleFromUser = useCallback((next: string | null | undefined) => {
    if (!isSupportedLocale(next)) return;
    applyLocale(next);
  }, [applyLocale]);
  // The auth → locale reconcile (calling setLocaleFromUser with the user's
  // server-persisted displayLanguage) lives in App.tsx, NOT here — so importing
  // useCopy from the i18n barrel doesn't drag the auth store into every
  // component's module graph.

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, setLocaleFromUser }),
    [locale, setLocale, setLocaleFromUser],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Current display locale + setters. Falls back to default outside a provider. */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    // Defensive fallback so a stray consumer never crashes the tree; in
    // practice LocaleProvider wraps the whole app at the root.
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      setLocaleFromUser: () => {},
    };
  }
  return ctx;
}
