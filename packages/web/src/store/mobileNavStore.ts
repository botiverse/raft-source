import { create } from "zustand";

// The phone's tabs (chat / activity / tasks / search — the bar reads
// Home / Activity / Tasks / Search, then the server tab; Search became a tab
// on 2026-10-21, design lead) and which URLs belong to which.
//
// A tab tap always lands on that tab's root (stdrc 2026-05-09: pushed pages
// hide the bar, so reopening one would leave no way back to the root), as the
// user left it: its filters come back (its place, hooks/placeMemory) and so
// does its scroll position (hooks/useTabRootScroll). Tapping the selected tab scrolls its
// root to the top (Activity: its next unread item) and changes nothing else.
// Back follows the browser history (useMobileBack), not anything kept here.
//
// The last slot is the server tab (Raft DS › Navigation › "The server tab on a
// phone", stdrc 2026-10-22): the current server, which opens a popover, not a
// page, and is never selected. It took the place of More. The server's own
// pages, Members, Computers and Settings (and everything under them), open
// from that popover as pushed pages with Back, so they belong to no tab
// (navigation/surfaces.ts `mobileTabForPath` returns null). The old /more link redirects to Home.
// Search is a tab (design lead 2026-10-21, "like Slack"): /search is its
// root, with no Back and the bar showing Search selected. A result opened from
// it is a pushed page with a Back that returns to the results.
//
// URL paths are shared with desktop — only navigation BEHAVIOR is
// phone-specific. Nothing here survives a reload.
//
// Which URL belongs to which tab is the route table's (navigation/surfaces.ts).

export type MobileTabId = "chat" | "activity" | "tasks" | "search";

export const MOBILE_TAB_IDS: readonly MobileTabId[] = ["chat", "activity", "tasks", "search"];

interface MobileNavState {
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
  serverTabFocusFor: null,
  requestServerTabFocus: (locationKey) => set({ serverTabFocusFor: locationKey }),
  consumeServerTabFocus: (locationKey) => {
    const pending = get().serverTabFocusFor;
    if (pending === null) return false;
    set({ serverTabFocusFor: null });
    return pending === locationKey;
  },
  // Another server's bar has no page to come back from.
  reset: () => set({ serverTabFocusFor: null }),
}));
