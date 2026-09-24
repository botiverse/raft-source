/**
 * Provider-neutral Slack Bridge outbound delivery contract.
 *
 * This module deliberately contains no Slack client and no credential. It is
 * the closed decision layer that a durable outbox worker must consult before
 * provider I/O. Persistence/lease code may store more audit evidence, but it
 * must not invent additional states or retry rules.
 */

export const SLACK_BRIDGE_DELIVERY_CONTRACT_VERSION = "slack-bridge-delivery.v1" as const;

export const SLACK_BRIDGE_OUTBOUND_DELIVERY_STATES = [
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
] as const;

export type SlackBridgeOutboundDeliveryState =
  (typeof SLACK_BRIDGE_OUTBOUND_DELIVERY_STATES)[number];

export const SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS = 24;
export const SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY = 3;
export const SLACK_BRIDGE_MAX_DELIVERY_AGE_MS = 24 * 60 * 60 * 1000;
export const SLACK_BRIDGE_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export interface SlackBridgeOutboundDeliverySnapshot {
  logicalDeliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  partitionPosition: number;
  enqueueRuntimeRevision: string;
  state: SlackBridgeOutboundDeliveryState;
  providerAttempts: number;
  ambiguityBudgetProviderAttempts: number;
  dispatchedFailureAttempts: number;
  firstDispatchedAt: string | null;
  nextAttemptAt: string | null;
}

export type SlackBridgePartitionWorkPlan =
  | { kind: "dispatch" }
  | { kind: "reconcile_or_redispatch"; automaticRedispatchAllowed: boolean }
  | { kind: "advance_cursor" }
  | {
      kind: "blocked";
      reason:
        | "invalid_snapshot"
        | "not_partition_head"
        | "runtime_inactive"
        | "runtime_revision_mismatch"
        | "retry_not_due"
        | "lease_owned"
        | "automatic_provider_budget_exhausted"
        | "terminal_partition_head";
    };

export interface PlanSlackBridgePartitionWorkInput {
  delivery: SlackBridgeOutboundDeliverySnapshot;
  partitionCursorPosition: number;
  currentRuntimeRevision: string;
  runtimeActive: boolean;
  skipReceipt?: SlackBridgeExplicitSkipReceipt | null;
  now: Date;
}

export type SlackBridgeProviderAttemptResult =
  | { kind: "pre_io_lease_reclaimed" }
  | { kind: "accepted"; reconciled?: boolean }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_failure"; baseDelayMs: number; jitterUnit: number }
  | { kind: "deterministic_failure" }
  | { kind: "outcome_ambiguous" };

export interface SlackBridgeProviderAttemptTransition {
  state: SlackBridgeOutboundDeliveryState;
  providerAttempts: number;
  ambiguityBudgetProviderAttempts: number;
  dispatchedFailureAttempts: number;
  firstDispatchedAt: string | null;
  nextAttemptAt: string | null;
  automaticRedispatchAllowed: boolean;
  reason:
    | "lease_reclaimed_before_provider_io"
    | "provider_accepted"
    | "provider_rate_limited"
    | "provider_transient_failure"
    | "deterministic_failure"
    | "failure_budget_exhausted"
    | "age_budget_exhausted"
    | "provider_outcome_ambiguous"
    | "provider_reconciled";
}

export interface SlackBridgeExplicitSkipReceipt {
  logicalDeliveryId: string;
  bindingId: string;
  bindingEpoch: number;
  partitionPosition: number;
  actorId: string;
  reason: string;
  decisionRevision: number;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSlackBridgeOutboundDeliveryState(
  value: unknown,
): value is SlackBridgeOutboundDeliveryState {
  return typeof value === "string"
    && (SLACK_BRIDGE_OUTBOUND_DELIVERY_STATES as readonly string[]).includes(value);
}

function stateRequiresProviderAttemptEvidence(
  state: SlackBridgeOutboundDeliveryState,
): boolean {
  return state === "accepted"
    || state === "retry_wait"
    || state === "outcome_unknown"
    || state === "dead";
}

function validSnapshot(snapshot: SlackBridgeOutboundDeliverySnapshot): boolean {
  const firstDispatchedAt = parseTimestamp(snapshot.firstDispatchedAt);
  const nextAttemptAt = parseTimestamp(snapshot.nextAttemptAt);
  return snapshot.logicalDeliveryId.trim().length > 0
    && snapshot.bindingId.trim().length > 0
    && isPositiveInteger(snapshot.bindingEpoch)
    && isPositiveInteger(snapshot.partitionPosition)
    && snapshot.enqueueRuntimeRevision.trim().length > 0
    && isSlackBridgeOutboundDeliveryState(snapshot.state)
    && isNonNegativeInteger(snapshot.providerAttempts)
    && isNonNegativeInteger(snapshot.ambiguityBudgetProviderAttempts)
    && snapshot.ambiguityBudgetProviderAttempts <= snapshot.providerAttempts
    && isNonNegativeInteger(snapshot.dispatchedFailureAttempts)
    && snapshot.dispatchedFailureAttempts <= snapshot.providerAttempts
    && (snapshot.firstDispatchedAt === null || firstDispatchedAt !== null)
    && (snapshot.nextAttemptAt === null || nextAttemptAt !== null)
    && (snapshot.providerAttempts === 0
      ? snapshot.firstDispatchedAt === null
      : snapshot.firstDispatchedAt !== null)
    && (!stateRequiresProviderAttemptEvidence(snapshot.state)
      || snapshot.providerAttempts > 0)
    && (snapshot.state === "retry_wait"
      ? snapshot.nextAttemptAt !== null
      : snapshot.nextAttemptAt === null);
}

/**
 * The worker calls this with the durable partition cursor and authoritative
 * current runtime decision. A later row can never bypass the unresolved head.
 */
export function planSlackBridgePartitionWork(
  input: PlanSlackBridgePartitionWorkInput,
): SlackBridgePartitionWorkPlan {
  const { delivery } = input;
  if (
    !validSnapshot(delivery)
    || !isNonNegativeInteger(input.partitionCursorPosition)
    || !Number.isFinite(input.now.getTime())
  ) {
    return { kind: "blocked", reason: "invalid_snapshot" };
  }

  if (delivery.partitionPosition !== input.partitionCursorPosition + 1) {
    return { kind: "blocked", reason: "not_partition_head" };
  }
  if (delivery.state === "accepted") {
    return { kind: "advance_cursor" };
  }
  if (delivery.state === "skipped") {
    return canAdvanceSlackBridgePartitionCursor({
      delivery,
      skipReceipt: input.skipReceipt,
    })
      ? { kind: "advance_cursor" }
      : { kind: "blocked", reason: "terminal_partition_head" };
  }
  if (
    delivery.state === "not_queued"
    || delivery.state === "dead"
    || delivery.state === "revoked"
    || delivery.state === "quarantined"
  ) {
    return { kind: "blocked", reason: "terminal_partition_head" };
  }
  if (!input.runtimeActive) {
    return { kind: "blocked", reason: "runtime_inactive" };
  }
  if (delivery.enqueueRuntimeRevision !== input.currentRuntimeRevision) {
    return { kind: "blocked", reason: "runtime_revision_mismatch" };
  }

  switch (delivery.state) {
    case "queued":
      return delivery.ambiguityBudgetProviderAttempts
        < SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY
        ? { kind: "dispatch" }
        : { kind: "blocked", reason: "automatic_provider_budget_exhausted" };
    case "retry_wait": {
      const nextAttemptAt = parseTimestamp(delivery.nextAttemptAt);
      if (nextAttemptAt === null) return { kind: "blocked", reason: "invalid_snapshot" };
      if (
        delivery.ambiguityBudgetProviderAttempts
        >= SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY
      ) {
        return { kind: "blocked", reason: "automatic_provider_budget_exhausted" };
      }
      return nextAttemptAt <= input.now.getTime()
        ? { kind: "dispatch" }
        : { kind: "blocked", reason: "retry_not_due" };
    }
    case "dispatching":
      return { kind: "blocked", reason: "lease_owned" };
    case "outcome_unknown":
      return {
        kind: "reconcile_or_redispatch",
        automaticRedispatchAllowed:
          delivery.ambiguityBudgetProviderAttempts
            < SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY
          && !ageBudgetExhausted(
            parseTimestamp(delivery.firstDispatchedAt) ?? input.now.getTime(),
            input.now.getTime(),
          ),
      };
  }
}

function firstDispatchMs(snapshot: SlackBridgeOutboundDeliverySnapshot, nowMs: number): number {
  return parseTimestamp(snapshot.firstDispatchedAt) ?? nowMs;
}

function ageBudgetExhausted(firstDispatchMsValue: number, nowMs: number): boolean {
  return nowMs - firstDispatchMsValue >= SLACK_BRIDGE_MAX_DELIVERY_AGE_MS;
}

function withProviderAttempt(
  snapshot: SlackBridgeOutboundDeliverySnapshot,
  nowMs: number,
): {
  providerAttempts: number;
  firstDispatchedAt: string;
  firstDispatchedAtMs: number;
} {
  const firstDispatchedAtMs = firstDispatchMs(snapshot, nowMs);
  return {
    providerAttempts: snapshot.providerAttempts + 1,
    firstDispatchedAt: new Date(firstDispatchedAtMs).toISOString(),
    firstDispatchedAtMs,
  };
}

/**
 * Applies one closed provider-attempt result. The caller must first persist a
 * `dispatching` lease; a reclaimed lease before provider I/O is the sole event
 * here that consumes no provider/failure/ambiguity budget.
 */
export function applySlackBridgeProviderAttemptResult(
  snapshot: SlackBridgeOutboundDeliverySnapshot,
  result: SlackBridgeProviderAttemptResult,
  now: Date,
): SlackBridgeProviderAttemptTransition {
  if (!validSnapshot(snapshot) || snapshot.state !== "dispatching" || !Number.isFinite(now.getTime())) {
    throw new Error("Slack Bridge provider attempt requires a valid dispatching snapshot");
  }

  if (result.kind === "pre_io_lease_reclaimed") {
    return {
      state: "queued",
      providerAttempts: snapshot.providerAttempts,
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts,
      dispatchedFailureAttempts: snapshot.dispatchedFailureAttempts,
      firstDispatchedAt: snapshot.firstDispatchedAt,
      nextAttemptAt: null,
      automaticRedispatchAllowed: false,
      reason: "lease_reclaimed_before_provider_io",
    };
  }

  const nowMs = now.getTime();
  const attempt = withProviderAttempt(snapshot, nowMs);
  const base = {
    providerAttempts: attempt.providerAttempts,
    firstDispatchedAt: attempt.firstDispatchedAt,
  };

  if (result.kind === "accepted") {
    return {
      ...base,
      state: "accepted",
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts + 1,
      dispatchedFailureAttempts: snapshot.dispatchedFailureAttempts,
      nextAttemptAt: null,
      automaticRedispatchAllowed: false,
      reason: result.reconciled ? "provider_reconciled" : "provider_accepted",
    };
  }

  if (ageBudgetExhausted(attempt.firstDispatchedAtMs, nowMs)) {
    const dispatchedFailureAttempts = snapshot.dispatchedFailureAttempts
      + (result.kind === "transient_failure" || result.kind === "deterministic_failure" ? 1 : 0);
    return {
      ...base,
      state: "dead",
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts
        + (result.kind === "rate_limited" ? 0 : 1),
      dispatchedFailureAttempts,
      nextAttemptAt: null,
      automaticRedispatchAllowed: false,
      reason: "age_budget_exhausted",
    };
  }

  if (result.kind === "rate_limited") {
    if (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0) {
      throw new Error("Slack Bridge Retry-After must be a non-negative finite duration");
    }
    return {
      ...base,
      state: "retry_wait",
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts,
      dispatchedFailureAttempts: snapshot.dispatchedFailureAttempts,
      nextAttemptAt: new Date(nowMs + result.retryAfterMs).toISOString(),
      automaticRedispatchAllowed: false,
      reason: "provider_rate_limited",
    };
  }

  if (result.kind === "deterministic_failure") {
    return {
      ...base,
      state: "dead",
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts + 1,
      dispatchedFailureAttempts: snapshot.dispatchedFailureAttempts + 1,
      nextAttemptAt: null,
      automaticRedispatchAllowed: false,
      reason: "deterministic_failure",
    };
  }

  if (result.kind === "outcome_ambiguous") {
    const ambiguityBudgetProviderAttempts = snapshot.ambiguityBudgetProviderAttempts + 1;
    return {
      ...base,
      state: "outcome_unknown",
      ambiguityBudgetProviderAttempts,
      dispatchedFailureAttempts: snapshot.dispatchedFailureAttempts,
      nextAttemptAt: null,
      automaticRedispatchAllowed:
        ambiguityBudgetProviderAttempts
          < SLACK_BRIDGE_MAX_AUTOMATIC_PROVIDER_ATTEMPTS_AFTER_AMBIGUITY,
      reason: "provider_outcome_ambiguous",
    };
  }

  if (
    !Number.isFinite(result.baseDelayMs)
    || result.baseDelayMs < 0
    || !Number.isFinite(result.jitterUnit)
    || result.jitterUnit < 0
    || result.jitterUnit >= 1
  ) {
    throw new Error("Slack Bridge retry requires finite base delay and jitter in [0, 1)");
  }

  const dispatchedFailureAttempts = snapshot.dispatchedFailureAttempts + 1;
  if (dispatchedFailureAttempts >= SLACK_BRIDGE_MAX_FAILURE_ATTEMPTS) {
    return {
      ...base,
      state: "dead",
      ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts + 1,
      dispatchedFailureAttempts,
      nextAttemptAt: null,
      automaticRedispatchAllowed: false,
      reason: "failure_budget_exhausted",
    };
  }

  const exponentialCeiling = Math.min(
    SLACK_BRIDGE_MAX_RETRY_DELAY_MS,
    result.baseDelayMs * (2 ** Math.max(0, dispatchedFailureAttempts - 1)),
  );
  const retryDelayMs = Math.floor(exponentialCeiling * result.jitterUnit);
  return {
    ...base,
    state: "retry_wait",
    ambiguityBudgetProviderAttempts: snapshot.ambiguityBudgetProviderAttempts + 1,
    dispatchedFailureAttempts,
    nextAttemptAt: new Date(nowMs + retryDelayMs).toISOString(),
    automaticRedispatchAllowed: false,
    reason: "provider_transient_failure",
  };
}

/**
 * Cursor movement is exact: acceptance advances directly; a skip advances only
 * with an actor/reason-audited receipt bound to the same logical delivery and
 * immutable partition coordinates. Unknown/dead never advance on their own.
 */
export function canAdvanceSlackBridgePartitionCursor(input: {
  delivery: SlackBridgeOutboundDeliverySnapshot;
  skipReceipt?: SlackBridgeExplicitSkipReceipt | null;
}): boolean {
  const { delivery, skipReceipt } = input;
  if (!validSnapshot(delivery)) return false;
  if (delivery.state === "accepted") return true;
  if (delivery.state !== "skipped" || !skipReceipt) return false;
  return skipReceipt.logicalDeliveryId === delivery.logicalDeliveryId
    && skipReceipt.bindingId === delivery.bindingId
    && skipReceipt.bindingEpoch === delivery.bindingEpoch
    && skipReceipt.partitionPosition === delivery.partitionPosition
    && skipReceipt.actorId.trim().length > 0
    && skipReceipt.reason.trim().length > 0
    && isPositiveInteger(skipReceipt.decisionRevision);
}
