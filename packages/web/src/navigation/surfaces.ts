import { isSettingsApplicationsSlug } from "../components/settings/settingsNavigation";
import type { MobileTabId } from "../store/mobileNavStore";

/**
 * The left rail's entries. The URL **path** alone says which one is selected
 * (no query parameter does; old `?sidebarTab=` / `?tab=` are normalized away by
 * useRailLegacyRedirect).
 */
export type RailMode = "search" | "activity" | "chat" | "members" | "computers" | "apps" | "tasks" | "settings" | "assistant" | "artifacts";

/** What a place is checked against: the viewer's own assistant's DM, which shows the assistant page (MainLayout's DmRoute). */
export interface PlaceContext {
  assistantDmId?: string | null;
}

/**
 * One server page (a route under `/s/<slug>`) and how navigation treats it.
 *
 * - `rail` / `phone`: the rail entry and the phone tab it belongs to (`phone`
 *   null: the server's own pages, which the phone's server tab opens as pushed
 *   pages; no tab holds them).
 * - `memorable`: whether it is a place to come back to (placeMemory: the rail,
 *   a server switch, the phone tab bar and the `/` start). A page that redirects
 *   elsewhere, or is a transient view, is not.
 * - `place`: the page a visit is remembered as, when it is not the address
 *   itself: a single item (`/computer/<id>`, `/agent/<id>`) is a pane of its
 *   list page on a desktop, so its place is the list, on any viewport.
 * - `pageParams`: the query parameters that describe the page itself (its tab,
 *   filters, view), the only ones a place keeps. Everything else (a thread, a
 *   profile, an open result or task, a message to jump to, a dialog) is a pane
 *   or a one-shot intent: panes come back through the conversation's beside
 *   memory (useBesideMemory), never through a place.
 */
interface SurfaceSpec {
  pattern: RegExp;
  rail: RailMode;
  phone: MobileTabId | null;
  memorable: boolean | ((rest: string, context: PlaceContext) => boolean);
  place?: string;
  pageParams?: readonly string[];
}

/** The Tasks page's own state (useTasksPageParams). */
const TASKS_PAGE_PARAMS = ["tab", "sort", "view", "q", "channel", "status", "creator", "assignee"] as const;

// First match wins. `rest` is the path under `/s/<slug>`, without a trailing slash.
const SURFACES: readonly SurfaceSpec[] = [
  { pattern: /^$/, rail: "chat", phone: "chat", memorable: true },
  // A conversation's own search: a transient view of it.
  { pattern: /^\/(?:channel|dm)\/[^/]+\/search$/, rail: "chat", phone: "chat", memorable: false },
  { pattern: /^\/channel\/[^/]+$/, rail: "chat", phone: "chat", memorable: true, pageParams: ["chatTab"] },
  // The viewer's own assistant's DM is the assistant page, no Chat place:
  // remembered as one, every click on Chat landed on the assistant page.
  {
    pattern: /^\/dm\/[^/]+$/, rail: "chat", phone: "chat", pageParams: ["chatTab"],
    memorable: (rest, { assistantDmId }) => !assistantDmId || rest !== `/dm/${assistantDmId}`,
  },
  { pattern: /^\/(?:saved|drafts)$/, rail: "chat", phone: "chat", memorable: true },
  { pattern: /^\/threads(?:\/|$)/, rail: "chat", phone: "chat", memorable: false }, // legacy redirect
  // Search keeps its query and filters itself (raft:search-state): its place is the bare page, never a result.
  { pattern: /^\/search(?:\/|$)/, rail: "search", phone: "search", memorable: true, place: "/search" },
  { pattern: /^\/activity(?:\/|$)/, rail: "activity", phone: "activity", memorable: true, place: "/activity" },
  { pattern: /^\/inbox(?:\/|$)/, rail: "activity", phone: "activity", memorable: false }, // legacy redirect
  { pattern: /^\/tasks(?:\/|$)/, rail: "tasks", phone: "tasks", memorable: true, place: "/tasks", pageParams: TASKS_PAGE_PARAMS },
  // A Home row on a phone, not a tab.
  { pattern: /^\/assistant(?:\/|$)/, rail: "assistant", phone: "chat", memorable: true, place: "/assistant" },
  { pattern: /^\/artifacts(?:\/|$)/, rail: "artifacts", phone: null, memorable: true, place: "/artifacts" },
  { pattern: /^\/apps(?:\/|$)/, rail: "apps", phone: null, memorable: true, place: "/apps" },
  { pattern: /^\/(?:members(?:\/|$)|agent\/|human\/)/, rail: "members", phone: null, memorable: true, place: "/members" },
  { pattern: /^\/computers\/this-device$/, rail: "computers", phone: null, memorable: true },
  { pattern: /^\/(?:computers(?:\/|$)|computer\/|machine\/)/, rail: "computers", phone: null, memorable: true, place: "/computers", pageParams: ["filter"] },
  // Settings › Applications (or an old alias) redirects to Apps, and Delete
  // Account is no page to come back to (a cancelled deletion left it stuck loading).
  {
    pattern: /^\/settings(?:\/|$)/, rail: "settings", phone: null,
    memorable: (rest) => !isSettingsApplicationsSlug(rest.split("/")[2]) && !/^\/settings\/account\/delete(?:\/|$)/.test(rest),
  },
  { pattern: /^\/(?:release-notes|keyboard-shortcuts)$/, rail: "settings", phone: null, memorable: true },
  { pattern: /^\/raftbench$/, rail: "settings", phone: null, memorable: false },
];

// Anything else (migrations, legacy redirects, an unknown path): Chat's, and no place.
const FALLBACK_SURFACE: SurfaceSpec = { pattern: /^/, rail: "chat", phone: "chat", memorable: false };

/** The path under `pathBase` (`/s/<slug>`) without a trailing slash, or null when `pathname` is not under it. */
function restOf(pathname: string, pathBase: string): string | null {
  if (!pathBase || (pathname !== pathBase && !pathname.startsWith(`${pathBase}/`))) return null;
  return pathname.slice(pathBase.length).replace(/\/+$/, "");
}

function surfaceOf(rest: string | null): SurfaceSpec {
  if (rest === null) return FALLBACK_SURFACE;
  return SURFACES.find((surface) => surface.pattern.test(rest)) ?? FALLBACK_SURFACE;
}

/** The rail entry a pathname belongs to (Chat outside any server page). */
export function railModeForPath(pathname: string, pathBase: string): RailMode {
  return surfaceOf(restOf(pathname, pathBase)).rail;
}

/** The phone tab a pathname belongs to; null for the server's own pages, which the server tab's popover opens and no tab holds. */
export function mobileTabForPath(pathname: string, pathBase: string): MobileTabId | null {
  return surfaceOf(restOf(pathname, pathBase)).phone;
}

/**
 * Where a rail tab lands with nothing remembered (relative to `/s/<slug>`),
 * and who always lands there whatever is remembered: a Guest's Chat is its one
 * channel, which the server's root opens (a remembered conversation, from when
 * it was a member, may be one it can't read); a phone's Home tab is the
 * conversation list at the root (a tab never reopens a pushed page).
 */
const TAB_HOMES: Record<RailMode, { home: string; alwaysHomeFor?: readonly ("guest" | "phone")[] }> = {
  chat: { home: "", alwaysHomeFor: ["guest", "phone"] },
  search: { home: "/search" },
  activity: { home: "/activity" },
  tasks: { home: "/tasks" },
  members: { home: "/members" },
  computers: { home: "/computers" },
  apps: { home: "/apps" },
  settings: { home: "/settings/account" },
  assistant: { home: "/assistant" },
  artifacts: { home: "/artifacts" },
};

/** Whether a stored value names a rail tab (storage may be corrupt, or written by a newer build). */
export function isRailMode(value: unknown): value is RailMode {
  return typeof value === "string" && Object.hasOwn(TAB_HOMES, value);
}

export function tabHome(tab: RailMode, serverSlug: string): string {
  return `/s/${serverSlug}${TAB_HOMES[tab].home}`;
}

export function tabAlwaysLandsHome(tab: RailMode, viewer: { guest?: boolean; phone?: boolean }): boolean {
  const who = TAB_HOMES[tab].alwaysHomeFor ?? [];
  return (viewer.guest === true && who.includes("guest")) || (viewer.phone === true && who.includes("phone"));
}

/**
 * The place an address on `serverSlug` is remembered as, with its rail tab:
 * the surface's page (`place`) or the address's own path, with only the
 * surface's page params, as written (their encoding kept). Null when the
 * address is not a memorable page of that server.
 */
export function placeOf(
  address: string,
  serverSlug: string,
  context: PlaceContext = {},
): { tab: RailMode; place: string } | null {
  if (!address.startsWith("/")) return null;
  const [pathname = "", query = ""] = address.split("#", 1)[0]!.split(/\?(.*)/s);
  const pathBase = `/s/${serverSlug}`;
  const rest = restOf(pathname, pathBase);
  if (rest === null) return null;
  const surface = surfaceOf(rest);
  const memorable = typeof surface.memorable === "function" ? surface.memorable(rest, context) : surface.memorable;
  if (!memorable) return null;
  const allowed = surface.pageParams ?? [];
  const kept = query.split("&").filter((part) => part !== "" && allowed.includes(part.split("=", 1)[0]!));
  const path = `${pathBase}${surface.place ?? rest}`;
  return { tab: surface.rail, place: kept.length > 0 ? `${path}?${kept.join("&")}` : path };
}
