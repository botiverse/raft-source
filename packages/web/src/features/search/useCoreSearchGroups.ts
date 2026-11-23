// Core's own groups of global search (`GET /api/search?app=channels|people`,
// docs/contracts/web-search.md): the server decides which channels and people
// a query finds, in which order and with which status (CTO + product lead,
// #proj-mobile:#177). The page paints its local list first (no waiting while
// typing); when a group's answer for the words in the field arrives it
// replaces the local rows of that group (useSearchEntityResults). A group that
// can't be asked (offline, a failed request, a group error) keeps the local
// rows and says so (offline, or a failed search with Retry).
//
// Not behind any app flag (useAppSearchEnabled gates the app groups only):
// channels and people are core and always searchable. Each group is its own
// request, fired in parallel after the same debounce as the app groups; a new
// query aborts every request still out for the old one and drops late answers
// (a generation per query). "Show all" pages a group on with its own cursor.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { WEB_SEARCH_MAX_LIMIT, WEB_SEARCH_QUERY_MAX_CHARS } from "@botiverse/raft-shared";
import type { SearchCursor, WebSearchCoreGroupId, WebSearchItemsByCoreGroup } from "@botiverse/raft-shared";
import api from "../../api/client";
import { APP_SEARCH_DEBOUNCE_MS } from "./useAppSearchGroups";

/** One core group's answer for `q`, or why there is none. */
export type CoreGroupState<G extends WebSearchCoreGroupId> =
  | { status: "idle" }
  | { status: "loading"; q: string; retry?: boolean }
  | { status: "failed"; q: string }
  | {
    status: "ok";
    q: string;
    items: WebSearchItemsByCoreGroup[G][];
    nextCursor: SearchCursor | null;
    total: number;
    paging: boolean;
    /** The last next page failed (the rows loaded stay; the section offers Retry in its place). */
    pageFailed?: boolean;
  };

export interface CoreSearchState {
  generation: number;
  channels: CoreGroupState<"channels">;
  people: CoreGroupState<"people">;
}

export interface CoreSearchGroupsOptions {
  /** The committed words (trimmed), or null while an IME composition is open (nothing changes). */
  q: string | null;
  /** Off for a conversation's own search (core groups are server-wide). */
  enabled: boolean;
  serverId: string | null;
}

type Action =
  | { type: "reset"; generation: number }
  | { type: "start"; generation: number; q: string; groups: readonly WebSearchCoreGroupId[] }
  | { type: "loaded"; generation: number; group: WebSearchCoreGroupId; state: CoreGroupState<WebSearchCoreGroupId> }
  | { type: "paging"; generation: number; group: WebSearchCoreGroupId; paging: boolean; failed?: boolean }
  | { type: "paged"; generation: number; group: WebSearchCoreGroupId; items: unknown[]; nextCursor: SearchCursor | null; total: number };

const IDLE = { status: "idle" } as const;

/** The groups the words ask for: a leading `#` is channels only, `@` people only (as the local list). */
export function coreGroupsForQuery(q: string): WebSearchCoreGroupId[] {
  if (q.startsWith("#")) return ["channels"];
  if (q.startsWith("@")) return ["people"];
  return ["channels", "people"];
}

function itemKey(group: WebSearchCoreGroupId, item: unknown): string {
  const { id, kind } = item as { id?: unknown; kind?: unknown };
  return group === "people" ? `${String(kind)}:${String(id)}` : String(id);
}

export function coreSearchReducer(state: CoreSearchState, action: Action): CoreSearchState {
  switch (action.type) {
    case "reset":
      return { generation: action.generation, channels: IDLE, people: IDLE };
    case "start":
      return {
        generation: action.generation,
        channels: action.groups.includes("channels") ? { status: "loading", q: action.q } : IDLE,
        people: action.groups.includes("people") ? { status: "loading", q: action.q } : IDLE,
      };
    default:
      break;
  }
  if (action.generation !== state.generation) return state;
  const current = state[action.group];
  switch (action.type) {
    case "loaded":
      return { ...state, [action.group]: action.state };
    case "paging":
      return current.status === "ok" ? { ...state, [action.group]: { ...current, paging: action.paging, pageFailed: action.failed === true } } : state;
    case "paged": {
      if (current.status !== "ok") return state;
      // A row already shown (the server's order moved meanwhile) isn't shown twice.
      const seen = new Set(current.items.map((item) => itemKey(action.group, item)));
      const fresh = action.items.filter((item) => !seen.has(itemKey(action.group, item)));
      return { ...state, [action.group]: { ...current, paging: false, pageFailed: false, items: [...current.items, ...fresh], nextCursor: action.nextCursor, total: action.total } };
    }
    default:
      return state;
  }
}

/** The group's page in an answer; null: no usable page (a group error, or not this group). */
export function readCorePage(data: unknown, group: WebSearchCoreGroupId): { items: unknown[]; nextCursor: SearchCursor | null; total: number } | null {
  const groups = typeof data === "object" && data !== null ? (data as { groups?: unknown }).groups : undefined;
  if (!Array.isArray(groups)) return null;
  const page = groups.find((entry: unknown) => typeof entry === "object" && entry !== null && (entry as { app?: unknown }).app === group) as
    | { items?: unknown; nextCursor?: unknown; total?: unknown }
    | undefined;
  if (!page || !Array.isArray(page.items)) return null;
  return {
    items: page.items,
    nextCursor: typeof page.nextCursor === "string" ? (page.nextCursor as SearchCursor) : null,
    total: typeof page.total === "number" ? page.total : page.items.length,
  };
}

function isCanceled(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === "ERR_CANCELED" || name === "CanceledError" || name === "AbortError";
}

function searchable(q: string | null): q is string {
  return q !== null && q.replace(/^[#@]/, "").trim().length > 0 && Array.from(q).length <= WEB_SEARCH_QUERY_MAX_CHARS;
}

export function useCoreSearchGroups({ q, enabled, serverId }: CoreSearchGroupsOptions) {
  const [state, dispatch] = useReducer(coreSearchReducer, { generation: 0, channels: IDLE, people: IDLE });
  const generationRef = useRef(0);
  const requestsRef = useRef(new Set<AbortController>());

  const abortAll = useCallback(() => {
    for (const controller of requestsRef.current) controller.abort();
    requestsRef.current.clear();
  }, []);

  const request = useCallback(async (params: Record<string, string | number>) => {
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const { data } = await api.get("/search", { params, signal: controller.signal });
      return data as unknown;
    } finally {
      requestsRef.current.delete(controller);
    }
  }, []);

  // One group's first page for `q`, as the answer for `generation`.
  const fetchGroup = useCallback((generation: number, q: string, group: WebSearchCoreGroupId) => {
    request({ q, app: group }).then(
      (data) => {
        if (generation !== generationRef.current) return;
        const page = readCorePage(data, group);
        dispatch({
          type: "loaded",
          generation,
          group,
          state: page ? { status: "ok", q, items: page.items as never[], nextCursor: page.nextCursor, total: page.total, paging: false } : { status: "failed", q },
        });
      },
      (error: unknown) => {
        if (isCanceled(error) || generation !== generationRef.current) return;
        dispatch({ type: "loaded", generation, group, state: { status: "failed", q } });
      },
    );
  }, [request]);

  // A new query: the old one's requests are aborted and its answers go, so
  // the page draws its local rows until this query's answers arrive.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- an async loader keyed on the committed words and the server, as useAppSearchGroups.
  useEffect(() => {
    if (q === null) return;
    abortAll();
    const generation = ++generationRef.current;
    if (!enabled || !searchable(q)) {
      dispatch({ type: "reset", generation });
      return;
    }
    const groups = coreGroupsForQuery(q);
    dispatch({ type: "start", generation, q, groups });
    const timer = window.setTimeout(() => {
      for (const group of groups) fetchGroup(generation, q, group);
    }, APP_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [abortAll, enabled, fetchGroup, q, serverId]);

  useEffect(() => abortAll, [abortAll]);

  /**
   * A group's next page (Load more, once the section is expanded); false when
   * it failed: the rows on screen stay and the group's `pageFailed` is set
   * (the section shows Retry in Load more's place).
   */
  const loadMore = useCallback(async (group: WebSearchCoreGroupId): Promise<boolean> => {
    const { generation } = state;
    const current = state[group];
    if (current.status !== "ok" || current.paging || !current.nextCursor) return true;
    dispatch({ type: "paging", generation, group, paging: true });
    try {
      const page = readCorePage(await request({ q: current.q, app: group, cursor: current.nextCursor, limit: WEB_SEARCH_MAX_LIMIT }), group);
      if (page) dispatch({ type: "paged", generation, group, ...page });
      else dispatch({ type: "paging", generation, group, paging: false, failed: true });
      return page !== null || generation !== generationRef.current;
    } catch (error) {
      if (isCanceled(error)) return true;
      dispatch({ type: "paging", generation, group, paging: false, failed: true });
      return generation !== generationRef.current;
    }
  }, [request, state]);

  /** Asks again for the groups whose request failed (the incomplete line's Retry); the others keep their answer. */
  const retry = useCallback(() => {
    const { generation } = state;
    for (const group of ["channels", "people"] as const) {
      const current = state[group];
      if (current.status !== "failed") continue;
      dispatch({ type: "loaded", generation, group, state: { status: "loading", q: current.q, retry: true } });
      fetchGroup(generation, current.q, group);
    }
  }, [fetchGroup, state]);

  return { state, loadMore, retry };
}
