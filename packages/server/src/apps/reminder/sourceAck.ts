import type { AgentApiRequestBodyByRoute, AgentApiResponseByRoute } from "@botiverse/raft-shared/src/agentApiContract.js";
import * as reminderCrud from "./crud.js";
import { ackAuthorizedReminderFire } from "./service.js";

export const REMINDER_INBOX_APP_ID = "system.reminder" as const;
export const REMINDER_DUE_NOTIFICATION_CLASS = "due" as const;

type ReminderAppSourceAckInput = AgentApiRequestBodyByRoute["appSourceAck"] & {
  serverId: string;
  actingAgentId: string;
};

type ReminderAppSourceAckResult =
  | { ok: true; response: AgentApiResponseByRoute["appSourceAck"] }
  | {
      ok: false;
      status: number;
      body: {
        error: string;
        code: string;
        latestFiredSourceVersion?: number;
      };
    };

export async function handleReminderSourceAck(
  input: ReminderAppSourceAckInput,
): Promise<ReminderAppSourceAckResult> {
  if (
    input.appId !== REMINDER_INBOX_APP_ID
    || input.notificationClass !== REMINDER_DUE_NOTIFICATION_CLASS
    || input.sourceRef.kind !== "reminder"
    || input.sourceRef.revision === undefined
  ) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "No authority handler is registered for this app source",
        code: "app_source_authority_not_registered",
      },
    };
  }
  const sourceVersion = Number(input.sourceRef.revision);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion <= 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "sourceRef.revision must be a positive integer",
        code: "invalid_source_revision",
      },
    };
  }

  const resolved = await reminderCrud.resolveAppHistoricalReminderIdForOwner(
    input.sourceRef.id,
    input.serverId,
    input.actingAgentId,
  );
  if (resolved.kind === "ambiguous") {
    return {
      ok: false,
      status: 409,
      body: { error: "Reminder id prefix is ambiguous", code: "source_id_ambiguous" },
    };
  }
  if (resolved.kind !== "resolved") {
    return {
      ok: false,
      status: 404,
      body: { error: "Reminder not found", code: "source_not_found" },
    };
  }

  const ack = await ackAuthorizedReminderFire({
    serverId: input.serverId,
    actingAgentId: input.actingAgentId,
    reminderId: resolved.reminderId,
    sourceVersion,
    ackAttemptId: input.ackAttemptId,
  });
  if (!ack.ok) {
    return {
      ok: false,
      status: ack.reason === "reminder_not_found" || ack.reason === "target_not_fired" ? 404 : 409,
      body: {
        error:
          ack.reason === "stale_source_revision"
            ? "Source revision is stale; refresh Inbox and retry"
            : ack.reason === "target_not_fired"
              ? "Source revision was not fired"
              : "Source not found",
        code: ack.reason === "reminder_not_found" ? "source_not_found" : ack.reason,
        latestFiredSourceVersion: ack.latestFiredSourceVersion,
      },
    };
  }

  return {
    ok: true,
    response: {
      ok: true,
      itemId: input.itemId,
      appId: input.appId,
      notificationClass: input.notificationClass,
      sourceRef: input.sourceRef,
      sourceEventId: ack.sourceEventId,
      ackAttemptId: ack.ackAttemptId,
      replayed: ack.replayed,
    },
  };
}
