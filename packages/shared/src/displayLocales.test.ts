import { test } from "node:test";
import assert from "node:assert/strict";

import { DISPLAY_LOCALES, isDisplayLocale, normalizeDisplayLocale } from "./displayLocales.js";

test("DISPLAY_LOCALES is exactly the shipped-catalog set", () => {
  assert.deepEqual([...DISPLAY_LOCALES], ["en", "zh-cn"]);
});

test("normalizeDisplayLocale collapses English regions to en", () => {
  for (const tag of ["en", "EN", " en ", "en-US", "en-GB", "en-us", "en-AU"]) {
    assert.equal(normalizeDisplayLocale(tag), "en", tag);
  }
});

test("normalizeDisplayLocale collapses Simplified Chinese variants to zh-cn", () => {
  for (const tag of ["zh-cn", "zh-CN", "zh", "zh-Hans", "zh-hans", "zh-Hans-CN"]) {
    assert.equal(normalizeDisplayLocale(tag), "zh-cn", tag);
  }
});

test("normalizeDisplayLocale rejects languages/scripts without a shipped catalog", () => {
  // The exact class of bug: the translation taxonomy would ACCEPT these, but we
  // cannot render them, so a display preference must reject (not silently store).
  for (const tag of ["fr", "fr-FR", "zh-tw", "zh-TW", "zh-Hant", "zh-hant-hk", "ja", "ko", "pt-br", "de", "xx", ""]) {
    assert.equal(normalizeDisplayLocale(tag), null, tag);
  }
  assert.equal(normalizeDisplayLocale(null), null);
  assert.equal(normalizeDisplayLocale(undefined), null);
});

test("isDisplayLocale only accepts canonical codes", () => {
  assert.equal(isDisplayLocale("en"), true);
  assert.equal(isDisplayLocale("zh-cn"), true);
  assert.equal(isDisplayLocale("zh-CN"), false); // not canonical (normalize first)
  assert.equal(isDisplayLocale("fr"), false);
  assert.equal(isDisplayLocale(null), false);
});
