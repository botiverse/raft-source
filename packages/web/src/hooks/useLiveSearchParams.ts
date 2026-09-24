import { useCallback, useRef } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

/**
 * A query-string writer that merges against the browser's URL at event time.
 *
 * React Router's functional `setSearchParams(previous => ...)` looks like a
 * state updater, but `previous` is the `searchParams` captured by that hook's
 * render. Two independently rendered surfaces can therefore race: opening a
 * thread writes `thread=...`, then a still-mounted channel-tab callback writes
 * `chatTab=tasks` from its older snapshot and silently closes the thread.
 *
 * BrowserRouter updates `window.location` synchronously. When this hook is
 * backed by that router, read the document URL immediately before every write
 * and pass a concrete result to React Router. MemoryRouter/SSR callers retain
 * the router snapshot fallback, which keeps component tests and non-browser
 * rendering isolated from the ambient document.
 */
export function useLiveSearchParams(): ReturnType<typeof useSearchParams> {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isBrowserBackedRef = useRef<boolean | null>(null);

  if (isBrowserBackedRef.current === null) {
    isBrowserBackedRef.current = typeof window !== "undefined"
      && window.location.pathname === location.pathname
      && window.location.search === location.search;
  }

  const setLiveSearchParams: typeof setSearchParams = useCallback((nextInit, navigateOptions) => {
    const previous = isBrowserBackedRef.current && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams(location.search);
    const next = typeof nextInit === "function" ? nextInit(previous) : nextInit;

    // Pass a concrete value. Passing the updater through would make React
    // Router evaluate it against the same stale render snapshot again.
    setSearchParams(next, navigateOptions);
  }, [location.search, setSearchParams]);

  return [searchParams, setLiveSearchParams];
}
