import { useEffect } from "react";

import api from "../../api/client";
import { mergeTaskFields, useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";

type TaskLists = { tasks: Task[]; serverTasks: Task[]; tasksByChannelId: Record<string, Task[]> };

/** A task the client already holds, by id. */
export function findKnownTaskById(lists: TaskLists, taskId: string | null | undefined): Task | null {
  if (!taskId) return null;
  const match = (task: Task) => task.id === taskId;
  return lists.tasks.find(match)
    ?? lists.serverTasks.find(match)
    ?? Object.values(lists.tasksByChannelId).flat().find(match)
    ?? null;
}

/**
 * A task held only as a summary row (the Tasks page's lists and Select all read GET /tasks/server?detail=summary):
 * it says nothing of the task's conversation (`conversationChannelId` absent, where a full row says null or the id),
 * its description, host message or follow state, all of which the dialog needs. A full row always carries the key.
 */
export function isSummaryOnlyTask(task: Task): boolean {
  return task.conversationChannelId === undefined && !task.isLegacy;
}

/**
 * The task's full row filled into every row held of it: the held row wins where it says something (it may be newer, a
 * live change since the read), the read fills in what it left out. Not a live change: the lists, the counts and the
 * Tasks page's lanes stay as they are.
 */
export function fillTaskDetail(lists: TaskLists, full: Task): Partial<TaskLists> {
  const fill = (list: Task[]) => {
    let hit = false;
    const next = list.map((held) => {
      if (held.id !== full.id) return held;
      hit = true;
      return mergeTaskFields(full, held);
    });
    return hit ? next : list;
  };
  const changed: Partial<TaskLists> = {};
  const tasks = fill(lists.tasks);
  if (tasks !== lists.tasks) changed.tasks = tasks;
  const serverTasks = fill(lists.serverTasks);
  if (serverTasks !== lists.serverTasks) changed.serverTasks = serverTasks;
  let byChannelChanged = false;
  const tasksByChannelId: Record<string, Task[]> = {};
  for (const [channelId, list] of Object.entries(lists.tasksByChannelId)) {
    tasksByChannelId[channelId] = fill(list);
    if (tasksByChannelId[channelId] !== list) byChannelChanged = true;
  }
  if (byChannelChanged) changed.tasksByChannelId = tasksByChannelId;
  return changed;
}

const detailReads = new Map<string, Promise<void>>();

/** The task's full row, read once at a time by (channel, number), filled into the rows held (fillTaskDetail). */
export function loadTaskDetail(task: Pick<Task, "id" | "channelId" | "taskNumber">): Promise<void> {
  const pending = detailReads.get(task.id);
  if (pending) return pending;
  const read = api.get(`/tasks/channel/${task.channelId}/number/${task.taskNumber}`)
    .then(({ data }) => {
      const full = (data as { task?: Task } | null)?.task;
      if (full && full.id === task.id) useTaskStore.setState((state) => fillTaskDetail(state, full));
    })
    .catch((err: unknown) => console.error("Failed to read the task:", err))
    .finally(() => detailReads.delete(task.id));
  detailReads.set(task.id, read);
  return read;
}

/**
 * Task v2: the task behind a task conversation (the dialog, an Activity row, a
 * search hit), from the task lists the client already holds. With
 * `parentChannelId` (the dialog, which needs the full task) it loads that
 * channel's tasks once when the task is not there, and the task's full row
 * once when only its summary is held (opened from the Tasks page: without it
 * the dialog never learns the conversation, so its discussion read as empty);
 * rows and hits carry the task's identity themselves and only read it live.
 */
export function useTaskConversationTask({
  taskId,
  parentChannelId,
}: {
  taskId?: string | null;
  parentChannelId?: string | null;
}): Task | null {
  const task = useTaskStore((s) => findKnownTaskById(s, taskId));
  const parentLoaded = useTaskStore((s) => (parentChannelId ? s.loadedByChannelId[parentChannelId] ?? false : true));
  const parentLoading = useTaskStore((s) => (parentChannelId ? s.loadingByChannelId[parentChannelId] ?? false : false));
  const loadTasks = useTaskStore((s) => s.loadTasks);
  useEffect(() => {
    if (task || !taskId || !parentChannelId || parentLoaded || parentLoading) return;
    void loadTasks(parentChannelId);
  }, [loadTasks, parentChannelId, parentLoaded, parentLoading, task, taskId]);
  // Once per task opened (keyed by the task: its row changing live doesn't read it again; nor does a failed read loop).
  const summaryOnly = parentChannelId && task && isSummaryOnlyTask(task) ? task : null;
  const id = summaryOnly?.id ?? null;
  const channelId = summaryOnly?.channelId ?? null;
  const taskNumber = summaryOnly?.taskNumber ?? null;
  useEffect(() => {
    if (id === null || channelId === null || taskNumber === null) return;
    void loadTaskDetail({ id, channelId, taskNumber });
  }, [channelId, id, taskNumber]);
  return task;
}
