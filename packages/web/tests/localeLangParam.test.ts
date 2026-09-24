import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  DISPLAY_LOCALE_STORAGE_KEY,
  resolveInitialLocale,
  resolveLangParamLocale,
} from "../src/i18n/locale";

// `?lang=` support for the app's display locale.
//
// The Android app embeds settings (notably the billing flow) in a WebView and
// passes the device language as `?lang=` — see #4602 "localize embedded billing
// flow", which is why a billing-only resolver existed in utils/billingI18n.ts.
// That surface is moving to the shared catalog, so the parameter has to be
// honoured by the app's own locale resolution or the embedded flow silently
// falls back to English on a Chinese device (fresh WebView => empty storage,
// user record not loaded yet).
//
// These cases mirror the billing resolver's semantics ONE FOR ONE. If they
// drift, an embedded host sees a different language after the migration than
// before it — the exact regression this file exists to prevent.
//
// billingI18n.ts is gone now; its behaviour survives here as a frozen corpus.

function fakeStorage(value?: string): Storage {
  const map = new Map<string, string>();
  if (value !== undefined) map.set(DISPLAY_LOCALE_STORAGE_KEY, value);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

test("an explicit lang parameter selects the locale", () => {
  assert.equal(resolveLangParamLocale("?lang=zh", []), "zh-cn");
  assert.equal(resolveLangParamLocale("?lang=zh-CN", []), "zh-cn");
  assert.equal(resolveLangParamLocale("?lang=zh-Hans-CN", []), "zh-cn");
  assert.equal(resolveLangParamLocale("?lang=en", []), "en");
  assert.equal(resolveLangParamLocale("?lang=fr", []), "en", "unsupported falls back to English");
});

test("lang=system follows the browser languages, and only then", () => {
  // The host explicitly asked to follow the device language. This remains
  // distinct from the implicit browser fallback because it outranks storage.
  assert.equal(resolveLangParamLocale("?lang=system", ["zh-CN", "en"]), "zh-cn");
  assert.equal(resolveLangParamLocale("?lang=system", ["en-US"]), "en");
  assert.equal(resolveLangParamLocale("?lang=system", []), "en");
  assert.equal(resolveInitialLocale({ languages: ["zh-CN"] }), "zh-cn",
    "a Chinese browser selects zh-cn when no explicit choice exists");
});

test("an absent or blank lang parameter resolves to null, not a locale", () => {
  // null (not "en") matters: it is what lets storage still win below.
  assert.equal(resolveLangParamLocale("", []), null);
  assert.equal(resolveLangParamLocale(undefined, []), null);
  assert.equal(resolveLangParamLocale("?other=1", []), null);
  assert.equal(resolveLangParamLocale("?lang=", []), null);
  assert.equal(resolveLangParamLocale("?lang=%20%20", []), null, "whitespace-only is absent");
});

test("lang wins over cached storage, and storage wins when lang is absent", () => {
  assert.equal(
    resolveInitialLocale({ storage: fakeStorage("en"), search: "?lang=zh" }),
    "zh-cn",
    "the embedding host's per-navigation instruction wins over a stale cache",
  );
  assert.equal(
    resolveInitialLocale({ storage: fakeStorage("zh-cn"), search: "" }),
    "zh-cn",
    "storage still decides when no lang is passed",
  );
  assert.equal(
    resolveInitialLocale({ storage: fakeStorage(), languages: ["zh-Hans-SG"], search: "" }),
    "zh-cn",
    "browser preference decides only when lang and storage are absent",
  );
  assert.equal(
    resolveInitialLocale({ storage: fakeStorage(), languages: ["fr-FR"], search: "" }),
    DEFAULT_LOCALE,
    "unsupported browser languages fall back to English",
  );
});

/**
 * FROZEN parity corpus: every (search, navigator.languages) pair the billing
 * resolver was exercised with, and the locale IT returned, captured from
 * src/utils/billingI18n.ts at the commit that deleted it.
 *
 * This test used to call resolveBillingUiLocale() live and require agreement.
 * That is the stronger form — comparing implementations cannot drift the way a
 * hand-mirrored table can — but it is only available while both exist. Freezing
 * the outputs is what carries the guarantee past the delete: an Android host
 * must see the same language after the migration as before it, and these 60
 * rows are the record of "before".
 *
 * The corpus deliberately includes the shapes an Android host emits
 * (`zh-Hans-CN`, `system`) and the ones that trip naive parsing (casing,
 * padding, a bare `zh`, a repeated key, `zh_TW` with an underscore).
 */
const BILLING_RESOLVER_PARITY: ReadonlyArray<readonly [string, readonly string[], "zh-CN" | "en"]> = [
  ["?lang=zh", [], "zh-CN"],
  ["?lang=zh", ["en-US"], "zh-CN"],
  ["?lang=zh", ["zh-CN", "en"], "zh-CN"],
  ["?lang=zh", ["zh"], "zh-CN"],
  ["?lang=zh", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=ZH", [], "zh-CN"],
  ["?lang=ZH", ["en-US"], "zh-CN"],
  ["?lang=ZH", ["zh-CN", "en"], "zh-CN"],
  ["?lang=ZH", ["zh"], "zh-CN"],
  ["?lang=ZH", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=zh-CN", [], "zh-CN"],
  ["?lang=zh-CN", ["en-US"], "zh-CN"],
  ["?lang=zh-CN", ["zh-CN", "en"], "zh-CN"],
  ["?lang=zh-CN", ["zh"], "zh-CN"],
  ["?lang=zh-CN", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=zh-Hans-CN", [], "zh-CN"],
  ["?lang=zh-Hans-CN", ["en-US"], "zh-CN"],
  ["?lang=zh-Hans-CN", ["zh-CN", "en"], "zh-CN"],
  ["?lang=zh-Hans-CN", ["zh"], "zh-CN"],
  ["?lang=zh-Hans-CN", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=zh_TW", [], "en"],
  ["?lang=zh_TW", ["en-US"], "en"],
  ["?lang=zh_TW", ["zh-CN", "en"], "en"],
  ["?lang=zh_TW", ["zh"], "en"],
  ["?lang=zh_TW", ["fr-FR", "zh-TW"], "en"],
  ["?lang=en", [], "en"],
  ["?lang=en", ["en-US"], "en"],
  ["?lang=en", ["zh-CN", "en"], "en"],
  ["?lang=en", ["zh"], "en"],
  ["?lang=en", ["fr-FR", "zh-TW"], "en"],
  ["?lang=en-GB", [], "en"],
  ["?lang=en-GB", ["en-US"], "en"],
  ["?lang=en-GB", ["zh-CN", "en"], "en"],
  ["?lang=en-GB", ["zh"], "en"],
  ["?lang=en-GB", ["fr-FR", "zh-TW"], "en"],
  ["?lang=fr", [], "en"],
  ["?lang=fr", ["en-US"], "en"],
  ["?lang=fr", ["zh-CN", "en"], "en"],
  ["?lang=fr", ["zh"], "en"],
  ["?lang=fr", ["fr-FR", "zh-TW"], "en"],
  ["?lang=system", [], "en"],
  ["?lang=system", ["en-US"], "en"],
  ["?lang=system", ["zh-CN", "en"], "zh-CN"],
  ["?lang=system", ["zh"], "zh-CN"],
  ["?lang=system", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=%20zh%20", [], "zh-CN"],
  ["?lang=%20zh%20", ["en-US"], "zh-CN"],
  ["?lang=%20zh%20", ["zh-CN", "en"], "zh-CN"],
  ["?lang=%20zh%20", ["zh"], "zh-CN"],
  ["?lang=%20zh%20", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?foo=1&lang=zh", [], "zh-CN"],
  ["?foo=1&lang=zh", ["en-US"], "zh-CN"],
  ["?foo=1&lang=zh", ["zh-CN", "en"], "zh-CN"],
  ["?foo=1&lang=zh", ["zh"], "zh-CN"],
  ["?foo=1&lang=zh", ["fr-FR", "zh-TW"], "zh-CN"],
  ["?lang=zh&lang=en", [], "zh-CN"],
  ["?lang=zh&lang=en", ["en-US"], "zh-CN"],
  ["?lang=zh&lang=en", ["zh-CN", "en"], "zh-CN"],
  ["?lang=zh&lang=en", ["zh"], "zh-CN"],
  ["?lang=zh&lang=en", ["fr-FR", "zh-TW"], "zh-CN"],
];

test("matches the billing resolver one-for-one wherever lang is present", () => {
  assert.equal(BILLING_RESOLVER_PARITY.length, 60, "the frozen corpus lost rows");
  for (const [search, languages, billing] of BILLING_RESOLVER_PARITY) {
    assert.equal(
      resolveLangParamLocale(search, languages),
      billing === "zh-CN" ? "zh-cn" : "en",
      `divergence for ${search} with languages [${languages.join(",")}]`,
    );
  }
});

test("the one deliberate divergence: no lang parameter", () => {
  // With no `lang`, the billing resolver returns "en" unconditionally — billing
  // copy today ignores the user's display-language setting entirely. The app
  // resolver returns null so storage can decide, which is why a zh-cn user will
  // start seeing Chinese billing copy after the migration.
  //
  // That is a real user-visible behaviour change, raised with @artin rather than
  // slipped in: it is pinned here so it stays a decision, not an accident.
  // resolveBillingUiLocale("", ["zh-CN"]) returned "en" — frozen, same as above.
  assert.equal(resolveLangParamLocale("", ["zh-CN"]), null);
  assert.equal(
    resolveInitialLocale({ storage: fakeStorage("zh-cn"), search: "" }),
    "zh-cn",
    "the stored display language now reaches billing too",
  );
});

test("resolving from lang does not write to storage", () => {
  // A single embedded visit must not silently rewrite the user's own setting.
  const storage = fakeStorage();
  resolveInitialLocale({ storage, search: "?lang=zh", languages: [] });
  assert.equal(storage.getItem(DISPLAY_LOCALE_STORAGE_KEY), null, "lang must not persist");
});
