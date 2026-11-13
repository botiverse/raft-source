import { useMemo, useState } from "react";
import type { Location } from "react-router-dom";
import {
  hasMeaningfulMessageSearchFilter,
  normalizeSearchScopes,
  normalizeSearchSort,
  normalizeSearchTimeRange,
} from "./searchGrouping";
import type { SearchScope } from "./searchGrouping";
import { applySearchState, readSearchState, searchParamsHaveExplicitState } from "./searchHome";
import type { SearchScopeTarget } from "./searchScope";

/**
 * The search page's committed state, read from the URL (the only source of
 * truth for it): the params as shown on the first frame (a remembered search
 * restored before its URL write lands) and the filters derived from them.
 */
export function useSearchUrlState({
  searchParams,
  serializedSearchParams,
  location,
  scope,
  searchSurface,
  searchEntry,
  searchStateStorageKey,
}: {
  searchParams: URLSearchParams;
  serializedSearchParams: string;
  location: Location;
  scope: SearchScopeTarget | null;
  searchSurface: string;
  searchEntry: string | null;
  searchStateStorageKey: string | null;
}) {
  const [initialSearchRestore] = useState<{
    locationKey: string;
    params: URLSearchParams;
  } | null>(() => {
    const currentParams = new URLSearchParams(serializedSearchParams);
    const snapshot = !searchSurface
      && location.pathname.endsWith("/search")
      && searchStateStorageKey
      && searchEntry !== "rail"
      && !searchParamsHaveExplicitState(currentParams)
      ? readSearchState(
        typeof window === "undefined" ? null : window.localStorage,
        searchStateStorageKey,
      )
      : null;
    const restoredParams = snapshot ? applySearchState(currentParams, snapshot) : null;
    const params = restoredParams?.toString() === serializedSearchParams
      ? null
      : restoredParams;
    return params ? { locationKey: location.key, params } : null;
  });
  // oxlint-disable-next-line react-doctor/no-event-handler -- Immutable lazy initialization provides the first-frame value; no effect or event handler sets this state.
  const visibleSearchParams = initialSearchRestore?.locationKey === location.key
    && !searchParamsHaveExplicitState(searchParams)
    ? initialSearchRestore.params
    : searchParams;

  const initialQuery = visibleSearchParams.get("q") ?? "";
  const senderIdParam = visibleSearchParams.get("senderId") ?? "";
  // A conversation's own search is always in that conversation; it is its
  // scope, not a filter the user set (and not one they can clear).
  const channelIdParam = scope?.id ?? visibleSearchParams.get("channelId") ?? "";
  const channelFilterParam = scope ? "" : channelIdParam;
  const timeRange = normalizeSearchTimeRange(visibleSearchParams.get("range"));
  const scopeParamKey = visibleSearchParams.getAll("scope").join("\0");
  const scopes = useMemo(() => normalizeSearchScopes(scopeParamKey ? scopeParamKey.split("\0") : []), [scopeParamKey]);
  const scopeSet = useMemo(() => new Set<SearchScope>(scopes), [scopes]);
  const sort = normalizeSearchSort(visibleSearchParams.get("sort"));

  const queryParam = visibleSearchParams.get("q") ?? "";
  const deferUntilQuery = visibleSearchParams.get("defer") === "1";
  const hasActiveFilters = hasMeaningfulMessageSearchFilter({
    senderId: senderIdParam,
    channelId: channelFilterParam,
    timeRange,
    scopes,
  });

  return {
    visibleSearchParams,
    initialQuery,
    senderIdParam,
    channelIdParam,
    channelFilterParam,
    timeRange,
    scopes,
    scopeSet,
    sort,
    queryParam,
    deferUntilQuery,
    hasActiveFilters,
  };
}
