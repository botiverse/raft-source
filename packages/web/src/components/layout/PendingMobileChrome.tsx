import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { Activity, Home, ListTodo, Search } from "lucide-react";
import { MobileNavItem, MobileNavLabel, MobileNavRoot, PanelActions, Skeleton, WorkspaceButton, WorkspaceButtonName } from "@botiverse/raft-ui";
import { MobileNavServerItem, MobileNavServerPopover } from "@botiverse/raft-ui/wip";
import type { MobileTabId } from "../../store/mobileNavStore";
import { useServerStore } from "../../store/serverStore";
import { serverSlugOfPath } from "../../utils/serverSlugOfPath";
import AvatarSlot from "../ui/AvatarSlot";
import { PendingNotificationTrigger } from "./NotificationTrigger";
import { OfflineIndicator } from "./OfflineIndicator";
import { useShellOffline } from "./shellPending";
import { TabRootBar } from "./TabRootBar";

/**
 * A phone tab root's chrome while the server is still on its way
 * (PendingServerLayout): Home's bar and the bottom tab bar, in the boxes
 * MainLayout then fills (Sidebar's TabRootBar, MainLayout's MobileTabBar), so
 * nothing moves when the server arrives. Drawn, not interactive (the pending
 * frame is inert); the server shows only once it is the one the URL opens.
 */

/** Phone bar chrome (stdrc 2026-10-21): raft-ui's MobileNav edge bar as
 *  the DS draws it — full width at the bottom, the card surface, a seam on
 *  top, and raft-ui's own bottom padding (8px, or the home-indicator inset up
 *  to 34px). It hides while the on-screen keyboard is up (`data-soft-keyboard`
 *  on #root, utils/visualViewport.ts) instead of riding above it, and slides
 *  back up when the keyboard closes (`.mobile-tab-bar-return`, index.css).
 *  MainLayout's MobileTabBar and the pending bar use it. */
export const MOBILE_TAB_BAR_CLASS = "mobile-tab-bar-return md:hidden in-data-[soft-keyboard=open]:hidden";
/** Each tab's icon sits in its own box with the attention dot pinned to the
 *  box's top-right corner (Raft DS › MobileNav: "one pink pixel at the top
 *  right of the icon"). The dot must not be a direct child of the item:
 *  MobileNavItem sets `*:relative` on its children, which beats the dot's own
 *  `absolute`, so a direct-child dot joined the item's column as a third
 *  row and made a tab with a dot taller than the others — in a row that
 *  centres its items, that tab's icon rode up ("the Activity icon floats",
 *  stdrc 2026-10-21; Activity is the tab that almost always has a dot). */
export const MOBILE_TAB_ICON_BOX_CLASS = "relative flex";

const TAB_ICONS = { chat: Home, activity: Activity, tasks: ListTodo, search: Search } as const;
const MOBILE_TAB_LABEL_IDS = {
  chat: "layout.mobileTabBar.home",
  activity: "layout.mobileTabBar.activity",
  tasks: "layout.mobileTabBar.tasks",
  search: "layout.mobileTabBar.search",
} as const;
const MOBILE_TABS = ["chat", "activity", "tasks", "search"] as const satisfies readonly MobileTabId[];

/** The current server, once it is the one the URL opens (opened from the device's list); offline, the one shown from the device. */
function useShownServer() {
  const server = useServerStore((s) => s.current);
  const { pathname } = useLocation();
  const offline = useShellOffline();
  if (offline) return offline.server;
  return server && server.slug === serverSlugOfPath(pathname) ? server : null;
}

/** Home's bar: the workspace button, then the Bell. */
export function PendingHomeBar() {
  const { formatMessage } = useIntl();
  const server = useShownServer();
  const offline = useShellOffline() !== null;
  return (
    <TabRootBar
      name={formatMessage({ id: "layout.mobileTabBar.home" })}
      content={(
        <>
          <WorkspaceButton className="-ml-[11px]" aria-label={server?.name ?? formatMessage({ id: "common.loading" })}>
            {server ? (
              <>
                <AvatarSlot context="compact-row" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={(server.name ?? "").slice(0, 1).toUpperCase() || "R"} className="shrink-0" />
                <WorkspaceButtonName>{server.name}</WorkspaceButtonName>
              </>
            ) : (
              <>
                <Skeleton variant="circle" className="size-5 shrink-0" />
                <Skeleton variant="line" className="w-24" />
              </>
            )}
          </WorkspaceButton>
          <div className="min-w-0 flex-1" />
          <PanelActions>
            {offline ? <OfflineIndicator compact /> : null}
            <PendingNotificationTrigger flavor="mobile-navbar" />
          </PanelActions>
        </>
      )}
    />
  );
}

/** The bottom tab bar, `selected` marked, the server tab last. */
export function PendingMobileTabBar({ selected }: { selected: MobileTabId }) {
  const { formatMessage } = useIntl();
  const server = useShownServer();
  return (
    <MobileNavRoot aria-label={formatMessage({ id: "layout.mobileTabBar.navLabel" })} className={MOBILE_TAB_BAR_CLASS} data-testid="mobile-tab-bar">
      {MOBILE_TABS.map((tab) => {
        const Icon = TAB_ICONS[tab];
        const label = formatMessage({ id: MOBILE_TAB_LABEL_IDS[tab] });
        return (
          <MobileNavItem key={tab} selected={selected === tab} aria-label={label}>
            <span className={MOBILE_TAB_ICON_BOX_CLASS}><Icon /></span>
            <MobileNavLabel>{label}</MobileNavLabel>
          </MobileNavItem>
        );
      })}
      {/* The server tab is the popover's trigger; closed, as the frame is inert. */}
      <MobileNavServerPopover open={false}>
        <MobileNavServerItem aria-label={server?.name ?? formatMessage({ id: "common.loading" })}>
          {server ? (
            <AvatarSlot context="compact-list" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={(server.name ?? "").slice(0, 1).toUpperCase() || "R"} />
          ) : (
            <Skeleton variant="block" className="size-[19px]" />
          )}
          <MobileNavLabel>{server ? server.name : <Skeleton variant="line" className="mx-auto h-2.5 w-10" />}</MobileNavLabel>
        </MobileNavServerItem>
      </MobileNavServerPopover>
    </MobileNavRoot>
  );
}
