import type { Task } from "../../store/taskStore";

/**
 * Which of the task lists the client keeps can answer "is this thread's parent
 * a task?".
 *
 * Its own module rather than a local in MainLayout so it can be imported by a
 * test: MainLayout pulls the whole app graph (stores touch `localStorage` at
 * module load), which is why every other test of that file asserts on source
 * text. The regression this guards is a MISSING SOURCE, and a source-text
 * assertion cannot tell a real lookup from a sentence describing one.
 */
export function resolveThreadHostTask(
  parentMessageId: string | null,
  lists: { tasks: Task[]; parentChannelTasks: Task[]; serverTasks: Task[] },
): Task | null {
  if (!parentMessageId) return null;
  const hit = (list: Task[]) => list.find((t) => t.messageId === parentMessageId);
  return hit(lists.tasks) ?? hit(lists.parentChannelTasks) ?? hit(lists.serverTasks) ?? null;
}

export function loadThreadParentTasksIfNeeded({
  parentMessageId,
  parentChannelId,
  parentLoaded,
  parentLoading,
  loadTasks,
}: {
  parentMessageId: string | null;
  parentChannelId: string | null;
  parentLoaded: boolean;
  parentLoading: boolean;
  loadTasks: (channelId: string) => unknown;
}): boolean {
  if (!parentMessageId || !parentChannelId || parentLoaded || parentLoading) return false;
  void loadTasks(parentChannelId);
  return true;
}
