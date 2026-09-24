import type { Server as SocketServer } from "socket.io";
import type { messages } from "../db/schema.js";
import { messageAudience, projectMessageSocketPayload, type MessageRealtimeTarget } from "./messageRealtimeEvents.js";

type MessageRow = typeof messages.$inferSelect;

type TaskMessageUpdateRow = Pick<MessageRow,
  | "id"
  | "seq"
  | "channelId"
  | "senderType"
  | "senderId"
  | "randomId"
  | "messageType"
  | "content"
  | "actionMetadata"
  | "threadId"
  | "taskStatus"
  | "taskNumber"
  | "taskAssigneeType"
  | "taskAssigneeId"
  | "taskClaimedAt"
  | "taskCompletedAt"
  | "createdAt"
  | "updatedAt"
> & {
  taskAssigneeName?: string | null;
};

type TaskRealtimeTarget = MessageRealtimeTarget;

type TaskCreatedProjectionSource = Record<string, unknown>;

export function projectTaskCreated(row: TaskCreatedProjectionSource) {
  return {
    id: row.id,
    messageId: row.messageId,
    channelId: row.channelId,
    channelName: row.channelName,
    channelType: row.channelType,
    taskNumber: row.taskNumber,
    title: row.title,
    description: row.description,
    status: row.status,
    claimedByType: row.claimedByType,
    claimedById: row.claimedById,
    claimedByName: row.claimedByName,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
    taskCurrentProjection: row.taskCurrentProjection,
    isLegacy: row.isLegacy,
  };
}

export function projectTaskMessageUpdated(
  row: TaskMessageUpdateRow,
  senderName: string,
) {
  return projectMessageSocketPayload(row, senderName);
}

export function projectTaskMessageNew(
  row: TaskMessageUpdateRow,
  senderName: string,
) {
  return projectMessageSocketPayload(row, senderName);
}

function projectTaskMessageRowToTarget(
  row: TaskMessageUpdateRow,
  target: TaskRealtimeTarget,
): TaskMessageUpdateRow {
  return row.channelId === target.channelId ? row : { ...row, channelId: target.channelId };
}

export function emitTaskMessageNew(
  io: SocketServer,
  target: TaskRealtimeTarget,
  row: TaskMessageUpdateRow,
  senderName: string,
) {
  // message-realtime-producer: task-message.new.projector
  io.to(`channel:${target.channelId}`).emit(
    "message:new",
    projectTaskMessageNew(projectTaskMessageRowToTarget(row, target), senderName),
  );
}

export function emitTaskMessageUpdated(
  io: SocketServer,
  row: TaskMessageUpdateRow,
  senderName: string,
) {
  // message-realtime-producer: task-message.updated.projector
  io.to(`channel:${row.channelId}`).emit(
    "message:updated",
    projectTaskMessageUpdated(row, senderName),
  );
}

export function emitTaskCreated(
  io: SocketServer,
  target: TaskRealtimeTarget,
  payload: { channelId: string; tasks: TaskCreatedProjectionSource[] },
) {
  messageAudience(io, target).emit("task:created", {
    channelId: payload.channelId,
    tasks: payload.tasks.map(projectTaskCreated),
  });
}

export function emitTaskUpdated(
  io: SocketServer,
  target: TaskRealtimeTarget,
  payload: { channelId: string; task: unknown },
) {
  messageAudience(io, target).emit("task:updated", payload);
}

export function emitTaskDeleted(
  io: SocketServer,
  target: TaskRealtimeTarget,
  payload: { channelId: string; taskId: string },
) {
  messageAudience(io, target).emit("task:deleted", payload);
}
