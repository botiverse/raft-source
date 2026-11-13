import assert from "node:assert/strict";

import { DISPLAY_LOCALES } from "@botiverse/raft-shared";
import type { DisplayLocale } from "@botiverse/raft-shared";
import { en as enMessages } from "../src/i18n/messages/en";

// A label never ends with an ellipsis, in any language (Raft DS
// design/content/writing.md; Artea, 2026-11-08): Decline, not Decline…; 拒绝,
// not 拒绝…. A button or menu item that opens a dialog says the action it leads
// to. Only progress text (Loading…, {first} is typing…) and a field's
// placeholder (Search members…) keep one.
//
// A message's English decides what it is: progress text says what is going
// on with a word in -ing that starts its last sentence (Loading…, Setup
// complete. Returning to the app…) or follows is/are/still ({first} is
// typing…, Still updating…); a placeholder's id says so, or is listed below.
// A label with an -ing noun (Edit mapping…) is not progress.

const en = enMessages as Record<string, string>;

/** Placeholders whose ids don't say "placeholder". */
const PLACEHOLDER_IDS = new Set([
  "settings.slackBridge.searchChannels",
  "settings.connectedApps.searchApps",
  // The shortcut recorder's empty state, a prompt in the field (zh: 按下新组合…).
  "keyboardShortcuts.edit.recorderEmpty",
]);

const endsWithEllipsis = (value: string) => /(…|\.\.\.)\s*$/.test(value);

function isProgress(english: string): boolean {
  const sentence = english.replace(/\{[^{}]*\}/g, " ").split(/[.!?]\s+/).pop() ?? "";
  const words = sentence.match(/[A-Za-z]+/g) ?? [];
  const ing = (word: string | undefined) => word !== undefined && word.length > 4 && /ing$/i.test(word);
  return ing(words[0]) || words.some((word, i) => /^(is|are|still)$/i.test(word) && ing(words[i + 1]));
}

const mayEndWithEllipsis = (id: string) =>
  /placeholder/i.test(id) || PLACEHOLDER_IDS.has(id) || (en[id] !== undefined && isProgress(en[id]));

async function catalog(locale: DisplayLocale): Promise<Partial<Record<string, string>>> {
  const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Partial<Record<string, string>>>;
  const [messages] = Object.values(module);
  return messages;
}

for (const locale of DISPLAY_LOCALES) {
  test(`${locale}: only progress text and placeholders end with an ellipsis`, async () => {
    const messages = await catalog(locale);
    const offenders = Object.entries(messages)
      .filter(([id, value]) => value !== undefined && endsWithEllipsis(value) && !mayEndWithEllipsis(id))
      .map(([id, value]) => `${id}: ${value}`);
    assert.deepEqual(offenders, []);
  });
}

test("progress text and placeholders are told apart from labels", () => {
  assert.ok(isProgress("Loading…"));
  assert.ok(isProgress("{first} and {second} are typing…"));
  assert.ok(isProgress("Setting up your chat…"));
  assert.ok(isProgress("Setup complete. Returning to the app…"));
  assert.ok(isProgress("Still updating…"));
  assert.ok(!isProgress("Edit settings…"));
  assert.ok(!isProgress("Edit mapping…"));
  assert.ok(!isProgress("Rename Artifact…"));
  assert.ok(!mayEndWithEllipsis("artifacts.menu.rename"));
  assert.ok(mayEndWithEllipsis("channel.membersPage.searchPlaceholder"));
});
