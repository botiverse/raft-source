import {
  reduceApmGatedAssistantContinuation,
  reduceApmIdleState,
  type ApmGatedSteeringDecisionState,
} from "./apmStateMachine.js";
import type {
  RuntimeBusyDeliveryReadiness,
  RuntimeTurnAttribution,
} from "./drivers/index.js";

type RuntimeBusyDeliveryClosedReason =
  Extract<RuntimeBusyDeliveryReadiness, { ready: false }>["reason"];

export interface RuntimeBusyDeliveryProcess {
  config: {
    runtime: string;
    model: string;
  };
  runtime: {
    descriptor: {
      busyDelivery: string;
    };
  };
  driver: {
    busyDeliveryReadiness?: () => RuntimeBusyDeliveryReadiness;
  };
  inbox: Array<{
    timestamp: string;
  }>;
  notifications: {
    readonly pendingCount: number;
    add(count?: number): number;
  };
  sessionId: string | null;
  sessionReadyForDelivery: boolean;
  launchId: string | null;
  gatedSteering: ApmGatedSteeringDecisionState;
}

export interface RuntimeBusyDeliveryCoordinatorHooks<
  Process extends RuntimeBusyDeliveryProcess,
> {
  nowMs(): number;
  commitDecisionState(
    agentId: string,
    process: Process,
    nextState: ApmGatedSteeringDecisionState,
  ): void;
  flushDirectNotification(agentId: string, process: Process, source: string): boolean;
  flushIdleDelivery(agentId: string, source: string, traceName: string): boolean;
  recordDaemonTrace(
    name: string,
    attrs?: Record<string, unknown>,
    status?: "ok" | "error" | "cancelled",
  ): void;
  recordRuntimeTraceEvent(
    agentId: string,
    process: Process,
    name: string,
    attrs?: Record<string, unknown>,
  ): void;
}

function bucketMs(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 900_000) return "5-15m";
  if (ms < 3_600_000) return "15-60m";
  return ">60m";
}

function pendingInboxAgeMs(
  process: RuntimeBusyDeliveryProcess,
  nowMs: number,
): number | undefined {
  let oldestMs: number | null = null;
  for (const message of process.inbox) {
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    oldestMs = oldestMs === null ? timestampMs : Math.min(oldestMs, timestampMs);
  }
  return oldestMs === null ? undefined : Math.max(0, nowMs - oldestMs);
}

function canDeliverToRuntimeSession(process: RuntimeBusyDeliveryProcess): boolean {
  return Boolean(process.sessionId && process.sessionReadyForDelivery);
}

/**
 * Reconciles the APM's projected busy phase with the driver's native direct-
 * delivery gate. The coordinator owns no process state; all commits and side
 * effects remain explicit hooks supplied by the APM composition root.
 */
export class RuntimeBusyDeliveryCoordinator<
  Process extends RuntimeBusyDeliveryProcess,
> {
  constructor(private readonly hooks: RuntimeBusyDeliveryCoordinatorHooks<Process>) {}

  reconcile(
    agentId: string,
    process: Process,
    source: string,
  ): RuntimeBusyDeliveryClosedReason | undefined {
    if (process.gatedSteering.isIdle) return undefined;
    if (process.runtime.descriptor.busyDelivery !== "direct") return undefined;
    if (!canDeliverToRuntimeSession(process)) return undefined;
    const readiness = process.driver.busyDeliveryReadiness?.();
    if (!readiness || readiness.ready) return undefined;

    const reduction = reduceApmIdleState(process.gatedSteering, { isIdle: true });
    this.hooks.commitDecisionState(agentId, process, reduction.nextState);
    const pendingAgeMs = pendingInboxAgeMs(process, this.hooks.nowMs());
    this.hooks.recordDaemonTrace("daemon.agent.busy_delivery.readiness_reconciled", {
      agentId,
      runtime: process.config.runtime,
      model: process.config.model,
      launchId: process.launchId || undefined,
      source,
      outcome: "closed",
      closed_reason: readiness.reason,
      apm_idle_before: false,
      apm_idle_after: true,
      inbox_count: process.inbox.length,
      pending_notification_count: process.notifications.pendingCount,
      pending_age_ms_bucket: pendingAgeMs === undefined ? undefined : bucketMs(pendingAgeMs),
    });
    return readiness.reason;
  }

  applyAssistantContinuation(
    agentId: string,
    process: Process,
    eventKind: "thinking" | "text",
    runtimeTurn: RuntimeTurnAttribution | undefined,
  ): void {
    if (runtimeTurn?.state !== "completed") {
      const reduction = reduceApmGatedAssistantContinuation(process.gatedSteering);
      this.hooks.commitDecisionState(
        agentId,
        process,
        reduction.nextState,
      );
      this.hooks.flushDirectNotification(agentId, process, eventKind);
      return;
    }

    // Late output stays visible to trajectory/progress without reopening the
    // APM busy phase after the driver has terminally attributed its generation.
    this.hooks.recordRuntimeTraceEvent(
      agentId,
      process,
      "runtime.assistant_output.late_terminal",
      {
        event_kind: eventKind,
        runtime_turn_generation: runtimeTurn.generation,
        runtime_turn_state: runtimeTurn.state,
        outcome: "observable_without_busy_revival",
      },
    );
    const closedReason = this.reconcile(agentId, process, `late_${eventKind}`);
    if (
      !process.gatedSteering.isIdle
      || process.notifications.pendingCount === 0
      || process.inbox.length === 0
    ) {
      return;
    }
    this.flushPendingDeliveryFromIdle(
      agentId,
      process,
      "late_terminal_output_idle_flush",
      "late_terminal_output",
      closedReason,
    );
  }

  flushClosedNotificationDebt(agentId: string, process: Process): boolean | undefined {
    const closedReason = this.reconcile(agentId, process, "busy_notification_attempt");
    if (!closedReason) return undefined;
    if (process.notifications.pendingCount === 0 || process.inbox.length === 0) {
      return false;
    }
    return this.flushPendingDeliveryFromIdle(
      agentId,
      process,
      "driver_closed_busy_delivery",
      "driver_closed_busy_delivery",
      closedReason,
    );
  }

  flushNotificationDebtIfIdle(
    agentId: string,
    process: Process,
    notificationCount: number,
  ): boolean | undefined {
    if (!process.gatedSteering.isIdle) return undefined;
    process.notifications.add(notificationCount);
    return this.flushPendingDeliveryFromIdle(
      agentId,
      process,
      "idle_notification_debt_flush",
      "notification_timer_observed_idle",
    );
  }

  private flushPendingDeliveryFromIdle(
    agentId: string,
    process: Process,
    source: string,
    trigger: string,
    closedReason?: RuntimeBusyDeliveryClosedReason,
  ): boolean {
    const pendingAgeMs = pendingInboxAgeMs(process, this.hooks.nowMs());
    const flushed = this.hooks.flushIdleDelivery(
      agentId,
      source,
      "daemon.agent.pending_delivery.flush",
    );
    this.hooks.recordDaemonTrace(
      "daemon.agent.pending_delivery.flush_outcome",
      {
        agentId,
        runtime: process.config.runtime,
        model: process.config.model,
        launchId: process.launchId || undefined,
        trigger,
        closed_reason: closedReason,
        outcome: flushed ? "written_idle" : "not_written",
        inbox_count: process.inbox.length,
        pending_notification_count: process.notifications.pendingCount,
        pending_age_ms_bucket: pendingAgeMs === undefined ? undefined : bucketMs(pendingAgeMs),
      },
      flushed ? "ok" : "error",
    );
    return flushed;
  }
}
