import assert from "node:assert/strict";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Consent copy for issue reports. Leiysky's privacy audit failed the old string
// ("I understand and consent to sharing this data") because it never said WHO
// reads the report, while the real audience is every member of the Botiverse
// workspace, agents included.
//
// Why this file exists at all: the fix was a locale-value change, and the only
// gate it had was `tsc`. Typecheck cannot tell a precise consent sentence from a
// vague one — both are valid strings — so reverting the fix would have been
// SILENT. These assertions are the tooth that bites on a revert.
//
// ⛔ Deliberately NOT asserting the sentence verbatim. A literal-equality test
// pins the wording, so every copy edit turns red for no privacy reason and the
// next author deletes the test. What must not regress is the SEMANTICS the audit
// turned on: the audience, the fact that it covers the selected diagnostic data,
// and that the act being consented to is submission.

const EN_CONSENT = enMessages["agent.reportIssue.consent"] as string;
const CN_CONSENT = zhMessages["agent.reportIssue.consent"] as string;

test("EN consent names the audience, the data, and the act", () => {
  // audience — the audit's actual finding: the reader set was never stated
  assert.match(EN_CONSENT, /\beveryone\b/i);
  assert.match(EN_CONSENT, /\bBotiverse\b/);
  assert.match(EN_CONSENT, /\bagents\b/i);
  // scope — "selected", because default-ON means untouched items still ship
  assert.match(EN_CONSENT, /selected diagnostic data/i);
  // act — consent attaches to submitting, not to some vague "sharing"
  assert.match(EN_CONSENT, /\bconsent\b/i);
  assert.match(EN_CONSENT, /\bsubmit\b/i);
});

test("CN consent names the audience, the data, and the act", () => {
  assert.match(CN_CONSENT, /所有成员/);
  assert.match(CN_CONSENT, /Botiverse/);
  assert.match(CN_CONSENT, /选择附带的诊断数据/);
  assert.match(CN_CONSENT, /同意提交/);
});

test("CN uses the product term 「包括 Agent」, never an English plural", () => {
  // zh-cn.ts's own header contract (language owner AngLee): no English plurals
  // in CJK copy, and `Agent` is the fixed product term. "agents" here would be
  // a language-contract violation, not a style preference.
  assert.match(CN_CONSENT, /包括 Agent/);
  assert.doesNotMatch(CN_CONSENT, /包括 agents/);
  assert.doesNotMatch(CN_CONSENT, /Agents/);
});

test("neither locale still carries the audit-failed vague sentence", () => {
  // The exact strings the privacy audit rejected. This is the revert detector.
  assert.notEqual(EN_CONSENT, "I understand and consent to sharing this data");
  assert.notEqual(CN_CONSENT, "我理解并同意共享这些数据");
});
