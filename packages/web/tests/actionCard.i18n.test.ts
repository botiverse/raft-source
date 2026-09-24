import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// ActionCard migration. The file had ZERO formatMessage calls before this and
// establishes the `actionCard.*` namespace.
//
// The scanner reported 38 candidates for this file. That number was LOW, and the
// misses were structural rather than incidental — worth recording, because the
// same shapes exist elsewhere:
//   * all 8 `actionVerb()` button labels — `return "Create Channel";` in a switch
//     is not JSX, not a prop, not a template, so nothing matches it;
//   * the whole `ResultLink` block (7 more sentences);
//   * `Committed by`;
//   * `"private" | "public"` interpolated as an ADJECTIVE — a raw union value
//     used as copy, which no string scanner can ever see.
// So this file pins behaviour, not scanner silence.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

const RAW_SRC = readFileSync(
  resolve(import.meta.dirname, "../src/components/actions/ActionCard.tsx"),
  "utf8",
);

/**
 * Source with comments stripped, for the negative guards below.
 *
 * This is not tidiness — the first version of this file FAILED because a
 * `doesNotMatch(/count === 1 \? "" : "s"/)` guard matched the comment I wrote
 * explaining that the hand-rolled plural had been REMOVED. A negative guard that
 * reads comments reports the documentation of a fix as the bug, and the obvious
 * "fix" is to delete the explanation — losing the comment that tells the next
 * person why the message is shaped this way.
 *
 * Only whole-line and block comments are removed; a trailing `//` is left alone
 * so URLs inside string literals survive.
 */
const SRC = RAW_SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

/** id -> the exact English the pre-migration source rendered. */
const VERBS: Record<string, string> = {
  "actionCard.verb.createChannel": "Create Channel",
  "actionCard.verb.createAgent": "Create Agent",
  "actionCard.verb.addMembers": "Add Members",
  "actionCard.verb.approveLogin": "Approve Login",
  "actionCard.verb.installApp": "Install App",
  "actionCard.verb.registerApp": "Register App",
  "actionCard.verb.updateApp": "Update App",
  "actionCard.verb.recoverOwner": "Recover Owner",
};

test("every action verb renders the label the old switch returned", () => {
  for (const [id, english] of Object.entries(VERBS)) {
    assert.equal(fmt("en", id), english, `${id}: English changed during the lift`);
    assert.notEqual(zh[id], undefined, `${id}: missing zh`);
  }
});

test("actionVerb returns ids and the CALLER formats them", () => {
  // The MessageId shape-change trap: if actionVerb formatted internally, or the
  // call site rendered the id bare, typecheck stays green and the button shows
  // the literal "actionCard.verb.createChannel".
  assert.match(SRC, /function actionVerb\(action: ActionCardAction\): MessageId/);
  assert.match(SRC, /formatMessage\(\{ id: actionVerb\(action\) \}\)/);
  // No arm may return prose.
  const body = SRC.slice(SRC.indexOf("function actionVerb"), SRC.indexOf("function ActionTitleLine"));
  assert.doesNotMatch(body, /return "(?!actionCard\.)/, "an actionVerb arm returns text, not an id");
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
  assert.doesNotMatch(SRC, /\{vis\}/, "the raw visibility value is being interpolated again");
});

test("member count uses ICU plural, not hand-rolled English", () => {
  const n = (c: string) => c;
  assert.equal(fmt("en", "actionCard.title.addMembers", { count: 1, target: "#a", n }),
    "Add 1 member to #a");
  assert.equal(fmt("en", "actionCard.title.addMembers", { count: 2, target: "#a", n }),
    "Add 2 members to #a");
  // zh has a single plural arm; the point is that it does not inherit an "s".
  assert.equal(fmt("zh-cn", "actionCard.title.addMembers", { count: 1, target: "#a", n }),
    "向 #a 添加 1 位成员");
  assert.doesNotMatch(SRC, /count === 1 \? "" : "s"/, "hand-rolled pluralization is back");
});

test("register vs update is two messages, not an interpolated mode value", () => {
  assert.equal(
    fmt("en", "actionCard.result.appRegistered", { client: "C", clientKey: "k" }),
    "C registered (k)",
  );
  assert.equal(
    fmt("en", "actionCard.result.appUpdated", { client: "C", clientKey: "k" }),
    "C updated (k)",
  );
  assert.doesNotMatch(
    SRC, /\? "registered" : "updated"/,
    "the mode union is being rendered as English words again",
  );
});

test("every rich-text chunk in this file is keyed", () => {
  // react-intl renders chunks as an array; an unkeyed element warns at render
  // and nothing fails. Repo-wide guard lives in richTextChunkKeys.test.ts; this
  // asserts it for the file that introduced several at once.
  const chunkFns = [...RAW_SRC.matchAll(/n:\s*\((?:c|chunks)[^)]*\)\s*=>\s*(<[A-Za-z][^>]*>)/g)];
  assert.ok(chunkFns.length >= 2, "expected the title and committed-by chunks");
  for (const m of chunkFns) {
    assert.match(m[1], /key=/, `unkeyed chunk: ${m[1]}`);
  }
});

test("field labels are deduplicated across the action cases", () => {
  // 23 label sites collapsed to 13 ids. Minting one id per SITE is how the same
  // English drifts into two Chinese translations.
  const ids = [...SRC.matchAll(/id: "(actionCard\.field\.[A-Za-z]+)"/g)].map((m) => m[1]);
  const unique = new Set(ids);
  assert.ok(ids.length > unique.size, "expected reuse — every field id is used once only");
  for (const id of unique) {
    assert.notEqual(en[id], undefined, `${id} missing from en`);
    assert.notEqual(zh[id], undefined, `${id} missing from zh`);
  }
  // No two field ids may carry the same English.
  const byEnglish = new Map<string, string[]>();
  for (const id of unique) {
    byEnglish.set(en[id], [...(byEnglish.get(en[id]) ?? []), id]);
  }
  for (const [text, dupes] of byEnglish) {
    assert.equal(dupes.length, 1, `${JSON.stringify(text)} minted ${dupes.length} ids: ${dupes}`);
  }
});

test("no bare English prose is left in the component", () => {
  assert.doesNotMatch(SRC, /Failed to execute action"/);
  assert.doesNotMatch(SRC, />Done</);
  assert.doesNotMatch(SRC, /Committed by\{" "\}/);
  assert.doesNotMatch(SRC, /Auto-generated on commit"/);
  assert.doesNotMatch(SRC, /No description prefilled\.</);
  assert.doesNotMatch(SRC, /Admin recovery only\./);
  assert.doesNotMatch(SRC, /Unsafe demo URL override requested\.</);
});

test("every actionCard id exists in BOTH catalogs", () => {
  const enIds = Object.keys(en).filter((k) => k.startsWith("actionCard."));
  assert.ok(enIds.length >= 45, `expected the full namespace, got ${enIds.length}`);
  for (const id of enIds) {
    assert.notEqual(zh[id], undefined, `${id} has no Chinese`);
    assert.notEqual(zh[id], "", `${id} has empty Chinese`);
  }
  // Every id the source references must exist.
  for (const m of SRC.matchAll(/id: "(actionCard\.[A-Za-z.]+)"/g)) {
    assert.notEqual(en[m[1]], undefined, `${m[1]} referenced but not in en`);
  }
});

// ---------------------------------------------------------------------------
// CALLSITE <-> ID PAIRING
//
// The tests above prove each id renders the right English. They do NOT prove the
// right id is bound to the right action — I verified that by mutation: swapping
// `createAgent` for `createChannel` (a WRONG but EXISTING id) left the whole file
// green. Per @铁根's bar that makes them no-rehardcode guards, not semantic
// oracles, so the pairing has to be pinned directly.
//
// This is the highest-value assertion in the file: a mis-paired verb ships a
// button labelled "Create Channel" that creates an Agent.
// ---------------------------------------------------------------------------

/** action.type -> the id its switch arm must return. */
const VERB_PAIRING: Record<string, string> = {
  "channel:create": "actionCard.verb.createChannel",
  "agent:create": "actionCard.verb.createAgent",
  "channel:add_member": "actionCard.verb.addMembers",
  "integration:approve_agent_login": "actionCard.verb.approveLogin",
  "integration:install_marketplace_app": "actionCard.verb.installApp",
  "integration:register_app": "actionCard.verb.registerApp",
  "integration:update_app_registration": "actionCard.verb.updateApp",
  "integration:recover_app_owner": "actionCard.verb.recoverOwner",
};

function parseSwitchPairs(fnName: string, endMarker: string, anchor: string): Map<string, string> {
  const body = SRC.slice(SRC.indexOf(`function ${fnName}`), SRC.indexOf(endMarker));
  assert.ok(body.length > 0, `${fnName}: could not slice the function body`);
  const pairs = new Map<string, string>();
  for (const m of body.matchAll(/case "([a-z_:]+)":([\s\S]*?)(?=\n    case "|\n  \}|$)/g)) {
    // Anchor on the CALL that produces the label, not on the first id in the
    // arm. `channel:add_member` also references `title.channelFallback` for its
    // empty-channel-name case, and a first-id parser silently reported that as
    // the arm's title — a parser bug that looks exactly like a real mis-pairing.
    const at = m[2].indexOf(anchor);
    if (at === -1) continue;
    const id = /"(actionCard\.[A-Za-z.]+)"/.exec(m[2].slice(at));
    if (id) pairs.set(m[1], id[1]);
  }
  return pairs;
}

test("each action type is bound to ITS OWN verb id", () => {
  const pairs = parseSwitchPairs("actionVerb", "function ActionTitleLine", "return ");
  assert.equal(
    pairs.size, Object.keys(VERB_PAIRING).length,
    `parsed ${pairs.size} arms, expected ${Object.keys(VERB_PAIRING).length} — the parser drifted, ` +
      "which would make this whole test vacuous",
  );
  for (const [type, expected] of Object.entries(VERB_PAIRING)) {
    assert.equal(pairs.get(type), expected, `${type} is wired to the wrong verb id`);
  }
});

test("each action type is bound to ITS OWN title id", () => {
  const pairs = parseSwitchPairs("ActionTitleLine", "function ActionDetail", "title(");
  // channel:create resolves through a visibility ternary, so its FIRST id is the
  // private arm; the public arm is asserted separately below.
  const expected: Record<string, string> = {
    "channel:create": "actionCard.title.createPrivateChannel",
    "agent:create": "actionCard.title.createAgent",
    "channel:add_member": "actionCard.title.addMembers",
    "integration:approve_agent_login": "actionCard.title.approveLogin",
    "integration:install_marketplace_app": "actionCard.title.installApp",
    "integration:register_app": "actionCard.title.registerApp",
    "integration:update_app_registration": "actionCard.title.updateApp",
    "integration:recover_app_owner": "actionCard.title.recoverOwner",
  };
  assert.equal(pairs.size, Object.keys(expected).length, "title switch parser drifted");
  for (const [type, id] of Object.entries(expected)) {
    assert.equal(pairs.get(type), id, `${type} is wired to the wrong title id`);
  }
  // The ternary must test `private` and fall through to public — inverting it
  // would label a public channel private, which the pairing above cannot see.
  assert.match(
    SRC,
    /action\.visibility === "private"\s*\?\s*"actionCard\.title\.createPrivateChannel"\s*:\s*"actionCard\.title\.createPublicChannel"/,
    "the visibility ternary is inverted or reshaped",
  );
});

test("no verb or title id is used for two different actions", () => {
  const verbs = [...parseSwitchPairs("actionVerb", "function ActionTitleLine", "return ").values()];
  const titles = [...parseSwitchPairs("ActionTitleLine", "function ActionDetail", "title(").values()];
  for (const [what, ids] of [["verb", verbs], ["title", titles]] as const) {
    assert.equal(new Set(ids).size, ids.length, `two actions share a ${what} id`);
  }
});
