import assert from "node:assert/strict";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Consent copy for issue reports. Leiysky's privacy audit failed the old string
// ("I understand and consent to sharing this data") because it never said WHO
// reads the report. The audience is now stated as the Raft team — the people
// the report is sent to (xxchan, #triage:348179b6).
//
// Why this file exists at all: the fix was a locale-value change, and the only
// gate it had was `tsc`. Typecheck cannot tell a precise consent sentence from a
// vague one — both are valid strings — so reverting the fix would have been
// SILENT. These assertions are the tooth that bites on a revert.
//
// ⛔ Deliberately NOT asserting the sentence verbatim. A literal-equality test
// pins the wording, so every copy edit turns red for no privacy reason and the
// next author deletes the test. What must not regress is the SEMANTICS the audit
// turned on: WHO reads the report is named, and the act being consented to is
// sending it.

const EN_CONSENT = enMessages["agent.reportIssue.consent"] as string;
const CN_CONSENT = zhMessages["agent.reportIssue.consent"] as string;

test("EN consent names the audience and the act", () => {
  // audience — the audit's actual finding: the reader was never stated
  assert.match(EN_CONSENT, /\bRaft team\b/);
  // act — consent attaches to sending this report, not to some vague "sharing"
  assert.match(EN_CONSENT, /\bagree\b/i);
  assert.match(EN_CONSENT, /\bsend this report\b/i);
});

test("CN consent names the audience and the act", () => {
  assert.match(CN_CONSENT, /Raft 团队/);
  assert.match(CN_CONSENT, /同意/);
  assert.match(CN_CONSENT, /发送/);
});

test("neither locale still carries the audit-failed vague sentence", () => {
  // The exact strings the privacy audit rejected. This is the revert detector.
  assert.notEqual(EN_CONSENT, "I understand and consent to sharing this data");
  assert.notEqual(CN_CONSENT, "我理解并同意共享这些数据");
});
