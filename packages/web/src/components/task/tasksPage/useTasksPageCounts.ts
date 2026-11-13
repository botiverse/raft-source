import { useCallback, useMemo } from "react";

import type { ViewMode } from "../tasksViewMode";
import type { BoardStatus, ServerTaskBoardFilters, ServerTaskCounts } from "./tasksPageApi";
import { BOARD_STATUSES } from "./tasksPageApi";
import {
  NO_PAGE_FILTERS,
  assignedSectionFilters,
  boardColumns,
  boardCountsFilters,
  serverFiltersOf,
  startedSectionFilters,
} from "./tasksPageModel";
import type { MineSection, PageFilters, TasksPageTab } from "./tasksPageModel";
import { totalOf, useTaskCounts } from "./useTasksPageData";

const NO_FILTERS: ServerTaskBoardFilters = {};

export interface TasksPageCounts {
  /** The tabs' numbers, under no filter: 我的's two sections, and every task (全部). */
  tabs: Record<TasksPageTab, number | null>;
  /** What the current view shows under its filters (the head's N); null while searching. */
  shown: number | null;
  /**
   * A search narrows the view: the counts take no search (`q` is not sent; a count of a search is the server's
   * costliest read), so the view's numbers are not read: `shown`, `sections` and `columns` stay null and the lists
   * show what they read.
   */
  searching: boolean;
  /** 我的 list: each section's total. */
  sections: Record<MineSection, number> | null;
  /** Board: each column's total. */
  columns: Record<BoardStatus, number> | null;
  /** The numbers are the server's for the live changes so far (a lane re-reads to agree with them). */
  current: boolean;
  /** The counts could not be read (after retries). */
  failed: boolean;
  retry: () => void;
}

function sum(...values: (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
}

function columnsOf(counts: readonly (ServerTaskCounts | null)[]): Record<BoardStatus, number> | null {
  if (counts.some((entry) => entry === null)) return null;
  const columns = { backlog: 0, todo: 0, in_progress: 0, done: 0, closed: 0 } satisfies Record<BoardStatus, number>;
  for (const entry of counts) for (const status of BOARD_STATUSES) columns[status] += entry!.statuses[status];
  return columns;
}

/**
 * The Tasks page's numbers, every one the server's count: the tabs (no
 * filter), the head's N under the filters, the 我的 sections and the board's
 * columns. The filter sets are those of the lanes (tasksPageModel), so each
 * number counts exactly the rows its lane pages through. A read is shared by
 * every caller of the same filter set (tasksPageStore).
 */
export function useTasksPageCounts(tab: TasksPageTab, view: ViewMode, filters: PageFilters, doneSince: string): TasksPageCounts {
  // The tabs, under no filter.
  const mineUnfiltered = useMemo(
    () => [assignedSectionFilters(NO_PAGE_FILTERS), ...startedSectionFilters(NO_PAGE_FILTERS, doneSince)],
    [doneSince],
  );
  const allTotal = useTaskCounts(NO_FILTERS);
  const mineA = useTaskCounts(mineUnfiltered[0]!);
  const mineB = useTaskCounts(mineUnfiltered[1]!);
  const mineC = useTaskCounts(mineUnfiltered[2]!);

  // The view, under its filters: up to three filter sets (a 我的 view has one per relation). None for a search.
  const searching = filters.query !== "";
  const viewFilters = useMemo<ServerTaskBoardFilters[]>(() => {
    if (filters.query !== "") return [];
    if (view === "board") return boardCountsFilters(tab, filters);
    if (tab === "all") return [serverFiltersOf(filters)];
    return [assignedSectionFilters(filters), ...startedSectionFilters(filters, doneSince)];
  }, [doneSince, filters, tab, view]);
  const slotA = useTaskCounts(viewFilters[0] ?? null);
  const slotB = useTaskCounts(viewFilters[1] ?? null);
  const slotC = useTaskCounts(viewFilters[2] ?? null);
  const slots = [slotA, slotB, slotC].slice(0, viewFilters.length);

  const tabs: Record<TasksPageTab, number | null> = {
    mine: sum(totalOf(mineA.data), totalOf(mineB.data), totalOf(mineC.data)),
    all: totalOf(allTotal.data),
  };
  const slotData = slots.map((slot) => slot.data);
  let sections: Record<MineSection, number> | null = null;
  let columns: Record<BoardStatus, number> | null = null;
  let shown: number | null;
  if (view === "board") {
    columns = columnsOf(slotData);
    shown = columns ? boardColumns(filters).reduce((total, status) => total + columns![status], 0) : null;
  } else if (tab === "all") {
    shown = totalOf(slotData[0] ?? null);
  } else {
    const assigned = totalOf(slotData[0] ?? null);
    const started = sum(totalOf(slotData[1] ?? null), totalOf(slotData[2] ?? null));
    sections = assigned === null || started === null ? null : { assigned, started };
    shown = sum(assigned, started);
  }

  const all = [allTotal, mineA, mineB, mineC, ...slots];
  const retry = useCallback(() => {
    for (const view of [allTotal, mineA, mineB, mineC, slotA, slotB, slotC]) if (view.failed) view.retry();
  }, [allTotal, mineA, mineB, mineC, slotA, slotB, slotC]);
  return {
    tabs,
    shown,
    searching,
    sections,
    columns,
    current: all.every((entry) => entry.current),
    failed: slots.some((slot) => slot.failed && !slot.data),
    retry,
  };
}
