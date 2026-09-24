import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { appSourceTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import type { BuiltInMachineMessageContext } from "../../registry.manifest.js";
import * as reminderService from "./service.js";
import { isReminderCatchup } from "./fireTiming.js";
import { selectReminderDueProtocol } from "./protocolTransition.js";

type FireRequest = Extract<MachineToServerMessage, { type: "reminder.fire_request" }>;

function traceAttrs(message: FireRequest) {
  return appSourceTraceAttrs({
    ownerAgentId: message.agentId,
    sourceRef: {
      kind: "reminder",
      id: message.reminderId,
      revision: String(message.version),
    },
  });
}

async function sendAccepted(
  message: FireRequest,
  context: BuiltInMachineMessageContext,
  result: { fired: boolean; catchup: boolean },
): Promise<boolean> {
  return context.send({
    type: "reminder.fire_request.result",
    agentId: message.agentId,
    reminderId: message.reminderId,
    version: message.version,
    requestId: message.requestId,
    outcome: "accepted",
    fired: result.fired,
    catchup: result.catchup,
  });
}

async function replayAuthorizedFire(
  message: FireRequest,
  context: BuiltInMachineMessageContext,
): Promise<boolean> {
  const replay = await reminderService.findAuthorizedReminderFire(
    message.reminderId,
    context.agent.serverId,
    message.agentId,
    message.version,
  );
  if (!replay) return false;
  await sendAccepted(message, context, replay);
  return true;
}

export async function handleReminderFireRequest(
  message: FireRequest,
  context: BuiltInMachineMessageContext,
): Promise<void> {
  const attrs = traceAttrs(message);
  const protocol = selectReminderDueProtocol({
    daemonVersion: context.daemonVersion,
    capabilities: context.capabilities,
  });
  if (protocol !== "fire_request") {
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      request_id: message.requestId,
      outcome: "rejected",
      reason: protocol === "unknown" ? "protocol_unknown" : "protocol_mismatch",
    }, "error");
    return;
  }

  try {
    if (await replayAuthorizedFire(message, context)) {
      context.trace("server.app_source.receipt", {
        ...attrs,
        machine_id: context.machineId,
        receipt_type: message.type,
        request_id: message.requestId,
        outcome: "accepted_replayed",
      });
      return;
    }

    const existing = await reminderService.getReminderById(message.reminderId);
    if (!existing || existing.serverId !== context.agent.serverId) {
      await context.send({
        type: "reminder.fire_request.result",
        agentId: message.agentId,
        reminderId: message.reminderId,
        version: message.version,
        requestId: message.requestId,
        outcome: "obsolete",
        reason: "server_mismatch_or_missing",
      });
      return;
    }
    if (existing.ownerAgentId !== message.agentId) {
      await context.send({
        type: "reminder.fire_request.result",
        agentId: message.agentId,
        reminderId: message.reminderId,
        version: message.version,
        requestId: message.requestId,
        outcome: "obsolete",
        reason: "owner_mismatch",
      });
      return;
    }

    const catchup = isReminderCatchup({
      dueAtMs: existing.fireAt.getTime(),
      firedAtClient: message.firedAtClient,
      serverObservedAtMs: context.nowMs,
      toleranceMs: reminderService.FIRE_DUE_TOLERANCE_MS,
    });
    const result = await reminderService.fireReminder(message.reminderId, message.version, {
      catchup,
      clock: { now: () => new Date(context.nowMs) },
    });
    if (!result.ok) {
      if (result.reason === "premature_fire") {
        const dueAt = result.fireAt ?? existing.fireAt;
        const retryAfterMs = Math.max(
          1,
          dueAt.getTime() - result.now.getTime() - reminderService.FIRE_DUE_TOLERANCE_MS,
        );
        await context.send({
          type: "reminder.fire_request.result",
          agentId: message.agentId,
          reminderId: message.reminderId,
          version: message.version,
          requestId: message.requestId,
          outcome: "premature",
          reason: "premature_fire",
          serverNow: result.now.toISOString(),
          dueAt: dueAt.toISOString(),
          retryAfterMs,
        });
        context.trace("server.app_source.receipt", {
          ...attrs,
          machine_id: context.machineId,
          receipt_type: message.type,
          request_id: message.requestId,
          outcome: "premature",
          retry_after_ms: retryAfterMs,
        });
        return;
      }
      if (await replayAuthorizedFire(message, context)) return;
      await context.send({
        type: "reminder.fire_request.result",
        agentId: message.agentId,
        reminderId: message.reminderId,
        version: message.version,
        requestId: message.requestId,
        outcome: "obsolete",
        reason: result.reason,
      });
      return;
    }

    if (result.fired) {
      context.emit("reminder:fired", {
        reminderId: result.row.id,
        ownerAgentId: result.row.ownerAgentId,
        firedAt: result.row.firedAt?.toISOString() ?? message.firedAtClient,
        catchup: result.catchup,
        nextFireAt: result.nextFireAt?.toISOString() ?? null,
      });
    }
    const transported = result.nextFireAt
      ? await context.host.pushReminderUpsert(result.row.ownerAgentId, result.row)
      : await context.host.pushReminderCancel(result.row.ownerAgentId, result.row.id, result.row.version);
    const sent = await sendAccepted(message, context, result);
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      request_id: message.requestId,
      outcome: sent && transported ? "accepted" : "accepted_transport_incomplete",
      fired: result.fired,
      catchup: result.catchup,
    }, sent && transported ? "ok" : "error");
  } catch (error) {
    context.trace("server.app_source.receipt", {
      ...attrs,
      machine_id: context.machineId,
      receipt_type: message.type,
      request_id: message.requestId,
      outcome: "convergence_failed",
    }, "error");
    console.error(`[Machine ${context.machineId}] Failed to converge due request ${message.reminderId}:`, error);
  }
}
