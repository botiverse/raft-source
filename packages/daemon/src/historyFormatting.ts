import { formatUtcTimestamp } from "@botiverse/raft-shared";
import { formatAttachmentSuffix } from "./attachmentFormatting.js";

type HistoryAttachment = {
  id: string;
  filename: string;
};

type HistoryMessageLine = {
  seq: number;
  id?: string;
  createdAt?: string;
  senderType?: string;
  senderName: string;
  senderDescription?: string | null;
  content: string;
  attachments?: HistoryAttachment[];
  taskStatus?: string | null;
  taskNumber?: number | null;
  taskAssigneeType?: string | null;
  taskAssigneeId?: string | null;
  threadId?: string | null;
  replyCount?: number | null;
};

function formatHistorySenderHandle(message: Pick<HistoryMessageLine, "senderName" | "senderDescription">): string {
  return message.senderDescription ? `@${message.senderName} — ${message.senderDescription}` : `@${message.senderName}`;
}

export function formatHistoryMessageLine(message: HistoryMessageLine): string {
  const headerParts = [
    `seq=${message.seq}`,
    `msg=${message.id || "-"}`,
    `time=${message.createdAt ? formatUtcTimestamp(message.createdAt) : "-"}`,
  ];

  if (message.senderType) {
    headerParts.push(`type=${message.senderType}`);
  }
  if (message.threadId) {
    headerParts.push(`threadId=${message.threadId}`);
  }
  if ((message.replyCount ?? 0) > 0) {
    headerParts.push(`replyCount=${message.replyCount}`);
  }

  const attachSuffix = formatAttachmentSuffix(message.attachments);
  const taskSuffix = message.taskStatus
    ? ` [task #${message.taskNumber} status=${message.taskStatus}${message.taskAssigneeId ? ` assignee=${message.taskAssigneeType}:${message.taskAssigneeId}` : ""}]`
    : "";

  return `[${headerParts.join(" ")}] ${formatHistorySenderHandle(message)}: ${message.content}${attachSuffix}${taskSuffix}`;
}
