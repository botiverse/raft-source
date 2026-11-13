import { useInboxStore } from "./inboxStore";
import { useTaskStore } from "./taskStore";
import type { Task } from "./taskStore";
import { useThreadStore } from "./threadStore";
import { forgetDeletedTaskRef } from "../components/task/useTaskRefTask";

export type TaskRealtimeSocket = {
  on: (event: string, handler: (data: any) => void) => unknown;
  off: (event: string, handler: (data: any) => void) => unknown;
};

export function applyTaskRealtimeUpdate(task: Task) {
  useTaskStore.getState().upsertTask(task);
}

/** `task:deleted`; `conversationChannelId` is the conversation as this surface saw it (task v2). */
export type TaskDeletedEvent = { channelId: string; taskId: string; conversationChannelId?: string | null };

/**
 * A deleted task (`task:deleted`): drop it from the boards and, for a task v2
 * task, everything that still shows its conversation (deleted server-side with
 * it): the Activity and Unfollowed rows, the followed-list row, the task
 * dialog open on it, and a `#channel:#N` chip that fetched it.
 */
export function applyTaskDeleted(data: TaskDeletedEvent) {
  useTaskStore.getState().removeTask(data.taskId);
  forgetDeletedTaskRef(data.taskId);
  const conversationChannelId = typeof data.conversationChannelId === "string" ? data.conversationChannelId : null;
  useThreadStore.getState().dropDeletedTaskConversation({ taskId: data.taskId, conversationChannelId });
  if (conversationChannelId) useInboxStore.getState().removeConversation(conversationChannelId);
}

/** Whether a `task:deleted` names the task (or the conversation) a task window shows. */
export function isTaskDeletedForTarget(
  data: TaskDeletedEvent | null | undefined,
  target: { taskId: string | null; conversationChannelId: string | null },
): boolean {
  if (!data || typeof data.taskId !== "string") return false;
  if (target.taskId !== null && data.taskId === target.taskId) return true;
  return !!data.conversationChannelId && data.conversationChannelId === target.conversationChannelId;
}

export function registerTaskRealtimeHandlers(socket: TaskRealtimeSocket): () => void {
  const handleTaskCreated = (data: { channelId: string; tasks: Task[] }) => {
    for (const task of data.tasks) {
      applyTaskRealtimeUpdate(task);
    }
  };
  const handleTaskUpdated = (data: { channelId: string; task: Task }) => {
    applyTaskRealtimeUpdate(data.task);
  };
  const handleTaskDeleted = (data: TaskDeletedEvent) => {
    applyTaskDeleted(data);
  };
  // When the socket drops, the server-tasks list can no longer be assumed
  // complete: task:created/updated/deleted events during the gap are lost (the
  // server sends no event replay on resume). Invalidate on "disconnect" — the
  // moment the gap begins — so the generation bumps before any in-flight load
  // can commit, and the next TasksPanel mount re-fetches (#210). Lazy: no eager
  // refetch of the unbounded list.
  const handleDisconnect = () => {
    useTaskStore.getState().invalidateServerTasks();
  };
  // On reconnect, an open Tasks view catches up (generation-keyed load); a
  // closed one stays lazy. Guarded inside catchUpServerTasksOnReconnect so the
  // initial app connect does not eager-fetch the unbounded list.
  const handleConnect = () => {
    useTaskStore.getState().catchUpServerTasksOnReconnect();
  };

  socket.on("task:created", handleTaskCreated);
  socket.on("task:updated", handleTaskUpdated);
  socket.on("task:deleted", handleTaskDeleted);
  socket.on("disconnect", handleDisconnect);
  socket.on("connect", handleConnect);

  return () => {
    socket.off("task:created", handleTaskCreated);
    socket.off("task:updated", handleTaskUpdated);
    socket.off("task:deleted", handleTaskDeleted);
    socket.off("disconnect", handleDisconnect);
    socket.off("connect", handleConnect);
  };
}
