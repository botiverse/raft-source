// The app groups of global search: core's `GET /api/search` (shared
// webSearchContract.ts), one group per first-party app that searches and is
// on for the server, in the server's order. The page renders whatever groups
// the answer holds; a server with an app switched off simply sends no group
// for it, so nothing here checks a flag. (The page turns this off, `enabled`,
// while no app is on for the server: useAppSearchEnabled.)
//
// It runs beside the message search, not after it: each lands on its own.
// When the query changes, every request still out for the old one is aborted
// and anything that answers late is dropped (a generation per query), and the
// old query's groups leave the screen at once: what shows always answers the
// words in the field. A group that timed out or failed shows that in its own
// section with a Retry for that app alone (`?app=`); a group pages on with its
// own cursor (`?app=&cursor=`).
import { useCallback, useEffect, useReducer, useRef } from "react";
import { WEB_SEARCH_QUERY_MAX_CHARS } from "@botiverse/raft-shared";
import type { SearchCursor, WebSearchApp, WebSearchGroup, WebSearchGroupError } from "@botiverse/raft-shared";
import api from "../../api/client";

/** A group with results (possibly none). */
export type AppSearchPageGroup = Extract<WebSearchGroup, { items: unknown }>;

/** One app's section: waiting for its answer, its results, or why there are none. */
export type AppGroupState =
  | { app: WebSearchApp; status: "loading" }
  | { app: WebSearchApp; status: "failed"; error: WebSearchGroupError }
  | { app: WebSearchApp; status: "ok"; group: AppSearchPageGroup; paging: boolean };

export interface AppSearchState {
  /** Bumped for every new query; an answer of an older one is dropped. */
  generation: number;
  /** The words the groups answer ("" with none). */
  q: string;
  /**
   * The request for every group: `failed` is no answer at all (offline, 429
   * RATE_LIMITED, a server error); with no sections to say so in, the page
   * shows one line for them.
   */
  status: "idle" | "loading" | "ok" | "failed";
  groups: AppGroupState[];
}

export interface AppSearchGroupsOptions {
  /** The committed words (trimmed), or null while an IME composition is open (nothing changes). */
  q: string | null;
  /** Off for a conversation's own search: the app groups are server-wide. */
  enabled: boolean;
  serverId: string | null;
  /** Which search this is (the Search tab, a conversation's), for the remount snapshot. */
  surface: string;
  /** Results per group (WEB_SEARCH_DEFAULT_LIMIT when absent). */
  limit?: number;
  /** Whether an app's group can be drawn here; a group of an app this client doesn't know is left out. */
  isKnownApp: (app: string) => app is WebSearchApp;
}

/** The same debounce as the message search beside it. */
export const APP_SEARCH_DEBOUNCE_MS = 200;

type Action =
  | { type: "reset"; generation: number }
  | { type: "start"; generation: number; q: string; expected: readonly WebSearchApp[] }
  | { type: "seed"; generation: number; q: string; groups: AppGroupState[] }
  | { type: "loaded"; generation: number; groups: WebSearchGroup[] }
  | { type: "failed"; generation: number }
  | { type: "groupLoading"; generation: number; app: WebSearchApp }
  | { type: "groupLoaded"; generation: number; app: WebSearchApp; group: WebSearchGroup | null }
  | { type: "paging"; generation: number; app: WebSearchApp; paging: boolean }
  | { type: "paged"; generation: number; app: WebSearchApp; page: AppSearchPageGroup };

function groupState(group: WebSearchGroup): AppGroupState {
  return "items" in group
    ? { app: group.app, status: "ok", group, paging: false }
    : { app: group.app, status: "failed", error: group.error };
}

function replaceGroup(groups: AppGroupState[], app: WebSearchApp, next: (group: AppGroupState) => AppGroupState | null): AppGroupState[] {
  return groups.flatMap((group) => {
    if (group.app !== app) return [group];
    const replaced = next(group);
    return replaced ? [replaced] : [];
  });
}

/** A group's next page after its rows: an item already shown (the index moved meanwhile) isn't shown twice. */
function appendPage(group: AppSearchPageGroup, page: AppSearchPageGroup, keyOf: (group: AppSearchPageGroup, index: number) => string): AppSearchPageGroup {
  const seen = new Set(group.items.map((_, index) => keyOf(group, index)));
  const fresh = page.items.filter((_, index) => !seen.has(keyOf(page, index)));
  // One app's items: the two pages are the same app's group (checked by the caller).
  return { ...group, items: [...group.items, ...fresh], nextCursor: page.nextCursor } as AppSearchPageGroup;
}

function reducer(keyOf: (group: AppSearchPageGroup, index: number) => string) {
  return (state: AppSearchState, action: Action): AppSearchState => {
    switch (action.type) {
      case "reset":
        return { generation: action.generation, q: "", status: "idle", groups: [] };
      case "start":
        // The old query's groups go; the apps the server answered with last
        // time wait in their own sections (heading and skeleton) for this one.
        return { generation: action.generation, q: action.q, status: "loading", groups: action.expected.map((app) => ({ app, status: "loading" })) };
      case "seed":
        return { generation: action.generation, q: action.q, status: "ok", groups: action.groups };
      default:
        break;
    }
    if (action.generation !== state.generation) return state;
    switch (action.type) {
      case "loaded":
        return { ...state, status: "ok", groups: action.groups.map(groupState) };
      case "failed":
        // No answer at all: the sections waiting for one say so, each with its
        // own Retry; with none waiting, the page has one line for them all.
        return { ...state, status: "failed", groups: state.groups.map((group) => ({ app: group.app, status: "failed", error: "failed" })) };
      case "groupLoading":
        return { ...state, groups: replaceGroup(state.groups, action.app, () => ({ app: action.app, status: "loading" })) };
      case "groupLoaded":
        return { ...state, groups: replaceGroup(state.groups, action.app, () => (action.group ? groupState(action.group) : null)) };
      case "paging":
        return { ...state, groups: replaceGroup(state.groups, action.app, (group) => (group.status === "ok" ? { ...group, paging: action.paging } : group)) };
      case "paged":
        return {
          ...state,
          groups: replaceGroup(state.groups, action.app, (group) => (
            group.status === "ok" && group.group.app === action.page.app
              ? { ...group, paging: false, group: appendPage(group.group, action.page, keyOf) }
              : group
          )),
        };
      default:
        return state;
    }
  };
}

/** The answer's groups this client can draw; anything else in the body is ignored. */
function readGroups(data: unknown, isKnownApp: (app: string) => app is WebSearchApp): WebSearchGroup[] {
  const groups = typeof data === "object" && data !== null ? (data as { groups?: unknown }).groups : undefined;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown): WebSearchGroup[] => {
    if (typeof group !== "object" || group === null) return [];
    const { app, items, error, nextCursor } = group as { app?: unknown; items?: unknown; error?: unknown; nextCursor?: unknown };
    if (typeof app !== "string" || !isKnownApp(app)) return [];
    // The items are the app's own type (WebSearchItemsByApp), by its id.
    if (Array.isArray(items)) return [{ app, items, nextCursor: typeof nextCursor === "string" ? (nextCursor as SearchCursor) : null } as WebSearchGroup];
    return [{ app, error: error === "timeout" ? "timeout" : "failed" }];
  });
}

function isCanceled(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === "ERR_CANCELED" || name === "CanceledError" || name === "AbortError";
}

function statusOf(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

interface Snapshot {
  serverId: string | null;
  q: string;
  limit: number | undefined;
  groups: AppGroupState[];
}

// What the last settled search showed, per surface: the page remounts when a
// result opens beside it (col 2 ↔ col 3), and the same words shouldn't search
// again or flash. And per server, the apps that answered last, so the next
// query's sections wait under their headings instead of popping in.
const snapshots = new Map<string, Snapshot>();
const expectedApps = new Map<string, readonly WebSearchApp[]>();

/** Test seam: forget what earlier searches showed. */
export function resetAppSearchSnapshots(): void {
  snapshots.clear();
  expectedApps.clear();
}

function snapshotFor(surface: string, serverId: string | null, q: string | null, limit: number | undefined): Snapshot | null {
  const snapshot = snapshots.get(surface);
  return snapshot && q !== null && snapshot.serverId === serverId && snapshot.q === q && snapshot.limit === limit ? snapshot : null;
}

function searchable(q: string | null): q is string {
  return q !== null && q.length > 0 && Array.from(q).length <= WEB_SEARCH_QUERY_MAX_CHARS;
}

export function useAppSearchGroups({ q, enabled, serverId, surface, limit, isKnownApp, keyOf }: AppSearchGroupsOptions & {
  /** An item's identity within its group (for paging without repeats). */
  keyOf: (group: AppSearchPageGroup, index: number) => string;
}) {
  const [state, dispatch] = useReducer(reducer(keyOf), undefined, (): AppSearchState => {
    const snapshot = enabled ? snapshotFor(surface, serverId, q, limit) : null;
    return snapshot
      ? { generation: 0, q: snapshot.q, status: "ok", groups: snapshot.groups }
      : { generation: 0, q: "", status: "idle", groups: [] };
  });
  const generationRef = useRef(state.generation);
  const requestsRef = useRef(new Set<AbortController>());
  const [nonce, bump] = useReducer((n: number) => n + 1, 0);
  const isKnownAppRef = useRef(isKnownApp);
  isKnownAppRef.current = isKnownApp;
  const stateRef = useRef(state);
  stateRef.current = state;

  const abortAll = useCallback(() => {
    for (const controller of requestsRef.current) controller.abort();
    requestsRef.current.clear();
  }, []);

  const request = useCallback(async (params: Record<string, string | number>) => {
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const { data } = await api.get("/search", { params, signal: controller.signal });
      return readGroups(data, isKnownAppRef.current);
    } finally {
      requestsRef.current.delete(controller);
    }
  }, []);

  const baseParams = useCallback((words: string): Record<string, string | number> => (
    limit === undefined ? { q: words } : { q: words, limit }
  ), [limit]);

  // A new query: the old one's requests are aborted and its groups go.
  // Async loader keyed on the words, the server and Retry (nonce).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (q === null) return;
    abortAll();
    const generation = ++generationRef.current;
    if (!enabled || !searchable(q)) {
      dispatch({ type: "reset", generation });
      return;
    }
    const snapshot = nonce === 0 ? snapshotFor(surface, serverId, q, limit) : null;
    if (snapshot) {
      dispatch({ type: "seed", generation, q, groups: snapshot.groups });
      return;
    }
    dispatch({ type: "start", generation, q, expected: expectedApps.get(serverId ?? "") ?? [] });
    const timer = window.setTimeout(() => {
      request(baseParams(q)).then(
        (groups) => {
          if (generation !== generationRef.current) return;
          expectedApps.set(serverId ?? "", groups.map((group) => group.app));
          dispatch({ type: "loaded", generation, groups });
        },
        (error: unknown) => {
          if (isCanceled(error) || generation !== generationRef.current) return;
          // `q` too long or empty is refused before it is sent; a 400 here is
          // a server that reads the words differently: no groups, no alarm.
          if (statusOf(error) === 400) dispatch({ type: "loaded", generation, groups: [] });
          else dispatch({ type: "failed", generation });
        },
      );
    }, APP_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [abortAll, baseParams, enabled, limit, nonce, q, request, serverId, surface]);

  useEffect(() => abortAll, [abortAll]);

  // Keep what a settled search shows for a remount with the same words.
  useEffect(() => {
    if (state.status !== "ok" || state.groups.some((group) => group.status === "loading" || (group.status === "ok" && group.paging))) return;
    snapshots.set(surface, { serverId, q: state.q, limit, groups: state.groups });
  }, [limit, serverId, state, surface]);

  /** Search one app's group again (its section's Retry): only that section changes. */
  const retryGroup = useCallback((app: WebSearchApp) => {
    const { generation, q: words } = stateRef.current;
    if (!words) return;
    dispatch({ type: "groupLoading", generation, app });
    request({ ...baseParams(words), app }).then(
      (groups) => dispatch({ type: "groupLoaded", generation, app, group: groups.find((group) => group.app === app) ?? null }),
      (error: unknown) => {
        if (isCanceled(error)) return;
        // 404 APP_NOT_FOUND: switched off since; its section goes.
        dispatch({ type: "groupLoaded", generation, app, group: statusOf(error) === 404 ? null : { app, error: "failed" } });
      },
    );
  }, [baseParams, request]);

  /** Search every group again, after the whole request failed. */
  const retryAll = useCallback(() => bump(), []);

  /** One group's next page; false when it failed (the rows on screen stay). */
  const loadMore = useCallback(async (app: WebSearchApp): Promise<boolean> => {
    const { generation, q: words, groups } = stateRef.current;
    const current = groups.find((group) => group.app === app);
    if (!words || current?.status !== "ok" || current.paging || !current.group.nextCursor) return true;
    dispatch({ type: "paging", generation, app, paging: true });
    try {
      const page = (await request({ ...baseParams(words), app, cursor: current.group.nextCursor })).find((group) => group.app === app);
      if (page && "items" in page) dispatch({ type: "paged", generation, app, page });
      else dispatch({ type: "paging", generation, app, paging: false });
      return true;
    } catch (error) {
      if (isCanceled(error)) return true;
      dispatch({ type: "paging", generation, app, paging: false });
      return generation !== generationRef.current;
    }
  }, [baseParams, request]);

  /** Pull to refresh: the same words again; the groups on screen stay until the answer replaces them. */
  const refresh = useCallback(async () => {
    const { generation, q: words } = stateRef.current;
    if (!words) return;
    try {
      const groups = await request(baseParams(words));
      dispatch({ type: "loaded", generation, groups });
    } catch {
      // The groups on screen stay; the message search's refresh says it failed.
    }
  }, [baseParams, request]);

  return { state, retryGroup, retryAll, loadMore, refresh };
}
