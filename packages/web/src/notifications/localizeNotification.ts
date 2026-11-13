// Server notification text in the display language (docs/contracts/notifications.md
// §1.5). The server sends the English text of a banner and, for each fixed
// phrase in it, the key and args it was rendered from (`localization`,
// raft-shared notificationCopy.ts); the web catalogs carry the same `push.*`
// ids. A key this build lacks, a catalog that is not loaded, or args that do
// not fill the message keep the server's English, so nothing ever shows a raw
// id. Names and message text are args and are never translated.
//
// Raft Desktop's server stream uses this (desktopNative/serverNotificationStream.ts).
// The Web Push service worker (public/sw.js) does not: the catalogs are lazy
// ES module chunks a classic worker cannot import, so a browser notification
// stays the English text.

import { createIntl, createIntlCache } from "react-intl";
import {
  DESKTOP_NOTIFICATION_BODY_MAX,
  DESKTOP_NOTIFICATION_TITLE_MAX,
  boundDesktopNotificationText,
} from "@botiverse/raft-shared";
import type { NotificationLocalization } from "@botiverse/raft-shared";
import { DEFAULT_LOCALE } from "../i18n/locale";
import { shownLocaleMessages } from "../i18n/messages";
import type { MessageId } from "../i18n/messages";

/** The localized text of `key` with `args`, or null to keep the English. */
export type NotificationKeyLocalizer = (key: string, args: readonly string[]) => string | null;

const intlCache = createIntlCache();

/** The shown locale's text of a `push.*` key, or null (unknown key, catalog not loaded, missing arg). */
export function localizeNotificationKey(key: string, args: readonly string[]): string | null {
  if (!key.startsWith("push.")) return null;
  const { locale, messages } = shownLocaleMessages();
  const message = (messages as Partial<Record<string, string>>)[key];
  if (typeof message !== "string") return null;
  // A `{n}` with no arg would render as the placeholder: keep the English instead.
  for (const match of message.matchAll(/\{(\d+)\}/g)) {
    if (Number(match[1]) >= args.length) return null;
  }
  try {
    const text = createIntl({ locale, defaultLocale: DEFAULT_LOCALE, messages, onError: () => {} }, intlCache)
      .formatMessage({ id: key as MessageId }, Object.fromEntries(args.map((arg, index) => [String(index), arg])));
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Title / subtitle / body with every keyed part localized; the rest (and any part that cannot be) as sent. */
export function localizeNotificationText(
  text: { title: string; subtitle?: string; body: string },
  localization: NotificationLocalization | undefined,
  localize: NotificationKeyLocalizer = localizeNotificationKey,
): { title: string; subtitle?: string; body: string } {
  if (!localization) return text;
  const part = (value: string, key: string | undefined, args: string[] | undefined, max: number) => {
    if (!key) return value;
    const localized = localize(key, args ?? []);
    return localized === null ? value : boundDesktopNotificationText(localized, max);
  };
  return {
    title: part(text.title, localization.titleKey, localization.titleArgs, DESKTOP_NOTIFICATION_TITLE_MAX),
    ...(text.subtitle !== undefined
      ? { subtitle: part(text.subtitle, localization.subtitleKey, localization.subtitleArgs, DESKTOP_NOTIFICATION_TITLE_MAX) }
      : {}),
    body: part(text.body, localization.bodyKey, localization.bodyArgs, DESKTOP_NOTIFICATION_BODY_MAX),
  };
}
