import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { DISPLAY_LOCALES } from "@botiverse/raft-shared";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// ActionCard migration. The file had ZERO formatMessage calls before this and
// establishes the `actionCard.*` namespace.
//
// The scanner reported 38 candidates for this file. That number was LOW, and the
// misses were structural rather than incidental — worth recording, because the
// same shapes exist elsewhere:
//   * all 8 `actionVerb()` button labels — `return "Create channel";` in a switch
//     is not JSX, not a prop, not a template, so nothing matches it;
//   * the whole `ResultLink` block (7 more sentences);
//   * `Committed by`;
//   * `"private" | "public"` interpolated as an ADJECTIVE — a raw union value
//     used as copy, which no string scanner can ever see.
// So this file pins behaviour, not scanner silence.
//
// The typed card that rendered these ids is gone: every card renders from its
// spec (#proj-apps:#40 P9). The web catalogs stay the source of the cards'
// copy, and the shared ACTION_CARD_MESSAGES table the spec's Msgs carry
// mirrors them by id (actionCardMessages.parity test), so the ids pinned here
// are the `source` of its entries. The ids only the typed card used went in P11
// (actionCard.verb.updateApp, actionCard.result.channelMembers).

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

/** id -> the exact English the pre-migration source rendered. */
const VERBS: Record<string, string> = {
  "actionCard.verb.createChannel": "Create channel",
  "actionCard.verb.createAgent": "Create agent",
  "actionCard.verb.addMembers": "Add members",
  "actionCard.verb.approveLogin": "Approve login",
  "actionCard.verb.installApp": "Install app",
  // Apps v4 (stdrc): the card that makes an App says Create Raft App, not Register.
  "actionCard.verb.registerApp": "Create Raft app",
  "actionCard.verb.recoverOwner": "Recover owner",
  "actionCard.verb.submitFeedback": "Submit feedback",
};

test("every action verb renders the label the old switch returned", () => {
  for (const [id, english] of Object.entries(VERBS)) {
    assert.equal(fmt("en", id), english, `${id}: English changed during the lift`);
    assert.notEqual(zh[id], undefined, `${id}: missing zh`);
  }
});

test("the channel-visibility adjective is a message per arm, not an interpolated value", () => {
  // Was `Create {vis} channel` with vis = "private" | "public" — a union VALUE
  // rendered as an English adjective. Untranslatable and unscannable.
  assert.equal(fmt("en", "actionCard.title.createPrivateChannel", { name: "x", n: (c: string) => c }),
    "Create private channel #x");
  assert.equal(fmt("en", "actionCard.title.createPublicChannel", { name: "x", n: (c: string) => c }),
    "Create public channel #x");
  assert.notEqual(
    zh["actionCard.title.createPrivateChannel"],
    zh["actionCard.title.createPublicChannel"],
    "the two visibilities must stay distinct in zh",
  );
});

test("register vs update is two messages, not an interpolated mode value", () => {
  assert.equal(
    fmt("en", "actionCard.result.appRegistered", { client: "C", clientKey: "k" }),
    "C created (k)",
  );
  assert.equal(
    fmt("en", "actionCard.result.appUpdated", { client: "C", clientKey: "k" }),
    "C updated (k)",
  );
});

test("every actionCard id exists in BOTH catalogs", () => {
  const enIds = Object.keys(en).filter((k) => k.startsWith("actionCard."));
  assert.ok(enIds.length >= 45, `expected the full namespace, got ${enIds.length}`);
  for (const id of enIds) {
    assert.notEqual(zh[id], undefined, `${id} has no Chinese`);
    assert.notEqual(zh[id], "", `${id} has empty Chinese`);
  }
});

test("a card names people and agents by display name: no actionCard copy writes an @, in any locale", async () => {
  for (const locale of DISPLAY_LOCALES) {
    const [catalog] = Object.values(await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Record<string, string>>);
    for (const [id, text] of Object.entries(catalog!)) {
      if (id.startsWith("actionCard.")) assert.equal(text.includes("@{"), false, `${locale} ${id}: ${text}`);
    }
  }
});
