// Design note: this reducer is the lifecycle semantic boundary documented in
// rfcs/031-agent-lifecycle-event-model-rfc.zh.html.
//
// Callers should feed canonical lifecycle events plus explicit current-state
// inputs into this file and receive projection plans back. This is where product
// semantics such as "Starting", "Stopped", "Runtime interrupted", wake
// eligibility, reset-window suppression, and Activity Log dedupe are decided.
// Do not reintroduce those decisions directly into AgentOrchestrator branches;
// keep legacy protocol translation in the adapter and side-effect writes in the
// projection writer.
//
// Source discussion: #proj-runtime:4dbe9aa7.
import type { AgentActivityDetailKind, AgentActivityKind, AgentStatus, DaemonTrajectoryEntry, TrajectoryEntry } from "@botiverse/raft-shared";
import type {
  AgentLifecycleEvent,
  AgentLifecycleEventType,
  AgentLifecycleProjectionOutcome,
  AgentLifecycleTraceAttrs,
} from "./agentLifecycleEvents.js";

export type LifecycleWakeBlockReason =
  | "control_gate"
  | "machine_unreachable"
  | "manual_stopped"
  | "reset_window";

export type LifecycleDbStatusProjection =
  | {
      kind: "apply";
      sessionId?: string;
      status: AgentStatus;
      writer: "direct" | "signal";
      attrs?: AgentLifecycleTraceAttrs;
    }
  | {
      kind: "skip";
      skippedReason: string;
      attrs?: AgentLifecycleTraceAttrs;
    };

export interface LifecycleWakeEligibilityProjection {
  eligible: boolean;
  blockReason?: LifecycleWakeBlockReason;
  attrs?: AgentLifecycleTraceAttrs;
}

export type LifecycleLiveActivityProjection =
  | {
      kind: "emit";
      activity: AgentActivityKind;
      detail: string;
      entries?: TrajectoryEntry[];
      dedupeKey?: string;
      detailKind: AgentActivityDetailKind;
      emitWhen?: "always" | "manual_or_stop_send_failed";
      nowOverride?: number;
      attrs?: AgentLifecycleTraceAttrs;
      /**
       * Daemon-side per-launch monotonic counter from the inbound
       * `agent:activity` message. Threaded through to the Socket.IO
       * `agent:activity` broadcast so feedback-export bundles preserve
       * the row-level join key against `server.agent.activity.ingest`.
       * Absent when the inbound daemon message omits it (older daemons
       * or non-daemon-sourced emits); never synthesized.
       * Leiysky #proj-daemon:f8397295 task #136, 2026-06-21.
       */
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      observedAtMs?: number;
      isHeartbeat?: boolean;
      arbitrationObservationClass?: LifecycleObservationClass;
      arbitrationSignalSite?: LifecycleShadowSignalSite;
      arbitrationPlanKind?: AgentLifecycleEventType;
    }
  | {
      kind: "ready_online";
      detailKind: "ready";
      attrs?: AgentLifecycleTraceAttrs;
    }
  | {
      kind: "skip";
      skippedReason: string;
      attrs?: AgentLifecycleTraceAttrs;
    };

export interface LifecycleActivityLogProjection {
  labelKind: string;
  dedupeKey?: string;
  skippedReason?: string;
  attrs?: AgentLifecycleTraceAttrs;
}

export interface LifecycleProjectionSideEffects {
  clearInbox?: boolean;
  clearLaunchGuard?: boolean;
  releaseWakeLock?: boolean;
  resolveStartingActivity?: boolean;
  sendStopToMachine?: "await" | "best_effort";
  terminalizeFreshnessHold?: "freshness_hold_terminalized";
  updateCache?: {
    machineId?: string | null;
    runtimeState?: LifecycleRuntimeState;
    sessionId?: string | null;
    status?: AgentStatus;
  };
}

export interface AgentLifecycleProjectionPlan {
  event: AgentLifecycleEvent;
  activityLog: LifecycleActivityLogProjection;
  dbStatus: LifecycleDbStatusProjection;
  liveActivity: LifecycleLiveActivityProjection;
  sideEffects?: LifecycleProjectionSideEffects;
  wakeEligibility: LifecycleWakeEligibilityProjection;
}

export type ReadyReconcileLifecycleAction =
  | "force-stop-and-stay-offline"
  | "mark-wakeable-not-running"
  | "mark-active-online"
  | "mark-inactive-offline"
  | "stay-offline";

export type LifecycleIntentState = "running_allowed" | "manual_stopped" | "deleted";
export type LifecycleMachineReachability = "reachable" | "unreachable" | "degraded" | "unknown";
export type LifecycleRuntimeState =
  | "not_running"
  | "starting"
  | "running_idle"
  | "working"
  | "thinking"
  | "interrupted"
  | "crashed"
  | "stalled"
  | "unknown";
export type LifecycleControlGate = "open" | "runtime_profile_migration" | "reset_window" | "zen_migrating";
export type RuntimeProfileControlGate = Extract<LifecycleControlGate, "open" | "runtime_profile_migration">;

export interface AgentLifecycleStateSnapshot {
  /**
   * In-memory state-machine input assembled from the existing physical stores.
   *
   * This is deliberately not a new persisted source of truth. Callers build it
   * from legacy `agents.status`, reset/migration gates, machine reachability,
   * runtime/session/launch facts, and pass it to the reducer as the explicit
   * state snapshot side of `state + event -> projection plan`.
   */
  controlGate: LifecycleControlGate;
  dbStatus: AgentStatus;
  intentState: LifecycleIntentState;
  launchId?: string | null;
  machineId?: string | null;
  machineReachability: LifecycleMachineReachability;
  resetMode: "restart" | "session" | "full" | null;
  runtimeState: LifecycleRuntimeState;
  sessionId?: string | null;
}

export function buildAgentLifecycleStateSnapshot(input: {
  controlGate?: LifecycleControlGate;
  dbStatus: AgentStatus;
  intentState?: LifecycleIntentState;
  launchId?: string | null;
  machineId?: string | null;
  machineReachability?: LifecycleMachineReachability;
  resetMode?: "restart" | "session" | "full" | null;
  runtimeState?: LifecycleRuntimeState;
  sessionId?: string | null;
}): AgentLifecycleStateSnapshot {
  const resetMode = input.resetMode ?? null;
  return {
    controlGate: input.controlGate ?? (resetMode ? "reset_window" : "open"),
    dbStatus: input.dbStatus,
    intentState: input.intentState ?? inferIntentState(input.dbStatus),
    launchId: input.launchId,
    machineId: input.machineId,
    machineReachability: input.machineReachability ?? "unknown",
    resetMode,
    runtimeState: input.runtimeState ?? inferRuntimeState(input.dbStatus),
    sessionId: input.sessionId,
  };
}

function inferIntentState(status: AgentStatus): LifecycleIntentState {
  if (status === "stopped") return "manual_stopped";
  return "running_allowed";
}

function inferRuntimeState(status: AgentStatus): LifecycleRuntimeState {
  if (status === "active") return "running_idle";
  return "not_running";
}

function stateWakeBlockReason(state: AgentLifecycleStateSnapshot): LifecycleWakeBlockReason | undefined {
  if (state.intentState === "manual_stopped" || state.dbStatus === "stopped") {
    return "manual_stopped";
  }
  if (state.controlGate === "reset_window" || state.resetMode) {
    return "reset_window";
  }
  if (state.controlGate === "runtime_profile_migration" || state.controlGate === "zen_migrating") {
    return "control_gate";
  }
  if (state.machineReachability === "unreachable") {
    return "machine_unreachable";
  }
  return undefined;
}

export interface WakePlanInput {
  state: AgentLifecycleStateSnapshot;
}

export type WakePlanAction =
  | "attempt-wake"
  | "suppress-control-gate"
  | "suppress-stopped"
  | "suppress-reset"
  | "deliver-directly";

export function planWakeAction(input: WakePlanInput): WakePlanAction {
  if (input.state.controlGate === "runtime_profile_migration" || input.state.controlGate === "zen_migrating") {
    return "suppress-control-gate";
  }
  if (input.state.dbStatus === "inactive") {
    return input.state.controlGate === "reset_window" || input.state.resetMode ? "suppress-reset" : "attempt-wake";
  }
  if (input.state.dbStatus === "stopped") {
    return "suppress-stopped";
  }
  // Active is the wake-allowed intent. If daemon ready/restart told us the
  // process is absent, a message should start it instead of being delivered to
  // a runtime that is not actually running.
  if (input.state.dbStatus === "active" && input.state.runtimeState === "not_running") {
    return input.state.controlGate === "reset_window" || input.state.resetMode ? "suppress-reset" : "attempt-wake";
  }
  return "deliver-directly";
}

function isResetWindowWithoutCurrentLaunchSignal(state: AgentLifecycleStateSnapshot): boolean {
  // Launch-guard acceptance runs before these planners. During reset, a signal
  // with launchId is therefore the new guarded launch confirmation; legacy or
  // stale reset-window signals arrive without an accepted launchId and stay
  // suppressed.
  return (state.controlGate === "reset_window" || Boolean(state.resetMode)) && !state.launchId;
}

export type DaemonReportedAgentStatus = "active" | "inactive" | null;

export interface StatusSignalPlanInput {
  reportedStatus: DaemonReportedAgentStatus;
  state: AgentLifecycleStateSnapshot;
}

export type StatusSignalPlanAction =
  | "ignore"
  | "ignore-and-release-wake-lock"
  | "persist-active"
  | "persist-inactive"
  | "persist-stopped";

export function planStatusSignalAction(input: StatusSignalPlanInput): StatusSignalPlanAction {
  if (!input.reportedStatus) return "ignore";

  if (input.reportedStatus === "active") {
    if (input.state.dbStatus === "stopped" || input.state.intentState === "manual_stopped") return "ignore-and-release-wake-lock";
    if (isResetWindowWithoutCurrentLaunchSignal(input.state)) return "ignore";
    return "persist-active";
  }

  return input.state.dbStatus === "stopped" ? "persist-stopped" : "persist-inactive";
}

export interface SessionSignalPlanInput {
  state: AgentLifecycleStateSnapshot;
}

export type SessionSignalPlanAction =
  | "ignore"
  | "ignore-and-release-wake-lock"
  | "persist-active-session";

export function planSessionSignalAction(input: SessionSignalPlanInput): SessionSignalPlanAction {
  if (input.state.dbStatus === "stopped" || input.state.intentState === "manual_stopped") {
    return "ignore-and-release-wake-lock";
  }
  if (isResetWindowWithoutCurrentLaunchSignal(input.state)) {
    return "ignore";
  }
  return "persist-active-session";
}

export interface ActivitySignalPlanInput {
  state: AgentLifecycleStateSnapshot;
}

export type ActivitySignalPlanAction = "ignore" | "broadcast-activity";

export function planActivitySignalAction(input: ActivitySignalPlanInput): ActivitySignalPlanAction {
  if (input.state.dbStatus === "stopped" || input.state.intentState === "manual_stopped") {
    return "ignore";
  }
  if (isResetWindowWithoutCurrentLaunchSignal(input.state)) {
    return "ignore";
  }
  return "broadcast-activity";
}

export interface StartProjectionInput {
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
}

export function reduceStartLifecycle(input: StartProjectionInput): AgentLifecycleProjectionPlan {
  return {
    event: input.event,
    sideEffects: {
      updateCache: { runtimeState: "starting", status: "active" },
    },
    dbStatus: {
      kind: "apply",
      status: "active",
      writer: "direct",
      attrs: {
        intent_state: "running_allowed",
        legacy_status: "active",
        previous_status: input.state.dbStatus,
        runtime_state: "starting",
      },
    },
    wakeEligibility: { eligible: true },
    liveActivity: {
      kind: "emit",
      activity: "working",
      detail: "Starting…",
      detailKind: "runtime_starting",
    },
    activityLog: {
      labelKind: "runtime_starting",
    },
  };
}

export interface DaemonActivityProjectionInput {
  action: ActivitySignalPlanAction;
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  entries?: TrajectoryEntry[];
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
  /**
   * Daemon socket-message join keys for the corresponding `agent:activity`
   * Socket.IO broadcast. Optional — older daemons leave them unset.
   * These fields are pure pass-through to the live socket payload; they
   * do NOT participate in dedup (server dedup keeps using the ingest generation+
   * launchId+clientSeq tracked separately in `lastClientSeqByActivityIngestKey`) and they
   * do NOT alter durable activity log persistence shape.
   * Leiysky #proj-daemon:f8397295 task #136, 2026-06-21.
   */
  launchId?: string;
  clientSeq?: number;
  probeId?: string;
  producerFactId?: string;
  observedAtMs?: number;
  isHeartbeat?: boolean;
  observationClass?: LifecycleObservationClass;
}

/**
 * Strong daemon detail kinds whose live activity is owned by the server
 * reducer. Keep this table exhaustive over the canonical set: producer-sent
 * activityKind is compatibility input only and cannot override these rows.
 */
export const CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND = {
  message_received: "working",
  freshness_hold: "working",
  starting: "working",
  runtime_starting: "working",
  idle: "online",
  running_command: "working",
  checking_messages: "working",
  compacting_context: "working",
  compaction_finished: "working",
  compaction_stale: "working",
  reviewing_changes: "working",
  review_finished: "working",
  review_stale: "working",
  runtime_reconnecting: "working",
  runtime_error: "error",
  runtime_crashed: "offline",
  runtime_unavailable: "offline",
  runtime_stalled: "error",
  stalled_recovery: "working",
  stopped: "offline",
  ready: "online",
  runtime_interrupted: "offline",
  machine_disconnected: "offline",
  computer_started: "online",
  computer_restarted: "online",
  computer_upgraded: "online",
  computer_operation_failed: "error",
  synthetic_repair: "online",
  system_message: "working",
  runtime_progress: "working",
  model_request_started: "working",
  model_response_started: "working",
  tool_started: "working",
  tool_end: "working",
  thinking_started: "thinking",
  thinking_end: "working",
  subagent_activity: "working",
} as const satisfies Partial<Record<AgentActivityDetailKind, AgentActivityKind>>;

export type CanonicalDaemonActivityDetailKind = keyof typeof CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND;

/**
 * Explicit registry of retired weak kinds. Current typed daemon frames using
 * any of these are rejected; only a detailKind-less legacy frame reaches the
 * one-version compatibility path in reduceDaemonActivitySignal.
 */
export const LEGACY_DAEMON_ACTIVITY_COMPAT_RULE_BY_DETAIL_KIND = {
  none: "reject_current_protocol",
  daemon_activity: "reject_current_protocol",
  external_activity: "reject_current_protocol",
  slock_action: "reject_current_protocol",
  other: "reject_current_protocol",
} as const satisfies Record<
  Exclude<AgentActivityDetailKind, CanonicalDaemonActivityDetailKind>,
  "reject_current_protocol"
>;

export type DaemonActivitySignalReduction = {
  activity: AgentActivityKind;
  detailKind: AgentActivityDetailKind;
  source: "canonical" | "legacy_detail_kind_missing";
};

export function reduceDaemonActivitySignal(input: {
  detailKind: AgentActivityDetailKind | undefined;
  legacyActivity?: AgentActivityKind;
}): DaemonActivitySignalReduction {
  // One-version deprecation window: only truly old, detailKind-less daemon
  // frames may retain their declared activity. An explicit weak kind is a
  // current-protocol violation and must not reopen producer authority.
  if (input.detailKind === undefined) {
    if (!input.legacyActivity) {
      throw new Error("Legacy daemon activity frame is missing activity");
    }
    return {
      activity: input.legacyActivity,
      detailKind: "other",
      source: "legacy_detail_kind_missing",
    };
  }
  if (input.detailKind in CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND) {
    const detailKind = input.detailKind as CanonicalDaemonActivityDetailKind;
    return {
      activity: CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND[detailKind],
      detailKind,
      source: "canonical",
    };
  }

  throw new Error(`Non-fact daemon activity detail kind: ${String(input.detailKind)}`);
}

/** Rewrite the daemon's optional legacy status conclusion from reducer truth. */
export function rewriteDaemonActivityEntries(
  entries: readonly DaemonTrajectoryEntry[] | undefined,
  signal: DaemonActivitySignalReduction,
): TrajectoryEntry[] | undefined {
  if (!entries) return undefined;
  return entries.map((entry): TrajectoryEntry => {
    if (entry.kind !== "status") return entry;
    const { activityKind: _activityKind, activity: _activity, ...fact } = entry;
    const entryActivity = fact.detailKind && fact.detailKind in CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND
      ? CANONICAL_DAEMON_ACTIVITY_BY_DETAIL_KIND[fact.detailKind as CanonicalDaemonActivityDetailKind]
      : signal.activity;
    return {
      ...fact,
      kind: "status",
      activity: entryActivity,
      activityKind: entryActivity,
    };
  });
}

export type RuntimeErrorActivityAction = "set" | "clear" | "preserve";

const RUNTIME_ERROR_SET_DETAIL_KINDS = new Set<CanonicalDaemonActivityDetailKind>([
  "runtime_error",
  "runtime_stalled",
]);

const RUNTIME_ERROR_CLEAR_DETAIL_KINDS = new Set<CanonicalDaemonActivityDetailKind>([
  "running_command",
  "checking_messages",
  "compacting_context",
  "compaction_finished",
  "reviewing_changes",
  "review_finished",
  "runtime_progress",
  "model_request_started",
  "model_response_started",
  "tool_started",
  "tool_end",
  "thinking_started",
  "thinking_end",
  "subagent_activity",
]);

export function reduceRuntimeErrorActivityAction(input: {
  signal: DaemonActivitySignalReduction;
  currentErrorPresent: boolean;
  isHeartbeat?: boolean;
  /** #688(b): a valid typed RuntimeErrorActivityDiagnostic carrier rode this
   * signal (already normalized server-side). Only that may let `runtime_crashed`
   * establish durable typed authority; without it, a crash is a weak signal that
   * can neither establish nor clear authority. */
  typedRuntimeCarrierPresent?: boolean;
}): RuntimeErrorActivityAction {
  if (input.signal.source === "canonical") {
    const detailKind = input.signal.detailKind as CanonicalDaemonActivityDetailKind;
    if (detailKind === "runtime_crashed") {
      // Crash is only an authority when a valid typed carrier proves the fact;
      // otherwise it is a weak offline signal that must not establish/clear.
      return input.typedRuntimeCarrierPresent ? "set" : "preserve";
    }
    if (RUNTIME_ERROR_SET_DETAIL_KINDS.has(detailKind)) return "set";
    if (
      input.currentErrorPresent
      && input.isHeartbeat === false
      && RUNTIME_ERROR_CLEAR_DETAIL_KINDS.has(detailKind)
    ) {
      return "clear";
    }
    return "preserve";
  }

  // A detailKind-less legacy frame may preserve its visible compatibility
  // projection for one version window, but its raw conclusion never mutates
  // durable runtime-error authority.
  return "preserve";
}

export function reduceDaemonActivityLifecycle(input: DaemonActivityProjectionInput): AgentLifecycleProjectionPlan {
  const wakeBlockReason = stateWakeBlockReason(input.state);
  const sourceProducerFactAttrs = sourceProducerFactTraceAttrs(input.producerFactId);
  if (input.action === "ignore") {
    return skippedSignalProjection(input.event, {
      blockReason: wakeBlockReason,
      eligible: !wakeBlockReason,
      skippedReason: wakeBlockReason === "manual_stopped"
        ? "manual_stopped_ignores_daemon_activity"
        : wakeBlockReason === "reset_window"
          ? "reset_window_ignores_daemon_activity"
          : "activity_signal_ignored",
      attrs: sourceProducerFactAttrs,
    });
  }

  const apmSourceFactAttrs = apmProducerFactTraceAttrs(input.entries);
  const liveRuntimeActivity =
    input.activity === "online" || input.activity === "thinking" || input.activity === "working";
  const shouldRestoreActiveStatus = input.state.dbStatus === "inactive" && liveRuntimeActivity;
  const runtimeState: LifecycleRuntimeState =
    input.activity === "online" ? "running_idle"
      : input.activity === "thinking" ? "thinking"
        : input.activity === "working" ? "working"
          : input.activity === "error" ? "crashed"
            : "interrupted";
  const dbStatus: LifecycleDbStatusProjection = shouldRestoreActiveStatus
    ? {
        kind: "apply",
        status: "active",
        writer: "signal",
        attrs: {
          activity_status: input.activity,
          legacy_status: input.state.dbStatus,
          runtime_state: input.state.runtimeState,
        },
      }
    : {
        kind: "skip",
        skippedReason: "daemon_activity_does_not_change_db_status",
        attrs: { activity_status: input.activity },
      };

  return {
    event: input.event,
    sideEffects: {
      updateCache: {
        runtimeState,
        ...(shouldRestoreActiveStatus ? { status: "active" as const } : {}),
      },
    },
    dbStatus,
    wakeEligibility: { eligible: true },
    liveActivity: {
      kind: "emit",
      activity: input.activity,
      detail: input.detail,
      entries: input.entries,
      detailKind: input.detailKind,
      attrs: { ...sourceProducerFactAttrs, ...apmSourceFactAttrs },
      ...(input.launchId !== undefined ? { launchId: input.launchId } : {}),
      ...(input.clientSeq !== undefined ? { clientSeq: input.clientSeq } : {}),
      ...(input.probeId !== undefined ? { probeId: input.probeId } : {}),
      ...(input.producerFactId !== undefined ? { producerFactId: input.producerFactId } : {}),
      ...(input.observedAtMs !== undefined ? { observedAtMs: input.observedAtMs } : {}),
      ...(input.isHeartbeat !== undefined ? { isHeartbeat: input.isHeartbeat } : {}),
      arbitrationObservationClass: input.observationClass ?? "observed",
      arbitrationSignalSite: "daemon_ingest",
    },
    activityLog: {
      labelKind: "daemon_activity",
      attrs: { activity_status: input.activity, ...sourceProducerFactAttrs, ...apmSourceFactAttrs },
    },
  };
}

function sourceProducerFactTraceAttrs(producerFactId: string | undefined): AgentLifecycleTraceAttrs {
  const id = typeof producerFactId === "string" ? producerFactId.trim() : "";
  if (!id) return {};
  return {
    source_producer_fact_id: id,
  };
}

function apmProducerFactTraceAttrs(entries: readonly TrajectoryEntry[] | undefined): AgentLifecycleTraceAttrs {
  const producerFactIds = uniqueProducerFactIds(entries);
  if (producerFactIds.length === 0) return {};
  return {
    apm_source_fact_count: producerFactIds.length,
    ...(producerFactIds.length === 1 ? { apm_source_fact_id: producerFactIds[0] } : {}),
  };
}

function uniqueProducerFactIds(entries: readonly TrajectoryEntry[] | undefined): string[] {
  if (!entries) return [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const producerFactId = typeof entry.producerFactId === "string" ? entry.producerFactId.trim() : "";
    if (producerFactId.length > 0) ids.add(producerFactId);
  }
  return [...ids];
}

export interface ExternalActivityProjectionInput {
  activity: "error" | "offline" | "online" | "thinking" | "working";
  dedupeKey?: string;
  detail: string;
  entries?: TrajectoryEntry[];
  event: AgentLifecycleEvent;
  occurredAtMs?: number;
}

export function reduceExternalActivityLifecycle(input: ExternalActivityProjectionInput): AgentLifecycleProjectionPlan {
  const apmSourceFactAttrs = apmProducerFactTraceAttrs(input.entries);
  return {
    event: input.event,
    dbStatus: {
      kind: "skip",
      skippedReason: "external_activity_does_not_change_db_status",
      attrs: { activity_status: input.activity },
    },
    wakeEligibility: { eligible: true },
    liveActivity: {
      kind: "emit",
      activity: input.activity,
      detail: input.detail,
      entries: input.entries,
      dedupeKey: input.dedupeKey,
      detailKind: "external_activity",
      nowOverride: input.occurredAtMs,
      attrs: apmSourceFactAttrs,
    },
    activityLog: {
      labelKind: "external_activity",
      dedupeKey: input.dedupeKey,
      attrs: { activity_status: input.activity, ...apmSourceFactAttrs },
    },
  };
}

export type SyntheticRepairKind = "stale_sweep" | "transient_normalization";

export interface SyntheticRepairProjectionInput {
  event: AgentLifecycleEvent;
  repairKind: SyntheticRepairKind;
  nowOverride?: number;
}

export function reduceSyntheticRepairLifecycle(input: SyntheticRepairProjectionInput): AgentLifecycleProjectionPlan {
  return {
    event: input.event,
    dbStatus: {
      kind: "skip",
      skippedReason: "synthetic_repair_does_not_change_db_status",
      attrs: { synthetic_repair: true, repair_kind: input.repairKind },
    },
    wakeEligibility: { eligible: true },
    liveActivity: {
      kind: "emit",
      activity: "online",
      detail: "",
      detailKind: "synthetic_repair",
      nowOverride: input.nowOverride,
      attrs: { synthetic_repair: true, repair_kind: input.repairKind },
    },
    activityLog: {
      labelKind: "synthetic_repair",
      attrs: { synthetic_repair: true, repair_kind: input.repairKind },
    },
  };
}

export interface ReadyReconcileProjectionInput {
  action: ReadyReconcileLifecycleAction;
  activityDedupeKey: string;
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
}

export function reduceReadyReconcileLifecycle(input: ReadyReconcileProjectionInput): AgentLifecycleProjectionPlan {
  switch (input.action) {
    case "force-stop-and-stay-offline":
      return {
        event: input.event,
        sideEffects: {
          sendStopToMachine: "best_effort",
          updateCache: { machineId: input.state.machineId, status: input.state.dbStatus },
        },
        dbStatus: {
          kind: "skip",
          skippedReason: "preserve_persisted_status",
          attrs: { legacy_status: input.state.dbStatus },
        },
        wakeEligibility: {
          eligible: false,
          blockReason: input.state.dbStatus === "stopped" ? "manual_stopped" : "control_gate",
        },
        liveActivity: {
          kind: "emit",
          activity: "offline",
          detail: "Stopped",
          dedupeKey: input.activityDedupeKey,
          detailKind: "stopped",
        },
        activityLog: {
          labelKind: "stopped",
          dedupeKey: input.activityDedupeKey,
        },
      };

    case "mark-active-online":
      return {
        event: input.event,
        sideEffects: {
          clearLaunchGuard: true,
          updateCache: { machineId: input.state.machineId, runtimeState: "running_idle", status: "active" },
        },
        dbStatus: {
          kind: "apply",
          status: "active",
          writer: "signal",
          attrs: { legacy_status: "active", runtime_state: "running_idle" },
        },
        wakeEligibility: { eligible: true },
        liveActivity: {
          kind: "ready_online",
          detailKind: "ready",
          attrs: { activity_status: "online", detail_kind: "ready" },
        },
        activityLog: {
          labelKind: "ready_online",
          skippedReason: "online_recovery_may_be_persisted_by_broadcast_ready_online",
        },
      };

    case "mark-wakeable-not-running":
      // Daemon restart / ready reconciliation can observe no running process
      // for an agent that is still logically active. Do not persist an offline
      // status here; only record the runtime-process axis as absent.
      return {
        event: input.event,
        sideEffects: {
          clearLaunchGuard: true,
          releaseWakeLock: true,
          updateCache: { machineId: input.state.machineId, runtimeState: "not_running", status: "active" },
        },
        dbStatus: {
          kind: "skip",
          skippedReason: "runtime_absent_but_agent_wakeable",
          attrs: { legacy_status: "active", runtime_state: "not_running" },
        },
        wakeEligibility: { eligible: true },
        liveActivity: {
          kind: "ready_online",
          detailKind: "ready",
          attrs: { activity_status: "online", detail_kind: "ready", runtime_state: "not_running" },
        },
        activityLog: {
          labelKind: "ready_wakeable_not_running",
          skippedReason: "wakeable_sleeping_runtime_is_not_user_visible_offline",
        },
      };

    case "mark-inactive-offline":
      return {
        event: input.event,
        sideEffects: {
          releaseWakeLock: true,
          updateCache: { machineId: input.state.machineId, runtimeState: "interrupted", status: "inactive" },
        },
        dbStatus: {
          kind: "apply",
          status: "inactive",
          writer: "signal",
          attrs: { legacy_status: "inactive", runtime_state: "interrupted" },
        },
        wakeEligibility: { eligible: true },
        liveActivity: {
          kind: "emit",
          activity: "offline",
          detail: "Runtime interrupted",
          dedupeKey: input.activityDedupeKey,
          detailKind: "runtime_interrupted",
        },
        activityLog: {
          labelKind: "runtime_interrupted",
          dedupeKey: input.activityDedupeKey,
        },
      };

    case "stay-offline": {
      const stopped = input.state.dbStatus === "stopped";
      const detailKind = stopped ? "stopped" : "runtime_interrupted";
      return {
        event: input.event,
        sideEffects: {
          updateCache: { machineId: input.state.machineId, runtimeState: "not_running", status: input.state.dbStatus },
        },
        dbStatus: {
          kind: "skip",
          skippedReason: "preserve_persisted_status",
          attrs: { legacy_status: input.state.dbStatus },
        },
        wakeEligibility: {
          eligible: !stopped,
          ...(stopped ? { blockReason: "manual_stopped" } : {}),
        },
        liveActivity: {
          kind: "emit",
          activity: "offline",
          detail: stopped ? "Stopped" : "Runtime interrupted",
          dedupeKey: input.activityDedupeKey,
          detailKind,
        },
        activityLog: {
          labelKind: detailKind,
          dedupeKey: input.activityDedupeKey,
        },
      };
    }
  }
}

export interface DaemonStatusProjectionInput {
  action: StatusSignalPlanAction;
  event: AgentLifecycleEvent;
  nextStatus?: AgentStatus;
  state: AgentLifecycleStateSnapshot;
}

export function reduceDaemonStatusLifecycle(input: DaemonStatusProjectionInput): AgentLifecycleProjectionPlan {
  if (input.action === "ignore-and-release-wake-lock") {
    return skippedSignalProjection(input.event, {
      blockReason: "manual_stopped",
      eligible: false,
      releaseWakeLock: true,
      skippedReason: "manual_stopped_ignores_daemon_status",
    });
  }

  if (input.action === "ignore") {
    const wakeBlockReason = stateWakeBlockReason(input.state);
    return skippedSignalProjection(input.event, {
      blockReason: wakeBlockReason,
      eligible: !wakeBlockReason,
      skippedReason: wakeBlockReason === "reset_window"
        ? "reset_window_ignores_daemon_status"
        : "status_signal_ignored",
    });
  }

  const status = input.nextStatus ?? (input.action === "persist-active" ? "active" : input.action === "persist-stopped" ? "stopped" : "inactive");
  const dbStatus: LifecycleDbStatusProjection = status === input.state.dbStatus
    ? {
        kind: "skip",
        skippedReason: "daemon_status_unchanged",
        attrs: { legacy_status: status },
      }
    : {
        kind: "apply",
        status,
        writer: "signal",
        attrs: { legacy_status: status },
      };
  return {
    event: input.event,
    sideEffects: {
      ...(status === "active" ? { resolveStartingActivity: true } : { clearLaunchGuard: true, releaseWakeLock: true }),
      ...(status === "active" ? {} : { terminalizeFreshnessHold: "freshness_hold_terminalized" as const }),
      updateCache: { runtimeState: status === "active" ? "running_idle" : "not_running", status },
    },
    dbStatus,
    wakeEligibility: {
      eligible: status !== "stopped",
      ...(status === "stopped" ? { blockReason: "manual_stopped" } : {}),
    },
    liveActivity: {
      kind: "skip",
      skippedReason: status === "active" ? "starting_activity_may_be_resolved" : "status_signal_not_visible_activity",
    },
    activityLog: {
      labelKind: "none",
      skippedReason: "status_signal_not_visible_activity",
    },
  };
}

export interface DaemonSessionProjectionInput {
  action: SessionSignalPlanAction;
  event: AgentLifecycleEvent;
  sessionId: string;
  state: AgentLifecycleStateSnapshot;
}

export function reduceDaemonSessionLifecycle(input: DaemonSessionProjectionInput): AgentLifecycleProjectionPlan {
  if (input.action === "ignore-and-release-wake-lock") {
    return skippedSignalProjection(input.event, {
      blockReason: "manual_stopped",
      eligible: false,
      releaseWakeLock: true,
      skippedReason: "manual_stopped_ignores_daemon_session",
    });
  }

  if (input.action === "ignore") {
    const wakeBlockReason = stateWakeBlockReason(input.state);
    return skippedSignalProjection(input.event, {
      blockReason: wakeBlockReason,
      eligible: !wakeBlockReason,
      skippedReason: wakeBlockReason === "reset_window"
        ? "reset_window_ignores_daemon_session"
        : "session_signal_ignored",
    });
  }

  const sessionUnchanged = input.state.dbStatus === "active" && input.state.sessionId === input.sessionId;
  return {
    event: input.event,
    sideEffects: {
      releaseWakeLock: true,
      resolveStartingActivity: true,
      updateCache: { runtimeState: "running_idle", sessionId: input.sessionId, status: "active" },
    },
    dbStatus: sessionUnchanged
      ? {
          kind: "skip",
          skippedReason: "daemon_session_unchanged",
          attrs: { legacy_status: "active", session_present: true },
        }
      : {
          kind: "apply",
          sessionId: input.sessionId,
          status: "active",
          writer: "signal",
          attrs: { legacy_status: "active", session_present: true },
        },
    wakeEligibility: { eligible: true },
    liveActivity: {
      kind: "skip",
      skippedReason: "starting_activity_may_be_resolved",
    },
    activityLog: {
      labelKind: "none",
      skippedReason: "session_signal_not_visible_activity",
    },
  };
}

function skippedSignalProjection(
  event: AgentLifecycleEvent,
  input: {
    blockReason?: LifecycleWakeBlockReason;
    eligible: boolean;
    releaseWakeLock?: boolean;
    skippedReason: string;
    attrs?: AgentLifecycleTraceAttrs;
  },
): AgentLifecycleProjectionPlan {
  return {
    event,
    sideEffects: input.releaseWakeLock ? { releaseWakeLock: true } : undefined,
    dbStatus: {
      kind: "skip",
      skippedReason: input.skippedReason,
      attrs: input.attrs,
    },
    wakeEligibility: {
      eligible: input.eligible,
      ...(input.blockReason ? { blockReason: input.blockReason } : {}),
      attrs: input.attrs,
    },
    liveActivity: {
      kind: "skip",
      skippedReason: input.skippedReason,
      attrs: input.attrs,
    },
    activityLog: {
      labelKind: "none",
      skippedReason: input.skippedReason,
      attrs: input.attrs,
    },
  };
}

export interface MachineDisconnectProjectionInput {
  activityDedupeKey: string;
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
}

export function reduceMachineDisconnectLifecycle(input: MachineDisconnectProjectionInput): AgentLifecycleProjectionPlan {
  return {
    event: input.event,
    sideEffects: {
      updateCache: { runtimeState: "interrupted", status: input.state.dbStatus },
    },
    dbStatus: {
      kind: "skip",
      skippedReason: "machine_disconnect_preserves_agent_status",
      attrs: { legacy_status: input.state.dbStatus, machine_reachability: "unreachable" },
    },
    wakeEligibility: {
      eligible: false,
      blockReason: "machine_unreachable",
      attrs: { machine_reachability: "unreachable" },
    },
    liveActivity: {
      kind: "emit",
      activity: "offline",
      detail: "Machine disconnected",
      dedupeKey: input.activityDedupeKey,
      detailKind: "machine_disconnected",
    },
    activityLog: {
      labelKind: "machine_disconnected",
      dedupeKey: input.activityDedupeKey,
    },
  };
}

export interface MachineShutdownProjectionInput {
  activityDedupeKey: string;
  event: AgentLifecycleEvent;
  shutdownReason: string;
  state: AgentLifecycleStateSnapshot;
}

export function reduceMachineShutdownLifecycle(input: MachineShutdownProjectionInput): AgentLifecycleProjectionPlan {
  const attrs = {
    legacy_status: input.state.dbStatus,
    machine_reachability: "unreachable",
    shutdown_reason: input.shutdownReason,
  };
  return {
    event: input.event,
    sideEffects: {
      updateCache: { runtimeState: "not_running", status: input.state.dbStatus },
    },
    dbStatus: {
      kind: "skip",
      skippedReason: "machine_shutdown_preserves_agent_status",
      attrs,
    },
    wakeEligibility: {
      eligible: false,
      blockReason: "machine_unreachable",
      attrs: {
        machine_reachability: "unreachable",
        shutdown_reason: input.shutdownReason,
      },
    },
    liveActivity: {
      kind: "emit",
      activity: "offline",
      detail: "Computer stopped",
      dedupeKey: input.activityDedupeKey,
      detailKind: "stopped",
    },
    activityLog: {
      labelKind: "stopped",
      dedupeKey: input.activityDedupeKey,
      attrs: {
        ...attrs,
        stop_source: "computer",
      },
    },
  };
}

export interface StopProjectionInput {
  activityDedupeKey: string;
  event: AgentLifecycleEvent;
  nextStatus: AgentStatus;
  state: AgentLifecycleStateSnapshot;
}

export function reduceStopLifecycle(input: StopProjectionInput): AgentLifecycleProjectionPlan {
  const stopped = input.nextStatus === "stopped";
  return {
    event: input.event,
    sideEffects: {
      clearInbox: true,
      clearLaunchGuard: true,
      releaseWakeLock: true,
      ...(input.state.machineId ? { sendStopToMachine: "await" } : {}),
      updateCache: { runtimeState: "not_running", status: input.nextStatus },
    },
    dbStatus: {
      kind: "apply",
      status: input.nextStatus,
      writer: "direct",
      attrs: {
        intent_state: stopped ? "manual_stopped" : "running_allowed",
        legacy_status: input.nextStatus,
        runtime_state: "not_running",
      },
    },
    wakeEligibility: {
      eligible: !stopped,
      ...(stopped ? { blockReason: "manual_stopped" } : {}),
    },
    liveActivity: {
      kind: "emit",
      activity: "offline",
      detail: stopped ? "Agent stopped by user" : "Stopped",
      dedupeKey: input.activityDedupeKey,
      detailKind: "stopped",
      emitWhen: "manual_or_stop_send_failed",
    },
    activityLog: {
      labelKind: "stopped",
      dedupeKey: input.activityDedupeKey,
      attrs: {
        intent_state: stopped ? "manual_stopped" : "running_allowed",
        legacy_status: input.nextStatus,
        runtime_state: "not_running",
        stop_source: stopped ? "user" : "server",
      },
    },
  };
}

export interface RuntimeProfileControlProjectionInput {
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
}

export function reduceRuntimeProfileControlLifecycle(
  input: RuntimeProfileControlProjectionInput,
): AgentLifecycleProjectionPlan {
  const gated = input.state.controlGate === "runtime_profile_migration";
  return {
    event: input.event,
    dbStatus: {
      kind: "skip",
      skippedReason: "control_gate_only",
      attrs: { control_gate: input.state.controlGate },
    },
    wakeEligibility: {
      eligible: !gated,
      ...(gated ? { blockReason: "control_gate" } : {}),
    },
    liveActivity: {
      kind: "skip",
      skippedReason: "control_gate_not_visible_activity",
      attrs: { control_gate: input.state.controlGate },
    },
    activityLog: {
      labelKind: "none",
      skippedReason: "control_gate_not_visible_activity",
      attrs: { control_gate: input.state.controlGate },
    },
  };
}

export interface AgentMigrationControlProjectionInput {
  event: AgentLifecycleEvent;
  state: AgentLifecycleStateSnapshot;
}

export function reduceAgentMigrationControlLifecycle(
  input: AgentMigrationControlProjectionInput,
): AgentLifecycleProjectionPlan {
  const gated = input.state.controlGate === "zen_migrating";
  return {
    event: input.event,
    dbStatus: {
      kind: "skip",
      skippedReason: "control_gate_only",
      attrs: { control_gate: input.state.controlGate },
    },
    wakeEligibility: {
      eligible: !gated,
      ...(gated ? { blockReason: "control_gate" } : {}),
    },
    liveActivity: {
      kind: "skip",
      skippedReason: "control_gate_not_visible_activity",
      attrs: { control_gate: input.state.controlGate },
    },
    activityLog: {
      labelKind: "none",
      skippedReason: "control_gate_not_visible_activity",
      attrs: { control_gate: input.state.controlGate },
    },
  };
}

export function shouldEmitLiveActivity(input: {
  liveActivity: LifecycleLiveActivityProjection;
  nextStatus?: AgentStatus;
  stopSent?: boolean;
}): boolean {
  if (input.liveActivity.kind !== "emit") return false;
  if (input.liveActivity.emitWhen !== "manual_or_stop_send_failed") return true;
  return input.nextStatus === "stopped" || input.stopSent !== true;
}

// ---------------------------------------------------------------------------
// Lifecycle-v2 arbitration kernel (task #460, P1 slice).
//
// Implements the I3 contract pinned by agentLifecycleReducer.property.test.ts
// (#3829) against the #457 reducer-facing event shape: a signal that survived
// storage-level ownership/ordering admission is arbitrated here into a
// projection verdict. Two-layer semantics, NOT a time ratchet:
//   - fresh observed same-generation runtime truth replaces the projection
//     outright, in both directions (working -> idle turn end and error -> idle
//     observed recovery are legal downgrades);
//   - the authority priority table arbitrates only same-tick/ambiguous
//     conflicts and never lets non-observed provenance create liveness.
// Stale-generation launch noise may resolve only the Starting affordance
// (production analogue: maybeResolveStartingActivity's not_starting_detail
// skip); it never promotes runtime truth nor demotes a live projection.
//
// P1 wiring is shadow-only (verdicts feed #459 diff rows); nothing in this
// section changes user-visible projection behavior until the P2 flag flip.

/**
 * Signal provenance. gamma-2.1 adds "control": an AUTHORIZED control-command
 * projection (Kai calibration v3 §B split: synthetic-control-command vs
 * synthetic-lifecycle-readiness). Control commands are the authoritative
 * writers of their own axis — they legally replace the projection value
 * (reason control_command_authority) — but they are NOT observations:
 * the fold never advances observed-freshness for them (I6: liveness is
 * observed, never synthesized). Lifecycle-readiness intent stays plain
 * "synthetic" and remains suppressed (no authority over fresh observed).
 */
export type LifecycleObservationClass =
  | "observed"
  | "observed_turn_active"
  | "replayed"
  | "synthetic"
  | "diagnostic"
  | "control";

type FrozenTraceObservationClass =
  | "activity_assertion"
  | "activity_replay"
  | "control_intent"
  | "diagnostic"
  | "liveness_observation"
  | "observed_turn_active"
  | "runtime_lifecycle_observation"
  | "synthetic_diagnostic";

export type LifecycleCanonicalProjection =
  | "unknown"
  | "offline"
  | "online"
  | "idle"
  | "working"
  | "thinking"
  | "stopping"
  | "error";

export const LIFECYCLE_AUTHORITY_PRIORITY: Record<LifecycleCanonicalProjection, number> = {
  unknown: 0,
  offline: 1,
  online: 2,
  idle: 3,
  working: 4,
  thinking: 5,
  stopping: 6,
  error: 7,
};

export interface LifecycleArbitrationState {
  currentLaunchGeneration?: string | null;
  lastObservedAtMs: number;
  projection: LifecycleCanonicalProjection;
  /**
   * Explicit Starting-affordance bit, fail-closed. Production truth for this
   * bit is `current.activity === "working" && detailKind in {starting,
   * runtime_starting}` (see isStartingActivitySnapshot); the snapshot builder
   * sets it, the kernel never infers it. In particular `projection ===
   * "unknown"` does NOT imply Starting — an observed-absent unknown is not a
   * Starting spinner and must not be "resolved" by stale launch noise.
   */
  startingAffordance?: boolean;
}

export interface LifecycleArbitrationSignal {
  atMs: number;
  launchGeneration?: string | null;
  observationClass: LifecycleObservationClass;
  projection: LifecycleCanonicalProjection;
}

export type LifecycleArbitrationVerdict =
  | {
      action: "replace";
      freshnessAdvanced: boolean;
      projection: LifecycleCanonicalProjection;
      reason: "fresh_observed_same_generation" | "control_command_authority";
    }
  | {
      action: "arbitrate";
      freshnessAdvanced: boolean;
      projection: LifecycleCanonicalProjection;
      reason: "same_tick_priority";
    }
  | { action: "degrade_unknown"; projection: "unknown"; reason: "non_observed_uncertainty" }
  | {
      action: "preserve";
      projection: LifecycleCanonicalProjection;
      reason:
        | "diagnostic_no_authority"
        | "replayed_no_authority"
        | "stale_observed"
        | "stale_generation"
        | "synthetic_no_authority";
    }
  | { action: "resolve_starting"; projection: "idle"; reason: "stale_generation_starting_cleanup" };

export function arbitrateLifecycleProjection(
  state: LifecycleArbitrationState,
  signal: LifecycleArbitrationSignal,
): LifecycleArbitrationVerdict {
  const staleGeneration =
    signal.launchGeneration != null
    && state.currentLaunchGeneration != null
    && signal.launchGeneration !== state.currentLaunchGeneration;

  if (staleGeneration) {
    if (state.startingAffordance === true) {
      return { action: "resolve_starting", projection: "idle", reason: "stale_generation_starting_cleanup" };
    }
    return { action: "preserve", projection: state.projection, reason: "stale_generation" };
  }

  // Control-command authority (gamma-2.1, Kai v3 §B): an authorized control
  // projection legally replaces the value on its own axis — it is NOT
  // filed under no_authority with the lifecycle-readiness intents. The
  // freshness consequence is the fold's job: control never advances
  // lastObservedAtMs (I6). Unknown stays fail-safe.
  if (signal.observationClass === "control") {
    if (signal.projection === "unknown") {
      return { action: "degrade_unknown", projection: "unknown", reason: "non_observed_uncertainty" };
    }
    return {
      action: "replace",
      freshnessAdvanced: false,
      projection: signal.projection,
      reason: "control_command_authority",
    };
  }

  const isObservedAuthority = signal.observationClass === "observed" || signal.observationClass === "observed_turn_active";
  if (!isObservedAuthority) {
    if (signal.projection === "unknown") {
      return { action: "degrade_unknown", projection: "unknown", reason: "non_observed_uncertainty" };
    }
    return {
      action: "preserve",
      projection: state.projection,
      reason:
        signal.observationClass === "synthetic"
          ? "synthetic_no_authority"
          : signal.observationClass === "replayed"
            ? "replayed_no_authority"
            : "diagnostic_no_authority",
    };
  }

  if (signal.atMs > state.lastObservedAtMs) {
    return {
      action: "replace",
      freshnessAdvanced: signal.projection === "working" || signal.projection === "thinking",
      projection: signal.projection,
      reason: "fresh_observed_same_generation",
    };
  }

  if (signal.atMs < state.lastObservedAtMs) {
    return {
      action: "preserve",
      projection: state.projection,
      reason: "stale_observed",
    };
  }

  const winner =
    LIFECYCLE_AUTHORITY_PRIORITY[signal.projection] >= LIFECYCLE_AUTHORITY_PRIORITY[state.projection]
      ? signal.projection
      : state.projection;
  return {
    action: "arbitrate",
    freshnessAdvanced: winner === "working" || winner === "thinking",
    projection: winner,
    reason: "same_tick_priority",
  };
}

// Mechanical fold: applies a verdict to the arbitration state with zero
// additional semantics (I2 plan-applier discipline — every decision above,
// none here). `lastObservedAtMs` advances only when an observed signal was
// actually admitted into the projection (replace/arbitrate). The Starting
// affordance clears when it is explicitly resolved or when a real projection
// is admitted; it is never set here (only the snapshot builder sets it).
export function foldLifecycleArbitration(
  state: LifecycleArbitrationState,
  signal: LifecycleArbitrationSignal,
): { state: LifecycleArbitrationState; verdict: LifecycleArbitrationVerdict } {
  const verdict = arbitrateLifecycleProjection(state, signal);
  const admitted = verdict.action === "replace" || verdict.action === "arbitrate";
  // I6 pin (gamma-2.1): only an OBSERVED admission advances observed-
  // freshness. A control-command replace legally changes the value but must
  // not synthesize liveness — advancing lastObservedAtMs from a server-side
  // command would be exactly the freshness laundering this kernel exists to
  // refuse. The affordance still clears on any admitted real projection.
  const observedAdmitted = admitted && (signal.observationClass === "observed" || signal.observationClass === "observed_turn_active");
  return {
    state: {
      currentLaunchGeneration: state.currentLaunchGeneration,
      lastObservedAtMs: observedAdmitted ? Math.max(state.lastObservedAtMs, signal.atMs) : state.lastObservedAtMs,
      projection: verdict.projection,
      startingAffordance:
        admitted || verdict.action === "resolve_starting" ? false : state.startingAffordance,
    },
    verdict,
  };
}

// --- Lifecycle-v2 shadow verdict (task #460 PR-beta, P1 shadow wiring) -------
//
// Builds the trace-only shadow verdict emitted at orchestrator ingest sites.
// Oracle scope (pinned by #459 DoD): the shadow state is constructed in place
// from the LIVE system's current snapshot, so each verdict measures PER-STEP
// divergence against the live projection. A run of zero per-step divergence
// does NOT establish trajectory equivalence with a self-consistent kernel;
// consumers must not sign that stronger claim with this weaker oracle.
// Behavior-neutral: output feeds span events only, never projections.

// Maps the legacy live-activity vocabulary onto the canonical projection
// space. Conservative: only online+idle detail refines to "idle"; Starting
// stays "working" because the affordance is carried as the explicit bit, not
// as a projection value.
export function legacyActivityToCanonicalProjection(
  activity: AgentActivityKind,
  detailKind?: AgentActivityDetailKind | null,
): LifecycleCanonicalProjection {
  if (activity === "online" && detailKind === "idle") return "idle";
  return activity;
}

// Legacy live activity can express exactly the AGENT_ACTIVITIES values (plus
// idle via online+detailKind). stopping/unknown have no legacy expression;
// per the #459 comparison rule they land in the inexpressible bucket instead
// of polluting agree/disagree.
export function isLegacyExpressibleProjection(projection: LifecycleCanonicalProjection): boolean {
  return projection !== "stopping" && projection !== "unknown";
}

export interface LifecycleShadowSnapshotInput {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  updatedAtMs: number;
}

/**
 * Closed emission-site enum (task #460 PR-gamma). Proof consumer: the
 * three-vector replay bucketing in the gamma acceptance readtable — each
 * value points at its own repair carrier:
 * - daemon_ingest: client-originated signals (heartbeat replay vector is
 *   daemon_ingest + observation_class=activity_replay → PR-beta-2 carrier; the
 *   probe-echo vector is daemon_ingest + probeId, display axis owned by #457).
 * - preserve_rebroadcast: stable legacy taxonomy for the stale-sweep busy-
 *   preserve diagnostic. Since task #499 this carrier is trace-only: timeout
 *   preservation does not re-broadcast or write agentActivity.
 * - synthetic_repair: stable trace taxonomy for rejected server whitewash
 *   candidates. Since task #499 stale_sweep / transient_normalization are
 *   diagnostic-only and do not write agentActivity.
 * Required, never defaulted: an emission site that cannot name itself is a
 * wiring bug, not a legacy cohort (contrast the isHeartbeat absent-cohort,
 * which exists because remote legacy producers are real).
 *
 * gamma-2 extension (write-site closure, g1 prior-chain finding): the five
 * additional values name the previously UNSHADOWED agentActivity writers —
 * every prior-chain break in the g1 spread was the footprint of one of them.
 * Coverage scope note: this shadow covers the AGENT-ACTIVITY write axis
 * only. The offline a client reads after a machine drops is a READ-TIME
 * machine-reachability overlay (resolveDerivedActivity / the
 * hard-reachability-offline hint-ignore), not an agentActivity write — that
 * axis has its own truth source and is deliberately NOT a site value here.
 */
export type LifecycleShadowSignalSite =
  | "daemon_ingest"
  | "preserve_rebroadcast"
  | "synthetic_repair"
  | "starting_resolve"
  | "ready_online"
  | "delivery_ack"
  | "slock_action_status"
  | "hint_resolution"
  | "runtime_error"
  /**
   * gamma-3: the lifecycle projection-plan path (applyAgentLifecycleProjection-
   * Plan -> deps.broadcastActivity). Sub-family rides shadow_plan_kind (the
   * closed AgentLifecycleEventType); class comes from the total
   * LIFECYCLE_PLAN_SHADOW_CLASS map. g2 invariant-#7 first catch: disconnect
   * offline / start working / ready legs flowed through here verdict-less.
   */
  | "lifecycle_plan";

/**
 * Closed registry of agentActivity map writers (gamma-2 write-site closure
 * invariant): every writer of serving activity truth either carries a
 * shadow_verdict with its own site value, or is registered here as a
 * justified non-verdict writer. skyzh's CI grep-ratchet consumes this as
 * the closure denominator (writer count in source == registry length);
 * Leiysky's readtable consumes it as the bucket denominator (negative
 * space: a site that never appears is a finding, not an unknown).
 * NOTE: the ratchet proves "writers are registered and wired", not "the
 * verdict was actually emitted at runtime" — runtime coverage is the
 * shadow_verdict stream's job (proxy vs target, kept separate on purpose).
 */
export const AGENT_ACTIVITY_WRITER_REGISTRY = [
  // The daemon-activity ingest handler emits at ACCEPT time (it needs the
  // observed/replayed classifier context that only exists there).
  { method: "handleMachineMessage(agent:activity).accept", site: "daemon_ingest" },
  // Every OTHER reducer plan that emits liveActivity flows through the
  // projection writer, which emits at the broadcast seam (gamma-3); the
  // sub-family is the closed shadow_plan_kind = AgentLifecycleEventType.
  // g2 invariant-#7 catch: this path was verdict-less (Yingjun census row
  // recorded one caller instead of the semantic families flowing through).
  { method: "applyAgentLifecycleProjectionPlan.emit", site: "lifecycle_plan" },
  // refreshStaleTransientActivity is trace-only: timeout preservation must not
  // write agentActivity or re-mint the stale user-facing detail (task #499).
  // stale_sweep and transient_normalization are also trace-only: reachability
  // absence and read-time normalization are not activity observations.
  { method: "maybeResolveStartingActivity", site: "starting_resolve" },
  { method: "broadcastReadyOnline", site: "ready_online" },
  { method: "handleMachineMessage(agent:deliver:ack).turn_active", site: "delivery_ack" },
  { method: "broadcastRaftAction", site: "slock_action_status" },
  { method: "applyActivityHintResolutionAction", site: "hint_resolution" },
  { method: "rememberRuntimeError", site: "runtime_error" },
  { method: "clearLastRuntimeError", site: "runtime_error" },
] as const satisfies ReadonlyArray<{ method: string; site: LifecycleShadowSignalSite }>;

/**
 * gamma-3 per-plan observation-class map — TOTAL over the closed
 * AgentLifecycleEventType (satisfies Record<...>): adding a new event type
 * fails to compile until a class row is decided here. Classification per
 * Kai calibration v3.1/v3.2 three-way semantics (authority != liveness):
 * - observed: daemon/runtime/external-REPORTED facts (their axis's truth).
 * - control: authorized commands (value authority, never liveness).
 * - synthetic: server-derived intent/readiness/axis-crossings — including
 *   machine_disconnected -> offline (a machine-axis observation projected
 *   onto the agent axis; the kernel's honest verdict is "cannot know",
 *   which is exactly the divergence bucket worth measuring).
 */
export const LIFECYCLE_PLAN_SHADOW_CLASS = {
  activity_changed: "synthetic", // non-daemon activity_changed (wake/message legs); daemon ingest + repairs are handler-emitted and skipped below
  daemon_shutdown: "observed", // daemon-declared lifecycle fact
  daemon_upgrade_started: "observed", // daemon-declared lifecycle fact
  external_agent_signal: "observed", // external-reported (#457 external row)
  machine_disconnected: "synthetic", // axis-crossing derivation (offline write)
  manual_start_requested: "control", // authorized command
  manual_stop_requested: "control", // authorized command
  migration_aborted: "control", // authorized migration command chain
  migration_completed: "control", // authorized migration command chain
  migration_started: "control", // authorized migration command chain
  ready_reconciled: "synthetic", // readiness family (ready_online leg emits its own site)
  runtime_crashed: "observed", // daemon-detected runtime fact
  runtime_interrupted: "observed", // daemon-detected runtime fact
  runtime_profile_control_changed: "control", // authorized control gate
  runtime_ready: "synthetic", // readiness intent (resolve-race cousin)
  runtime_spawned: "synthetic", // readiness intent (Starting leg)
} as const satisfies Record<AgentLifecycleEventType, LifecycleObservationClass>;

export type LifecyclePlanShadowDecision =
  | { kind: "skip"; reason: "handler_emits" }
  | { kind: "emit"; observationClass: LifecycleObservationClass; planKind: AgentLifecycleEventType };

/**
 * Which liveActivity-emitting plans the WRITER shadows vs which are already
 * verdict-carrying at their handler (explicit closed skip-set — the
 * emitted-vs-admitted difference must be decided, never implicit):
 * - daemon activity ingest (source=daemon, activity_changed or the typed
 *   runtime-error sub-carrier): the accept
 *   handler emits with observed/replayed classifier context (isHeartbeat /
 *   probeId / lastAccepted) that does not exist in the plan.
 * - synthetic repairs (attrs.synthetic_repair): their apply sites emit
 *   site=synthetic_repair before the plan is applied.
 * Everything else emits here with the total class map.
 */
export function lifecyclePlanShadowDecision(event: AgentLifecycleEvent): LifecyclePlanShadowDecision {
  if (event.attrs?.synthetic_repair === true) return { kind: "skip", reason: "handler_emits" };
  if (event.eventType === "activity_changed" && event.source === "daemon") {
    return { kind: "skip", reason: "handler_emits" };
  }
  if (
    event.eventType === "runtime_crashed"
    && event.source === "daemon"
    && event.attrs?.source_protocol === "daemon_runtime_error_carrier_v1"
  ) {
    return { kind: "skip", reason: "handler_emits" };
  }
  return {
    kind: "emit",
    observationClass: LIFECYCLE_PLAN_SHADOW_CLASS[event.eventType],
    planKind: event.eventType,
  };
}

export interface LifecycleShadowSignalInput {
  activity: AgentActivityKind;
  /**
   * gamma-3.1: per-verdict agent identity. REQUIRED — machine-scoped spans
   * (e.g. ready.reconcile) host verdicts for MULTIPLE agents, so span-level
   * attribution is structurally unsound; the g3/g4 "boot break" was a
   * checker artifact of exactly that. Consumers: invariant #7 chain key,
   * readtable per-agent grouping.
   */
  agentId: string;
  atMs: number;
  /** Accepted-launch generation currently in force for the agent, if any. */
  currentLaunchGeneration?: string | null;
  detailKind?: AgentActivityDetailKind | null;
  /** Generation carried by the incoming signal, if any. */
  launchGeneration?: string | null;
  observationClass: LifecycleObservationClass;
  /** Explicit probe-response marker from agent:activity. Probes bind as liveness-only snapshots. */
  probeIdPresent?: boolean;
  site: LifecycleShadowSignalSite;
  /**
   * Closed sub-family for site=lifecycle_plan verdicts (the plan's
   * AgentLifecycleEventType). Absent for all other sites — the readtable
   * treats it as a per-site nullable column, not a required key.
   */
  planKind?: AgentLifecycleEventType;
}

// Mirrors isStartingActivitySnapshot (agentOrchestrator): the Starting
// affordance is derived from the detailKind truth source only, never from a
// projection value.
function shadowStartingAffordance(current: LifecycleShadowSnapshotInput | undefined): boolean {
  if (!current || current.activity !== "working") return false;
  if (current.detailKind === "starting" || current.detailKind === "runtime_starting") return true;
  return current.detail === "Starting…";
}

function frozenShadowObservationClass(
  signal: LifecycleShadowSignalInput,
  incoming: LifecycleCanonicalProjection,
): FrozenTraceObservationClass {
  if (signal.probeIdPresent === true) return "liveness_observation";
  switch (signal.observationClass) {
    case "control":
      return "control_intent";
    case "diagnostic":
      return "diagnostic";
    case "replayed":
      return "activity_replay";
    case "synthetic":
      return "synthetic_diagnostic";
    case "observed":
      return incoming === "working" || incoming === "thinking"
        ? "activity_assertion"
        : "runtime_lifecycle_observation";
    case "observed_turn_active":
      return "observed_turn_active";
  }
}

function shadowEventKind(
  signal: LifecycleShadowSignalInput,
  incoming: LifecycleCanonicalProjection,
  observationClass: FrozenTraceObservationClass,
): string {
  if (signal.planKind) return eventKindForLifecyclePlan(signal.planKind);
  if (signal.probeIdPresent === true) return "activity_snapshot";
  if (observationClass === "observed_turn_active") return "turn_active";
  if (signal.site === "synthetic_repair") return "synthetic_repair";
  if (observationClass === "activity_replay") return "activity_replayed";
  if (signal.site === "starting_resolve" || signal.site === "ready_online") return "synthetic_repair";
  if (signal.site === "hint_resolution") return "activity_replayed";
  if (signal.site === "slock_action_status") {
    return incoming === "offline" || incoming === "stopping" ? "stop_requested" : "start_requested";
  }
  if (observationClass === "synthetic_diagnostic") return "synthetic_repair";
  if (observationClass === "diagnostic") return "diagnostic";
  if (signal.site === "runtime_error") {
    return observationClass === "runtime_lifecycle_observation" ? "runtime_error" : "synthetic_repair";
  }
  if (observationClass === "activity_assertion") return "activity_observed";
  if (incoming === "error") return "runtime_error";
  if (incoming === "offline" || incoming === "stopping") return "runtime_exited";
  if (incoming === "idle" || incoming === "online") return "runtime_idle";
  return "runtime_working";
}

function eventKindForLifecyclePlan(planKind: AgentLifecycleEventType): string {
  switch (planKind) {
    case "manual_start_requested":
      return "start_requested";
    case "manual_stop_requested":
      return "stop_requested";
    case "runtime_ready":
    case "ready_reconciled":
      return "runtime_ready";
    case "runtime_crashed":
      return "runtime_error";
    case "runtime_interrupted":
    case "daemon_shutdown":
    case "daemon_upgrade_started":
      return "runtime_exited";
    case "activity_changed":
    case "external_agent_signal":
      return "activity_observed";
    case "machine_disconnected":
      return "machine_disconnected";
    case "runtime_spawned":
      return "runtime_working";
    case "runtime_profile_control_changed":
    case "migration_aborted":
    case "migration_completed":
    case "migration_started":
      return "internal_rpc";
  }
}

function shadowSource(site: LifecycleShadowSignalSite, observationClass: FrozenTraceObservationClass): string {
  if (observationClass === "activity_replay") return "replay_tooling";
  if (observationClass === "control_intent") return "server_control";
  if (observationClass === "liveness_observation") return "activity_probe";
  if (observationClass === "observed_turn_active") {
    return site === "delivery_ack" ? "server_delivery_ack" : "daemon_runtime";
  }
  if (observationClass === "synthetic_diagnostic") return "scheduler_repair";
  switch (site) {
    case "daemon_ingest":
      return "daemon_runtime";
    case "runtime_error":
      return "daemon_runtime";
    case "delivery_ack":
      return "server_delivery_ack";
    case "lifecycle_plan":
    case "slock_action_status":
      return "server_control";
    case "hint_resolution":
    case "preserve_rebroadcast":
      return "legacy_adapter";
    case "ready_online":
    case "starting_resolve":
    case "synthetic_repair":
      return "scheduler_repair";
  }
}

function shadowAuthority(observationClass: FrozenTraceObservationClass): string {
  switch (observationClass) {
    case "observed_turn_active":
      return "observed_turn_active";
    case "activity_assertion":
    case "runtime_lifecycle_observation":
      return "daemon_runtime";
    case "control_intent":
      return "server_control";
    case "activity_replay":
      return "replay_tooling";
    case "liveness_observation":
      return "activity_probe";
    case "synthetic_diagnostic":
      return "scheduler_repair";
    case "diagnostic":
      return "storage_owner";
  }
}

function observedClockAttrs(observationClass: FrozenTraceObservationClass, atMs: number): AgentLifecycleTraceAttrs {
  if (observationClass === "activity_assertion" || observationClass === "observed_turn_active") {
    return {
      activity_observed_at_ms: atMs,
      advances_observed_clock: "activity",
    };
  }
  if (observationClass === "runtime_lifecycle_observation") {
    return {
      lifecycle_observed_at_ms: atMs,
      advances_observed_clock: "lifecycle",
    };
  }
  return {
    advances_observed_clock: "none",
  };
}

export function buildLifecycleShadowVerdictAttrs(
  current: LifecycleShadowSnapshotInput | undefined,
  signal: LifecycleShadowSignalInput,
): AgentLifecycleTraceAttrs {
  const state: LifecycleArbitrationState = {
    currentLaunchGeneration: signal.currentLaunchGeneration ?? null,
    lastObservedAtMs: current?.updatedAtMs ?? 0,
    projection: current
      ? legacyActivityToCanonicalProjection(current.activity, current.detailKind)
      : "unknown",
    startingAffordance: shadowStartingAffordance(current),
  };
  const incoming = legacyActivityToCanonicalProjection(signal.activity, signal.detailKind ?? null);
  const verdict = arbitrateLifecycleProjection(state, {
    atMs: signal.atMs,
    launchGeneration: signal.launchGeneration ?? null,
    observationClass: signal.observationClass,
    projection: incoming,
  });
  const frozenObservationClass = frozenShadowObservationClass(signal, incoming);

  // Legacy applies every accepted broadcast as-is (arrival-order LWW), so the
  // legacy per-step outcome is the incoming projection itself.
  const legacyOutcome = incoming;
  const expressible = isLegacyExpressibleProjection(verdict.projection);
  const direction =
    LIFECYCLE_AUTHORITY_PRIORITY[incoming] > LIFECYCLE_AUTHORITY_PRIORITY[state.projection]
      ? "upgrade"
      : LIFECYCLE_AUTHORITY_PRIORITY[incoming] < LIFECYCLE_AUTHORITY_PRIORITY[state.projection]
        ? "downgrade"
        : "lateral";

  return {
    event_kind: shadowEventKind(signal, incoming, frozenObservationClass),
    source: shadowSource(signal.site, frozenObservationClass),
    authority: shadowAuthority(frozenObservationClass),
    observation_class: frozenObservationClass,
    ...observedClockAttrs(frozenObservationClass, signal.atMs),
    shadow_agent_id: signal.agentId,
    shadow_action: verdict.action,
    shadow_reason: verdict.reason,
    shadow_projection: verdict.projection,
    shadow_prior_projection: state.projection,
    shadow_starting_affordance: state.startingAffordance === true,
    shadow_legacy_outcome: legacyOutcome,
    // Direction is reported separately so downgrade agreement can be audited
    // on its own — aggregating directions is how the ratchet class hid.
    shadow_direction: direction,
    shadow_expressible: expressible,
    shadow_agree: expressible ? verdict.projection === legacyOutcome : null,
    shadow_observation_class: frozenObservationClass,
    shadow_signal_site: signal.site,
    ...(signal.planKind !== undefined ? { shadow_plan_kind: signal.planKind } : {}),
  };
}

// Observed-vs-replayed discrimination for daemon activity signals.
//
// Canonical key: PRODUCER-DECLARED provenance. The daemon's heartbeat timer
// branch knows at emission time that it is replaying stale lastActivity, so
// the protocol heartbeat bit declares it — consumer inference from payload
// is the lifecycle-v1 original sin, and content hashing is just a fancier
// guess. A producer that declares false is observed even when content
// repeats, which closes the reverse pit (a genuine identical re-observation
// must not be denied liveness).
//
// Legacy compat shim (absent-bit cohort ONLY, per the #457 null-generation
// precedent: explicit compat row, never a first-class key), in strict order:
// 1. A probe response (probeId present) is observed — probes echo the
//    unchanged lastActivity with no entries (respondToActivityProbe), i.e.
//    they LOOK exactly like heartbeat replays on the content axis, but they
//    are the passive ground-truth liveness answers the stale sweep depends
//    on; classifying them replayed would strangle the probe mechanism.
//    probeId is an explicit wire marker, so it never falls into content
//    guessing (same fail-closed pattern as the declared bit).
// 2. A signal with fresh trajectory entries is observed regardless of
//    content (heartbeat replays carry none — agentProcessManager heartbeat
//    sendToServer omits entries).
// 3. Otherwise unchanged content identity (activity + detail + detailKind)
//    means replayed.
// Retirement is aggressive: post-1.6-6a progress is structured/closed-attr,
// so content collisions concentrate exactly on the liveness signals this key
// most needs to separate — the shim dies as soon as the legacy-daemon share
// crosses the #457 threshold.
//
// Deliberately rejected keys, with the disease each carries:
// - clientSeq advance: the heartbeat allocates a fresh clientSeq per replay
//   (agentProcessManager nextActivityClientSeq), so seq-advance launders
//   stale replays into fresh observed truth — the I6 failure family.
// - producerFactId: today seq-DERIVED (buildActivityProducerFactId =
//   daemon_activity:agent:launch:clientSeq); every replay mints a fresh one,
//   inheriting the seq disease wholesale. Only a daemon-side construction
//   change (SMR-005A lineage semantics) could ever qualify it.
export interface LifecycleObservationIdentity {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  hasEntries: boolean;
  /** Explicit probe-response wire marker (agent:activity probeId echo). */
  probeId?: string | null;
}

export function classifyDaemonActivityObservation(input: {
  /** Producer-declared heartbeat/replay provenance (protocol bit). */
  declaredHeartbeat?: boolean | null;
  incoming: LifecycleObservationIdentity;
  lastAccepted?: LifecycleObservationIdentity;
}): Extract<LifecycleObservationClass, "observed" | "observed_turn_active" | "replayed"> {
  if (input.declaredHeartbeat === true) return "replayed";
  if (typeof input.incoming.probeId === "string" && input.incoming.probeId.length > 0) return "observed";
  const contentUnchanged = input.lastAccepted
    ? input.incoming.activity === input.lastAccepted.activity
      && input.incoming.detail === input.lastAccepted.detail
      && input.incoming.detailKind === input.lastAccepted.detailKind
    : false;
  if (input.declaredHeartbeat !== false && !input.incoming.hasEntries && contentUnchanged) return "replayed";
  if (input.incoming.activity === "working" && input.incoming.detailKind === "message_received") {
    return "observed_turn_active";
  }
  if (input.declaredHeartbeat === false) return "observed";
  if (input.incoming.hasEntries) return "observed";
  if (!input.lastAccepted) return "observed";
  return contentUnchanged ? "replayed" : "observed";
}
