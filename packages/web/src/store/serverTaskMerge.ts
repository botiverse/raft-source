import type { Task } from "./taskStore";

// How fetched /tasks/server rows merge into taskStore.serverTasks (split out
// of taskStore.ts): field-wise, never losing a live change that landed while
// the read was in flight.

/**
 * Upgrade-only field merge: an incoming field that is undefined (absent from
 * a summary projection) never overwrites an existing defined value; defined
 * incoming values (including null) always win. Socket task events carry the
 * full task shape and stay authoritative, while detail=summary rows cannot
 * clobber fields they don't project (e.g. a fetched description).
 */
export function mergeTaskFields(existing: Task, incoming: Task): Task {
  const merged = { ...incoming };
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined && (merged as Record<string, unknown>)[key] === undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  // Activity only moves forward: a live message moves it locally at once, the
  // server stamps it at most once a minute, so a row read later may be older.
  if (existing.activityAt && incoming.activityAt && Date.parse(existing.activityAt) > Date.parse(incoming.activityAt)) {
    merged.activityAt = existing.activityAt;
  }
  return merged;
}

// Merge a /tasks/server snapshot with the live task mutations that landed while
// it was in flight. The snapshot is the authoritative base; for any id touched
// live during the fetch, the live store value wins (updated -> live value,
// removed -> dropped, created -> appended). With no live mutations the snapshot
// is returned unchanged. This makes committing the snapshot lossless w.r.t.
// concurrent socket events.
export function mergeServerTasksSnapshot(snapshot: Task[], touched: Set<string>, liveNow: Task[]): Task[] {
  if (touched.size === 0) return snapshot;
  const liveById = new Map(liveNow.map((t) => [t.id, t]));
  const emitted = new Set<string>();
  const result: Task[] = [];
  for (const t of snapshot) {
    emitted.add(t.id);
    if (!touched.has(t.id)) {
      result.push(t);
      continue;
    }
    const live = liveById.get(t.id);
    if (live) result.push(live); // updated live; if absent -> removed live, drop
  }
  for (const id of touched) {
    if (!emitted.has(id)) {
      const live = liveById.get(id); // created live during the fetch, not in snapshot
      if (live) result.push(live);
    }
  }
  return result;
}

// Live task mutations that land while one or more summary page loads are in
// flight. Refcounted so the parallel active-status first pages share one set; a
// committing page skips touched ids (the live store value is newer) instead of
// rolling them back to the pre-event snapshot — the same lossless rule
// loadTouchedIds gives the legacy full load.
let summaryLoadTouchedIds: Set<string> | null = null;
let summaryLoadsInFlight = 0;

export function beginSummaryPageLoad(): Set<string> {
  summaryLoadsInFlight += 1;
  if (!summaryLoadTouchedIds) summaryLoadTouchedIds = new Set();
  return summaryLoadTouchedIds;
}

export function endSummaryPageLoad(): void {
  summaryLoadsInFlight -= 1;
  if (summaryLoadsInFlight === 0) summaryLoadTouchedIds = null;
}

/**
 * A live task mutation (socket upsert / removal / conversation message, or
 * the answer to the client's own write): pages in flight skip it.
 */
export function noteSummaryPageTouched(taskId: string): void {
  summaryLoadTouchedIds?.add(taskId);
  liveSequence += 1;
  // Re-inserted, so the map stays in order of change: the oldest go first.
  liveChanges.delete(taskId);
  liveChanges.set(taskId, liveSequence);
  if (liveChanges.size > LIVE_CHANGES_CAP) {
    const oldest = liveChanges.keys().next().value;
    if (oldest !== undefined) liveChanges.delete(oldest);
  }
}

// Which tasks changed live, and when, on one counter: a Tasks page group
// places a task it did not read only when the task changed after the read
// (tasksPageModel.laneTasks), never a row the client holds from elsewhere.
let liveSequence = 0;
const liveChanges = new Map<string, number>();
/** A bound for a long session: a change older than this many others is older than any read on screen. */
const LIVE_CHANGES_CAP = 2000;

/**
 * Forget the changes no read needs any more: at or before `sequence`, the
 * earliest read the Tasks page still holds (0 holds none: all go).
 */
export function pruneLiveChanges(sequence: number | null): void {
  if (sequence === null) {
    liveChanges.clear();
    return;
  }
  for (const [taskId, at] of liveChanges) {
    if (at > sequence) break;
    liveChanges.delete(taskId);
  }
}

/** The live-change counter now: a read records it when it starts. */
export function currentLiveSequence(): number {
  return liveSequence;
}

/** When the task last changed live (0: not since the app started). */
export function liveChangeOf(taskId: string): number {
  return liveChanges.get(taskId) ?? 0;
}

// Merge a fetched summary page into serverTasks: upsert-only (a page never
// shrinks the list — lanes outside this page and live-created tasks stay),
// field-merged so summary rows can't clobber unprojected fields, and skipped
// for ids touched live during the fetch (the live value is newer; a live
// deletion is simply absent and must not be resurrected).
export function mergeServerTaskPage(current: Task[], page: Task[], touched: Set<string>): Task[] {
  const indexById = new Map(current.map((task, index) => [task.id, index]));
  const next = [...current];
  for (const item of page) {
    if (touched.has(item.id)) continue;
    const index = indexById.get(item.id);
    if (index === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
    } else {
      next[index] = mergeTaskFields(next[index], item);
    }
  }
  return next;
}
