import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import { useMobileNavStore } from "../store/mobileNavStore";
import { mobileTabForPath } from "../navigation/surfaces";
import { placeFor } from "./placeMemory";
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
// kept): its place, the same one the desktop rail lands on (placeMemory),
// with Home always on its conversation list. Tapping the selected tab is not a navigation at all: MobileTabBar
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
export function useMobileNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  const mobileTab = useMemo<MobileTabId | null>(
    () => mobileTabForPath(location.pathname, pathBase),
    [location.pathname, pathBase],
  );

  // A different server's bar has no page to come back from.
  useEffect(() => {
    if (!serverSlug) return;
    useMobileNavStore.getState().reset();
  }, [serverSlug]);

  const selectTab = useCallback((mode: MobileTabId) => {
    if (!serverSlug) return;
    // stdrc 2026-05-09 #proj-mobile:b1c622e5 task #11: a tab tap lands on
    // the tab's root, never on a pushed page left open in it (pushed pages
    // hide the bar, so that would leave no way back to the root). Browser
    // history is left intact (no `replace`).
    navigate(placeFor(serverSlug, mode, { phone: true }));
  }, [serverSlug, navigate]);

  return { selectTab, mobileTab, isMobile: isMobileViewport() };
}
