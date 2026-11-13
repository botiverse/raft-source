import assert from "node:assert/strict";
import { AgentIdleHoldTracker, IDLE_HOLD_LONG_MS } from "./agentIdleHold";

const MIN = 60_000;

test("the same reason past the threshold is reported once, with how long it held", () => {
  const tracker = new AgentIdleHoldTracker();
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 0), null);
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 29 * MIN), null);
  assert.deepEqual(tracker.observe("a", "p1", "spec_restart", "background_tasks", 30 * MIN), {
    gate: "spec_restart",
    reason: "background_tasks",
    heldMs: IDLE_HOLD_LONG_MS,
  });
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 90 * MIN), null, "once per episode");
});

test("a different reason starts a new episode", () => {
  const tracker = new AgentIdleHoldTracker();
  tracker.observe("a", "p1", "session_rotation", "background_tasks", 0);
  tracker.observe("a", "p1", "session_rotation", "delivery_in_flight", 20 * MIN);
  assert.equal(tracker.observe("a", "p1", "session_rotation", "delivery_in_flight", 40 * MIN), null);
  assert.equal(tracker.observe("a", "p1", "session_rotation", "delivery_in_flight", 50 * MIN)?.heldMs, 30 * MIN);
});

test("a pass (null) resets the hold", () => {
  const tracker = new AgentIdleHoldTracker();
  tracker.observe("a", "p1", "spec_restart", "agent_busy", 0);
  assert.equal(tracker.observe("a", "p1", "spec_restart", null, 20 * MIN), null);
  assert.deepEqual(tracker.trackedAgentIds(), [], "nothing held, nothing kept");
  tracker.observe("a", "p1", "spec_restart", "agent_busy", 21 * MIN);
  assert.equal(tracker.observe("a", "p1", "spec_restart", "agent_busy", 40 * MIN), null);
  assert.equal(tracker.observe("a", "p1", "spec_restart", "agent_busy", 51 * MIN)?.heldMs, 30 * MIN);
});

test("a new process resets the hold", () => {
  const tracker = new AgentIdleHoldTracker();
  tracker.observe("a", "p1", "spec_restart", "background_tasks", 0);
  assert.equal(tracker.observe("a", "p2", "spec_restart", "background_tasks", 30 * MIN), null);
  assert.equal(tracker.observe("a", "p2", "spec_restart", "background_tasks", 60 * MIN)?.heldMs, 30 * MIN);
});

test("after a report, it reports again only after a reset and another full threshold", () => {
  const tracker = new AgentIdleHoldTracker();
  tracker.observe("a", "p1", "spec_restart", "background_tasks", 0);
  assert.ok(tracker.observe("a", "p1", "spec_restart", "background_tasks", 30 * MIN));
  tracker.observe("a", "p1", "spec_restart", null, 31 * MIN);
  tracker.observe("a", "p1", "spec_restart", "background_tasks", 32 * MIN);
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 61 * MIN), null);
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 62 * MIN)?.heldMs, 30 * MIN);
});

test("gates and agents are measured apart; forget drops one gate or the whole agent", () => {
  const tracker = new AgentIdleHoldTracker();
  tracker.observe("a", "p1", "spec_restart", "background_tasks", 0);
  tracker.observe("a", "p1", "session_rotation", "background_tasks", 10 * MIN);
  tracker.observe("b", "p9", "spec_restart", "background_tasks", 0);
  assert.equal(tracker.observe("a", "p1", "session_rotation", "background_tasks", 30 * MIN), null, "its own start, not the other gate's");
  assert.ok(tracker.observe("a", "p1", "spec_restart", "background_tasks", 30 * MIN));

  tracker.forget("a", "spec_restart");
  assert.equal(tracker.observe("a", "p1", "spec_restart", "background_tasks", 40 * MIN), null, "a fresh episode");
  assert.ok(tracker.observe("a", "p1", "session_rotation", "background_tasks", 40 * MIN), "the other gate kept its start");

  tracker.forget("a");
  assert.deepEqual(tracker.trackedAgentIds(), ["b"]);
});
