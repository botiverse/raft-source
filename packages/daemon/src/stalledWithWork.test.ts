// Reconciler step 9: the pure stalled-with-work rule (rows C14, C15). The
// host-side triggers are in agentProcessManager.stalledWithWork.test.ts.
import { STALLED_WITH_WORK_THRESHOLDS, stalledWithWork, type StalledWithWorkFacts } from "./stalledWithWork";

const MIN = 60_000;

/** A direct-stdin runtime in a turn, a message queued, silent past the threshold. */
function facts(overrides: Partial<StalledWithWorkFacts> = {}): StalledWithWorkFacts {
  return {
    inboxLength: 1,
    turnInProgress: true,
    recoveryUnderway: false,
    deliveryHold: null,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    outstandingToolUses: 0,
    hasDirectStdinRecoveryEvidence: false,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
    runtimeProgressIsStale: false,
    staleForMs: 16 * MIN,
    ...overrides,
  };
}

test("stalled with work queued past the threshold is broken; at exactly the threshold too", () => {
  expect(stalledWithWork(facts())).toEqual({ broken: true, reason: "stalled_with_work", thresholdMs: 15 * MIN });
  expect(stalledWithWork(facts({ staleForMs: 15 * MIN })).broken).toBe(true);
});

test("before the threshold: not broken, with the time left until it (the deadline)", () => {
  expect(stalledWithWork(facts({ staleForMs: 15 * MIN - 1 }))).toEqual({ broken: false, reason: "runtime_progress_recent", deadlineInMs: 1 });
  expect(stalledWithWork(facts({ staleForMs: 4 * MIN }))).toEqual({ broken: false, reason: "runtime_progress_recent", deadlineInMs: 11 * MIN });
});

test("a stall the host latched counts as past the threshold", () => {
  expect(stalledWithWork(facts({ staleForMs: MIN, runtimeProgressIsStale: true })).broken).toBe(true);
});

test("stalled without queued work is only a fact (C15)", () => {
  expect(stalledWithWork(facts({ inboxLength: 0, staleForMs: 10 * 60 * MIN }))).toEqual({ broken: false, reason: "empty_inbox" });
});

test("an idle process with unread messages, or one already being stopped, is not stalled", () => {
  expect(stalledWithWork(facts({ turnInProgress: false })).reason).toBe("turn_not_in_progress");
  expect(stalledWithWork(facts({ recoveryUnderway: true })).reason).toBe("recovery_underway");
});

test.each(["provider_limit", "credential_invalid", "runtime_error_backoff"] as const)("held deliveries (%s) wait by design: never stalled", (deliveryHold) => {
  expect(stalledWithWork(facts({ deliveryHold, staleForMs: 5 * 60 * MIN }))).toEqual({ broken: false, reason: "delivery_held" });
});

test("direct-stdin: an open tool holds the process unless stdin is broken or the tool holds no live work; no session holds it too", () => {
  expect(stalledWithWork(facts({ outstandingToolUses: 1 })).reason).toBe("runtime_not_restartable");
  expect(stalledWithWork(facts({ outstandingToolUses: 1, hasDirectStdinRecoveryEvidence: true })).broken).toBe(true);
  expect(stalledWithWork(facts({ outstandingToolUses: 1, openToolHoldsNoLiveWork: true })).broken).toBe(true);
  expect(stalledWithWork(facts({ hasSession: false })).reason).toBe("runtime_not_restartable");
  expect(stalledWithWork(facts({ busyDeliveryMode: "notification" })).reason).toBe("runtime_not_restartable");
});

test("non-stdin: alive waits 60 minutes with no open tool; not known alive, or latched, uses the stall threshold", () => {
  const nonStdin = { supportsStdinNotification: false, busyDeliveryMode: "none" as const };
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: true, staleForMs: 16 * MIN }))).toEqual({ broken: false, reason: "runtime_progress_recent", deadlineInMs: 44 * MIN });
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: true, staleForMs: 60 * MIN }))).toEqual({ broken: true, reason: "stalled_with_work", thresholdMs: 60 * MIN });
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: true, outstandingToolUses: 1, staleForMs: 10 * 60 * MIN })).reason).toBe("runtime_not_restartable");
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: false, staleForMs: 16 * MIN })).broken).toBe(true);
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: undefined, outstandingToolUses: 1, staleForMs: 16 * MIN })).broken).toBe(true);
  expect(stalledWithWork(facts({ ...nonStdin, processAlive: true, runtimeProgressIsStale: true, staleForMs: 16 * MIN })).broken).toBe(true);
});

test("thresholds are the rule's input", () => {
  expect(STALLED_WITH_WORK_THRESHOLDS).toEqual({ stallMs: 15 * MIN, nonStdinAliveStallMs: 60 * MIN });
  expect(stalledWithWork(facts({ staleForMs: 2 * MIN }), { stallMs: MIN, nonStdinAliveStallMs: 4 * MIN }).broken).toBe(true);
});
