import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { needsEmbedRepair, withEmbedParams } from "../embed";
import { useLiveSearchParams } from "./useLiveSearchParams";

/**
 * Keeps the embed params in the URL across internal navigations.
 *
 * WHY THIS EXISTS
 * `navigate("/computers/abc")` drops the query string. The embed LATCH survives that
 * (it is module-level), but a WebView cold start / reload / OS kill restores from the
 * URL alone — and the URL would have nothing in it. Nothing errors; the native shell
 * just grows a second header one day. So the latch handles navigation and the URL
 * handles re-entry, and we need both.
 *
 * WHY THE GUARD IS *BEFORE* THE SETTER, NOT INSIDE THE UPDATER (@MingQi)
 * Two facts about `react-router-dom` 7 that together bite:
 *   1. `setSearchParams` calls `navigate("?" + next, options)` UNCONDITIONALLY. A
 *      functional updater that returns `prev` unchanged does NOT skip the write.
 *   2. The setter's identity is rebuilt on every location change (its `useCallback`
 *      deps include `searchParams`), so an effect listing it in deps re-fires after
 *      its own write.
 * Put together, "write, then rely on the updater to no-op" is the #2787 self-trigger
 * loop wearing a disguise: it re-fires and re-writes on every location change,
 * including for users who are not embedded at all.
 *
 * So the decision to write is taken OUTSIDE, by a pure function over the current
 * search string, and the setter is called only when the URL is genuinely missing the
 * params. `needsEmbedRepair` returns false for everyone who is not embedded, so the
 * ordinary app never issues a single extra Router write because of this hook.
 *
 * This is gated by a WRITE-COUNTING test, not by asserting the final URL — the earlier
 * version's final URL was correct while it was redundantly rewriting the history entry
 * on every navigation. A gate that only checks the destination cannot see that.
 */
export function useEmbedParamsKeeper(): void {
  const { search } = useLocation();
  const [, setSearchParams] = useLiveSearchParams();

  // Pure, synchronous, and derived from the CURRENT url — so once the repair lands,
  // this flips to false and the effect's next run (the setter's identity churns, so
  // there will be one) exits without touching the Router.
  const repair = needsEmbedRepair(search);

  useEffect(() => {
    if (!repair) return;
    setSearchParams((prev) => withEmbedParams(prev), { replace: true });
  }, [repair, setSearchParams]);
}
