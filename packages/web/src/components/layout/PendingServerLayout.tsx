import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import type { CSSProperties } from "react";
import { AppShellSidebarSlot } from "@botiverse/raft-ui";
import { ConversationLoading, ThreadSkeleton } from "../../boot/bootSkeletons";
import { COLUMN_BOUNDS } from "../../lib/panelBounds";
import { useColumnWidth } from "../../store/columnWidthStore";
import { useServerStore } from "../../store/serverStore";
import { LeftRail } from "./LeftRail";
import { PendingHomeBar, PendingMobileTabBar } from "./PendingMobileChrome";
import { ShellFrame, useIsDesktopShell, useShowsTopBar } from "./ShellFrame";
import ShellSidebarColumn from "./ShellSidebarColumn";
import { shellRouteLayout } from "./shellRouteLayout";
import { PendingSidebarSkeleton } from "../../features/sidebar/sections/PendingSidebarSkeleton";
import { useAuthStore } from "../../store/authStore";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";
import { SIDEBAR_REGION_ID, useSidebarSlotHidden } from "./sidebarToggle";
import { OfflineChannelRows, OfflineMessagesNotice, OfflineReasonNotice } from "./OfflineServerParts";
import type { OfflineFrame } from "./OfflineServerParts";
import { ShellOfflineContext } from "./shellPending";

/** The server path prefix of a URL (`/s/<slug>`), or "" off a server page. */
function pathBaseOf(pathname: string): string {
  return /^\/s\/[^/]+/.exec(pathname)?.[0] ?? "";
}

/** Whether the URL opens a conversation (the default route redirects to one). */
function opensConversation(pathname: string, pathBase: string): boolean {
  const rest = pathname.slice(pathBase.length).replace(/\/+$/, "");
  return rest === "" || /^\/(channel|dm)\//.test(rest);
}

/**
 * The app's frame while the server it opens is still on its way (the signed-in
 * check, the server list, the server becoming current): the real top bar and
 * rail, and each region loading in its own place. The panes come from the
 * same rules as MainLayout's (shellRouteLayout), and MainLayout then takes over
 * the same frame (ShellFrame) with the server's data. Pending
 * (ShellPendingContext): not interactive, and nothing in it asks for data.
 */
export function PendingServerLayout({ prerender = false, offline }: {
  /**
   * The boot shell prerendered into index.html (scripts/bootShellPlugin.ts),
   * before any script knows the window: the desktop frame, with the phone's
   * left to the stylesheet (top bar from md up) and the thread column to the
   * boot script (`html.boot-thread`). "phone-home": the phone's Home (the
   * channel list, its bar and the tab bar), which the stylesheet shows
   * instead on a phone at a server's root (`html.boot-home`).
   */
  prerender?: boolean | "phone-home";
  /**
   * Offline, the last session from the device's tables (OfflineServerLayout):
   * the server and its channel rows in place of the skeletons, Offline in
   * the bar, and in the main column that messages can't be opened. Still
   * the pending frame: inert, and nothing in it asks for or changes anything.
   */
  offline?: OfflineFrame;
} = {}) {
  const { formatMessage } = useIntl();
  const { pathname, search } = useLocation();
  const measuredDesktop = useIsDesktopShell();
  const isDesktop = prerender === "phone-home" ? false : prerender || measuredDesktop;
  const measuredTopBar = useShowsTopBar(isDesktop);
  const showTopBar = prerender === "phone-home" ? false : prerender ? "md" : measuredTopBar;
  const pathBase = pathBaseOf(pathname);
  // Offline on a phone, whatever the URL: the server's Home (its bar with
  // Offline, the reason, the channel list, the tab bar). A detail page would
  // be only the notice, with no bar and no way back.
  const layoutPath = offline && !isDesktop ? pathBase : pathname;
  // A Guest gets no sidebar (shellRouteLayout). Its role is known once the
  // server's row is (taken from the device, or in the list on a switch), so
  // that frame draws none either. The prerendered boot shell can't know it.
  const slug = pathBase.slice("/s/".length);
  const guest = useServerStore((s) => {
    const row = s.current?.slug === slug ? s.current : s.servers.find((server) => server.slug === slug);
    return Boolean(slug) && row?.role === "guest";
  });
  // Whose sidebar on which server, when known (from the device), for the rows
  // each section had the last time it loaded there; the prerendered shell
  // knows neither and draws the defaults.
  const serverId = useServerStore((s) => {
    if (!slug) return null;
    const row = s.current?.slug === slug ? s.current : s.servers.find((server) => server.slug === slug);
    return row?.id ?? null;
  });
  const userId = useAuthStore((s) => s.user?.id ?? accessTokenSubject(s.accessToken));
  const layout = shellRouteLayout(layoutPath, pathBase, { isDesktop, searchSlotOpen: false, guest });
  const sidebarInline = layout.mobileShowSidebarInline;
  const sidebarHidden = useSidebarSlotHidden(layout.collapseColumn);
  const thread = !offline && (prerender === true || new URLSearchParams(search).has("thread"));
  const threadWidth = useColumnWidth("thread");
  const threadStyle = { "--thread-panel-width": `${threadWidth}px` } as CSSProperties;
  const loading = formatMessage({ id: "common.loading" });

  const frame = (
    <ShellFrame
      pending
      busy={!offline}
      isDesktop={isDesktop}
      showTopBar={showTopBar}
      topEdgeSurface={layout.topEdgeSurface}
      sidebarCollapsible={layout.sidebarCollapsible}
      sidebarOpen={!sidebarHidden}
      rail={<LeftRail hidden={sidebarInline} topBar={showTopBar !== false} sidebarToggle={layout.sidebarCollapsible ? layout.collapseColumn : null} />}
      sidebar={layout.hideSidebar ? null : (
        <AppShellSidebarSlot
          id={SIDEBAR_REGION_ID}
          className={sidebarInline ? "relative z-auto flex min-w-0 flex-1" : isDesktop ? "hidden md:relative md:flex" : "hidden md:hidden"}
        >
          <ShellSidebarColumn
            column={layout.searchMasterDetail ? "list" : "sidebar"}
            inline={sidebarInline}
            collapseColumn={layout.sidebarCollapsible && !sidebarInline ? layout.collapseColumn : null}
            ownBorder={layout.searchMasterDetail}
            rightColumnMin={thread ? COLUMN_BOUNDS.thread.contentMin : 0}
            className={`relative h-full min-w-0 ${sidebarInline ? "flex-1 bg-layer-canvas" : "shrink-0 bg-layer-sidebar"} ${layout.searchMasterDetail ? "flex flex-col" : ""}`}
          >
            {sidebarInline && layout.isDefaultRoute ? <PendingHomeBar /> : null}
            {offline && showTopBar === false ? <OfflineReasonNotice /> : null}
            {/* The loaded sidebar's entries and sections, so its rows replace
                these without moving. */}
            {offline ? (
              <OfflineChannelRows channels={offline.channels} />
            ) : (
              <PendingSidebarSkeleton userId={userId} serverId={serverId} phone={!isDesktop} />
            )}
          </ShellSidebarColumn>
        </AppShellSidebarSlot>
      )}
      mainHidden={sidebarInline}
      main={(
        <div className="thread-layout-container flex min-h-0 min-w-0 flex-1" data-testid="pending-server-layout">
          <div className="thread-main-column flex min-h-0 min-w-0 flex-1 flex-col overflow-clip" data-main-column="">
            {offline
              ? <OfflineMessagesNotice />
              : opensConversation(pathname, pathBase)
                ? <ConversationLoading label={loading} />
                : <span className="sr-only" role="status">{loading}</span>}
          </div>
          {thread ? (
            <div className="thread-side-column flex flex-col bg-layer-canvas" style={threadStyle} data-boot-thread="">
              <ThreadSkeleton />
            </div>
          ) : null}
          <div hidden data-slot="thread-layout-end" />
        </div>
      )}
      after={layout.mobileTabRoot ? <PendingMobileTabBar selected={layout.mobileTabRoot} /> : null}
    />
  );
  return offline ? <ShellOfflineContext.Provider value={offline}>{frame}</ShellOfflineContext.Provider> : frame;
}
