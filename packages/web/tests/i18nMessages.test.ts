import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { MESSAGES } from "../src/i18n/messages";
import { SUPPORTED_LOCALES } from "../src/i18n/locale";

// L1 — message-catalog completeness gate (i18n react-intl foundation).
//
// The contract every locale catalog must uphold: its key set is EXACTLY equal to
// the en source-of-truth key set — no missing keys (would silently fall back to
// English at runtime and ship an untranslated string) and no extra keys (dead
// copy / a typo'd id that no component reads). zh-cn is typed
// `Record<MessageId, string>`, so a MISSING key is already a compile error; this
// test is the CI backstop that also catches EXTRA keys and covers every locale
// in SUPPORTED_LOCALES uniformly as more are added.

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

test("every supported locale has a message map in MESSAGES", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(MESSAGES[locale], `MESSAGES is missing an entry for locale "${locale}"`);
  }
});

test("en is the source-of-truth key set (non-empty, unique)", () => {
  assert.ok(enKeys.length > 0, "en catalog must not be empty");
  assert.equal(new Set(enKeys).size, enKeys.length, "en has duplicate keys");
});

for (const locale of SUPPORTED_LOCALES) {
  test(`locale "${locale}" key set is exactly equal to en`, () => {
    const localeKeys = Object.keys(MESSAGES[locale]).sort();

    const missing = enKeys.filter((k) => !(k in MESSAGES[locale]));
    const extra = localeKeys.filter((k) => !(k in en));

    assert.deepEqual(
      missing,
      [],
      `locale "${locale}" is MISSING keys present in en: ${missing.join(", ")}`,
    );
    assert.deepEqual(
      extra,
      [],
      `locale "${locale}" has EXTRA keys not present in en: ${extra.join(", ")}`,
    );
  });
}

test("zh-cn values are all non-empty strings", () => {
  for (const [key, value] of Object.entries(zhCn)) {
    assert.equal(typeof value, "string", `zh-cn "${key}" is not a string`);
    assert.ok(value.length > 0, `zh-cn "${key}" is an empty string`);
  }
});

test("Connected Apps destructive-card copy is complete in en and zh-cn", () => {
  assert.equal(
    en["settings.connectedApps.deleteAppDescription"],
    "Permanently deletes this app registration and its current credentials.",
  );
  assert.equal(
    zhCn["settings.connectedApps.deleteAppDescription"],
    "永久删除此应用注册及其当前凭据。",
  );
});

test("Activity and notification batch messages parse and keep placeholder parity", () => {
  const ids = enKeys.filter((id) => currentBatchPrefixes.some((prefix) => id.startsWith(prefix)));

  // 88 after the current Activity sidebar added DM/channel, saved/done, and
  // header search/sort copy without reviving the retired Activity v2 message set.
  // An intentional id removal/addition updates this count with the reason;
  // silent drift still goes red.
  assert.equal(ids.length, 88, "current i18n batch should cover exactly the known 88 message ids");

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
