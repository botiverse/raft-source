import type { Server as SocketServer } from "socket.io";
import type { messages } from "../db/schema.js";

type MessageRow = typeof messages.$inferSelect;

export type MessageSocketProjectionRow = Pick<MessageRow,
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

export type MessageRealtimeTarget = {
  channelId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  serverId: string;
};

type StorageOnlyMessageSocketKey = "agentSendKey" | "searchText" | "searchVector" | "senderHandle";

type MessageAudience = {
  emit(event: "message:new" | "message:updated" | "task:created" | "task:updated" | "task:deleted", payload: unknown): unknown;
};

export function messageAudience(io: SocketServer, target: MessageRealtimeTarget): MessageAudience {
  // Room membership is authorized; the server room also contains guests
  // who cannot read every public channel.
  return io.to(`channel:${target.channelId}`);
}

export function projectMessageSocketPayload(
  row: MessageSocketProjectionRow,
  senderName: string,
) {
  const taskAssigneeName = row.taskAssigneeId
    ? { taskAssigneeName: row.taskAssigneeName ?? null }
    : {};

  // Socket message payloads are an allowlisted projection, not DB row spreads.
  // Keep storage/idempotency/search-only columns out of manifest v4 surfaces.
  return {
    id: row.id,
    seq: row.seq,
    channelId: row.channelId,
    senderType: row.senderType,
    senderId: row.senderId,
    randomId: row.randomId,
    messageType: row.messageType,
    content: row.content,
    actionMetadata: row.actionMetadata,
    threadId: row.threadId,
    taskStatus: row.taskStatus,
    taskNumber: row.taskNumber,
    taskAssigneeType: row.taskAssigneeType,
    taskAssigneeId: row.taskAssigneeId,
    ...taskAssigneeName,
    taskClaimedAt: row.taskClaimedAt,
    taskCompletedAt: row.taskCompletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    senderName,
  };
}

export function projectRichMessageSocketPayload<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, StorageOnlyMessageSocketKey> {
  const {
    agentSendKey: _agentSendKey,
    searchText: _searchText,
    searchVector: _searchVector,
    senderHandle: _senderHandle,
    ...projected
  } = payload;
  return projected;
}
