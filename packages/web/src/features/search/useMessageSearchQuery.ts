import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ServerPlan } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { Location, SetURLSearchParams } from "react-router-dom";
import api from "../../api/client";
import { showToast } from "../../components/toastBridge";
import { getCommittedSearchQuery } from "./searchComposition";
import { PAGE_SIZE } from "./searchConstants";
import { classifySearchFailure, searchFailureTitleId } from "./searchFailure";
import type { SearchFailureKind } from "./searchFailure";
import {
  buildTimeRangeParams,
  getEffectiveMessageSearchSort,
  hasMeaningfulMessageSearchFilter,
} from "./searchGrouping";
import type { SearchScope, SearchSort, SearchTimeRange } from "./searchGrouping";
import { getExclusiveSenderTypeScope } from "./searchLabels";
import type { MessageSearchResult } from "./searchResultTypes";
import { buildSearchRetryReset } from "./searchRetry";
import {
  cachedSearchSnapshots,
  NO_SEARCH_CONTINUATION,
  readSearchContinuation,
  readSearchSnapshotForServer,
  serializeSearchParams,
} from "./searchSnapshot";
import type { SearchContinuation } from "./searchSnapshot";

/**
 * The message search: the committed query written to the URL, the debounced
 * first-page loader (seeded from and kept in the module-level snapshot), the
 * next page / continuation, pull-to-refresh and retry.
 */
export function useMessageSearchQuery({
  query,
  isComposing,
  queryParam,
  location,
  setSearchParams,
  skipNextSearchStateRestoreRef,
  senderIdParam,
  channelIdParam,
  channelFilterParam,
  timeRange,
  scopes,
  scopeSet,
  sort,
  deferUntilQuery,
  searchSurface,
  serverId,
  serverPlan,
  refreshAppSearch,
  formatMessage,
}: {
  query: string;
  isComposing: boolean;
  queryParam: string;
  location: Location;
  setSearchParams: SetURLSearchParams;
  skipNextSearchStateRestoreRef: RefObject<boolean>;
  senderIdParam: string;
  channelIdParam: string;
  channelFilterParam: string;
  timeRange: SearchTimeRange;
  scopes: SearchScope[];
  scopeSet: Set<SearchScope>;
  sort: SearchSort;
  deferUntilQuery: boolean;
  searchSurface: string;
  serverId: string | undefined;
  serverPlan: ServerPlan;
  refreshAppSearch: () => unknown;
  formatMessage: IntlShape["formatMessage"];
}) {
  // Seed results/hasMore from the module-level snapshot so a remount caused by
  // the col-2↔col-3 swap on slot-open re-renders the previous list instantly
  // instead of flashing through "no results" while the debounced re-fetch lands.
  const [results, setResults] = useState<MessageSearchResult[]>(() => readSearchSnapshotForServer(serverId, searchSurface)?.results ?? []);
  const [resultsSearchQuery, setResultsSearchQuery] = useState<string>(() => readSearchSnapshotForServer(serverId, searchSurface)?.query ?? "");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState<boolean>(() => readSearchSnapshotForServer(serverId, searchSurface)?.hasMore ?? false);
  const [continuation, setContinuation] = useState<SearchContinuation>(
    () => readSearchSnapshotForServer(serverId, searchSurface)?.continuation ?? NO_SEARCH_CONTINUATION,
  );
  const [searchError, setSearchError] = useState<SearchFailureKind | null>(null);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);
  const lastUrlWriteRef = useRef<string | null>(null);

  // Track the last `q` value Effect A (URL writer below) wrote, so this
  // effect can distinguish "URL changed because Effect A just wrote it"
  // from "URL changed externally (rail Search click, deep link, back/forward)".
  // Without this, Effect A and the URL→input adopt effect form a SYMMETRIC
  // ping-pong on rail Search re-click: Effect A re-asserts `?q=googl` from
  // the still-stale `query` state, the next render flips, and they oscillate
  // 400+/s until something interrupts (#393, see SearchPageRailFlicker spec).
  // External URL change: q in the URL is not what Effect A last wrote. Adopt
  // the URL (it's a fresh navigation source — rail Search click, deep link,
  // back/forward), and DON'T let Effect A re-write the old `query` state on
  // top. The own-write loopback case (queryParam === lastUrlWriteRef) is a
  // no-op — Effect A already advanced the ref when it wrote.
  const isExternalUrlChange = lastUrlWriteRef.current !== null && lastUrlWriteRef.current !== queryParam;

  // oxlint-disable-next-line react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    const trimmed = getCommittedSearchQuery(query, isComposing);
    if (trimmed === null && isComposing) return;
    if (trimmed === queryParam) {
      // URL already matches; just sync our written-value ref so a future
      // external URL change is detectable.
      lastUrlWriteRef.current = queryParam;
      return;
    }
    if (isExternalUrlChange) {
      // External nav (rail Search click, deep link, back/forward) just changed
      // the URL. The URL→input effect above will adopt it; we must NOT clobber
      // the URL with our stale `query` state, or the two effects ping-pong
      // (#393). Sync the ref to the new external value so subsequent
      // user-typed query writes land cleanly.
      lastUrlWriteRef.current = queryParam;
      return;
    }
    // Functional updater + no `searchParams` dep: the bare-object form plus
    // `searchParams` in deps made this effect re-fire on its own URL write,
    // forming a flicker loop with the `initialQuery → setQuery` effect (search
    // button re-click). Per the URL-query single-writer contract (CLAUDE.md),
    // read the latest params from `prev` and never depend on `searchParams`.
    const writtenValue = trimmed ?? "";
    lastUrlWriteRef.current = writtenValue;
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (trimmed) {
        next.set("q", trimmed);
      } else {
        next.delete("q");
      }
      return next;
    }, { replace: true, state: location.state });
  }, [isComposing, isExternalUrlChange, location.state, query, queryParam, setSearchParams, skipNextSearchStateRestoreRef]);

  const buildMessageSearchParams = useCallback((offset: number) => {
    const trimmed = getCommittedSearchQuery(query, isComposing);
    if (trimmed === null) return null;
    const hasFilters = hasMeaningfulMessageSearchFilter({
      senderId: senderIdParam,
      channelId: channelFilterParam,
      timeRange,
      scopes,
    });
    if (!trimmed && (!hasFilters || deferUntilQuery)) return null;

    const params: Record<string, string | number> = {
      q: trimmed,
      limit: PAGE_SIZE,
      offset,
    };
    const requestSort = getEffectiveMessageSearchSort(trimmed, sort);
    if (trimmed && requestSort === "recent") {
      params.sort = sort;
    }

    if (senderIdParam) {
      params.senderId = senderIdParam;
    }

    if (scopeSet.has("mentioned")) {
      params.mentionTarget = "self";
    }
    const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(scopes);
    if (exclusiveSenderTypeScope === "user") {
      params.senderType = "user";
    } else if (exclusiveSenderTypeScope === "agent") {
      params.senderType = "agent";
    }

    if (channelIdParam) {
      params.channelId = channelIdParam;
    }

    const timeRangeParams = buildTimeRangeParams(timeRange);
    if (timeRangeParams.after) params.after = timeRangeParams.after;
    if (timeRangeParams.before) params.before = timeRangeParams.before;

    return params;
  }, [channelFilterParam, channelIdParam, deferUntilQuery, isComposing, query, scopeSet, scopes, senderIdParam, sort, timeRange]);

  // The first page of a search, from the loader below or a pull to refresh:
  // shown, and kept for a remount with the same params.
  const showFirstSearchPage = useCallback((
    params: Record<string, string | number>,
    paramsKey: string,
    snapshotServerId: string | null,
    data: { results?: unknown; hasMore?: unknown; nextCursor?: unknown; incomplete?: unknown; searchedThrough?: unknown; relaxedSkipped?: unknown; relevanceFallback?: unknown },
  ) => {
    const nextResults = Array.isArray(data.results) ? data.results as MessageSearchResult[] : [];
    const nextHasMore = Boolean(data.hasMore);
    const nextContinuation = readSearchContinuation(data);
    setResults(nextResults);
    setResultsSearchQuery(typeof params.q === "string" ? params.q : "");
    setHasMore(nextHasMore);
    setContinuation(nextContinuation);
    cachedSearchSnapshots.set(searchSurface, {
      serverId: snapshotServerId,
      paramsKey,
      query: typeof params.q === "string" ? params.q : "",
      results: nextResults,
      hasMore: nextHasMore,
      continuation: nextContinuation,
    });
  }, [searchSurface]);

  // Counts the first pages shown (the loader's runs, a pull to refresh), so a
  // refresh or a next page that lands after the list was replaced is dropped.
  const searchRunRef = useRef(0);

  // Async search-loader. Reset on params change + fetch + arrival commit.
  // Same async-loader FP family.
  // Moved verbatim out of MessageSearchPage, where its inputs were page state
  // rather than hook arguments; the same async loader as before.
  /* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- async loader: reset on params change + fetch + arrival commit, not state mirrored from a prop. */
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    searchRunRef.current += 1;
    const params = buildMessageSearchParams(0);
    if (!params) {
      setResults([]);
      setResultsSearchQuery("");
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      setContinuation(NO_SEARCH_CONTINUATION);
      setSearchError(null);
      setLoadMoreError(false);
      cachedSearchSnapshots.delete(searchSurface);
      return;
    }

    // If a remount lands with the same params we already have cached, the
    // initial state seeded from the snapshot is already what we'd refetch —
    // skip the network round-trip (and the loading flash) entirely.
    // The plan is part of the key: an upgrade widens what the same search
    // returns, so it searches again instead of keeping the 30-day answer.
    const paramsKey = `${serializeSearchParams(params, timeRange)}|plan=${serverPlan}`;
    const snapshotServerId = serverId ?? null;
    if (readSearchSnapshotForServer(snapshotServerId, searchSurface)?.paramsKey === paramsKey) {
      setSearchError(null);
      setLoadMoreError(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLoadingMore(false);
      setSearchError(null);
      setLoadMoreError(false);
      try {
        const { data } = await api.get("/messages/search", { params, signal: controller.signal });
        if (!cancelled) showFirstSearchPage(params, paramsKey, snapshotServerId, data);
      } catch (error: any) {
        if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError") {
          return;
        }
        if (!cancelled) {
          setHasMore(false);
          setContinuation(NO_SEARCH_CONTINUATION);
          setSearchError(classifySearchFailure(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [buildMessageSearchParams, searchNonce, searchSurface, serverId, serverPlan, showFirstSearchPage, timeRange]);
  /* oxlint-enable react-doctor/no-adjust-state-on-prop-change */

  const loadMoreResults = useCallback(async () => {
    if (loadingMore) return;
    // A cursor continues exactly below what was shown; an offset would restart
    // the server's scan from the newest message.
    const base = buildMessageSearchParams(continuation.nextCursor ? 0 : results.length);
    if (!base) return;
    let params: Record<string, string | number> = base;
    if (continuation.nextCursor) {
      const { offset: _offset, ...rest } = base;
      params = { ...rest, cursor: continuation.nextCursor };
    }
    setLoadingMore(true);
    setLoadMoreError(false);
    const run = searchRunRef.current;
    try {
      const { data } = await api.get("/messages/search", { params });
      if (run !== searchRunRef.current) return;
      const nextResults = Array.isArray(data.results) ? data.results as MessageSearchResult[] : [];
      setResults((prev) => [...prev, ...nextResults]);
      setHasMore(Boolean(data.hasMore));
      // The server marks every cursor page of a fallen-back search
      // (relevanceFallback), so the note follows the latest page.
      setContinuation(readSearchContinuation(data));
    } catch {
      // Preserve both the current page and the continuation state so the failed
      // page is visibly retryable instead of looking like the end of results.
      if (run === searchRunRef.current) setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [buildMessageSearchParams, continuation.nextCursor, loadingMore, results.length]);

  // Pull to refresh on a phone once a search is showing (Raft DS › Navigation
  // › Refreshing): the same search again, whose first page replaces the list
  // when it arrives. A failure keeps the results on screen and says so in a
  // toast with the failed search's own title.
  const refreshSearchResults = useCallback(async () => {
    // The app groups refresh beside the messages, each replacing its own.
    void refreshAppSearch();
    const params = buildMessageSearchParams(0);
    if (!params) return;
    const run = searchRunRef.current;
    const paramsKey = `${serializeSearchParams(params, timeRange)}|plan=${serverPlan}`;
    try {
      const { data } = await api.get("/messages/search", { params });
      if (run !== searchRunRef.current) return;
      searchRunRef.current += 1;
      showFirstSearchPage(params, paramsKey, serverId ?? null, data);
      setSearchError(null);
      setLoadMoreError(false);
    } catch (error) {
      if (run !== searchRunRef.current) return;
      showToast({ title: formatMessage({ id: searchFailureTitleId(classifySearchFailure(error)) }), type: "warning" });
    }
  }, [buildMessageSearchParams, formatMessage, refreshAppSearch, serverId, serverPlan, showFirstSearchPage, timeRange]);

  const retrySearch = useCallback(() => {
    // Retry must clear the last crashing result set before the debounced fetch starts,
    // otherwise the boundary can immediately trip again on the same data.
    // The module-level cache must be dropped too, otherwise the same-params
    // short-circuit in the fetch effect would skip the refetch we want here.
    cachedSearchSnapshots.delete(searchSurface);
    const reset = buildSearchRetryReset();
    setResults(reset.results);
    setResultsSearchQuery("");
    setLoading(reset.loading);
    setLoadingMore(reset.loadingMore);
    setHasMore(reset.hasMore);
    setContinuation(NO_SEARCH_CONTINUATION);
    setSearchError(reset.searchError);
    setLoadMoreError(false);
    setSearchNonce((prev) => prev + 1);
  }, [searchSurface]);

  return {
    results,
    resultsSearchQuery,
    loading,
    loadingMore,
    hasMore,
    continuation,
    searchError,
    loadMoreError,
    searchNonce,
    loadMoreResults,
    refreshSearchResults,
    retrySearch,
  };
}
