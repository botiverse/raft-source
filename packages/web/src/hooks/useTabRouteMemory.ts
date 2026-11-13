import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { isSettingsApplicationsSlug } from "../components/settings/settingsNavigation";
import { useServerStore } from "../store/serverStore";
import type { RailMode } from "./useSidebarTab";
import { SERVER_SURFACE_STORAGE_PREFIX, TAB_MEMORY_STORAGE_PREFIX } from "./tabRouteMemoryKeys";

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
  if (rest === "/drafts" || rest.startsWith("/drafts/")) return "chat";
  // /search is its own rail mode (task #311). It is intentionally NOT
  // memorized — selectRailMode("search") always lands on a fresh /search,
  // and we must NOT classify it as "chat" or visiting Search would clobber
  // the chat memory and trap the user (clicking Chat → reads "/search" back
  // out of chat memory and bounces them right back to Search).
  if (rest === "/search" || rest.startsWith("/search/")) return null;
  if (rest.startsWith("/agent/")) return "members";
  if (rest.startsWith("/human/")) return "members";
  if (rest === "/members" || rest.startsWith("/members/")) return "members";
  if (rest.startsWith("/computer/")) return "computers";
  if (rest.startsWith("/machine/")) return "computers"; // legacy
  if (rest === "/computers" || rest.startsWith("/computers/")) return "computers";
  if (rest === "/apps" || rest.startsWith("/apps/")) return "apps";
  if (rest === "/settings" || rest.startsWith("/settings/")) return "settings";
  if (rest === "/release-notes" || rest.startsWith("/release-notes/")) return "settings";
  if (rest === "/keyboard-shortcuts") return "settings";
  return null;
}

// Bumped to v2 when rail mode moved to path-only routing (members and
// computers split, /machine/<id> → /computer/<id>). Old v1 entries could
// have stored /machine/<id> under the "members" bucket, which would now
// route the user to Computers when they click Members — invalidate them.
const STORAGE_PREFIX = TAB_MEMORY_STORAGE_PREFIX;
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
  if (rest === "/drafts" || rest.startsWith("/drafts/")) return true;
  if (rest === "/search" || rest.startsWith("/search/")) return true;
  if (rest.startsWith("/agent/")) return true;
  if (rest.startsWith("/human/")) return true;
  if (rest === "/members" || rest.startsWith("/members/")) return true;
  if (rest.startsWith("/computer/")) return true;
  if (rest.startsWith("/machine/")) return true; // legacy
  if (rest === "/computers" || rest.startsWith("/computers/")) return true;
  if (rest === "/apps" || rest.startsWith("/apps/")) return true;
  if (rest === "/settings" || rest.startsWith("/settings/")) return true;
  if (rest === "/release-notes" || rest.startsWith("/release-notes/")) return true;
  if (rest === "/keyboard-shortcuts") return true;
  return false;
}

export function normalizeServerSurfaceMemory(serverSlug: string, pathAndSearch: string): string | null {
  const parts = splitPathAndSearch(pathAndSearch);
  if (!parts) return null;
  const pathBase = `/s/${serverSlug}`;
  if (!isServerSurfaceRoute(parts.pathname, pathBase)) return null;
  return `${parts.pathname}${parts.suffix}`;
}

// The viewer's own assistant's DM: its route redirects to the assistant page
// (MainLayout's DmRoute), so it is no chat place. Remembered as one, every
// click on Chat landed on the assistant page instead.
function isOwnAssistantDmRoute(pathname: string, pathBase: string, assistantDmId: string | null): boolean {
  if (!assistantDmId) return false;
  const dmPath = `${pathBase}/dm/${assistantDmId}`;
  return pathname === dmPath || pathname === `${dmPath}/`;
}

// Settings' Applications page (or an old alias of it) redirects to the server's
// Apps page (MainLayout's SettingsRoute), so it is no Settings place. Remembered
// as one, every click on Settings landed on Apps and Settings couldn't be
// reached. A guest's Applications is a real page, but a guest's Settings simply
// opens on its first page.
function isSettingsApplicationsRoute(pathname: string, pathBase: string): boolean {
  const [, section, slug] = pathname.slice(pathBase.length).split("/");
  return section === "settings" && isSettingsApplicationsSlug(slug);
}

export function readTabMemory(
  serverSlug: string,
  mode: RailMode,
  { assistantDmId = null }: { assistantDmId?: string | null } = {},
): string | null {
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
    // Saved before the assistant was known (or before this was left out of
    // the memory): dropped as it is read.
    if (isOwnAssistantDmRoute(pathOnly, pathBase, assistantDmId) || isSettingsApplicationsRoute(pathOnly, pathBase)) {
      localStorage.removeItem(memoryKey(serverSlug, mode));
      return null;
    }
    return withoutStoredDialogParams(raw, mode);
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
    const tab = classifyRouteForTab(splitPathAndSearch(normalized)?.pathname ?? normalized, `/s/${serverSlug}`);
    return withoutStoredDialogParams(normalized, tab);
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

// A dialog over the page opens only from a click or a link someone followed,
// never from a rail tab or a server switch coming back to the page: the task
// dialog (`task=`, a modal wherever it is), and the legacy task panel
// (`legacyTask=`), a modal on the Tasks page. Remembered with them, leaving
// the page from inside the dialog (a link in it) left the dialog to pop up
// again on every return, though it had been closed.
function withoutDialogParams(search: string, tab: RailMode | null): string {
  const dialogKeys = tab === "tasks" ? ["task", "legacyTask"] : ["task"];
  // Filtered as written, so the params kept keep their encoding (URLSearchParams would re-encode `:`).
  const kept = search.replace(/^\?/, "").split("&")
    .filter((part) => part !== "" && !dialogKeys.includes(part.split("=", 1)[0] ?? ""));
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

// A place saved before dialogs were left out of it (withoutDialogParams) is
// cleaned as it is read, so it doesn't pop the dialog once more.
function withoutStoredDialogParams(pathAndSearch: string, tab: RailMode | null): string {
  const parts = splitPathAndSearch(pathAndSearch);
  if (!parts) return pathAndSearch;
  const hashIndex = parts.suffix.indexOf("#");
  const search = hashIndex === -1 ? parts.suffix : parts.suffix.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : parts.suffix.slice(hashIndex);
  return `${parts.pathname}${withoutDialogParams(search, tab)}${hash}`;
}

// Mount once at the top of the layout. Records the current path+search+hash
// under a per-server "last surface" slot and, for rail-tab routes, under the
// per-server/per-tab slot used by LeftRail. `assistantDmId` is the viewer's
// own assistant's DM (useOwnAssistantDmId): undefined while not known yet.
export function useTabRouteMemory(assistantDmId: string | null | undefined): void {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);

  useEffect(() => {
    if (!serverSlug) return;
    const pathBase = `/s/${serverSlug}`;
    // Path is the rail-mode source of truth, so we persist the path verbatim.
    // Right-panel keys (?profile=, ?thread=, ?msg=, ?agentTab=, ?chatTab=)
    // belong to other surfaces; preserving them lets the user return to the
    // exact view they left, including any open profile/thread — but not a
    // dialog (withoutDialogParams).
    const tab = classifyRouteForTab(location.pathname, pathBase);
    const search = withoutDialogParams(location.search ?? "", tab);
    const hash = location.hash ?? "";
    const pathAndSearch = `${location.pathname}${search}${hash}`;
    writeServerSurfaceMemory(serverSlug, pathAndSearch);
    if (!tab) return;
    // The assistant's DM is the assistant page: not Chat's place (the server's
    // last place above keeps it, which is the assistant page too). A DM shown
    // before the assistant is known may be it (DmRoute redirects once it is):
    // written when it is known, on this effect's next run.
    if (assistantDmId === undefined && location.pathname.startsWith(`${pathBase}/dm/`)) return;
    if (isOwnAssistantDmRoute(location.pathname, pathBase, assistantDmId ?? null)) return;
    if (isSettingsApplicationsRoute(location.pathname, pathBase)) return;
    writeTabMemory(serverSlug, tab, pathAndSearch);
  }, [assistantDmId, location.hash, location.pathname, location.search, serverSlug]);
}
