import assert from "node:assert/strict";
import test from "node:test";

import { daemonApiKnownInboxFlagSchema, parseDaemonApiResponse } from "./daemonApiContract.js";

// 2026-09-06 incident: the daemon emitted a flag the wire contract did not accept, so an
// inbox snapshot containing it was rejected WHOLE -- every pending target and every app
// item vanished, not just the offending row. The two definitions of one flag union were
// hand-written in this same package and drifted for seven weeks.
const rowWith = (flags: readonly string[]) => ({
  ok: true,
  rows: [{ target: "#some-channel", pendingCount: 1, flags: [...flags] }],
});

// Kept as literals on purpose: this file must be runnable against the UNMODIFIED source as
// the red proof, so it may not import a symbol the fix introduces. These are exactly the
// members of AgentInboxFlag in agentInbox.ts.
const RENDERER_FLAGS = ["mention", "non_member_mention", "thread", "dm", "task"] as const;

test("every flag the renderer can produce is accepted by the wire contract", () => {
  for (const flag of RENDERER_FLAGS) {
    const parsed = parseDaemonApiResponse("inboxCheck", rowWith([flag]));
    assert.deepEqual(parsed.rows?.[0]?.flags, [flag], `wire contract rejected flag: ${flag}`);
  }
});

test("non_member_mention specifically parses (the 2026-09-06 outage)", () => {
  const parsed = parseDaemonApiResponse("inboxCheck", rowWith(["non_member_mention"]));
  assert.deepEqual(parsed.rows?.[0]?.flags, ["non_member_mention"]);
});

// An unknown value must NOT take down the whole payload. Producer and consumer are
// deployed independently (the incident ran CLI 0.0.22 against daemon 1.0.23), so a newer
// daemon will eventually emit a flag this build has never heard of. Degrading to "one
// row shows one fewer badge" is survivable; rejecting the response is an outage.
test("an unknown future flag degrades instead of rejecting the whole response", () => {
  const parsed = parseDaemonApiResponse("inboxCheck", rowWith(["mention", "flag_from_a_newer_daemon"]));
  assert.equal(parsed.rows?.length, 1, "the response must still parse");
  assert.ok(
    parsed.rows?.[0]?.flags.includes("mention"),
    "known flags must survive alongside an unknown one",
  );
});

// Drift tooth. The round-trip tests above CANNOT catch a stale hand-written enum any more:
// once unknown values are tolerated, a drifted list still parses -- the tolerance that fixes
// the outage also hides its cause. So the single-source property is asserted directly.
// (Found by running @ApplePI's mutation teeth: restoring the old 4-value literal broke
// nothing until this test existed.)
test("the wire contract's known-flag set IS the authoritative list, not a copy of it", () => {
  assert.deepEqual(
    [...daemonApiKnownInboxFlagSchema.options].sort(),
    [...RENDERER_FLAGS].sort(),
    "daemonApiContract must derive its flags from AGENT_INBOX_FLAGS, never restate them",
  );
});
