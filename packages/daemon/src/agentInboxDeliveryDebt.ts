import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import { RuntimeNotificationState } from "./runtimeNotificationState.js";

export type SessionReadyDeliveryRetryFlushSource = "timer";

export type SessionInitDeliveryDebtRetryReason =
  | "session_init_ready_with_pending_delivery"
  | "session_init_with_pending_delivery";

export type SessionReadyDeliveryRetryState =
  | { kind: "idle"; scheduler: null; attempts: 0 }
  | { kind: "scheduled"; scheduler: RuntimeNotificationState; attempts: number; reason: string };

export interface PendingInboxDeliveryProcess {
  inbox: AgentMessage[];
  config: Pick<AgentConfig, "runtime" | "model">;
  sessionId: string | null;
  sessionReadyForDelivery: boolean;
  launchId: string | null;
  driver: { supportsStdinNotification: boolean; liveSessionReadyAt?: "session_init" | "turn_end" };
  notifications: RuntimeNotificationState;
  sessionReadyDeliveryRetry: SessionReadyDeliveryRetryState;
}

type RecordDaemonTrace = (name: string, attrs?: Record<string, unknown>, status?: "ok" | "error" | "cancelled") => void;

export function createSessionReadyDeliveryRetryState(): SessionReadyDeliveryRetryState {
  return { kind: "idle", scheduler: null, attempts: 0 };
}

let sessionReadyDeliveryRetrySchedulerFactoryForTesting: (() => RuntimeNotificationState) | null = null;

export function setSessionReadyDeliveryRetrySchedulerFactoryForTesting(
  factory: (() => RuntimeNotificationState) | null,
): void {
  sessionReadyDeliveryRetrySchedulerFactoryForTesting = factory;
}

function createSessionReadyDeliveryRetryScheduler(): RuntimeNotificationState {
  return sessionReadyDeliveryRetrySchedulerFactoryForTesting?.() ?? new RuntimeNotificationState();
}

export function clearSessionReadyDeliveryRetry(ap: PendingInboxDeliveryProcess): void {
  if (ap.sessionReadyDeliveryRetry.kind === "scheduled") {
    ap.sessionReadyDeliveryRetry.scheduler.clearTimer();
  }
  ap.sessionReadyDeliveryRetry = createSessionReadyDeliveryRetryState();
}

export function samePendingDelivery(left: AgentMessage, right: AgentMessage): boolean {
  if (left.message_id && right.message_id) return left.message_id === right.message_id;
  if (typeof left.seq === "number" && left.seq > 0 && typeof right.seq === "number" && right.seq > 0) {
    return left.seq === right.seq;
  }
  return false;
}

export function queueAgentInboxMessage(
  ap: Pick<PendingInboxDeliveryProcess, "inbox">,
  message: AgentMessage,
): { duplicate: boolean; inboxCount: number } {
  if (ap.inbox.some((pending) => samePendingDelivery(pending, message))) {
    return { duplicate: true, inboxCount: ap.inbox.length };
  }
  ap.inbox.push(message);
  return { duplicate: false, inboxCount: ap.inbox.length };
}

export function prepareSessionInitDeliveryDebtRetry(
  ap: PendingInboxDeliveryProcess,
  previousSessionId: string | null,
): SessionInitDeliveryDebtRetryReason | null {
  const wasReady = ap.sessionReadyForDelivery;
  if (ap.sessionId && ap.driver.liveSessionReadyAt !== "turn_end") {
    ap.sessionReadyForDelivery = true;
  }
  if (ap.inbox.length === 0) return null;
  if (ap.sessionReadyForDelivery && (!wasReady || previousSessionId !== ap.sessionId)) {
    return "session_init_ready_with_pending_delivery";
  }
  return ap.sessionReadyForDelivery ? null : "session_init_with_pending_delivery";
}

export function scheduleSessionReadyDeliveryRetry<TProcess extends PendingInboxDeliveryProcess>(
  agentId: string,
  ap: TProcess,
  reason: string,
  opts: {
    delayMs: number;
    readyDelayCapMs: number;
    canDeliverToRuntimeSession: (ap: TProcess) => boolean;
    flush: (agentId: string, source: SessionReadyDeliveryRetryFlushSource) => boolean;
    recordDaemonTrace: RecordDaemonTrace;
  },
): boolean {
  if (ap.sessionReadyDeliveryRetry.kind === "scheduled" && ap.sessionReadyDeliveryRetry.scheduler.hasTimer) return false;
  const sessionReadyForDelivery = opts.canDeliverToRuntimeSession(ap);
  const settleReady = reason === "session_init_ready_with_pending_delivery";
  if (
    !ap.driver.supportsStdinNotification
    || !ap.sessionId
    || (sessionReadyForDelivery && !settleReady)
    || ap.inbox.length === 0
  ) {
    return false;
  }
  const attempts = ap.sessionReadyDeliveryRetry.attempts + 1;
  const state: SessionReadyDeliveryRetryState = {
    kind: "scheduled",
    attempts,
    reason,
    scheduler: createSessionReadyDeliveryRetryScheduler(),
  };
  const delayMs = settleReady ? Math.min(opts.delayMs, opts.readyDelayCapMs) : opts.delayMs;
  state.scheduler.schedule(() => {
    if (ap.sessionReadyDeliveryRetry === state) state.scheduler.clearTimer();
    opts.flush(agentId, "timer");
  }, delayMs);
  ap.sessionReadyDeliveryRetry = state;
  opts.recordDaemonTrace("daemon.agent.session_ready_delivery_retry.scheduled", {
    agentId,
    runtime: ap.config.runtime,
    model: ap.config.model,
    launchId: ap.launchId || undefined,
    reason,
    attempts,
    delay_ms: delayMs,
    inbox_count: ap.inbox.length,
    session_id_present: true,
    session_ready_for_delivery: sessionReadyForDelivery,
  });
  return true;
}

export function flushSessionReadyDeliveryRetry<TProcess extends PendingInboxDeliveryProcess>(
  agentId: string,
  source: SessionReadyDeliveryRetryFlushSource,
  opts: {
    getProcess: (agentId: string) => TProcess | undefined;
    canDeliverToRuntimeSession: (ap: TProcess) => boolean;
    isApmIdle: (ap: TProcess) => boolean;
    commitApmIdleState: (agentId: string, ap: TProcess, idle: boolean) => void;
    startRuntimeTrace: (agentId: string, ap: TProcess, name: string, messages: AgentMessage[]) => void;
    deliverInboxUpdateViaStdin: (
      agentId: string,
      ap: TProcess,
      messages: AgentMessage[],
      mode: "idle",
      source: string,
    ) => boolean;
    sendStdinNotification: (agentId: string, options?: { forceUnsupportedRetry?: boolean }) => boolean;
    recordDaemonTrace: RecordDaemonTrace;
  },
): boolean {
  const ap = opts.getProcess(agentId);
  if (!ap) return false;
  if (ap.sessionReadyDeliveryRetry.kind === "scheduled") {
    ap.sessionReadyDeliveryRetry.scheduler.clearTimer();
  }
  const attempts = ap.sessionReadyDeliveryRetry.attempts;
  const reason = ap.sessionReadyDeliveryRetry.kind === "scheduled" ? ap.sessionReadyDeliveryRetry.reason : "none";
  ap.sessionReadyDeliveryRetry = createSessionReadyDeliveryRetryState();
  if (ap.inbox.length === 0) return false;
  if (!ap.driver.supportsStdinNotification || !ap.sessionId) {
    opts.recordDaemonTrace("daemon.agent.session_ready_delivery_retry.flush", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      reason,
      attempts,
      outcome: "queued_without_stdin",
      inbox_count: ap.inbox.length,
      session_id_present: Boolean(ap.sessionId),
      supports_stdin_notification: ap.driver.supportsStdinNotification,
    });
    return false;
  }

  if (!opts.canDeliverToRuntimeSession(ap)) {
    ap.sessionReadyForDelivery = true;
    opts.recordDaemonTrace("daemon.agent.session_ready_for_delivery.timeout", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      reason,
      attempts,
      inbox_count: ap.inbox.length,
      session_id_present: true,
      session_ready_for_delivery: true,
    });
  }

  const isIdle = opts.isApmIdle(ap);
  if (isIdle) {
    ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
    const messages = ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId);
    if (messages.length === 0) {
      opts.recordDaemonTrace("daemon.agent.session_ready_delivery_retry.flush", {
        agentId,
        runtime: ap.config.runtime,
        model: ap.config.model,
        launchId: ap.launchId || undefined,
        source,
        reason,
        attempts,
        mode: "idle",
        outcome: "suppressed_already_contributed",
        inbox_count: ap.inbox.length,
        messages_count: 0,
        session_id_present: true,
      });
      return false;
    }
    opts.commitApmIdleState(agentId, ap, false);
    opts.startRuntimeTrace(agentId, ap, "session-ready-delivery-retry", messages);
    const accepted = opts.deliverInboxUpdateViaStdin(
      agentId,
      ap,
      messages,
      "idle",
      "session_ready_delivery_retry",
    );
    opts.recordDaemonTrace("daemon.agent.session_ready_delivery_retry.flush", {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      source,
      reason,
      attempts,
      mode: "idle",
      outcome: accepted ? "written" : "not_written",
      inbox_count: ap.inbox.length,
      messages_count: messages.length,
      session_id_present: true,
    });
    return accepted;
  }

  if (ap.notifications.pendingCount === 0) {
    ap.notifications.add(ap.inbox.length);
  }
  const accepted = opts.sendStdinNotification(agentId, { forceUnsupportedRetry: true });
  opts.recordDaemonTrace("daemon.agent.session_ready_delivery_retry.flush", {
    agentId,
    runtime: ap.config.runtime,
    model: ap.config.model,
    launchId: ap.launchId || undefined,
    source,
    reason,
    attempts,
    mode: "busy",
    outcome: accepted ? "written" : "not_written",
    inbox_count: ap.inbox.length,
    pending_notification_count: ap.notifications.pendingCount,
    session_id_present: true,
  });
  return accepted;
}

export function flushIdleInboxDeliveryRetry<TProcess extends PendingInboxDeliveryProcess>(
  agentId: string,
  source: string,
  traceName: string,
  opts: {
    getProcess: (agentId: string) => TProcess | undefined;
    isApmIdle: (ap: TProcess) => boolean;
    commitApmIdleState: (agentId: string, ap: TProcess, idle: boolean) => void;
    startRuntimeTrace: (agentId: string, ap: TProcess, name: string, messages: AgentMessage[]) => void;
    deliverInboxUpdateViaStdin: (
      agentId: string,
      ap: TProcess,
      messages: AgentMessage[],
      mode: "idle",
      source: string,
    ) => boolean;
    sendStdinNotification: (agentId: string, options?: { forceUnsupportedRetry?: boolean }) => boolean;
    recordDaemonTrace: RecordDaemonTrace;
  },
): boolean {
  const ap = opts.getProcess(agentId);
  if (!ap) return false;

  const count = ap.notifications.takePendingAndClearTimer();
  if (count === 0) return false;
  if (!ap.driver.supportsStdinNotification || !ap.sessionId || ap.inbox.length === 0) {
    ap.notifications.add(count);
    opts.recordDaemonTrace(traceName, {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      mode: "idle",
      outcome: "queued_without_stdin",
      inbox_count: ap.inbox.length,
      pending_notification_count: ap.notifications.pendingCount,
      session_id_present: Boolean(ap.sessionId),
      supports_stdin_notification: ap.driver.supportsStdinNotification,
    });
    return false;
  }

  if (!opts.isApmIdle(ap)) {
    ap.notifications.add(count);
    return opts.sendStdinNotification(agentId, { forceUnsupportedRetry: true });
  }

  ap.notifications.pruneContributedToPending(ap.inbox, ap.sessionId);
  const messages = ap.notifications.filterUncontributedMessages(ap.inbox, ap.sessionId);
  if (messages.length === 0) {
    opts.recordDaemonTrace(traceName, {
      agentId,
      runtime: ap.config.runtime,
      model: ap.config.model,
      launchId: ap.launchId || undefined,
      mode: "idle",
      outcome: "suppressed_already_contributed",
      inbox_count: ap.inbox.length,
      pending_notification_count: count,
      session_id_present: true,
    });
    return false;
  }

  opts.commitApmIdleState(agentId, ap, false);
  opts.startRuntimeTrace(agentId, ap, source.replaceAll("_", "-"), messages);
  const accepted = opts.deliverInboxUpdateViaStdin(
    agentId,
    ap,
    messages,
    "idle",
    source,
  );
  opts.recordDaemonTrace(traceName, {
    agentId,
    runtime: ap.config.runtime,
    model: ap.config.model,
    launchId: ap.launchId || undefined,
    mode: "idle",
    outcome: accepted ? "written" : "not_written",
    inbox_count: ap.inbox.length,
    messages_count: messages.length,
    session_id_present: true,
  });
  return accepted;
}
