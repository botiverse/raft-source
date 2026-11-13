import api from "../api/client";
import { TASK_STATUSES } from "@botiverse/raft-shared";
import type { TaskStatus } from "@botiverse/raft-shared";

export interface TaskFact {
  id: string;
  channelId: string;
  status: TaskStatus;
  owner: "user" | "agent" | null;
  createdAt: string;
  completedAt: string | null;
}
export interface TaskSnapshot {
  tasks: TaskFact[];
  complete: boolean;
  fetchedAt: string;
}
export const TASK_SNAPSHOT_LIMIT = 1000;
const STATUSES: readonly TaskStatus[] = TASK_STATUSES;
function parseTask(value: unknown): TaskFact {
  if (!value || typeof value !== "object") throw new Error("Invalid task row");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.channelId !== "string" ||
    !STATUSES.includes(row.status as TaskStatus) ||
    (row.claimedByType !== null && row.claimedByType !== "user" && row.claimedByType !== "agent") ||
    typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) ||
    (row.completedAt !== null && (typeof row.completedAt !== "string" || !Number.isFinite(Date.parse(row.completedAt))))) {
    throw new Error("Invalid task row");
  }
  return { id: row.id, channelId: row.channelId, status: row.status as TaskStatus,
    owner: row.claimedByType, createdAt: row.createdAt, completedAt: row.completedAt };
}
/** Existing human server task endpoint preserves channel ACL; keep no task bodies. */
export async function loadTaskSnapshot(serverId: string, signal: AbortSignal): Promise<TaskSnapshot> {
  const tasks: TaskFact[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const { data }: { data: unknown } = await api.get<unknown>("/tasks/server", {
      params: { detail: "summary", limit: 250, ...(cursor ? { cursor } : {}) },
      headers: { "X-Server-Id": serverId }, signal,
    });
    if (!data || typeof data !== "object" || !("tasks" in data) || !Array.isArray(data.tasks) ||
      !("next_cursor" in data) || (data.next_cursor !== null && typeof data.next_cursor !== "string") || data.tasks.length > 250) {
      throw new Error("Invalid task page");
    }
    for (const value of data.tasks) {
      const fact = parseTask(value);
      if (ids.has(fact.id)) throw new Error("Duplicate task row");
      ids.add(fact.id); tasks.push(fact);
    }
    cursor = data.next_cursor;
    if (cursor === null) return { tasks, complete: true, fetchedAt: new Date().toISOString() };
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid task cursor");
    cursors.add(cursor);
  }
  return { tasks, complete: false, fetchedAt: new Date().toISOString() };
}
export function summarizeTasks(tasks: readonly TaskFact[]) {
  const statuses: Record<TaskStatus, number> = { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, closed: 0 };
  const owners = { user: 0, agent: 0, unassigned: 0 };
  const durations: number[] = [];
  for (const task of tasks) {
    statuses[task.status]++;
    owners[task.owner ?? "unassigned"]++;
    const elapsed = task.completedAt ? Date.parse(task.completedAt) - Date.parse(task.createdAt) : NaN;
    if (task.status === "done" && elapsed >= 0) durations.push(elapsed / 3_600_000);
  }
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianHours = durations.length ? (durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2) : null;
  return { total: tasks.length, statuses, owners, medianHours, durationSamples: durations.length };
}

/** Completed UTC days make both windows equal and align with billing's day buckets. */
export function comparisonWindow(now: string, days = 7) {
  const date = new Date(now);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (!Number.isFinite(end) || !Number.isInteger(days) || days < 1 || days > 90) throw new Error("Invalid comparison window");
  const start = end - days * 86_400_000;
  return { start, end, previousStart: start - days * 86_400_000, days };
}
export function summarizeTaskPeriod(tasks: readonly TaskFact[], start: number, end: number) {
  const done = tasks.filter((task) => task.status === "done" && task.completedAt !== null &&
    Date.parse(task.completedAt) >= start && Date.parse(task.completedAt) < end);
  const summary = summarizeTasks(done);
  const durations = done.flatMap((task) => {
    const elapsed = Date.parse(task.completedAt!) - Date.parse(task.createdAt);
    return elapsed >= 0 ? [elapsed / 3_600_000] : [];
  });
  return { completed: done.length, medianHours: summary.medianHours,
    meanHours: durations.length ? durations.reduce((sum, hours) => sum + hours, 0) / durations.length : null,
    durationSamples: durations.length };
}
