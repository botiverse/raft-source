import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { ingestServerTaskQueryPage } from "../../../store/taskStore";
import type { Task } from "../../../store/taskStore";
import type { TaskRowSelection } from "../TaskChipList";
import { fetchServerTaskPage } from "./tasksPageApi";
import type { LaneSpec } from "./tasksPageModel";

const NO_IDS: ReadonlySet<string> = new Set();

/** Select all reads its lanes to their end this many rows at a time (the server's page cap)… */
const SELECT_ALL_PAGE = 500;
/** …up to this many tasks: past it the selection stops there, and the page says how many it holds. */
export const SELECT_ALL_MAX = 2000;

/**
 * The ids the page shows, in the order it shows them (rows top to bottom,
 * board columns left to right): a Shift-click's run goes from one to the
 * other on screen. Rows and cards carry `data-task-id`.
 */
export function shownTaskIds(root: ParentNode | null): string[] {
  if (!root) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-task-id]")) {
    const id = element.dataset.taskId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The ids from `from` to `to` (either order) in `order`, both included; just `to` when `from` is not there. */
export function selectionRun(order: readonly string[], from: string | null, to: string): string[] {
  const end = order.indexOf(to);
  const start = from === null ? -1 : order.indexOf(from);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * Every task the lanes hold, read to their end (summaries, kept in the task
 * store so the batch actions know them), at most `max`. `complete` is false
 * when it stopped short: at `max` (`capped`), or because a read failed or the
 * connection dropped meanwhile (not capped).
 */
export async function readAllLaneTaskIds(lanes: readonly LaneSpec[], max = SELECT_ALL_MAX): Promise<{ ids: string[]; complete: boolean; capped: boolean }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    let cursor: string | null = null;
    do {
      let page;
      try {
        page = await ingestServerTaskQueryPage(() => fetchServerTaskPage({
          filters: lane.filters,
          sort: lane.sort,
          limit: SELECT_ALL_PAGE,
          cursor,
          detail: "summary",
        }));
      } catch (err) {
        console.error("Select all could not read on:", err);
        page = null;
      }
      if (!page) return { ids, complete: false, capped: false };
      for (const task of page.tasks) {
        if (seen.has(task.id)) continue;
        if (ids.length >= max) return { ids, complete: false, capped: true };
        seen.add(task.id);
        ids.push(task.id);
      }
      cursor = page.tasks.length > 0 ? page.nextCursor : null;
    } while (cursor);
  }
  return { ids, complete: true, capped: false };
}

export interface TaskSelection extends TaskRowSelection {
  selected: ReadonlySet<string>;
  clear: () => void;
  /** Replace the selection (Select all). */
  setAll: (ids: readonly string[]) => void;
  /** Add `ids` (more of Select all, as it reads). */
  add: (ids: readonly string[]) => void;
  /** Drop ids that left (deleted). */
  remove: (ids: readonly string[]) => void;
  /** The task picked last by hand (a click or a Shift-click), kept after the selection ends: where focus goes back to. */
  lastPicked: () => string | null;
}

/**
 * The Tasks page's selection: ids, and the last one picked (a Shift-click's
 * run starts there). It belongs to what the page shows (`scope`: the tab,
 * view, sort, filters and search): when that changes, the selection is empty
 * and a Shift-click's run has no start.
 * `rootRef` is the page, whose rows give a run its order (shownTaskIds).
 */
export function useTaskSelection(scope: string, rootRef: RefObject<HTMLElement | null>): TaskSelection {
  const [state, setState] = useState<{ scope: string; ids: ReadonlySet<string> }>({ scope, ids: NO_IDS });
  const anchorRef = useRef<string | null>(null);
  const lastPickedRef = useRef<string | null>(null);
  const selected = state.scope === scope ? state.ids : NO_IDS;
  useEffect(() => {
    anchorRef.current = null;
    lastPickedRef.current = null;
  }, [scope]);

  const update = useCallback((edit: (ids: ReadonlySet<string>) => ReadonlySet<string>) => {
    setState((previous) => ({ scope, ids: edit(previous.scope === scope ? previous.ids : NO_IDS) }));
  }, [scope]);

  const onSelect = useCallback((task: Task, { range }: { range: boolean }) => {
    const anchor = anchorRef.current;
    if (range && anchor !== null) {
      const run = selectionRun(shownTaskIds(rootRef.current), anchor, task.id);
      update((ids) => new Set([...ids, ...run]));
    } else {
      update((ids) => {
        const next = new Set(ids);
        if (next.has(task.id)) next.delete(task.id);
        else next.add(task.id);
        return next;
      });
    }
    anchorRef.current = task.id;
    lastPickedRef.current = task.id;
  }, [rootRef, update]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    update(() => NO_IDS);
  }, [update]);
  const setAll = useCallback((ids: readonly string[]) => update(() => new Set(ids)), [update]);
  const add = useCallback((ids: readonly string[]) => update((current) => new Set([...current, ...ids])), [update]);
  const remove = useCallback((ids: readonly string[]) => update((current) => {
    const next = new Set(current);
    for (const id of ids) next.delete(id);
    return next;
  }), [update]);
  const isSelected = useCallback((id: string) => selected.has(id), [selected]);
  const lastPicked = useCallback(() => lastPickedRef.current, []);

  return useMemo(() => ({
    selected,
    selecting: selected.size > 0,
    isSelected,
    onSelect,
    clear,
    setAll,
    add,
    remove,
    lastPicked,
  }), [add, clear, isSelected, lastPicked, onSelect, remove, selected, setAll]);
}
