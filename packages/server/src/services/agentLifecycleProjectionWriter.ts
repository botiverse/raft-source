// Design note: this writer is the single lifecycle projection output seam from
// rfcs/031-agent-lifecycle-event-model-rfc.zh.html.
//
// Reducers return projection plans; this module applies the side effects and
// records trace rows. Keep DB status writes, live activity emission, Activity
// Log persistence/dedupe, wake-projection trace outcomes, wake-lock release,
// launch-guard cleanup, and machine stop side effects centralized here. Do not
// let AgentOrchestrator or legacy adapters bypass this writer for lifecycle
// product semantics.
//
// Source discussion: #proj-runtime:4dbe9aa7.
import type { AgentActivityDetailKind, AgentActivityKind, AgentStatus, TrajectoryEntry } from "@botiverse/raft-shared";
import type { ActiveSpan } from "@botiverse/raft-shared";
import {
  AGENT_LIFECYCLE_EVENT_TRACE_NAME,
  AGENT_LIFECYCLE_PROJECTION_TRACE_NAME,
  createAgentLifecycleProjectionTraceRows,
  toAgentLifecycleEventTraceAttrs,
  toAgentLifecycleProjectionTraceAttrs,
  type AgentLifecycleEventType,
  type AgentLifecycleTraceAttrs,
  type CreateAgentLifecycleProjectionInput,
} from "./agentLifecycleEvents.js";
import {
  lifecyclePlanShadowDecision,
  shouldEmitLiveActivity,
  type AgentLifecycleProjectionPlan,
  type LifecycleObservationClass,
  type LifecycleRuntimeState,
  type LifecycleShadowSignalSite,
} from "./agentLifecycleReducer.js";

export type ActivityPersistenceOutcome = "applied" | "deduped" | "error";

export interface LifecycleActivityBroadcastResult {
  action?: string;
  arbitration?: {
    enabled: boolean;
    reason: string;
    verdictAction: string;
  };
  persistedEntryCount?: number;
  previousActivity?: AgentActivityKind | null;
  nextActivity?: AgentActivityKind;
  persistence?: Promise<ActivityPersistenceOutcome>;
}

export interface AgentLifecycleProjectionWriterDeps {
  broadcastActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    entries?: TrajectoryEntry[],
    nowOverride?: number,
    options?: {
      dedupeKey?: string;
      /**
       * Optional daemon socket-message join keys. Threaded into the
       * Socket.IO `agent:activity` payload so feedback-export bundles
       * preserve row-level exact-join correlation against
       * `server.agent.activity.ingest`. Absent for server-initiated
       * broadcasts (synth online, ready_online, etc) — only daemon
       * `agent:activity` ingests populate them.
       * Leiysky #proj-daemon:f8397295 task #136, 2026-06-21.
       */
      launchId?: string;
      clientSeq?: number;
      probeId?: string;
      producerFactId?: string;
      observedAtMs?: number;
      isHeartbeat?: boolean;
      arbitration?: {
        observationClass: LifecycleObservationClass;
        signalSite: LifecycleShadowSignalSite;
        planKind?: AgentLifecycleEventType;
      };
    },
  ): LifecycleActivityBroadcastResult;
  broadcastReadyOnline(agentId: string, span?: ActiveSpan | null): Promise<void>;
  /**
   * gamma-3 write-site closure: emits the lifecycle_v2.shadow_verdict for a
   * plan-path liveActivity write (site=lifecycle_plan, sub-family =
   * shadow_plan_kind). Called by the writer at the broadcast seam for every
   * emitted plan whose family is not already handler-emitted (see
   * lifecyclePlanShadowDecision). Required, not optional: a deps without
   * this emitter would silently reopen the g2 traceless-writer hole.
   */
  emitLifecyclePlanShadowVerdict(
    agentId: string,
    signal: {
      activity: AgentActivityKind;
      detailKind: AgentActivityDetailKind;
      observationClass: LifecycleObservationClass;
      planKind: AgentLifecycleEventType;
    },
    span?: ActiveSpan | null,
  ): void;
  clearInbox(agentId: string): void;
  clearLaunchGuard(agentId: string): void;
  maybeResolveStartingActivity(agentId: string, span?: ActiveSpan | null): void;
  persistAgentStatus(agentId: string, status: AgentStatus, sessionId?: string): Promise<void>;
  persistAgentStatusFromSignal(agentId: string, status: AgentStatus, sessionId?: string): Promise<boolean>;
  releaseWakeLock(agentId: string): void;
  sendBestEffortStopToMachine(machineId: string, agentId: string): void;
  sendStopToMachine(machineId: string, agentId: string): Promise<boolean>;
  terminalizeFreshnessHold(agentId: string, reason: "freshness_hold_terminalized", span?: ActiveSpan | null): void;
  updateCache(agentId: string, updates: {
    machineId?: string | null;
    runtimeState?: LifecycleRuntimeState;
    sessionId?: string | null;
    status?: AgentStatus;
  }): void;
}

export interface AppliedAgentLifecycleProjection {
  activityOutcome?: ActivityPersistenceOutcome;
  dbStatusApplied?: boolean;
  liveActivityResult?: LifecycleActivityBroadcastResult;
  stopSent?: boolean;
}

export async function applyAgentLifecycleProjectionPlan(
  plan: AgentLifecycleProjectionPlan,
  deps: AgentLifecycleProjectionWriterDeps,
  span?: ActiveSpan | null,
): Promise<AppliedAgentLifecycleProjection> {
  const agentId = plan.event.agentId;
  let dbStatusApplied: boolean | undefined;
  let stopSent: boolean | undefined;

  if (plan.sideEffects?.sendStopToMachine && plan.event.machineId) {
    if (plan.sideEffects.sendStopToMachine === "best_effort") {
      deps.sendBestEffortStopToMachine(plan.event.machineId, agentId);
    } else {
      stopSent = await deps.sendStopToMachine(plan.event.machineId, agentId);
    }
  }

  if (plan.sideEffects?.clearInbox) deps.clearInbox(agentId);
  if (plan.sideEffects?.updateCache) deps.updateCache(agentId, plan.sideEffects.updateCache);
  if (plan.sideEffects?.clearLaunchGuard) deps.clearLaunchGuard(agentId);
  if (plan.sideEffects?.releaseWakeLock) deps.releaseWakeLock(agentId);
  if (plan.sideEffects?.resolveStartingActivity) deps.maybeResolveStartingActivity(agentId, span);
  if (plan.sideEffects?.terminalizeFreshnessHold) deps.terminalizeFreshnessHold(agentId, plan.sideEffects.terminalizeFreshnessHold, span);

  if (plan.dbStatus.kind === "apply") {
    if (plan.dbStatus.writer === "signal") {
      dbStatusApplied = await deps.persistAgentStatusFromSignal(agentId, plan.dbStatus.status, plan.dbStatus.sessionId);
    } else {
      await deps.persistAgentStatus(agentId, plan.dbStatus.status, plan.dbStatus.sessionId);
      dbStatusApplied = true;
    }
  }

  let liveActivityOutcome: CreateAgentLifecycleProjectionInput["outcome"] = "skipped";
  let liveActivityResult: LifecycleActivityBroadcastResult | undefined;
  let liveActivitySkippedReason: string | undefined;
  let activityLogOutcome: CreateAgentLifecycleProjectionInput["outcome"] = "skipped";
  let activityLogSkippedReason = plan.activityLog.skippedReason;
  let activityOutcome: ActivityPersistenceOutcome | undefined;

  if (plan.liveActivity.kind === "ready_online") {
    await deps.broadcastReadyOnline(agentId, span);
    liveActivityOutcome = "applied";
    activityLogSkippedReason ??= "online_recovery_may_be_persisted_by_broadcast_ready_online";
  } else if (plan.liveActivity.kind === "emit") {
    const shouldEmit = shouldEmitLiveActivity({
      liveActivity: plan.liveActivity,
      nextStatus: plan.sideEffects?.updateCache?.status,
      stopSent,
    });
    if (shouldEmit) {
      // gamma-3: the plan path was the g2 invariant-#7 catch (disconnect
      // offline / start working legs wrote the map verdict-less). Emit at
      // the seam unless the family is handler-emitted (explicit skip-set).
      const shadowDecision = lifecyclePlanShadowDecision(plan.event);
      if (shadowDecision.kind === "emit") {
        deps.emitLifecyclePlanShadowVerdict(
          agentId,
          {
            activity: plan.liveActivity.activity,
            detailKind: plan.liveActivity.detailKind,
            observationClass: shadowDecision.observationClass,
            planKind: shadowDecision.planKind,
          },
          span,
        );
      }
      const arbitration = plan.liveActivity.arbitrationObservationClass
        ? {
            observationClass: plan.liveActivity.arbitrationObservationClass,
            signalSite: plan.liveActivity.arbitrationSignalSite ?? "lifecycle_plan",
            ...(plan.liveActivity.arbitrationPlanKind !== undefined ? { planKind: plan.liveActivity.arbitrationPlanKind } : {}),
          }
        : shadowDecision.kind === "emit"
          ? {
              observationClass: shadowDecision.observationClass,
              signalSite: "lifecycle_plan" as const,
              planKind: shadowDecision.planKind,
            }
          : plan.event.attrs?.synthetic_repair === true
            ? {
                observationClass: "synthetic" as const,
                signalSite: "synthetic_repair" as const,
                planKind: plan.event.eventType,
              }
            : {
                observationClass: "observed" as const,
                signalSite: "lifecycle_plan" as const,
                planKind: plan.event.eventType,
              };
      const result = deps.broadcastActivity(
        agentId,
        plan.liveActivity.activity,
        plan.liveActivity.detail,
        plan.liveActivity.detailKind,
        plan.liveActivity.entries,
        plan.liveActivity.nowOverride,
        {
          dedupeKey: plan.liveActivity.dedupeKey,
          // Pass-through join keys (task #136). Omitted fields stay
          // undefined down the chain; the orchestrator's broadcast →
          // emitActivity layer will likewise omit them from the
          // Socket.IO payload, so feedback-export bundles classify
          // those rows as `join_key_missing` rather than synthesizing
          // a `legacy` placeholder.
          ...(plan.liveActivity.launchId !== undefined ? { launchId: plan.liveActivity.launchId } : {}),
          ...(plan.liveActivity.clientSeq !== undefined ? { clientSeq: plan.liveActivity.clientSeq } : {}),
          ...(plan.liveActivity.probeId !== undefined ? { probeId: plan.liveActivity.probeId } : {}),
          ...(plan.liveActivity.producerFactId !== undefined ? { producerFactId: plan.liveActivity.producerFactId } : {}),
          ...(plan.liveActivity.observedAtMs !== undefined ? { observedAtMs: plan.liveActivity.observedAtMs } : {}),
          ...(plan.liveActivity.isHeartbeat !== undefined ? { isHeartbeat: plan.liveActivity.isHeartbeat } : {}),
          arbitration,
        },
      );
      liveActivityResult = result;
      activityOutcome = await result.persistence;
      if (result.action === "kernel-preserve") {
        liveActivityOutcome = "skipped";
        liveActivitySkippedReason = "kernel_preserve";
        activityLogSkippedReason ??= "kernel_preserve";
      } else {
        liveActivityOutcome = "applied";
        activityLogOutcome = activityOutcome ?? "skipped";
        if (result.action === "heartbeat-refresh") {
          activityLogSkippedReason ??= "heartbeat_refresh";
        } else if (result.action === "probe-refresh") {
          activityLogSkippedReason ??= "probe_refresh";
        }
      }
    } else {
      liveActivitySkippedReason = "no_visible_activity_for_internal_stop";
      activityLogSkippedReason ??= "no_visible_activity_for_internal_stop";
    }
  } else {
    liveActivitySkippedReason = plan.liveActivity.skippedReason;
    activityLogSkippedReason ??= plan.liveActivity.skippedReason;
  }

  recordLifecycleProjectionTrace(span, plan, {
    activityLogOutcome,
    activityLogSkippedReason,
    liveActivityOutcome,
    liveActivitySkippedReason,
  });

  return { activityOutcome, dbStatusApplied, liveActivityResult, stopSent };
}

function recordLifecycleProjectionTrace(
  span: ActiveSpan | null | undefined,
  plan: AgentLifecycleProjectionPlan,
  outcomes: {
    activityLogOutcome: CreateAgentLifecycleProjectionInput["outcome"];
    activityLogSkippedReason?: string;
    liveActivityOutcome: CreateAgentLifecycleProjectionInput["outcome"];
    liveActivitySkippedReason?: string;
  },
) {
  if (!span) return;
  const projections: CreateAgentLifecycleProjectionInput[] = [
    {
      projectionKind: "db_status",
      outcome: plan.dbStatus.kind === "apply" ? "applied" : "skipped",
      ...(plan.dbStatus.kind === "skip" ? { skippedReason: plan.dbStatus.skippedReason } : {}),
      attrs: plan.dbStatus.attrs,
    },
    {
      projectionKind: "wake_eligibility",
      outcome: "applied",
      attrs: {
        ...plan.wakeEligibility.attrs,
        wake_eligibility: plan.wakeEligibility.eligible,
        ...(plan.wakeEligibility.blockReason ? { wake_block_reason: plan.wakeEligibility.blockReason } : {}),
      },
    },
    {
      projectionKind: "live_activity",
      outcome: outcomes.liveActivityOutcome,
      ...(outcomes.liveActivitySkippedReason ? { skippedReason: outcomes.liveActivitySkippedReason } : {}),
      attrs: liveActivityTraceAttrs(plan),
    },
    {
      projectionKind: "activity_log",
      outcome: outcomes.activityLogOutcome,
      ...(plan.activityLog.dedupeKey ? { dedupeKey: plan.activityLog.dedupeKey } : {}),
      ...(outcomes.activityLogSkippedReason ? { skippedReason: outcomes.activityLogSkippedReason } : {}),
      attrs: {
        ...plan.activityLog.attrs,
        label_kind: plan.activityLog.labelKind,
      },
    },
  ];

  span.addEvent(AGENT_LIFECYCLE_EVENT_TRACE_NAME, toAgentLifecycleEventTraceAttrs(plan.event));
  for (const row of createAgentLifecycleProjectionTraceRows(plan.event, projections)) {
    span.addEvent(AGENT_LIFECYCLE_PROJECTION_TRACE_NAME, toAgentLifecycleProjectionTraceAttrs(row));
  }
}

function liveActivityTraceAttrs(plan: AgentLifecycleProjectionPlan): AgentLifecycleTraceAttrs {
  if (plan.liveActivity.kind === "ready_online") {
    return {
      ...plan.liveActivity.attrs,
      activity_status: "online",
      detail_kind: plan.liveActivity.detailKind,
    };
  }
  if (plan.liveActivity.kind === "emit") {
    return {
      ...plan.liveActivity.attrs,
      activity_status: plan.liveActivity.activity,
      detail_kind: plan.liveActivity.detailKind,
    };
  }
  return plan.liveActivity.attrs ?? {};
}
