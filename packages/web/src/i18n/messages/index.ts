// Per-locale react-intl message maps + the MessageId union.
//
// `MESSAGES[locale]` is passed to react-intl's IntlProvider. `en` is the default
// / source of truth; other locales are typed against `MessageId` for compile-time
// completeness, with the key-equivalence test as the CI backstop.

import { DEFAULT_LOCALE } from "../locale";
import type { Locale } from "../locale";
import { en } from "./en";
import type { MessageId } from "./en";
import { zhCn } from "./zh-cn";

export type { MessageId };

export const MESSAGES: Record<Locale, Record<MessageId, string>> = {
  en,
  "zh-cn": zhCn,
};

/**
 * Messages for `locale` overlaid on the default-locale base, so any key not yet
 * translated in `locale` degrades to the English string rather than its raw id.
 * For the default locale this is just its own map. This is what IntlProvider is
 * fed; the per-locale `MESSAGES` maps stay the canonical, un-merged source.
 */
export function mergedMessages(locale: Locale): Record<MessageId, string> {
  if (locale === DEFAULT_LOCALE) return MESSAGES[DEFAULT_LOCALE];
  return { ...MESSAGES[DEFAULT_LOCALE], ...MESSAGES[locale] };
}
