import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTranslationLanguageCode } from "./translationLanguages.js";

test("normalizeTranslationLanguageCode canonicalizes browser locales to supported targets", () => {
  assert.equal(normalizeTranslationLanguageCode("en-US"), "en");
  assert.equal(normalizeTranslationLanguageCode("EN-gb"), "en");
  assert.equal(normalizeTranslationLanguageCode("zh-CN"), "zh-cn");
  assert.equal(normalizeTranslationLanguageCode("zh-TW"), "zh-tw");
  assert.equal(normalizeTranslationLanguageCode("zh"), "zh-cn");
  assert.equal(normalizeTranslationLanguageCode("zh-Hans"), "zh-cn");
  assert.equal(normalizeTranslationLanguageCode("zh-Hant"), "zh-tw");
  assert.equal(normalizeTranslationLanguageCode("pt-BR"), "pt-br");
  assert.equal(normalizeTranslationLanguageCode("fr-FR"), "fr");
  assert.equal(normalizeTranslationLanguageCode("it-IT"), "it");
  assert.equal(normalizeTranslationLanguageCode("not-a-language"), null);
});
