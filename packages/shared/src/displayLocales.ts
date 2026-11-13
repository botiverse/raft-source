// UI display locales — the app-chrome languages Raft ships a catalog for. This
// registry is the single source of truth: the web catalog set, the Settings
// picker (names and order), <html lang>, every place that picks a locale from a
// language tag (browser, `?lang=`, Accept-Language, the OS locale of the
// desktop app and the Computer CLI), and the server's display-language
// validator all derive from it. Adding a locale is one entry here plus its
// catalogs; docs/frontend/i18n/README.md has the checklist.
//
// DELIBERATELY distinct from the message-TRANSLATION taxonomy
// (translationLanguages.ts): those are targets for translating other people's
// chat messages and include languages with no shipped UI catalog (fr, de, …).
// Every display locale is also a translation language (checked in tests), so a
// display locale can stand in as the default translation target.

/**
 * Canonical codes, in Settings picker order: native names sorted by the
 * Unicode root collation (Latin, then Cyrillic, then Hangul, then Han), so the order favours
 * no language and a new locale has exactly one place to go. A test pins it.
 */
export const DISPLAY_LOCALES = ["en", "es", "pt-br", "ru", "ko", "ja", "zh-cn", "zh-tw"] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];

export interface DisplayLocaleInfo {
  /** BCP 47 tag: <html lang>, Intl formatting, Accept-Language, native hosts. */
  readonly tag: string;
  /** The language's name for itself (endonym), shown in the language picker. */
  readonly nativeName: string;
}

export const DISPLAY_LOCALE_INFO: Readonly<Record<DisplayLocale, DisplayLocaleInfo>> = {
  en: { tag: "en", nativeName: "English" },
  es: { tag: "es", nativeName: "Español" },
  "pt-br": { tag: "pt-BR", nativeName: "Português (Brasil)" },
  ru: { tag: "ru", nativeName: "Русский" },
  ko: { tag: "ko", nativeName: "한국어" },
  ja: { tag: "ja", nativeName: "日本語" },
  "zh-cn": { tag: "zh-CN", nativeName: "简体中文" },
  "zh-tw": { tag: "zh-TW", nativeName: "繁體中文" },
};

/** The BCP 47 tag of a display locale (`zh-cn` → `zh-CN`, `pt-br` → `pt-BR`). */
export function displayLocaleTag(locale: DisplayLocale): string {
  return DISPLAY_LOCALE_INFO[locale].tag;
}

interface ParsedTag {
  language: string;
  /** Only tracked where Raft could ship two scripts of one language (Chinese). */
  script: string | null;
}

// Chinese is the one language whose script decides the catalog: Hans (CN, SG)
// versus Hant (TW, HK, MO). A tag without a script subtag takes the script its
// region implies, as in CLDR's likely subtags. Other languages ship one catalog
// each, so the region never matters (es-MX and es-ES get es; pt-PT gets pt-br).
const TRADITIONAL_CHINESE_REGIONS = new Set(["tw", "hk", "mo"]);

/**
 * Language and (for Chinese) script of a BCP 47 tag, or null when it is not one.
 * Underscores are not BCP 47 (`zh_TW`) and do not parse; callers reading POSIX
 * locales (`ja_JP.UTF-8`) convert first.
 */
function parseTag(raw: string | null | undefined): ParsedTag | null {
  const parts = raw?.trim().toLowerCase().split("-") ?? [];
  const language = parts[0] ?? "";
  if (!/^[a-z]{2,3}$/.test(language)) return null;
  if (parts.slice(1).some((part) => !/^[a-z0-9]{1,8}$/.test(part))) return null;
  if (language !== "zh") return { language, script: null };
  const subtags = parts.slice(1);
  const script = subtags.find((part) => /^[a-z]{4}$/.test(part));
  if (script) return { language, script };
  const region = subtags.find((part) => /^([a-z]{2}|\d{3})$/.test(part));
  return { language, script: region && TRADITIONAL_CHINESE_REGIONS.has(region) ? "hant" : "hans" };
}

const PARSED_LOCALES: ReadonlyArray<readonly [DisplayLocale, ParsedTag]> = DISPLAY_LOCALES.map(
  (locale) => [locale, parseTag(DISPLAY_LOCALE_INFO[locale].tag) as ParsedTag] as const,
);

/**
 * The display locale a language tag asks for EXACTLY: same language and, for
 * Chinese, same script; the region is otherwise ignored (`en-GB` → en,
 * `zh-SG` → zh-cn, `zh-HK` → zh-tw, `pt-PT` → pt-br). Null when Raft has no
 * catalog for it — this is the strict form the server validates a stored
 * preference with, so it never persists a choice that would silently render
 * something else.
 */
export function normalizeDisplayLocale(
  raw: string | null | undefined,
): DisplayLocale | null {
  const parsed = parseTag(raw);
  if (!parsed) return null;
  const exact = PARSED_LOCALES.find(([, entry]) =>
    entry.language === parsed.language && (entry.script === null || entry.script === parsed.script));
  return exact?.[0] ?? null;
}

/**
 * The best display locale for a language tag when picking one automatically
 * (browser, `?lang=`, Accept-Language, OS locale): the exact match, else
 * another catalog of the same language (a Chinese tag in a script Raft has no
 * catalog for still gets Chinese rather than English), else null.
 */
export function matchDisplayLocale(raw: string | null | undefined): DisplayLocale | null {
  const exact = normalizeDisplayLocale(raw);
  if (exact) return exact;
  const parsed = parseTag(raw);
  if (!parsed) return null;
  return PARSED_LOCALES.find(([, entry]) => entry.language === parsed.language)?.[0] ?? null;
}

/**
 * The display locale for an ordered preference list (navigator.languages, an
 * OS language list): the first tag that matches any catalog.
 */
export function matchDisplayLocaleFromList(
  languages: readonly (string | null | undefined)[] | null | undefined,
): DisplayLocale | null {
  for (const language of languages ?? []) {
    const match = matchDisplayLocale(language);
    if (match) return match;
  }
  return null;
}

/**
 * The display locale for a device's ordered language list when the host asks
 * to follow the device (`?lang=system`, the desktop app's OS languages): the
 * first tag with a catalog wins, except that English listed first still yields
 * to a Chinese language later in the list. That exception predates the other
 * catalogs (Chinese devices commonly list English first) and is kept so those
 * users see no change; a second language such as `es-US` after `en-US` does
 * not override English. English when nothing matches.
 */
export function matchSystemDisplayLocale(
  languages: readonly (string | null | undefined)[] | null | undefined,
): DisplayLocale {
  let englishFirst = false;
  for (const language of languages ?? []) {
    const locale = matchDisplayLocale(language);
    if (!locale) continue;
    if (locale === "en") {
      englishFirst = true;
      continue;
    }
    if (!englishFirst || parseTag(DISPLAY_LOCALE_INFO[locale].tag)?.language === "zh") return locale;
  }
  return "en";
}

/** Type guard: is `value` already a canonical display locale? */
export function isDisplayLocale(value: string | null | undefined): value is DisplayLocale {
  return (DISPLAY_LOCALES as readonly (string | null | undefined)[]).includes(value);
}

/**
 * `[language, script (Chinese only) or null, locale]` per display locale, for a
 * matcher that cannot import this module (an inline page script). It must
 * implement `matchDisplayLocale` over these rules; callers test the parity.
 */
export function displayLocaleMatchRules(): Array<[string, string | null, DisplayLocale]> {
  return PARSED_LOCALES.map(([locale, { language, script }]) => [language, script, locale]);
}
