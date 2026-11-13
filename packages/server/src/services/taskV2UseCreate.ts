import {
  formatTaskV2ClaimByMessageRefusal,
  formatTaskV2ConvertRefusal,
  TASK_V2_USE_CREATE_ERROR_CODE,
  type TaskV2ClaimByMessageRefusalItem,
} from "@botiverse/raft-shared";

import { isTaskV2ConversationsEnabledForRequest } from "./taskConversationsGate";
import * as taskService from "./taskService";
import { getServerHistoryWindowForRead, isBehindHistoryWindow } from "./historyWindow";

/**
 * Task v2 (spec §5, §7): on a server with `task_v2_conversations_v0` on, a
 * message is never converted into a task. `raft task convert` and
 * `raft task claim --message-id` are kept but do not execute there: they answer
 * 409 `task_v2_use_create` (the status the same routes use for their other
 * business refusals) with the new way in `error`, so CLIs that predate this
 * print it verbatim. Flag off: null, and the caller keeps its pre-v2 behavior.
 *
 * The gate is the server owning the task storage channel, like createTasks.
 */
export type TaskV2UseCreateRefusal = {
  status: 409;
  body: { error: string; code: typeof TASK_V2_USE_CREATE_ERROR_CODE };
};

function refusal(error: string): TaskV2UseCreateRefusal {
  return { status: 409, body: { error, code: TASK_V2_USE_CREATE_ERROR_CODE } };
}

/**
 * The text a suggested `--title` may quote: none from a message behind the
 * plan's history window of the server the request came through
 * (services/historyWindow.ts); the hint then shows its placeholder.
 */
async function quotableText(message: { content: string; createdAt: Date }, serverId: string | null | undefined): Promise<string | null> {
  if (!serverId) return message.content;
  return isBehindHistoryWindow(message.createdAt, await getServerHistoryWindowForRead(serverId)) ? null : message.content;
}

/** `raft task convert` (agent API `POST /tasks/convert`). */
export async function taskV2ConvertRefusal(input: {
  storageChannelId: string;
  /** The server the request came through (task v2 gate; joint storage is shared). */
  initiatingServerId?: string | null;
  /** The channel as the agent named it (`#general`). */
  channel: string;
  messageId: string;
  /** The calling agent's handle (for the `--assignee` variant). */
  selfHandle?: string | null;
}): Promise<TaskV2UseCreateRefusal | null> {
  if (!await isTaskV2ConversationsEnabledForRequest(input)) return null;
  const message = await taskService.resolveMessageInChannel(input.storageChannelId, input.messageId);
  return refusal(formatTaskV2ConvertRefusal({
    channel: input.channel,
    messageShortId: message ? message.id.slice(0, 8) : input.messageId,
    messageText: message ? await quotableText(message, input.initiatingServerId) : null,
    selfHandle: input.selfHandle ?? null,
  }));
}

/** `raft task claim --message-id` (agent API + legacy daemon `tasks/claim`). */
export async function taskV2ClaimByMessageRefusal(input: {
  storageChannelId: string;
  initiatingServerId?: string | null;
  channel: string;
  messageIds: readonly string[];
  selfHandle?: string | null;
  alsoHadTaskNumbers?: boolean;
}): Promise<TaskV2UseCreateRefusal | null> {
  if (!await isTaskV2ConversationsEnabledForRequest(input)) return null;
  const items: TaskV2ClaimByMessageRefusalItem[] = [];
  for (const raw of input.messageIds) {
    const requested = String(raw);
    const message = await taskService.resolveMessageInChannel(input.storageChannelId, requested);
    if (!message) {
      items.push({ requested, messageShortId: null, taskNumbers: [] });
      continue;
    }
    const target = await taskService.resolveClaimTargetByMessageId(message.id);
    items.push({
      requested,
      messageShortId: message.id.slice(0, 8),
      taskNumbers: target.kind === "task"
        ? [target.owner.row.taskNumber]
        : target.kind === "ambiguous" ? target.taskNumbers : [],
      messageText: await quotableText(message, input.initiatingServerId),
    });
  }
  return refusal(formatTaskV2ClaimByMessageRefusal({
    channel: input.channel,
    items,
    selfHandle: input.selfHandle ?? null,
    alsoHadTaskNumbers: input.alsoHadTaskNumbers ?? false,
  }));
}

/** The web message-menu convert route (`POST /api/tasks/convert-message`). */
export async function taskV2WebConvertRefusal(
  storageChannelId: string,
  initiatingServerId?: string | null,
): Promise<TaskV2UseCreateRefusal | null> {
  if (!await isTaskV2ConversationsEnabledForRequest({ storageChannelId, initiatingServerId })) return null;
  return refusal(
    "Converting a message into a task is not available on this server. "
      + "Use \"Create Task from Message\" instead: it creates a new task linked to the message.",
  );
}
