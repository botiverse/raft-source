import { create } from "zustand";
import type { RailMode } from "../hooks/useSidebarTab";

// The phone's tabs (chat / activity / tasks / search — the bar reads
// Home / Activity / Tasks / Search, then the server tab; Search became a tab
// on 2026-10-21, design lead) and which URLs belong to which.
//
// A tab tap always lands on that tab's root (stdrc 2026-05-09: pushed pages
// hide the bar, so reopening one would leave no way back to the root), as the
// user left it: its filters come back (`roots` below) and so does its scroll
// position (hooks/useTabRootScroll). Tapping the selected tab scrolls its
// root to the top (Activity: its next unread item) and changes nothing else.
// Back follows the browser history (useMobileBack), not anything kept here.
//
// The last slot is the server tab (Raft DS › Navigation › "The server tab on a
// phone", stdrc 2026-10-22): the current server, which opens a popover, not a
// page, and is never selected. It took the place of More. The server's own
// pages, Members, Computers and Settings (and everything under them), open
// from that popover as pushed pages with Back, so they belong to no tab
// (`mobileTabForPath` returns null). The old /more link redirects to Home.
// Search is a tab (design lead 2026-10-21, "like Slack"): /search is its
// root, with no Back and the bar showing Search selected. A result opened from
// it is a pushed page with a Back that returns to the results.
//
// URL paths are shared with desktop — only navigation BEHAVIOR is
// phone-specific. Nothing here survives a reload.

export type MobileTabId = "chat" | "activity" | "tasks" | "search";

export const MOBILE_TAB_IDS: readonly MobileTabId[] = ["chat", "activity", "tasks", "search"];

/** Which mobile tab does this desktop rail mode belong to?
 *  - artifacts / members / computers / apps / settings → none: the server's own
 *    pages, opened from the server tab's popover as pushed pages
 *  - search    → mobile "search" tab
 *  - assistant → mobile "chat" tab (a Home row on a phone)
 */
export function railModeToMobileTab(mode: RailMode): MobileTabId | null {
  // The assistant is a Home row on a phone, not a tab.
  if (mode === "assistant") return "chat";
  if (mode === "artifacts" || mode === "members" || mode === "computers" || mode === "apps" || mode === "settings") return null;
  return mode;
}

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The phone tab a pathname belongs to; null for the server's own pages,
 *  which the server tab's popover opens and no tab holds. */
export function mobileTabForPath(pathname: string, pathBase: string): MobileTabId | null {
  const path = pathname.replace(/\/+$/, "");
  if (isUnder(path, `${pathBase}/search`)) return "search";
  if (isUnder(path, `${pathBase}/activity`) || isUnder(path, `${pathBase}/inbox`)) return "activity";
  if (isUnder(path, `${pathBase}/tasks`)) return "tasks";
  if (
    isUnder(path, `${pathBase}/artifacts`)
    || isUnder(path, `${pathBase}/members`)
    || path.startsWith(`${pathBase}/agent/`)
    || path.startsWith(`${pathBase}/human/`)
    || isUnder(path, `${pathBase}/computers`)
    || path.startsWith(`${pathBase}/computer/`)
    || path.startsWith(`${pathBase}/machine/`)
    || isUnder(path, `${pathBase}/apps`)
    || isUnder(path, `${pathBase}/settings`)
    || path.startsWith(`${pathBase}/release-notes`)
    || path.startsWith(`${pathBase}/keyboard-shortcuts`)
    || path === `${pathBase}/raftbench`
  ) return null;
  return "chat";
}


const TAB_HOME_BY_MOBILE_TAB: Record<MobileTabId, (pathBase: string) => string> = {
  chat: (base) => base,
  activity: (base) => `${base}/activity`,
  tasks: (base) => `${base}/tasks`,
  // Bare /search: MessageSearchPage restores the last query and filters
  // (raft:search-state) and the cached results, so coming back to the tab
  // resumes the search the user left.
  search: (base) => `${base}/search`,
};

export function tabHomeFor(mode: MobileTabId, pathBase: string): string {
  return TAB_HOME_BY_MOBILE_TAB[mode](pathBase);
}

// Query params that open something over a page (a thread, a profile, a task
// sheet, a picked search result) rather than describe the page itself. A tab
// root remembered without them is the root as the user left it, with its
// filters, and never a pushed page.
const OVERLAY_QUERY_PARAMS = ["thread", "profile", "task", "legacyTask", "agentTab", "open"] as const;

/** Strip overlay params from a "pathname?search" string. */
function stripOverlayParams(pathAndSearch: string): string {
  const qIndex = pathAndSearch.indexOf("?");
  if (qIndex < 0) return pathAndSearch;
  const pathname = pathAndSearch.slice(0, qIndex);
  const params = new URLSearchParams(pathAndSearch.slice(qIndex + 1));
  for (const key of OVERLAY_QUERY_PARAMS) params.delete(key);
  const remaining = params.toString();
  return remaining ? `${pathname}?${remaining}` : pathname;
}

interface MobileNavState {
  // Each tab root as the user last left it ("pathname?search"), so a tab tap
  // brings back its filters (e.g. Tasks' channel / creator / assignee
  // filters, which live in the URL). Only roots are recorded: a tab never
  // reopens on a pushed page.
  roots: Partial<Record<MobileTabId, string>>;
  rememberRoot: (mode: MobileTabId, pathAndSearch: string) => void;
  // Set when the server tab's popover opens one of the server's pages
  // (Members, Computers, Settings): the tab bar is gone while that pushed page
  // is up, and the server tab takes focus back when it returns (Raft DS ›
  // Navigation), so a keyboard or a screen reader picks up where it left off.
  // The request is tied to the history entry the popover was opened on
  // (react-router's location key): only Back to that entry brings focus back.
  // Reaching a tab bar any other way (a DM, then a channel link, then Home)
  // drops it, so the server tab never grabs focus out of nowhere.
  serverTabFocusFor: string | null;
  requestServerTabFocus: (locationKey: string) => void;
  /** Whether the tab bar now showing is the entry focus should return to; clears the request either way. */
  consumeServerTabFocus: (locationKey: string) => boolean;
  reset: () => void;
}

export const useMobileNavStore = create<MobileNavState>((set, get) => ({
  roots: {},
  rememberRoot: (mode, pathAndSearch) => {
    const root = stripOverlayParams(pathAndSearch);
    set((state) => (state.roots[mode] === root ? {} : { roots: { ...state.roots, [mode]: root } }));
  },
  serverTabFocusFor: null,
  requestServerTabFocus: (locationKey) => set({ serverTabFocusFor: locationKey }),
  consumeServerTabFocus: (locationKey) => {
    const pending = get().serverTabFocusFor;
    if (pending === null) return false;
    set({ serverTabFocusFor: null });
    return pending === locationKey;
  },
  // Another server has other roots, and its bar has no page to come back from.
  reset: () => set({ roots: {}, serverTabFocusFor: null }),
}));
