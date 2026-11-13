import { useCallback, useContext, useEffect, useMemo, useRef } from "react";

import { useAuthStore } from "../../../store/authStore";
import { liveChangeOf } from "../../../store/serverTaskMerge";
import { useTaskStore } from "../../../store/taskStore";
import type { Task } from "../../../store/taskStore";
import { countsKey, useTasksPageStore } from "../../../store/tasksPageStore";
import type { ServerTaskBoardFilters, ServerTaskCounts } from "./tasksPageApi";
import { laneUnknownIds, mergedLaneTasks } from "./tasksPageModel";
import type { LaneSpec } from "./tasksPageModel";
import { TasksPageShownContext } from "./tasksPageShown";

/** After live task changes the counts are read again at most this often (every live change moves liveRevision). */
export const COUNTS_REFRESH_MIN_INTERVAL_MS = 10_000;

export interface LaneView {
  tasks: Task[];
  /** The first page has landed (an empty lane is then really empty). */
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  /** The last read failed: the lane offers to try again instead of reading on its own. */
  failed: boolean;
  /** Read the next page: the end of the lane scrolled into view. */
  loadMore: () => void;
}

/**
 * One list, section or board column of the Tasks page: its lanes (one, or
 * several of one sort: 你发起的, a 我的 board column), read together: the
 * rows merged in order (tasksPageModel.mergedLaneTasks), `loadMore` reading
 * the next page of each that has one. Nothing is read until the list asks:
 * its end (LoadMoreSentinel) scrolling into view does, so a folded column or
 * one off screen reads nothing. `count` is the server's total, when known. The lanes read their first page again,
 * replacing it, when what they show cannot be right:
 * - a task changed live that may belong but hinges on a fact the client
 *   lacks (a socket row has no source-message sender: From my messages);
 * - everything is read, yet the server's current count disagrees with the
 *   rows shown (once per count value, so a lasting disagreement can't loop).
 * Not while folded or while the page is hidden under a task: the need stays,
 * and the lanes read again once they show.
 * `lanes` must be memoized by the caller.
 */
export function useMergedTasksLanes(lanes: readonly LaneSpec[], count: number | null, folded: boolean): LaneView {
  const shown = useContext(TasksPageShownContext);
  const viewerId = useAuthStore((s) => s.user?.id ?? null);
  const known = useTaskStore((s) => s.serverTasks);
  const allReads = useTasksPageStore((s) => s.lanes);
  const loadLanePage = useTasksPageStore((s) => s.loadLanePage);
  // The reads of these lanes only.
  const reads = useMemo(() => lanes.map((lane) => allReads[lane.key]), [allReads, lanes]);
  const knownById = useMemo(() => new Map(known.map((task) => [task.id, task])), [known]);
  // liveChangeOf reads serverTaskMerge's counter, which moves with every change to `known`.
  const tasks = useMemo(() => mergedLaneTasks(lanes, reads, knownById, viewerId, liveChangeOf), [knownById, lanes, reads, viewerId]);
  const loaded = reads.every((read) => read?.loaded ?? false);
  const loading = reads.some((read) => read?.loading ?? false);
  const hasMore = !loaded || reads.some((read) => read?.nextCursor != null);

  const unknownIds = useMemo(() => {
    const checked = new Set(reads.flatMap((read) => read?.checkedIds ?? []));
    return laneUnknownIds(lanes, reads, knownById, viewerId, liveChangeOf).filter((id) => !checked.has(id));
  }, [knownById, lanes, reads, viewerId]);
  const syncedCount = reads[0]?.syncedCount ?? null;
  const disagrees = loaded && !hasMore && count !== null && count !== tasks.length && syncedCount !== count;
  const resync = loading || folded || !shown ? null : unknownIds.length > 0 ? { checkedIds: unknownIds } : disagrees && count !== null ? { syncedCount: count } : null;
  const resyncKey = resync ? JSON.stringify(resync) : null;
  const resyncRef = useRef(resync);
  useEffect(() => {
    resyncRef.current = resync;
  });
  useEffect(() => {
    const marks = resyncRef.current;
    if (!resyncKey || !marks) return;
    for (const lane of lanes) void loadLanePage(lane, { restart: true, ...marks });
  }, [lanes, loadLanePage, resyncKey]);

  const loadMore = useCallback(() => {
    for (const lane of lanes) void loadLanePage(lane);
  }, [lanes, loadLanePage]);
  // An open lane that has never been read reads its first page at once, not only when its end scrolls into view: a
  // board column that starts open off to the side (Closed, unfolded in an earlier visit) otherwise waits for a
  // sentinel it never shows (Kirby, 11-10: "Closed 2", no cards). A count of 0 needs no read.
  const failed = reads.some((read) => read?.failed ?? false);
  const neverRead = reads.every((read) => !read || (!read.loaded && !read.loading));
  const firstRead = shown && !folded && !failed && neverRead && count !== 0;
  useEffect(() => {
    if (!firstRead) return;
    for (const lane of lanes) void loadLanePage(lane);
  }, [firstRead, lanes, loadLanePage]);
  return {
    tasks,
    loaded,
    loading,
    hasMore,
    failed,
    loadMore,
  };
}

export interface CountsView {
  data: ServerTaskCounts | null;
  /** Read at the current live revision (not waiting for a refresh). */
  current: boolean;
  /** Every attempt failed and there is nothing to show. */
  failed: boolean;
  /** Try again after a failure. */
  retry: () => void;
}

/**
 * The server's totals for a filter set (data null: not read yet, or
 * `filters` null), read on first use and again after live task changes, never
 * sooner than COUNTS_REFRESH_MIN_INTERVAL_MS after the last read of that set
 * began: the changes in between are read at once, when it runs out. Only while
 * the page is shown. A failed
 * read is retried with a growing wait (tasksPageStore), then reported.
 * `filters` must be memoized by the caller.
 */
export function useTaskCounts(filters: ServerTaskBoardFilters | null): CountsView {
  const shown = useContext(TasksPageShownContext);
  const key = filters ? countsKey(filters) : null;
  const entry = useTasksPageStore((s) => (key === null ? undefined : s.counts[key]));
  const liveRevision = useTaskStore((s) => s.liveRevision);
  const loadCounts = useTasksPageStore((s) => s.loadCounts);
  const retryCounts = useTasksPageStore((s) => s.retryCounts);
  const readRevision = entry?.revision ?? null;
  const current = readRevision === liveRevision;
  const busy = (entry?.loading ?? false) || (entry?.failures ?? 0) > 0 || (entry?.failed ?? false);
  const readAt = entry?.readAt ?? null;

  useEffect(() => {
    if (!filters || !shown || current || busy) return;
    // The first read at once; a refresh when the interval since the last read has run out (a fixed time, so a steady
    // stream of changes can't put it off).
    const delay = readRevision === null || readAt === null ? 0 : Math.max(0, readAt + COUNTS_REFRESH_MIN_INTERVAL_MS - Date.now());
    const timer = window.setTimeout(() => void loadCounts(filters), delay);
    return () => window.clearTimeout(timer);
  }, [busy, current, filters, liveRevision, loadCounts, readAt, readRevision, shown]);

  const retry = useCallback(() => {
    if (filters) void retryCounts(filters);
  }, [filters, retryCounts]);
  return { data: entry?.data ?? null, current, failed: entry?.failed ?? false, retry };
}

/** Sum of a counts' statuses: every task the filters match. */
export function totalOf(counts: ServerTaskCounts | null): number | null {
  if (!counts) return null;
  const { backlog, todo, in_progress, done, closed } = counts.statuses;
  return backlog + todo + in_progress + done + closed;
}
