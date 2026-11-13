import { useCallback, useMemo, useState } from "react";

import { useLiveSearchParams } from "../../../hooks/useLiveSearchParams";
import { useAuthStore } from "../../../store/authStore";
import { useServerStore } from "../../../store/serverStore";
import { parseTaskViewMode, readStoredTaskViewMode, writeStoredTaskViewMode } from "../tasksViewMode";
import type { ViewMode } from "../tasksViewMode";
import { DEFAULT_SERVER_TASK_SORT } from "./tasksPageApi";
import type { BoardStatus, ServerTaskSort } from "./tasksPageApi";
import {
  parseBoardStatus,
  parseServerTaskSort,
  parseTasksPageTab,
  TASK_SEARCH_MAX_LENGTH,
  readStoredTasksPageTab,
  writeStoredTasksPageTab,
} from "./tasksPageModel";
import type { PageFilters, TasksPageTab } from "./tasksPageModel";

const NO_VALUES: readonly string[] = [];
const NO_STATUSES: readonly BoardStatus[] = [];

/** The list is the page's own view (the approved design); the person's last choice wins. */
const DEFAULT_VIEW: ViewMode = "list";

type ListParam = "channel" | "status" | "creator" | "assignee";

/**
 * The Tasks page's state, in the address so a view can be shared and
 * reloaded (Raft DS › Tasks › Filters): `?tab=mine|all`, `?sort=` (absent:
 * most recently updated), `?view=board|list`, `?q=` (the search) and the
 * filters `?channel=`, `?status=`, `?creator=`, `?assignee=` (both tabs).
 * The tab and the view also fall back to the person's last choice (the tab
 * per server and person), then to 我的 and to the list.
 */
export function useTasksPageParams() {
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [storedView, setStoredView] = useState<ViewMode | null>(() => readStoredTaskViewMode());

  const urlTab = parseTasksPageTab(searchParams.get("tab"));
  // The stored choice is read again when the server or the person changes.
  const storedTab = useMemo(() => readStoredTasksPageTab(serverId, userId), [serverId, userId]);
  const tab: TasksPageTab = urlTab ?? storedTab ?? "mine";
  const sort: ServerTaskSort = parseServerTaskSort(searchParams.get("sort")) ?? DEFAULT_SERVER_TASK_SORT;
  const view: ViewMode = parseTaskViewMode(searchParams.get("view")) ?? storedView ?? DEFAULT_VIEW;

  const channelParam = searchParams.getAll("channel").join(",");
  const statusParam = searchParams.getAll("status").join(",");
  const creatorParam = searchParams.getAll("creator").join(",");
  const assigneeParam = searchParams.getAll("assignee").join(",");
  // The server takes a search of TASK_SEARCH_MAX_LENGTH at most: a longer one from the address is cut there.
  const rawQuery = (searchParams.get("q") ?? "").slice(0, TASK_SEARCH_MAX_LENGTH);
  const query = rawQuery.trim();
  const filters = useMemo<PageFilters>(() => {
    const list = (param: string) => (param ? param.split(",").filter(Boolean) : NO_VALUES);
    const statuses = statusParam
      ? [...new Set(statusParam.split(",").map(parseBoardStatus).filter((status): status is BoardStatus => status !== null))]
      : NO_STATUSES;
    return {
      channelIds: list(channelParam),
      statuses,
      creators: list(creatorParam),
      assignees: list(assigneeParam),
      query,
    };
  }, [assigneeParam, channelParam, creatorParam, query, statusParam]);

  const write = useCallback((edit: (next: URLSearchParams) => void) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      edit(next);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setTab = useCallback((next: TasksPageTab) => {
    writeStoredTasksPageTab(serverId, userId, next);
    write((params) => params.set("tab", next));
  }, [serverId, userId, write]);

  const setSort = useCallback((next: ServerTaskSort) => {
    write((params) => {
      if (next === DEFAULT_SERVER_TASK_SORT) params.delete("sort");
      else params.set("sort", next);
    });
  }, [write]);

  const setView = useCallback((next: ViewMode) => {
    setStoredView(next);
    writeStoredTaskViewMode(next);
    write((params) => {
      if (next === DEFAULT_VIEW) params.delete("view");
      else params.set("view", next);
    });
  }, [write]);

  const setList = useCallback((key: ListParam, values: readonly string[]) => {
    write((params) => {
      params.delete(key);
      for (const value of values) params.append(key, value);
    });
  }, [write]);
  const setChannelIds = useCallback((values: string[]) => setList("channel", values), [setList]);
  const setStatuses = useCallback((values: string[]) => setList("status", values), [setList]);
  const setCreators = useCallback((values: string[]) => setList("creator", values), [setList]);
  const setAssignees = useCallback((values: string[]) => setList("assignee", values), [setList]);

  const setQuery = useCallback((next: string) => {
    write((params) => {
      if (next.trim()) params.set("q", next);
      else params.delete("q");
    });
  }, [write]);

  /** 清除筛选: every toolbar filter; `withSearch` the search too (the empty result's Clear). */
  const clearFilters = useCallback((withSearch = false) => {
    write((params) => {
      for (const key of ["channel", "status", "creator", "assignee"] as const) params.delete(key);
      if (withSearch) params.delete("q");
    });
  }, [write]);

  return {
    tab, setTab,
    sort, setSort,
    view, setView,
    filters,
    /** The search as typed in the address (untrimmed), for the field. */
    rawQuery,
    setQuery,
    setChannelIds,
    setStatuses,
    setCreators,
    setAssignees,
    clearFilters,
  };
}
