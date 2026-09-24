import assert from "node:assert/strict";
import test from "node:test";

import {
  SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY,
  SLACK_BRIDGE_MAX_DELIVERY_AGE_MS,
  SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS,
  SLACK_BRIDGE_MAX_RETRY_DELAY_MS,
  SLACK_BRIDGE_OUTBOUND_DELIVERY_STATES,
  applySlackBridgeProviderAttemptResult,
  canAdvanceSlackBridgePartitionCursor,
  planSlackBridgePartitionWork,
  type SlackBridgeOutboundDeliverySnapshot,
} from "./slackBridgeDelivery.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function delivery(
  overrides: Partial<SlackBridgeOutboundDeliverySnapshot> = {},
): SlackBridgeOutboundDeliverySnapshot {
  return {
    logicalDeliveryId: "delivery-1",
    bindingId: "binding-1",
    bindingEpoch: 7,
    partitionPosition: 11,
    enqueueRuntimeRevision: "runtime-r4.1",
    state: "queued",
    providerAttempts: 0,
    ambiguityBudgetProviderAttempts: 0,
    dispatchedFailureAttempts: 0,
    firstDispatchedAt: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

test("freezes the ten closed outbound delivery states", () => {
  assert.deepEqual(SLACK_BRIDGE_OUTBOUND_DELIVERY_STATES, [
    "not_queued",
    "queued",
    "dispatching",
    "accepted",
    "retry_wait",
    "outcome_unknown",
    "dead",
    "skipped",
    "revoked",
    "quarantined",
  ]);
});

test("only the exact partition head under the same active runtime revision may dispatch", () => {
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery(),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "dispatch" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ partitionPosition: 12 }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "not_partition_head" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery(),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.2",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "runtime_revision_mismatch" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery(),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: false,
    now: NOW,
  }), { kind: "blocked", reason: "runtime_inactive" });
});

test("fuse-down blocks provider I/O but does not strand an already accepted head", () => {
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "accepted",
      providerAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.2",
    runtimeActive: false,
    now: NOW,
  }), { kind: "advance_cursor" });
});

test("retry_wait dispatches only when due and an owned lease never double-dispatches", () => {
  const future = delivery({
    state: "retry_wait",
    providerAttempts: 1,
    firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    nextAttemptAt: "2026-07-24T12:00:01.000Z",
  });
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: future,
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "retry_not_due" });
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: future,
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: new Date("2026-07-24T12:00:01.000Z"),
  }), { kind: "dispatch" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ state: "dispatching" }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "lease_owned" });
});

test("unknown and dead heads cannot be overtaken automatically", () => {
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "outcome_unknown",
      providerAttempts: SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY,
      ambiguityBudgetProviderAttempts: SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY,
      firstDispatchedAt: NOW.toISOString(),
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "reconcile_or_redispatch", automaticRedispatchAllowed: false });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "outcome_unknown",
      providerAttempts: 1,
      ambiguityBudgetProviderAttempts: 1,
      firstDispatchedAt: new Date(
        NOW.getTime() - SLACK_BRIDGE_MAX_DELIVERY_AGE_MS,
      ).toISOString(),
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "reconcile_or_redispatch", automaticRedispatchAllowed: false });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "dead",
      providerAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "terminal_partition_head" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ state: "queued", partitionPosition: 12 }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "not_partition_head" });
});

test("pre-provider-I/O lease reclaim consumes no attempt or age budget", () => {
  const before = delivery({
    state: "dispatching",
    providerAttempts: 2,
    ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: "2026-07-24T11:00:00.000Z",
  });
  assert.deepEqual(applySlackBridgeProviderAttemptResult(
    before,
    { kind: "pre_io_lease_reclaimed" },
    NOW,
  ), {
    state: "queued",
    providerAttempts: 2,
    ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    nextAttemptAt: null,
    automaticRedispatchAllowed: false,
    reason: "lease_reclaimed_before_provider_io",
  });
});

test("429 consumes provider-attempt and wall-clock age but no failure or ambiguity budget", () => {
  const transition = applySlackBridgeProviderAttemptResult(
    delivery({
      state: "dispatching",
      providerAttempts: 1,
      ambiguityBudgetProviderAttempts: 1,
      dispatchedFailureAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    { kind: "rate_limited", retryAfterMs: 30_000 },
    NOW,
  );
  assert.deepEqual(transition, {
    state: "retry_wait",
    providerAttempts: 2,
    ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    nextAttemptAt: "2026-07-24T12:00:30.000Z",
    automaticRedispatchAllowed: false,
    reason: "provider_rate_limited",
  });
});

test("definite transient failure uses capped full jitter and the 24th failure is dead", () => {
  const retry = applySlackBridgeProviderAttemptResult(
    delivery({
      state: "dispatching",
      providerAttempts: 20,
      dispatchedFailureAttempts: 20,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    { kind: "transient_failure", baseDelayMs: 1_000, jitterUnit: 0.5 },
    NOW,
  );
  assert.equal(retry.state, "retry_wait");
  assert.equal(retry.dispatchedFailureAttempts, 21);
  assert.equal(
    Date.parse(retry.nextAttemptAt!) - NOW.getTime(),
    Math.floor(SLACK_BRIDGE_MAX_RETRY_DELAY_MS * 0.5),
  );

  const dead = applySlackBridgeProviderAttemptResult(
    delivery({
      state: "dispatching",
      providerAttempts: SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS - 1,
      dispatchedFailureAttempts: SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS - 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    { kind: "transient_failure", baseDelayMs: 1_000, jitterUnit: 0 },
    NOW,
  );
  assert.equal(dead.state, "dead");
  assert.equal(dead.dispatchedFailureAttempts, SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS);
  assert.equal(dead.reason, "failure_budget_exhausted");
});

test("24h age terminalizes retryable and ambiguous outcomes while acceptance remains authoritative", () => {
  const firstDispatchedAt = new Date(NOW.getTime() - SLACK_BRIDGE_MAX_DELIVERY_AGE_MS).toISOString();
  const aged = delivery({
    state: "dispatching",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt,
  });

  assert.equal(applySlackBridgeProviderAttemptResult(
    aged,
    { kind: "rate_limited", retryAfterMs: 30_000 },
    NOW,
  ).reason, "age_budget_exhausted");
  assert.equal(applySlackBridgeProviderAttemptResult(
    aged,
    { kind: "outcome_ambiguous" },
    NOW,
  ).state, "dead");
  assert.equal(applySlackBridgeProviderAttemptResult(
    aged,
    { kind: "accepted" },
    NOW,
  ).state, "accepted");
});

test("ambiguous automatic resend budget is based on total provider attempts for one logical delivery", () => {
  const secondAttemptAmbiguous = applySlackBridgeProviderAttemptResult(
    delivery({
      state: "dispatching",
      providerAttempts: 1,
      ambiguityBudgetProviderAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    { kind: "outcome_ambiguous" },
    NOW,
  );
  assert.equal(secondAttemptAmbiguous.state, "outcome_unknown");
  assert.equal(secondAttemptAmbiguous.providerAttempts, 2);
  assert.equal(secondAttemptAmbiguous.automaticRedispatchAllowed, true);

  const thirdAttemptAmbiguous = applySlackBridgeProviderAttemptResult(
    delivery({
      state: "dispatching",
      providerAttempts: 2,
      ambiguityBudgetProviderAttempts: 2,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
    { kind: "outcome_ambiguous" },
    NOW,
  );
  assert.equal(thirdAttemptAmbiguous.providerAttempts, 3);
  assert.equal(thirdAttemptAmbiguous.automaticRedispatchAllowed, false);
});

test("429 does not consume the three-call non-429 automatic budget", () => {
  const rateLimited = applySlackBridgeProviderAttemptResult(
    delivery({ state: "dispatching" }),
    { kind: "rate_limited", retryAfterMs: 0 },
    NOW,
  );
  assert.equal(rateLimited.providerAttempts, 1);
  assert.equal(rateLimited.ambiguityBudgetProviderAttempts, 0);

  let snapshot = delivery({
    state: "dispatching",
    providerAttempts: rateLimited.providerAttempts,
    ambiguityBudgetProviderAttempts: rateLimited.ambiguityBudgetProviderAttempts,
    firstDispatchedAt: rateLimited.firstDispatchedAt,
  });
  for (const expectedBudget of [1, 2, 3]) {
    const transition = applySlackBridgeProviderAttemptResult(
      snapshot,
      { kind: "outcome_ambiguous" },
      NOW,
    );
    assert.equal(transition.ambiguityBudgetProviderAttempts, expectedBudget);
    assert.equal(transition.automaticRedispatchAllowed, expectedBudget < 3);
    snapshot = delivery({
      state: "dispatching",
      providerAttempts: transition.providerAttempts,
      ambiguityBudgetProviderAttempts: transition.ambiguityBudgetProviderAttempts,
      firstDispatchedAt: transition.firstDispatchedAt,
    });
  }
  assert.equal(snapshot.providerAttempts, 4);
});

test("definite non-429 outcomes also consume the automatic provider budget", () => {
  let snapshot = delivery({ state: "dispatching" });
  for (const expectedBudget of [1, 2]) {
    const transition = applySlackBridgeProviderAttemptResult(
      snapshot,
      { kind: "transient_failure", baseDelayMs: 1_000, jitterUnit: 0 },
      NOW,
    );
    assert.equal(transition.ambiguityBudgetProviderAttempts, expectedBudget);
    snapshot = delivery({
      state: "dispatching",
      providerAttempts: transition.providerAttempts,
      ambiguityBudgetProviderAttempts: transition.ambiguityBudgetProviderAttempts,
      dispatchedFailureAttempts: transition.dispatchedFailureAttempts,
      firstDispatchedAt: transition.firstDispatchedAt,
    });
  }

  const third = applySlackBridgeProviderAttemptResult(
    snapshot,
    { kind: "outcome_ambiguous" },
    NOW,
  );
  assert.equal(third.ambiguityBudgetProviderAttempts, 3);
  assert.equal(third.automaticRedispatchAllowed, false);
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "retry_wait",
      providerAttempts: third.providerAttempts,
      ambiguityBudgetProviderAttempts: third.ambiguityBudgetProviderAttempts,
      dispatchedFailureAttempts: third.dispatchedFailureAttempts,
      firstDispatchedAt: third.firstDispatchedAt,
      nextAttemptAt: NOW.toISOString(),
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "automatic_provider_budget_exhausted" });
});

test("only accepted or exact actor-and-reason-audited CAS skip advances the cursor", () => {
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({
      state: "accepted",
      providerAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
  }), true);
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({
      state: "outcome_unknown",
      providerAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
  }), false);
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({
      state: "dead",
      providerAttempts: 1,
      firstDispatchedAt: "2026-07-24T11:00:00.000Z",
    }),
  }), false);
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({ state: "skipped" }),
  }), false);

  const skipReceipt = {
    logicalDeliveryId: "delivery-1",
    bindingId: "binding-1",
    bindingEpoch: 7,
    partitionPosition: 11,
    actorId: "user-manager",
    reason: "audited duplicate-risk decision",
    decisionRevision: 1,
  };
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({ state: "skipped" }),
    skipReceipt,
  }), true);
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ state: "skipped" }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: false,
    skipReceipt,
    now: NOW,
  }), { kind: "advance_cursor" });
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ state: "skipped" }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "terminal_partition_head" });
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({ state: "skipped" }),
    skipReceipt: { ...skipReceipt, partitionPosition: 12 },
  }), false);
  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({ state: "skipped" }),
    skipReceipt: { ...skipReceipt, actorId: "" },
  }), false);
});

test("invalid snapshots and invalid retry inputs fail closed", () => {
  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({ providerAttempts: 0, dispatchedFailureAttempts: 1 }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "invalid_snapshot" });

  assert.deepEqual(planSlackBridgePartitionWork({
    delivery: delivery({
      state: "unknown_new_state" as SlackBridgeOutboundDeliverySnapshot["state"],
    }),
    partitionCursorPosition: 10,
    currentRuntimeRevision: "runtime-r4.1",
    runtimeActive: true,
    now: NOW,
  }), { kind: "blocked", reason: "invalid_snapshot" });

  for (const state of ["accepted", "retry_wait", "outcome_unknown", "dead"] as const) {
    assert.deepEqual(planSlackBridgePartitionWork({
      delivery: delivery({
        state,
        nextAttemptAt: state === "retry_wait" ? "2026-07-24T12:00:01.000Z" : null,
      }),
      partitionCursorPosition: 10,
      currentRuntimeRevision: "runtime-r4.1",
      runtimeActive: true,
      now: NOW,
    }), { kind: "blocked", reason: "invalid_snapshot" }, `${state} needs provider evidence`);
  }

  assert.equal(canAdvanceSlackBridgePartitionCursor({
    delivery: delivery({ state: "accepted" }),
  }), false);

  assert.throws(
    () => applySlackBridgeProviderAttemptResult(
      delivery({ state: "dispatching" }),
      { kind: "transient_failure", baseDelayMs: 1_000, jitterUnit: 1 },
      NOW,
    ),
    /jitter/,
  );
  assert.throws(
    () => applySlackBridgeProviderAttemptResult(
      delivery({ state: "dispatching" }),
      { kind: "rate_limited", retryAfterMs: -1 },
      NOW,
    ),
    /Retry-After/,
  );
});
