import { useEffect, useRef } from "react";
import type { Location, SetURLSearchParams } from "react-router-dom";
import {
  applySearchState,
  captureSearchState,
  persistSearchState,
  readSearchState,
  searchParamsHaveExplicitState,
} from "./searchHome";
import type { SearchScopeTarget } from "./searchScope";

/**
 * The Search tab remembers its last search per user+server: an entry with no
 * explicit state restores it into the URL, and every committed URL state is
 * persisted. A conversation's own search does neither.
 *
 * Returns the refs the page's URL writers share with these effects.
 */
export function useSearchStatePersistence({
  scope,
  location,
  searchEntry,
  searchStateStorageKey,
  searchParams,
  serializedSearchParams,
  setSearchParams,
}: {
  scope: SearchScopeTarget | null;
  location: Location;
  searchEntry: string | null;
  searchStateStorageKey: string | null;
  searchParams: URLSearchParams;
  serializedSearchParams: string;
  setSearchParams: SetURLSearchParams;
}) {
  const skipNextSearchStatePersistRef = useRef(false);
  const skipNextSearchStateRestoreRef = useRef(false);
  const selectRestoredQueryRef = useRef(false);

  useEffect(() => {
    if (scope || !location.pathname.endsWith("/search")) return;
    if (skipNextSearchStateRestoreRef.current) {
      skipNextSearchStateRestoreRef.current = false;
      return;
    }
    if (searchEntry === "rail") return;
    const currentParams = new URLSearchParams(serializedSearchParams);
    if (!searchStateStorageKey || searchParamsHaveExplicitState(currentParams)) return;
    const snapshot = readSearchState(
      typeof window === "undefined" ? null : window.localStorage,
      searchStateStorageKey,
    );
    if (!snapshot) return;
    const restoredParams = applySearchState(currentParams, snapshot);
    if (restoredParams.toString() === serializedSearchParams) return;
    selectRestoredQueryRef.current = Boolean(snapshot.q);
    skipNextSearchStatePersistRef.current = true;
    setSearchParams(
      (prev) => applySearchState(prev, snapshot),
      { replace: true, state: location.state },
    );
  }, [location.key, location.pathname, location.state, scope, searchEntry, searchStateStorageKey, serializedSearchParams, setSearchParams]);

  useEffect(() => {
    if (scope || !searchStateStorageKey) return;
    if (skipNextSearchStatePersistRef.current) {
      skipNextSearchStatePersistRef.current = false;
      return;
    }
    persistSearchState(
      typeof window === "undefined" ? null : window.localStorage,
      searchStateStorageKey,
      captureSearchState(searchParams),
    );
  }, [scope, searchStateStorageKey, searchParams, serializedSearchParams]);

  return { skipNextSearchStateRestoreRef, selectRestoredQueryRef };
}
