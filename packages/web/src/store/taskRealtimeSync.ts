import { useTaskStore } from "./taskStore";
import type { Task } from "./taskStore";

export type TaskRealtimeSocket = {
  on: (event: string, handler: (data: any) => void) => unknown;
  off: (event: string, handler: (data: any) => void) => unknown;
};

export function applyTaskRealtimeUpdate(task: Task) {
  useTaskStore.getState().upsertTask(task);
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
  const handleTaskDeleted = (data: { channelId: string; taskId: string }) => {
    useTaskStore.getState().removeTask(data.taskId);
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
