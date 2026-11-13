import assert from "node:assert/strict";
import { agentNotIdleReason, agentNotRunnableReason, agentStopWaitReason, type AgentIdleFacts, type AgentRunnableFacts } from "./agentIdle";

const IDLE: AgentIdleFacts = { turnEnded: true, backgroundTasks: 0, unconsumedStdin: 0, queuedInputPending: false, untoldInbox: false, trackedMentionOpen: false };

test("idle only when the turn ended, no background task runs, and nothing waits to be read", () => {
  assert.equal(agentNotIdleReason(IDLE), null);
  assert.equal(agentNotIdleReason({ ...IDLE, turnEnded: false }), "agent_busy");
  // task #1260: the turn ended but a background task it started is still running.
  assert.equal(agentNotIdleReason({ ...IDLE, backgroundTasks: 1 }), "background_tasks");
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true }), "delivery_in_flight");
  assert.equal(agentNotIdleReason({ ...IDLE, unconsumedStdin: 1 }), "delivery_in_flight", "written to stdin, not yet read by a turn");
  assert.equal(agentNotIdleReason({ ...IDLE, queuedInputPending: true }), "delivery_in_flight", "written into the turn that just ended, which the runtime may run next");
  assert.equal(agentNotIdleReason({ ...IDLE, trackedMentionOpen: true }), "mention_in_flight");
});

test("a running turn is reported first, then background work, then deliveries", () => {
  const busy: AgentIdleFacts = { turnEnded: false, backgroundTasks: 2, unconsumedStdin: 1, queuedInputPending: true, untoldInbox: true, trackedMentionOpen: true };
  assert.equal(agentNotIdleReason(busy), "agent_busy");
  assert.equal(agentNotIdleReason({ ...busy, turnEnded: true }), "background_tasks");
  assert.equal(agentNotIdleReason({ ...busy, turnEnded: true, backgroundTasks: 0 }), "delivery_in_flight");
  assert.equal(agentNotIdleReason({ ...IDLE, trackedMentionOpen: true, untoldInbox: true }), "delivery_in_flight");
});

// Reconciler step 13 (Q-H): a drain's quiet is this definition with one
// clause dropped. RED proof: drop the option check and the first line fails;
// let it drop more and one of the others does.
test("ignoreUntoldInbox drops only the untold inbox: background tasks, stdin, queued input and mentions still count", () => {
  const quiet = { ignoreUntoldInbox: true };
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true }, quiet), null);
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true, turnEnded: false }, quiet), "agent_busy");
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true, backgroundTasks: 1 }, quiet), "background_tasks");
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true, unconsumedStdin: 1 }, quiet), "delivery_in_flight");
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true, queuedInputPending: true }, quiet), "delivery_in_flight");
  assert.equal(agentNotIdleReason({ ...IDLE, untoldInbox: true, trackedMentionOpen: true }, quiet), "mention_in_flight");
});

test("input written into a turn is pending at its end only until a new turn starts, or the settle window passes", async () => {
  const { DeliveryConsumptionWatch, QUEUED_INPUT_SETTLE_MS } = await import("./deliveryConsumptionWatch");
  const watch = new DeliveryConsumptionWatch();
  // A turn whose input started it (an idle write) leaves nothing queued.
  watch.recordWrite("idle", "stdin_idle_delivery", 0);
  watch.recordConsumption("text", 1);
  watch.recordConsumption("turn_end", 2);
  assert.equal(watch.queuedForNextTurn(), null);
  assert.equal(watch.queuedInputPending(2), false);
  // Written into the running turn, then "consumed" by that turn's own events.
  watch.recordWrite("busy", "busy_stdin_notification", 10, true);
  watch.recordConsumption("tool_call", 11);
  assert.equal(watch.snapshot().unconsumedDeliveries, 0, "the observation semantics are unchanged");
  watch.recordConsumption("turn_end", 20);
  assert.deepEqual(watch.queuedForNextTurn(), { count: 1, turnEndAtMs: 20, taken: false });
  assert.equal(watch.queuedInputPending(20 + QUEUED_INPUT_SETTLE_MS - 1), true);
  assert.equal(watch.queuedInputPending(20 + QUEUED_INPUT_SETTLE_MS), false, "no new turn within the window");
  // The runtime runs it as a turn of its own: pending until that turn ends, however long.
  watch.noteTurnStarted();
  assert.equal(watch.queuedInputPending(20 + 10 * QUEUED_INPUT_SETTLE_MS), true);
  // That turn's end, with no write into it, queues nothing.
  watch.recordConsumption("turn_end", 30);
  assert.equal(watch.queuedForNextTurn(), null);
  assert.equal(watch.queuedInputPending(30), false);
});

// tygg: a stop-wait for an agent that cannot work. RED proof: make
// agentStopWaitReason return agentNotIdleReason alone and every
// "not waited for" line fails; let it drop agent_busy or background tasks
// and the "still waits" lines fail.
const RUNNABLE: AgentRunnableFacts = { processAlive: true, credentialInvalid: false, quotaExhausted: false, runtimeMismatch: false };

test("not runnable: no live process, a runtime mismatch, an invalid credential, an exhausted quota", () => {
  assert.equal(agentNotRunnableReason(RUNNABLE), null);
  assert.equal(agentNotRunnableReason({ ...RUNNABLE, processAlive: false }), "process_not_alive");
  assert.equal(agentNotRunnableReason({ ...RUNNABLE, runtimeMismatch: true }), "runtime_mismatch");
  assert.equal(agentNotRunnableReason({ ...RUNNABLE, credentialInvalid: true }), "credential_invalid");
  assert.equal(agentNotRunnableReason({ ...RUNNABLE, quotaExhausted: true }), "quota_exhausted");
  assert.equal(agentNotRunnableReason({ processAlive: false, credentialInvalid: true, quotaExhausted: true, runtimeMismatch: true }), "process_not_alive");
});

test("stop-wait: a runnable agent waits as idle says; one that cannot run is not waited for on clauses only a turn settles", () => {
  const quiet = { ignoreUntoldInbox: true };
  const dead = { ...RUNNABLE, credentialInvalid: true };
  assert.deepEqual(agentStopWaitReason(IDLE, dead, quiet), { notIdle: null, notRunnable: null, settled: null }, "idle: nothing to report");
  for (const facts of [{ ...IDLE, unconsumedStdin: 1 }, { ...IDLE, queuedInputPending: true }, { ...IDLE, untoldInbox: true }]) {
    assert.equal(agentStopWaitReason(facts, RUNNABLE).notIdle, "delivery_in_flight", "runnable: waits");
    assert.deepEqual(agentStopWaitReason(facts, dead), { notIdle: null, notRunnable: "credential_invalid", settled: "delivery_in_flight" });
  }
  assert.deepEqual(agentStopWaitReason({ ...IDLE, trackedMentionOpen: true }, { ...RUNNABLE, quotaExhausted: true }, quiet), { notIdle: null, notRunnable: "quota_exhausted", settled: "mention_in_flight" });
  // A turn in flight, or a background task, still waits: they end without the main runtime's reply.
  assert.deepEqual(agentStopWaitReason({ ...IDLE, turnEnded: false, unconsumedStdin: 1 }, dead, quiet), { notIdle: "agent_busy", notRunnable: null, settled: null });
  assert.deepEqual(agentStopWaitReason({ ...IDLE, backgroundTasks: 1, unconsumedStdin: 1 }, dead, quiet), { notIdle: "background_tasks", notRunnable: null, settled: null });
  // No live process: no turn can be in flight.
  assert.deepEqual(agentStopWaitReason({ ...IDLE, turnEnded: false }, { ...RUNNABLE, processAlive: false }), { notIdle: null, notRunnable: "process_not_alive", settled: "agent_busy" });
});
