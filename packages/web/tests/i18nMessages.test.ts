import assert from "node:assert/strict";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import type { Locale } from "../src/i18n/locale";
import { SUPPORTED_LOCALES } from "../src/i18n/locale";

// Every shipped catalog of the locale registry, imported directly by file name
// (the app loads the non-English ones on demand).
const MESSAGES = Object.fromEntries(await Promise.all(SUPPORTED_LOCALES.map(async (locale) => {
  const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Record<string, string>>;
  return [locale, Object.values(module)[0]] as const;
}))) as Record<Locale, Record<string, string>>;

// L1 — message-catalog key sets (i18n react-intl foundation).
//
// No catalog may have an id en lacks (dead copy / a typo'd id no component
// reads). zh-cn must also have every en id: it is typed
// `Record<MessageId, string>` (a missing key is a compile error) and this test is
// the CI backstop. The other catalogs are `Partial` by decision (stdrc,
// 2026-10-21): an id they lack renders the English until it is backfilled, so
// new English copy never needs six translations in the same PR.

/** Catalogs that must hold every en id. */
const COMPLETE_LOCALES: readonly Locale[] = ["en", "zh-cn"];

const enKeys = Object.keys(en).sort();
const currentBatchPrefixes = [
  "activity.",
  "layout.systemNotifications.",
  "message.notificationActivation.",
] as const;

function collectPlaceholders(elements: MessageFormatElement[], result = new Set<string>()) {
  for (const element of elements) {
    if (
      element.type === TYPE.argument ||
      element.type === TYPE.number ||
      element.type === TYPE.date ||
      element.type === TYPE.time ||
      element.type === TYPE.select ||
      element.type === TYPE.plural ||
      element.type === TYPE.tag
    ) {
      result.add(element.value);
    }

    if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options)) {
        collectPlaceholders(option.value, result);
      }
    }

    if (element.type === TYPE.tag) {
      collectPlaceholders(element.children, result);
    }
  }

  return [...result].sort();
}

function placeholders(message: string) {
  return collectPlaceholders(parse(message));
}

test("every supported locale has a catalog", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(MESSAGES[locale], `no catalog for locale "${locale}"`);
  }
});

test("en is the source-of-truth key set (non-empty, unique)", () => {
  assert.ok(enKeys.length > 0, "en catalog must not be empty");
  assert.equal(new Set(enKeys).size, enKeys.length, "en has duplicate keys");
});

for (const locale of SUPPORTED_LOCALES) {
  const complete = COMPLETE_LOCALES.includes(locale);
  test(`locale "${locale}" has ${complete ? "exactly en's ids" : "no id en lacks"}`, () => {
    const localeKeys = Object.keys(MESSAGES[locale]).sort();

    const missing = enKeys.filter((k) => !(k in MESSAGES[locale]));
    const extra = localeKeys.filter((k) => !(k in en));

    if (complete) {
      assert.deepEqual(
        missing,
        [],
        `locale "${locale}" is MISSING keys present in en: ${missing.join(", ")}`,
      );
    }
    assert.deepEqual(
      extra,
      [],
      `locale "${locale}" has EXTRA keys not present in en: ${extra.join(", ")}`,
    );
  });
}

for (const locale of SUPPORTED_LOCALES.filter((code) => code !== "en")) {
  test(`${locale} values are all non-empty strings`, () => {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.equal(typeof value, "string", `${locale} "${key}" is not a string`);
      assert.ok(value.length > 0, `${locale} "${key}" is an empty string`);
    }
  });
}

test("Activity and notification batch messages parse and keep placeholder parity", () => {
  const ids = enKeys.filter((id) => currentBatchPrefixes.some((prefix) => id.startsWith(prefix)));

  // Check the actual catalog, not an editable count of past additions/removals.
  assert.ok(ids.length > 0, "Activity and notification prefixes must select messages");

  for (const id of ids) {
    assert.deepEqual(
      placeholders(zhCn[id]),
      placeholders(en[id]),
      `${id} placeholders differ between en and zh-cn`,
    );
  }
});

test("Agent and machine Lane B messages parse and keep placeholder parity", () => {
  const laneBPrefixes = [
    "agent.detail.",
    "agent.dmConversation.",
    "agent.mcp.",
    "agent.reminders.",
    "agent.reportIssue.",
    "agent.runtimeConfig.",
    "agent.scopes.",
    "agent.skills.",
    "agent.workspace.",
    "agent.avatar.",
    "agent.channelMembers.",
    "agent.create.",
    "machine.",
  ] as const;
  const ids = enKeys.filter((id) => laneBPrefixes.some((prefix) => id.startsWith(prefix)));

  assert.ok(ids.length > 0, "Lane B should include agent/machine message ids");

  for (const id of ids) {
    assert.deepEqual(
      placeholders(zhCn[id]),
      placeholders(en[id]),
      `${id} placeholders differ between en and zh-cn`,
    );
  }
});
