import { WorkspaceButton, WorkspaceButtonName, PanelActions, Popover, PopoverTrigger, SidebarHeader, SidebarHeaderTitle } from "@botiverse/raft-ui";
import AppPanelHeader from "../../components/ui/PanelHeader";
import AttentionDot from "../../components/ui/AttentionDot";
import { PublicPageGlobe } from "../../components/server/PublicPageGlobe";
import AvatarSlot from "../../components/ui/AvatarSlot";
import ServerSwitcherMenu from "../../components/ui/ServerSwitcherMenu";
import { SHOW_STALE_COUNTS_NOTICE_IN_DESKTOP_SIDEBAR, StaleCountsNotice, UNREAD_COUNT_SURFACES } from "../../components/layout/StaleCountsNotice";
import NotificationTrigger from "../../components/layout/NotificationTrigger";
import { WorkingNowSummary } from "../../components/layout/WorkingNowSummary";
import { TabRootBar } from "../../components/layout/TabRootBar";
import type { SidebarData } from "./hooks/useSidebarData";
import type { SidebarViewState } from "./hooks/useSidebarViewState";
import type { SidebarSync } from "./hooks/useSidebarSync";
import type { SidebarHomeEntriesState } from "./hooks/useSidebarHomeEntries";

/**
 * The Sidebar's head: the phone tab-root bar or a pushed page's Back head, the
 * desktop head, and the stale-counts notice.
 */
export function SidebarTopBar({ mobileInline, hideTitle, data, view, sync, home }: {
  mobileInline: boolean | undefined;
  hideTitle: boolean;
  data: SidebarData;
  view: SidebarViewState;
  sync: SidebarSync;
  home: SidebarHomeEntriesState;
}) {
  const { formatMessage, serverName, serverAvatarUrl, serverPublicPageLive, serverUnreadCounts } = data;
  const { showServerMenu, setShowServerMenu, railMode, railLabel } = view;
  const { hasOtherServerUnread } = sync;
  const {
    closeServerMenu, mobileHeadRef, isServerPushedPage, backFromServerPage, backFromServerPageProps,
  } = home;
  return (
    <>
      {/* Phone tab-root NavBar (TabRootBar, shared with Activity and Tasks): raft-ui's
          section head, which on a phone is the frame with a seam below and
          owns the edges (content on 16, the last 44px button 3px from the
          edge, mirroring a Back). No tab icon. Home shows only the workspace
          pill — the one label — then who is working and the bell; every
          other tab root writes its page name in the bar and has no pill. On
          desktop the switcher lives in the rail or the top bar. */}
      {isServerPushedPage && (
        <AppPanelHeader title={railLabel} onMobileBack={backFromServerPage} mobileBackProps={backFromServerPageProps} />
      )}
      {mobileInline && !isServerPushedPage && (
        <TabRootBar
          ref={mobileHeadRef}
          // Home's bar shows the pill, not the page name, so "Home" is the
          // page's one h1 for assistive tech only.
          name={railMode === "chat" ? formatMessage({ id: "layout.mobileTabBar.home" }) : railLabel}
          content={railMode === "chat" ? (
            <>
              {/* The switcher hangs under the whole bar, 8px in from each
                  side, as a raft-ui Popover kept on screen. */}
              <Popover open={showServerMenu} onOpenChange={setShowServerMenu}>
                <PopoverTrigger
                  /* The server switcher (raft-ui WorkspaceButton): the same
                     shape as the web top bar and the mobile app — the
                     server's avatar, its name, a chevron. Other servers'
                     unread rides on the avatar's corner. Its avatar sits
                     on the bar's 16px margin, in line with the list below:
                     the button's border and padding hang outward (DS ›
                     Alignment, a shape beside plain text). */
                  render={<WorkspaceButton data-testid="mobile-workspace-trigger" className="-ml-[11px]" />}
                >
                  <AvatarSlot
                    context="compact-row"
                    type="server"
                    serverAvatarUrl={serverAvatarUrl}
                    serverInitial={(serverName ?? "").slice(0, 1).toUpperCase() || "R"}
                    className="shrink-0"
                    badge={hasOtherServerUnread ? (
                      <AttentionDot
                        aria-label={formatMessage({ id: "layout.sidebar.otherServersUnread" })}
                        title={formatMessage({ id: "layout.sidebar.otherServersUnread" })}
                      />
                    ) : undefined}
                  />
                  <WorkspaceButtonName>{serverName || formatMessage({ id: "layout.sidebar.serverFallbackName" })}</WorkspaceButtonName>
                  <PublicPageGlobe live={serverPublicPageLive} size={14} />
                </PopoverTrigger>
                <ServerSwitcherMenu
                  onClose={closeServerMenu}
                  serverUnreadCounts={serverUnreadCounts}
                  testId="mobile-server-switcher-menu"
                  navigationMode="replace-with-home"
                  anchor={mobileHeadRef}
                  sideOffset={4}
                  alignOffset={8}
                  className="w-[calc(var(--anchor-width)-16px)]"
                />
              </Popover>
              <div className="min-w-0 flex-1" />
              {/* Who is working (AgentActivity `rf-working--count`); renders
                  nothing when nobody is, or the setting is off. */}
              <WorkingNowSummary variant="count" onFrame />
              {/* Notification Center entry — the permanent Bell on the Home
                  bar's right; only its attention pixel depends on whether
                  notifications exist. */}
              <PanelActions>
                <NotificationTrigger flavor="mobile-navbar" />
              </PanelActions>
            </>
          ) : undefined}
        />
      )}

      {/* Desktop sidebar head (`.rf-side__head`, raft-ui SidebarHeader): 56
          tall like the rail head and every panel head, so the seams line up;
          just the rail mode's name (the rail already carries the icon), and
          on Chat who is working right now on the right. With the top bar it
          is dropped. */}
      {!mobileInline && !hideTitle && (
        <SidebarHeader>
          <SidebarHeaderTitle className="min-w-0 flex-1">
            {railLabel}
          </SidebarHeaderTitle>
          {railMode === "chat" && <WorkingNowSummary variant="count" />}
        </SidebarHeader>
      )}

      {/* Task #164: the unread counts may be the last known ones; say so
          once under the head: Home's bar on a phone, the sidebar head on a
          desktop (behind SHOW_STALE_COUNTS_NOTICE_IN_DESKTOP_SIDEBAR). */}
      {railMode === "chat" && !isServerPushedPage && (mobileInline || SHOW_STALE_COUNTS_NOTICE_IN_DESKTOP_SIDEBAR) && (
        <StaleCountsNotice
          surfaces={UNREAD_COUNT_SURFACES}
          messageId="layout.sidebar.staleCountsNotice"
          unavailableMessageId="layout.sidebar.countsUnavailableNotice"
          data-testid="sidebar-stale-notice"
        />
      )}
    </>
  );
}
