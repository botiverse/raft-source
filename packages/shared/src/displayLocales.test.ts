import assert from "node:assert/strict";

import {
  DISPLAY_LOCALE_INFO,
  DISPLAY_LOCALES,
  displayLocaleTag,
  isDisplayLocale,
  matchDisplayLocale,
  matchDisplayLocaleFromList,
  matchSystemDisplayLocale,
  normalizeDisplayLocale,
} from "./displayLocales";
import { normalizeTranslationLanguageCode } from "./translationLanguages";

test("DISPLAY_LOCALES is exactly the shipped-catalog set", () => {
  assert.deepEqual([...DISPLAY_LOCALES].sort(), ["en", "es", "ja", "ko", "pt-br", "ru", "zh-cn", "zh-tw"]);
  assert.deepEqual(Object.keys(DISPLAY_LOCALE_INFO).sort(), [...DISPLAY_LOCALES].sort());
});

test("the picker order is native names in Unicode root collation", () => {
  // A new locale has exactly one place to go; nobody's language is "first".
  const collator = new Intl.Collator("und");
  const byNativeName = [...DISPLAY_LOCALES].sort((a, b) =>
    collator.compare(DISPLAY_LOCALE_INFO[a].nativeName, DISPLAY_LOCALE_INFO[b].nativeName));
  assert.deepEqual([...DISPLAY_LOCALES], byNativeName);
});

test("every display locale is also a message-translation language with the same code", () => {
  for (const locale of DISPLAY_LOCALES) {
    assert.equal(normalizeTranslationLanguageCode(locale), locale, locale);
  }
});

test("each locale's tag round-trips through the strict normalizer", () => {
  for (const locale of DISPLAY_LOCALES) {
    assert.equal(normalizeDisplayLocale(displayLocaleTag(locale)), locale, locale);
    assert.equal(normalizeDisplayLocale(locale), locale, locale);
  }
});

test("normalizeDisplayLocale ignores the region within a shipped language", () => {
  for (const tag of ["en", "EN", " en ", "en-US", "en-GB", "en-us", "en-AU"]) {
    assert.equal(normalizeDisplayLocale(tag), "en", tag);
  }
  for (const tag of ["ja", "JA", "ja-JP", "ja-jp"]) {
    assert.equal(normalizeDisplayLocale(tag), "ja", tag);
  }
  for (const tag of ["ko", "KO", "ko-KR", "ko-kr"]) {
    assert.equal(normalizeDisplayLocale(tag), "ko", tag);
  }
  for (const tag of ["es", "es-ES", "es-MX", "es-419", "es-us"]) {
    assert.equal(normalizeDisplayLocale(tag), "es", tag);
  }
  // One Portuguese catalog, Brazilian: a European Portuguese reader gets it too.
  for (const tag of ["pt", "pt-BR", "pt-br", "pt-PT", "pt-AO"]) {
    assert.equal(normalizeDisplayLocale(tag), "pt-br", tag);
  }
  // One Russian catalog for every region.
  for (const tag of ["ru", "ru-RU", "ru-KZ", "ru-BY", "RU-ua"]) {
    assert.equal(normalizeDisplayLocale(tag), "ru", tag);
  }
  // Like every non-Chinese language, Russian listed after English does not override it.
  assert.equal(matchSystemDisplayLocale(["en-US", "ru-RU"]), "en");
  assert.equal(matchSystemDisplayLocale(["ru-RU", "en-US"]), "ru");
});

test("normalizeDisplayLocale matches Chinese by script", () => {
  for (const tag of ["zh-cn", "zh-CN", "zh", "zh-Hans", "zh-hans", "zh-Hans-CN", "zh-SG", "zh-Hans-HK"]) {
    assert.equal(normalizeDisplayLocale(tag), "zh-cn", tag);
  }
  // The region implies the script when there is no script subtag.
  for (const tag of ["zh-TW", "zh-tw", "zh-Hant", "zh-hant-hk", "zh-HK", "zh-MO", "zh-Hant-CN"]) {
    assert.equal(normalizeDisplayLocale(tag), "zh-tw", tag);
  }
  // A script Raft has no catalog for is not stored as either.
  assert.equal(normalizeDisplayLocale("zh-Latn"), null);
});

test("normalizeDisplayLocale rejects languages without a shipped catalog and non-tags", () => {
  for (const tag of ["fr", "fr-FR", "jav", "kok", "ptb", "de", "xx", "", "zh_TW", "ja_JP", "pt_BR", "en--US"]) {
    assert.equal(normalizeDisplayLocale(tag), null, tag);
  }
  assert.equal(normalizeDisplayLocale(null), null);
  assert.equal(normalizeDisplayLocale(undefined), null);
});

test("matchDisplayLocale falls back within the language when picking automatically", () => {
  assert.equal(matchDisplayLocale("zh-TW"), "zh-tw");
  assert.equal(matchDisplayLocale("zh-Hant-HK"), "zh-tw");
  // A Chinese script with no catalog still gets Chinese rather than English.
  assert.equal(matchDisplayLocale("zh-Latn"), "zh-cn");
  assert.equal(matchDisplayLocale("ja-JP"), "ja");
  assert.equal(matchDisplayLocale("es-AR"), "es");
  assert.equal(matchDisplayLocale("pt-PT"), "pt-br");
  assert.equal(matchDisplayLocale("fr-FR"), null);
  assert.equal(matchDisplayLocale("zh_TW"), null, "not BCP 47");
});

test("matchDisplayLocaleFromList takes the first tag with a catalog", () => {
  assert.equal(matchDisplayLocaleFromList(["fr-FR", "ko-KR", "en"]), "ko");
  assert.equal(matchDisplayLocaleFromList(["en-US", "ja"]), "en");
  assert.equal(matchDisplayLocaleFromList(["fr", "de"]), null);
  assert.equal(matchDisplayLocaleFromList(undefined), null);
});

test("isDisplayLocale only accepts canonical codes", () => {
  for (const locale of DISPLAY_LOCALES) assert.equal(isDisplayLocale(locale), true, locale);
  assert.equal(isDisplayLocale("zh-CN"), false); // a tag, not the code (normalize first)
  assert.equal(isDisplayLocale("ja-JP"), false);
  assert.equal(isDisplayLocale("pt-BR"), false);
  assert.equal(isDisplayLocale("fr"), false);
  assert.equal(isDisplayLocale(null), false);
});

test("matchSystemDisplayLocale: first match, but English first yields to a later Chinese language", () => {
  // A second language does not override English…
  assert.equal(matchSystemDisplayLocale(["en-US", "es-US"]), "en");
  assert.equal(matchSystemDisplayLocale(["en-US", "ko-KR"]), "en");
  assert.equal(matchSystemDisplayLocale(["en-GB", "pt-PT", "ja-JP"]), "en");
  // …except Chinese, as on Chinese devices that list English first (unchanged behaviour).
  assert.equal(matchSystemDisplayLocale(["en-US", "zh-CN"]), "zh-cn");
  assert.equal(matchSystemDisplayLocale(["en-US", "es-US", "zh-Hant-TW"]), "zh-tw");
  // Otherwise the first language with a catalog wins.
  assert.equal(matchSystemDisplayLocale(["es-MX", "en-US"]), "es");
  assert.equal(matchSystemDisplayLocale(["fr-FR", "pt-BR", "zh-CN"]), "pt-br");
  assert.equal(matchSystemDisplayLocale(["ja-JP", "zh-Hans-CN"]), "ja");
  assert.equal(matchSystemDisplayLocale(["fr-FR", "de"]), "en");
  assert.equal(matchSystemDisplayLocale([]), "en");
  assert.equal(matchSystemDisplayLocale(undefined), "en");
});
