import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import {
  useMobileNavStore,
  tabHomeFor,
  railModeToMobileTab,
} from "../store/mobileNavStore";
import type {
  MobileTabId,
} from "../store/mobileNavStore";
import { useRailMode } from "./useSidebarTab";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

// Single hook used by MainLayout to (a) keep the active tab's stack
// hydrated and synced to the current URL, (b) provide `selectTab` for
// the mobile tab bar (restore-stack-top on switch, pop-to-root on tap
// active).
//
// 4-tab mobile model (per @stdrc 2026-04-30 #proj-uiux:c8711d2a):
// Chat / Tasks / Members / Settings. Computers is not a top-level
// mobile tab — its routes live in the Settings stack.
//
// Back-button behavior is NOT driven by this stack — see `useMobileBack`
// in useAppNavigate.ts. History → caller's fallbackPath, no stack pop
// (stdrc msg=3e59ad5d, 2026-05-01, supersedes msg=548eda5f).
//
// Desktop behavior is unchanged — these helpers gate on viewport size
// and become no-ops on >=md screens.
export function useMobileNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  const { railMode } = useRailMode();
  const mobileTab = useMemo<MobileTabId>(() => railModeToMobileTab(railMode), [railMode]);
  const hydrate = useMobileNavStore((s) => s.hydrate);
  const push = useMobileNavStore((s) => s.push);
  const popToRoot = useMobileNavStore((s) => s.popToRoot);

  const lastSyncedPathRef = useRef<string | null>(null);

  const currentPathAndSearch = useMemo(
    () => `${location.pathname}${location.search}`,
    [location.pathname, location.search],
  );

  // Hydrate the active tab on every URL change so that:
  // - First time we land in a tab, [home, current] (or just [home] if at home)
  // - Subsequent in-tab navigations push the new path onto the stack
  //   (skipped when the URL change is itself a stack pop, which calls
  //   navigate with the destination already at the new stack top).
  //
  // NOTE: This stack does NOT drive the back-button behavior. Per
  // @stdrc's ruling in `#proj-uiux:c8711d2a` msg=3e59ad5d (2026-05-01,
  // supersedes msg=548eda5f / msg=49bf9068), mobile back goes through
  // browser history first and falls back directly to the caller's
  // `fallbackPath` — the view-stack is no longer consulted by
  // `useMobileBack` (see useAppNavigate.ts). The stack here remains the
  // source of truth for two things only: (1) tab-switch memory — "when I
  // come back to this tab, resume where I left off", and (2) popToRoot on
  // double-tap of an active tab. So we tolerate a little inflation on
  // browser-back (the top entry can be a path we've already visited)
  // rather than try to detect pops here.
  useEffect(() => {
    if (!serverSlug || !isMobileViewport()) return;
    if (lastSyncedPathRef.current === currentPathAndSearch) return;
    hydrate(mobileTab, pathBase, currentPathAndSearch);
    push(mobileTab, currentPathAndSearch);
    lastSyncedPathRef.current = currentPathAndSearch;
  }, [serverSlug, pathBase, mobileTab, currentPathAndSearch, hydrate, push]);

  // Reset stacks when the active server changes — different /s/<slug>
  // means different home paths and unrelated history.
  useEffect(() => {
    if (!serverSlug) return;
    // Stacks are keyed by tab not by server, so clearing them on slug
    // change keeps the next server's tabs starting fresh.
    useMobileNavStore.getState().reset();
    lastSyncedPathRef.current = null;
  }, [serverSlug]);

  const selectTab = useCallback((mode: MobileTabId) => {
    if (!serverSlug) return;
    const home = tabHomeFor(mode, pathBase);
    // stdrc 2026-05-09 #proj-mobile:b1c622e5 task #11:
    // Every tab tap goes to that tab's root, drops any per-tab sub-page
    // memory. Previous behavior was iOS-style: tap inactive = restore
    // last sub-page top, tap active = pop to root. That broke the
    // "user can always reach tab root" invariant — sub-pages hide the
    // tab bar, so once you'd drilled into tab A and switched away,
    // tapping A again would drop you back into the sub-page with no
    // tab bar; the only escape was browser-back, which would route
    // through the OTHER tab you came from rather than to A's root.
    // Now: tap-to-root for both active and inactive cases. Stack
    // memory is reset for the target tab so the "drilled in" state
    // doesn't reappear on the next tap either. Browser history is
    // left intact (no `replace`) — back button still rewinds through
    // visited surfaces normally.
    popToRoot(mode);
    lastSyncedPathRef.current = home;
    navigate(home);
  }, [serverSlug, pathBase, popToRoot, navigate]);

  return { selectTab, isMobile: isMobileViewport() };
}
