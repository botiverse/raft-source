import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { appSourceTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import type { BuiltInMachineMessageContext } from "../../registry.manifest.js";
import { isReminderCatchup } from "./fireTiming.js";
import * as reminderService from "./service.js";
import { selectReminderDueProtocol } from "./protocolTransition.js";

type LegacyFireAttempt = Extract<MachineToServerMessage, { type: "reminder.fire_attempt" }>;

function traceAttrs(message: LegacyFireAttempt) {
  return appSourceTraceAttrs({
    ownerAgentId: message.agentId,
    sourceRef: {
      kind: "reminder",
      id: message.reminderId,
      revision: String(message.version),
    },
  });
}

export async function handleLegacyReminderFireAttempt(
  message: LegacyFireAttempt,
  context: BuiltInMachineMessageContext,
): Promise<void> {
  const attrs = traceAttrs(message);
  // Only daemon 1.0.14/1.0.15 legitimately emit `reminder.fire_attempt`.
  // Selection uses the connection handshake's explicit capabilities first and
  // `daemonVersion` second; daemon >=1.0.16 is rejected from this legacy bridge.
  // `computerVersion` is intentionally absent because it does not own this wire.
  const protocol = selectReminderDueProtocol({
    daemonVersion: context.daemonVersion,
    capabilities: context.capabilities,
  });
  if (protocol !== "legacy_fire_attempt") {
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      outcome: "rejected",
      reason: protocol === "unknown" ? "protocol_unknown" : "protocol_mismatch",
    }, "error");
    return;
  }

  try {
    const existing = await reminderService.getReminderById(message.reminderId);
    if (!existing || existing.serverId !== context.agent.serverId) {
      context.trace("server.app_source.receipt", {
        ...attrs,
        machine_id: context.machineId,
        receipt_type: message.type,
        outcome: "rejected",
        reason: "server_mismatch_or_missing",
      }, "error");
      return;
    }
    if (existing.ownerAgentId !== message.agentId) {
      context.trace("server.app_source.receipt", {
        ...attrs,
        machine_id: context.machineId,
        receipt_type: message.type,
        outcome: "rejected",
        reason: "owner_or_revision_mismatch",
      }, "error");
      return;
    }
    if (
      existing.version !== message.version
      || existing.status !== "scheduled"
    ) {
      context.trace("server.app_source.receipt", {
        ...attrs,
        machine_id: context.machineId,
        receipt_type: message.type,
        outcome: "legacy_duplicate_noop",
      });
      return;
    }

    const catchup = isReminderCatchup({
      dueAtMs: existing.fireAt.getTime(),
      firedAtClient: message.firedAtClient,
      serverObservedAtMs: context.nowMs,
      toleranceMs: reminderService.FIRE_DUE_TOLERANCE_MS,
    });
    const result = await reminderService.fireReminder(message.reminderId, message.version, { catchup });
    if (!result.ok) {
      const rearmed = result.reason === "premature_fire"
        ? await context.host.pushReminderUpsert(existing.ownerAgentId, existing)
        : false;
      context.trace("server.app_source.receipt", {
        ...attrs,
        machine_id: context.machineId,
        receipt_type: message.type,
        outcome: result.reason === "premature_fire"
          ? rearmed ? "legacy_premature_rearmed" : "legacy_premature_rearm_failed"
          : "legacy_refused",
        reason: result.reason,
        catchup,
      }, rearmed || result.reason !== "premature_fire" ? "ok" : "error");
      return;
    }

    const fired = result.row;
    if (result.fired) {
      context.emit("reminder:fired", {
        reminderId: fired.id,
        ownerAgentId: fired.ownerAgentId,
        firedAt: fired.firedAt?.toISOString() ?? message.firedAtClient,
        catchup: result.catchup,
        nextFireAt: result.nextFireAt?.toISOString() ?? null,
      });
    }
    const woke = result.fired
      ? await reminderService.deliverLegacyReminderWake(context.host, fired, {
        catchup: result.catchup,
      })
      : false;
    const transported = result.nextFireAt
      ? await context.host.pushReminderUpsert(fired.ownerAgentId, fired)
      : await context.host.pushReminderCancel(fired.ownerAgentId, fired.id, fired.version);
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      outcome: result.fired
        ? woke ? "legacy_converged" : "legacy_wake_failed"
        : "legacy_skipped_unknown_recurrence",
      catchup: result.catchup,
    }, (result.fired && !woke) || !transported ? "error" : "ok");
  } catch (error) {
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      outcome: "legacy_convergence_failed",
    }, "error");
    console.error(
      `[Machine ${context.machineId}] Failed to converge legacy reminder attempt ${message.reminderId}:`,
      error,
    );
  }
}
