// #proj-runtime:#54 phase 3: the turn-end compaction rule both hosts share.
import assert from "node:assert/strict";
import { TurnEndCompactionArming, decideTurnEndCompaction, resolveTurnEndCompactionConfig, turnEndCompactionLogLine, turnEndCompactionTraceAttrs } from "./turnEndCompaction";

const on = resolveTurnEndCompactionConfig({ turnEndCompaction: true }, {});

test("#54 phase 3: the flag turns it on; the local switch only turns it off; the knobs follow per-agent env over the daemon's", () => {
  assert.deepEqual(on, { enabled: true, minContextTokens: 250_000, minWindowTokens: 400_000, driverTimeoutMs: 600_000 });
  assert.equal(resolveTurnEndCompactionConfig({}, {}).enabled, false, "no flag: off");
  assert.equal(resolveTurnEndCompactionConfig({ turnEndCompaction: false }, { RAFT_TURN_END_COMPACTION: "1" }).enabled, false, "env never turns it on");
  assert.equal(resolveTurnEndCompactionConfig({ turnEndCompaction: true, envVars: { RAFT_TURN_END_COMPACTION: "0" } }, {}).enabled, false);
  const tuned = resolveTurnEndCompactionConfig(
    { turnEndCompaction: true, envVars: { RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "300000" } },
    { RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "1", RAFT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS: "500000" },
  );
  assert.equal(tuned.minContextTokens, 300_000, "per-agent env wins");
  assert.equal(tuned.minWindowTokens, 500_000);
  assert.equal(resolveTurnEndCompactionConfig({ turnEndCompaction: true }, { RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "abc" }).minContextTokens, 250_000);
});

test("#54 phase 3: fires only past 250k on a window of at least 400k; unknown facts never fire", () => {
  const at = (contextTokens: number | null, windowTokens: number | null, armed = true) => decideTurnEndCompaction(on, { contextTokens, windowTokens }, armed);
  assert.deepEqual(at(300_000, 1_000_000), { fire: true });
  assert.deepEqual(at(300_000, 400_000), { fire: true }, "a 400k window qualifies");
  assert.deepEqual(at(250_000, 1_000_000), { fire: false, reason: "below_threshold" }, "at the threshold: not past it");
  assert.deepEqual(at(300_000, 200_000), { fire: false, reason: "window_too_small" }, "a 200k window keeps the runtime's own compaction");
  assert.deepEqual(at(300_000, null), { fire: false, reason: "window_unknown" });
  assert.deepEqual(at(null, 1_000_000), { fire: false, reason: "context_unknown" });
  assert.deepEqual(at(300_000, 1_000_000, false), { fire: false, reason: "not_rearmed" });
});

test("#54 phase 3: no second compaction until the context has dropped to the threshold and grown past it again; a new session starts armed", () => {
  const arming = new TurnEndCompactionArming();
  assert.equal(arming.observe("s-1", 300_000, 250_000), true);
  arming.markFired();
  assert.equal(arming.observe("s-1", 320_000, 250_000), false, "still past it after the compaction");
  assert.equal(arming.observe("s-1", null, 250_000), false, "unknown size (just compacted) doesn't re-arm");
  assert.equal(arming.observe("s-1", 90_000, 250_000), true, "dropped below: armed again");
  assert.equal(arming.observe("s-1", 260_000, 250_000), true, "and fires once it grows past again");
  arming.markFired();
  assert.equal(arming.observe("s-2", 300_000, 250_000), true, "a new session starts armed");
  arming.markFired();
  arming.rearm();
  assert.equal(arming.observe("s-2", 300_000, 250_000), true, "a refused compaction keeps the arm");
});

test("#54 phase 3: the trace carries the threshold, the window floor, and the facts it decided on", () => {
  assert.deepEqual(turnEndCompactionTraceAttrs(on, { contextTokens: 310_000, windowTokens: 1_000_000 }), {
    threshold_tokens: 250_000,
    min_window_tokens: 400_000,
    context_tokens: 310_000,
    context_window_tokens: 1_000_000,
  });
  assert.deepEqual(turnEndCompactionTraceAttrs(on, { contextTokens: null, windowTokens: null }), { threshold_tokens: 250_000, min_window_tokens: 400_000 });
});

test("#54 phase 3: a settled compaction's one log line names the outcome and the context before it", () => {
  assert.equal(
    turnEndCompactionLogLine({ agentId: "agent-1", host: "oar", outcome: "completed", contextTokens: 310_000, contextAfterTokens: 42_000, durationMs: 8_200 }),
    "[TurnEndCompaction] agent agent-1: completed, 310000 context tokens before, 42000 after, took 8200ms (oar)",
  );
  assert.equal(
    turnEndCompactionLogLine({ agentId: "agent-1", host: "legacy", outcome: "failed:not_compacted", contextTokens: null, durationMs: 5 }),
    "[TurnEndCompaction] agent agent-1: failed:not_compacted, unknown context tokens before, took 5ms (legacy)",
  );
});
