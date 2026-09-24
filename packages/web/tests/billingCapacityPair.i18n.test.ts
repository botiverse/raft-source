import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b, final slice: the capacity PAIR ("3 Humans, 1 Agent").
//
// The confirm dialog used to build this in JSX:
//
//   {formatHumanCapacityLabel(n)}{locale === "zh-CN" ? "，" : " "}{formatAgentCapacityLabel(m)}
//
// i.e. the SEPARATOR was a locale ternary embedded between two elements. That is
// invisible to a hardcoded-string scanner (neither arm is a sentence) and it is
// also where a real zh typography bug lived — see the delta test below.
//
// Both halves are still computed by the capacity-label helpers (they carry the
// plural logic); only the joining is a message now, which is what this pins.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const pair = (loc: "en" | "zh-cn", human: string, agent: string) =>
  String(intls[loc].formatMessage({ id: "billing.capacityPair" }, { human, agent }));

test("the pair joins the two capacity halves the way the old JSX did", () => {
  assert.equal(pair("en", "3 Humans", "1 Agent"), "3 Humans 1 Agent");
  assert.equal(pair("zh-cn", "3 位人类成员", "1 个 Agent"), "3 位人类成员，1 个 Agent");
});

test("DELIBERATE DELTA: zh no longer emits a space before the full-width comma", () => {
  // The old JSX was `{human}{sep}{agent}` with sep = "，" — but the surrounding
  // source had the halves on separate lines, so JSX text-node whitespace put an
  // ASCII space in front of the full-width comma: "3 位人类成员 ，1 个 Agent".
  // Full-width punctuation already carries its own leading advance, so that read
  // as a visible gap in the Chinese confirm dialog.
  //
  // This is a FIX, not a transfer, and it is recorded as a delta rather than
  // folded into the equivalence table above.
  const zhPair = pair("zh-cn", "3 位人类成员", "1 个 Agent");
  assert.ok(!zhPair.includes(" ，"), "a space crept back in before the full-width comma");
  assert.match(zhPair, /成员，1/, "the two halves must join directly across the comma");
});

test("both arms keep their own punctuation", () => {
  // en separates with a space, zh with a full-width comma. Collapsing them to one
  // value is the failure mode this message exists to prevent.
  assert.equal(en["billing.capacityPair"], "{human} {agent}");
  assert.equal(zh["billing.capacityPair"], "{human}，{agent}");
  assert.notEqual(
    en["billing.capacityPair"], zh["billing.capacityPair"],
    "the two locales must not share a separator",
  );
});
