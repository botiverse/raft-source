import { useEffect, useSyncExternalStore } from "react";
import api from "../../api/client";
import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";

/**
 * The task a `#channel:#7` ref names, for a ref whose task the page has not
 * loaded (another channel's task, read from this channel). The chip shows the
 * task's status, so an unloaded task is read once by (channel, number) into a
 * cache of its own here; the task store is not written, so no list or
 * per-message task cache changes because a message mentions a task. Once the
 * task store knows the task (a socket update, or the channel's own list), its
 * copy wins, so the chip follows status changes live. `missing` (deleted, or a
 * channel the reader cannot read) keeps the ref as plain text.
 */
export type TaskRefLookup =
  | { state: "ready"; task: Task }
  | { state: "loading" }
  | { state: "missing" };

// A ref that could not be read stays plain text; it is asked again after a
// while (a task created later with that number, access granted later), not on
// every render of a long list.
const MISSING_RETRY_MS = 5 * 60 * 1000;
const missingRefs = new Map<string, number>();
const fetchedRefs = new Map<string, Task>();
const inFlightRefs = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function isMissing(key: string): boolean {
  const at = missingRefs.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < MISSING_RETRY_MS) return true;
  missingRefs.delete(key);
  return false;
}

function findStoreTask(state: ReturnType<typeof useTaskStore.getState>, channelId: string, taskNumber: number): Task | undefined {
  const matches = (task: Task) => task.channelId === channelId && task.taskNumber === taskNumber;
  return state.tasksByChannelId[channelId]?.find(matches)
    ?? state.tasks.find(matches)
    ?? state.serverTasks.find(matches);
}

function fetchRefTask(key: string, channelId: string, taskNumber: number): Promise<void> {
  const pending = inFlightRefs.get(key);
  if (pending) return pending;
  const request = api.get(`/tasks/channel/${channelId}/number/${taskNumber}`)
    .then(({ data }) => {
      const task = (data as { task?: Task } | undefined)?.task;
      if (!task) throw new Error("no task");
      fetchedRefs.set(key, task);
      missingRefs.delete(key);
    })
    .catch(() => {
      missingRefs.set(key, Date.now());
    })
    .finally(() => {
      inFlightRefs.delete(key);
      notify();
    });
  inFlightRefs.set(key, request);
  return request;
}

export function useTaskRefTask(channelId: string, taskNumber: number, enabled = true): TaskRefLookup {
  const key = `${channelId}:${taskNumber}`;
  const storeTask = useTaskStore((state) => findStoreTask(state, channelId, taskNumber));
  const fetched = useSyncExternalStore(subscribe, () => fetchedRefs.get(key), () => undefined);
  const missing = useSyncExternalStore(subscribe, () => isMissing(key), () => false);
  const task = storeTask ?? fetched;

  useEffect(() => {
    if (!enabled || task || isMissing(key)) return;
    void fetchRefTask(key, channelId, taskNumber);
  }, [enabled, task, key, channelId, taskNumber]);

  if (task) return { state: "ready", task };
  return missing ? { state: "missing" } : { state: "loading" };
}

/**
 * A deleted task (`task:deleted`): a ref to it reads as plain text again, as a
 * ref to a deleted task does on a fresh load, instead of keeping the status it
 * had when it was fetched.
 */
export function forgetDeletedTaskRef(taskId: string): void {
  let changed = false;
  for (const [key, task] of fetchedRefs) {
    if (task.id !== taskId) continue;
    fetchedRefs.delete(key);
    missingRefs.set(key, Date.now());
    changed = true;
  }
  if (changed) notify();
}

/** Tests: forget fetched and missing refs between cases. */
export function resetTaskRefLookupsForTest(): void {
  missingRefs.clear();
  fetchedRefs.clear();
  inFlightRefs.clear();
}
