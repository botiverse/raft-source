import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import {
  useMobileNavStore,
  tabHomeFor,
  mobileTabForPath,
} from "../store/mobileNavStore";
import type {
  MobileTabId,
} from "../store/mobileNavStore";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

// Used by the phone tab bar: which tab the URL belongs to, and `selectTab`,
// which lands on a tab's root as the user left it (design lead 2026-10-21:
// each tab root keeps its filters and scroll position; pushed pages are not
// kept). Tapping the selected tab is not a navigation at all: MobileTabBar
// scrolls that root to the top, Activity to its next unread item
// (useTabRootScroll).
//
// Mobile tabs (stdrc / design lead 2026-10-21): Home / Activity / Tasks /
// Search, then the server tab (stdrc 2026-10-22), which opens a popover and
// holds no page. The server's own pages (Members, Computers, Settings) are
// pushed from that popover and belong to no tab: `mobileTab` is null there.
// /search is the Search tab's root.
//
// Back is not driven from here — see `useMobileBack` in useAppNavigate.ts:
// browser history first, then the caller's fallbackPath (stdrc msg=3e59ad5d,
// 2026-05-01).
//
// Desktop is unchanged: nothing is recorded on >=md screens.
export function useMobileNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  const mobileTab = useMemo<MobileTabId | null>(
    () => mobileTabForPath(location.pathname, pathBase),
    [location.pathname, pathBase],
  );
  const rememberRoot = useMobileNavStore((s) => s.rememberRoot);

  // A different server has different roots. Declared first, so a server
  // switch clears the old roots before the new URL is recorded.
  useEffect(() => {
    if (!serverSlug) return;
    useMobileNavStore.getState().reset();
  }, [serverSlug]);

  // Record a tab root, with its query (its filters), each time the URL shows
  // one. Search keeps its own state (raft:search-state), so its tab lands on
  // bare /search and the page restores the rest.
  useEffect(() => {
    if (!serverSlug || !isMobileViewport() || mobileTab === null || mobileTab === "search") return;
    const pathname = location.pathname.replace(/\/+$/, "") || "/";
    if (pathname !== tabHomeFor(mobileTab, pathBase)) return;
    rememberRoot(mobileTab, `${pathname}${location.search}`);
  }, [serverSlug, pathBase, mobileTab, location.pathname, location.search, rememberRoot]);

  const selectTab = useCallback((mode: MobileTabId) => {
    if (!serverSlug) return;
    // stdrc 2026-05-09 #proj-mobile:b1c622e5 task #11: a tab tap lands on
    // the tab's root, never on a pushed page left open in it (pushed pages
    // hide the bar, so that would leave no way back to the root). Browser
    // history is left intact (no `replace`).
    navigate(useMobileNavStore.getState().roots[mode] ?? tabHomeFor(mode, pathBase));
  }, [serverSlug, pathBase, navigate]);

  return { selectTab, mobileTab, isMobile: isMobileViewport() };
}
