import type { Server as SocketServer } from "socket.io";
import * as taskService from "./taskService";
import { ensureTaskConversation, type CreatedTaskConversation } from "./taskConversationService";
import { emitTaskUpdated } from "./taskRealtimeEvents";
import type { MessageRealtimeTarget } from "./messageRealtimeEvents";
import {
  getTaskRealtimeSurfaceTargets,
  getTaskRealtimeTargetsForStorageChannel,
  type TaskChannelSurface,
} from "./taskChannelSurface";

/**
 * The identity facts a route needs after a task mutation, so no caller reaches
 * into a raw row.
 *
 * P3: there is one representation now, so this no longer normalizes across two.
 * `messageId` is the pre-v2 host message (thread/URL anchor); null for task v2
 * tasks (they have their own conversation) and pre-message-task orphans.
 */
export interface TaskMutationFacts {
  taskId: string;
  taskNumber: number;
  title: string;
  messageId: string | null;
  channelId: string;
  enriched: Awaited<ReturnType<typeof taskService.enrichSingleLegacyTask>>;
}

/** Normalize a committed mutation into route-facing facts, without broadcasting. */
export async function describeTaskMutation(
  result: Extract<taskService.TaskMutationResult, { source: string }>,
): Promise<TaskMutationFacts> {
  const row = result.row;
  return {
    taskId: row.id,
    taskNumber: row.taskNumber,
    title: row.title,
    messageId: row.messageId,
    channelId: row.channelId,
    enriched: await taskService.enrichSingleLegacyTask(row),
  };
}

/**
 * Broadcast a committed task mutation.
 *
 * A canonical task's host message is not touched by a mutation, so
 * re-broadcasting it as a message row would publish a row state that does not
 * exist — `task:updated` is the whole update. Pre-P3 a message-owned task also
 * emitted `message:updated`, because mutating it really did change a row the
 * chat flow renders; that arm went away with the shape, not with the contract.
 */
export async function emitTaskMutation(
  io: SocketServer,
  target: MessageRealtimeTarget,
  result: Extract<taskService.TaskMutationResult, { source: string }>,
): Promise<TaskMutationFacts> {
  const facts = await describeTaskMutation(result);
  const task = taskService.projectTaskToChannel(facts.enriched, {
    id: target.channelId,
    type: target.channelType,
  });
  emitTaskUpdated(io, target, { channelId: target.channelId, task });
  return facts;
}

/** Fan one canonical task mutation out through every active local surface. */
export async function emitTaskMutationToSurfaces(
  io: SocketServer,
  surface: TaskChannelSurface,
  result: Extract<taskService.TaskMutationResult, { source: string }>,
  taskCurrentProjection?: {
    title: string;
    description: string | null;
    revision: number;
    superseded: true;
    amendedAt: string;
    amendedByType: "user" | "agent" | "system";
    amendedByName: string | null;
    source: "tasks_current_projection";
  },
): Promise<TaskMutationFacts> {
  const facts = await describeTaskMutation(result);
  const targets = await getTaskRealtimeSurfaceTargets(surface);
  for (const target of targets) {
    const task = {
      ...taskService.projectTaskToChannel(facts.enriched, target.localChannel),
      ...(taskCurrentProjection && { taskCurrentProjection }),
    };
    emitTaskUpdated(io, target, { channelId: target.channelId, task });
  }
  return facts;
}

/**
 * Task v2: lazily give a pre-v2 task its own conversation (flag read for the
 * initiating server; see taskConversationService.ensureTaskConversation) and,
 * when this call created it, tell every surface showing the task
 * (`task:updated` carrying `conversationChannelId`). Returns the conversation,
 * or null when the flag is off / the task is unknown.
 */
export async function ensureTaskConversationAndBroadcast(
  io: SocketServer | null | undefined,
  taskId: string,
  opts: { initiatingServerId?: string | null; createdByUserId?: string | null } = {},
): Promise<CreatedTaskConversation | null> {
  const ensured = await ensureTaskConversation(taskId, opts);
  if (!ensured) return null;
  if (ensured.created) await broadcastCreatedTaskConversation(io, taskId);
  return ensured.conversation;
}

/**
 * A task conversation was just created (lazily): boards hear one
 * `task:updated` carrying it. Never throws.
 */
export async function broadcastCreatedTaskConversation(
  io: SocketServer | null | undefined,
  taskId: string,
): Promise<void> {
  if (io) {
    try {
      const row = await taskService.getLegacyTask(taskId);
      if (row) {
        const enriched = await taskService.enrichSingleLegacyTask(row);
        for (const target of await getTaskRealtimeTargetsForStorageChannel(row.channelId)) {
          const task = taskService.projectTaskToChannel(enriched, target.localChannel);
          emitTaskUpdated(io, target, { channelId: target.channelId, task });
        }
      }
    } catch (err) {
      console.error(`[taskMutationBroadcast] task ${taskId}: conversation created, task:updated broadcast failed:`, err);
    }
  }
}

/**
 * Task v2: after a committed mutation of a pre-v2 task on a flag-on server,
 * give it its own conversation before the mutation is broadcast and printed,
 * so clients and agents are pointed at it. Returns the mutation with the
 * post-ensure row (carrying `conversationChannelId`); unchanged when nothing
 * was created or the flag is off. Never fails the already-committed mutation.
 */
export async function withTaskConversationEnsured<T extends { row: taskService.TaskRow }>(
  result: T,
  opts: { initiatingServerId?: string | null } = {},
): Promise<T> {
  if (result.row.conversationChannelId) return result;
  try {
    const ensured = await ensureTaskConversation(result.row.id, opts);
    return ensured?.created
      ? { ...result, row: { ...result.row, conversationChannelId: ensured.conversation.canonicalChannelId } }
      : result;
  } catch (err) {
    console.error(`[taskMutationBroadcast] task ${result.row.id}: ensuring its conversation failed:`, err);
    return result;
  }
}
