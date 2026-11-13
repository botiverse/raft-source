import type { SearchTimeRange } from "./searchGrouping";
import type { MessageSearchResult } from "./searchResultTypes";

// Module-level snapshot of the last successful search result set. MainLayout
// remounts MessageSearchPage when /search transitions from single-page (col-3
// host, slot=null) to master/detail (col-2 host, slot=open) — they are
// different positions in the tree, so React drops local state. Without this
// cache the new mount renders an empty list, fires a 200ms-debounced re-fetch,
// and only refills after the RTT — read as a flash + jump (stdrc msg=4b24a914
// 2026-05-28 "还是会闪"). Re-keying on the exact params (q + filters + sort)
// means the cache only short-circuits when the next mount asks for the same
// query; any different query falls through to the normal fetch path.
//
// The snapshot is also keyed by the server it was fetched from. MainLayout is
// keyed by server id, so a server switch remounts this page — but the module
// variable survives. Without the server key, re-opening search with the same
// query on another server would seed and short-circuit on the previous
// server's results; clicking one of those hits then resolves its ids against
// the *current* server's X-Server-Id and 404s (task #14: a thread hit opened
// an empty "No replies yet" panel).
export interface SearchResultsSnapshot {
  serverId: string | null;
  paramsKey: string;
  query: string;
  results: MessageSearchResult[];
  hasMore: boolean;
  continuation: SearchContinuation;
}

/**
 * Recent-sort text search can stop at the server's scan budget before a page
 * fills (`incomplete`): the results so far are not all the matches, and the
 * search continues from `nextCursor`. The cursor also pages a complete page.
 */
export interface SearchContinuation {
  nextCursor: string | null;
  incomplete: boolean;
  searchedThrough: string | null;
  /**
   * `relaxedSkipped: "too_broad"`: no message has every word, and the server
   * skipped the any-word search because too many messages have one of them.
   * The empty page then does not mean nothing matches (#14398).
   */
  tooBroad: boolean;
  /**
   * `relevanceFallback: "too_broad"`: a relevance search matched too many
   * messages to rank, so the server answered newest first (#14480). The
   * results are real; they are just not ranked by relevance.
   */
  relevanceFallback: boolean;
}
export const NO_SEARCH_CONTINUATION: SearchContinuation = Object.freeze({ nextCursor: null, incomplete: false, searchedThrough: null, tooBroad: false, relevanceFallback: false });

export function readSearchContinuation(data: { nextCursor?: unknown; incomplete?: unknown; searchedThrough?: unknown; relaxedSkipped?: unknown; relevanceFallback?: unknown }): SearchContinuation {
  const tooBroad = data.relaxedSkipped === "too_broad";
  const relevanceFallback = data.relevanceFallback === "too_broad";
  const nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
  if (!nextCursor) return tooBroad || relevanceFallback ? { ...NO_SEARCH_CONTINUATION, tooBroad, relevanceFallback } : NO_SEARCH_CONTINUATION;
  return {
    nextCursor,
    incomplete: data.incomplete === true,
    searchedThrough: typeof data.searchedThrough === "string" ? data.searchedThrough : null,
    tooBroad,
    relevanceFallback,
  };
}
/** One snapshot per search surface: the Search tab ("") and each
 *  conversation's own search ("channel:<id>", "dm:<id>"), so a search in a
 *  channel never replaces the Search tab's results or scroll position. */
export const cachedSearchSnapshots = new Map<string, SearchResultsSnapshot>();
/** Where the results list was scrolled when the page last unmounted, for the
 *  search it was showing (server + query + filters), per surface. */
export const cachedSearchScrolls = new Map<string, { key: string; top: number }>();
/** The search (server + query) whose server-entity list was expanded
 *  with "Show All", per surface: Back from a result opened from the expanded
 *  list lands on the same full list, so the restored scroll position holds. */
export const expandedEntitySearches = new Map<string, string>();
/** The result a phone user opened last, per surface: the list they come back
 *  to (Back) flashes that row once, so they see where they came from. */
export const lastOpenedResultKeys = new Map<string, string>();

export function readSearchSnapshotForServer(serverId: string | null | undefined, surface: string): SearchResultsSnapshot | null {
  const snapshot = cachedSearchSnapshots.get(surface);
  return snapshot && snapshot.serverId === (serverId ?? null) ? snapshot : null;
}

export function serializeSearchParams(params: Record<string, string | number>, timeRange: SearchTimeRange): string {
  // Stable key — drop `offset` since the cache only covers the first page.
  // A time range filter is keyed by its choice ("7d"), not by the `after` /
  // `before` instants it resolves to: those are read from the clock on every
  // build, so a remount with the same filters would never match its own
  // snapshot and would refetch (and flash) on every return to Search.
  const { offset: _offset, after: _after, before: _before, ...rest } = params;
  if (timeRange !== "any") rest.range = timeRange;
  return Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
}
