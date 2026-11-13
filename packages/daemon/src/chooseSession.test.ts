// Reconciler step 8a: one session rule for both hosts (chooseSession.ts).
//
// RED proof: check the stuck refusal before the spec drop and "spec drop and
// stuck" refuses; check the recycle before the refusal and "stuck and
// recycle" starts a new session; drop the refusal and "stuck" resumes.

import assert from "node:assert/strict";
import { chooseSession, RESUME_FAILURE_THRESHOLD, type WakeRecycleChosen } from "./chooseSession";
import { decideWakeRecycle, type WakeRecyclePlan } from "./wakeSessionRecycle";

const plan = (lastContextTokens: number): WakeRecyclePlan => decideWakeRecycle({
  config: { enabled: true, minContextTokens: 1_000, minColdGapMs: 60_000, tierGate: false, minColdGap5mTierMs: 30_000, minContextTokensPastTier: 500 },
  runtime: "claude",
  sessionId: "session-1",
  hasResumePrompt: false,
  hasRuntimeProfileControl: false,
  facts: { transcriptPath: null, lastActivityAtMs: 0, lastContextTokens },
  nowMs: 120_000,
});
const recycle = plan(5_000) as WakeRecycleChosen;
const keep = plan(500);

test("the fixtures: a large cold session recycles, a small one resumes", () => {
  assert.equal(recycle.action, "recycle");
  assert.deepEqual(keep, {
    action: "resume",
    reason: "context_below_threshold",
    thresholds: { minColdGapMs: 60_000, minContextTokens: 1_000, cacheTier: "unknown", tierGate: false },
  });
});

test("no session: a new one, whatever the other facts say", () => {
  for (const sessionId of [null, undefined, ""]) {
    assert.deepEqual(chooseSession({ sessionId, specDrop: "runtime_changed", stuckFailures: 3, wakeRecycle: recycle }), { kind: "new", reason: "no_session" });
  }
});

test("no rule applies (or none was read): the session is resumed", () => {
  assert.deepEqual(chooseSession({ sessionId: "session-1" }), { kind: "resume", sessionId: "session-1" });
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", specDrop: null, stuckFailures: null, wakeRecycle: keep }),
    { kind: "resume", sessionId: "session-1" },
  );
});

test("rule 1, step 7: a session started on another spec is replaced by a new one", () => {
  assert.deepEqual(chooseSession({ sessionId: "session-1", specDrop: "runtime_changed" }), { kind: "new", reason: "spec_drop", dropReason: "runtime_changed" });
  assert.deepEqual(chooseSession({ sessionId: "session-1", specDrop: "codex_model_changed" }), { kind: "new", reason: "spec_drop", dropReason: "codex_model_changed" });
});

test("rule 2, task #10: a session that needs a reset refuses the start, never a new session", () => {
  assert.deepEqual(chooseSession({ sessionId: "session-1", specDrop: null, stuckFailures: 3 }), { kind: "refuse", reason: "session_needs_reset", failures: 3 });
});

test("rule 3, RFC 070: a cold wake of a large session starts a new one with the plan's briefing", () => {
  assert.deepEqual(chooseSession({ sessionId: "session-1", wakeRecycle: recycle }), { kind: "new", reason: "wake_recycle", recycle });
});

test("precedence: the spec drop wins over the refusal (a dropped session is not refused)", () => {
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", specDrop: "runtime_changed", stuckFailures: 4 }),
    { kind: "new", reason: "spec_drop", dropReason: "runtime_changed" },
  );
});

test("precedence: the spec drop wins over the recycle (no briefing for a dropped session)", () => {
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", specDrop: "codex_model_changed", wakeRecycle: recycle }),
    { kind: "new", reason: "spec_drop", dropReason: "codex_model_changed" },
  );
});

test("precedence: the refusal wins over the recycle (a stuck session is refused, not recycled)", () => {
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", specDrop: null, stuckFailures: 3, wakeRecycle: recycle }),
    { kind: "refuse", reason: "session_needs_reset", failures: 3 },
  );
});

test("precedence: all three apply, the spec drop decides", () => {
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", specDrop: "runtime_changed", stuckFailures: 3, wakeRecycle: recycle }),
    { kind: "new", reason: "spec_drop", dropReason: "runtime_changed" },
  );
});

// Reconciler step 10a (row D4): the resume failure moved here from the close
// path. RED proof: drop rule 1b and the "resume failure" rows resume.
test("rule 1b, step 10a: a known resume error starts a new session", () => {
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", resumeFailure: { knownError: "missing", earlyCrashes: 0 } }),
    { kind: "new", reason: "resume_failed", cause: "missing", sessionId: "session-1" },
  );
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", resumeFailure: { knownError: "provider_replay_rejected", earlyCrashes: 0 } }),
    { kind: "new", reason: "resume_failed", cause: "provider_replay_rejected", sessionId: "session-1" },
  );
});

test(`rule 1b, step 10a: ${RESUME_FAILURE_THRESHOLD} early crashes in a row start a new session, one does not`, () => {
  assert.deepEqual(chooseSession({ sessionId: "session-1", resumeFailure: { knownError: null, earlyCrashes: 1 } }), { kind: "resume", sessionId: "session-1" });
  assert.deepEqual(
    chooseSession({ sessionId: "session-1", resumeFailure: { knownError: null, earlyCrashes: RESUME_FAILURE_THRESHOLD } }),
    { kind: "new", reason: "resume_failed", cause: "repeated_early_crash", sessionId: "session-1" },
  );
});

test("precedence: the spec drop wins over a resume failure; a resume failure wins over the refusal and the recycle", () => {
  const failed = { knownError: null, earlyCrashes: RESUME_FAILURE_THRESHOLD };
  assert.deepEqual(chooseSession({ sessionId: "session-1", specDrop: "runtime_changed", resumeFailure: failed }), { kind: "new", reason: "spec_drop", dropReason: "runtime_changed" });
  assert.equal(chooseSession({ sessionId: "session-1", stuckFailures: 3, resumeFailure: failed }).kind, "new");
  assert.equal(chooseSession({ sessionId: "session-1", wakeRecycle: recycle, resumeFailure: failed }).kind, "new");
  assert.deepEqual(chooseSession({ sessionId: null, resumeFailure: failed }), { kind: "new", reason: "no_session" });
});
