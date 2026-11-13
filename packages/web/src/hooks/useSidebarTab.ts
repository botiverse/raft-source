import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useOwnAssistantDmId } from "../assistant/assistantClient";
import { useServerStore } from "../store/serverStore";
import { readTabMemory } from "./useTabRouteMemory";
import { useLiveLocation } from "./useLiveLocation";
import { resolveSearchOverlayBackground, searchEntryState } from "../features/search/searchOverlayLocation";

// The left navigation rail surfaces a fixed set of modes; the entire left
// column (rail button highlight + sidebar content + sidebar header text)
// derives from a SINGLE value.
//
// Source of truth: the URL **path**. No query parameter ever expresses rail
// mode — older `?sidebarTab=` and `?tab=` signals are normalized away by
// useRailLegacyRedirect on entry.
//
// `search` is the only mode that takes over the full main area (no Sidebar
// visible) — same shape as `tasks`. Per stdrc #proj-uiux:c2313b1d task #311
// 2026-05-25: Search entry promoted to the Rail's first button + opens a
// fullscreen search page.
export type RailMode = "search" | "activity" | "chat" | "members" | "computers" | "apps" | "tasks" | "settings" | "assistant" | "artifacts";

// Back-compat alias for callers that only care about the chat/members
// distinction inside the chat-or-members surface (e.g. existing tests).
export type SidebarTab = "chat" | "members";

function deriveRailModeFromPath(pathname: string, pathBase: string): RailMode {
  if (!pathBase) return "chat";
  if (pathname === `${pathBase}/search` || pathname.startsWith(`${pathBase}/search/`)) return "search";
  if (pathname === `${pathBase}/activity` || pathname.startsWith(`${pathBase}/activity/`)) return "activity";
  // Legacy /inbox still maps to the activity rail mode so the rail button stays
  // highlighted during the /inbox→/activity redirect tick.
  if (pathname === `${pathBase}/inbox` || pathname.startsWith(`${pathBase}/inbox/`)) return "activity";
  if (pathname.replace(/\/$/, "") === `${pathBase}/raftbench`) return "settings";
  if (pathname.startsWith(`${pathBase}/settings`)) return "settings";
  if (pathname.startsWith(`${pathBase}/release-notes`)) return "settings";
  if (pathname.startsWith(`${pathBase}/keyboard-shortcuts`)) return "settings";
  if (pathname === `${pathBase}/tasks` || pathname.startsWith(`${pathBase}/tasks/`)) return "tasks";
  if (pathname === `${pathBase}/assistant` || pathname.startsWith(`${pathBase}/assistant/`)) return "assistant";
  if (pathname.startsWith(`${pathBase}/computer/`)) return "computers";
  if (pathname.startsWith(`${pathBase}/machine/`)) return "computers"; // legacy
  if (pathname === `${pathBase}/computers` || pathname.startsWith(`${pathBase}/computers/`)) return "computers";
  // The Apps page (#proj-apps task #22): one page, like Tasks.
  if (pathname === `${pathBase}/apps` || pathname.startsWith(`${pathBase}/apps/`)) return "apps";
  // The Artifacts home page (#proj-workspace:#133): one page with its own rail entry.
  if (pathname === `${pathBase}/artifacts` || pathname.startsWith(`${pathBase}/artifacts/`)) return "artifacts";
  if (pathname.startsWith(`${pathBase}/agent/`)) return "members";
  if (pathname.startsWith(`${pathBase}/human/`)) return "members";
  if (pathname === `${pathBase}/members` || pathname.startsWith(`${pathBase}/members/`)) return "members";
  return "chat";
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
    () => deriveRailModeFromPath(overlayBackgroundPath ?? location.pathname, pathBase),
    [overlayBackgroundPath, location.pathname, pathBase],
  );
  // Where the user actually is: `search` while the overlay floats over a page,
  // where railMode names the page behind it. Telemetry reads it to tell a
  // click on the current surface (nav_entry_selected `was_active`).
  const currentMode = useMemo<RailMode>(
    () => deriveRailModeFromPath(location.pathname, pathBase),
    [location.pathname, pathBase],
  );

  const selectRailMode = useCallback((mode: RailMode) => {
    if (!serverSlug) {
      navigate("/");
      return;
    }
    const base = `/s/${serverSlug}`;
    // Search and Activity are intentionally NOT route-memorized — every
    // entry should start at the canonical landing (`/search` with no query;
    // `/activity` showing the current activity list). Other modes restore the
    // last-visited path so server-switch / rail-bounce doesn't clobber
    // where the user was.
    if (mode === "search") {
      navigate(`${base}/search`, {
        // Desktop: the rail entry is the ⌘K overlay too (task #96); web keeps full page.
        // The page at click time, not the rendered one (useLiveLocation).
        state: searchEntryState(liveLocation(), { searchEntry: "rail" }),
      });
      return;
    }
    if (mode === "activity") {
      navigate(`${base}/activity`);
      return;
    }
    // The assistant is one page (its DM, or Create Your Assistant): nothing
    // to remember inside it.
    if (mode === "assistant") {
      navigate(`${base}/assistant`);
      return;
    }
    // Artifacts is one page too: its tabs and filters are the page's own, and an open Artifact isn't a place to come back to.
    if (mode === "artifacts") {
      navigate(`${base}/artifacts`);
      return;
    }
    // Members is one page (raft-design members.md): a profile opens in the
    // side panel over it, and the graph is a page under it, so the rail
    // always lands on the page itself, never a remembered profile or graph.
    if (mode === "members") {
      navigate(`${base}/members`);
      return;
    }
    // A Guest's Chat is its one channel, which the server's root opens: a
    // remembered path (another channel, a DM, from when it was a member, or
    // a channel since archived) would open a conversation it can't read.
    if (mode === "chat" && guest) {
      navigate(base);
      return;
    }
    const remembered = readTabMemory(serverSlug, mode, { assistantDmId: assistantDmId ?? null });
    const fallback = mode === "chat" ? base
      : mode === "computers" ? `${base}/computers`
      : mode === "apps" ? `${base}/apps`
      : mode === "tasks" ? `${base}/tasks`
      : `${base}/settings/account`;
    navigate(remembered ?? fallback);
  }, [assistantDmId, guest, liveLocation, serverSlug, navigate]);

  return { railMode, currentMode, selectRailMode };
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
