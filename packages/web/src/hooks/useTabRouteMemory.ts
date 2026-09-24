import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import type { RailMode } from "./useSidebarTab";

// Determines which rail mode a given pathname belongs to. Returns null for
// routes that don't belong to any rail surface (login redirects, etc.) so
// we don't clobber the per-mode memory.
//
// pathBase is the server-scoped prefix (e.g. `/s/dev`). Pass `null` when no
// active server — the function falls through to null in that case.
export function classifyRouteForTab(pathname: string, pathBase: string | null): RailMode | null {
  if (!pathBase) return null;
  if (!pathname.startsWith(pathBase)) return null;
  const rest = pathname.slice(pathBase.length); // "" | "/foo/bar"
  if (rest === "" || rest === "/") return "chat";
  if (rest.startsWith("/channel/")) return "chat";
  if (rest.startsWith("/dm/")) return "chat";
  if (rest === "/threads" || rest.startsWith("/threads/")) return "chat";
  if (rest === "/tasks" || rest.startsWith("/tasks/")) return "tasks";
  if (rest === "/saved" || rest.startsWith("/saved/")) return "chat";
  // /search is its own rail mode (task #311). It is intentionally NOT
  // memorized — selectRailMode("search") always lands on a fresh /search,
  // and we must NOT classify it as "chat" or visiting Search would clobber
  // the chat memory and trap the user (clicking Chat → reads "/search" back
  // out of chat memory and bounces them right back to Search).
  if (rest === "/search" || rest.startsWith("/search/")) return null;
  if (rest === "/wiki" || rest.startsWith("/wiki/")) return "wiki";
  if (rest.startsWith("/agent/")) return "members";
  if (rest.startsWith("/human/")) return "members";
  if (rest === "/members" || rest.startsWith("/members/")) return "members";
  if (rest.startsWith("/computer/")) return "computers";
  if (rest.startsWith("/machine/")) return "computers"; // legacy
  if (rest === "/computers" || rest.startsWith("/computers/")) return "computers";
  if (rest === "/settings" || rest.startsWith("/settings/")) return "settings";
  if (rest === "/release-notes" || rest.startsWith("/release-notes/")) return "settings";
  return null;
}

// Bumped to v2 when rail mode moved to path-only routing (members and
// computers split, /machine/<id> → /computer/<id>). Old v1 entries could
// have stored /machine/<id> under the "members" bucket, which would now
// route the user to Computers when they click Members — invalidate them.
const STORAGE_PREFIX = "slock:tabMemory:v2";
const SERVER_SURFACE_STORAGE_PREFIX = "slock:serverSurface:v1";
function memoryKey(serverSlug: string, mode: RailMode): string {
  return `${STORAGE_PREFIX}:${serverSlug}:${mode}`;
}

function serverSurfaceMemoryKey(serverSlug: string): string {
  return `${SERVER_SURFACE_STORAGE_PREFIX}:${serverSlug}`;
}

function splitPathAndSearch(pathAndSearch: string): { pathname: string; suffix: string } | null {
  if (!pathAndSearch.startsWith("/")) return null;
  const queryIndex = pathAndSearch.indexOf("?");
  const hashIndex = pathAndSearch.indexOf("#");
  const suffixIndex =
    queryIndex === -1 ? hashIndex
      : hashIndex === -1 ? queryIndex
      : Math.min(queryIndex, hashIndex);
  if (suffixIndex === -1) {
    return { pathname: pathAndSearch, suffix: "" };
  }
  return {
    pathname: pathAndSearch.slice(0, suffixIndex),
    suffix: pathAndSearch.slice(suffixIndex),
  };
}

function isServerSurfaceRoute(pathname: string, pathBase: string): boolean {
  if (pathname === pathBase || pathname === `${pathBase}/`) return true;
  if (!pathname.startsWith(`${pathBase}/`)) return false;
  const rest = pathname.slice(pathBase.length);
  if (rest.startsWith("/channel/")) return true;
  if (rest.startsWith("/dm/")) return true;
  if (rest === "/threads" || rest.startsWith("/threads/")) return true;
  if (rest === "/activity" || rest.startsWith("/activity/")) return true;
  if (rest === "/inbox" || rest.startsWith("/inbox/")) return true; // legacy alias
  if (rest === "/tasks" || rest.startsWith("/tasks/")) return true;
  if (rest === "/saved" || rest.startsWith("/saved/")) return true;
  if (rest === "/search" || rest.startsWith("/search/")) return true;
  if (rest === "/wiki" || rest.startsWith("/wiki/")) return true;
  if (rest.startsWith("/agent/")) return true;
  if (rest.startsWith("/human/")) return true;
  if (rest === "/members" || rest.startsWith("/members/")) return true;
  if (rest.startsWith("/computer/")) return true;
  if (rest.startsWith("/machine/")) return true; // legacy
  if (rest === "/computers" || rest.startsWith("/computers/")) return true;
  if (rest === "/settings" || rest.startsWith("/settings/")) return true;
  if (rest === "/release-notes" || rest.startsWith("/release-notes/")) return true;
  return false;
}

export function normalizeServerSurfaceMemory(serverSlug: string, pathAndSearch: string): string | null {
  const parts = splitPathAndSearch(pathAndSearch);
  if (!parts) return null;
  const pathBase = `/s/${serverSlug}`;
  if (!isServerSurfaceRoute(parts.pathname, pathBase)) return null;
  return `${parts.pathname}${parts.suffix}`;
}

export function readTabMemory(serverSlug: string, mode: RailMode): string | null {
  try {
    const raw = localStorage.getItem(memoryKey(serverSlug, mode));
    if (!raw || raw.length === 0) return null;
    // Self-heal: if the stored route no longer belongs to this mode (e.g. a
    // pre-#311 build wrote `/search` into the chat slot), drop it. Without
    // this guard the user would click Chat → read stale /search → bounce
    // straight back to Search, never reaching their last chat surface.
    const pathBase = `/s/${serverSlug}`;
    const pathOnly = splitPathAndSearch(raw)?.pathname ?? raw;
    if (classifyRouteForTab(pathOnly, pathBase) !== mode) return null;
    return raw;
  } catch {
    return null;
  }
}

export function readServerSurfaceMemory(serverSlug: string): string | null {
  try {
    const raw = localStorage.getItem(serverSurfaceMemoryKey(serverSlug));
    if (!raw || raw.length === 0) return null;
    const normalized = normalizeServerSurfaceMemory(serverSlug, raw);
    if (!normalized) {
      localStorage.removeItem(serverSurfaceMemoryKey(serverSlug));
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function writeTabMemory(serverSlug: string, mode: RailMode, pathAndSearch: string): void {
  try {
    localStorage.setItem(memoryKey(serverSlug, mode), pathAndSearch);
  } catch {
    // localStorage may throw in private mode / quota exhaustion — best-effort.
  }
}

function writeServerSurfaceMemory(serverSlug: string, pathAndSearch: string): void {
  try {
    const normalized = normalizeServerSurfaceMemory(serverSlug, pathAndSearch);
    if (!normalized) return;
    localStorage.setItem(serverSurfaceMemoryKey(serverSlug), normalized);
  } catch {
    // localStorage may throw in private mode / quota exhaustion — best-effort.
  }
}

// Mount once at the top of the layout. Records the current path+search+hash
// under a per-server "last surface" slot and, for rail-tab routes, under the
// per-server/per-tab slot used by LeftRail.
export function useTabRouteMemory(): void {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);

  useEffect(() => {
    if (!serverSlug) return;
    const pathBase = `/s/${serverSlug}`;
    // Path is the rail-mode source of truth, so we persist the path verbatim.
    // Right-panel keys (?profile=, ?thread=, ?msg=, ?agentTab=, ?chatTab=)
    // belong to other surfaces; preserving them lets the user return to the
    // exact view they left, including any open profile/thread.
    const search = location.search ?? "";
    const hash = location.hash ?? "";
    const pathAndSearch = `${location.pathname}${search}${hash}`;
    writeServerSurfaceMemory(serverSlug, pathAndSearch);
    const tab = classifyRouteForTab(location.pathname, pathBase);
    if (!tab) return;
    writeTabMemory(serverSlug, tab, pathAndSearch);
  }, [location.hash, location.pathname, location.search, serverSlug]);
}
