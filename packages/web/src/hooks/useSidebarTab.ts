import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useOwnAssistantDmId } from "../assistant/assistantClient";
import { useServerStore } from "../store/serverStore";
import { railModeForPath } from "../navigation/surfaces";
import type { RailMode } from "../navigation/surfaces";
import { placeFor } from "./placeMemory";
import { useLiveLocation } from "./useLiveLocation";
import { resolveSearchOverlayBackground, searchEntryState } from "../features/search/searchOverlayLocation";

// The left navigation rail surfaces a fixed set of modes; the entire left
// column (rail button highlight + sidebar content + sidebar header text)
// derives from a SINGLE value: the URL path, read through the route table
// (navigation/surfaces.ts).
//
// `search` is the only mode that takes over the full main area (no Sidebar
// visible) — same shape as `tasks`. Per stdrc #proj-uiux:c2313b1d task #311
// 2026-05-25: Search entry promoted to the Rail's first button + opens a
// fullscreen search page.
export type { RailMode };

// Back-compat alias for callers that only care about the chat/members
// distinction inside the chat-or-members surface (e.g. existing tests).
export type SidebarTab = "chat" | "members";

/** The Saved page, `/s/<slug>/saved` (or under it). */
export function isSavedPagePath(pathname: string, pathBase: string): boolean {
  return !!pathBase && (pathname === `${pathBase}/saved` || pathname.startsWith(`${pathBase}/saved/`));
}

export function useRailMode() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const guest = useServerStore((s) => s.current?.role === "guest");
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";
  const liveLocation = useLiveLocation();
  const assistantDmId = useOwnAssistantDmId();

  // While the ⌘K search overlay floats over a page, the URL is /search but the
  // page behind it (and its sidebar) is the overlay's background: settings stays
  // settings, members stays members. Deriving from /search here made the
  // sidebar fall back to the Chat channel list behind the overlay.
  const overlayBackgroundPath = resolveSearchOverlayBackground(location)?.pathname ?? null;
  const railMode = useMemo<RailMode>(
    () => railModeForPath(overlayBackgroundPath ?? location.pathname, pathBase),
    [overlayBackgroundPath, location.pathname, pathBase],
  );
  // The Saved page is part of the chat mode (a member opens it from the Chat
  // sidebar), but a Guest, who has no sidebar, opens it from its own rail
  // entry, which shows selected here instead of Chat.
  const savedPage = isSavedPagePath(overlayBackgroundPath ?? location.pathname, pathBase);
  // Where the user actually is: `search` while the overlay floats over a page,
  // where railMode names the page behind it. Telemetry reads it to tell a
  // click on the current surface (nav_entry_selected `was_active`).
  const currentMode = useMemo<RailMode>(
    () => railModeForPath(location.pathname, pathBase),
    [location.pathname, pathBase],
  );

  // Every tab lands on its place (placeMemory): the page last left in it,
  // with its own filters and view, never a pane over it; a Guest's Chat and
  // the tabs with nothing remembered land on their home. A list page lands
  // clean even when it is the page you are on; re-selecting Chat on the
  // conversation you are on keeps its address (dropping a `msg` there would
  // reload the channel, and its panes are the conversation's own).
  const selectRailMode = useCallback((mode: RailMode) => {
    if (!serverSlug) {
      navigate("/");
      return;
    }
    const place = placeFor(serverSlug, mode, { guest, assistantDmId: assistantDmId ?? null });
    const live = liveLocation();
    if (mode === "search") {
      navigate(place, {
        // Desktop: the rail entry is the ⌘K overlay too (task #96); web keeps full page.
        // The page at click time, not the rendered one (useLiveLocation).
        state: searchEntryState(live, { searchEntry: "rail" }),
      });
      return;
    }
    const sameConversation = mode === "chat" && place.split("?", 1)[0] === live.pathname;
    navigate(sameConversation ? `${live.pathname}${live.search}` : place);
  }, [assistantDmId, guest, liveLocation, serverSlug, navigate]);

  return { railMode, currentMode, selectRailMode, savedPage };
}

// Back-compat shim for callers that only need chat-vs-members. New code
// should use useRailMode directly.
export function useSidebarTab() {
  const { railMode, selectRailMode } = useRailMode();
  const activeTab: SidebarTab = railMode === "members" ? "members" : "chat";
  const selectSidebarTab = useCallback(
    (tab: SidebarTab) => selectRailMode(tab),
    [selectRailMode],
  );
  return { activeTab, selectSidebarTab };
}
