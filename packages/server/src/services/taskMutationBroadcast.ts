import type { Server as SocketServer } from "socket.io";
import * as taskService from "./taskService.js";
import { emitTaskUpdated } from "./taskRealtimeEvents.js";
import type { MessageRealtimeTarget } from "./messageRealtimeEvents.js";
import {
  getTaskRealtimeSurfaceTargets,
  type TaskChannelSurface,
} from "./taskChannelSurface.js";

/**
 * The identity facts a route needs after a task mutation, so no caller reaches
 * into a raw row.
 *
 * P3: there is one representation now, so this no longer normalizes across two.
 * `messageId` is the thread/URL anchor and is null only for pre-message-task
 * orphans (task v0), which have no host message at all.
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
