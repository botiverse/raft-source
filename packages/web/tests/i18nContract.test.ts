import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntl, createIntlCache } from "react-intl";

import { mergedMessages } from "../src/i18n/messages";
import { en } from "../src/i18n/messages/en";
import type { MessageId } from "../src/i18n/messages/en";
import {
  DEFAULT_LOCALE,
  htmlLangForLocale,
  resolveInitialLocale,
  shouldReconcileAccountLocale,
} from "../src/i18n/locale";
import type {
  Locale,
} from "../src/i18n/locale";

// L1 — ICU formatting-rail contract (i18n react-intl foundation).
//
// Pins the message-runtime behavior the migration depends on, exercised through
// the SAME intl instance shape the app builds (mergedMessages + createIntl).
// Each fixture is a rail a hand-rolled homegrown runtime got wrong or couldn't
// do: placeholder interpolation, count-plural selection, currency number
// formatting, date formatting, and English fallback for an un-translated key.
// These lock the rails from day one, before any real plural/currency copy is
// migrated onto them.

const cache = createIntlCache();

function storageWithDisplayLanguage(value: string | null): Storage {
  return {
    getItem: (key: string) => key === "slock.displayLanguage" ? value : null,
  } as Storage;
}

function intlFor(locale: Locale, messages: Record<string, string> = mergedMessages(locale)) {
  return createIntl({ locale, defaultLocale: DEFAULT_LOCALE, messages }, cache);
}

test("plain message: returns the literal string", () => {
  const intl = intlFor("en");
  assert.equal(intl.formatMessage({ id: "common.confirm.cancel" }), "Cancel");
  assert.equal(intlFor("zh-cn").formatMessage({ id: "common.confirm.cancel" }), "取消");
});

test("placeholder: {name} is interpolated", () => {
  assert.equal(
    intlFor("en").formatMessage({ id: "fixtures.placeholder" }, { name: "Ada" }),
    "Hello, Ada!",
  );
  assert.equal(
    intlFor("zh-cn").formatMessage({ id: "fixtures.placeholder" }, { name: "小明" }),
    "你好，小明！",
  );
});

test("plural: count selects the correct English arm; # is the number", () => {
  const intl = intlFor("en");
  assert.equal(intl.formatMessage({ id: "fixtures.plural" }, { count: 1 }), "1 item");
  assert.equal(intl.formatMessage({ id: "fixtures.plural" }, { count: 5 }), "5 items");
});

test("plural: zh-cn has no count distinction (single other arm)", () => {
  const intl = intlFor("zh-cn");
  assert.equal(intl.formatMessage({ id: "fixtures.plural" }, { count: 1 }), "1 项");
  assert.equal(intl.formatMessage({ id: "fixtures.plural" }, { count: 5 }), "5 项");
});

test("currency: ::currency/USD formats with symbol, grouping, and cents", () => {
  const out = intlFor("en").formatMessage({ id: "fixtures.currency" }, { price: 1234.5 });
  // Locale-formatted, not hand-concatenated: symbol, grouped thousands, 2 dp.
  assert.match(out, /\$/, `expected a currency symbol in "${out}"`);
  assert.match(out, /1,234\.50/, `expected grouped 2-dp amount in "${out}"`);
  // The ICU argument must actually be consumed — not left as a literal.
  assert.ok(!out.includes("{price"), `currency arg not formatted: "${out}"`);
});

test("date: medium style formats a Date without leaving the ICU literal", () => {
  const value = new Date(Date.UTC(2026, 6, 16)); // 2026-07-16
  const out = intlFor("en").formatMessage({ id: "fixtures.date" }, { value });
  assert.ok(!out.includes("{value"), `date arg not formatted: "${out}"`);
  assert.match(out, /2026/, `expected the year in "${out}"`);
});

test("fallback: a key missing in the active locale degrades to the en string", () => {
  // Simulate mid-migration: zh-cn has NOT yet translated one id. mergedMessages
  // overlays en as the base, so the active-locale intl still yields English —
  // never the raw id.
  const missingId: MessageId = "common.confirm.cancel";
  const partialZh = { ...en };
  delete (partialZh as Record<string, string>)[missingId];
  const merged = { ...en, ...partialZh }; // en base + a zh map missing one key

  const intl = createIntl({ locale: "zh-cn", defaultLocale: DEFAULT_LOCALE, messages: merged }, cache);
  const out = intl.formatMessage({ id: missingId });
  assert.equal(out, en[missingId], `expected en fallback, got "${out}"`);
  assert.notEqual(out, missingId, "must not render the raw message id");
});

test("SSR / storageless: resolveInitialLocale never throws and returns a supported locale", () => {
  // No window/localStorage, no navigator languages — the server-render path.
  const resolved = resolveInitialLocale({ storage: undefined, languages: undefined });
  assert.equal(resolved, DEFAULT_LOCALE);
});

test("unset display language follows the browser preference", () => {
  assert.equal(resolveInitialLocale({
    storage: storageWithDisplayLanguage(null),
    languages: ["zh-CN", "en"],
  }), "zh-cn");
});

test("explicit English wins over a Chinese browser", () => {
  assert.equal(resolveInitialLocale({
    storage: storageWithDisplayLanguage("en"),
    languages: ["zh-CN"],
  }), "en");
});

test("explicit Chinese wins over an English browser", () => {
  assert.equal(resolveInitialLocale({
    storage: storageWithDisplayLanguage("zh-cn"),
    languages: ["en-US"],
  }), "zh-cn");
});

test("unknown persisted display language is ignored in favor of the browser", () => {
  assert.equal(resolveInitialLocale({
    storage: storageWithDisplayLanguage("xx-not-a-locale"),
    languages: ["zh-CN"],
  }), "zh-cn");
});

test("display locale maps to canonical HTML lang metadata", () => {
  assert.equal(htmlLangForLocale("en"), "en");
  assert.equal(htmlLangForLocale("zh-cn"), "zh-CN");
});

test("account reconciliation waits for a settled authenticated user", () => {
  assert.equal(
    shouldReconcileAccountLocale({ initialized: false, userId: "user-1" }),
    false,
    "an in-flight account cannot overwrite the explicit pre-auth choice",
  );
  assert.equal(
    shouldReconcileAccountLocale({ initialized: true, userId: null }),
    false,
    "signed-out state is not an account preference and must not rewrite storage",
  );
  assert.equal(
    shouldReconcileAccountLocale({ initialized: true, userId: "user-1" }),
    true,
    "a settled authenticated account is authoritative even when its preference is unset",
  );
});
