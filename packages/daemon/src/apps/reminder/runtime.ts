import {
  currentDate,
  type AgentInboxAppItem,
  type MachineToServerMessage,
  type ReminderJob,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import {
  appSnapshotTraceAttrs,
  appSourceTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";

import type { AgentAppInboxStore } from "../../agentAppInbox.js";
import type { Clock } from "../../connection.js";
import { systemClock } from "../../connection.js";
import { logger } from "../../logger.js";
import type { ScopedAppStorage } from "../../scopedAppStorage.js";
import {
  isReminderDueInboxItem,
  projectReminderInboxTitle,
  reminderItemId,
} from "./inboxDefinition.js";
import {
  createReminderDueIdentity,
  createReminderPhaseTruth,
  REMINDER_BOUNDED_ALERT_PHASES,
  REMINDER_PHASE_TRANSITION_SOURCES,
  ReminderCache,
  type ReminderBoundedAlertPhase,
  type ReminderBoundedAlertPhaseTruth,
  type ReminderFireContext,
  type ReminderPhaseTransitionEvidence,
} from "./reminderCache.js";

type ReminderServerMessage = Extract<ServerToMachineMessage, { type: `reminder.${string}` }>;

export function reminderBoundedAlertPhaseAttrs(
  truth: ReminderBoundedAlertPhaseTruth,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const phase of REMINDER_BOUNDED_ALERT_PHASES) {
    const evidence = truth[phase];
    attrs[phase] = evidence.state;
    attrs[`${phase}_transition_evidence`] = evidence.evidence;
    attrs[`${phase}_transition_at`] = evidence.transition?.observedAt ?? null;
    attrs[`${phase}_transition_source`] = evidence.transition?.source ?? null;
  }
  return attrs;
}

function clonePhaseTruth(
  truth: ReminderBoundedAlertPhaseTruth,
): ReminderBoundedAlertPhaseTruth {
  return Object.fromEntries(
    REMINDER_BOUNDED_ALERT_PHASES.map((phase) => [
      phase,
      truth[phase].transition === null
        ? { ...truth[phase] }
        : { ...truth[phase], transition: { ...truth[phase].transition } },
    ]),
  ) as unknown as ReminderBoundedAlertPhaseTruth;
}

function reminderTraceAttrs(input: {
  ownerAgentId: string;
  reminderId: string;
  version: number;
  itemId?: string;
}) {
  return appSourceTraceAttrs({
    appId: "system.reminder",
    ownerAgentId: input.ownerAgentId,
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id: input.reminderId,
      revision: String(input.version),
    },
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
  });
}

/**
 * Closed inventory of every Server->Computer Reminder ingress that can mutate
 * owner-scoped state. A new protocol message cannot compile until its owner
 * fence mode and a matching contract scenario are added.
 */
export const REMINDER_OWNER_FENCE_KINDS = {
  "reminder.upsert": "payload-owner",
  "reminder.cancel": "cache-owner",
  "reminder.snapshot": "entry-owner",
  "reminder.fire_receipt.ack": "receipt-owner",
  "reminder.fire_request.result": "request-owner",
} as const satisfies Record<ReminderServerMessage["type"], string>;

export interface ReminderRuntimeOptions {
  clock?: Clock;
  getInbox(agentId: string): AgentAppInboxStore;
  notifyInbox(agentId: string, item: AgentInboxAppItem): Promise<boolean>;
  send(message: MachineToServerMessage): void;
  trace?: (
    name: string,
    attrs: Record<string, unknown>,
    status?: "ok" | "error",
  ) => void;
}

/** App-owned adapter between the generic daemon runtime and Reminder state. */
export function createReminderRuntime(options: ReminderRuntimeOptions) {
  const trace = options.trace ?? (() => {});
  const clock = options.clock ?? systemClock;
  const pendingSnapshotRequests = new Set<string>();
  type OccurrencePhase =
    | "fired"
    | "app_item_materialized"
    | "wake_request_accepted"
    | "wake_request_error"
    | "acknowledged"
    | "error";
  interface OccurrenceState {
    ownerAgentId: string;
    reminderId: string;
    version: number;
    occurrenceId: string;
    scheduledDue: string;
    fireDelayMs: number | null;
    phaseTruth: ReminderBoundedAlertPhaseTruth;
    acknowledged: boolean;
    observedPhases: Set<OccurrencePhase>;
    alertTimer: unknown | null;
  }
  const occurrencesByDue = new Map<string, OccurrenceState>();

  const dueKey = (input: { ownerAgentId: string; reminderId: string; version: number }) =>
    `${input.ownerAgentId}\u0000${input.reminderId}\u0000${input.version}`;

  const emitOccurrence = (
    state: OccurrenceState,
    phase: OccurrencePhase,
    reason?: string,
    observedAt = new Date(clock.now()).toISOString(),
  ) => {
    if (state.observedPhases.has(phase) && phase !== "error") return;
    trace(
      "daemon.app_schedule.occurrence",
      {
        ...reminderTraceAttrs(state),
        occurrence: state.occurrenceId,
        phase,
        outcome: "observed",
        observed_at: observedAt,
        ...(phase === "fired"
          ? {
            scheduled_due: state.scheduledDue,
            fire_delay_ms: state.fireDelayMs,
          }
          : {}),
        ...(reason === undefined ? {} : { reason }),
      },
      phase === "error" ? "error" : "ok",
    );
    state.observedPhases.add(phase);
  };

  const inheritBoundedPhase = (
    state: OccurrenceState,
    phase: ReminderBoundedAlertPhase,
    evidence: ReminderPhaseTransitionEvidence,
  ) => {
    const current = state.phaseTruth[phase];
    if (current.evidence === "observed") return;
    if (!evidence.state && current.state) return;
    state.phaseTruth = { ...state.phaseTruth, [phase]: evidence };
  };

  const observeBoundedPhase = (
    state: OccurrenceState,
    phase: ReminderBoundedAlertPhase,
    observedAt = new Date(clock.now()).toISOString(),
  ) => {
    if (state.phaseTruth[phase].evidence === "observed") return;
    const observed: ReminderPhaseTransitionEvidence = {
      state: true,
      evidence: "observed",
      transition: {
        occurrenceId: state.occurrenceId,
        observedAt,
        source: REMINDER_PHASE_TRANSITION_SOURCES[phase],
      },
    };
    emitOccurrence(state, phase, undefined, observedAt);
    state.phaseTruth = {
      ...state.phaseTruth,
      [phase]: observed,
    };
  };

  const getOccurrence = (
    job: ReminderJob,
    context: Pick<ReminderFireContext, "requestId" | "retryDeadlineAt" | "phaseTruth">,
  ) => {
    const key = dueKey({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    });
    const existing = occurrencesByDue.get(key);
    if (existing?.occurrenceId === context.requestId) return existing;
    if (existing?.alertTimer !== null && existing?.alertTimer !== undefined) {
      clock.clearTimeout(existing.alertTimer);
    }
    const state: OccurrenceState = {
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
      occurrenceId: context.requestId,
      scheduledDue: job.fireAt,
      fireDelayMs: null,
      phaseTruth: clonePhaseTruth(context.phaseTruth),
      acknowledged: false,
      observedPhases: new Set(),
      alertTimer: null,
    };
    const remainingMs = Math.max(0, Date.parse(context.retryDeadlineAt) - clock.now());
    state.alertTimer = clock.setTimeout(() => {
      state.alertTimer = null;
      if (state.acknowledged) return;
      trace(
        "daemon.app_schedule.delivery_alert",
        {
          ...reminderTraceAttrs(state),
          occurrence: state.occurrenceId,
          reason: "fired_but_unacknowledged",
          scheduled_due: state.scheduledDue,
          fire_delay_ms: state.fireDelayMs,
          ...reminderBoundedAlertPhaseAttrs(state.phaseTruth),
          turn_outcome: "unknown",
          acknowledged: state.acknowledged,
          observed_at: new Date(clock.now()).toISOString(),
        },
        "error",
      );
      if (occurrencesByDue.get(key)?.occurrenceId === state.occurrenceId) {
        occurrencesByDue.delete(key);
      }
    }, remainingMs);
    occurrencesByDue.set(key, state);
    return state;
  };

  const acknowledgeOccurrence = (input: {
    ownerAgentId: string;
    reminderId: string;
    version: number;
  }) => {
    const state = occurrencesByDue.get(dueKey(input));
    if (!state) return;
    state.acknowledged = true;
    if (state.alertTimer !== null) clock.clearTimeout(state.alertTimer);
    state.alertTimer = null;
    emitOccurrence(state, "acknowledged");
    occurrencesByDue.delete(dueKey(input));
  };

  const cache = new ReminderCache({
    clock: options.clock,
    onOccurrenceFired: ({ job, requestId, firedAtClient, retryDeadlineAt }) => {
      const initialTruth = createReminderPhaseTruth({ occurrenceId: requestId, firedAtClient });
      const occurrence = getOccurrence(job, {
        requestId,
        retryDeadlineAt,
        phaseTruth: {
          ...initialTruth,
          fired: {
            state: true,
            evidence: "transition_provenance_missing",
            transition: null,
          },
        },
      });
      occurrence.fireDelayMs = Date.parse(firedAtClient) - Date.parse(job.fireAt);
      observeBoundedPhase(occurrence, "fired", firedAtClient);
      return occurrence.phaseTruth.fired;
    },
    onFire: (job, context) => materializeFire(job, context),
    onRetryExhausted: (exhaustion) => {
      logger.error(
        `[Daemon] Reminder ${exhaustion.reminderId} delivery retry exhausted at ${exhaustion.stage}`,
      );
      trace("daemon.app_source.retry", {
        ...reminderTraceAttrs({
          ownerAgentId: exhaustion.ownerAgentId,
          reminderId: exhaustion.reminderId,
          version: exhaustion.version,
        }),
        outcome: "exhausted",
        code: exhaustion.code,
        stage: exhaustion.stage,
        attempts: exhaustion.attempts,
        deadline_at: exhaustion.deadlineAt,
      }, "error");
      const state = occurrencesByDue.get(dueKey(exhaustion));
      if (state?.occurrenceId === exhaustion.requestId) {
        emitOccurrence(state, "error", exhaustion.code);
      }
    },
  });

  const requestSnapshotOnce = (agentId: string, reason: "unsynchronized_upsert" | "agent_start") => {
    if (cache.isSynchronized(agentId) || pendingSnapshotRequests.has(agentId)) return false;
    pendingSnapshotRequests.add(agentId);
    options.send({ type: "reminder.snapshot.request", agentId });
    trace("daemon.app_source.snapshot_request", {
      ...appSnapshotTraceAttrs({
        appId: "system.reminder",
        ownerAgentId: agentId,
        snapshotKind: "reminder",
      }),
      outcome: "sent",
      reason,
    });
    return true;
  };

  const sendArmOutcome = (agentId: string, job: ReminderJob, applied: boolean) => {
    if (cache.isArmed(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    }))) {
      options.send({
        type: "reminder.armed",
        agentId,
        reminderId: job.reminderId,
        version: job.version,
        armedAtClient: currentDate().toISOString(),
      });
      trace("daemon.app_source.arm", {
        ...reminderTraceAttrs({
          ownerAgentId: agentId,
          reminderId: job.reminderId,
          version: job.version,
        }),
        outcome: "armed",
      });
    } else if (applied && cache.isSynchronized(agentId)) {
      options.send({
        type: "reminder.arm_rejected",
        agentId,
        reminderId: job.reminderId,
        version: job.version,
        reason: "invalid_fire_at",
      });
      trace(
        "daemon.app_source.arm",
        {
          ...reminderTraceAttrs({
            ownerAgentId: agentId,
            reminderId: job.reminderId,
            version: job.version,
          }),
          outcome: "rejected",
          reason: "invalid_fire_at",
        },
        "error",
      );
    }
  };

  const sendFireRequest = (job: ReminderJob, context: ReminderFireContext) => {
    options.send({
      type: "reminder.fire_request",
      agentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
      requestId: context.requestId,
      firedAtClient: context.firedAtClient,
    });
    trace("daemon.app_source.receipt", {
      ...reminderTraceAttrs({
        ownerAgentId: job.ownerAgentId,
        reminderId: job.reminderId,
        version: job.version,
      }),
      outcome: "sent",
      request_id: context.requestId,
    });
  };

  async function materializeFire(job: ReminderJob, context: ReminderFireContext) {
    // One fail-closed authority gate: a local timer may request a transition,
    // but cannot mint user-visible work until the Server has both accepted the
    // exact revision and confirmed that it represents a supported fire.
    if (!context.serverAcked || !context.serverFired) {
      if (!context.serverAcked) sendFireRequest(job, context);
      return { wakeEnqueued: false, retryStage: "fire_request" as const };
    }
    logger.info(`[Daemon] Reminder ${job.reminderId} fired locally (agent=${job.ownerAgentId})`);
    const inbox = options.getInbox(job.ownerAgentId);
    if (context.itemConsumed) {
      // Complete a crash-interrupted cross-store acknowledgement without
      // rematerializing or re-waking the already-read source item.
      const itemId = reminderItemId({ kind: "reminder", id: job.reminderId, revision: String(job.version) });
      if (itemId) inbox.ack(itemId);
      trace("daemon.app_source.fire", {
        ...reminderTraceAttrs({
          ownerAgentId: job.ownerAgentId,
          reminderId: job.reminderId,
          version: job.version,
          ...(itemId ? { itemId } : {}),
        }),
        outcome: "already_consumed",
        wake_enqueued: true,
      });
      return { wakeEnqueued: true };
    }

    const occurrence = getOccurrence(job, context);
    for (const phase of REMINDER_BOUNDED_ALERT_PHASES) {
      inheritBoundedPhase(occurrence, phase, context.phaseTruth[phase]);
    }

    const stableItemId = reminderItemId({
      kind: "reminder",
      id: job.reminderId,
      revision: String(job.version),
    });
    const itemAlreadyPresent = stableItemId !== null
      && inbox.list().some((item) => item.itemId === stableItemId);

    const projectedTitle = projectReminderInboxTitle(job.title);
    const mint = inbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
      ...(projectedTitle ? { title: projectedTitle } : {}),
      summary: context.catchup ? "Overdue reminder recovered locally" : "Reminder due",
    });
    if (!mint.ok) {
      logger.error(`[Daemon] Reminder ${job.reminderId} Inbox mint failed: ${mint.code}: ${mint.message}`);
      trace("daemon.app_source.fire", {
        ...reminderTraceAttrs({
          ownerAgentId: job.ownerAgentId,
          reminderId: job.reminderId,
          version: job.version,
        }),
        outcome: "mint_rejected",
        reason: mint.code,
      }, "error");
      emitOccurrence(occurrence, "error", "mint_rejected");
      return { wakeEnqueued: false, retryStage: "inbox_materialization" as const };
    }
    if (!occurrence.phaseTruth.app_item_materialized.state) {
      if (itemAlreadyPresent) {
        occurrence.phaseTruth = {
          ...occurrence.phaseTruth,
          app_item_materialized: {
            state: true,
            evidence: "transition_provenance_missing",
            transition: null,
          },
        };
      } else {
        observeBoundedPhase(occurrence, "app_item_materialized");
      }
    }
    let wakeEnqueued = context.wakeEnqueued;
    if (!context.wakeEnqueued) {
      wakeEnqueued = await options.notifyInbox(job.ownerAgentId, mint.item);
      if (wakeEnqueued) {
        observeBoundedPhase(occurrence, "wake_request_accepted");
      } else {
        emitOccurrence(occurrence, "wake_request_error", "wake_not_enqueued");
      }
    }
    trace(
      "daemon.app_source.fire",
      {
        ...reminderTraceAttrs({
          ownerAgentId: job.ownerAgentId,
          reminderId: job.reminderId,
          version: job.version,
          itemId: mint.item.itemId,
        }),
        outcome: wakeEnqueued ? "presented" : "wake_not_enqueued",
        wake_enqueued: wakeEnqueued,
        catchup: context.catchup,
      },
      wakeEnqueued ? "ok" : "error",
    );
    return {
      wakeEnqueued,
      phaseTruth: clonePhaseTruth(occurrence.phaseTruth),
      ...(wakeEnqueued ? {} : { retryStage: "inbox_materialization" as const }),
    };
  }

  return {
    bindStorageProvider(storageForAgent: (agentId: string) => ScopedAppStorage) {
      cache.bindStorageProvider(storageForAgent);
    },
    start: () => cache.start(),
    stop: () => {
      cache.stop();
      for (const occurrence of occurrencesByDue.values()) {
        if (occurrence.alertTimer !== null) clock.clearTimeout(occurrence.alertTimer);
      }
      occurrencesByDue.clear();
    },
    handleServerMessage(message: ServerToMachineMessage): boolean {
      switch (message.type) {
        case "reminder.upsert": {
          void REMINDER_OWNER_FENCE_KINDS[message.type];
          if (message.reminder.ownerAgentId !== message.agentId) {
            logger.warn(
              `[Daemon] Ignoring Reminder upsert for ${message.reminder.reminderId}: envelope agent ${message.agentId} does not own payload`,
            );
            trace(
              "daemon.app_source.receive",
              {
                ...reminderTraceAttrs({
                  ownerAgentId: message.agentId,
                  reminderId: message.reminder.reminderId,
                  version: message.reminder.version,
                }),
                message_type: message.type,
                outcome: "owner_mismatch",
              },
              "error",
            );
            return true;
          }
          const outcome = cache.upsert(message.reminder);
          if (outcome === "applied" || outcome === "stale") {
            requestSnapshotOnce(message.agentId, "unsynchronized_upsert");
          }
          trace(
            "daemon.app_source.receive",
            {
              ...reminderTraceAttrs({
                ownerAgentId: message.agentId,
                reminderId: message.reminder.reminderId,
                version: message.reminder.version,
              }),
              message_type: message.type,
              outcome,
            },
            outcome === "applied" ? "ok" : "error",
          );
          sendArmOutcome(message.agentId, message.reminder, outcome === "applied");
          return true;
        }
        case "reminder.cancel":
          void REMINDER_OWNER_FENCE_KINDS[message.type];
          const outcome = cache.cancel(message.reminderId, message.version, message.agentId);
          trace(
            "daemon.app_source.receive",
            {
              ...reminderTraceAttrs({
                ownerAgentId: message.agentId,
                reminderId: message.reminderId,
                version: message.version,
              }),
              message_type: message.type,
              outcome,
            },
            outcome === "applied" ? "ok" : "error",
          );
          return true;
        case "reminder.snapshot":
          void REMINDER_OWNER_FENCE_KINDS[message.type];
          pendingSnapshotRequests.delete(message.agentId);
          logger.info(`[Daemon] Reminder snapshot for agent ${message.agentId}: ${message.reminders.length} entries`);
          const ownedReminders: ReminderJob[] = [];
          for (const job of message.reminders) {
            if (job.ownerAgentId === message.agentId) {
              ownedReminders.push(job);
              continue;
            }
            trace(
              "daemon.app_source.receive",
              {
                ...reminderTraceAttrs({
                  ownerAgentId: message.agentId,
                  reminderId: job.reminderId,
                  version: job.version,
                }),
                message_type: message.type,
                outcome: "owner_mismatch",
              },
              "error",
            );
          }
          const outcomes = cache.snapshot(message.agentId, ownedReminders);
          if (ownedReminders.length === 0) {
            trace("daemon.app_source.receive", {
              ...appSnapshotTraceAttrs({
                appId: "system.reminder",
                ownerAgentId: message.agentId,
                snapshotKind: "reminder",
              }),
              message_type: message.type,
              outcome: "applied_empty",
            });
          }
          for (const job of ownedReminders) {
            const outcome = outcomes.get(job.reminderId) ?? "rejected";
            trace(
              "daemon.app_source.receive",
              {
                ...reminderTraceAttrs({
                  ownerAgentId: message.agentId,
                  reminderId: job.reminderId,
                  version: job.version,
                }),
                message_type: message.type,
                outcome,
              },
              outcome === "applied" ? "ok" : "error",
            );
            sendArmOutcome(
              message.agentId,
              job,
              outcome === "applied",
            );
          }
          return true;
        case "reminder.fire_receipt.ack":
          void REMINDER_OWNER_FENCE_KINDS[message.type];
          const acknowledged = cache.ackFireReceipt(createReminderDueIdentity({
            ownerAgentId: message.agentId,
            reminderId: message.reminderId,
            version: message.version,
          }));
          trace(
            "daemon.app_source.receipt",
            {
              ...reminderTraceAttrs({
                ownerAgentId: message.agentId,
                reminderId: message.reminderId,
                version: message.version,
              }),
              outcome: acknowledged ? "acknowledged" : "missing",
            },
            acknowledged ? "ok" : "error",
          );
          return true;
        case "reminder.fire_request.result": {
          void REMINDER_OWNER_FENCE_KINDS[message.type];
          const identity = createReminderDueIdentity({
            ownerAgentId: message.agentId,
            reminderId: message.reminderId,
            version: message.version,
          });
          const applied = message.outcome === "accepted"
            ? cache.acceptFireRequest(identity, message.requestId, {
                fired: message.fired,
                catchup: message.catchup,
              })
            : message.outcome === "premature"
              ? cache.rearmFireRequest(identity, message.requestId, message.retryAfterMs)
              : cache.discardFireRequest(identity, message.requestId);
          trace(
            "daemon.app_source.receipt",
            {
              ...reminderTraceAttrs({
                ownerAgentId: message.agentId,
                reminderId: message.reminderId,
                version: message.version,
              }),
              request_id: message.requestId,
              outcome: applied ? message.outcome : "stale_result",
              ...(message.outcome === "accepted" ? { fired: message.fired } : {}),
              ...(message.outcome === "premature" ? { retry_after_ms: message.retryAfterMs } : {}),
              ...(message.outcome === "obsolete" ? { reason: message.reason } : {}),
            },
            applied ? "ok" : "error",
          );
          return true;
        }
        default:
          return false;
      }
    },
    beforeAck(agentId: string, item: AgentInboxAppItem) {
      if (!isReminderDueInboxItem(item)) return true;
      const version = Number(item.sourceRef.revision);
      if (Number.isSafeInteger(version) && version > 0) {
        const identity = createReminderDueIdentity({
          ownerAgentId: agentId,
          reminderId: item.sourceRef.id,
          version,
        });
        const acknowledged = cache.ackLocalItem(identity);
        if (acknowledged) acknowledgeOccurrence(identity);
        return acknowledged;
      }
      return false;
    },
    beforeServerAuthorizedAck(agentId: string, item: AgentInboxAppItem) {
      if (!isReminderDueInboxItem(item)) return false;
      const version = Number(item.sourceRef.revision);
      if (!Number.isSafeInteger(version) || version <= 0) return false;
      // Best-effort convergence for current local cache records. A missing or
      // older cache record is exactly why this path asks the Server to
      // adjudicate the world revision, so it must not veto a Server proof.
      cache.ackLocalItem(createReminderDueIdentity({
        ownerAgentId: agentId,
        reminderId: item.sourceRef.id,
        version,
      }));
      return true;
    },
    replayPendingReceipts() {
      cache.replayPendingFireReceipts();
    },
    onConnect() {
      pendingSnapshotRequests.clear();
    },
    requestSnapshot(agentId: string) {
      pendingSnapshotRequests.add(agentId);
      options.send({ type: "reminder.snapshot.request", agentId });
    },
    /**
     * agent:start fallback (task #2, #proj-reminder): an agent starting on
     * this machine may own reminders that were never loaded — e.g. it arrived
     * by migration after connect, so neither the connect-time snapshot set
     * nor the server's connect push covered it. Guarded: no-op when the owner
     * is already synchronized or a request is in flight.
     */
    requestSnapshotIfUnsynchronized(agentId: string): boolean {
      return requestSnapshotOnce(agentId, "agent_start");
    },
  };
}
