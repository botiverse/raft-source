import { deferredDialog, deferredPanel, lazyPanel } from "../../boot/deferredUi";
import { loadComputersRack } from "../../features/computer/computersRackChunk";
import { loadMachineDetailPanel } from "../../features/computer/machineDetailChunk";
import { COMPUTER_PANEL_QUERY, computerProfileParam } from "../../utils/computerPanel";
import { PanelLoading } from "./PanelLoading";
import { MOBILE_TAB_BAR_CLASS, MOBILE_TAB_ICON_BOX_CLASS } from "./PendingMobileChrome";
import Tooltip from "../ui/Tooltip";
import AppEmptyState from "../ui/EmptyState";
import { ConversationLoading } from "../../boot/bootSkeletons";
import { markBootMilestone } from "../../boot/bootTiming";
import MessageLinkUnavailable from "../deeplinks/MessageLinkUnavailable";
import { OpenInAppOffers } from "../deeplinks/OpenInAppOffers";
import { useOtherServerMessageLink } from "../deeplinks/otherServerMessageLink";
import { conversationPathOf, serverPathOf, useDeepLinksFlag, useLandedMessageLink, useLandingHoldsAnnouncements, useMessageLinkLandingLifetime } from "../deeplinks/deepLinksFlag";
import { isMessageLinkLanding, isThreadMismatch, parseMessageLink } from "../../utils/messageLinkLanding";
import { movePageLanding } from "../../utils/pageLanding";
import { useContext, useState, useEffect, useEffectEvent, useCallback, useMemo, useRef, Suspense } from "react";
import type { ReactNode } from "react";
import {
  AppShellSidebarSlot,
  DialogSurface,
  PanelAction,
  PanelActions,
  PanelHeader as PanelHead,
  MobileNavItem,
  MobileNavLabel,
  MobileNavRoot,
  Skeleton,
  ProfilePanel as ProfilePanelFrame,
  toast,
} from "@botiverse/raft-ui";
import { ThreadIcon, MessageIcon } from "@botiverse/ricons";
import { PROFILE_PANEL_OVERLAY_CLASS, profilePanelDesktopStyle } from "../profile/profilePanelGeometry";
import { LEGACY_TASK_SIDE_PANEL_CLASS, legacyTaskSidePanelDesktopStyle } from "../task/legacyTaskPanelGeometry";
import { COLUMN_BOUNDS } from "../../lib/panelBounds";
import { useColumnWidth } from "../../store/columnWidthStore";
import ChannelSideArea, { SideSectionPortal, ThreadColumnSections, useThreadColumnSide } from "../task/ChannelSideArea";
import { ThreadCollapseChevron } from "../task/ThreadCollapseChevron";
import { AgentContextViewPageSlot } from "../agentContextView/AgentContextViewSlots";
import { useRowPlanned } from "./rowPlanStore";
import { RowRegionChrome } from "./RowRegionChrome";
import { SideSectionDnd, useSideSectionHead } from "../task/sideSectionDrag";
import { useStackEndHead } from "../task/stackEnd";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import ShellSidebarColumn from "./ShellSidebarColumn";
import ShellArtifactHost from "./ShellArtifactHost";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { Routes, Route, Navigate, UNSAFE_NavigationContext as NavigationContext, useParams, useNavigate, useLocation, useNavigationType } from "react-router-dom";
import { directTaskConversationChannelId, isTaskV2Task, opensAsTaskConversation, parseTaskConversationParam } from "../../utils/taskConversation";
import { dismissTaskConversationDialog, TaskConversationDialog } from "../task/taskConversationDialogChunk";
import { DRAFTS_SECTION_FLAG_KEY, TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ArtifactReviewId } from "@botiverse/raft-shared";
import { useRecordRecentConversation } from "../../features/search/useRecordRecentConversation";
import { useIntl } from "react-intl";
import { useChannelStore } from "../../store/channelStore";
import { useAgentStore } from "../../store/agentStore";
import { useInboxStore } from "../../store/inboxStore";
import { useShallow } from "zustand/react/shallow";
import AttentionDot from "../ui/AttentionDot";
import { hasCurrentServerActivityUnread } from "../../utils/serverUnreadSummary";
import { useTaskStore, selectChannelTaskBucket } from "../../store/taskStore";
import { loadThreadParentTasksIfNeeded, resolveThreadHostTask } from "./threadHostTask";
import type { Task } from "../../store/taskStore";
import { useMachineStore } from "../../store/machineStore";
import { watchModelLabelCatalog } from "../../store/modelLabelCatalogStore";
import { useServerStore } from "../../store/serverStore";
import { rememberRootConversation, ROOT_REDIRECT_MEDIA_QUERY } from "../../store/rootConversation";
import { useAuthStore } from "../../store/authStore";
import { shouldSuppressAnnouncements, useOnboardingAnnouncementGateStore } from "../../store/onboardingAnnouncementGateStore";
import { mainLayoutRealtimeBridgeDriver } from "../../store/mainLayoutRealtimeBridgeDriver";
import { useMainLayoutRealtimeBridge } from "../../store/socketBridge";
import { Sidebar } from "../../features/sidebar/Sidebar";
import { isHostShell } from "../../embed";
import { useEmbedParamsKeeper } from "../../hooks/useEmbedParamsKeeper";
import { LeftRail } from "./LeftRail";
import { ShellFrame, useIsDesktopShell, useShowsTopBar } from "./ShellFrame";
import { useThreadRowState } from "./threadRowState";
import { isGuestHomePath, isTasksPagePath, shellRouteLayout } from "./shellRouteLayout";
import { useGuestHome, useGuestUnreadableRedirect, useIsGuest } from "./guestShell";
import { useTabRouteMemory } from "../../hooks/useTabRouteMemory";
import { useRailLegacyRedirect } from "../../hooks/useRailLegacyRedirect";
import { useMobileNav } from "../../hooks/useMobileNav";
import { ChatPanel } from "../../features/channel/ChatPanel";
import { ChannelAccessLost } from "../../features/channel/ChannelAccessLost";
import { GuestNoChannel, NoConversation } from "../../features/channel/NoConversation";
import { useChannelAccessLost, useChannelUnavailable } from "../../store/channelAccessLoss";
import MobileComputersPanel from "../machine/MobileComputersPanel";
import { MobileServerTab } from "./MobileServerTab";
import { useMarkComputerAttentionSeen } from "../../hooks/useComputerAttentionDot";
import { ThreadPanel } from "../../features/thread/DeferredThreadPanel";
import { useProfileStore } from "../../store/profileStore";
import { ComputerPanelRedirect } from "../machine/ComputerPanelRedirect";
import { useThreadStore } from "../../store/threadStore";
import { loadThreadRefContext } from "../../utils/threadRefContext";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import {
  useSearchContentStore,
  parseSearchOpenParam,
  formatSearchOpenParam,
} from "../../store/searchContentStore";
import type {
  SearchContentSlot,
} from "../../store/searchContentStore";
import { useSearchHitMarkLifetime } from "../../features/search/useSearchHitMarkLifetime";
import {
  isCurrentRightPanelSearchSnapshot,
  subscribeRightPanelThreadAnchor,
  syncRightPanelStoresFromSearch,
  syncRightPanelUrlFromStores,
} from "./rightPanelUrlSync";
import { blurFocusedControlForScreenshotShortcut } from "../../utils/keyboardShortcuts";
import { SIDEBAR_REGION_ID, setSidebarSlotHidden, toggleSidebarFromKeyboard, useSidebarSlotHidden } from "./sidebarToggle";
import { LegacyMemberGraphRedirect, LegacyThreadsRedirect, LegacyWorkspaceGridRedirect } from "./LegacyRedirects";
import { ShortcutHelpColumn } from "../../features/keyboard-shortcuts/ShortcutHelpColumn";
import "../../features/shortcuts/shortcutAccountBridge";
import { ShortcutHelpPage } from "../../features/keyboard-shortcuts/ShortcutHelpPage";
import { useShortcutHelpStore } from "../../features/keyboard-shortcuts/shortcutHelpStore";
import { useShortcut } from "../../features/shortcuts/useShortcut";
import { focusMountedSearch, routeGlobalSearchShortcut } from "../../utils/searchFocusRequest";
import { retapTabRoot } from "../../hooks/useTabRootScroll";
import { Activity, ArrowLeft, Home, ListTodo, MonitorX, Search, UserX, X } from "lucide-react";
import { MembersEmptyRoute } from "../../features/members/MembersEmptyRoute";
import { useMembersProfileRedirect } from "../../features/members/useMembersProfileRedirect";
import api from "../../api/client";
import type { HumanProfile } from "../member/HumanDetailPanel";
import { resolveHumanProfile } from "../member/resolveHumanProfile";
import { canRenderAgentDetail } from "../agent/agentDetailAvailability";
import { getCachedAgentProfile } from "../profile/profileFallbackCache";
import type { ProfilePanelProps } from "../profile/ProfilePanel";
import { recordSynchronousMobileBackNavigation, useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useOwnAssistantDmId, useOwnAssistantPageForDm } from "../../assistant/assistantClient";
import { AssistantOtterLayer } from "../../assistant/AssistantOtterShortcut";
import { loadArtifactActivityViewer, loadArtifactsDashboard } from "../../apps/artifacts";
import { artifactAddressTidying, artifactOpenEntryOf, artifactSlotInAddress, liveArtifactAddressEntry, readArtifactAddress, useArtifactOpenAddress, withArtifactAddress, writeArtifactAddress, writeArtifactSlotAddress } from "./artifactOpenAddress";
import { useArtifactViewerAddress } from "./artifactViewerAddress";
import { useBesideMemory } from "./useBesideMemory";
import PanelHeader from "../ui/PanelHeader";
import { ContentSlotThreadPanel } from "./ContentSlotThreadPanel";
import { CONTENT_SLOT_ENTRY_MARK, historyEntryIndex, isContentSlotEntry, stampContentSlotEntry } from "./contentSlotEntry";
import { TaskContentSlot } from "./TaskContentSlot";
import { TasksRoute } from "./TasksRoute";
import { RowColumnSlotContext } from "./rowColumnSlot";
import { DetailSlotThreadContext, useThreadInDetailSlotOpener } from "./detailSlotThread";
import { ContentSlotBackContext, useContentSlotBack } from "./contentSlotBack";
import { ACTIVITY_MASTER_DETAIL_QUERY, isActivityMasterDetailViewport } from "../thread/activityLayout";
import { useActivityVisitSurface } from "../thread/activityVisit";
import { focusActivityRowAfterClose } from "../thread/activityRowFocus";
import { useClearLiveAgentActivityOnServerChange } from "./WorkingNowSummary";
import { TaskDialogShell } from "../task/TaskDialogShell";
import { isSettingsApplicationsSlug, legacySettingsRouteRedirectSlug } from "../settings/settingsNavigation";
import { isChangePasswordSettingsIntent } from "../../utils/changePasswordNavigation";
import ServerSetupProjectionGate from "../onboarding/ServerSetupProjectionGate";
import {
  buildThreadRoutePath,
  consumeThreadRefHandoffSearch,
  executeThreadRefHandoffOnce,
  parseThreadRefHandoff,
  resolveThreadTargetByShortId,
} from "../../utils/threadRefNavigation";
import { buildSidebarDisclosureRestoreState } from "./sidebarChannelFocus";
import { observeProfileOpenE2eImport } from "../../utils/profileOpenE2eTimeline";

const SHRINK_PANEL_HEADER_CONTAINER_PROPS = { className: "shrink-0" };
const LG_VIEWPORT_QUERY = "(min-width: 1024px)";
const THREAD_SPLIT_VIEWPORT_QUERY = "(orientation: landscape), (min-width: 1280px)";

// Lazy-loaded route panels (code splitting), each with Try again in place of a
// failed download (lazyPanel). The detail panels the workspace opens first
// (agent, computer, member) are also fetched in the background after the first
// screen (deferredPanel); ChatPanel is in the entry, ThreadPanel deferred too.
const AgentDetailPanel = deferredPanel(() => observeProfileOpenE2eImport(
  "agent-detail",
  () => import("../../features/agent/AgentDetailPanel").then((module) => ({ default: module.AgentDetailPanel })),
));
const MessageSearchPage = deferredPanel(() => import("../../features/search/MessageSearchPage").then((module) => ({ default: module.MessageSearchPage })));
const SearchOverlay = deferredDialog(() => import("../../features/search/SearchOverlay").then((module) => ({ default: module.SearchOverlay })));
const AddMachineDialog = deferredDialog(() => import("../machine/AddMachineDialog"));
const AgentUnavailablePanel = lazyPanel(() => import("../agent/AgentUnavailablePanel"));
const ArtifactActivityViewer = lazyPanel(loadArtifactActivityViewer);
// One load with the side panel's (machineDetailChunk), which the Computers page starts on hover.
const MachineDetailPanel = deferredPanel(loadMachineDetailPanel);
// The rack's one shared load (computersRackChunk: the phone page and the boot's
// start for this route use it too); a failed download shows Try again here.
const ComputersRackOverview = deferredPanel(loadComputersRack);
const ThisDevicePanel = lazyPanel(() => import("../machine/localComputer/ThisDevicePanel").then((m) => ({ default: m.ThisDevicePanel })));
const HumanDetailPanel = deferredPanel(() => import("../member/HumanDetailPanel"));
const RaftBenchPage = lazyPanel(() => import("../../raftbench/RaftBenchPage"));
const AssistantRoute = lazyPanel(() => import("../../assistant/AssistantRoute"));
const SettingsPanel = lazyPanel(() => import("../settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const AppsPage = lazyPanel(() => import("../apps/AppsPage"));
const MigrationLogPage = lazyPanel(() => import("../agentMigration/log/MigrationLogPage").then((m) => ({ default: m.MigrationLogPage })));
const ReleaseNotesPanel = lazyPanel(() => import("../settings/ReleaseNotesPanel"));
const ThreadsInbox = lazyPanel(() => import("../../features/thread/ThreadsInbox").then((m) => ({ default: m.ThreadsInbox })));
const SavedPanel = lazyPanel(() => import("../saved/SavedPanel"));
const DraftsPanel = lazyPanel(() => import("../drafts/DraftsPanel"));
const ArtifactsDashboard = lazyPanel(loadArtifactsDashboard);
const ProfilePanel = lazyPanel<ProfilePanelProps>(() => observeProfileOpenE2eImport(
  "profile-panel",
  () => import("../profile/ProfilePanel"),
));
const LegacyTaskPanel = lazyPanel(() => import("../task/LegacyTaskPanel"));
const TaskModalHead = lazyPanel(() => import("../task/TaskModalHead"));

/** Returns true when the mobile bottom tab bar should be visible on the
 *  current route. Used by both the bar itself and its in-flow spacer so that
 *  detail views (which return null from MobileTabBar) don't leave a stray
 *  empty strip below the page content.
 *
 *  The phone rule (design lead, 2026-10-21): a page with a Back at the top has
 *  no tab bar; a page without one is a tab root and shows it. The tab bar says
 *  which part of the product you are in, Back says where you came from —
 *  never both. Same iOS NavigationView model as @stdrc 2026-04-30
 *  #proj-uiux:c8711d2a: the tab bar lives at the root of each tab's stack
 *  only (Home, Activity, Tasks, Search). When the user pushes to a detail
 *  (channel / dm / agent / human / computer, a search result, a task /
 *  profile sheet over a tab root, or one of the server's own pages the server
 *  tab opens: Members, Computers, Settings) the new view covers the full
 *  screen including the tab bar. To switch tabs the user pops back to the tab
 *  root first.
 */
function useMobileTabBarVisible(): boolean {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const threadOpen = useThreadStore((s) => !!s.openParentMessageId);
  const taskModalOpen = useThreadStore((s) => s.taskModal !== null);
  const profileOpen = useProfileStore((s) => !!s.profileId);
  const legacyTaskOpen = useLegacyTaskPanelStore((s) => !!s.task);
  const searchSlotOpen = useSearchContentStore((s) => !!s.slot);
  const { guest, overlayOpen: guestOverlayOpen } = useGuestHome(serverSlug ? `/s/${serverSlug}` : null);
  if (!serverSlug) return false;

  const pathBase = `/s/${serverSlug}`;
  const path = location.pathname;
  const trimmedPath = path.replace(/\/+$/, "");

  if (threadOpen) return false;
  // A picked Search result (or Activity item) is a pushed page with a Back.
  if (searchSlotOpen) return false;

  // Sheets with a Back that RightPanel lays over the main column: the task
  // sheet (any route), a profile, and a legacy task (only on /tasks). Home
  // renders the sidebar inline and hides the main column, so a stray store
  // value there draws nothing and must not take the bar away.
  const mainColumnHidden = trimmedPath === pathBase;
  const isTasksRoot = trimmedPath === `${pathBase}/tasks`;
  if (!mainColumnHidden && (taskModalOpen || profileOpen || (legacyTaskOpen && isTasksRoot))) return false;

  if (guestOverlayOpen) return false; // a card or an Artifact over a Guest's Home (guestShell)

  // Hide on detail routes: channel, DM, agent, human, computer, and the
  // server's own pages the server tab's popover pushes (Members, Computers,
  // Settings, each settings section and everything under them).
  // Per @stdrc 2026-04-30 #proj-uiux:c8711d2a ("tabbar is level-1; any view
  // you push into covers the navbar and shows a back button top-left").
  // /search itself is the Search tab's root (design lead 2026-10-21): no
  // Back, the bar shows with Search selected.
  const isChannelDetail = path.startsWith(`${pathBase}/channel/`) && !(guest && isGuestHomePath(path, pathBase)); // a Guest's Home
  const isDMDetail = path.startsWith(`${pathBase}/dm/`);
  const isSearchDetail = path.startsWith(`${pathBase}/search/`);
  const isAgentDetail = path.startsWith(`${pathBase}/agent/`);
  const isHumanDetail = path.startsWith(`${pathBase}/human/`);
  // Members was a tab root until 2026-10-20; now the server tab pushes it.
  const isMembersPage = path === `${pathBase}/members` || path.startsWith(`${pathBase}/members/`);
  const isComputerDetail = path.startsWith(`${pathBase}/computer/`) || path.startsWith(`${pathBase}/machine/`);
  const isComputersList = path === `${pathBase}/computers` || path.startsWith(`${pathBase}/computers/`);
  // Apps is pushed from the server tab's popover too.
  const isAppsPage = path === `${pathBase}/apps` || path.startsWith(`${pathBase}/apps/`);
  // /settings (the list) was More's root until 2026-10-22; now it is pushed
  // from the server tab like its sections.
  const isSettingsPage = trimmedPath === `${pathBase}/settings` || path.startsWith(`${pathBase}/settings/`) || path.startsWith(`${pathBase}/release-notes`) || path.startsWith(`${pathBase}/keyboard-shortcuts`) || trimmedPath === `${pathBase}/raftbench`;
  // Legacy Threads + Saved are level-2 pushes from Chat tab — same iOS NavigationView
  // model as channel/DM detail. stdrc 2026-05-02 #proj-uiux:648f8735 0a4084eb:
  // "在移动端点击 Threads 和 Saved 出来的页面，没有覆盖掉 Tab Bar" — fix to
  // match the channel/DM/agent detail behavior. /activity itself is the
  // Activity tab root (as in the mobile app), so only pushes under it hide the bar.
  const isInboxDetail = path.startsWith(`${pathBase}/activity/`);
  const isThreadsList = path === `${pathBase}/threads` || path.startsWith(`${pathBase}/threads/`);
  const isSavedList = path === `${pathBase}/saved` || path.startsWith(`${pathBase}/saved/`);
  // Drafts is a Home row on a phone, under Saved: its page is a push like Saved's.
  const isDraftsList = path === `${pathBase}/drafts` || path.startsWith(`${pathBase}/drafts/`);
  // The Artifacts home page has no phone tab: the server tab's popover pushes it (#proj-workspace:#203), like Apps.
  const isArtifactsPage = path === `${pathBase}/artifacts` || path.startsWith(`${pathBase}/artifacts/`);
  // The assistant is a Home row on a phone, so its page is a push like Saved.
  const isAssistantPage = path === `${pathBase}/assistant` || path.startsWith(`${pathBase}/assistant/`);

  if (
    isChannelDetail || isDMDetail || isSearchDetail || isAgentDetail || isHumanDetail || isMembersPage ||
    isComputerDetail || isComputersList || isAppsPage || isSettingsPage ||
    isInboxDetail || isThreadsList || isSavedList || isDraftsList || isArtifactsPage || isAssistantPage
  ) {
    return false;
  }

  // Show on tab home routes only: chat root, /activity, /tasks, /search.
  return true;
}

/** Attention dot on the Activity tab: the same signal as the desktop rail's
 *  Activity dot (LeftRail) — the accepted Activity window once loaded,
 *  otherwise the server unread summary's activityUnreadCount. Raft DS ›
 *  MobileNav / Badge: tab bar icons carry the attention dot, never a number,
 *  and never on the selected tab. */
function ActivityTabUnreadDot({ className }: { className?: string }) {
  const { formatMessage } = useIntl();
  const summaryUnreadCount = useServerStore((s) => {
    const id = s.current?.id;
    return id ? s.serverUnreadCounts[id]?.activityUnreadCount : undefined;
  });
  const [hasAcceptedWindow, hasTotalUnread, hasPreloadActiveUnread] = useInboxStore(useShallow((s) => [
    s.hasAcceptedWindow,
    // Object rows (Artifacts) count apart from the conversations' (shared activityObjectsContract).
    s.totalUnreadCount + s.objectUnreadCount > 0,
    s.activeUnreadCount > 0,
  ] as const));
  const unread = hasCurrentServerActivityUnread({ hasAcceptedWindow, hasTotalUnread, hasPreloadActiveUnread, summaryUnreadCount });
  if (!unread) return null;
  return (
    <AttentionDot
      className={className}
      role="img"
      aria-label={formatMessage({ id: "layout.leftRail.unreadActivity" })}
      data-testid="mobile-tab-activity-unread-dot"
    />
  );
}

const MOBILE_TAB_DOT_CLASS = "absolute -top-0.5 -right-1";

/** Mobile bottom tab bar — shown only on root-level views (md:hidden).
 *  Hidden when user drills into a detail view (channel, DM, thread, member detail). */
export function MobileTabBar() {
  const serverSlug = useServerStore((s) => s.current?.slug);
  const visible = useMobileTabBarVisible();
  const { selectTab, mobileTab } = useMobileNav();
  // Display-language (react-intl) — layout namespace. Called BEFORE the
  // host-shell / visibility early-returns below so the hook order is stable.
  const { formatMessage } = useIntl();
  // A toast sits above the bar (toastViewportBottom.ts).
  const toastFloorRef = useToastViewportFloor();

  // HOST-SHELL EMBED: the native WebView owns its own chrome. The app's global
  // navigation must not render inside it — checked on the RENDER PATH, not in an
  // effect, so the very first frame is already correct. (An effect would paint the
  // tab bar and then remove it: a flash the user sees while every "final DOM"
  // assertion still reports green.)
  if (isHostShell()) return null;
  if (!visible || !serverSlug) return null;

  // Phone bar (stdrc 2026-10-21, 2026-10-22): Home / Activity / Tasks /
  // Search, then the current server, in raft-ui's edge bar. The server tab
  // (MobileServerTab) took More's slot: it opens a popover, not a page, and
  // is never selected; the server's own pages open from it.
  // Search is a tab like the others (design lead 2026-10-21, "like Slack"):
  // /search is its root, it shows selected there, and it never carries a dot.

  // An unselected tab lands on its root as the user left it, filters and
  // scroll position included (useMobileNav.selectTab, useTabRootScroll);
  // pushed pages are not kept (stdrc 2026-05-09: they hide the bar).
  //
  // The selected tab (the bar shows only on roots, so its root is on screen)
  // scrolls that root to the top and does nothing else: no navigation, no
  // reset (design lead 2026-10-21). Search, at the top, focuses its field.
  // Activity is the one exception (artin 2026-10-21): it goes to the next
  // unread item below, then back to the top (ThreadsInbox, activityRetap).
  //
  // Activity also sends activity_open (stdrc's Activity question; the Home row
  // that sent it on the phone is gone).
  const tapTab = (tab: MobileTabId, active: boolean) => () => {
    trackNavEntrySelected(tab === "chat" ? "home" : tab, "mobile_tab_bar", active);
    if (tab === "activity") trackActivityOpen("mobile_tab_bar");
    if (active) {
      retapTabRoot(tab);
      return;
    }
    selectTab(tab);
  };
  const tabs = [
    { id: "chat", label: formatMessage({ id: "layout.mobileTabBar.home" }), icon: Home },
    { id: "activity", label: formatMessage({ id: "layout.mobileTabBar.activity" }), icon: Activity },
    { id: "tasks", label: formatMessage({ id: "layout.mobileTabBar.tasks" }), icon: ListTodo },
    { id: "search", label: formatMessage({ id: "layout.mobileTabBar.search" }), icon: Search },
  ] as const satisfies readonly { id: MobileTabId; label: string; icon: typeof Home }[];

  // In-flow (not fixed): the bar is the last child of the MainLayout flex
  // column, which is itself pinned to the visual viewport via #root. This
  // avoids two iOS bugs: (1) `fixed; bottom:0` ending up above the visible
  // bottom in PWA standalone because the layout viewport is taller than the
  // visible area, and (2) the fixed bar being covered by the keyboard in
  // mobile Safari because `fixed; bottom:0` anchors to layout viewport which
  // doesn't shrink with the keyboard. MobileNavRoot pads the safe area itself,
  // capped at the iPhone home-indicator inset so bad PWA/browser reports do
  // not create a large blank strip below the tabs.
  return (
    <MobileNavRoot
      aria-label={formatMessage({ id: "layout.mobileTabBar.navLabel" })}
      ref={toastFloorRef}
      className={MOBILE_TAB_BAR_CLASS}
      data-testid="mobile-tab-bar"
    >
      {tabs.map((tab) => {
        const active = mobileTab === tab.id;
        return (
          <MobileNavItem
            key={tab.id}
            selected={active}
            onClick={tapTab(tab.id, active)}
            aria-label={tab.label}
            data-testid={tab.id === "search" ? "mobile-tab-search" : undefined}
          >
            {/* The icon stays in short windows too: Raft DS › TabBar marks the
                selected tab by the yellow sticker around its icon, so hiding
                the icon (the old Brutal short-viewport adaptation) would hide
                which tab you are on. */}
            <span className={MOBILE_TAB_ICON_BOX_CLASS}>
              <tab.icon />
              {/* Raft DS › MobileNav: an attention dot, never a number, and
                  never on the selected tab. Search never has one. */}
              {tab.id === "activity" && !active && <ActivityTabUnreadDot className={MOBILE_TAB_DOT_CLASS} />}
            </span>
            <MobileNavLabel>{tab.label}</MobileNavLabel>
          </MobileNavItem>
        );
      })}
      <MobileServerTab mobileTab={mobileTab} />
    </MobileNavRoot>
  );
}

import { CreateAgentDialog } from "../agent/DeferredCreateAgentDialog";
import { usePageViewTracking } from "../../analytics/pageViews";
import { useComputerMigrationReporting } from "../../analytics/computerMigration";
import { trackNavEntrySelected } from "../../analytics/navigation";
import { trackActivityOpen } from "../../analytics/activity";
import type { MobileTabId } from "../../store/mobileNavStore";
import JointChannelLinkIntent from "../channel/JointChannelLinkIntent";
import AnnouncementModal from "../AnnouncementModal";
import UpgradeDialogHost from "../billing/DeferredUpgradeDialogHost";
import SeatJoinDialogHost from "../billing/SeatJoinDialog";
import { SearchScopeContext } from "../../features/search/searchScope";
import { isSearchOverlayEnabled, overlayCloseTarget, rememberNonSearchLocation, resolveSearchOverlayBackground } from "../../features/search/searchOverlayLocation";
import { useToastViewportFloor } from "../toastViewportBottom";

/**
 * Deep links v1 (item d): what a message link this page landed on shows
 * instead of the conversation, or null to show the conversation. A `thread`
 * naming another conversation rejects the whole link (waiting for the flag
 * rather than opening it first); a conversation that can't be read shows the
 * same "Message not found" as a missing message. Flag off: null, as before.
 */
function useMessageLinkLandingBlock(channelId: string, conversationMissing: boolean): ReactNode | null {
  const location = useLocation();
  const { formatMessage } = useIntl();
  const link = useLandedMessageLink(location.pathname, location.search);
  const target = link.target?.channelId === channelId ? link.target : null;
  if (!target) return null;
  if (isThreadMismatch(target)) {
    if (!link.resolved) return <ConversationLoading label={formatMessage({ id: "layout.main.loadingChannel" })} />;
    return link.enabled ? <MessageLinkUnavailable backTo={conversationPathOf(target)} /> : null;
  }
  if (conversationMissing && link.enabled) return <MessageLinkUnavailable backTo={serverPathOf(target)} />;
  return null;
}

/** Channel content body — used by both /channel/:channelId AND the
 *  /search master/detail layout (col 3 when slot.kind === "channel").
 *  Pulling the lookup-and-hydrate logic out of the route component lets the
 *  search-slot path render the same content without faking URL params. */
export function ChannelById({ channelId }: { channelId: string }) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  // Agent Lounge v0: a Lounge opens on the channel route; its row lives in
  // its own slice, never in `channels`.
  const lounge = useChannelStore((s) => s.loungeChannels?.find((c) => c.id === channelId));
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const [missingChannelId, setMissingChannelId] = useState<string | null>(null);
  const all = [...channels, ...dmChannels];
  const channel = all.find((c) => c.id === channelId) ?? lounge;
  // ⌘K "recent conversations" (task #113): a resolved, non-thread conversation
  // the user is looking at is by definition the most recent one. Not a
  // Lounge: ⌘K lists no Lounges (Agent Lounge v0).
  useRecordRecentConversation(channel && channel.type !== "thread" && !channel.loungeAgentId ? channel.id : null);

  // Async resolution: when `channelId` is new and not yet in stores, ensure
  // it (server fetch) and set `missingChannelId` sentinel if it can't be
  // resolved. `missingChannelId` is a pure resolution sentinel — no user
  // input lives here, so no clobber risk (verified by @铁根 msg=6b34e537).
  // Same async-arrival recognition family as PR #2532 AddMembersDialog.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!channelId || channel) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setMissingChannelId(null);
      return;
    }

    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setMissingChannelId(null);
    void ensureChannel(channelId).then((resolved) => {
      if (cancelled) return;
      if (!resolved) setMissingChannelId(channelId);
    });

    return () => {
      cancelled = true;
    };
  }, [channelId, channel, ensureChannel]);

  // While the channel hasn't been found AND we haven't given up resolving it,
  // hold the placeholder. The previous tri-state (channelStoreLoading OR
  // hydratingChannelId === channelId) flashed through ChatPanel's "Select a
  // channel" empty state on first render — before the effect could mark the
  // row as hydrating — which manifested as a flicker + layout shift when
  // opening a thread search hit whose channel row wasn't yet in the store
  // (stdrc msg=71334a2d 2026-05-27 "闪一下然后错位").
  const askingOtherServers = useOtherServerMessageLink(channelId, !channel && missingChannelId === channelId);
  const linkBlock = useMessageLinkLandingBlock(channelId, !channel && missingChannelId === channelId);
  const accessLost = useChannelAccessLost(channelId);
  const unavailable = useChannelUnavailable(channelId);
  if (askingOtherServers) {
    return <ConversationLoading label={formatMessage({ id: "layout.main.loadingChannel" })} />;
  }
  if (linkBlock) return linkBlock;
  // Removed from it while it was open: say so, not "Select a channel".
  if (accessLost) return <ChannelAccessLost />;

  if (!channel && missingChannelId !== channelId) return <ConversationLoading label={formatMessage({ id: "layout.main.loadingChannel" })} />;

  return channel ? <ChatPanel channel={channel} /> : <NoConversation unavailable={unavailable} />;
}

/** Route: /channel/:channelId */
function ChannelRoute() {
  const { channelId } = useParams<{ channelId: string }>();
  if (!channelId) return <ChatPanel channel={null} />;
  return <ChannelById channelId={channelId} />;
}

/** DM body — same pattern as ChannelById, used by both the route and the
 *  /search col-3 slot. */
export function DmById({ dmId }: { dmId: string }) {
  const { formatMessage } = useIntl();
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const [missingDmId, setMissingDmId] = useState<string | null>(null);
  const channel = dmChannels.find((c) => c.id === dmId);
  useRecordRecentConversation(channel?.id ?? null);

  // Same async-resolution sentinel pattern as ChannelById above.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!dmId || channel) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setMissingDmId(null);
      return;
    }

    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setMissingDmId(null);
    void ensureChannel(dmId).then((resolved) => {
      if (cancelled) return;
      if (!resolved) setMissingDmId(dmId);
    });

    return () => {
      cancelled = true;
    };
  }, [dmId, channel, ensureChannel]);

  const linkBlock = useMessageLinkLandingBlock(dmId, !channel && missingDmId === dmId);
  const unavailable = useChannelUnavailable(dmId);
  if (linkBlock) return linkBlock;

  if (!channel && missingDmId !== dmId) {
    return (
      <ConversationLoading label={formatMessage({ id: "layout.main.loadingChannel" })} />
    );
  }

  return channel ? <ChatPanel channel={channel} /> : <NoConversation unavailable={unavailable} />;
}

/** Route: /dm/:dmId. The viewer's own assistant's DM is its page (replace, not a push). */
function DmRoute() {
  const { dmId } = useParams<{ dmId: string }>();
  const assistantPage = useOwnAssistantPageForDm(dmId);
  if (assistantPage) return <Navigate to={assistantPage} replace />;
  if (!dmId) return <ChatPanel channel={null} />;
  return <DmById dmId={dmId} />;
}

/** A conversation's own search (its header's Search button on a phone): a
 *  pushed page over the conversation, with Back to it. Keyed by the
 *  conversation, so each one keeps its own query and results. */
function ConversationSearchRoute({ kind }: { kind: "channel" | "dm" }) {
  const { channelId, dmId } = useParams<{ channelId?: string; dmId?: string }>();
  const id = kind === "channel" ? channelId : dmId;
  const scope = useMemo(() => (id ? { kind, id } : null), [id, kind]);
  const guestRedirect = useGuestUnreadableRedirect(kind, id);
  if (!scope) return <Navigate to=".." replace />;
  if (guestRedirect) return <Navigate to={guestRedirect} replace />; // guestShell
  return (
    <SearchScopeContext value={scope}>
      <Suspense fallback={<PanelFallback />}><MessageSearchPage key={`${scope.kind}:${scope.id}`} /></Suspense>
    </SearchScopeContext>
  );
}

/** Suspense fallback for lazy-loaded main-area panels (routed full-page views:
 *  AgentRoute, MachineRoute, HumanRoute, SettingsRoute, ReleaseNotesRoute, etc.).
 *  `flex-1` fills the routes container column. */
function PanelFallback() {
  const { formatMessage } = useIntl();
  return <PanelLoading label={formatMessage({ id: "layout.main.loading" })} />;
}

/** Suspense fallback for the legacy task panel inside the task dialog (tasks route).
 *  On mobile the panel itself uses `absolute inset-0 z-cover` to cover the main
 *  content, so its fallback uses the same geometry: a `flex-1` fallback would
 *  split the mobile viewport 50/50 with the main panel, the "half-loaded agent
 *  detail" bug reported in `#proj-uiux:c8711d2a` msg=f4f07d15 (2026-05-01). */
function OverlayPanelFallback({ testId }: { testId?: string } = {}) {
  const { formatMessage } = useIntl();
  return (
    <PanelLoading
      className="absolute inset-0 z-cover flex bg-layer-canvas md:relative md:inset-auto md:z-auto md:flex-1 md:border-l md:border-line-seam"
      label={formatMessage({ id: "layout.main.loading" })}
      testId={testId}
    />
  );
}

/** While the profile panel's code loads: the panel's own box (raft-ui
 *  ProfilePanel, the same classes and remembered width), holding a spinner.
 *  It used to fill the rest of the row and then snap to the saved width when
 *  the panel arrived (task #157; Raft DS › Responsive layout, "The first frame
 *  is the settled one"). index.css folds the row around it as around the panel
 *  (`[data-profile-panel-fallback]`). */
function ProfilePanelFallback({ testId }: { testId?: string } = {}) {
  const { formatMessage } = useIntl();
  const width = useColumnWidth("detail");
  const isLg = useMediaQuery(LG_VIEWPORT_QUERY);
  const style = useMemo(() => (isLg ? profilePanelDesktopStyle(width) : undefined), [isLg, width]);
  return (
    <ProfilePanelFrame
      data-profile-panel-fallback=""
      data-testid={testId}
      edge="attached"
      className={PROFILE_PANEL_OVERLAY_CLASS}
      style={style}
    >
      <PanelLoading label={formatMessage({ id: "layout.main.loading" })} />
    </ProfilePanelFrame>
  );
}

/** While the legacy task side panel's code loads: its own box at the
 *  remembered width, as for the profile panel above (task #157). */
function LegacyTaskSidePanelFallback() {
  const { formatMessage } = useIntl();
  const width = useColumnWidth("detail");
  const isLg = useMediaQuery(LG_VIEWPORT_QUERY);
  const style = useMemo(() => (isLg ? legacyTaskSidePanelDesktopStyle(width) : undefined), [isLg, width]);
  return (
    <div data-legacy-task-panel-fallback="" className={LEGACY_TASK_SIDE_PANEL_CLASS} style={style}>
      <PanelLoading label={formatMessage({ id: "layout.main.loading" })} />
    </div>
  );
}

/** Agent body — used by both /agent/:agentId AND the /search col-3 slot.
 *
 * A peer-server agent seen through an active joint channel is never in the
 * local `agentStore` — that store only holds this server's own agents. Reading
 * only the store therefore rendered `AgentUnavailablePanel` ("terminated or no
 * longer available in this server") for every remote agent, which is the wrong
 * sentence: nothing was terminated, it simply belongs elsewhere.
 *
 * So we also consult the viewer-server-scoped projection cache that member /
 * message-sender / mention surfaces prime — the same source `ProfilePanel`
 * uses — and hand `currentServerId` to the render guard so a bounded remote
 * partial is allowed to render. We deliberately do NOT fetch this server's
 * `/agents/:id` for it: that endpoint correctly 404s on a foreign id.
 *
 * A direct route hit with no bounded projection still falls through to
 * unavailable, as do same-server incomplete/deleted agents. (task #19)
 */
function AgentById({ agentId, onBack, activityOnly }: { agentId: string; onBack?: () => void; activityOnly?: boolean }) {
  // Fine-grained selector: only re-renders when THIS agent's data changes,
  // not when other agents update (which would create a new agents array reference).
  const agent = useAgentStore(
    useCallback((s) => s.agents.find((a) => a.id === agentId), [agentId])
  );
  const currentServerId = useServerStore((s) => s.current?.id);
  const projectedAgent = agent ?? getCachedAgentProfile(currentServerId, agentId);
  if (!canRenderAgentDetail(projectedAgent, currentServerId)) {
    return <Suspense fallback={<PanelFallback />}><AgentUnavailablePanel /></Suspense>;
  }
  return <Suspense fallback={<PanelFallback />}><AgentDetailPanel agent={projectedAgent} onBack={onBack} activityOnly={activityOnly} /></Suspense>;
}

/** Route: /agent/:agentId */
function AgentRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const membersPanel = useMembersProfileRedirect("agent", agentId);
  return agentId ? membersPanel ?? <AgentById agentId={agentId} /> : null;
}

/** Route: /agent/:agentId/activity — the activity log alone for the mobile app's Activity tab (embedded WebView,
 *  which draws the header and tabs natively); on desktop, the Members page's panel on its Activity tab. */
function AgentActivityRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const membersPanel = useMembersProfileRedirect("agent", agentId, "activity");
  return agentId ? membersPanel ?? <AgentById agentId={agentId} activityOnly /> : null;
}

/** Computer body — used by both the computer's own page (/computer/:machineId) and the /search col-3 slot. */
function MachineById({ machineId }: { machineId: string }) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const machine = machines.find((m) => m.id === machineId);
  if (!machine) {
    return (
      <AppEmptyState className="flex-1" icon={<MonitorX />} title={formatMessage({ id: "layout.main.computerNotFound" })} />
    );
  }
  return <Suspense fallback={<PanelFallback />}><MachineDetailPanel machine={machine} /></Suspense>;
}

/** Route: /computer/:machineId (and the legacy /machine/:machineId).
 *  From 768px and outside the host app's WebView, a computer opens in the
 *  side panel beside the card wall (Raft DS › Navigation, "Opening an item"),
 *  so an old link or bookmark lands there: /computers?profile=computer:<id>.
 *  Otherwise it is the computer's own page: on a phone with Back, and in the
 *  host WebView under the native shell's own header, which has its Back
 *  (PanelHeader draws none there). */
function MachineRoute() {
  const { machineId } = useParams<{ machineId: string }>();
  const location = useLocation();
  const server = useServerStore((s) => s.current);
  const wide = useMediaQuery(COMPUTER_PANEL_QUERY);
  const hostShell = isHostShell();
  if (!machineId) return null;
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
  }
  if (wide && !hostShell && server?.slug) {
    const params = new URLSearchParams(location.search);
    params.set("profile", computerProfileParam(machineId));
    return <ComputerPanelRedirect to={`/s/${server.slug}/computers?${params.toString()}`} machineId={machineId} />;
  }
  return <MachineById machineId={machineId} />;
}

/** Human body — used by both /human/:userId AND the /search col-3 slot. */
function HumanById({ userId, onBack }: { userId: string; onBack?: () => void }) {
  const { formatMessage } = useIntl();
  const members = useServerStore((s) => s.members);
  const currentServerId = useServerStore((s) => s.current?.id);
  const human = members.find((m) => m.userId === userId);
  const [fallbackHuman, setFallbackHuman] = useState<HumanProfile | null>(null);
  const [fallbackLoading, setFallbackLoading] = useState(false);

  // Async-loader: fetch fallback human profile when `userId` / `currentServerId`
  // change. Both fallbackHuman + fallbackLoading are server-fetch derived,
  // not user-controlled. Same async-loader FP family as PR #2530's
  // useChannelMembers / InviteAcceptPage loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    if (!userId || !currentServerId) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setFallbackHuman(null);
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setFallbackLoading(false);
      return;
    }
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackLoading(true);
    void api
      .get(`/servers/${currentServerId}/members/${userId}/profile`)
      .then(({ data }) => {
        if (!cancelled) setFallbackHuman(data as HumanProfile);
      })
      .catch(() => {
        if (!cancelled) setFallbackHuman(null);
      })
      .finally(() => {
        if (!cancelled) setFallbackLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentServerId, userId]);

  const resolvedHuman = resolveHumanProfile(human, fallbackHuman);
  if (resolvedHuman) {
    // `key={resolvedHuman.userId}` forces a fresh remount when the panel
    // switches to a different human — every entity-scoped state in
    // HumanDetailPanel resets to its initializer cleanly, no in-component
    // mirror-prop effect needed.
    return <Suspense fallback={<PanelFallback />}><HumanDetailPanel key={resolvedHuman.userId} human={resolvedHuman} onBack={onBack} /></Suspense>;
  }
  if (fallbackLoading) return <PanelFallback />;
  return (
    <AppEmptyState className="flex-1" icon={<UserX />} title={formatMessage({ id: "layout.main.humanNotFound" })} />
  );
}

/** Route: /human/:userId */
function HumanRoute() {
  const { userId } = useParams<{ userId: string }>();
  const membersPanel = useMembersProfileRedirect("human", userId);
  return userId ? membersPanel ?? <HumanById userId={userId} /> : null;
}

/** Route: /settings/:tab?/* */
function SettingsRoute() {
  const { tab } = useParams<{ tab: string }>();
  const location = useLocation();
  const server = useServerStore((s) => s.current);
  // The server's Apps moved out of Settings into their own page (#proj-apps
  // task #22): an old Applications link, deep links included
  // (?permission_updates=1, ?marketplace_app=), opens it. A guest's
  // Applications holds only their own link previews and stays, and so does the
  // native host shell's embedded settings page.
  if (isSettingsApplicationsSlug(tab) && server && server.role !== "guest" && !isHostShell()) {
    return <Navigate to={`/s/${server.slug}/apps${location.search}${location.hash}`} replace />;
  }
  const canonicalSlug = legacySettingsRouteRedirectSlug(tab);
  if (canonicalSlug) {
    return (
      <Navigate
        to={`${location.pathname.replace(/\/settings\/[^/]+\/?$/, `/settings/${canonicalSlug}`)}${location.search}${location.hash}`}
        replace
      />
    );
  }
  return (
    <Suspense fallback={<PanelFallback />}>
      <SettingsPanel
        tab={tab}
        accountPasswordChangeIntent={tab === "account" && isChangePasswordSettingsIntent(location.search)}
      />
    </Suspense>
  );
}

/**
 * Route: /migrations. The server's agent migration log (owners and admins):
 * every move between computers as a chord diagram,
 * with filters kept in the address.
 */
function MigrationLogRoute() {
  const server = useServerStore((s) => s.current);
  const serverSlug = server?.slug;
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const { formatMessage } = useIntl();
  const mobileBackProps = useMemo(() => ({
    "data-testid": "migration-log-mobile-back",
    title: formatMessage({ id: "agent.migrationLog.back" }),
  }), [formatMessage]);
  if (server && server.role !== "owner" && server.role !== "admin") {
    return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="migration-log-route">
      <PanelHeader title={formatMessage({ id: "agent.migrationLog.title" })} onMobileBack={onMobileBack} mobileBackProps={mobileBackProps} />
      <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas">
        <Suspense fallback={<PanelFallback />}>
          <MigrationLogPage />
        </Suspense>
      </div>
    </div>
  );
}

/** Route: /release-notes */
function ReleaseNotesRoute() {
  return <Suspense fallback={<PanelFallback />}><ReleaseNotesPanel /></Suspense>;
}

/** Route: /saved */
function SavedRoute() {
  return <Suspense fallback={<PanelFallback />}><SavedPanel /></Suspense>;
}

/** Route: /drafts, behind drafts_section_v0 (off: back to the server's home). */
function DraftsRoute() {
  const serverSlug = useServerStore((s) => s.current?.slug);
  const drafts = useServerFeatureFlag(DRAFTS_SECTION_FLAG_KEY);
  if (drafts.resolved && !drafts.enabled) {
    return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
  }
  if (!drafts.enabled) return <PanelFallback />;
  return <Suspense fallback={<PanelFallback />}><DraftsPanel /></Suspense>;
}

/**
 * Route: /artifacts — the Artifacts home page (S7), behind workspace_artifacts_v0 (the page says so when it is off).
 * `?artifact=<id>` is the Artifact open over the page, `&version=<n>` at a
 * pinned version (useArtifactOpenAddress, #proj-workspace:#237): a row of the
 * page pushes it, Back and the viewer's close take it away, and a reload or a
 * copied address opens it again. The canonical link `/artifacts/<id>` of a
 * server not in the reader's list yet replaces itself with it, adding
 * `&from=link`, which is replaced away once read. An Activity row or a Search
 * hit opens it in that page's detail slot, a message's card beside its channel,
 * each at the same address on its page (artifactOpenAddress.ts).
 */
function ArtifactsRoute() {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const address = useArtifactOpenAddress();
  return (
    <Suspense fallback={<PanelFallback />}>
      <ArtifactsDashboard serverId={serverId} onMobileBack={onMobileBack} address={address} />
    </Suspense>
  );
}

/** Route: /apps — the server's Apps (#proj-apps task #22). Not for guests, like Members and Computers. */
function AppsRoute() {
  const server = useServerStore((s) => s.current);
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
  }
  return <Suspense fallback={<PanelFallback />}><AppsPage /></Suspense>;
}


/** Route: /search col-3 host. When the search slot is open, MainLayout puts
 *  MessageSearchPage in the sidebar slot (col 2) and renders this component
 *  in the main routes container (col 3) — dispatched on slot.kind to the
 *  same body components the dedicated /channel/:id, /dm/:id, /agent/:id,
 *  /human/:userId, /computer/:machineId routes use, so col 3 is the SAME picked-entity surface
 *  the user would see by direct navigation. When the slot is null, this
 *  renders MessageSearchPage in the routes container so /search alone
 *  (without ?open=) still shows the full-width search page. */
// Dispatch an open content slot to the col-3 entity surface — the SAME body
// components the dedicated /channel/:id, /dm/:id, /agent/:id, /human/:userId, /computer/:machineId
// routes use, so col 3 is identical to direct navigation. Shared by both the
// /search master/detail (SearchContentRoute) and the /inbox Activity one
// (InboxContentRoute) so their col-3 behavior is byte-identical.
function renderContentSlot(slot: SearchContentSlot, closeSlot: () => void) {
  if (slot.kind === "channel") return <ChannelById channelId={slot.id} />;
  if (slot.kind === "dm") return <DmById dmId={slot.id} />;
  // Agent/human search hits are detail pages inside the master/detail stack.
  // Their structural Back control closes the picked slot and restores the
  // exact Search/Activity list state; falling back to /members would leave
  // the surface that actually opened the profile.
  if (slot.kind === "agent") return <AgentById agentId={slot.id} onBack={closeSlot} />;
  if (slot.kind === "human") return <HumanById userId={slot.id} onBack={closeSlot} />;
  if (slot.kind === "machine") return <MachineById machineId={slot.id} />;
  // Activity and Search draw an Artifact's slot themselves (ArtifactContentSlot).
  if (slot.kind === "artifact") return null;
  if (slot.kind === "task") return <TaskContentSlot slot={slot} closeSlot={closeSlot} />;
  // kind === "thread" — first-principles fix per stdrc 2026-05-28 (msg=41f5c906
  // / msg=138867ba). A thread is NOT a channel — it's a parent-message-anchored
  // sub-conversation. Rendering ChannelById/ChatPanel for the thread channel
  // showed a single floating reply with the wrong chrome. The right surface IS
  // ThreadPanel — the same component the right-panel overlay uses — driven by
  // threadStore. The col-3 parent flex column is itself the column container
  // (no width/border/resize chrome needed; that's the chat col-4's job, not
  // col-3's). The opener (MessageSearchPage.openResult / ThreadsInbox.handleOpen)
  // seeds threadStore at click time, and useRightPanelUrlSync mirrors `?thread=`
  // so cold-load deeplinks restore threadStore (col-4 overlay never appears on
  // these routes — RightPanel's content-route guard returns null structurally).
  return <ContentSlotThreadPanel closeSlot={closeSlot} />;
}

/**
 * An Artifact opened from its Activity row (xxchan, Remy), or from a Search
 * hit (#proj-workspace:#104): its viewer in the
 * main area beside the list, as a conversation row opens its conversation; on
 * a phone a page pushed in place of the list, its Back returning to it
 * (useSearchContentUrlSync pushes and pops the entry). Its address is the
 * Artifact address (`?artifact=<id>`, `&version=`, `&review=`; artifactOpenAddress.ts):
 * a version picked in the viewer replaces `&version=` in the same entry.
 */
function ArtifactContentSlot({ slot, closeSlot, nothingOpen = <ActivityNothingOpen />, source = "activity" }: {
  slot: SearchContentSlot;
  closeSlot: () => void;
  /** Desktop, with Artifacts off: what the main area says instead. */
  nothingOpen?: ReactNode;
  source?: "activity" | "search";
}) {
  const masterDetail = useMediaQuery(ACTIVITY_MASTER_DETAIL_QUERY);
  const artifacts = useServerFeatureFlag(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  const close = useCallback(() => {
    closeSlot();
    if (!masterDetail) return;
    // Closed beside the list (Esc, its X): focus goes back to the Artifact's row.
    focusActivityRowAfterClose(`object:artifact:${slot.id}`);
  }, [closeSlot, masterDetail, slot.id]);
  // Show All Comments: the same Artifact open without its review (`&review=` leaves the address).
  const showAllComments = useCallback(() => {
    useSearchContentStore.setState((state) => {
      if (state.slot?.kind !== "artifact" || state.slot.review === undefined) return state;
      const { review: _shown, ...rest } = state.slot;
      return { slot: rest };
    });
  }, []);
  // The review again, from the comment list's Filter button: back in the slot (`&review=`).
  const showReview = useCallback((review: ArtifactReviewId) => useSearchContentStore.setState((state) => (
    state.slot?.kind === "artifact" && state.slot.id === slot.id ? { slot: { ...state.slot, review } } : state)), [slot.id]);
  // A version picked in the viewer: the slot's (the store → URL sync replaces `&version=`, the entry kept).
  const showVersion = useCallback((version: number | null) => {
    useSearchContentStore.setState((state) => {
      if (state.slot?.kind !== "artifact" || state.slot.id !== slot.id) return state;
      const { version: _shown, ...rest } = state.slot;
      return { slot: version === null ? rest : { ...rest, version } };
    });
  }, [slot.id]);
  // workspace_artifacts_v0: an address naming an Artifact on a server where they are off opens nothing.
  if (!artifacts.resolved) return <PanelFallback />;
  if (!artifacts.enabled) return masterDetail ? nothingOpen : null;
  return (
    <Suspense fallback={<PanelFallback />}>
      <ArtifactActivityViewer id={slot.id} version={slot.version} review={slot.review} comment={slot.comment} onShowAllComments={showAllComments} onShowReview={showReview} onShowVersion={showVersion} covering={!masterDetail} onClose={close} source={source} />
    </Suspense>
  );
}

function SearchContentRoute() {
  const slot = useSearchContentStore((s) => s.slot);
  const closeSlot = useSearchContentStore((s) => s.close);
  const openThreadHere = useThreadInDetailSlotOpener();
  if (!slot) return <Suspense fallback={<PanelFallback />}><MessageSearchPage /></Suspense>;
  // An Artifact hit: its viewer beside the results, as Activity's Artifact rows open beside its list.
  if (slot.kind === "artifact") return <ArtifactContentSlot slot={slot} closeSlot={closeSlot} nothingOpen={null} source="search" />;
  return <DetailSlotThreadContext.Provider value={opensThreadsInPlace(slot) ? openThreadHere : null}>{renderContentSlot(slot, closeSlot)}</DetailSlotThreadContext.Provider>;
}

/** A thread link in a thread or a task shown in the detail slot opens there, in its place (detailSlotThread.ts). */
function opensThreadsInPlace(slot: SearchContentSlot): boolean {
  return slot.kind === "thread" || slot.kind === "task";
}

/** Route: /activity — Activity surface, rendered as the search-style
 *  master/detail (no slot → full-width list; slot → picked entity in col 3,
 *  with the list hosted in col 2 by the master/detail layout). The
 *  rail-vs-sidebar placement A/B was dropped 2026-06-30 (stdrc) — Activity is
 *  always the rail master/detail surface now.
 *
 *  On a phone (below ACTIVITY_MASTER_DETAIL_QUERY, the desktop width) the
 *  picked entity is a page pushed in place of the list, still on /activity:
 *  its header Back closes the slot and returns to the list
 *  (ContentSlotBackContext for a conversation; ThreadPanel and the profiles
 *  already take closeSlot). */
function InboxContentRoute() {
  const slot = useSearchContentStore((s) => s.slot);
  const closeSlot = useSearchContentStore((s) => s.close);
  const masterDetail = useMediaQuery(ACTIVITY_MASTER_DETAIL_QUERY);
  const openThreadHere = useThreadInDetailSlotOpener();
  // The route stays mounted for the whole visit to Activity, whichever of the
  // list and the opened conversation it shows (the list may sit beside it in
  // col 2, or on a phone not be mounted at all): a hold on a reopened
  // conversation still on screen survives the layout switching under it.
  useActivityVisitSurface();
  if (!slot) {
    // Desktop: the list sits in col 2 (MainLayout) even with nothing open, so
    // the main area says so (stdrc). A phone's list is the page itself.
    if (masterDetail) return <ActivityNothingOpen />;
    return <Suspense fallback={<PanelFallback />}><ThreadsInbox /></Suspense>;
  }
  // `data-activity-detail`: acting in here reads a conversation Activity reopened on its own (autoReadHold).
  const detail = slot.kind === "thread"
    ? <ActivityThreadContentRoute slot={slot} closeSlot={closeSlot} />
    : slot.kind === "artifact"
      ? <ArtifactContentSlot slot={slot} closeSlot={closeSlot} />
      : renderContentSlot(slot, closeSlot);
  return (
    <ContentSlotBackContext.Provider value={masterDetail ? null : closeSlot}>
      <DetailSlotThreadContext.Provider value={opensThreadsInPlace(slot) ? openThreadHere : null}>
        <div data-activity-detail className="contents">{detail}</div>
      </DetailSlotThreadContext.Provider>
    </ContentSlotBackContext.Provider>
  );
}

/** Desktop Activity's main area while nothing is open beside the list. */
function ActivityNothingOpen() {
  const { formatMessage } = useIntl();
  return (
    <AppEmptyState
      className="flex-1"
      icon={<MessageIcon />}
      title={formatMessage({ id: "layout.main.activityNothingOpenTitle" })}
      // The main area's only content, so its title is a heading (Raft DS › EmptyState).
      titleHeading="h2"
      description={formatMessage({ id: "layout.main.activityNothingOpenDescription" })}
      data-testid="activity-nothing-open"
    />
  );
}

export function ActivityThreadContentRoute({ slot, closeSlot }: { slot: SearchContentSlot; closeSlot: () => void }) {
  const { formatMessage } = useIntl();
  const singlePaneBack = useContentSlotBack();
  const consumeMessageFocus = useSearchContentStore((s) => s.consumeMessageFocus);
  type ActivityThreadIdentity = {
    parentChannelId: string;
    parentMessageId: string;
    threadChannelId: string;
  };
  const threadItem = useInboxStore((s) => {
    const item = s.items.find((candidate) => candidate.kind === "thread" && candidate.threadChannelId === slot.id);
    return item?.kind === "thread" ? item : null;
  });
  const openThreadChannelId = useThreadStore((s) => s.openThreadChannelId);
  const openParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const openParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const loaded = useInboxStore((s) => s.loaded);
  const loading = useInboxStore((s) => s.loading);
  const loadInbox = useInboxStore((s) => s.loadInbox);
  const retainedThreadIdentityRef = useRef<ActivityThreadIdentity | null>(null);
  const openThreadIdentity = useMemo(() => {
    if (openThreadChannelId !== slot.id || !openParentChannelId || !openParentMessageId) return null;
    return {
      parentChannelId: openParentChannelId,
      parentMessageId: openParentMessageId,
      threadChannelId: openThreadChannelId,
    };
  }, [openParentChannelId, openParentMessageId, openThreadChannelId, slot.id]);

  useEffect(() => {
    if (!loaded && !loading) {
      void loadInbox({ reset: true, reason: "initial" });
    }
  }, [loadInbox, loaded, loading]);

  const currentThreadIdentity = threadItem
    ? {
        parentChannelId: threadItem.parentChannelId,
        parentMessageId: threadItem.parentMessageId,
        threadChannelId: threadItem.threadChannelId,
      }
    : openThreadIdentity;
  if (currentThreadIdentity) {
    retainedThreadIdentityRef.current = currentThreadIdentity;
  }
  const retainedSlotThreadIdentity = retainedThreadIdentityRef.current?.threadChannelId === slot.id
    ? retainedThreadIdentityRef.current
    : null;
  const threadIdentity = currentThreadIdentity ?? retainedSlotThreadIdentity;
  const parentChannelId = threadIdentity?.parentChannelId;
  const parentMessageId = threadIdentity?.parentMessageId;
  const threadChannelId = threadIdentity?.threadChannelId;
  const focusedMessageId = slot.messageId ?? null;
  // Each open of the slot is a jump of its own (a second open of the same
  // message locates it again).
  const focusNonce = useSearchContentStore((s) => s.openNonce);
  const panelThreadIdentity = useMemo(() => (
    parentChannelId !== undefined && parentMessageId !== undefined && threadChannelId !== undefined
      ? { parentChannelId, parentMessageId, threadChannelId, focusedMessageId, focusNonce }
      : null
  ), [focusNonce, focusedMessageId, parentChannelId, parentMessageId, threadChannelId]);
  const handleFocusedMessageConsumed = useCallback(
    () => consumeMessageFocus("thread", slot.id),
    [consumeMessageFocus, slot.id],
  );

  if (!panelThreadIdentity) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-layer-canvas">
        <PanelHeader
          title={formatMessage({ id: "message.threadPanel.thread" })}
          containerProps={SHRINK_PANEL_HEADER_CONTAINER_PROPS}
          onMobileBack={singlePaneBack ?? undefined}
          backButtonVisibility="always"
        />
        {loaded ? (
          <AppEmptyState
            className="flex-1"
            icon={<ThreadIcon />}
            title={formatMessage({ id: "layout.main.threadNotInActivity" })}
          />
        ) : (
          <PanelLoading label={formatMessage({ id: "common.loading" })} />
        )}
      </div>
    );
  }

  return (
    <ThreadPanel
      presentation="side"
      // The Activity list on the left draws the column divider (task #110).
      edge="inset"
      threadIdentity={panelThreadIdentity}
      onFocusedMessageConsumed={handleFocusedMessageConsumed}
      onClose={closeSlot}
    />
  );
}

/** Route: * — redirect to first channel (a Guest's only one) */
function DefaultRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { navigator } = useContext(NavigationContext);
  const channels = useChannelStore((s) => s.channels);
  const loading = useChannelStore((s) => s.loading);
  const slug = useServerStore((s) => s.current?.slug);
  const guest = useIsGuest(); // no channel list to show instead: always into its channel
  // A window opened narrow (channel list as the page) and then widened with a
  // mouse must still enter the first channel instead of staying on an empty
  // "Select a channel". A phone rotated to landscape (>= 768px too) must not:
  // the reader is on their channel list, so only a fine pointer follows the
  // width live; otherwise the width at mount decides.
  const [isDesktopAtMount] = useState(() => window.matchMedia(ROOT_REDIRECT_MEDIA_QUERY).matches);
  const isDesktopNow = useMediaQuery(ROOT_REDIRECT_MEDIA_QUERY);
  const finePointer = useMediaQuery("(pointer: fine)");
  const isDesktop = isDesktopAtMount || (isDesktopNow && finePointer);
  const disclosureRestoreState = useMemo(() => buildSidebarDisclosureRestoreState(), []);
  const suppressDefaultRouteRedirect =
    (location.state as { suppressDefaultRouteRedirect?: unknown } | null)?.suppressDefaultRouteRedirect === true;
  // From the list only: a row ensured before it (the root's guess, preloadServerRoute) is not where it lands.
  const defaultChannelId = !loading ? channels[0]?.id ?? null : null;
  const defaultChannelPath = slug && defaultChannelId ? `/s/${slug}/channel/${defaultChannelId}` : null;
  // On mobile, don't auto-redirect — the sidebar (channel list) is shown inline
  // as the main content via the master-detail layout in MainLayout.
  const shouldRedirect = Boolean(
    (isDesktop || guest)
    && defaultChannelPath
    && !suppressDefaultRouteRedirect
    && location.pathname !== defaultChannelPath,
  );
  // Not <Navigate replace>: BrowserRouter pushes history immediately but
  // renders the new location in a transition, so this route can still render
  // for /s/<a> after the user already navigated on (switching servers twice
  // quickly). A replace then would overwrite that newer entry and bounce them
  // back to <a>. Redirect only while history still is the location we
  // rendered for.
  useEffect(() => {
    if (!shouldRedirect || !defaultChannelPath) return;
    // The router's own history, not window.location: under MemoryRouter
    // (tests, embedded shells) window.location never moves, and reading it
    // would suppress every redirect. BrowserRouter's history reads the URL.
    const live = (navigator as { location?: { pathname?: string } }).location?.pathname;
    if (live !== undefined && live !== location.pathname) return;
    if (defaultChannelId) rememberRootConversation(useAuthStore.getState().user?.id, useServerStore.getState().current?.id, defaultChannelId);
    movePageLanding(location.pathname, defaultChannelPath); // a landing on /s/<slug> keeps its open-in-app offer
    navigate(defaultChannelPath, { replace: true, state: disclosureRestoreState });
  }, [shouldRedirect, defaultChannelPath, defaultChannelId, location.pathname, navigator, navigate, disclosureRestoreState]);
  if (shouldRedirect) return null;
  // A wildcard test harness (or an embedding shell) can keep this element
  // mounted after the redirect reaches the canonical channel route. Do not
  // render a second ChatPanel in that settled state; the real channel route
  // owns the surface, and returning null also prevents the redirect effect
  // from retriggering on every location update.
  if ((isDesktop || guest) && defaultChannelPath && location.pathname === defaultChannelPath && !suppressDefaultRouteRedirect) {
    return null;
  }
  if (loading) return null;
  if (guest) return defaultChannelPath ? null : <GuestNoChannel />; // no sidebar: told only when it has no channel
  return <ChatPanel channel={null} />;
}

// Computers route — on desktop the Sidebar owns the Computers rail with
// the list of machines, and the main panel shows the Computers empty state.
// On mobile the Sidebar is not rendered for /computers (removed from
// isMobileMasterRoute 2026-05-01 per stdrc msg 2a500cb7), so the main
// panel here IS the page the user sees: MobileComputersPanel renders a
// proper h-[62px] yellow navbar + cream body + cards, matching the
// other mobile panels (Tasks / Saved / Threads / Settings sub-pages).
function ComputersRoute() {
  const server = useServerStore((s) => s.current);
  // Opening Computers (desktop rail list or the phone page) sees every
  // computer's current attention state: the rail / popover dots go out, the
  // rows keep showing the state (raft-design #620 "Attention dots").
  useMarkComputerAttentionSeen(server?.role !== "guest");
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
  }
  // Host-shell embed (`?embed=raft-settings-v1&shell=host`) FORCES the mobile panel
  // regardless of viewport width. Reason (@MingQi): a native WebView on a tablet or in
  // landscape can exceed the md breakpoint; without this guard, the route would fall
  // through to `<ChatPanel>` and the WebView would render the wrong page. Mobile can't
  // reliably fake a narrow viewport from its side, so the host-shell decision must be
  // authoritative in web — see PR #4799.
  const forceMobilePanel = isHostShell() || !isDesktop;
  if (forceMobilePanel) return <MobileComputersPanel />;
  // The rack overview, a full page beside the rail (no sidebar: shellRouteLayout).
  return <Suspense fallback={<PanelFallback />}><ComputersRackOverview /></Suspense>;
}

// /more — the phone's More tab (2026-10-20 to 2026-10-22). The server tab took
// its place, and what More held (Members, Computers, Settings) opens from the
// server tab's popover, so an old /more link lands on the server's Home, on a
// phone and on desktop alike.
export function MoreRoute() {
  const serverSlug = useServerStore((s) => s.current?.slug);
  return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
}

/** Thread panel wrapper — only renders if a thread is open. Owns the column
 *  container chrome (positioning / width / resize / border) appropriate for
 *  the host. ThreadPanel itself is column-agnostic per stdrc 2026-05-28
 *  msg=138867ba: page object lives in a column container; the same surface
 *  renders identically across hosts.
 *
 *  - "side"         — chat col 4: full-row overlay until the chat row can fit
 *                     both pane minimums; otherwise an inline column with a
 *                     persisted width and left-edge resize handle.
 *  - "modal"        — bordered card with standard shadow-float, fixed centered size.
 *                     Caller wraps in TaskDialogShell for the scrim + Esc.
 *  - "mobile-modal" — full-screen overlay (no dialog wrapper); back chevron is
 *                     the close affordance.
 */
/** The task whose host message anchors this thread, if any.
 *
 *  Opening a v1 task IS opening its message's thread (`TasksPanel.openTask`),
 *  so the task is found by matching the thread's parent message rather than by
 *  any task-specific routing state. Returns null for an ordinary thread, which
 *  is what keeps the Properties block off non-task threads. */
function useThreadHostTask(parentMessageId: string | null) {
  const parentChannelId = useThreadStore((s) => s.openParentChannelId);
  const tasks = useTaskStore((s) => s.tasks);
  const serverTasks = useTaskStore((s) => s.serverTasks);
  const parentChannelTasks = useTaskStore((s) => selectChannelTaskBucket(s, parentChannelId));
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const parentLoaded = useTaskStore((s) => (parentChannelId ? s.loadedByChannelId[parentChannelId] ?? false : false));
  const parentLoading = useTaskStore((s) => (parentChannelId ? s.loadingByChannelId[parentChannelId] ?? false : false));

  // `tasks` only ever holds the channel the user currently has open, and
  // `serverTasks` is built from `type in ('channel','joint')` — DM and private
  // channels are excluded from it by design, because a server-wide board must
  // not list what happens in someone's DMs.
  //
  // Both of those are fine on their own, and together they left a hole: open a
  // DM task's thread from anywhere that is not that DM — Activity, another
  // channel — and neither source can supply the task. `hostTask` comes back
  // null, so TaskModalHead never mounts, and TaskModalHead is what renders
  // TaskProperties, which is the only place the status can be changed. The user
  // gets a bare thread viewer with no task affordance at all (@artin, task #44).
  //
  // So resolve from the parent channel's own bucket too, loading it on demand.
  // This costs nothing in the common case: a thread opened inside the channel
  // you are reading was already loaded by ChatPanel, so `parentLoaded` is true
  // and no request is made.
  useEffect(() => {
    loadThreadParentTasksIfNeeded({
      parentMessageId,
      parentChannelId,
      parentLoaded,
      parentLoading,
      loadTasks,
    });
  }, [loadTasks, parentChannelId, parentLoaded, parentLoading, parentMessageId]);

  return useMemo(
    () => resolveThreadHostTask(parentMessageId, { tasks, parentChannelTasks, serverTasks }),
    [parentMessageId, tasks, parentChannelTasks, serverTasks],
  );
}

/** The `#` is markup, not translatable copy — kept out of JSX so the i18n
 *  literal-disposition guard does not count it. */
function channelSigil(name: string): string {
  return `#${name}`;
}

/** Persistent bar for a task modal: where you are, and the way out.
 *
 *  It exists because suppressing ThreadPanel's header — needed so the modal
 *  does not announce itself as a thread — also removed the only visible close
 *  affordance. Backdrop and ESC still worked, but a dialog with no X is not a
 *  closable dialog.
 *
 *  Channel lives here rather than in the scrolling head so it survives scroll:
 *  the bar is the part that must always answer "where am I, and how do I get
 *  out". The title stays in the scroll region because a long one cannot be
 *  bounded by a fixed bar. */
const NON_INTERACTIVE_TOOLTIP_PROPS = { className: "pointer-events-none" };

function TaskModalBar({
  task,
  onClose,
  onViewInThread,
  mobile = false,
}: {
  task: Task;
  onClose: () => void;
  /** Absent when the task has no thread to show (legacy tasks, or a task
   *  whose anchor is itself a thread reply). */
  onViewInThread?: () => void;
  mobile?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    // raft-ui PanelHeader owns the edges, as on every other panel head: the
    // first and last icon boxes sit on the content margin and mirror
    // (headEdges.ts). Its row is centred, so the X is
    // weighed against the whole two-line block, not its first line.
    <PanelHead>
      {mobile && (
        <PanelAction
          onClick={onClose}
          aria-label={formatMessage({ id: "task.modal.close" })}
          data-testid="task-modal-mobile-back"
        >
          <ArrowLeft />
        </PanelAction>
      )}
      {/* Two lines so the bar has body: where this lives, then what it is.
          Both are stable facts — the task's own title stays in the scrolling
          body, because a long one cannot be bounded by a fixed bar. */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-caption font-bold text-foreground-muted">
          {channelSigil(task.channelName || formatMessage({ id: "task.properties.unknownChannel" }))}
        </div>
        <div className="truncate text-subhead font-bold" data-testid="task-modal-bar-label">
          {formatMessage({ id: "task.modal.taskWithNumber" }, { taskNumber: task.taskNumber })}
        </div>
      </div>
      {(onViewInThread || !mobile) && (
        <PanelActions>
          {/* Icon-only, the same quiet control as Close beside it — the shape
              the legacy task panel's "View in channel" already uses (Artea). */}
          {onViewInThread && (
            <Tooltip
              content={formatMessage({ id: "task.modal.viewInThread" })}
              disableHoverablePopup
              contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
            >
              <PanelAction
                onClick={onViewInThread}
                aria-label={formatMessage({ id: "task.modal.viewInThread" })}
                data-testid="task-modal-view-in-thread"
              >
                <ThreadIcon />
              </PanelAction>
            </Tooltip>
          )}
          {!mobile && (
            <PanelAction
              onClick={onClose}
              aria-label={formatMessage({ id: "task.modal.close" })}
              data-testid="task-modal-close"
            >
              <X />
            </PanelAction>
          )}
        </PanelActions>
      )}
    </PanelHead>
  );
}

function ThreadPanelWrapper({ presentation = "side" }: { presentation?: "side" | "modal" | "mobile-modal" }) {
  // Task v2: a dialog keyed by the task (its own conversation, no parent
  // message). Only `openTaskConversation` fills that slot, behind the flag.
  const taskConversationOpen = useThreadStore((s) => !!s.taskModal?.taskId && !s.taskModal.parentMessageId);
  if (presentation !== "side" && taskConversationOpen) {
    return <TaskConversationDialogHost presentation={presentation} />;
  }
  return <MessageThreadPanelWrapper presentation={presentation} />;
}

/** Task v2 dialog host: closes the slot (desktop) or consumes the history
 *  entry that opened it (phone), as the message-keyed task sheet does. */
function TaskConversationDialogHost({ presentation }: { presentation: "modal" | "mobile-modal" }) {
  const closeTaskModal = useThreadStore((s) => s.closeTaskModal);
  const mobileTaskBack = useMobileBack(closeTaskModal, closeTaskModal);
  return (
    <TaskConversationDialog
      presentation={presentation}
      onClose={presentation === "mobile-modal" ? mobileTaskBack : closeTaskModal}
    />
  );
}

function MessageThreadPanelWrapper({ presentation = "side" }: { presentation?: "side" | "modal" | "mobile-modal" }) {
  const openParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const taskModal = useThreadStore((s) => s.taskModal);
  const closeThread = useThreadStore((s) => s.closeThread);
  const closeTaskModal = useThreadStore((s) => s.closeTaskModal);
  // Dialog presentations render the task surface, whose identity lives in the
  // independent taskModal slot (task #699) — or, on the /tasks route, an
  // ordinary intent=thread open rendered as a modal, which keeps the store's
  // open* fields. The slot wins when present.
  const isTaskSurface = presentation !== "side";
  const parentMessageId = isTaskSurface
    ? taskModal?.parentMessageId ?? openParentMessageId
    : openParentMessageId;
  const surfaceThreadIdentity = useMemo(() => isTaskSurface && taskModal
    ? {
        parentMessageId: taskModal.parentMessageId,
        parentChannelId: taskModal.parentChannelId ?? "",
        threadChannelId: taskModal.threadChannelId,
        focusedMessageId: taskModal.focusedMessageId,
        focusNonce: taskModal.focusNonce,
      }
    : undefined, [isTaskSurface, taskModal]);
  const closeSurface = isTaskSurface && taskModal ? closeTaskModal : closeThread;
  const hostTask = useThreadHostTask(parentMessageId);
  const nav = useAppNavigate();
  const openThread = useThreadStore((s) => s.openThread);
  const threadChannelId = taskModal?.threadChannelId ?? null;
  // "View in thread": leave the task surface for the ordinary side thread of
  // the same message — the reading the thread icon gives. Same two steps as a
  // thread ref (utils/refTarget.ts): land on the message, then open its
  // replies with the THREAD intent, so this never re-opens the task modal.
  const viewInThread = useCallback(() => {
    if (!hostTask) return;
    closeSurface();
    if (hostTask.channelType === "dm") nav.toDmMessage(hostTask.channelId, hostTask.messageId);
    else nav.toMessage(hostTask.channelId, hostTask.messageId);
    void openThread({
      parentChannelId: hostTask.channelId,
      parentMessageId: hostTask.messageId,
      threadChannelId,
      intent: "thread",
    });
  }, [closeSurface, hostTask, nav, openThread, threadChannelId]);
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  // Task v2: a task's conversation is its own, not a message's thread, so a
  // task sheet keyed by its message (an older `task=<ch>:<msg>` link) moves
  // onto the task-keyed dialog as soon as the task is known. Decided per task:
  // a task made the v2 way moves whatever the flag says (its `messageId` is
  // only the task id, so a flag-off sheet on it would show no message).
  const openTaskConversation = useThreadStore((s) => s.openTaskConversation);
  const redirectToTaskConversation = isTaskSurface && !!taskModal && !!hostTask && opensAsTaskConversation(hostTask, taskV2);
  useEffect(() => {
    if (!redirectToTaskConversation || !hostTask) return;
    openTaskConversation({
      taskId: hostTask.id,
      parentChannelId: hostTask.channelId,
      conversationChannelId: directTaskConversationChannelId(hostTask),
    });
  }, [hostTask, openTaskConversation, redirectToTaskConversation]);
  // Only a pre-v2 task has a host message whose thread to view.
  const canViewInThread = !taskV2 && !!hostTask && !hostTask.isLegacy && !isTaskV2Task(hostTask) && hostTask.channelType !== "thread";
  // The task sheet owns the current history entry. Close the store first so
  // the panel disappears synchronously, then consume the PUSH that opened it.
  // On a cold deep link there is no safe entry to pop, so the callback fallback
  // simply closes the sheet and leaves the user on the underlying Tasks route.
  const mobileTaskBack = useMobileBack(closeSurface, closeSurface);
  if (!parentMessageId) return null;
  // Composition point, deliberately: Properties is mounted ABOVE ThreadPanel
  // rather than inside it. ThreadPanel's identity is "the replies of a
  // message", and the endgame (a task owning its own discussion channel)
  // deletes exactly that premise — so task-shaped concerns must not accrete
  // inside it. See #proj-task thread 3a4a72db.
  if (presentation === "modal") {
    return (
      <DialogSurface
        className="h-[min(86vh,900px)] max-h-[calc(100dvh-2rem)] w-[min(960px,calc(100vw-2rem))]"
        data-testid="task-thread-modal"
      >
        {hostTask && <TaskModalBar task={hostTask} onClose={closeSurface} onViewInThread={canViewInThread ? viewInThread : undefined} />}
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPanel key={parentMessageId} presentation="modal" threadIdentity={surfaceThreadIdentity} hideHeader={!!hostTask} hideParentMessage={!!hostTask}
            parentSlot={hostTask ? <Suspense fallback={<div className="stack-y-3 border-b border-line-hairline bg-layer-canvas p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>}><TaskModalHead task={hostTask} /></Suspense> : undefined} />
        </div>
      </DialogSurface>
    );
  }
  if (presentation === "mobile-modal") {
    return (
      <div className="absolute inset-0 z-cover flex flex-col bg-layer-canvas" data-testid="task-thread-modal">
        {hostTask && (
          <TaskModalBar task={hostTask} onClose={mobileTaskBack} onViewInThread={canViewInThread ? viewInThread : undefined} mobile />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPanel key={parentMessageId} presentation="mobile-modal" threadIdentity={surfaceThreadIdentity} hideHeader={!!hostTask} hideParentMessage={!!hostTask}
            parentSlot={hostTask ? <Suspense fallback={<div className="stack-y-3 border-b border-line-hairline bg-layer-canvas p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>}><TaskModalHead task={hostTask} /></Suspense> : undefined} />
        </div>
      </div>
    );
  }
  return <SideThreadColumn key={parentMessageId} />;
}

/** Chat-side col-4 thread column container. Owns persisted width + resize +
 *  desktop/mobile chrome. Renders ThreadPanel for the surface content. */
function SideThreadColumn() {
  // The remembered width; the row's plan shows it at its share (#189, rowLayout).
  const width = useColumnWidth("thread");
  // Task v2 (task #165): the column's place among the side columns, and the sections stacked with the thread in it.
  // (Its Expand, Focus Mode, is the row's: the head's button or Escape, #189 rule 5; no snap past the seam's end.)
  const [columnElement, setColumnElement] = useState<HTMLDivElement | null>(null);
  const side = useThreadColumnSide(columnElement);
  // Standing in the row, the thread's head moves it among the side columns (its grip on its own head, not the column's: a section can stand above it).
  const head = useStackEndHead("thread", useSideSectionHead("thread", side.inRow));
  return (
    <div
      ref={setColumnElement}
      className="thread-side-column flex flex-col bg-layer-canvas"
      data-testid="thread-side-column"
      data-otter-dock="thread"
      // With the channel folded (Thread | Profile, index.css), the thread is the conversation the profile takes its
      // width from (ColumnResizeHandle); elsewhere it is hidden or is the column being resized, and does not count.
      data-main-column=""
      data-side-col={side.sideCol}
      data-side-stacked={side.stacked ? "true" : undefined}
      data-thread-collapsed={side.threadFold}
      // Folded into the conversation's column, over the chat (#189 rule 3, rowPlan): Back instead of × (index.css).
      data-covers={side.covers}
      // Its remembered width; the row's plan shows it at its share (rowLayout `--row-width`).
      style={{ "--thread-panel-width": `${width}px`, "--side-thread-flex": side.threadFlex, order: side.order } as React.CSSProperties}
    >
      {/* Shown only where it stands in the row (index.css), not folded. */}
      {/* Stacked with sections, the column draws the left seam itself (index.css), not the thread's panel. */}
      <ColumnResizeHandle column="thread" edge="left" className="thread-side-column-resizer" ownBorder={side.stacked} highlight={side.seamHighlight} />
      <ThreadColumnSections side={side} part="before" />
      <ThreadPanel
        presentation="side"
        allowExpand
        headerLeading={side.stacked ? <ThreadCollapseChevron side={side} /> : undefined}
        headerDrag={head}
      />
      <ThreadColumnSections side={side} part="after" />
    </div>
  );
}

/** Profile panel wrapper — only renders if a profile is open */
function ProfilePanelWrapper({ collapseChannel = false, collapseThread = false }: { collapseChannel?: boolean; collapseThread?: boolean } = {}) {
  const isOpen = useProfileStore((s) => !!s.profileId);
  const planned = useRowPlanned();
  const { formatMessage } = useIntl();
  if (!isOpen) return null;
  // A desktop's planned row (#189 rule 7): a section of the side layout, moved among the columns like Tasks.
  if (planned) {
    return (
      <SideSectionPortal section="profile" title={formatMessage({ id: "agent.detail.tab.profile" })}>
        <RowRegionChrome region="profile"><Suspense fallback={<ProfilePanelFallback />}><ProfilePanel presentation="column" /></Suspense></RowRegionChrome>
      </SideSectionPortal>
    );
  }
  // Keep this marker as a direct child of the thread layout while flattening
  // its box.  That lets CSS switch the existing three-column flex row to
  // Thread | Profile without moving/unmounting the ThreadPanel element.
  return (
    <div
      className="thread-profile-side-column contents"
      data-testid="thread-profile-side-column"
      data-collapse-channel={collapseChannel ? "true" : "false"}
      data-collapse-thread={collapseThread ? "true" : "false"}
    >
      <Suspense fallback={(
        <ProfilePanelFallback
          testId={import.meta.env.VITE_E2E === "true" ? "profile-panel-fallback" : undefined}
        />
      )}><ProfilePanel /></Suspense>
    </div>
  );
}

/** Legacy task panel wrapper — only renders if a legacy task is open */
function LegacyTaskPanelWrapper({ presentation = "side" }: { presentation?: "side" | "modal" | "mobile-modal" }) {
  const isOpen = useLegacyTaskPanelStore((s) => !!s.task);
  if (!isOpen) return null;
  return (
    <Suspense fallback={presentation === "side" ? <LegacyTaskSidePanelFallback /> : <OverlayPanelFallback />}>
      <LegacyTaskPanel presentation={presentation} />
    </Suspense>
  );
}

/** Right panel — renders the open views in their overlay-stack order.
 *
 * An ordinary thread and a profile are both real surfaces, not alternatives:
 * opening a profile from a thread must retain the thread underneath so closing
 * the profile returns to the exact conversation the user came from. Task
 * threads remain modal-owned and keep their existing single-surface behavior.
 */
function RightPanel() {
  const location = useLocation();
  const threadOpen = useThreadStore((s) => !!s.openParentMessageId);
  const threadOpenedAt = useThreadStore((s) => s.openedAt);
  const profileOpen = useProfileStore((s) => !!s.profileId);
  const profileOpenedAt = useProfileStore((s) => s.openedAt);
  const profileOpenSource = useProfileStore((s) => s.openSource);
  const legacyTaskOpen = useLegacyTaskPanelStore((s) => !!s.task);
  const closeThread = useThreadStore((s) => s.closeThread);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const isTasksRoute = /\/tasks\/?$/.test(location.pathname);
  // Tasks-route: rail-visible (md+) wraps the thread / legacy task in TaskDialogShell
  // (bounded centered card with backdrop). Mobile (no Rail, <md) renders the
  // panel directly so it behaves like a regular full-screen thread overlay.
  // The md threshold matches LeftRail's own `hidden md:flex` — stdrc
  // 2026-05-21 #proj-task:287f18ce msg=59d4256c: "只要显示 Rail，就应该
  // 显示为中间弹窗". Earlier 1024px threshold made medium viewports drop into
  // mobile mode even with the Rail visible, which felt wrong.
  const [railVisible, setRailVisible] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setRailVisible(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const profileIsTop = profileOpen && (!threadOpen || profileOpenedAt >= threadOpenedAt);
  const threadIsTop = threadOpen && (!profileOpen || threadOpenedAt > profileOpenedAt);

  // Keep both ordinary side-panel surfaces mounted. The later child is the
  // visual top layer (mobile uses the shared absolute/z-index overlay; desktop
  // lays the two relative columns out side by side). This is intentionally
  // limited to ordinary threads: task threads are centered/modal surfaces and
  // must continue to be owned by their dialog wrapper (TaskDialogShell).
  // Every branch that renders a side thread goes through this SAME shape —
  // fragment [thread, profile|null] — so closing the profile reconciles to the
  // identical mounted thread node instead of remounting it.
  const renderStackedSidePanels = (threadPanel: ReturnType<typeof ThreadPanelWrapper>, source: "channel" | "thread" | null) => (
    <>{threadPanel}{profileOpen ? (
      <ProfilePanelWrapper
        collapseChannel={source !== "channel"}
        collapseThread={source === "channel"}
      />
    ) : null}</>
  );

  // Is the open thread anchored to a task? Uses the same store the chip list and
  // badge read, so "this thread belongs to a task" is answered identically
  // wherever it is asked.
  // Read the caller's INTENT, do not infer it. "Is the parent a task" was the
  // old test and it conflated two different actions on one message: the thread
  // icon (show the replies, side panel) and the task badge (open the task,
  // centered modal). @stdrc msg=ef2492f5.
  // The task modal owns an independent slot (task #699) and overlays whatever
  // surface is underneath — a side thread it was opened over keeps its
  // identity, mount, and scroll; closing the modal just empties the slot.
  const taskModalOpen = useThreadStore((s) => s.taskModal !== null);
  // A task keyed by the task (task v2) is the task slot's own: it follows a task ref there (TaskContentSlot).
  const taskModalTaskKeyed = useThreadStore((s) => !!s.taskModal?.taskId && !s.taskModal.parentMessageId);

  // /search 4-column layout (stdrc #proj-uiux:c2313b1d msg=a19e7a44 2026-05-28):
  // when col 3 hosts a channel/dm/agent/human surface, clicking thread / replies
  // opens the thread in col 4 — same as chat. The col-4 overlay (ThreadPanelWrapper
  // = SideThreadColumn at lg, full-screen overlay below lg) reuses the chat-side
  // thread column container; the page object is identical (page-object/container
  // axiom, msg=138867ba). When slot.kind === "thread" the search hit IS a thread
  // and SearchContentRoute renders ThreadPanel directly in col 3 — col 4 must NOT
  // also mount ThreadPanel, or we'd double-render. ProfilePanel still allowed.
  // /search AND /inbox are master/detail content routes that host the picked
  // entity (incl. thread) in col 3. Same structural rule for both: when col 3
  // IS a thread, col 4 must not also mount ThreadPanel (double-render);
  // otherwise a thread opened from inside a col-3 channel still gets col 4.
  // Both /search and /activity are master/detail content routes (the
  // rail-vs-sidebar placement A/B was dropped 2026-06-30 — Activity is always
  // the rail master/detail surface now).
  // In search-overlay mode the URL is /search but this panel must behave for the
  // frozen background channel, so key off the background location when present.
  const rightPanelPath = (resolveSearchOverlayBackground(location) ?? location).pathname;
  const rightPanelServerSlug = useServerStore((s) => s.current?.slug);
  const isSearchRoute = /\/search(\/|$)/.test(rightPanelPath);
  const isActivityRoute = /\/activity(\/|$)/.test(rightPanelPath);
  const searchSlotKind = useSearchContentStore((s) => s.slot?.kind ?? null);
  // The Tasks page (task v2) with a task, or a thread linked from it, in its
  // own detail slot is a content route too: the slot's thread is no col-4
  // panel, and no task modal draws over it.
  const isContentRoute = isSearchRoute || isActivityRoute
    || (isTasksPagePath(rightPanelPath, rightPanelServerSlug) && (searchSlotKind === "task" || searchSlotKind === "thread"));
  // The task modal is an overlay surface: it renders ON TOP of the base
  // decision below instead of replacing it (task #699 — the base used to be
  // dropped because both shared the one open slot). Its close handler shuts the
  // dialog's profile first, then the slot; the /tasks-route modal: closeThread.
  const renderTaskThreadPanel = (onClose: () => void) => {
    if (railVisible) {
      // The task dialog (raft-ui Dialog, TaskDialogShell): its scrim and Esc close it, as does the card's ×.
      return (
        <TaskDialogShell onClose={onClose}>
          <ThreadPanelWrapper presentation="modal" />
        </TaskDialogShell>
      );
    }
    return <ThreadPanelWrapper presentation="mobile-modal" />;
  };
  // The task slot shows its task in place (TaskContentSlot): no dialog over it. A message-keyed task
  // (pre-v2, a linked task's badge) opened from inside it is no task of the slot's: the dialog, as ever.
  const taskModalOverlay = taskModalOpen && !(searchSlotKind === "task" && taskModalTaskKeyed) ? renderTaskThreadPanel(dismissTaskConversationDialog) : null;
  if (isContentRoute) {
    let base = null;
    if (
      threadOpen
      && !isTasksRoute
      && searchSlotKind
      && searchSlotKind !== "thread"
      && profileOpen
    ) {
      base = renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource);
    } else if (profileIsTop) base = <ProfilePanelWrapper />;
    else if (threadIsTop && searchSlotKind && searchSlotKind !== "thread") {
      base = renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource);
    }
    return <>{base}{taskModalOverlay}</>;
  }

  if (threadOpen && !isTasksRoute && profileOpen) {
    return <>{renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource)}{taskModalOverlay}</>;
  }
  if (profileIsTop) return <><ProfilePanelWrapper />{taskModalOverlay}</>;
  // Centered because the thread belongs to a TASK, not because of the route.
  // Gating on `isTasksRoute` meant the same task opened as a modal from the
  // Tasks page and as a side panel from its own channel — one object, two
  // containers, decided by where you happened to click. @stdrc.
  if (threadIsTop && isTasksRoute) {
    return <>{renderTaskThreadPanel(closeThread)}{taskModalOverlay}</>;
  }
  if (threadIsTop) return <>{renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource)}{taskModalOverlay}</>;
  if (isTasksRoute && legacyTaskOpen) {
    if (railVisible) {
      return (
        <TaskDialogShell onClose={closeLegacyTask}>
          <LegacyTaskPanelWrapper presentation="modal" />
        </TaskDialogShell>
      );
    }
    return <LegacyTaskPanelWrapper presentation="mobile-modal" />;
  }
  if (legacyTaskOpen) return <LegacyTaskPanelWrapper />;
  // Overlay-only case: task modal open over a bare channel (no side thread,
  // no profile). The base surfaces above all returned before this point.
  return taskModalOverlay;
}

/** Sync right panel state ↔ URL query params */
function useRightPanelUrlSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef({ pathname: location.pathname, search: location.search });
  // Search-overlay mode: the URL is the overlay's own /search?q=… and carries no
  // panel params, while the thread/profile panels stay mounted for the frozen
  // background. Reading that URL would close the open thread (and closing the
  // overlay would reopen it from scratch, refetch and flash "loading" — task
  // #763); writing to it would put panel params on the search URL. So the sync
  // is isolated while overlaying, like useSearchContentUrlSync, and resumes
  // against the background URL the overlay closes back to.
  const isSearchOverlay = resolveSearchOverlayBackground(location) !== null;

  // Keep a router-snapshot fallback for non-browser tests. Browser store→URL
  // sync reads `window.location.*` directly so close/open updates merge with
  // the live URL, not a React-render snapshot that may still contain a stale
  // `?thread=`.
  useEffect(() => {
    locationRef.current = { pathname: location.pathname, search: location.search };
  }, [location.pathname, location.search]);

  // URL → Store: keep thread/profile stores consistent with URL params.
  // Runs on mount AND on in-session URL changes so that clicking a permalink
  // to a different thread (which calls navigate() and only changes the query
  // string) reopens the panel to the new target instead of staying on the
  // previously opened thread.
  // Deep links v1: a landed message link whose `thread` names another
  // conversation is rejected whole, so its thread never opens (and waits for
  // the flag instead of opening first). Any other address syncs as before.
  const deepLinks = useDeepLinksFlag();
  const rejectsLandedThread = (() => {
    if (!isMessageLinkLanding(location.pathname, location.search)) return false;
    const target = parseMessageLink(location.pathname, location.search);
    return !!target && isThreadMismatch(target) && (!deepLinks.resolved || deepLinks.enabled);
  })();
  // The store→URL direction must leave the rejected link alone too: with no
  // thread open it would drop `thread=` and turn the link into a plain ?msg=.
  const rejectsLandedThreadRef = useRef(rejectsLandedThread);
  rejectsLandedThreadRef.current = rejectsLandedThread;
  useEffect(() => {
    // React can still flush an older URL→store effect after a fast close has
    // already replaced the live URL. Ignore those stale snapshots so a removed
    // ?thread= param cannot reopen the just-closed panel.
    if (isSearchOverlay) return;
    if (rejectsLandedThread) return;
    if (!isCurrentRightPanelSearchSnapshot(location.search)) return;
    syncRightPanelStoresFromSearch(location.search);
  }, [location.pathname, location.search, isSearchOverlay, rejectsLandedThread]);

  // Store → URL: update query params when panel state changes.
  // Panels stack: both ?thread= and ?profile= can coexist. Adding a panel
  // pushes a new history entry; close / swap / in-place updates replace.
  const syncUrl = useCallback((
    mode: "auto" | "replace" = "auto",
    options: { resetAgentTabForProfileReopen?: boolean } = {},
  ) => {
      if (rejectsLandedThreadRef.current) return;
      // Sync locationRef synchronously after navigate(). React-router's
      // navigate() calls history.pushState under the hood, which updates
      // window.history synchronously, but the useEffect at line 413 only
      // refreshes locationRef AFTER React re-renders. Without this manual
      // sync, a Zustand subscriber that fires a second syncUrl() in the
      // same tick (e.g. an openThread() that sets multiple fields, or an
      // openThread+openProfile combo) reads the stale locationRef and
      // pushes the SAME URL again, producing duplicate history entries —
      // which is why browser back needed 2–3 clicks to escape a thread
      // opened from /threads or a channel view. Reported in
      // `#proj-uiux:c8711d2a` msg=b61ca24b (2026-05-01, @stdrc).
      // Stryker disable next-line ObjectLiteral: MainLayout only forwards router state; rightPanelUrlSyncContract covers the URL sync behavior.
      syncRightPanelUrlFromStores({
        mode,
        navigate,
        fallback: locationRef.current,
        options,
        // Stryker disable next-line BlockStatement: this adapter keeps the fallback ref in sync after navigate; covered by rightPanelUrlSyncContract.
        updateFallback: (next) => {
          locationRef.current = next;
        },
      });
  }, [navigate]);

  useEffect(() => {
    if (isSearchOverlay) return;
    const unsubThread = subscribeRightPanelThreadAnchor(() => {
      // The URL derives only from the parent anchor. Thread fetch completion,
      // summaries, unread counts, and reply previews can arrive while a
      // browser POP is waiting for React Router to commit; letting those
      // unrelated updates call syncUrl would reattach the stale ?thread=.
      syncUrl("auto");
    });
    const unsubProfile = useProfileStore.subscribe((state, prev) => {
      const resetAgentTabForProfileReopen =
        state.openedAt !== prev.openedAt
        && state.profileType === "agent"
        && state.profileType === prev.profileType
        && state.profileId === prev.profileId
        && !!state.profileId
        && state.defaultAgentTabIntent === "ordered-first";
      syncUrl("auto", { resetAgentTabForProfileReopen });
      if (state.defaultAgentTabIntent) {
        useProfileStore.getState().clearDefaultAgentTabIntent();
      }
    });
    const unsubLegacyTask = useLegacyTaskPanelStore.subscribe((state, prev) => {
      if (state.task === prev.task) return;
      syncUrl("auto");
    });
    return () => { unsubThread(); unsubProfile(); unsubLegacyTask(); };
  }, [syncUrl, isSearchOverlay]);

  // Re-add panel params after react-router navigation changes the pathname
  useEffect(() => {
    if (isSearchOverlay) return;
    syncUrl("replace");
  }, [location.pathname, syncUrl, isSearchOverlay]);
}

// Two-way URL sync for the content master/detail (task #311 stdrc msg=b61ab472).
// `?open=<kind>:<id>` <-> searchContentStore.slot; an Artifact's slot is the
// one Artifact address (artifactOpenAddress.ts, #proj-workspace:#240): `?artifact=<id>`, `&version=`,
// `&review=`; the retired `?open=artifact:<id>` is read, and replaced with it. The same slot store + URL
// param back BOTH the /search master/detail AND the /inbox (Activity) one
// (stdrc #proj-activity:171042a3 2026-06-23: "Activity 的展示方式应该跟搜索
// 结果页面一致 … 点进去后的交互行为也和搜索结果点进去的行为类似"). Scoped to
// those two routes: outside them we ignore inbound URLs AND auto-clear any open
// slot, so navigating away closes the slot without leaving residue. Because the
// slot is shared, switching between /search and /inbox is also a route change —
// the new route's URL carries no `?open=` on a fresh entry, so the URL→Store
// branch clears the prior route's slot rather than letting it bleed across.
type SearchContentSlotState = { slot: SearchContentSlot | null };

function useSearchContentUrlSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  // Search-overlay mode: the URL is /search (the overlay's own query) but the
  // background — which may itself be an Activity/Search WITH a picked col-3 slot —
  // must be left exactly as it was. So this whole sync is ISOLATED while overlaying
  // (both effects early-return): we must not read the overlay's ?open=/?msg=, clear
  // the background's slot, or write the overlay URL. Only fully leaving the overlay
  // resumes the sync.
  const isSearchOverlay = resolveSearchOverlayBackground(location) !== null;
  // The Tasks page (task v2) opens a task in a detail slot of its own, and a
  // thread linked from that task in its place (detailSlotThread.ts).
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const onTasksRoute = taskV2 && isTasksPagePath(location.pathname, serverSlug);
  const onContentRoute =
    !!serverSlug
    && (location.pathname === `/s/${serverSlug}/search`
        || location.pathname.startsWith(`/s/${serverSlug}/search/`)
        || location.pathname === `/s/${serverSlug}/activity`
        || location.pathname.startsWith(`/s/${serverSlug}/activity/`)
        || onTasksRoute);
  // The result's own entry keeps its mark through in-place rewrites of that
  // entry while the result stays open: a conversation's tab (?chatTab=), its
  // focused message (?msg= cleared on send / back to bottom) and other
  // replaces write the URL without our state. When a REPLACE lands on the
  // entry the previous commit saw marked, with the result still showing, the
  // mark goes back on, so closing the result still pops it.
  const lastCommitRef = useRef<{ index: number | null; marked: boolean } | null>(null);
  useEffect(() => {
    if (isSearchOverlay || !onContentRoute) {
      lastCommitRef.current = null;
      return;
    }
    const index = historyEntryIndex();
    const previous = lastCommitRef.current;
    if (
      navigationType === "REPLACE"
      && !isContentSlotEntry()
      && previous?.marked
      && index !== null
      && previous.index === index
      && new URLSearchParams(window.location.search).has("open")
    ) {
      stampContentSlotEntry();
    }
    lastCommitRef.current = { index, marked: isContentSlotEntry() };
  }, [location.key, navigationType, isSearchOverlay, onContentRoute]);

  // URL → Store. Clears the slot when leaving the content routes or when ?open
  // is removed.
  useEffect(() => {
    if (isSearchOverlay) return;
    if (!onContentRoute) {
      const slot = useSearchContentStore.getState().slot;
      if (slot) {
        useSearchContentStore.getState().close();
        // Its task goes with it, not on to the next page as the dialog. Kept
        // where the page's own address names it (a link to a message in it:
        // the channel with the task open) or another task was opened on the
        // way out. Read before the stale-commit check below: the address the
        // navigation carried, not the one the panels' sync rewrites it to.
        const named = parseTaskConversationParam(new URLSearchParams(location.search).get("task"))?.taskId;
        if (slot.kind === "task" && named !== slot.id && useThreadStore.getState().taskModal?.taskId === slot.id) useThreadStore.getState().closeTaskModal();
      }
      return;
    }
    // A stale commit: Router is still rendering a location the browser has
    // already left (a result opened, then Back before the result's render
    // committed). Acting on it would reopen the result just closed; the
    // current location's own commit runs this effect again.
    if (location.search !== window.location.search && location.pathname === window.location.pathname) return;
    const params = new URLSearchParams(location.search);
    const openParam = params.get("open");
    const msgParam = params.get("msg");
    const parsedParam = parseSearchOpenParam(openParam);
    // An Artifact opens in Activity's slot and in Search's (#proj-workspace:#104), as any result, at its address
    // (`?artifact=`, or the retired `?open=artifact:` replaced with it in place, its entry kept).
    const artifactAddress = onTasksRoute || (parsedParam && parsedParam.kind !== "artifact") ? null : readArtifactAddress(params);
    if (artifactAddress?.legacy) writeArtifactAddress(navigate, artifactAddressTidying({ pathname: location.pathname, search: location.search, state: location.state }, "activity"));
    const parsed: SearchContentSlot | null = artifactAddress
      ? { kind: "artifact", id: artifactAddress.id }
      // The Tasks page's slot is only ever a task or a thread opened from one.
      : onTasksRoute && parsedParam?.kind !== "task" && parsedParam?.kind !== "thread" ? null : parsedParam;
    const current = useSearchContentStore.getState().slot;
    if (!parsed) {
      if (current) useSearchContentStore.getState().close();
      return;
    }
    const nextMessageId = (parsed.kind === "channel" || parsed.kind === "dm" || parsed.kind === "thread" || parsed.kind === "task")
      ? (msgParam ?? undefined)
      : undefined;
    const nextVersion = artifactAddress ? artifactAddress.version ?? undefined : undefined;
    const nextReview = artifactAddress ? artifactAddress.review : undefined;
    if (
      !current
      || current.kind !== parsed.kind
      || current.id !== parsed.id
      || current.messageId !== nextMessageId
      || current.version !== nextVersion
      || current.review !== nextReview
    ) {
      useSearchContentStore.getState().open({
        ...parsed,
        messageId: nextMessageId,
        ...(nextVersion === undefined ? {} : { version: nextVersion }),
        ...(nextReview === undefined ? {} : { review: nextReview }),
      });
    }
  }, [location.pathname, location.search, location.state, onContentRoute, onTasksRoute, isSearchOverlay, navigate]);

  // Back / Forward away from an opened result closes it on the spot. The
  // URL→Store effect above does the same once Router commits the popped
  // location, but a result page that is still settling (lazy panels, a
  // pending transition) can leave that commit without the effect re-running,
  // and the result stayed up over a results URL. Reading the live URL on
  // popstate does not depend on that commit.
  useEffect(() => {
    if (isSearchOverlay || !onContentRoute) return;
    const closeSlotWhenUrlDropsIt = () => {
      const live = new URLSearchParams(window.location.search);
      if (live.has("open") || readArtifactAddress(live)) return;
      if (useSearchContentStore.getState().slot) useSearchContentStore.getState().close();
    };
    window.addEventListener("popstate", closeSlotWhenUrlDropsIt);
    return () => window.removeEventListener("popstate", closeSlotWhenUrlDropsIt);
  }, [onContentRoute, isSearchOverlay]);

  // Store → URL. Only writes when on a content route; off-route the URL→Store
  // branch above is authoritative.
  //
  // Reads the URL via `window.location.*` (not the closure'd `location.*`) so a
  // navigate() from another concurrently-firing store subscriber in the same
  // tick is preserved. Concretely: clicking a thread search hit calls
  // `closeThread()` → `openThread()` (which writes `?thread=parentCh:parentMsg`
  // via useRightPanelUrlSync) → `openSearchContent()` (this subscriber). With a
  // closure'd snapshot we'd rebuild params from the pre-click URL and clobber
  // the freshly written `?thread=`; the URL→Store branch then sees no
  // `?thread=` and calls `closeThread()`, leaving ThreadPanel with
  // `parentMessageId === null` — which renders blank for one click and is
  // why task #330's "first-click col-3 blank" repro'd on thread hits.
  //
  // Phone /search (design lead 2026-10-21): Search is a tab, and a result
  // opened from it is a pushed page whose Back returns to the results. Opening
  // the first result therefore PUSHES a history entry (a thread hit's entry
  // was already pushed by the ?thread= sync, so it merges into that one), and
  // closing the result from the store — an agent/human page's Back calls
  // closeSlot — pops it instead of leaving a duplicate results entry behind.
  // Phone Activity does the same: the opened conversation is a page pushed in
  // place of the list, so system/browser Back returns to the list. Desktop
  // master/detail (col 3 beside the list) keeps replacing.
  useEffect(() => {
    if (isSearchOverlay || !onContentRoute) return;
    // True when it popped the result's entry rather than writing the URL.
    const writeSlot = (state: SearchContentSlotState, prev: SearchContentSlotState): boolean => {
      const params = new URLSearchParams(window.location.search);
      const livePath = window.location.pathname.replace(/\/+$/, "");
      const phoneSearch = !!serverSlug
        && livePath === `/s/${serverSlug}/search`
        && typeof window.matchMedia === "function"
        && !window.matchMedia("(min-width: 768px)").matches;
      const phoneActivity = !!serverSlug
        && livePath === `/s/${serverSlug}/activity`
        && !isActivityMasterDetailViewport();
      // The Tasks page's task on a phone: a page pushed in place of the list, as Activity's.
      const phoneTasks = !!serverSlug
        && livePath === `/s/${serverSlug}/tasks`
        && !isActivityMasterDetailViewport();
      const pushesResultPage = phoneSearch || phoneActivity || phoneTasks;
      // The entry on screen is one a result opened on its own (marked when it
      // was pushed; the mark lives on the history entry, so it survives
      // leaving for another page and coming Back to it). Closing it pops that
      // entry at any width: one opened on a phone and closed after the window
      // widened must not leave a duplicate list entry either. (An Artifact's: its address's mark.)
      const live = liveArtifactAddressEntry();
      const slotEntry = isContentSlotEntry() || artifactOpenEntryOf(live.state)?.pushed === true;
      const liveAddress = readArtifactAddress(params);
      // A slot opened FROM the URL (a cold link, Back/Forward) is already in
      // history; only a result the user opens adds an entry.
      const openedFromUrl = !!state.slot && (state.slot.kind === "artifact"
        ? artifactSlotInAddress(liveAddress, state.slot) : params.get("open") === formatSearchOpenParam(state.slot));
      const opensResultPage = pushesResultPage && !!state.slot && !prev.slot && !openedFromUrl;
      // An Artifact's slot: the Artifact address's writes, with this master/detail's push rule.
      if (state.slot?.kind === "artifact" || (!state.slot && prev.slot?.kind === "artifact" && liveAddress)) {
        writeArtifactSlotAddress(navigate, live, state.slot, { source: livePath.endsWith("/search") ? "search" : "activity", push: opensResultPage, pushed: slotEntry });
        return false;
      }
      if (!state.slot) {
        const resultEntryShowing = params.has("open");
        if (slotEntry && resultEntryShowing) {
          navigate(-1);
          return true;
        }
        params.delete("open");
        params.delete("msg");
      } else {
        params.set("open", formatSearchOpenParam(state.slot));
        if (
          (state.slot.kind === "channel"
            || state.slot.kind === "dm"
            || state.slot.kind === "thread"
            || state.slot.kind === "task")
          && state.slot.messageId
        ) {
          params.set("msg", state.slot.messageId);
        } else {
          params.delete("msg");
        }
      }
      // Another result in its place: the Artifact open with the one before (its slot, or beside its conversation) goes.
      const sameResult = !!state.slot && !!prev.slot && state.slot.kind === prev.slot.kind && state.slot.id === prev.slot.id;
      const written = sameResult ? params : withArtifactAddress(params, null);
      const search = written.toString();
      const pathname = window.location.pathname;
      // A task's entry was pushed by its ?task= the same way (TaskContentSlot).
      const threadEntryAlreadyPushed = (state.slot?.kind === "thread" && params.has("thread"))
        || (state.slot?.kind === "task" && params.has("task"));
      const push = opensResultPage && !threadEntryAlreadyPushed;
      // Mark the result's own entry (a thread hit's was pushed by the
      // ?thread= sync just before; this replace marks it) and keep the mark
      // while the result stays open on it. Otherwise these rewrites stay
      // stateless, as they always were (searchFullPagePreviewSync).
      const nextState = state.slot && (opensResultPage || slotEntry)
        ? { [CONTENT_SLOT_ENTRY_MARK]: true }
        : undefined;
      navigate(
        { pathname, search: search ? `?${search}` : "" },
        // flushSync: the result page renders from the store at once, so the
        // router must commit its entry now too. Left to a transition (which a
        // suspending result page can hold back), a quick Back would pop to the
        // location React still had committed and never close the result.
        push ? { flushSync: true, state: nextState } : { replace: true, state: nextState },
      );
      // The result page's Back renders before Router commits the new entry;
      // record the push now so that Back pops back to the results.
      if (push) recordSynchronousMobileBackNavigation("PUSH", `${pathname}${search ? `?${search}` : ""}`);
      return false;
    };
    return useSearchContentStore.subscribe((state, prev) => {
      if (state.slot === prev.slot) return;
      const popped = writeSlot(state, prev);
      // A task slot's task (TaskContentSlot) closes as the slot leaves it,
      // after the slot's own write. A popped entry takes its ?task= along
      // and the URL closes the task; writing it now would land on the entry
      // being left before the pop.
      if (prev.slot?.kind === "task" && state.slot?.kind !== "task" && !popped) useThreadStore.getState().closeTaskModal();
    });
  }, [onContentRoute, navigate, isSearchOverlay, serverSlug]);
}


export default function MainLayout() {
  const [announcementHost, setAnnouncementHost] = useState<HTMLDivElement | null>(null);
  // Shared model-label catalog (task #700): the shell owns the load trigger
  // (server changes while the app is up); rows and panels only subscribe, so
  // every surface switches to the reported names together.
  useEffect(() => watchModelLabelCatalog(), []);
  useEffect(() => markBootMilestone("frame"), []);
  const { formatMessage } = useIntl();
  useEmbedParamsKeeper();
  useRightPanelUrlSync();
  useSearchContentUrlSync();
  useArtifactViewerAddress();
  useBesideMemory();
  useSearchHitMarkLifetime();
  useRailLegacyRedirect();
  useTabRouteMemory(useOwnAssistantDmId());

  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const channelsLoading = useChannelStore((s) => s.loading);
  const showAddMachine = useMachineStore((s) => s.showAddMachine);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const showCreateAgent = useAgentStore((s) => s.showCreateAgent);
  const createAgentOnboarding = useAgentStore((s) => s.createAgentOnboarding);
  const setShowCreateAgent = useAgentStore((s) => s.setShowCreateAgent);
  const navigate = useNavigate();
  const location = useLocation();
  // Desktop ⌘K search overlay (background-location modal route): when the topbar
  // Search / ⌘K navigates to /search it carries the current location as
  // `backgroundLocation`. While set, the whole layout below renders for that
  // BACKGROUND location (the channel stays frozen behind) and the search floats in
  // a SearchOverlay on top. Web never sets backgroundLocation, so every branch
  // gated on it is dead there and behaviour is byte-for-byte unchanged.
  // Desktop invariant (task #96): /search is ALWAYS the overlay — entries that
  // carry no backgroundLocation (rail, "search this channel", deep links,
  // history traversal) get one synthesized from searchFrom / the last
  // non-search location / server home instead of rendering the full page.
  const backgroundLocation = resolveSearchOverlayBackground(location);
  // The content column the web search overlay sits at the top of (SearchOverlay).
  const contentColumnRef = useRef<HTMLDivElement | null>(null);
  // A page's own column beside the conversation in the row (the Tasks page's task; rowColumnSlot).
  const [rowColumnSlot, setRowColumnSlot] = useState<HTMLElement | null>(null);
  usePageViewTracking(location.pathname);
  // Raft Desktop: its move to the official Computer, as product events (analytics/computerMigration.ts).
  useComputerMigrationReporting();
  useMessageLinkLandingLifetime(location.pathname, location.search);
  useEffect(() => {
    rememberNonSearchLocation({ pathname: location.pathname, search: location.search });
  }, [location.pathname, location.search]);
  // Detect mobile vs desktop (matches Tailwind's md: breakpoint at 768px)
  const isDesktop = useIsDesktopShell();
  // A stable element: the Sidebar is memoised, and a fresh slot per render
  // re-rendered every sidebar row after each unrelated update (web perf).
  const sidebarAnnouncementSlot = useMemo(
    () => (isDesktop ? <div ref={setAnnouncementHost} className="shrink-0" data-testid="sidebar-announcement-slot" /> : undefined),
    [isDesktop],
  );

  const isLg = useMediaQuery(LG_VIEWPORT_QUERY);
  // index.css shows Channel | Thread side by side only in a landscape or xl window.
  const threadSplitViewport = useMediaQuery(THREAD_SPLIT_VIEWPORT_QUERY);

  const serverSlug = useServerStore((s) => s.current?.slug);
  const currentServerId = useServerStore((s) => s.current?.id);
  const announcementGateState = useOnboardingAnnouncementGateStore((state) => (
    currentServerId ? state.byServerId[currentServerId] ?? "pending" : "pending"
  ));
  const sawOnboardingThisSession = useOnboardingAnnouncementGateStore((state) => (
    currentServerId ? state.sawOnboardingServerIds.includes(currentServerId) : false
  ));
  // A page a link landed on, with the open-in-app offer: the announcement waits (one app prompt at a time).
  const landingHoldsAnnouncements = useLandingHoldsAnnouncements();
  const threadRefHandoff = useMemo(
    () => serverSlug ? parseThreadRefHandoff(serverSlug, location.search) : null,
    [location.search, serverSlug],
  );
  const consumedThreadRefHandoffsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!threadRefHandoff || !serverSlug || channelsLoading) return;
    const serverEpoch = useServerStore.getState().serverEpoch;
    void executeThreadRefHandoffOnce({
      consumedHandoffs: consumedThreadRefHandoffsRef.current,
      intent: threadRefHandoff,
      serverSlug,
      serverEpoch,
      channels: [...channels, ...dmChannels],
      consume: () => navigate(
        {
          pathname: location.pathname,
          search: consumeThreadRefHandoffSearch(location.search),
        },
        { replace: true },
      ),
      resolve: (parentChannel) => resolveThreadTargetByShortId({
        serverSlug,
        parentChannelId: parentChannel.id,
        shortId: threadRefHandoff.shortId,
        summaries: useThreadStore.getState().summaries,
        followedThreads: useThreadStore.getState().followedThreads,
        // A thread behind the plan's history window opens on its paywall, as in the app.
        loadContext: loadThreadRefContext,
      }),
      getAuthority: () => {
        const activeServer = useServerStore.getState();
        return { serverSlug: activeServer.current?.slug, serverEpoch: activeServer.serverEpoch };
      },
      onFailure: (reason) => {
        // channel_not_listed is decided locally, with no request: say why, as there is no trace id to send.
        if (reason === "channel_not_listed") toast.error(formatMessage({ id: "message.messageItem.threadChannelUnavailable" }));
        else toast.error(formatMessage({ id: "message.messageItem.threadUnavailable" }));
        navigate(`/s/${serverSlug}`, { replace: true });
      },
      onOpen: (target, parentChannel) => {
        void useThreadStore.getState().openThread(target);
        navigate(
          buildThreadRoutePath(target, parentChannel.type === "dm" ? "dm" : "channel"),
          { replace: true },
        );
      },
    });
  }, [channelsLoading, formatMessage, location.pathname, location.search, navigate, serverSlug, threadRefHandoff, channels, dmChannels]);

  useClearLiveAgentActivityOnServerChange(currentServerId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { blurFocusedControlForScreenshotShortcut(event); };
    // keydown-global-exempt: system screenshot focus cleanup, observed only (never preventDefault)
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘K / Ctrl+K, through the shortcut registry's dispatcher (which calls preventDefault).
  useShortcut("search", () => {
    if (!serverSlug) return;
    const searchPath = `/s/${serverSlug}/search`;
    const outcome = routeGlobalSearchShortcut({
      pathname: location.pathname,
      searchPath,
      focusMountedSearch,
      navigateToSearch: () => navigate(`/s/${serverSlug}/search`, {
        state: {
          searchFrom: `${location.pathname}${location.search}`,
          // Float the search over the current view (⌘K overlay) wherever the
          // overlay is on (desktop shell, desktop-width web); phones keep the
          // full-page /search. A minimal {pathname,search} avoids nesting the
          // location.state chain.
          ...(isSearchOverlayEnabled()
            ? { backgroundLocation: { pathname: location.pathname, search: location.search } }
            : {}),
        },
      }),
    });
    trackNavEntrySelected("search", "keyboard_shortcut", outcome === "focused");
  });

  // One-time hash migration: redirect old hash URLs to new paths. Runs when the
  // server slug resolves or changes, not on every navigation.
  const migrateLegacyHashUrl = useEffectEvent((slug: string) => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    // Clear the hash
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const base = `/s/${slug}`;
    if (hash === "settings") {
      navigate(`${base}/settings`, { replace: true });
      return;
    }
    const [type, id] = hash.split("/");
    if (id && ["channel", "dm", "agent", "machine", "human", "member"].includes(type)) {
      navigate(`${base}/${type}/${id}`, { replace: true });
    }
  });
  useEffect(() => {
    if (serverSlug) migrateLegacyHashUrl(serverSlug);
  }, [serverSlug]);

  useMainLayoutRealtimeBridge(mainLayoutRealtimeBridgeDriver);

  // In search-overlay mode the URL is /search but the layout must render the
  // BACKGROUND channel behind the overlay, so all route checks below key off the
  // background location's path. Without an overlay this is exactly location.pathname.
  const path = (backgroundLocation ?? location).pathname;
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";

  const searchSlotOpen = useSearchContentStore((s) => !!s.slot);
  const searchSlotKind = useSearchContentStore((s) => s.slot?.kind ?? null);
  const guest = useIsGuest();
  // Which panes this URL gets (shellRouteLayout.ts, shared with PendingServerLayout).
  const {
    assistantPageOtter,
    mobileShowSidebarInline,
    isInboxRoute,
    searchMasterDetail,
    hideSidebar,
    collapseColumn,
    sidebarCollapsible,
    topEdgeSurface,
  } = shellRouteLayout(path, pathBase, { isDesktop, searchSlotOpen, guest });
  const threadRow = useThreadRowState();
  const threadParentMessageIdForLayout = useThreadStore((s) => s.openParentMessageId);
  const threadOpenForLayout = !!threadParentMessageIdForLayout;
  const profileOpenForLayout = useProfileStore((s) => !!s.profileId);
  const masterDetailShellClassName = searchMasterDetail
    ? "flex flex-col"
    : "";
  const legacyTaskOpenForLayout = useLegacyTaskPanelStore((s) => !!s.task);
  const shortcutHelpOpenForLayout = useShortcutHelpStore((s) => s.open);
  // Room a right panel needs for the sidebar column to give way to it (ShellSidebarColumn), 0 in the planned row
  // (#189): the sidebar is not in the row, which folds the thread instead, so it never moves when one opens or folds.
  // Elsewhere (a legacy task's row) index.css splits at the conversation's 360px plus the thread's minimum: a profile,
  // a legacy task or the shortcuts panel sits beside the conversation from lg; a thread in a landscape or xl window,
  // unless it is picked.
  const rowPlanned = useRowPlanned();
  const rightPanelBeside = isDesktop && !rowPlanned && (
    ((profileOpenForLayout || legacyTaskOpenForLayout || shortcutHelpOpenForLayout) && isLg)
    || (threadOpenForLayout && threadSplitViewport && !(searchMasterDetail && searchSlotKind === "thread"))
  );
  const rightColumnMin = rightPanelBeside ? COLUMN_BOUNDS.thread.contentMin : 0;
  const sidebarHidden = useSidebarSlotHidden(collapseColumn);
  const sidebarCollapsed = sidebarCollapsible && sidebarHidden;
  const handleSidebarOpenChange = useCallback(
    (open: boolean) => setSidebarSlotHidden(collapseColumn, !open),
    [collapseColumn],
  );
  const closeAddMachine = useCallback(() => setShowAddMachine(false), [setShowAddMachine]);
  const closeCreateAgent = useCallback(() => setShowCreateAgent(false), [setShowCreateAgent]);
  const closeSearchOverlay = useCallback(() => {
    if (backgroundLocation) navigate(overlayCloseTarget(backgroundLocation));
  }, [backgroundLocation, navigate]);

  // ⌘\ / Ctrl+\ (or the person's own keys), through the registry: held down it toggles once;
  // toggleSidebarFromKeyboard moves focus out of a collapsing sidebar itself.
  useShortcut("sidebar", () => { toggleSidebarFromKeyboard(document, collapseColumn); }, { enabled: sidebarCollapsible });

  // The top bar (workspace switcher + search) spans the window at desktop
  // width. The desktop shell draws its own title bar, and the host-shell embed
  // owns its chrome, so neither gets a second one. A shell that instead hands
  // its chrome to this bar (topBarHostContext.ts) gets it at any width: the
  // row is then the window's title bar and drag region.
  const showTopBar = useShowsTopBar(isDesktop);

  return (
    <ShellFrame
      isDesktop={isDesktop}
      showTopBar={showTopBar}
      topEdgeSurface={topEdgeSurface}
      sidebarCollapsible={sidebarCollapsible}
      sidebarOpen={!sidebarHidden}
      onSidebarOpenChange={handleSidebarOpenChange}
      topStrip={<OpenInAppOffers slot="top" />}
      bottomStrip={<OpenInAppOffers slot="bottom" />}
      rail={(
        <LeftRail
          hidden={mobileShowSidebarInline}
          topBar={showTopBar}
          sidebarToggle={sidebarCollapsible ? collapseColumn : null}
        />
      )}
      // Sidebar container:
      // - Mobile root: relative, full width, inline as main content (the "Chat tab")
      // - Mobile detail: hidden (no drawer on mobile — detail views cover everything)
      // - Desktop: always relative inline at resizable width
      // - Tasks rail mode: hidden (TasksPanel takes the full main area).
      sidebar={hideSidebar ? null : (
        <AppShellSidebarSlot
          id={SIDEBAR_REGION_ID}
          // Collapsed, the column stays mounted under the main area; raft-ui
          // makes it inert and aria-hidden, and while expanded stacks it just
          // above the main area so its resize handle's outer half stays
          // grabbable (no z-index here, so that stacking applies).
          className={
            mobileShowSidebarInline
              ? "relative z-auto flex min-w-0 flex-1"
              // A phone's detail page has no sidebar beside it, also where it
              // is wide (a host-shell embed: useIsDesktopShell); `md:hidden`
              // overrides raft-ui's own `md:flex` on the slot.
              : isDesktop ? "hidden md:relative md:flex" : "hidden md:hidden"
          }
        >
          <ShellSidebarColumn
            column={searchMasterDetail ? "list" : "sidebar"}
            // Activity with an item open: the list never renders wider than
            // the conversation (stdrc), at most half the room right of the rail.
            maxShare={searchMasterDetail && isInboxRoute && searchSlotOpen ? 0.5 : undefined}
            inline={mobileShowSidebarInline}
            rightColumnMin={rightColumnMin}
            collapseColumn={sidebarCollapsible && !mobileShowSidebarInline ? collapseColumn : null}
            ownBorder={searchMasterDetail}
            // stdrc 2026-05-02 #proj-uiux:95e25b5b ec1523d9: invert
            // sidebar/main relationship — sidebar uses warm cream
            // (`bg-palette-cream`), main panel uses bright white. After
            // research-driven iterations through paper/yellow/cool-gray
            // candidates, the cleanest hierarchy is the inversion:
            // LeftRail (yellow) → Sidebar (cream) → Main (white).
            //
            // Search master/detail (task #311): in this mode the slot host is
            // MessageSearchPage itself, not Sidebar. We keep cream as the
            // background so it lines up with the rest of the col-2 surface,
            // but MessageSearchPage paints its own bg-white over it.
            // Sidebar paints its own right divider; in master/detail it's
            // gone (replaced by MessageSearchPage), so add it on the
            // wrapper instead — stdrc msg=76b75151: "当打开 channel 的时候,
            // 和搜索结果之间应该也要有竖线".
            // searchMasterDetail's flex flex-col: the col-2 wrapper is the
            // container for MessageSearchPage, whose root is `flex min-h-0
            // flex-1 flex-col` — flex-1 only constrains height when the
            // parent is a flex column. Without it the search results list
            // grew past the viewport and the page lost its scroll
            // (stdrc #proj-uiux:c2313b1d msg=86b31b78 2026-05-28). Sidebar
            // uses h-full on its own root so adding flex flex-col to the
            // wrapper doesn't change its layout — but we still scope it to
            // master-detail to keep the non-search wrapper byte-identical.
            className={`relative h-full min-w-0 ${mobileShowSidebarInline ? "flex-1 bg-layer-canvas" : "shrink-0 bg-layer-sidebar"} ${masterDetailShellClassName}`}
          >
            {searchMasterDetail ? (
              // Col 2 master list: the Activity list on /inbox, the search
              // results on /search — same master/detail slot drives col 3.
              isInboxRoute ? (
                <Suspense fallback={<PanelFallback />}><ThreadsInbox /></Suspense>
              ) : (
                <Suspense fallback={<PanelFallback />}><MessageSearchPage /></Suspense>
              )
            ) : (
              <Sidebar
                mobileInline={mobileShowSidebarInline}
                announcementSlot={sidebarAnnouncementSlot}
                hideTitle={showTopBar}
              />
            )}
          </ShellSidebarColumn>
        </AppShellSidebarSlot>
      )}
      // Main content — hidden on mobile root views (sidebar is the content),
      // visible on mobile detail views and always on desktop.
      mainHidden={mobileShowSidebarInline}
      main={(
        <div
          ref={contentColumnRef}
          className="thread-layout-container relative flex min-h-0 min-w-0 flex-1"
          data-testid="thread-layout-container"
          // The thread's Expand (#189 rule 5); a profile is a column like the others on a desktop, so it doesn't undo it.
          data-thread-maximized={threadRow.maximized ? "true" : "false"}
          // Workspace Artifacts (F41): the thread stepped behind its channel, see index.css.
          data-thread-behind={threadRow.behind ? "true" : undefined}
        >
          {/* Task v2: the side sections' heads, wherever they render in the row, move them among its columns (no DOM of its own). */}
          <SideSectionDnd>
          {/* overflow-clip, not overflow-hidden: a hidden box is still a
              scroll container, so focusing anything that pokes past it
              (scrollIntoView, an autofocused field) slid the whole page
              sideways. A clipped box cannot scroll at all. */}
          <div
            className="thread-main-column flex min-h-0 min-w-0 flex-1 flex-col overflow-clip outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground"
            data-testid="thread-main-column"
            // The conversation a thread or detail column takes its width from (ColumnResizeHandle).
            data-main-column=""
            data-otter-dock="conversation"
          >
            <RowColumnSlotContext.Provider value={rowColumnSlot}>
            <Routes location={backgroundLocation ?? location}>
              <Route path="channel/:channelId" element={<ChannelRoute />} />
              <Route path="channel/:channelId/search" element={<ConversationSearchRoute kind="channel" />} />
              <Route path="dm/:dmId" element={<DmRoute />} />
              <Route path="dm/:dmId/search" element={<ConversationSearchRoute kind="dm" />} />
              <Route path="agent/:agentId" element={<AgentRoute />} />
              <Route path="agent/:agentId/activity" element={<AgentActivityRoute />} />
              <Route path="computer/:machineId" element={<MachineRoute />} />
              {/* Legacy /machine/:id — kept so external links and bookmarks
                  still work; redirected to /computer/:id by RailNavCompat. */}
              <Route path="machine/:machineId" element={<MachineRoute />} />
              <Route path="human/:userId" element={<HumanRoute />} />
              {/* Retired member graph: old links and bundles land on Members. */}
              <Route path="members/graph" element={<LegacyMemberGraphRedirect />} />
              <Route path="migrations" element={<MigrationLogRoute />} />
              <Route path="members" element={<MembersEmptyRoute />} />
              <Route path="computers" element={<ComputersRoute />} />
              <Route path="computers/this-device" element={<Suspense fallback={<PanelFallback />}><ThisDevicePanel /></Suspense>} />
              <Route path="apps" element={<AppsRoute />} />
              <Route path="more" element={<MoreRoute />} />
              <Route path="search" element={<SearchContentRoute />} />
              <Route path="raftbench" element={<Suspense fallback={<PanelFallback />}><RaftBenchPage /></Suspense>} />
              <Route path="assistant" element={<Suspense fallback={<PanelFallback />}><AssistantRoute /></Suspense>} />
              <Route path="settings/:tab?/*" element={<SettingsRoute />} />
              <Route path="activity" element={<InboxContentRoute />} />
              {/* Legacy /inbox + /threads → /activity (stdrc renamed the route
                  #proj-activity:171042a3 2026-06-23). Keep redirects so old
                  links/bookmarks resolve. */}
              <Route path="inbox" element={<LegacyThreadsRedirect />} />
              <Route path="threads" element={<LegacyThreadsRedirect />} />
              <Route path="tasks" element={<TasksRoute />} />
              <Route path="saved" element={<SavedRoute />} />
              <Route path="drafts" element={<DraftsRoute />} />
              <Route path="artifacts" element={<ArtifactsRoute />} />
              <Route path="release-notes" element={<ReleaseNotesRoute />} />
              <Route path="keyboard-shortcuts" element={<ShortcutHelpPage />} />
              {/* Legacy /workspace from the removed Workspace grid layout. */}
              <Route path="workspace" element={<LegacyWorkspaceGridRedirect />} />
              <Route path="*" element={<DefaultRoute />} />
            </Routes>
            </RowColumnSlotContext.Provider>
            {/* Workspace Artifacts: where one clicked outside a channel panel opens (the opening rule). */}
            <ShellArtifactHost />
            <AssistantOtterLayer pageOtter={assistantPageOtter && !mobileShowSidebarInline} />
          </div>
          {/* A page's own column right of the conversation, a column of the row (rowColumnSlot): the Tasks page's
              task beside its list. `contents`: the column is the row's flex item, right after the conversation. */}
          <div ref={setRowColumnSlot} className="contents" data-testid="row-column-slot" />
          <RightPanel />
          <ShortcutHelpColumn />
          {/* Task v2's Tasks and Files columns, at the row's level beside the
              thread when the row fits them (ChannelSideArea; task #165).
              `contents`: each column is the row's flex item. */}
          <div className="contents" data-testid="channel-side-slot"><ChannelSideArea /></div>
          {/* Always the row's last child. Opening or closing a thread or a
              profile adds and removes columns before it, so neither the
              channel column nor the thread column ever turns into (or stops
              being) the last child: WebKit restyles that column's whole
              subtree when it does (~180ms for a long chat on an iPhone). */}
          <div hidden data-slot="thread-layout-end" />
          </SideSectionDnd>
        </div>
      )}
      after={(
        <>
          <MobileTabBar />
          {currentServerId && serverSlug ? (
            <ServerSetupProjectionGate
              serverId={currentServerId}
              serverSlug={serverSlug}
            />
          ) : null}
          {showAddMachine && <AddMachineDialog onClose={closeAddMachine} />}
          {showCreateAgent && (
            <CreateAgentDialog
              onboarding={createAgentOnboarding}
              onClose={closeCreateAgent}
            />
          )}
          <JointChannelLinkIntent />
          <AgentContextViewPageSlot />
          <UpgradeDialogHost />
          <SeatJoinDialogHost />
          <AnnouncementModal suppressed={shouldSuppressAnnouncements(announcementGateState, sawOnboardingThisSession) || landingHoldsAnnouncements} preferSidebar={isDesktop && !hideSidebar && !searchMasterDetail && !sidebarCollapsed} sidebarContainer={announcementHost} />
          {/* Desktop ⌘K search overlay: floats the real /search over the frozen
              background channel. Dismiss (Esc/backdrop) navigates back to it. A hit
              selection navigates away on its own (clearing backgroundLocation). */}
          {backgroundLocation ? (
            <SearchOverlay onClose={closeSearchOverlay} contentColumnRef={showTopBar ? null : contentColumnRef} />
          ) : null}
        </>
      )}
    />
  );
}

export const __testInternals = {
  AgentActivityRoute, AgentRoute, ArtifactsRoute, HumanRoute,
  DmRoute,
  ComputersRoute,
  LegacyTaskSidePanelFallback,
  ProfilePanelFallback,
  RightPanel,
  AgentById,
  DefaultRoute,
  InboxContentRoute,
  MachineRoute,
  SearchContentRoute,
  SettingsRoute,
  renderContentSlot,
  useRightPanelUrlSync,
  useSearchContentUrlSync,
};
