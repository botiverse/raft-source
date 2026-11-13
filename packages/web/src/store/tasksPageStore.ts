import { create } from "zustand";

import { fetchServerTaskCounts, fetchServerTaskPage, serverTaskFilterParams } from "../components/task/tasksPage/tasksPageApi";
import type { ServerTaskBoardFilters, ServerTaskCounts } from "../components/task/tasksPage/tasksPageApi";
import { LANE_PAGE_SIZE, sortKeyOf } from "../components/task/tasksPage/tasksPageModel";
import type { LaneReadState, LaneSpec } from "../components/task/tasksPage/tasksPageModel";
import { registerServerReset } from "./serverResetRegistry";
import { currentLiveSequence, pruneLiveChanges } from "./serverTaskMerge";
import { ingestServerTaskQueryPage, useTaskStore } from "./taskStore";

/**
 * The Tasks page's reads (task v2): per lane (a 我的 section, the 全部 list or a board column,
 * tasksPageModel.ts) the ids and cursor read so far, and the server's counts
 * per filter set. The tasks themselves live in taskStore.serverTasks, which
 * the socket keeps current; a lane only remembers how far it has read. Kept
 * outside the page so leaving Tasks and coming back finds it read.
 */

export interface LaneState extends LaneReadState {
  loading: boolean;
  /** The last read failed; the lane offers Try again. */
  failed: boolean;
  /** Live tasks of unknown relation the lane has read again for (once each: laneUnknownIds). */
  checkedIds: readonly string[];
  /** The server count the lane last read again to agree with (once per count). */
  syncedCount: number | null;
}

export interface CountsState {
  data: ServerTaskCounts | null;
  loading: boolean;
  /** The liveRevision the data was read at (or the read in flight started at). */
  revision: number;
  /** When the last read began (Date.now()): a refresh waits out COUNTS_REFRESH_MIN_INTERVAL_MS from it (useTaskCounts). */
  readAt: number;
  /** Failed reads in a row; retried with a growing wait up to COUNTS_ATTEMPTS. */
  failures: number;
  /** Every attempt failed and there is nothing to show: the page says so, with Try again. */
  failed: boolean;
}

export interface LaneReadOptions {
  /** Read the first page again and replace what was read (a count that disagrees, a live row of unknown relation). */
  restart?: boolean;
  /** Recorded on the lane with the read: the ids it was read for, the count it was read to agree with. */
  checkedIds?: readonly string[];
  syncedCount?: number;
}

interface TasksPageState {
  lanes: Record<string, LaneState>;
  counts: Record<string, CountsState>;
  /** Groups / columns folded by hand, by name (`mine:<relation>`, `all:<status>`). */
  collapsed: Record<string, boolean>;
  /** Read the lane's next page (its first when never read, or with `restart`). No-op while reading or once complete. */
  loadLanePage: (lane: LaneSpec, options?: LaneReadOptions) => Promise<void>;
  /** Read the counts of a filter set, unless current for this liveRevision, being read, or given up on. */
  loadCounts: (filters: ServerTaskBoardFilters) => Promise<void>;
  /** Try again after the counts gave up (the page's Try again). */
  retryCounts: (filters: ServerTaskBoardFilters) => Promise<void>;
  setCollapsed: (name: string, collapsed: boolean) => void;
  /** Drop the reads (lanes and counts) made for 你发起的's done-since instant `since`: the page has moved past it. */
  evictCompletedSince: (since: string) => void;
  /** Forget every read (socket gap, server switch): mounted views read again from their first page. */
  reset: () => void;
}

const EMPTY_LANE: LaneState = {
  ids: [], keys: {}, frontier: null, nextCursor: null, loaded: false, readSequence: 0,
  loading: false, failed: false, checkedIds: [], syncedCount: null,
};

/** Attempts at a counts read before the page says it failed; waits of 1s, 2s between them. */
const COUNTS_ATTEMPTS = 3;
const COUNTS_RETRY_BASE_MS = 1000;

export function countsKey(filters: ServerTaskBoardFilters): string {
  return serverTaskFilterParams(filters).toString();
}

// Bumped on reset: a read that started before it must not land after it.
let readGeneration = 0;

/** Where first-page reads in flight start on the live-change counter: their changes must outlive any pruning. */
const firstReadsInFlight: number[] = [];

/** Forget the live changes every held read already covers (serverTaskMerge.pruneLiveChanges). */
function pruneCoveredLiveChanges(lanes: Record<string, LaneState>): void {
  const starts = [...Object.values(lanes).filter((lane) => lane.loaded).map((lane) => lane.readSequence), ...firstReadsInFlight];
  pruneLiveChanges(starts.length > 0 ? Math.min(...starts) : null);
}

/** Server cap on a page; a re-read asks for as many rows as the lane shows (up to it), so it keeps its length. */
const SERVER_PAGE_MAX = 500;

export const useTasksPageStore = create<TasksPageState>((set, get) => ({
  lanes: {},
  counts: {},
  collapsed: {},

  loadLanePage: async (lane, options = {}) => {
    const current = get().lanes[lane.key] ?? EMPTY_LANE;
    const restart = options.restart === true;
    if (current.loading || (!restart && current.loaded && current.nextCursor === null)) return;
    const generation = readGeneration;
    const firstPage = restart || !current.loaded;
    const sequence = currentLiveSequence();
    if (firstPage) firstReadsInFlight.push(sequence);
    const marks = {
      checkedIds: options.checkedIds ? [...new Set([...current.checkedIds, ...options.checkedIds])] : current.checkedIds,
      syncedCount: options.syncedCount ?? current.syncedCount,
    };
    set((state) => ({ lanes: { ...state.lanes, [lane.key]: { ...current, ...marks, loading: true, failed: false } } }));
    try {
      const page = await ingestServerTaskQueryPage(() => fetchServerTaskPage({
        filters: lane.filters,
        sort: lane.sort,
        // A re-read of a lane read further than its first page reads as far again,
        // so it neither shrinks under the reader nor jumps the scroll.
        limit: restart ? Math.min(SERVER_PAGE_MAX, Math.max(LANE_PAGE_SIZE, current.ids.length)) : LANE_PAGE_SIZE,
        cursor: firstPage ? null : current.nextCursor,
        detail: lane.detail,
      }));
      if (generation !== readGeneration) return;
      if (!page) {
        // The connection dropped while reading: start this lane over.
        set((state) => ({ lanes: { ...state.lanes, [lane.key]: { ...EMPTY_LANE, ...marks } } }));
        return;
      }
      set((state) => {
        const previous = state.lanes[lane.key] ?? EMPTY_LANE;
        // A first page replaces what was read (a restart drops rows the server no longer lists).
        const baseIds = firstPage ? [] : previous.ids;
        const seen = new Set(baseIds);
        const ids = [...baseIds];
        const keys: Record<string, number> = firstPage ? {} : { ...previous.keys };
        for (const task of page.tasks) {
          keys[task.id] = sortKeyOf(lane.sort, task);
          if (seen.has(task.id)) continue;
          seen.add(task.id);
          ids.push(task.id);
        }
        const last = page.tasks[page.tasks.length - 1];
        return {
          lanes: {
            ...state.lanes,
            [lane.key]: {
              ...marks,
              ids,
              keys,
              frontier: last ? { ...last } : firstPage ? null : previous.frontier,
              nextCursor: page.tasks.length > 0 ? page.nextCursor : null,
              loaded: true,
              readSequence: firstPage ? sequence : previous.readSequence,
              loading: false,
              failed: false,
            },
          },
        };
      });
      if (firstPage) pruneCoveredLiveChanges(get().lanes);
    } catch (err) {
      console.error("Failed to load tasks:", err);
      if (generation !== readGeneration) return;
      // A 400 on a next page is a cursor the server no longer accepts (its
      // channel left the board): read the lane again from its start. On a
      // first page it is the request itself: failed, not retried on its own.
      const status = (err as { response?: { status?: number } })?.response?.status;
      const startOver = status === 400 && !firstPage;
      set((state) => ({
        lanes: {
          ...state.lanes,
          [lane.key]: startOver ? { ...EMPTY_LANE, ...marks } : { ...(state.lanes[lane.key] ?? EMPTY_LANE), loading: false, failed: true },
        },
      }));
    } finally {
      const index = firstPage ? firstReadsInFlight.indexOf(sequence) : -1;
      if (index >= 0) firstReadsInFlight.splice(index, 1);
    }
  },

  loadCounts: async (filters) => {
    const key = countsKey(filters);
    const revision = useTaskStore.getState().liveRevision;
    const current = get().counts[key];
    if (current && (current.loading || current.failed || (current.data && current.revision === revision))) return;
    const generation = readGeneration;
    const failures = current?.failures ?? 0;
    const readAt = Date.now();
    set((state) => ({ counts: { ...state.counts, [key]: { data: current?.data ?? null, loading: true, revision, readAt, failures, failed: false } } }));
    try {
      const data = await fetchServerTaskCounts(filters);
      if (generation !== readGeneration) return;
      set((state) => ({ counts: { ...state.counts, [key]: { data, loading: false, revision, readAt, failures: 0, failed: false } } }));
    } catch (err) {
      console.error("Failed to count tasks:", err);
      if (generation !== readGeneration) return;
      const failed = failures + 1;
      const data = current?.data ?? null;
      // Gave up: with numbers already shown they stay (the next live change
      // reads again); with none, the page says so and offers Try again.
      const givenUp = failed >= COUNTS_ATTEMPTS;
      set((state) => ({
        counts: { ...state.counts, [key]: { data, loading: false, revision: givenUp && data ? revision : -1, readAt, failures: givenUp ? 0 : failed, failed: givenUp && !data } },
      }));
      if (!givenUp) {
        window.setTimeout(() => {
          if (generation === readGeneration) void get().loadCounts(filters);
        }, COUNTS_RETRY_BASE_MS * 2 ** (failed - 1));
      }
    }
  },

  retryCounts: async (filters) => {
    const key = countsKey(filters);
    set((state) => {
      const current = state.counts[key];
      return current ? { counts: { ...state.counts, [key]: { ...current, failures: 0, failed: false, revision: -1 } } } : state;
    });
    await get().loadCounts(filters);
  },

  setCollapsed: (name, collapsed) => set((state) => ({ collapsed: { ...state.collapsed, [name]: collapsed } })),

  evictCompletedSince: (since) => {
    // Keys carry the filters' query string (laneKey, countsKey). A read in flight under it lands in no lane shown.
    const marker = new URLSearchParams({ completed_since: since }).toString();
    const keep = <T>(entries: Record<string, T>) => Object.fromEntries(Object.entries(entries).filter(([key]) => !key.includes(marker)));
    set((state) => ({ lanes: keep(state.lanes), counts: keep(state.counts) }));
    pruneCoveredLiveChanges(get().lanes);
  },

  reset: () => {
    readGeneration += 1;
    firstReadsInFlight.length = 0;
    pruneLiveChanges(null);
    set({ lanes: {}, counts: {} });
  },
}));

// A socket gap or a server switch bumps taskStore's generation: what the page
// read before it may have missed changes, so it reads again.
useTaskStore.subscribe((state, previous) => {
  if (state.serverTasksGeneration !== previous.serverTasksGeneration) useTasksPageStore.getState().reset();
});

registerServerReset(() => {
  useTasksPageStore.getState().reset();
  useTasksPageStore.setState({ collapsed: {} });
});
