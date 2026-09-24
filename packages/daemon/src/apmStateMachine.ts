import { createHash } from "node:crypto";
import { normalizeActivity } from "@botiverse/raft-shared";
import type { AgentActivityDetailKind, AgentActivityKind, MachineToServerMessage } from "@botiverse/raft-shared";
export {
  buildApmFreshnessDecisionProducerFactId,
  projectApmFreshnessDecisionTrace,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
} from "@botiverse/raft-shared";
export type {
  ApmFreshnessDecisionProducerInput,
  ApmFreshnessHeldDecision,
  ApmFreshnessSideEffectAction,
  ApmFreshnessDecisionTraceProjection,
  ApmHeldFreshnessActivityEntry,
  ApmHeldFreshnessActivityProjection,
  ApmHeldFreshnessEnvelopeBody,
  ApmHeldFreshnessEnvelopeProjection,
} from "@botiverse/raft-shared";

export type AgentActivityMessage = Extract<MachineToServerMessage, { type: "agent:activity" }>;

function projectTraceActivityFromFact(detailKind: AgentActivityDetailKind | undefined): AgentActivityKind {
  switch (detailKind) {
    case "thinking_started":
      return "thinking";
    case "runtime_error":
    case "runtime_stalled":
    case "computer_operation_failed":
      return "error";
    case "runtime_crashed":
    case "runtime_unavailable":
    case "stopped":
    case "runtime_interrupted":
    case "machine_disconnected":
      return "offline";
    case "idle":
    case "ready":
    case "computer_started":
    case "computer_restarted":
    case "computer_upgraded":
    case "synthetic_repair":
      return "online";
    default:
      return "working";
  }
}

export type ApmTraceInputKind = "RuntimeStart" | "ParsedEvent" | "Delivery" | "Timer" | "ProcessSignal";

export interface ApmTraceInputRow {
  seq: number;
  scenario: string;
  correlationId: string;
  inputKind: ApmTraceInputKind;
  inputId: string;
  driver?: string;
  summary: string;
}

export type ApmTraceEffectRow =
  | {
    effectId: string;
    kind: "activity";
    reason: string;
    target: "activity-projector";
    clauseId: "SMR-002";
  }
  | {
    effectId: string;
    kind: "notify_stdin" | "deliver_stdin";
    reason: ApmGatedFlushReason;
    target: "runtime-stdin";
    stdinMode: "busy" | "idle";
    payloadHash: string;
    clauseId: "SMR-002";
  };

export type ApmGatedSteeringEffect =
  | {
    kind: "notify_stdin";
    reason: Exclude<ApmGatedFlushReason, "turn_end">;
    stdinMode: "busy";
    clauseId: "SMR-002";
  }
  | {
    kind: "deliver_stdin";
    reason: "turn_end";
    stdinMode: "idle";
    clauseId: "SMR-002";
  };

export interface ApmTraceProjectorOutputRow {
  projectorId: string;
  projector: "activity-sequence";
  surface: "agent:activity";
  payloadHash: string;
  producerFactId: string;
  sourceEffectId: string;
  clauseId: "SMR-003";
}

export interface ApmTraceTransitionRow {
  seq: number;
  scenario: string;
  correlationId: string;
  inputId: string;
  inputKind: ApmTraceInputKind;
  previousStateHash: string;
  nextStateHash: string;
  effects: ApmTraceEffectRow[];
  projectorOutputs: ApmTraceProjectorOutputRow[];
}

export type ApmGatedFlushReason = "compaction_finished" | "review_finished" | "turn_end";
export type ApmExpectedTerminationReason = "turn_end" | "stalled_recovery" | "startup_timeout" | "startup_request_error" | null;

export interface ApmGatedSteeringDecisionState {
  isIdle: boolean;
  expectedTerminationReason: ApmExpectedTerminationReason;
  outstandingToolUses: number;
  compacting: boolean;
  reviewing?: boolean;
}

export interface AgentActivitySequenceEntry {
  producerFactId: string;
  agentId: string;
  activityKind: AgentActivityKind;
  activity: string;
  detail: string;
  detailKind?: AgentActivityDetailKind;
  clientSeq?: number;
  launchId?: string;
}

export interface AgentActivitySequenceSnapshot {
  clauseId: "SMR-003";
  scenario: string;
  correlationId: string;
  producerFactIds: string[];
  sequence: AgentActivitySequenceEntry[];
}

export interface ApmDecisionState {
  stateHash: string;
  gatedSteering: ApmGatedSteeringDecisionState;
}

export interface ApmActivityProjectionInput {
  transitionSeq: number;
  scenario: string;
  correlationId: string;
  inputId: string;
  inputKind: ApmTraceInputKind;
  inputSummary: string;
  message: AgentActivityMessage;
}

export interface ApmActivityProjectionReduction {
  nextState: ApmDecisionState;
  transition: ApmTraceTransitionRow;
  snapshotEntry: AgentActivitySequenceEntry;
}

export interface ApmToolUseReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmIdleStateReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmGatedCompactionReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmGatedCompactionBoundaryFlushReduction {
  effects: ApmGatedSteeringEffect[];
}

export interface ApmGatedReviewReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmGatedTurnEndReduction {
  nextState: ApmGatedSteeringDecisionState;
  effects: ApmGatedSteeringEffect[];
}

export type ApmStalledRecoveryBlockReason =
  | "empty_inbox"
  | "runtime_not_restartable"
  | "runtime_progress_recent";

export interface ApmStalledRecoveryTerminationReduction {
  nextState: ApmGatedSteeringDecisionState;
  shouldTerminate: boolean;
  alreadyRecovering: boolean;
  blockedReason: ApmStalledRecoveryBlockReason | null;
}

export type ApmStartupTimeoutBlockReason = "runtime_progress_started";

export interface ApmStartupTimeoutTerminationReduction {
  nextState: ApmGatedSteeringDecisionState;
  shouldTerminate: boolean;
  blockedReason: ApmStartupTimeoutBlockReason | null;
}

export interface ApmStartupRequestErrorTerminationReduction {
  nextState: ApmGatedSteeringDecisionState;
  shouldTerminate: true;
}

export interface ApmGatedErrorReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmGatedAssistantContinuationReduction {
  nextState: ApmGatedSteeringDecisionState;
}

export interface ApmControlPlaneEventReduction {
  nextState: ApmGatedSteeringDecisionState;
  shouldTerminate: false;
  shouldAffectRuntimeState: false;
}

export type ApmRuntimeTerminationReason = "startup_timeout" | "stalled_recovery" | "turn_end";
export type ApmRuntimeTerminationTraceEventName = "runtime.start.timeout" | "runtime.progress.stalled";
export type ApmRuntimeTerminationRecoveryAction = "terminate_for_queued_message";

export interface ApmRuntimeStartupTimeoutTerminationTraceProjection {
  reason: "startup_timeout";
  runtimeEventName: "runtime.start.timeout";
  runtimeEventAttrs: Record<string, unknown>;
  runtimeSpanAttrs: Record<string, unknown>;
  processExitAttrs: Record<string, unknown>;
  runtimeStopReason: "startup_timeout";
}

export interface ApmRuntimeStalledRecoveryTerminationTraceProjection {
  reason: "stalled_recovery";
  runtimeEventName: "runtime.progress.stalled";
  runtimeEventAttrs: Record<string, unknown>;
  runtimeSpanAttrs: Record<string, unknown>;
  processExitAttrs: Record<string, unknown>;
  runtimeStopReason: "stalled_recovery";
}

export interface ApmRuntimeTurnEndTerminationTraceProjection {
  reason: "turn_end";
  processExitAttrs: Record<string, unknown>;
  runtimeStopReason: "turn_end";
}

export interface ApmRuntimeProgressStalledTraceProjection {
  runtimeEventName: "runtime.progress.stalled";
  runtimeEventAttrs: Record<string, unknown>;
  runtimeSpanAttrs: Record<string, unknown>;
}

export type ApmRuntimeStallTurnReason = "harness_post_tool_silent_wedge" | "no_runtime_events";

export interface ApmRuntimeStallDiagnosticProjection {
  detail: string;
  turnReason: ApmRuntimeStallTurnReason;
  lastActivityDetailPresent: boolean;
  lastActivityDetailKind: AgentActivityDetailKind | undefined;
  traceAttrs: Record<string, unknown>;
}

export type ApmRuntimeTerminationTraceProjection =
  | ApmRuntimeStartupTimeoutTerminationTraceProjection
  | ApmRuntimeStalledRecoveryTerminationTraceProjection
  | ApmRuntimeTurnEndTerminationTraceProjection;

export interface ApmRuntimeStartupTimeoutTerminationTraceProjectionInput {
  reason: "startup_timeout";
  timeoutMs: number;
}

export interface ApmRuntimeStalledRecoveryTerminationTraceProjectionInput {
  reason: "stalled_recovery";
  turnReason: string;
  staleForMs: number;
  lastActivity: AgentActivityKind;
  lastActivityDetailPresent: boolean;
  lastActivityDetailKind: AgentActivityDetailKind | undefined;
  pendingMessages: number;
  recoveryAction: ApmRuntimeTerminationRecoveryAction;
}

export interface ApmRuntimeTurnEndTerminationTraceProjectionInput {
  reason: "turn_end";
}

export type ApmRuntimeTerminationTraceProjectionInput =
  | ApmRuntimeStartupTimeoutTerminationTraceProjectionInput
  | ApmRuntimeStalledRecoveryTerminationTraceProjectionInput
  | ApmRuntimeTurnEndTerminationTraceProjectionInput;

export interface ApmRuntimeProgressStalledTraceProjectionInput {
  turnReason: string;
  staleForMs: number;
  lastActivity: AgentActivityKind;
  lastActivityDetailPresent: boolean;
  lastActivityDetailKind: AgentActivityDetailKind | undefined;
}

export interface ApmRuntimeStallDiagnosticProjectionInput {
  staleForMs: number;
  staleForMinutes: number;
  lastActivityKind: AgentActivityKind;
  lastActivity: string;
  lastActivityDetail: string | null | undefined;
  lastActivityDetailKind: AgentActivityDetailKind | undefined;
  runtimeProgressLastEventKind: string | null | undefined;
  runtime: string;
  model: string;
  platform: string;
  arch: string;
  launchId: string | null | undefined;
  sessionIdPresent: boolean;
  inboxCount: number;
  pendingNotificationCount: number;
  processPidPresent: boolean;
  driverBusyDeliveryMode: string;
  supportsStdinNotification: boolean;
  outstandingToolUses: number;
  compacting: boolean;
  reviewing?: boolean;
  recentStderrCount: number;
  recentStdoutCount: number;
  runtimeTraceCounterAttrs?: Record<string, unknown>;
}

function reviewStatePatch(
  state: ApmGatedSteeringDecisionState,
): Pick<ApmGatedSteeringDecisionState, "reviewing"> | Record<string, never> {
  return state.reviewing !== undefined ? { reviewing: state.reviewing } : {};
}

export function createInitialApmDecisionState(): ApmDecisionState {
  return {
    stateHash: "apm:legacy:opaque:start",
    gatedSteering: createInitialApmGatedSteeringState(),
  };
}

export function createInitialApmGatedSteeringState(): ApmGatedSteeringDecisionState {
  return {
    isIdle: false,
    expectedTerminationReason: null,
    outstandingToolUses: 0,
    compacting: false,
  };
}

export function commitApmGatedSteeringDecisionState(
  nextState: ApmGatedSteeringDecisionState,
): ApmGatedSteeringDecisionState {
  const committed: ApmGatedSteeringDecisionState = {
    isIdle: nextState.isIdle,
    expectedTerminationReason: nextState.expectedTerminationReason,
    outstandingToolUses: nextState.outstandingToolUses,
    compacting: nextState.compacting,
  };
  if (nextState.reviewing !== undefined) {
    committed.reviewing = nextState.reviewing;
  }
  return committed;
}

export function reduceApmIdleState(
  state: ApmGatedSteeringDecisionState,
  input: { isIdle: boolean },
): ApmIdleStateReduction {
  return {
    nextState: {
      ...state,
      isIdle: input.isIdle,
    },
  };
}

export function reduceApmToolUse(
  state: ApmGatedSteeringDecisionState,
  input: { kind: "tool_call" | "tool_output" },
): ApmToolUseReduction {
  if (input.kind === "tool_call") {
    return {
      nextState: {
        isIdle: false,
        expectedTerminationReason: state.expectedTerminationReason,
        outstandingToolUses: state.outstandingToolUses + 1,
        compacting: state.compacting,
        ...reviewStatePatch(state),
      },
    };
  }

  const hadOutstandingToolUse = state.outstandingToolUses > 0;
  const outstandingToolUses = Math.max(0, state.outstandingToolUses - 1);
  return {
    nextState: {
      isIdle: false,
      expectedTerminationReason: state.expectedTerminationReason,
      outstandingToolUses,
      compacting: state.compacting,
      ...reviewStatePatch(state),
    },
  };
}

export function reduceApmGatedCompaction(
  state: ApmGatedSteeringDecisionState,
  input: { kind: "compaction_started" | "compaction_finished" | "compaction_interrupted" },
): ApmGatedCompactionReduction {
  if (input.kind === "compaction_started") {
    return {
      nextState: {
        isIdle: false,
        expectedTerminationReason: state.expectedTerminationReason,
        outstandingToolUses: state.outstandingToolUses,
        compacting: true,
        ...reviewStatePatch(state),
      },
    };
  }

  if (input.kind === "compaction_interrupted") {
    return {
      nextState: {
        isIdle: false,
        expectedTerminationReason: state.expectedTerminationReason,
        outstandingToolUses: state.outstandingToolUses,
        compacting: false,
        ...reviewStatePatch(state),
      },
    };
  }

  return {
    nextState: {
      isIdle: false,
      expectedTerminationReason: state.expectedTerminationReason,
      outstandingToolUses: state.outstandingToolUses,
      compacting: false,
      ...reviewStatePatch(state),
    },
  };
}

export function reduceApmGatedReview(
  state: ApmGatedSteeringDecisionState,
  input: { kind: "review_started" | "review_finished" },
): ApmGatedReviewReduction {
  if (input.kind === "review_started") {
    return {
      nextState: {
        isIdle: false,
        expectedTerminationReason: state.expectedTerminationReason,
        outstandingToolUses: state.outstandingToolUses,
        compacting: state.compacting,
        reviewing: true,
      },
    };
  }

  return {
    nextState: {
      isIdle: false,
      expectedTerminationReason: state.expectedTerminationReason,
      outstandingToolUses: state.outstandingToolUses,
      compacting: state.compacting,
      reviewing: false,
    },
  };
}

export function reduceApmGatedCompactionBoundaryFlush(
  _state: ApmGatedSteeringDecisionState,
  input: {
    hasSession: boolean;
    supportsStdinNotification: boolean;
    inboxLength: number;
    pendingNotificationCount: number;
  },
): ApmGatedCompactionBoundaryFlushReduction {
  if (!input.hasSession || !input.supportsStdinNotification || input.inboxLength === 0) {
    return { effects: [] };
  }
  if (input.pendingNotificationCount === 0) return { effects: [] };
  return {
    effects: [{
      kind: "notify_stdin",
      reason: "compaction_finished",
      stdinMode: "busy",
      clauseId: "SMR-002",
    }],
  };
}

export function reduceApmGatedReviewBoundaryFlush(
  _state: ApmGatedSteeringDecisionState,
  input: {
    hasSession: boolean;
    supportsStdinNotification: boolean;
    inboxLength: number;
    pendingNotificationCount: number;
  },
): ApmGatedCompactionBoundaryFlushReduction {
  if (!input.hasSession || !input.supportsStdinNotification || input.inboxLength === 0) {
    return { effects: [] };
  }
  if (input.pendingNotificationCount === 0) return { effects: [] };
  return {
    effects: [{
      kind: "notify_stdin",
      reason: "review_finished",
      stdinMode: "busy",
      clauseId: "SMR-002",
    }],
  };
}

export function reduceApmGatedTurnEnd(
  _state: ApmGatedSteeringDecisionState,
  input: {
    inboxLength?: number;
    supportsStdinNotification?: boolean;
    hasSession?: boolean;
    canDeliverWithoutSession?: boolean;
    terminateProcessOnTurnEnd?: boolean;
  } = {},
): ApmGatedTurnEndReduction {
  const shouldDeliverQueuedMessages = Boolean(
    input.inboxLength
      && input.inboxLength > 0
      && input.supportsStdinNotification
      && (input.hasSession || input.canDeliverWithoutSession),
  );
  return {
    nextState: {
      isIdle: !shouldDeliverQueuedMessages,
      expectedTerminationReason: input.terminateProcessOnTurnEnd === true ? "turn_end" : _state.expectedTerminationReason,
      outstandingToolUses: 0,
      compacting: false,
      ...(_state.reviewing !== undefined ? { reviewing: false } : {}),
    },
    effects: shouldDeliverQueuedMessages
      ? [{
        kind: "deliver_stdin",
        reason: "turn_end",
        stdinMode: "idle",
        clauseId: "SMR-002",
      }]
      : [],
  };
}

export function reduceApmGatedError(
  state: ApmGatedSteeringDecisionState,
  input: { terminalWakeable?: boolean } = {},
): ApmGatedErrorReduction {
  return {
    nextState: {
      isIdle: input.terminalWakeable === true,
      expectedTerminationReason: state.expectedTerminationReason,
      outstandingToolUses: state.outstandingToolUses,
      compacting: false,
      ...(state.reviewing !== undefined ? { reviewing: false } : {}),
    },
  };
}

export function reduceApmGatedAssistantContinuation(
  state: ApmGatedSteeringDecisionState,
): ApmGatedAssistantContinuationReduction {
  return {
    nextState: {
      isIdle: false,
      expectedTerminationReason: state.expectedTerminationReason,
      outstandingToolUses: state.outstandingToolUses,
      compacting: state.compacting,
      ...reviewStatePatch(state),
    },
  };
}

export function reduceApmStalledRecoveryTermination(
  state: ApmGatedSteeringDecisionState,
  input: {
    inboxLength: number;
    supportsStdinNotification: boolean;
    busyDeliveryMode: "direct" | "notification" | "none";
    hasSession: boolean;
    hasDirectStdinRecoveryEvidence: boolean;
    runtimeProgressIsStale: boolean;
    staleForMs: number;
    staleThresholdMs: number;
  },
): ApmStalledRecoveryTerminationReduction {
  if (input.inboxLength === 0) {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: false, blockedReason: "empty_inbox" };
  }

  if (state.expectedTerminationReason === "stalled_recovery") {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: true, blockedReason: null };
  }

  const directStdinRuntime = input.supportsStdinNotification && input.busyDeliveryMode === "direct";
  const canRestartDirectStdinProcess = directStdinRuntime &&
    input.hasSession &&
    (state.outstandingToolUses === 0 || input.hasDirectStdinRecoveryEvidence);
  const canRestartStalledProcess = !input.supportsStdinNotification || canRestartDirectStdinProcess;
  if (!canRestartStalledProcess) {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: false, blockedReason: "runtime_not_restartable" };
  }

  if (input.staleForMs < input.staleThresholdMs && !input.runtimeProgressIsStale) {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: false, blockedReason: "runtime_progress_recent" };
  }

  return {
    nextState: {
      ...state,
      expectedTerminationReason: "stalled_recovery",
    },
    shouldTerminate: true,
    alreadyRecovering: false,
    blockedReason: null,
  };
}

export function reduceApmStartupTimeoutTermination(
  state: ApmGatedSteeringDecisionState,
  input: { hasRuntimeProgressEvent: boolean },
): ApmStartupTimeoutTerminationReduction {
  if (input.hasRuntimeProgressEvent) {
    return {
      nextState: state,
      shouldTerminate: false,
      blockedReason: "runtime_progress_started",
    };
  }

  return {
    nextState: {
      ...state,
      isIdle: false,
      expectedTerminationReason: "startup_timeout",
    },
    shouldTerminate: true,
    blockedReason: null,
  };
}

export function reduceApmStartupRequestErrorTermination(
  state: ApmGatedSteeringDecisionState,
): ApmStartupRequestErrorTerminationReduction {
  return {
    nextState: {
      ...state,
      isIdle: false,
      expectedTerminationReason: "startup_request_error",
    },
    shouldTerminate: true,
  };
}

export function reduceApmControlPlaneEvent(
  state: ApmGatedSteeringDecisionState,
  _input: { eventClass: "control_plane_reconnect" },
): ApmControlPlaneEventReduction {
  return {
    nextState: state,
    shouldTerminate: false,
    shouldAffectRuntimeState: false,
  };
}

export function projectApmRuntimeTerminationTrace(
  input: ApmRuntimeStartupTimeoutTerminationTraceProjectionInput,
): ApmRuntimeStartupTimeoutTerminationTraceProjection;
export function projectApmRuntimeTerminationTrace(
  input: ApmRuntimeStalledRecoveryTerminationTraceProjectionInput,
): ApmRuntimeStalledRecoveryTerminationTraceProjection;
export function projectApmRuntimeTerminationTrace(
  input: ApmRuntimeTurnEndTerminationTraceProjectionInput,
): ApmRuntimeTurnEndTerminationTraceProjection;
export function projectApmRuntimeTerminationTrace(
  input: ApmRuntimeTerminationTraceProjectionInput,
): ApmRuntimeTerminationTraceProjection {
  if (input.reason === "startup_timeout") {
    const attrs = {
      turn_outcome: "failed",
      turn_subtype: "runtime_stalled",
      turn_reason: "no_runtime_events",
      runtime_start_failure_kind: "runtime_start_timeout",
      timeout_ms: input.timeoutMs,
    };
    return {
      reason: input.reason,
      runtimeEventName: "runtime.start.timeout",
      runtimeEventAttrs: attrs,
      runtimeSpanAttrs: attrs,
      processExitAttrs: {
        stop_source: "startup_timeout",
        expectedTerminationReason: "startup_timeout",
        timeout_ms: input.timeoutMs,
      },
      runtimeStopReason: "startup_timeout",
    };
  }

  if (input.reason === "turn_end") {
    return {
      reason: input.reason,
      processExitAttrs: {
        stop_source: "turn_end",
        expectedTerminationReason: "turn_end",
      },
      runtimeStopReason: "turn_end",
    };
  }

  const eventAttrs = {
    turn_outcome: "failed",
    turn_subtype: "runtime_stalled",
    turn_reason: input.turnReason,
    pendingMessages: input.pendingMessages,
    recovery: input.recoveryAction,
  };
  return {
    reason: input.reason,
    runtimeEventName: "runtime.progress.stalled",
    runtimeEventAttrs: eventAttrs,
    runtimeSpanAttrs: {
      ...eventAttrs,
      ageMs: input.staleForMs,
      lastActivity: input.lastActivity,
      lastActivityDetailPresent: input.lastActivityDetailPresent,
      lastActivityDetailKind: input.lastActivityDetailKind,
    },
    processExitAttrs: {
      stop_source: "stalled_recovery",
      expectedTerminationReason: "stalled_recovery",
      queued_messages_count: input.pendingMessages,
    },
    runtimeStopReason: "stalled_recovery",
  };
}

export function projectApmRuntimeProgressStalledTrace(
  input: ApmRuntimeProgressStalledTraceProjectionInput,
): ApmRuntimeProgressStalledTraceProjection {
  const eventAttrs = {
    turn_outcome: "failed",
    turn_subtype: "runtime_stalled",
    turn_reason: input.turnReason,
  };
  return {
    runtimeEventName: "runtime.progress.stalled",
    runtimeEventAttrs: eventAttrs,
    runtimeSpanAttrs: {
      ...eventAttrs,
      ageMs: input.staleForMs,
      lastActivity: input.lastActivity,
      lastActivityDetailPresent: input.lastActivityDetailPresent,
      lastActivityDetailKind: input.lastActivityDetailKind,
    },
  };
}

type RuntimeToolDiagnosticActivityInput = {
  classification:
    | "running_with_recent_progress"
    | "running_no_observed_progress"
    | "completion_loss"
    | "pending_liveness_unknown"
    | "runtime_inactive_without_pending_tool"
    | "not_pending"
    | "unknown";
  toolAgeMs?: number;
  lastProgressAgeMs?: number;
};

function formatDiagnosticAge(ageMs: number | undefined): string {
  const boundedMs = Math.max(0, ageMs ?? 0);
  if (boundedMs < 60_000) return `${Math.max(1, Math.floor(boundedMs / 1_000))}s`;
  if (boundedMs < 3_600_000) return `${Math.floor(boundedMs / 60_000)}m`;
  return `${Math.floor(boundedMs / 3_600_000)}h`;
}

export function projectRuntimeToolDiagnosticActivity(
  snapshots: readonly RuntimeToolDiagnosticActivityInput[],
  legacyFallback: string,
): string {
  if (snapshots.length === 0) return legacyFallback;
  return snapshots.map((snapshot) => {
    switch (snapshot.classification) {
      case "running_with_recent_progress":
        return `Bash tool has been running for ${formatDiagnosticAge(snapshot.toolAgeMs)}; process is alive; progress observed ${formatDiagnosticAge(snapshot.lastProgressAgeMs)} ago.`;
      case "running_no_observed_progress":
        return `Bash tool has been running for ${formatDiagnosticAge(snapshot.toolAgeMs)}; process is alive; no output/update observed for ${formatDiagnosticAge(snapshot.lastProgressAgeMs ?? snapshot.toolAgeMs)}.`;
      case "completion_loss":
        return "Tool process exited, but the runtime has not completed the tool call.";
      case "pending_liveness_unknown":
        return "Tool call is pending, but process liveness is unavailable.";
      case "runtime_inactive_without_pending_tool":
        return "Runtime is inactive; no pending tool call was found.";
      case "not_pending":
        return "No pending tool call was found.";
      case "unknown":
        return "Tool call status is unavailable.";
    }
  }).join(" ");
}

export function projectApmRuntimeStallDiagnostic(
  input: ApmRuntimeStallDiagnosticProjectionInput,
): ApmRuntimeStallDiagnosticProjection {
  const context: string[] = [];
  const lastActivityDetailKind = input.lastActivityDetail ? input.lastActivityDetailKind : undefined;
  if (input.lastActivityDetail) {
    context.push(`after ${input.lastActivityDetail}`);
  }
  if (input.outstandingToolUses > 0) {
    context.push(`tools=${input.outstandingToolUses}`);
  }
  if (input.compacting) {
    context.push("compacting");
  }
  if (input.reviewing) {
    context.push("reviewing");
  }
  if (input.inboxCount > 0) {
    context.push(`queued=${input.inboxCount}`);
  }

  const detail = [
    `Runtime stalled: no runtime events for ${input.staleForMinutes}m`,
    context.length > 0 ? ` (${context.join(", ")})` : "",
  ].join("");
  const turnReason: ApmRuntimeStallTurnReason =
    input.runtimeProgressLastEventKind === "tool_output" && input.outstandingToolUses === 0
      ? "harness_post_tool_silent_wedge"
      : "no_runtime_events";

  return {
    detail,
    turnReason,
    lastActivityDetailPresent: Boolean(input.lastActivityDetail),
    lastActivityDetailKind,
    traceAttrs: {
      ageMs: input.staleForMs,
      staleForMinutes: input.staleForMinutes,
      lastActivity: input.lastActivityKind,
      lastActivityDetailPresent: Boolean(input.lastActivityDetail),
      lastActivityDetailKind,
      runtime: input.runtime,
      model: input.model,
      platform: input.platform,
      arch: input.arch,
      launchId: input.launchId || undefined,
      sessionIdPresent: input.sessionIdPresent,
      inboxCount: input.inboxCount,
      pendingNotificationCount: input.pendingNotificationCount,
      processPidPresent: input.processPidPresent,
      busyDeliveryMode: input.driverBusyDeliveryMode,
      supportsStdinNotification: input.supportsStdinNotification,
      outstandingToolUses: input.outstandingToolUses,
      compacting: input.compacting,
      ...(input.reviewing === true ? { reviewing: true } : {}),
      recentStderrCount: input.recentStderrCount,
      recentStdoutCount: input.recentStdoutCount,
      ...(input.runtimeTraceCounterAttrs ?? {}),
    },
  };
}

export function reduceAgentActivityProjection(
  state: ApmDecisionState,
  input: ApmActivityProjectionInput,
): ApmActivityProjectionReduction {
  const producerFactId = `fact-${input.scenario}-${input.message.clientSeq ?? input.transitionSeq}`;
  const effectId = `effect-${input.scenario}-${input.transitionSeq}`;
  const projectorId = `projector-${input.scenario}-${input.transitionSeq}`;
  const activityKind = input.message.activityKind
    ?? (input.message.activity ? normalizeActivity(input.message.activity) : projectTraceActivityFromFact(input.message.detailKind));
  const payload = {
    agentId: input.message.agentId,
    activityKind,
    activity: input.message.activity,
    detail: input.message.detail,
    detailKind: input.message.detailKind,
    clientSeq: input.message.clientSeq,
    launchId: input.message.launchId,
  };
  const nextStateHash = `apm:${hashApmStable({ previousStateHash: state.stateHash, payload })}`;

  return {
    nextState: {
      stateHash: nextStateHash,
      gatedSteering: { ...state.gatedSteering },
    },
    transition: {
      seq: input.transitionSeq,
      scenario: input.scenario,
      correlationId: input.correlationId,
      inputId: input.inputId,
      inputKind: input.inputKind,
      previousStateHash: state.stateHash,
      nextStateHash,
      effects: [
        {
          effectId,
          kind: "activity",
          reason: input.inputSummary,
          target: "activity-projector",
          clauseId: "SMR-002",
        },
      ],
      projectorOutputs: [
        {
          projectorId,
          projector: "activity-sequence",
          surface: "agent:activity",
          payloadHash: hashApmStable(payload),
          producerFactId,
          sourceEffectId: effectId,
          clauseId: "SMR-003",
        },
      ],
    },
    snapshotEntry: {
      producerFactId,
      agentId: input.message.agentId,
      activityKind,
      activity: input.message.activity ?? activityKind,
      detail: input.message.detail,
      detailKind: input.message.detailKind,
      clientSeq: input.message.clientSeq,
      launchId: input.message.launchId,
    },
  };
}

export function hashApmStable(value: unknown): string {
  return createHash("sha256").update(stableStringifyApm(value)).digest("hex");
}

export function stableStringifyApm(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    normalized[key] = stableNormalize(child);
  }
  return normalized;
}
