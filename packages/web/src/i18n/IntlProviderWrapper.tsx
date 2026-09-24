// IntlProviderWrapper — bridges the app's LocaleProvider context to react-intl.
//
// Reads the active display locale from `useLocale()` and hands react-intl the
// message map. The map is the en source-of-truth OVERLAID with the active
// locale: `{ ...en, ...MESSAGES[locale] }`. react-intl does NOT fall back to
// `defaultLocale` for message *lookup* (defaultLocale only affects number/date
// formatting), so without this overlay a key missing from the active locale
// would render its raw id. Overlaying en as the base guarantees a missing
// translation degrades to the English string instead — the runtime safety net
// behind the compile-time `Record<MessageId, string>` completeness gate.
//
// Mounts directly under LocaleProvider, above App.

import { useMemo } from "react";
import { IntlProvider } from "react-intl";
import { DEFAULT_LOCALE } from "./locale";
import { useLocale } from "./LocaleProvider";
import { MESSAGES, mergedMessages } from "./messages";
import type { ReactNode } from "react";

export function IntlProviderWrapper({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  const messages = useMemo(() => mergedMessages(locale), [locale]);
  return (
    <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={messages}>
      {children}
    </IntlProvider>
  );
}

// Re-exported for symmetry; MESSAGES stays the canonical per-locale source.
export { MESSAGES };
