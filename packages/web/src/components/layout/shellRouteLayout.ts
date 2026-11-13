import type { SystemBarSurface } from "../../theme/systemBarColor";
import type { MobileTabId } from "../../store/mobileNavStore";
import type { SidebarSlotColumn } from "./sidebarToggle";

/**
 * A Guest's channel page, which on a phone is its Home tab's top-level page:
 * the tab bar, no Back. A Guest reads one channel, so any channel URL is that
 * one, or sends the Guest to it (ChannelById), so the URL alone decides.
 */
export function isGuestHomePath(path: string, pathBase: string): boolean {
  return path.startsWith(pathBase) && /^\/channel\/[^/]+\/?$/.test(path.slice(pathBase.length));
}

/** The Tasks page's own address, `/s/<slug>/tasks` (a trailing slash allowed), nothing under it. */
export function isTasksPagePath(path: string, serverSlug: string | null | undefined): boolean {
  return !!serverSlug && path.replace(/\/+$/, "") === `/s/${serverSlug}/tasks`;
}

/**
 * Which panes a server URL gets: whether the sidebar shows (inline on a phone's
 * master pages, as col 2 on desktop, or not at all), which column it is, and
 * the surface at the top edge on a phone. One function for MainLayout and for
 * the frame shown while the server is still loading (PendingServerLayout), so
 * the two never disagree.
 */
export function shellRouteLayout(path: string, pathBase: string, { isDesktop, searchSlotOpen, guest = false }: {
  isDesktop: boolean;
  /** A picked search or Activity result is open (searchContentStore.slot). */
  searchSlotOpen: boolean;
  /**
   * The viewer is a Guest of this server: bound to one channel, they get no
   * navigation sidebar (no Saved, Drafts, channel sections or DMs) and land
   * in that channel (DefaultRoute), which on a phone is the Home tab's
   * top-level page (isGuestHomePath). Only the Settings list stays.
   */
  guest?: boolean;
}) {
  const at = (route: string) => path === `${pathBase}${route}` || path === `${pathBase}${route}/`;
  const under = (route: string) => at(route) || path.startsWith(`${pathBase}${route}/`);

  // Show sidebar inline as main content on mobile when the URL is one of
  // the per-rail-mode master pages — chat root or settings root. Detail URLs (/channel/<id>, /agent/<id>, /settings/account, etc.)
  // instead show the main panel and hide the sidebar. /computers renders a
  // dedicated MobileComputersPanel on mobile (stdrc msg 2a500cb7 2026-05-01)
  // and /tasks has no sidebar at all (handled separately below).
  const isDefaultRoute = at("");
  const isMobileMasterRoute = guest ? at("/settings") : isDefaultRoute || at("/settings");
  const mobileShowSidebarInline = !isDesktop && isMobileMasterRoute;

  // Tasks rail mode is single-page: the Tasks page owns its own filtering UI,
  // so we skip the Sidebar entirely and let the page take the full width next
  // to LeftRail. With task v2 a task opened from it sits beside the list
  // inside the route itself (TasksRoute), so the list never remounts.
  // Search rail mode (task #311 stdrc #proj-uiux:c2313b1d 2026-05-25) starts
  // single-page (full-width MessageSearchPage next to LeftRail). Once the
  // user picks a result and `searchContentStore.slot` opens, we flip into a
  // 3-column master/detail (LeftRail | MessageSearchPage | picked-entity)
  // by reusing the Sidebar slot to host MessageSearchPage and rendering the
  // picked entity in the routes container via SearchContentRoute.
  const isTasksRoute = under("/tasks");
  // The assistant is one page (its DM, or Create Your Assistant): like Tasks it
  // has no sidebar and follows the rail directly.
  const isAssistantRoute = under("/assistant");
  // The Apps page (#proj-apps task #22) is one page too: on desktop it follows
  // the rail like Tasks; on a phone it is a page the server tab pushes.
  const isAppsRoute = under("/apps");
  // The Artifacts home page has its own rail entry (#proj-workspace:#133): on
  // desktop it follows the rail like Apps; on a phone the server tab pushes it.
  const isArtifactsRoute = under("/artifacts");
  // Computers on desktop: the rack is a full page beside the rail, like Tasks
  // and Apps, and a computer opens in the side panel beside it
  // (/computer/<id> redirects there, MainLayout's MachineRoute). On a phone
  // Computers keeps its own panes.
  const isComputersFullPage = isDesktop
    && (under("/computers") || under("/computer") || under("/machine"));
  // Members (raft-design products/raft-chat/members.md) is one page with its
  // own tabs, grouping and search: no sidebar beside it, on desktop or a
  // phone, like Apps. A profile URL (/agent/*, /human/*) is the Members
  // section too: on desktop it redirects to the page's side panel
  // (useMembersProfileRedirect), so no Members sidebar flashes before it, nor
  // stays beside one it doesn't redirect.
  const isMembersRoute = under("/members") || (isDesktop && (under("/agent") || under("/human")));
  const isSearchRoute = under("/search");
  // Inbox (Activity) is the second content master/detail route. It reuses the
  // exact same slot store, URL sync, column assembly, widths, and resize
  // handlers as /search — only col-2's content differs (ThreadsInbox vs
  // MessageSearchPage). stdrc #proj-activity:171042a3 2026-06-23.
  // /activity always gets the search-style master/detail (the rail-vs-sidebar
  // placement A/B was dropped 2026-06-30 — rail is the default).
  const isInboxRoute = under("/activity");
  const isContentRoute = isSearchRoute || isInboxRoute;
  // Activity on desktop (stdrc): always two columns, the list in col 2 beside
  // the opened conversation, or beside an empty main area while nothing is
  // open (InboxContentRoute). Where that is tight, the list column gives way
  // down to its minimum (ShellSidebarColumn); it collapses like the chat
  // sidebar. Search flips into master/detail only once a result is picked.
  const searchMasterDetail = isDesktop && (isInboxRoute || (isSearchRoute && searchSlotOpen));
  // A Guest's col 2 is never the navigation sidebar: only the Settings list,
  // and Search's and Activity's own lists (searchMasterDetail), stay.
  const guestHidesSidebar = guest && !under("/settings") && !searchMasterDetail;
  const hideSidebar = guestHidesSidebar || isTasksRoute || isAssistantRoute || isAppsRoute || isArtifactsRoute || isMembersRoute || isComputersFullPage || (isContentRoute && !searchMasterDetail);
  // Desktop sidebar collapse (stdrc, #proj-chat task #9): the rail's toggle and
  // ⌘\ hide the sidebar so the main area takes its width; raft-ui's
  // `sidebarCollapsible` shell slides the main area over it. Where col 2 is
  // the navigation sidebar, or Activity's list beside an opened conversation
  // (stdrc: collapsible exactly like the chat sidebar, remembered on its own so
  // neither hides the other). A phone has no column beside the main area, the
  // sidebar-less routes have nothing to collapse, and the Search results list
  // stays put. Elsewhere the remembered state waits, and the toggle is not shown.
  const collapseColumn: SidebarSlotColumn = searchMasterDetail && isInboxRoute ? "activityList" : "sidebar";
  const sidebarCollapsible = isDesktop && !hideSidebar && (!searchMasterDetail || isInboxRoute);
  // The Settings list renders the sidebar inline too, as a page the server
  // tab pushes (paper chrome, a Back); Members is its own pushed page.
  // /activity itself is the Activity tab root (pushes under it are details)
  // until an opened conversation covers it, as on /search.
  const isActivityRoot = at("/activity") && !searchSlotOpen;
  // /search is the Search tab's root (design lead 2026-10-21) until a picked
  // result covers it.
  const isSearchRoot = at("/search") && !searchSlotOpen;
  // A Guest's channel is its Home (it has no channel list to go back to): a
  // Back there would only land in the same channel again.
  const isGuestHome = guest && isGuestHomePath(path, pathBase);
  // A task opened from the Tasks page covers its root on a phone, as a picked result covers Search's.
  const isTasksRoot = isTasksRoute && !searchSlotOpen;
  const isMobileTabRoot = !isDesktop && (isDefaultRoute || isGuestHome || isActivityRoot || isTasksRoot || isSearchRoot);
  // Standalone chrome buckets (Raft Design System › NavBar): a tab root's top
  // bar is the frame (yellow in light, #0d0d0b in dark), a pushed detail's
  // header is paper, and at >=768px ShellTopBar is the frame. The shell paints
  // that surface above the safe-area inset and the system bar follows it
  // (systemBarColor.ts writes `meta[theme-color]`, in either mode).
  // A Guest's Home is the channel page, whose header is paper like any channel's.
  const topEdgeSurface: SystemBarSurface = !isDesktop && (!isMobileTabRoot || isGuestHome) ? "paper" : "frame";
  // The phone tab root the URL is, for the bottom tab bar (MainLayout's useMobileTabBarVisible draws it there).
  const mobileTabRoot: MobileTabId | null = !isMobileTabRoot ? null
    : isDefaultRoute || isGuestHome ? "chat" : isActivityRoot ? "activity" : isTasksRoot ? "tasks" : "search";

  // Main pages with no composer that still get the assistant's otter, on
  // the main column's bottom edge (AssistantPageOtter; #proj-assistant:#17
  // item 3).
  const assistantPageOtter = isInboxRoute || isTasksRoute || under("/members") || isSearchRoute;

  return {
    assistantPageOtter,
    isDefaultRoute,
    mobileShowSidebarInline,
    isTasksRoute,
    isAssistantRoute,
    isSearchRoute,
    isInboxRoute,
    isContentRoute,
    searchMasterDetail,
    hideSidebar,
    collapseColumn,
    sidebarCollapsible,
    topEdgeSurface,
    mobileTabRoot,
  };
}
