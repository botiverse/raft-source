import assert from "node:assert/strict";
import { decodeWakeCrashLoopState, encodeWakeCrashLoopState } from "./replicaRouter";
import { freshWakeCrashLoopEpisode, type WakeCrashLoopEpisodeState } from "./services/wakeCrashLoopBreaker";

// skyzh's type-boundary audit (2026-09-15): the decoder checked three fields and
// asserted the whole state; the breaker then did time arithmetic on whatever
// was stored. Every field is now shaped, legal nulls stay legal, blocked=true
// is never decoded away, and repaired fields are named.

const whole = {
  episode: 3,
  earlyExitCount: 2,
  blocked: false,
  blockedAtMs: null,
  lastStartAtMs: 1_700_000_000_000,
  lastStartLaunchId: "launch-1",
  lastStartCounted: true,
  firstExitAtMs: 1_700_000_001_000,
  lastExitAtMs: 1_700_000_002_000,
  lastExitKind: "agent_process_exited",
  lastSignal: "SIGTERM",
  lastLaunchId: "launch-1",
};

// The task #1221 fields are optional on the type: records written before them
// lack them, and they decode to their defaults without counting as a repair.
const task1221Defaults = {
  needsActionReason: null,
  catchupOwed: false,
  catchupCarriedLaunchId: null,
  startFailureCount: 0,
  lastStartFailureReason: null,
  lastStartFailureLaunchId: null,
  retryAfterMs: null,
  startFailureOwnedLaunchId: null,
  blockedByLaunchId: null,
  actionRequiredNotifiedFingerprint: null,
  pauseRetryAtMs: null,
  pauseRetryCooldownMs: null,
  pauseRetryLaunchId: null,
  pauseRetryReadyLaunchId: null,
  pauseRetryReadyCooldownMs: null,
  pauseRetryCapNotified: false,
};

test("a whole record decodes unchanged with nothing repaired", () => {
  const decoded = decodeWakeCrashLoopState(JSON.stringify(whole));
  assert.deepEqual(decoded, { state: { ...whole, ...task1221Defaults }, repaired: [] });
});

test("legal nulls are legal: an initial episode with null times is not a repair", () => {
  const initial = { ...whole, blocked: false, blockedAtMs: null, lastStartAtMs: null, lastStartLaunchId: null, lastStartCounted: false, firstExitAtMs: null, lastExitAtMs: null, lastExitKind: null, lastSignal: null, lastLaunchId: null, earlyExitCount: 0 };
  assert.deepEqual(decodeWakeCrashLoopState(JSON.stringify(initial)), { state: { ...initial, ...task1221Defaults }, repaired: [] });
});

// RFC 071 F1: the Redis store wrote needsActionReason / catchupOwed /
// catchupCarriedLaunchId but the decoder rebuilt the state without them, so the
// task #1221 catch-up obligation read back as absent after any write. Every
// field of the type is set to a value different from a fresh episode's, so
// dropping any one of them from the decoder fails the deep-equal.
const everyFieldSet: Required<WakeCrashLoopEpisodeState> = {
  episode: 4,
  earlyExitCount: 2,
  blocked: true,
  blockedAtMs: 1_700_000_003_000,
  lastStartAtMs: 1_700_000_000_000,
  lastStartLaunchId: "launch-2",
  lastStartCounted: true,
  firstExitAtMs: 1_700_000_001_000,
  lastExitAtMs: 1_700_000_002_000,
  lastExitKind: "machine_disconnected",
  lastSignal: "SIGKILL",
  lastLaunchId: "launch-2",
  needsActionReason: "model_not_configured",
  catchupOwed: true,
  catchupCarriedLaunchId: "launch-3",
  startFailureCount: 3,
  lastStartFailureReason: "model_not_found",
  lastStartFailureLaunchId: "launch-2",
  retryAfterMs: 1_700_000_004_000,
  startFailureOwnedLaunchId: "launch-owned",
  blockedByLaunchId: "launch-blocker",
  actionRequiredNotifiedFingerprint: "0123456789abcdef",
  pauseRetryAtMs: 1_700_001_800_000,
  pauseRetryCooldownMs: 1_800_000,
  pauseRetryLaunchId: "launch-try",
  pauseRetryReadyLaunchId: "launch-ready-try",
  pauseRetryReadyCooldownMs: 3_600_000,
  pauseRetryCapNotified: true,
};

test("every field of the episode state round-trips through the Redis codec", () => {
  const fresh: Record<string, unknown> = { ...freshWakeCrashLoopEpisode(1), ...task1221Defaults };
  // The fixture must cover every key the decoder produces, each with a non-default value.
  assert.deepEqual(Object.keys(everyFieldSet).sort(), Object.keys(fresh).sort());
  for (const [key, value] of Object.entries(everyFieldSet)) {
    assert.notDeepEqual(value, fresh[key], `${key} must differ from its default so an omission is visible`);
  }
  assert.deepEqual(decodeWakeCrashLoopState(encodeWakeCrashLoopState(everyFieldSet)), { state: everyFieldSet, repaired: [] });
});

test("step 12 follow-up: the capped-notice mark round-trips; a record without it decodes as not told, a malformed one is repaired", () => {
  const told: Required<WakeCrashLoopEpisodeState> = { ...whole, ...task1221Defaults, lastExitKind: "agent_process_exited", blocked: true, needsActionReason: "runtime_repeated_failure", pauseRetryAtMs: 1_700_028_800_000, pauseRetryCooldownMs: 28_800_000, pauseRetryCapNotified: true };
  assert.deepEqual(decodeWakeCrashLoopState(encodeWakeCrashLoopState(told)), { state: told, repaired: [] }, "a replica restart does not tell the owner again");
  const { pauseRetryCapNotified: _omitted, ...older } = told;
  assert.deepEqual(decodeWakeCrashLoopState(JSON.stringify(older)), { state: { ...older, pauseRetryCapNotified: false }, repaired: [] });
  const malformed = decodeWakeCrashLoopState(JSON.stringify({ ...told, pauseRetryCapNotified: "yes" }));
  assert.equal(malformed?.state.pauseRetryCapNotified, false);
  assert.deepEqual(malformed?.repaired, ["pauseRetryCapNotified"]);
});

test("malformed task #1221 fields are repaired to their defaults and named", () => {
  const decoded = decodeWakeCrashLoopState(JSON.stringify({ ...everyFieldSet, needsActionReason: 7, catchupOwed: "true", catchupCarriedLaunchId: "x".repeat(129) }));
  assert.ok(decoded);
  assert.equal(decoded.state.catchupOwed, false, "the string \"true\" is not an owed catch-up");
  assert.equal(decoded.state.needsActionReason, null);
  assert.equal(decoded.state.catchupCarriedLaunchId, null);
  assert.deepEqual([...decoded.repaired].sort(), ["catchupCarriedLaunchId", "catchupOwed", "needsActionReason"]);
});

test("a record missing the remaining fields is filled with neutral values and every gap is named", () => {
  const decoded = decodeWakeCrashLoopState(JSON.stringify({ episode: 1, earlyExitCount: 2, blocked: false }));
  assert.ok(decoded);
  assert.equal(decoded.state.lastStartAtMs, null, "a missing time must be null, never undefined");
  assert.equal(decoded.state.lastStartCounted, false);
  assert.equal(decoded.state.lastExitKind, null);
  assert.deepEqual(
    [...decoded.repaired].sort(),
    ["blockedAtMs", "firstExitAtMs", "lastExitAtMs", "lastExitKind", "lastLaunchId", "lastSignal", "lastStartAtMs", "lastStartCounted", "lastStartLaunchId"],
  );
});

test("a time that is not a number and a boolean that is a string are repaired, not passed through", () => {
  const decoded = decodeWakeCrashLoopState(JSON.stringify({ ...whole, lastStartAtMs: "not-a-time", lastStartCounted: "false", lastExitKind: "rebooted" }));
  assert.ok(decoded);
  assert.equal(decoded.state.lastStartAtMs, null);
  assert.equal(decoded.state.lastStartCounted, false, "the string \"false\" is truthy; it must not reach the breaker");
  assert.equal(decoded.state.lastExitKind, null, "an unknown exit kind is not a kind");
  assert.deepEqual([...decoded.repaired].sort(), ["lastExitKind", "lastStartAtMs", "lastStartCounted"]);
});

test("a blocked record with unreadable counters stays blocked", () => {
  const decoded = decodeWakeCrashLoopState(JSON.stringify({ episode: "1", earlyExitCount: -4, blocked: true }));
  assert.ok(decoded, "a blocked episode must survive decoding damage");
  assert.equal(decoded.state.blocked, true);
  assert.equal(decoded.state.episode, 1);
  assert.equal(decoded.state.earlyExitCount, 0);
  assert.ok(decoded.repaired.includes("episode") && decoded.repaired.includes("earlyExitCount"));
});

test("an unblocked record with unreadable counters, invalid JSON, a non-object, or a non-boolean blocked is not a state", () => {
  assert.equal(decodeWakeCrashLoopState(JSON.stringify({ episode: "1", earlyExitCount: 2, blocked: false })), null);
  assert.equal(decodeWakeCrashLoopState(JSON.stringify({ episode: 1, earlyExitCount: 2, blocked: "true" })), null);
  assert.equal(decodeWakeCrashLoopState("invalid-json"), null);
  assert.equal(decodeWakeCrashLoopState(JSON.stringify([1, 2, 3])), null);
  assert.equal(decodeWakeCrashLoopState(undefined), null);
});
