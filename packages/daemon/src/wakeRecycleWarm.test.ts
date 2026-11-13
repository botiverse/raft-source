// Warm wake recycle (#proj-runtime:#54, RFC 070 §6.5): the knobs, the mark
// decision, the per-agent marks with their quiet timer, and the trace/log
// text. The hosts' halves are agentProcessManager.wakeRecycleWarm.test.ts and
// agentHost/oarAgentHost.wakeRecycleWarm.test.ts; the start's decision is in
// wakeSessionRecycle.test.ts.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  WarmRecycleMarks,
  decideWarmRecycleMark,
  describeWarmRecycleCancelled,
  describeWarmRecycleMarked,
  describeWarmRecycleStopped,
  resolveWarmRecycleConfig,
  warmRecycleCoversRuntime,
  warmRecycleSenderKind,
  type WarmRecycleConfig,
  type WarmRecycleMark,
} from "./wakeRecycleWarm";

afterEach(() => { vi.useRealTimers(); });

const defaults: WarmRecycleConfig = { enabled: true, minContextTokens: 250_000, minWindowTokens: 400_000, quietMs: 120_000, ceilingTokens: 500_000 };
const mark = (overrides: Partial<WarmRecycleMark> = {}): WarmRecycleMark => ({ sessionId: "session-1", contextTokens: 300_000, windowTokens: 1_000_000, band: "quiet", markedAtMs: 1_000, ...overrides });

test("§6.5: off unless the Server's flag is on; the local RAFT_WAKE_RECYCLE=0 turns it off, nothing local turns it on", () => {
  assert.deepEqual(resolveWarmRecycleConfig({ wakeRecycleWarm: true }, {}), defaults);
  assert.equal(resolveWarmRecycleConfig({}, {}).enabled, false, "absent: off");
  assert.equal(resolveWarmRecycleConfig({ wakeRecycleWarm: false }, {}).enabled, false);
  assert.equal(resolveWarmRecycleConfig({}, { RAFT_WAKE_RECYCLE: "1", RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "1" }).enabled, false, "env never turns it on");
  assert.equal(resolveWarmRecycleConfig({ wakeRecycleWarm: true }, { RAFT_WAKE_RECYCLE: "0" }).enabled, false, "the daemon's off switch");
  assert.equal(resolveWarmRecycleConfig({ wakeRecycleWarm: true, envVars: { RAFT_WAKE_RECYCLE: "off" } }, {}).enabled, false, "the agent's off switch");
});

test("§6.5: thresholds from env, per-agent over the daemon's, parsed like the recycle family's (a bad value keeps the default)", () => {
  const env = {
    RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "200000",
    RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: "300000",
    RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "60000",
    RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "450000",
  };
  assert.deepEqual(resolveWarmRecycleConfig({ wakeRecycleWarm: true }, env), { enabled: true, minContextTokens: 200_000, minWindowTokens: 300_000, quietMs: 60_000, ceilingTokens: 450_000 });
  assert.equal(resolveWarmRecycleConfig({ wakeRecycleWarm: true, envVars: { RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "5000" } }, env).quietMs, 5_000, "the agent's own value wins");
  for (const bad of ["", "0", "-5", "abc"]) {
    assert.deepEqual(resolveWarmRecycleConfig({ wakeRecycleWarm: true }, {
      RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: bad,
      RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: bad,
      RAFT_WAKE_RECYCLE_WARM_QUIET_MS: bad,
      RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: bad,
    }), defaults, `"${bad}"`);
  }
});

test("§6.5: the mark needs both facts, a window of at least 400k and a context above 250k; above 500k is the ceiling band", () => {
  const at = (contextTokens: number | null, windowTokens: number | null) => decideWarmRecycleMark(defaults, { contextTokens, windowTokens });
  assert.deepEqual(at(null, 1_000_000), { mark: false, reason: "context_unknown" });
  assert.deepEqual(at(300_000, null), { mark: false, reason: "window_unknown" });
  assert.deepEqual(at(300_000, 399_999), { mark: false, reason: "window_too_small" });
  assert.deepEqual(at(250_000, 400_000), { mark: false, reason: "below_threshold" }, "at the threshold: not above it");
  assert.deepEqual(at(250_001, 400_000), { mark: true, band: "quiet", contextTokens: 250_001, windowTokens: 400_000 });
  assert.deepEqual(at(500_000, 1_000_000), { mark: true, band: "quiet", contextTokens: 500_000, windowTokens: 1_000_000 }, "at the ceiling: still the quiet band");
  assert.deepEqual(at(500_001, 1_000_000), { mark: true, band: "ceiling", contextTokens: 500_001, windowTokens: 1_000_000 });
});

test("§6.5: only runtimes whose next start can read resume facts: Claude on the legacy host; Codex and Grok on the OAR host with wake_recycle_oar", () => {
  assert.equal(warmRecycleCoversRuntime("legacy", "claude", {}), true);
  for (const runtime of ["pi", "builtin", "kimi-sdk", "codex", "grok", "opencode"]) {
    assert.equal(warmRecycleCoversRuntime("legacy", runtime, { wakeRecycleOar: true }), false, `legacy ${runtime}`);
  }
  assert.equal(warmRecycleCoversRuntime("oar", "codex", { wakeRecycleOar: true }), true);
  assert.equal(warmRecycleCoversRuntime("oar", "grok", { wakeRecycleOar: true }), true);
  assert.equal(warmRecycleCoversRuntime("oar", "codex", {}), false, "no summary facts without wake_recycle_oar");
  assert.equal(warmRecycleCoversRuntime("oar", "pi", { wakeRecycleOar: true }), false);
  assert.equal(warmRecycleCoversRuntime("oar", "claude", { wakeRecycleOar: true }), false);
});

test("§6.5 marks: no delivery for the quiet period runs the stop; the stop is kept for exactly one start", () => {
  vi.useFakeTimers();
  const marks = new WarmRecycleMarks();
  let quiet = 0;
  marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => { quiet += 1; } });
  assert.deepEqual(marks.pending("agent-1"), mark());
  assert.equal(marks.takeStopped("agent-2"), null);
  vi.advanceTimersByTime(119_999);
  assert.equal(quiet, 0);
  vi.advanceTimersByTime(1);
  assert.equal(quiet, 1, "two minutes: the host's stop runs");

  assert.deepEqual(marks.stopped("agent-1", 121_000), mark());
  assert.equal(marks.pending("agent-1"), null, "no longer pending");
  assert.equal(marks.cancel("agent-1"), null, "a delivery during the stop does not forget it");
  assert.deepEqual(marks.takeStopped("agent-1"), { sessionId: "session-1", stoppedAtMs: 121_000, contextTokens: 300_000, band: "quiet" });
  assert.equal(marks.takeStopped("agent-1"), null, "one start only");
});

test("§6.5 marks: a delivery inside the quiet period cancels the stop; a pending mark is not a stop for the next start", () => {
  vi.useFakeTimers();
  const marks = new WarmRecycleMarks();
  let quiet = 0;
  const arm = () => marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => { quiet += 1; } });
  arm();
  vi.advanceTimersByTime(60_000);
  assert.deepEqual(marks.cancel("agent-1"), mark());
  assert.equal(marks.cancel("agent-1"), null, "once");
  vi.advanceTimersByTime(600_000);
  assert.equal(quiet, 0, "the timer went with the mark");
  assert.equal(marks.stopped("agent-1", 1), null);

  arm();
  assert.equal(marks.takeStopped("agent-1"), null, "the process ended another way: nothing to recycle on");
  assert.equal(marks.pending("agent-1"), null, "and any start clears it");
  vi.advanceTimersByTime(600_000);
  assert.equal(quiet, 0);

  // A new turn end replaces the mark and its timer; the ceiling band arms none.
  arm();
  vi.advanceTimersByTime(100_000);
  arm();
  vi.advanceTimersByTime(100_000);
  assert.equal(quiet, 0, "two minutes from the later turn end");
  marks.mark("agent-1", mark({ band: "ceiling" }), null);
  vi.advanceTimersByTime(600_000);
  assert.equal(quiet, 0);
  marks.clear();
  assert.equal(marks.pending("agent-1"), null);
});

test("§6.5: a ceiling set below the threshold is raised to it (no session is stopped at once below its own ceiling)", () => {
  const config = resolveWarmRecycleConfig({ wakeRecycleWarm: true }, { RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "300000", RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "100000" });
  assert.equal(config.ceilingTokens, 300_000);
  assert.deepEqual(decideWarmRecycleMark(config, { contextTokens: 300_001, windowTokens: 1_000_000 }), { mark: true, band: "ceiling", contextTokens: 300_001, windowTokens: 1_000_000 });
});

test("§6.5 marks: a cancelled mark yields that session's next turn end (once); a declined session stays declined across starts", () => {
  vi.useFakeTimers();
  const marks = new WarmRecycleMarks();
  marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => {} });
  assert.deepEqual(marks.cancel("agent-1"), mark(), "the turn end's own re-decision: no yield");
  assert.equal(marks.takeYield("agent-1", "session-1"), false);

  marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => {} });
  assert.deepEqual(marks.cancel("agent-1", { yieldNext: true }), mark());
  assert.equal(marks.takeYield("agent-1", "session-2"), false, "another session: no yield");
  marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => {} });
  marks.cancel("agent-1", { yieldNext: true });
  assert.equal(marks.takeYield("agent-1", "session-1"), true, "the next turn end goes to compaction");
  assert.equal(marks.takeYield("agent-1", "session-1"), false, "and only that one");
  assert.equal(marks.cancel("agent-1", { yieldNext: true }), null);
  assert.equal(marks.takeYield("agent-1", "session-1"), false, "no mark was pending: nothing to yield");

  marks.decline("agent-1", "session-1");
  assert.equal(marks.takeStopped("agent-1"), null);
  assert.equal(marks.declined("agent-1", "session-1"), true, "a start does not forget it");
  assert.equal(marks.declined("agent-1", "session-2"), false);
  marks.forget("agent-1");
  assert.equal(marks.declined("agent-1", "session-1"), false, "the agent left the host");
});

test("§6.5 marks: dropPending ends a pending mark and its timer, and keeps a stop already made", () => {
  vi.useFakeTimers();
  const marks = new WarmRecycleMarks();
  let quiet = 0;
  marks.mark("agent-1", mark(), { quietMs: 120_000, onQuiet: () => { quiet += 1; } });
  marks.dropPending("agent-1");
  vi.advanceTimersByTime(600_000);
  assert.equal(quiet, 0, "no timer outlives the process");
  assert.equal(marks.pending("agent-1"), null);

  marks.mark("agent-1", mark(), null);
  marks.stopped("agent-1", 5_000);
  marks.dropPending("agent-1");
  assert.deepEqual(marks.takeStopped("agent-1"), { sessionId: "session-1", stoppedAtMs: 5_000, contextTokens: 300_000, band: "quiet" }, "the warm stop's own exit keeps it");

  marks.mark("agent-1", mark(), null);
  marks.stopped("agent-1", 5_000);
  marks.forget("agent-1");
  assert.equal(marks.takeStopped("agent-1"), null, "an agent that left the host keeps nothing");
});

test("§6.5: sender kinds are the message's sender type, an app as `app`, the daemon's own input as `daemon`", () => {
  assert.deepEqual(["human", "agent", "system", "third_party_app", undefined].map(warmRecycleSenderKind), ["human", "agent", "system", "app", "daemon"]);
});

test("§6.5: trace attributes and the one log line of each step", () => {
  const base = { agentId: "agent-1", launchId: "launch-1", runtime: "claude", host: "legacy" as const };
  const marked = describeWarmRecycleMarked(base, mark(), defaults);
  assert.deepEqual(marked.attrs, { ...base, session_id: "session-1", context_tokens: 300_000, window_tokens: 1_000_000, band: "quiet", threshold_tokens: 250_000, ceiling_tokens: 500_000, quiet_ms: 120_000 });
  assert.equal(marked.logLine, "[WakeRecycle] warm mark: agent agent-1 session session-1, band quiet, 300000 context tokens of a 1000000 window (legacy); stops after 120000ms with no delivery");
  assert.equal(
    describeWarmRecycleMarked({ ...base, host: "oar" }, mark({ band: "ceiling", contextTokens: 600_000 }), defaults).logLine,
    "[WakeRecycle] warm mark: agent agent-1 session session-1, band ceiling, 600000 context tokens of a 1000000 window (oar); stopping now",
  );

  const stopped = describeWarmRecycleStopped(base, mark(), 121_000);
  assert.deepEqual(stopped.attrs, { ...base, session_id: "session-1", context_tokens: 300_000, window_tokens: 1_000_000, band: "quiet", waited_ms: 120_000 });
  assert.equal(stopped.logLine, "[WakeRecycle] warm stop: agent agent-1 session session-1, band quiet, 300000 context tokens of a 1000000 window, waited 120000ms (legacy); the next start is a warm recycle");

  const cancelled = describeWarmRecycleCancelled(base, mark(), 61_000, { reason: "delivery", senderKind: "human", triggerKind: "mention" });
  assert.deepEqual(cancelled.attrs, { ...base, context_tokens: 300_000, band: "quiet", waited_ms: 60_000, reason: "delivery", sender_kind: "human", trigger_kind: "mention" });
  assert.equal(cancelled.logLine, "[WakeRecycle] warm cancel: agent agent-1 session session-1, delivery from human, waited 60000ms, band quiet, 300000 context tokens (legacy); the session continues");
  const notIdle = describeWarmRecycleCancelled(base, mark(), 121_000, { reason: "not_idle" });
  assert.deepEqual(notIdle.attrs, { ...base, context_tokens: 300_000, band: "quiet", waited_ms: 120_000, reason: "not_idle" });
  assert.equal(notIdle.logLine, "[WakeRecycle] warm cancel: agent agent-1 session session-1, not_idle, waited 120000ms, band quiet, 300000 context tokens (legacy); the session continues");
});
