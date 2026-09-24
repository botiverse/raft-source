import type { InboxItem } from "../store/inboxStore";
import type { Task } from "../store/taskStore";
import type { FollowedThread } from "../store/threadStore";

export interface TaskMetadataUpdate {
  messageId: string;
  taskNumber: number;
  status: Task["status"];
  claimedByName?: string | null;
}

type NormalizedTaskMetadataUpdate = Omit<TaskMetadataUpdate, "claimedByName"> & {
  claimedByName: string | null;
};

function normalizeTaskMetadataUpdate(task: TaskMetadataUpdate): NormalizedTaskMetadataUpdate {
  return {
    ...task,
    claimedByName: task.claimedByName ?? null,
  };
}

function sameTaskMetadata(
  left: TaskMetadataUpdate,
  right: TaskMetadataUpdate,
): boolean {
  return left.messageId === right.messageId &&
    left.taskNumber === right.taskNumber &&
    left.status === right.status &&
    (left.claimedByName ?? null) === (right.claimedByName ?? null);
}

function mergeTaskMetadata<T extends TaskMetadataUpdate>(
  task: T,
  update: TaskMetadataUpdate | null,
): T {
  if (!update || update.messageId !== task.messageId) return task;
  const normalized = normalizeTaskMetadataUpdate(update);
  if (sameTaskMetadata(task, normalized)) return task;
  return {
    ...task,
    taskNumber: normalized.taskNumber,
    status: normalized.status,
    claimedByName: normalized.claimedByName,
  };
}

export function mergeParentTaskMetadata(
  parentTask: Task | null,
  fallbackTask: Task | null,
  realtimeTask: TaskMetadataUpdate | null,
): Task | null {
  const task = parentTask ?? fallbackTask;
  if (!task) return null;
  return mergeTaskMetadata(
    mergeTaskMetadata(task, fallbackTask),
    realtimeTask,
  );
}

export function updateTaskMetadataCache(
  cache: Record<string, TaskMetadataUpdate>,
  task: TaskMetadataUpdate,
): Record<string, TaskMetadataUpdate> {
  const normalized = normalizeTaskMetadataUpdate(task);
  const existing = cache[normalized.messageId];
  if (existing && sameTaskMetadata(existing, normalized)) return cache;
  return {
    ...cache,
    [normalized.messageId]: normalized,
  };
}

export function updateTaskMetadataCacheBatch(
  cache: Record<string, TaskMetadataUpdate>,
  tasks: readonly TaskMetadataUpdate[],
): Record<string, TaskMetadataUpdate> {
  let next = cache;
  for (const task of tasks) {
    const normalized = normalizeTaskMetadataUpdate(task);
    const existing = next[normalized.messageId];
    if (existing && sameTaskMetadata(existing, normalized)) continue;
    if (next === cache) next = { ...cache };
    next[normalized.messageId] = normalized;
  }
  return next;
}

export function applyTaskToFollowedThreads(
  threads: FollowedThread[],
  task: TaskMetadataUpdate,
): FollowedThread[] {
  const normalized = normalizeTaskMetadataUpdate(task);
  let changed = false;
  const next = threads.map((thread) => {
    if (thread.parentMessageId !== normalized.messageId) return thread;

    if (
      thread.taskNumber === normalized.taskNumber &&
      thread.taskStatus === normalized.status &&
      thread.taskClaimedByName === normalized.claimedByName
    ) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      taskNumber: normalized.taskNumber,
      taskStatus: normalized.status,
      taskClaimedByName: normalized.claimedByName,
    };
  });

  return changed ? next : threads;
}

export function applyTaskToInboxItems(items: InboxItem[], task: TaskMetadataUpdate): InboxItem[] {
  const normalized = normalizeTaskMetadataUpdate(task);
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "thread" || item.parentMessageId !== normalized.messageId) return item;

    if (
      item.taskNumber === normalized.taskNumber &&
      item.taskStatus === normalized.status &&
      item.taskClaimedByName === normalized.claimedByName
    ) {
      return item;
    }

    changed = true;
    return {
      ...item,
      taskNumber: normalized.taskNumber,
      taskStatus: normalized.status,
      taskClaimedByName: normalized.claimedByName,
    };
  });

  return changed ? next : items;
}
