import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { DEFAULT_LOCALE } from "../../src/i18n/locale";
import type { Locale } from "../../src/i18n/locale";
import { mergedMessages } from "../../src/i18n/messages";

// Test-side mirror of IntlProviderWrapper: any component migrated to react-intl
// (e.g. ConfirmDialog) calls useIntl() and requires an <IntlProvider> ancestor.
// Component/behavior tests that mount such a component must wrap it with this so
// the intl context resolves exactly like production (same messages, same
// en-overlay fallback). Defaults to en; pass a locale to assert zh-cn copy.

export function TestIntlProvider({
  locale = DEFAULT_LOCALE,
  children,
}: {
  locale?: Locale;
  children: ReactNode;
}) {
  return (
    <IntlProvider locale={locale} defaultLocale={DEFAULT_LOCALE} messages={mergedMessages(locale)}>
      {children}
    </IntlProvider>
  );
}

/** `render()` with the intl context pre-wrapped. */
export function renderWithIntl(
  ui: ReactElement,
  { locale, ...options }: RenderOptions & { locale?: Locale } = {},
): RenderResult {
  return render(<TestIntlProvider locale={locale}>{ui}</TestIntlProvider>, options);
}
