import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Suspense, lazy } from "react";
import { Badge, Skeleton, toast } from "raft-ui";
import { useResizablePanel } from "../../hooks/useResizablePanel";
import { MASTER_DETAIL_COMPACT_PANEL_BOUNDS, resolveMasterDetailPanelWidth } from "./masterDetailPanelSizing";
import { Routes, Route, Navigate, useParams, useNavigate, useLocation } from "react-router-dom";
import { useIntl } from "react-intl";
import { useChannelStore } from "../../store/channelStore";
import { useAgentStore } from "../../store/agentStore";
import { useMessageStore } from "../../store/messageStore";
import { useInboxStore } from "../../store/inboxStore";
import type { InboxItem } from "../../store/inboxStore";
import { useTaskStore, selectChannelTaskBucket } from "../../store/taskStore";
import { loadThreadParentTasksIfNeeded, resolveThreadHostTask } from "./threadHostTask";
import type { Task } from "../../store/taskStore";
import type { SavedEntry } from "../../store/savedStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { shouldSuppressAnnouncements, useOnboardingAnnouncementGateStore } from "../../store/onboardingAnnouncementGateStore";
import { mainLayoutRealtimeBridgeDriver } from "../../store/mainLayoutRealtimeBridgeDriver";
import { useMainLayoutRealtimeBridge } from "../../store/socketBridge";
import Sidebar from "./Sidebar";
import { isHostShell } from "../../embed";
import { useEmbedParamsKeeper } from "../../hooks/useEmbedParamsKeeper";
import { LeftRail } from "./LeftRail";
import { useTabRouteMemory } from "../../hooks/useTabRouteMemory";
import { useRailLegacyRedirect } from "../../hooks/useRailLegacyRedirect";
import { useMobileNav } from "../../hooks/useMobileNav";
import ChatPanel from "../message/ChatPanel";
import MobileComputersPanel from "../machine/MobileComputersPanel";
import ThreadPanel from "../message/ThreadPanel";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useAuthStore } from "../../store/authStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import {
  useSearchContentStore,
  parseSearchOpenParam,
  formatSearchOpenParam,
} from "../../store/searchContentStore";
import type {
  SearchContentSlot,
} from "../../store/searchContentStore";
import {
  isCurrentRightPanelSearchSnapshot,
  subscribeRightPanelThreadAnchor,
  syncRightPanelStoresFromSearch,
  syncRightPanelUrlFromStores,
} from "./rightPanelUrlSync";
import { isGlobalSearchShortcut } from "../../utils/keyboardShortcuts";
import {
  routeGlobalSearchShortcut,
  SEARCH_FOCUS_REQUEST_EVENT,
} from "../../utils/searchFocusRequest";
import { ArrowLeft, CheckSquare, GitBranch, Home, Settings, Users, X } from "lucide-react";
import api from "../../api/client";
import type { HumanProfile } from "../member/HumanDetailPanel";
import { resolveHumanProfile } from "../member/resolveHumanProfile";
import { canRenderAgentDetail } from "../agent/agentDetailAvailability";
import { getCachedAgentProfile } from "../profile/profileFallbackCache";
import { useMobileBack } from "../../hooks/useAppNavigate";
import PanelHeader from "../ui/PanelHeader";
import LiveAgentActivityBar, { useClearLiveAgentActivityOnServerChange } from "./LiveAgentActivityBar";
import MobileBottomBarStack from "./MobileBottomBarStack";
import Modal from "../Modal";
import {
  WORKSPACE_GRID_DEMO_ROUTE,
  WORKSPACE_GRID_VIEWPORT_QUERY,
} from "../workspace/workspaceGridDemoConfig";
import { emitWorkspaceGridDragPanel, emitWorkspaceGridOpenPanel, isWorkspaceGridDemoPath } from "../workspace/workspaceGridOpenEvents";
import { useWorkspaceGridAvailability } from "../workspace/workspaceGridAvailability";
import {
  DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH,
  MAX_WORKSPACE_GRID_SIDEBAR_WIDTH,
  MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,
  maxWorkspaceGridSidebarWidth,
  useWorkspaceGridNavigationStore,
} from "../workspace/workspaceGridNavigationStore";
import type {
  WorkspaceGridRailSide,
} from "../workspace/workspaceGridNavigationStore";
import type { WorkspacePanelRef } from "../workspace/workspaceGridDemoConfig";
import { legacySettingsRouteRedirectSlug } from "../settings/settingsNavigation";
import { isChangePasswordSettingsIntent } from "../../utils/changePasswordNavigation";
import ServerSetupProjectionGate from "../onboarding/ServerSetupProjectionGate";
import {
  buildThreadRoutePath,
  consumeThreadRefHandoffSearch,
  executeThreadRefHandoffOnce,
  parseThreadRefHandoff,
  resolveThreadTargetByShortId,
} from "../../utils/threadRefNavigation";
import { WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { buildSidebarDisclosureRestoreState } from "./sidebarChannelFocus";

const THEME_CHROME_YELLOW = "#FFD440";
const THEME_CHROME_WHITE = "#FFFFFF";
const MOBILE_TAB_BAR_SAFE_BOTTOM = "min(env(safe-area-inset-bottom, 0px), 34px)";

function useWorkspaceSidebarResize({
  side,
  direction,
  width,
  userId,
}: {
  side: WorkspaceGridRailSide;
  direction: "left" | "right";
  width: number;
  userId: string | null;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const setSidebarWidth = useWorkspaceGridNavigationStore((state) => state.setSidebarWidth);

  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.style.width = `${width}px`;
  }, [width]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startWidth = panel.getBoundingClientRect().width;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;
    const delta = direction === "right" ? event.clientX - drag.startX : drag.startX - event.clientX;
    const nextWidth = Math.max(
      MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,
      Math.min(maxWorkspaceGridSidebarWidth(), drag.startWidth + delta),
    );
    drag.width = nextWidth;
    panel.style.width = `${nextWidth}px`;
  }, [direction]);

  const finishResize = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setSidebarWidth(side, drag.width, userId);
  }, [setSidebarWidth, side, userId]);

  const resetWidth = useCallback(() => {
    if (panelRef.current) panelRef.current.style.width = `${DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH}px`;
    setSidebarWidth(side, DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH, userId);
  }, [setSidebarWidth, side, userId]);

  return {
    panelRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp: finishResize,
    handlePointerCancel: finishResize,
    resetWidth,
  };
}

// Lazy-loaded route panels (code splitting)
const AgentDetailPanel = lazy(() => import("../agent/AgentDetailPanel"));
const AgentUnavailablePanel = lazy(() => import("../agent/AgentUnavailablePanel"));
const MachineDetailPanel = lazy(() => import("../machine/MachineDetailPanel"));
const HumanDetailPanel = lazy(() => import("../member/HumanDetailPanel"));
const SettingsPanel = lazy(() => import("../settings/SettingsPanel"));
const WorkspaceSettingsModal = lazy(() => import("../settings/WorkspaceSettingsModal"));
const MemberGraphSection = lazy(() => import("../settings/MemberGraphSection"));
const ReleaseNotesPanel = lazy(() => import("../settings/ReleaseNotesPanel"));
const ThreadsInbox = lazy(() => import("../thread/ThreadsInbox"));
const TasksPanel = lazy(() => import("../task/TasksPanel"));
const SavedPanel = lazy(() => import("../saved/SavedPanel"));
const WikiPanel = lazy(() => import("../wiki/WikiPanel"));
const ProfilePanel = lazy(() => import("../profile/ProfilePanel"));
const LegacyTaskPanel = lazy(() => import("../task/LegacyTaskPanel"));
const TaskModalHead = lazy(() => import("../task/TaskModalHead"));
const WorkspaceGridDemo = lazy(() => import("../workspace/WorkspaceGridDemo"));
const WorkspaceRailPanelFrame = lazy(() => import("../workspace/WorkspaceRailPanelFrame"));

/** Returns true when the mobile bottom tab bar should be visible on the
 *  current route. Used by both the bar itself and its in-flow spacer so that
 *  detail views (which return null from MobileTabBar) don't leave a stray
 *  empty strip below the page content.
 *
 *  iOS NavigationView model (per @stdrc 2026-04-30 #proj-uiux:c8711d2a):
 *  the tab bar lives at the root of each tab's stack only. When the user
 *  pushes to a detail (channel / dm / agent / human / computer / settings
 *  detail / search) the new view covers the full screen including the tab
 *  bar — there is no concept of "switch tabs from inside a detail". To
 *  switch tabs the user pops back to the tab home first via the back button.
 */
function useMobileTabBarVisible(): boolean {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const threadOpen = useThreadStore((s) => !!s.openParentMessageId);
  const searchSlotOpen = useSearchContentStore((s) => !!s.slot);

  if (!serverSlug) return false;

  const pathBase = `/s/${serverSlug}`;
  const path = location.pathname;

  if (threadOpen) return false;
  if (searchSlotOpen) return false;

  // Hide on detail routes: channel, DM, search, agent, human, computer,
  // settings sub-pages.
  // /computers and /release-notes are level-2 pushes under the Settings tab per
  // @stdrc 2026-04-30 #proj-uiux:c8711d2a ("tabbar is level-1; any view you push
  // into covers the navbar and shows a back button top-left").
  const isChannelDetail = path.startsWith(`${pathBase}/channel/`);
  const isDMDetail = path.startsWith(`${pathBase}/dm/`);
  const isSearchDetail = path === `${pathBase}/search` || path.startsWith(`${pathBase}/search/`);
  const isWikiDetail = path === `${pathBase}/wiki` || path.startsWith(`${pathBase}/wiki/`);
  const isAgentDetail = path.startsWith(`${pathBase}/agent/`);
  const isHumanDetail = path.startsWith(`${pathBase}/human/`);
  const isMembersDetail = path.startsWith(`${pathBase}/members/`);
  const isComputerDetail = path.startsWith(`${pathBase}/computer/`) || path.startsWith(`${pathBase}/machine/`);
  const isComputersList = path === `${pathBase}/computers` || path.startsWith(`${pathBase}/computers/`);
  const isSettingsDetail = path.startsWith(`${pathBase}/settings/`) || path.startsWith(`${pathBase}/release-notes`);
  // Inbox/legacy Threads + Saved are level-2 pushes from Chat tab — same iOS NavigationView
  // model as channel/DM detail. stdrc 2026-05-02 #proj-uiux:648f8735 0a4084eb:
  // "在移动端点击 Threads 和 Saved 出来的页面，没有覆盖掉 Tab Bar" — fix to
  // match the channel/DM/agent detail behavior.
  const isInboxList = path === `${pathBase}/activity` || path.startsWith(`${pathBase}/activity/`);
  const isThreadsList = path === `${pathBase}/threads` || path.startsWith(`${pathBase}/threads/`);
  const isSavedList = path === `${pathBase}/saved` || path.startsWith(`${pathBase}/saved/`);

  if (
    isChannelDetail || isDMDetail || isSearchDetail || isWikiDetail || isAgentDetail || isHumanDetail || isMembersDetail ||
    isComputerDetail || isComputersList || isSettingsDetail ||
    isInboxList || isThreadsList || isSavedList
  ) {
    return false;
  }

  // Show on tab home routes only: chat root, /tasks, /members, /settings.
  return true;
}

/** Mobile bottom tab bar — shown only on root-level views (md:hidden).
 *  Hidden when user drills into a detail view (channel, DM, thread, member detail). */
export function MobileTabBar() {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const serverRole = useServerStore((s) => s.current?.role);
  const visible = useMobileTabBarVisible();
  const { selectTab } = useMobileNav();
  // Display-language (react-intl) — layout namespace. Called BEFORE the
  // host-shell / visibility early-returns below so the hook order is stable.
  const { formatMessage } = useIntl();

  // HOST-SHELL EMBED: the native WebView owns its own chrome. The app's global
  // navigation must not render inside it — checked on the RENDER PATH, not in an
  // effect, so the very first frame is already correct. (An effect would paint the
  // tab bar and then remove it: a flash the user sees while every "final DOM"
  // assertion still reports green.)
  if (isHostShell()) return null;
  if (!visible || !serverSlug) return null;

  const pathBase = `/s/${serverSlug}`;
  const path = location.pathname;
  // 4-tab mobile bar (per @stdrc 2026-04-30 #proj-uiux:c8711d2a):
  // Home / Tasks / Members / Settings. Search is a Home drill-in on mobile,
  // not a top-level tab. Computers is reachable from inside Settings; it is
  // not a top-level tab on mobile.
  const isSettings = path.startsWith(`${pathBase}/settings`)
    || path.startsWith(`${pathBase}/release-notes`)
    || path === `${pathBase}/computers`
    || path.startsWith(`${pathBase}/computers/`)
    || path.startsWith(`${pathBase}/computer/`)
    || path.startsWith(`${pathBase}/machine/`); // legacy
  const isTasks = !isSettings && (path === `${pathBase}/tasks` || path.startsWith(`${pathBase}/tasks/`));
  const isMembers = !isSettings && !isTasks && (
    path === `${pathBase}/members`
      || path.startsWith(`${pathBase}/members/`)
      || path.startsWith(`${pathBase}/agent/`)
      || path.startsWith(`${pathBase}/human/`)
  );
  const isChat = !isSettings && !isTasks && !isMembers;

  // selectTab (see useMobileNav): every tab tap navigates to that tab's
  // root, regardless of active state. Per-tab sub-page memory is dropped.
  // (stdrc 2026-05-09 #proj-mobile:b1c622e5 task #11 — sub-pages hide the
  // tab bar; restoring sub-page on tab tap traps the user without a path
  // back to root.)
  const tabs = [
    { id: "chat", label: formatMessage({ id: "layout.mobileTabBar.home" }), icon: Home, active: isChat, onClick: () => selectTab("chat") },
    { id: "tasks", label: formatMessage({ id: "layout.mobileTabBar.tasks" }), icon: CheckSquare, active: isTasks, onClick: () => selectTab("tasks") },
    ...(serverRole === "guest" ? [] : [
      { id: "members", label: formatMessage({ id: "layout.mobileTabBar.members" }), icon: Users, active: isMembers, onClick: () => selectTab("members") },
    ]),
    { id: "settings", label: formatMessage({ id: "layout.mobileTabBar.settings" }), icon: Settings, active: isSettings, onClick: () => selectTab("settings") },
  ];

  // In-flow (not fixed): the bar is the last child of the MainLayout flex
  // column, which is itself pinned to the visual viewport via #root. This
  // avoids two iOS bugs: (1) `fixed; bottom:0` ending up above the visible
  // bottom in PWA standalone because the layout viewport is taller than the
  // visible area, and (2) the fixed bar being covered by the keyboard in
  // mobile Safari because `fixed; bottom:0` anchors to layout viewport which
  // doesn't shrink with the keyboard. Safe-area is added via padding-bottom,
  // capped at the iPhone home-indicator inset so bad PWA/browser reports do
  // not create a large blank strip below the tabs.
  return (
    <div
      // stdrc 2026-05-02 #proj-uiux:95e25b5b 6e039b98: "移动端的每一个
      // 界面背景色都应该相应地变成白色". MobileTabBar bg cream → white;
      // active tab pill stays bg-soft-signal (brand on selected); inactive
      // active-pressed feedback dropped from cream → black/5.
      className="md:hidden shrink-0 border-t-2 border-black bg-white"
      style={{ paddingBottom: MOBILE_TAB_BAR_SAFE_BOTTOM }}
    >
      <div className="flex">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            onClick={tab.onClick}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 [@media(max-height:600px)]:py-2 [@media(max-height:600px)]:min-h-9 text-[10px] font-bold tracking-wider transition-colors ${
              i < tabs.length - 1 ? "border-r-2 border-black" : ""
            } ${tab.active ? "bg-soft-signal" : "bg-white active:bg-black/5"}`}
          >
            {/* stdrc 2026-05-02 #proj-uiux:648f8735 16b2ec7b 3(a): on
                short viewports drop the icon and keep just the text label
                — saves vertical density. */}
            <tab.icon size={18} className="[@media(max-height:600px)]:hidden" />
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

import AddMachineDialog from "../machine/AddMachineDialog";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import AnnouncementModal from "../AnnouncementModal";
import MessageSearchPage from "../search/MessageSearchPage";
import PwaInstallPrompt from "../pwa/PwaInstallPrompt";

/** Channel content body — used by both /channel/:channelId AND the
 *  /search master/detail layout (col 3 when slot.kind === "channel").
 *  Pulling the lookup-and-hydrate logic out of the route component lets the
 *  search-slot path render the same content without faking URL params. */
function ChannelById({ channelId }: { channelId: string }) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const [missingChannelId, setMissingChannelId] = useState<string | null>(null);
  const all = [...channels, ...dmChannels];
  const channel = all.find((c) => c.id === channelId);

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
  if (!channel && missingChannelId !== channelId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-black/40 font-display text-lg font-bold uppercase">
        {formatMessage({ id: "layout.main.loadingChannel" })}
      </div>
    );
  }

  return <ChatPanel channel={channel ?? null} />;
}

/** Route: /channel/:channelId */
function ChannelRoute() {
  const { channelId } = useParams<{ channelId: string }>();
  if (!channelId) return <ChatPanel channel={null} />;
  return <ChannelById channelId={channelId} />;
}

/** DM body — same pattern as ChannelById, used by both the route and the
 *  /search col-3 slot. */
function DmById({ dmId }: { dmId: string }) {
  const { formatMessage } = useIntl();
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const ensureChannel = useChannelStore((s) => s.ensureChannel);
  const [missingDmId, setMissingDmId] = useState<string | null>(null);
  const channel = dmChannels.find((c) => c.id === dmId);

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

  if (!channel && missingDmId !== dmId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-black/40 font-display text-lg font-bold uppercase">
        {formatMessage({ id: "layout.main.loadingChannel" })}
      </div>
    );
  }

  return <ChatPanel channel={channel ?? null} />;
}

/** Route: /dm/:dmId */
function DmRoute() {
  const { dmId } = useParams<{ dmId: string }>();
  if (!dmId) return <ChatPanel channel={null} />;
  return <DmById dmId={dmId} />;
}

/** Suspense fallback for lazy-loaded main-area panels (routed full-page views:
 *  AgentRoute, MachineRoute, HumanRoute, SettingsRoute, ReleaseNotesRoute, etc.).
 *  `flex-1` fills the routes container column. */
function PanelFallback() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-1 items-center justify-center text-black/40 font-display text-lg font-bold">
      {formatMessage({ id: "layout.main.loading" })}
    </div>
  );
}

/** Suspense fallback for lazy-loaded OVERLAY panels (ProfilePanel, LegacyTaskPanel).
 *  These render alongside the main content in the same flex row; a `flex-1` fallback
 *  would split the mobile viewport 50/50 with the main panel, producing the
 *  "half-loaded agent detail" bug reported in `#proj-uiux:c8711d2a` msg=f4f07d15
 *  (2026-05-01). On mobile the panel itself uses `absolute inset-0 z-30` to cover
 *  the main content, so its fallback must use the same geometry — otherwise during
 *  the few hundred ms of lazy chunk load we flash the split. On desktop the
 *  overlay panel is inline (`md:relative`), so `md:flex-1` restores the normal
 *  sidebar-like fill. */
function OverlayPanelFallback() {
  const { formatMessage } = useIntl();
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-white text-black/40 font-display text-lg font-bold md:relative md:inset-auto md:z-auto md:flex-1 md:border-l-2 md:border-black">
      {formatMessage({ id: "layout.main.loading" })}
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
function AgentById({ agentId, onBack }: { agentId: string; onBack?: () => void }) {
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
  return <Suspense fallback={<PanelFallback />}><AgentDetailPanel agent={projectedAgent} onBack={onBack} /></Suspense>;
}

/** Route: /agent/:agentId */
function AgentRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  if (!agentId) return null;
  return <AgentById agentId={agentId} />;
}

/** Computer body — used by both /computer/:machineId and the /search col-3 slot. */
function MachineById({ machineId }: { machineId: string }) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const machine = machines.find((m) => m.id === machineId);
  if (!machine) {
    return (
      <div className="flex flex-1 items-center justify-center text-black/40 font-display text-lg font-bold uppercase">
        {formatMessage({ id: "layout.main.computerNotFound" })}
      </div>
    );
  }
  return <Suspense fallback={<PanelFallback />}><MachineDetailPanel machine={machine} /></Suspense>;
}

/** Route: /machine/:machineId */
function MachineRoute() {
  const { machineId } = useParams<{ machineId: string }>();
  const server = useServerStore((s) => s.current);
  if (!machineId) return null;
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
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
    <div className="flex flex-1 items-center justify-center text-black/40 font-display text-lg font-bold uppercase">
      {formatMessage({ id: "layout.main.humanNotFound" })}
    </div>
  );
}

/** Route: /human/:userId */
function HumanRoute() {
  const { userId } = useParams<{ userId: string }>();
  if (!userId) return null;
  return <HumanById userId={userId} />;
}

/** Route: /settings/:tab?/* */
function SettingsRoute() {
  const { tab } = useParams<{ tab: string }>();
  const location = useLocation();
  const canonicalSlug = legacySettingsRouteRedirectSlug(tab);
  if (canonicalSlug) {
    return (
      <Navigate
        to={{
          pathname: location.pathname.replace(/\/settings\/[^/]+\/?$/, `/settings/${canonicalSlug}`),
          search: location.search,
          hash: location.hash,
        }}
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

/** Route: /members/graph */
function MemberGraphRoute() {
  const server = useServerStore((s) => s.current);
  const serverSlug = server?.slug;
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/members` : "/");
  const { formatMessage } = useIntl();

  if (server?.role === "guest") {
    return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={formatMessage({ id: "layout.memberGraph.title" })}
        titleSuffix={<Badge.Experimental className="-translate-y-px" />}
        icon={<GitBranch size={18} />}
        iconBg="bg-soft-signal text-black"
        onMobileBack={onMobileBack}
        mobileBackProps={{ "data-testid": "member-graph-mobile-back", title: formatMessage({ id: "layout.memberGraph.back" }) }}
      />
      <div className="flex-1 overflow-y-auto bg-white px-5 py-4">
        <Suspense fallback={<PanelFallback />}>
          <MemberGraphSection sectionLabel={formatMessage({ id: "layout.memberGraph.connectionsSectionLabel" })} />
        </Suspense>
      </div>
    </div>
  );
}

/** Route: /release-notes */
function ReleaseNotesRoute() {
  return <Suspense fallback={<PanelFallback />}><ReleaseNotesPanel /></Suspense>;
}

function LegacyWorkspaceGridRedirect() {
  const slug = useServerStore((s) => s.current?.slug);
  return <Navigate to={slug ? `/s/${slug}` : "/"} replace />;
}


function LegacyThreadsRedirect() {
  const slug = useServerStore((s) => s.current?.slug);
  return <Navigate to={slug ? `/s/${slug}/activity` : "/"} replace />;
}

/** Route: /saved */
function SavedRoute() {
  return <Suspense fallback={<PanelFallback />}><SavedPanel /></Suspense>;
}

/** Route: /tasks */
function TasksRoute() {
  return <Suspense fallback={<PanelFallback />}><TasksPanel /></Suspense>;
}

/** Route: /wiki */
function WikiRoute() {
  const serverSlug = useServerStore((s) => s.current?.slug);
  const wikiFeatureFlag = useServerFeatureFlag(WIKI_FEATURE_FLAG_KEY);
  if (!wikiFeatureFlag.resolved) return <PanelFallback />;
  if (!wikiFeatureFlag.enabled) {
    return <Navigate to={serverSlug ? `/s/${serverSlug}` : "/"} replace />;
  }
  return <Suspense fallback={<PanelFallback />}><WikiPanel /></Suspense>;
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
  return (
    <ThreadPanel
      presentation="side"
      onClose={() => {
        useThreadStore.getState().closeThread();
        closeSlot();
      }}
    />
  );
}

function SearchContentRoute() {
  const slot = useSearchContentStore((s) => s.slot);
  const closeSlot = useSearchContentStore((s) => s.close);
  if (!slot) return <MessageSearchPage />;
  return renderContentSlot(slot, closeSlot);
}

/** Route: /activity — Activity surface, rendered as the search-style
 *  master/detail (no slot → full-width list; slot → picked entity in col 3,
 *  with the list hosted in col 2 by the master/detail layout). The
 *  rail-vs-sidebar placement A/B was dropped 2026-06-30 (stdrc) — Activity is
 *  always the rail master/detail surface now. */
function InboxContentRoute() {
  const slot = useSearchContentStore((s) => s.slot);
  const closeSlot = useSearchContentStore((s) => s.close);
  if (!slot) {
    return <Suspense fallback={<PanelFallback />}><ThreadsInbox /></Suspense>;
  }
  if (slot.kind === "thread") {
    return <ActivityThreadContentRoute slot={slot} closeSlot={closeSlot} />;
  }
  return renderContentSlot(slot, closeSlot);
}

export function ActivityThreadContentRoute({ slot, closeSlot }: { slot: SearchContentSlot; closeSlot: () => void }) {
  const { formatMessage } = useIntl();
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
      void loadInbox({ reset: true });
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

  if (!threadIdentity) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-white">
        <PanelHeader title={formatMessage({ id: "message.threadPanel.thread" })} containerProps={{ className: "shrink-0" }} />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="text-black/40 font-mono text-sm">
            {loaded
              ? formatMessage({ id: "layout.main.threadNotInActivity" })
              : formatMessage({ id: "common.loading" })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ThreadPanel
      presentation="side"
      threadIdentity={{
        parentChannelId: threadIdentity.parentChannelId,
        parentMessageId: threadIdentity.parentMessageId,
        threadChannelId: threadIdentity.threadChannelId,
        focusedMessageId: slot.messageId ?? null,
      }}
      onFocusedMessageConsumed={() => consumeMessageFocus("thread", slot.id)}
      onClose={closeSlot}
    />
  );
}

/** Route: * — redirect to first channel */
function DefaultRoute() {
  const location = useLocation();
  const channels = useChannelStore((s) => s.channels);
  const loading = useChannelStore((s) => s.loading);
  const slug = useServerStore((s) => s.current?.slug);
  const [isDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const disclosureRestoreState = useMemo(() => buildSidebarDisclosureRestoreState(), []);
  const suppressDefaultRouteRedirect =
    (location.state as { suppressDefaultRouteRedirect?: unknown } | null)?.suppressDefaultRouteRedirect === true;
  const defaultChannelPath = slug && channels[0]
    ? `/s/${slug}/channel/${channels[0].id}`
    : null;
  // On mobile, don't auto-redirect — the sidebar (channel list) is shown inline
  // as the main content via the master-detail layout in MainLayout.
  if (
    isDesktop
    && defaultChannelPath
    && !suppressDefaultRouteRedirect
    && location.pathname !== defaultChannelPath
  ) {
    return (
      <Navigate
        to={defaultChannelPath}
        replace
        state={disclosureRestoreState}
      />
    );
  }
  // A wildcard test harness (or an embedding shell) can keep this element
  // mounted after the redirect reaches the canonical channel route. Do not
  // render a second ChatPanel in that settled state; the real channel route
  // owns the surface, and returning null also prevents the redirect effect
  // from retriggering on every location update.
  if (isDesktop && defaultChannelPath && location.pathname === defaultChannelPath && !suppressDefaultRouteRedirect) {
    return null;
  }
  if (loading) {
    return null;
  }
  // Desktop: show empty state. Mobile: this won't be visible (sidebar is shown instead).
  return <ChatPanel channel={null} />;
}

// Empty placeholder for /members and /computers root routes. Unlike
// DefaultRoute, these MUST NOT auto-redirect to the first channel — that
// would silently flip the URL into chat mode (and re-highlight the Chat
// rail button) the moment the user clicks Members or Computers.
function EmptyRoute() {
  const server = useServerStore((s) => s.current);
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
  }
  return <ChatPanel channel={null} />;
}

// Computers route — on desktop the Sidebar owns the Computers rail with
// the list of machines, and the main panel shows the empty ChatPanel.
// On mobile the Sidebar is not rendered for /computers (removed from
// isMobileMasterRoute 2026-05-01 per stdrc msg 2a500cb7), so the main
// panel here IS the page the user sees: MobileComputersPanel renders a
// proper h-[62px] yellow navbar + cream body + cards, matching the
// other mobile panels (Tasks / Saved / Threads / Settings sub-pages).
function ComputersRoute() {
  const server = useServerStore((s) => s.current);
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
  return forceMobilePanel ? <MobileComputersPanel /> : <ChatPanel channel={null} />;
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
 *  - "modal"        — bordered card with shadow-brutal, fixed centered size.
 *                     Caller wraps in <Modal> for backdrop + ESC.
 *  - "mobile-modal" — full-screen overlay (no Modal wrapper); back chevron is
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
function TaskModalBar({
  task,
  onClose,
  mobile = false,
}: {
  task: Task;
  onClose: () => void;
  mobile?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    // items-center, not items-start: the X is one control weighed against the
    // whole two-line block, so it centres on that block. I had left items-start
    // from when the bar was a single line, which parked the X against the first
    // line's top edge.
    <div className="flex shrink-0 items-center gap-3 border-b-2 border-black bg-white px-4 py-2">
      {mobile && (
        <button
          type="button"
          onClick={onClose}
          aria-label={formatMessage({ id: "task.modal.close" })}
          data-testid="task-modal-mobile-back"
          className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"
        >
          <ArrowLeft size={14} />
        </button>
      )}
      {/* Two lines so the bar has body: where this lives, then what it is.
          Both are stable facts — the task's own title stays in the scrolling
          body, because a long one cannot be bounded by a fixed bar. */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-bold text-black/60">
          {channelSigil(task.channelName || formatMessage({ id: "task.properties.unknownChannel" }))}
        </div>
        <div className="truncate text-sm font-bold" data-testid="task-modal-bar-label">
          {formatMessage({ id: "task.modal.taskWithNumber" }, { taskNumber: task.taskNumber })}
        </div>
      </div>
      {!mobile && (
        <button
          type="button"
          onClick={onClose}
          aria-label={formatMessage({ id: "task.modal.close" })}
          data-testid="task-modal-close"
          className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function ThreadPanelWrapper({ presentation = "side" }: { presentation?: "side" | "modal" | "mobile-modal" }) {
  const parentMessageId = useThreadStore((s) => s.openParentMessageId);
  const closeThread = useThreadStore((s) => s.closeThread);
  const hostTask = useThreadHostTask(parentMessageId);
  // The task sheet owns the current history entry. Close the store first so
  // the panel disappears synchronously, then consume the PUSH that opened it.
  // On a cold deep link there is no safe entry to pop, so the callback fallback
  // simply closes the sheet and leaves the user on the underlying Tasks route.
  const mobileTaskBack = useMobileBack(closeThread, closeThread);
  if (!parentMessageId) return null;
  // Composition point, deliberately: Properties is mounted ABOVE ThreadPanel
  // rather than inside it. ThreadPanel's identity is "the replies of a
  // message", and the endgame (a task owning its own discussion channel)
  // deletes exactly that premise — so task-shaped concerns must not accrete
  // inside it. See #proj-task thread 3a4a72db.
  if (presentation === "modal") {
    return (
      <div
        className="flex h-[min(86vh,900px)] max-h-[calc(100dvh-2rem)] w-[min(960px,calc(100vw-2rem))] flex-col overflow-hidden border-2 border-black bg-white shadow-brutal"
        data-testid="task-thread-modal"
      >
        {hostTask && <TaskModalBar task={hostTask} onClose={closeThread} />}
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPanel key={parentMessageId} presentation="modal" hideHeader={!!hostTask} hideParentMessage={!!hostTask}
            parentSlot={hostTask ? <Suspense fallback={<div className="space-y-3 border-b-2 border-black bg-white p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>}><TaskModalHead task={hostTask} /></Suspense> : undefined} />
        </div>
      </div>
    );
  }
  if (presentation === "mobile-modal") {
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-white" data-testid="task-thread-modal">
        {hostTask && (
          <TaskModalBar task={hostTask} onClose={mobileTaskBack} mobile />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPanel key={parentMessageId} presentation="mobile-modal" hideHeader={!!hostTask} hideParentMessage={!!hostTask}
            parentSlot={hostTask ? <Suspense fallback={<div className="space-y-3 border-b-2 border-black bg-white p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>}><TaskModalHead task={hostTask} /></Suspense> : undefined} />
        </div>
      </div>
    );
  }
  return <SideThreadColumn key={parentMessageId} />;
}

/** Chat-side col-4 thread column container. Owns persisted width + resize +
 *  desktop/mobile chrome. Renders ThreadPanel for the surface content. */
function getThreadPanelDynamicMax() {
  return typeof window !== "undefined" ? Math.max(400, Math.floor(window.innerWidth * 0.6)) : 400;
}

function SideThreadColumn() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [dynamicMax, setDynamicMax] = useState(() =>
    getThreadPanelDynamicMax(),
  );
  const getThreadDragStartWidth = useCallback(() => {
    const measuredWidth = panelRef.current?.getBoundingClientRect().width;
    return measuredWidth && measuredWidth > 0 ? measuredWidth : undefined;
  }, []);
  const { width, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizablePanel({
    storageKey: "slock:threadPanelWidth",
    min: 360,
    max: dynamicMax,
    defaultWidth: 400,
    direction: "left",
    getDragStartWidth: getThreadDragStartWidth,
  });
  const handleThreadResizeStart = useCallback((e: React.PointerEvent) => {
    // Browser window resize already forces layout and Timeline anchor repair.
    // Keep that path CSS-only; refresh the drag bounds only when the user
    // intentionally resizes this panel.
    setDynamicMax(getThreadPanelDynamicMax());
    handleResizeStart(e);
  }, [handleResizeStart]);
  return (
    <div
      ref={panelRef}
      className="thread-side-column flex flex-col bg-white"
      data-testid="thread-side-column"
      style={{ "--thread-panel-width": `${width}px` } as React.CSSProperties}
    >
      <div
        className="thread-side-column-resizer absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
        onPointerDown={handleThreadResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      <ThreadPanel presentation="side" />
    </div>
  );
}

/** Profile panel wrapper — only renders if a profile is open */
function ProfilePanelWrapper({ collapseChannel = false, collapseThread = false }: { collapseChannel?: boolean; collapseThread?: boolean } = {}) {
  const isOpen = useProfileStore((s) => !!s.profileId);
  if (!isOpen) return null;
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
      <Suspense fallback={<OverlayPanelFallback />}><ProfilePanel /></Suspense>
    </div>
  );
}

/** Legacy task panel wrapper — only renders if a legacy task is open */
function LegacyTaskPanelWrapper({ presentation = "side" }: { presentation?: "side" | "modal" | "mobile-modal" }) {
  const isOpen = useLegacyTaskPanelStore((s) => !!s.task);
  if (!isOpen) return null;
  return <Suspense fallback={<OverlayPanelFallback />}><LegacyTaskPanel presentation={presentation} /></Suspense>;
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
  const workspaceActive = useWorkspaceGridNavigationStore((s) => s.active);
  const threadOpen = useThreadStore((s) => !!s.openParentMessageId);
  const threadOpenedAt = useThreadStore((s) => s.openedAt);
  const profileOpen = useProfileStore((s) => !!s.profileId);
  const profileOpenedAt = useProfileStore((s) => s.openedAt);
  const profileOpenSource = useProfileStore((s) => s.openSource);
  const legacyTaskOpen = useLegacyTaskPanelStore((s) => !!s.task);
  const closeThread = useThreadStore((s) => s.closeThread);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const isTasksRoute = /\/tasks\/?$/.test(location.pathname);
  const isWorkspaceRoute = isWorkspaceGridDemoPath(location.pathname);
  // Tasks-route: rail-visible (md+) wraps the thread / legacy task in <Modal>
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
  // must continue to be owned by their Modal wrapper.
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
  const openedAsTask = useThreadStore((s) => s.openIntent === "task");

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
  const isSearchRoute = /\/search(\/|$)/.test(location.pathname);
  const isActivityRoute = /\/activity(\/|$)/.test(location.pathname);
  const isContentRoute = isSearchRoute || isActivityRoute;
  const searchSlotKind = useSearchContentStore((s) => s.slot?.kind ?? null);
  const renderTaskThreadPanel = () => {
    if (railVisible) {
      // Centered modal with backdrop. Backdrop click + ESC close it; no
      // inline X (back chevron handles close at md-lg, ESC/backdrop at lg+).
      return (
        <Modal onClose={closeThread} closeOnBackdrop>
          <ThreadPanelWrapper presentation="modal" />
        </Modal>
      );
    }
    return <ThreadPanelWrapper presentation="mobile-modal" />;
  };
  if (isContentRoute) {
    if (
      threadOpen
      && !openedAsTask
      && !isTasksRoute
      && searchSlotKind
      && searchSlotKind !== "thread"
      && profileOpen
    ) {
      return renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource);
    }
    if (profileIsTop) return <ProfilePanelWrapper />;
    if (threadIsTop && openedAsTask) {
      return renderTaskThreadPanel();
    }
    if (threadIsTop && searchSlotKind && searchSlotKind !== "thread") {
      return <ThreadPanelWrapper />;
    }
    return null;
  }

  if (workspaceActive || isWorkspaceRoute) return null;
  if (threadOpen && !openedAsTask && !isTasksRoute && profileOpen) {
    return renderStackedSidePanels(<ThreadPanelWrapper />, profileOpenSource);
  }
  if (profileIsTop) return <ProfilePanelWrapper />;
  // Centered because the thread belongs to a TASK, not because of the route.
  // Gating on `isTasksRoute` meant the same task opened as a modal from the
  // Tasks page and as a side panel from its own channel — one object, two
  // containers, decided by where you happened to click. @stdrc.
  if (threadIsTop && (isTasksRoute || openedAsTask)) {
    return renderTaskThreadPanel();
  }
  if (threadIsTop) return <ThreadPanelWrapper />;
  if (isTasksRoute && legacyTaskOpen) {
    if (railVisible) {
      return (
        <Modal onClose={closeLegacyTask} closeOnBackdrop>
          <LegacyTaskPanelWrapper presentation="modal" />
        </Modal>
      );
    }
    return <LegacyTaskPanelWrapper presentation="mobile-modal" />;
  }
  if (legacyTaskOpen) return <LegacyTaskPanelWrapper />;
  return null;
}

/** Sync right panel state ↔ URL query params */
function useRightPanelUrlSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceActive = useWorkspaceGridNavigationStore((s) => s.active);
  const locationRef = useRef({ pathname: location.pathname, search: location.search });

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
  useEffect(() => {
    if (workspaceActive || isWorkspaceGridDemoPath(location.pathname)) return;
    // React can still flush an older URL→store effect after a fast close has
    // already replaced the live URL. Ignore those stale snapshots so a removed
    // ?thread= param cannot reopen the just-closed panel.
    if (!isCurrentRightPanelSearchSnapshot(location.search)) return;
    syncRightPanelStoresFromSearch(location.search);
  }, [location.pathname, location.search, workspaceActive]);

  // Store → URL: update query params when panel state changes.
  // Panels stack: both ?thread= and ?profile= can coexist. Adding a panel
  // pushes a new history entry; close / swap / in-place updates replace.
  const syncUrl = useCallback((
    mode: "auto" | "replace" = "auto",
    options: { resetAgentTabForProfileReopen?: boolean } = {},
  ) => {
      if (workspaceActive || isWorkspaceGridDemoPath(locationRef.current.pathname)) return;
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
  }, [navigate, workspaceActive]);

  useEffect(() => {
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
  }, [syncUrl]);

  // Re-add panel params after react-router navigation changes the pathname
  useEffect(() => {
    if (workspaceActive || isWorkspaceGridDemoPath(location.pathname)) return;
    syncUrl("replace");
  }, [location.pathname, syncUrl, workspaceActive]);
}

// Two-way URL sync for the content master/detail (task #311 stdrc msg=b61ab472).
// `?open=<kind>:<id>` <-> searchContentStore.slot. The same slot store + URL
// param back BOTH the /search master/detail AND the /inbox (Activity) one
// (stdrc #proj-activity:171042a3 2026-06-23: "Activity 的展示方式应该跟搜索
// 结果页面一致 … 点进去后的交互行为也和搜索结果点进去的行为类似"). Scoped to
// those two routes: outside them we ignore inbound URLs AND auto-clear any open
// slot, so navigating away closes the slot without leaving residue. Because the
// slot is shared, switching between /search and /inbox is also a route change —
// the new route's URL carries no `?open=` on a fresh entry, so the URL→Store
// branch clears the prior route's slot rather than letting it bleed across.
function useSearchContentUrlSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const onContentRoute =
    !!serverSlug
    && (location.pathname === `/s/${serverSlug}/search`
        || location.pathname.startsWith(`/s/${serverSlug}/search/`)
        || location.pathname === `/s/${serverSlug}/activity`
        || location.pathname.startsWith(`/s/${serverSlug}/activity/`));

  // URL → Store. Clears the slot when leaving the content routes or when ?open
  // is removed.
  useEffect(() => {
    if (!onContentRoute) {
      if (useSearchContentStore.getState().slot) {
        useSearchContentStore.getState().close();
      }
      return;
    }
    const params = new URLSearchParams(location.search);
    const openParam = params.get("open");
    const msgParam = params.get("msg");
    const parsed = parseSearchOpenParam(openParam);
    const current = useSearchContentStore.getState().slot;
    if (!parsed) {
      if (current) useSearchContentStore.getState().close();
      return;
    }
    const nextMessageId = (parsed.kind === "channel" || parsed.kind === "dm" || parsed.kind === "thread")
      ? (msgParam ?? undefined)
      : undefined;
    if (
      !current
      || current.kind !== parsed.kind
      || current.id !== parsed.id
      || current.messageId !== nextMessageId
    ) {
      useSearchContentStore.getState().open({ ...parsed, messageId: nextMessageId });
    }
  }, [location.pathname, location.search, onContentRoute]);

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
  useEffect(() => {
    if (!onContentRoute) return;
    return useSearchContentStore.subscribe((state, prev) => {
      if (state.slot === prev.slot) return;
      const params = new URLSearchParams(window.location.search);
      if (!state.slot) {
        params.delete("open");
        params.delete("msg");
      } else {
        params.set("open", formatSearchOpenParam(state.slot));
        if (
          (state.slot.kind === "channel"
            || state.slot.kind === "dm"
            || state.slot.kind === "thread")
          && state.slot.messageId
        ) {
          params.set("msg", state.slot.messageId);
        } else {
          params.delete("msg");
        }
      }
      const search = params.toString();
      navigate(
        { pathname: window.location.pathname, search: search ? `?${search}` : "" },
        { replace: true },
      );
    });
  }, [onContentRoute, navigate]);
}


export default function MainLayout() {
  const { formatMessage } = useIntl();
  useEmbedParamsKeeper();
  useRightPanelUrlSync();
  useSearchContentUrlSync();
  useRailLegacyRedirect();
  useTabRouteMemory();

  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const workspaceChannels = useChannelStore((s) => s.channels);
  const workspaceDmChannels = useChannelStore((s) => s.dmChannels);
  const channelsLoading = useChannelStore((s) => s.loading);
  const workspaceAgents = useAgentStore((s) => s.agents);
  const workspaceMachines = useMachineStore((s) => s.machines);
  const setMessageStoreCurrentUserId = useMessageStore((s) => s.setCurrentUserId);
  const showAddMachine = useMachineStore((s) => s.showAddMachine);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const showCreateAgent = useAgentStore((s) => s.showCreateAgent);
  const createAgentOnboarding = useAgentStore((s) => s.createAgentOnboarding);
  const setShowCreateAgent = useAgentStore((s) => s.setShowCreateAgent);
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceAvailability = useWorkspaceGridAvailability();
  const workspacePreferenceEnabled = useWorkspaceGridNavigationStore((s) => s.enabled);
  const workspaceHydratedUserId = useWorkspaceGridNavigationStore((s) => s.hydratedUserId);
  const workspaceActiveRailSide = useWorkspaceGridNavigationStore((s) => s.activeRailSide);
  const workspaceSidebars = useWorkspaceGridNavigationStore((s) => s.sidebars);
  const workspaceSidebarWidths = useWorkspaceGridNavigationStore((s) => s.sidebarWidths);
  const workspaceSettingsModalOpen = useWorkspaceGridNavigationStore((s) => s.settingsModalOpen);
  const workspaceSettingsModalSide = useWorkspaceGridNavigationStore((s) => s.settingsModalSide);
  const hydrateWorkspacePreference = useWorkspaceGridNavigationStore((s) => s.hydrate);
  const setWorkspaceActive = useWorkspaceGridNavigationStore((s) => s.setActive);
  const setWorkspaceSidebarCollapsed = useWorkspaceGridNavigationStore((s) => s.setSidebarCollapsed);
  const setWorkspaceRailMode = useWorkspaceGridNavigationStore((s) => s.setRailMode);
  const closeWorkspaceSettingsModal = useWorkspaceGridNavigationStore((s) => s.closeSettingsModal);

  useEffect(() => {
    hydrateWorkspacePreference(currentUserId);
  }, [currentUserId, hydrateWorkspacePreference]);

  // Pushes the current user id into the external messageStore — write-to-
  // external-store sync, not derived local state. FP for no-derived-state-effect.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    setMessageStoreCurrentUserId(currentUserId);
  }, [currentUserId, setMessageStoreCurrentUserId]);

  // Detect mobile vs desktop (matches Tailwind's md: breakpoint at 768px)
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Workspace is an editor-groups surface, not the app's general tablet
  // desktop layout. Keep its hard gate at lg (1024px) so URL state, feature
  // flags, and persisted preference cannot mount FlexLayout below that width.
  const [isLg, setIsLg] = useState(() => window.matchMedia(WORKSPACE_GRID_VIEWPORT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WORKSPACE_GRID_VIEWPORT_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsLg(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const workspacePreferenceReady = currentUserId !== null && workspaceHydratedUserId === currentUserId;
  const workspaceEnabled = isLg
    && workspaceAvailability.enabled
    && workspacePreferenceReady
    && workspacePreferenceEnabled;

  // Synchronize the effective desktop+gate result into the external navigation store consumed by Sidebar/LeftRail.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    setWorkspaceActive(workspaceEnabled);
  }, [setWorkspaceActive, workspaceEnabled]);

  // Search master/detail responsive col-2 width per stdrc #proj-uiux:c2313b1d
  // msg=1351abcf (3c, 2026-05-26): at ≥1024 use the search-specific wider
  // panel (480 default, 360-720 range) for high-info-density result rows; at
  // 768-1023 collapse to chat-sidebar-shape (240 default, 180-320 range) so
  // col 3 picked-entity isn't squeezed to ~232px at 768. Two persisted widths
  // never conflict.
  // Resizable sidebar (desktop only)
  // Chat sidebar is a navigation rail, not a content pane. Keep the
  // resizable max compact so persisted wide values do not create an empty
  // right gutter around short labels and badges.
  const {
    width: sidebarWidth,
    handleResizeStart: handleSidebarResizeStart,
    handleResizeMove: handleSidebarResizeMove,
    handleResizeEnd: handleSidebarResizeEnd,
  } = useResizablePanel({ storageKey: "slock:sidebarWidth", min: 180, max: 320, defaultWidth: 240 });

  const leftWorkspaceSidebarResize = useWorkspaceSidebarResize({
    side: "left",
    direction: "right",
    width: workspaceSidebarWidths.left,
    userId: currentUserId,
  });
  const rightWorkspaceSidebarResize = useWorkspaceSidebarResize({
    side: "right",
    direction: "left",
    width: workspaceSidebarWidths.right,
    userId: currentUserId,
  });

  // Search master/detail col-2 (MessageSearchPage when slot is open) — much
  // wider than the Sidebar rail because it hosts search input + filter row
  // + results, and per stdrc msg=b61ab472 should feel roughly half-width.
  // Persisted separately so resizing in search mode doesn't affect chat.
  const {
    width: searchPanelWidth,
    handleResizeStart: handleSearchPanelResizeStart,
    handleResizeMove: handleSearchPanelResizeMove,
    handleResizeEnd: handleSearchPanelResizeEnd,
  } = useResizablePanel({ storageKey: "slock:searchPanelWidth", min: 400, max: 720, defaultWidth: 560 });

  // Search master/detail col-2 compact width — used when col 4 thread overlay
  // is open so col 2 + col 3 + col 4 all fit at 1280-1366 viewports without
  // squeezing col 3. Persisted independently from searchPanelWidth so user can
  // resize each mode separately (stdrc #proj-uiux:c2313b1d msg=0ed291ab
  // 2026-05-28). 240 felt too narrow (msg=6fa799a7); default 320 keeps
  // search-result rows readable while leaving col 3 ~580px at 1366.
  const {
    width: searchPanelCompactWidth,
    handleResizeStart: handleSearchPanelCompactResizeStart,
    handleResizeMove: handleSearchPanelCompactResizeMove,
    handleResizeEnd: handleSearchPanelCompactResizeEnd,
  } = useResizablePanel({
    storageKey: "slock:searchPanelCompactWidth",
    ...MASTER_DETAIL_COMPACT_PANEL_BOUNDS,
  });

  const serverSlug = useServerStore((s) => s.current?.slug);
  const currentServerId = useServerStore((s) => s.current?.id);
  const announcementGateState = useOnboardingAnnouncementGateStore((state) => (
    currentServerId ? state.byServerId[currentServerId] ?? "pending" : "pending"
  ));
  const sawOnboardingThisSession = useOnboardingAnnouncementGateStore((state) => (
    currentServerId ? state.sawOnboardingServerIds.includes(currentServerId) : false
  ));
  const threadRefHandoff = useMemo(
    () => serverSlug ? parseThreadRefHandoff(serverSlug, location.search) : null,
    [location.search, serverSlug],
  );
  const consumedThreadRefHandoffsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!threadRefHandoff || !serverSlug || channelsLoading) return;
    const serverEpoch = useServerStore.getState().serverEpoch;
    const channels = [...workspaceChannels, ...workspaceDmChannels];
    void executeThreadRefHandoffOnce({
      consumedHandoffs: consumedThreadRefHandoffsRef.current,
      intent: threadRefHandoff,
      serverSlug,
      serverEpoch,
      channels,
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
        loadContext: async (channelId, targetShortId) => {
          const { data } = await api.get(`/messages/context/${targetShortId}`, {
            params: { channelId },
          });
          return data;
        },
      }),
      getAuthority: () => {
        const activeServer = useServerStore.getState();
        return { serverSlug: activeServer.current?.slug, serverEpoch: activeServer.serverEpoch };
      },
      onFailure: () => {
        toast.error(formatMessage({ id: "message.messageItem.threadUnavailable" }));
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
  }, [channelsLoading, formatMessage, location.pathname, location.search, navigate, serverSlug, threadRefHandoff, workspaceChannels, workspaceDmChannels]);

  useClearLiveAgentActivityOnServerChange(currentServerId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isGlobalSearchShortcut(event)) {
        event.preventDefault();
        if (!serverSlug) return;
        if (workspaceEnabled) {
          setWorkspaceRailMode("search", "left", currentUserId);
          setWorkspaceSidebarCollapsed(false, currentUserId, "left");
          requestAnimationFrame(() => document.dispatchEvent(new Event(SEARCH_FOCUS_REQUEST_EVENT)));
          return;
        }
        const searchPath = `/s/${serverSlug}/search`;
        routeGlobalSearchShortcut({
          pathname: location.pathname,
          searchPath,
          focusMountedSearch: () => document.dispatchEvent(new Event(SEARCH_FOCUS_REQUEST_EVENT)),
          navigateToSearch: () => navigate(`/s/${serverSlug}/search`, {
            state: { searchFrom: `${location.pathname}${location.search}` },
          }),
        });
        return;
      }
    };
    // keydown-global-exempt: cmdk command palette / search global shortcut
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [currentUserId, location.pathname, location.search, navigate, serverSlug, setWorkspaceRailMode, setWorkspaceSidebarCollapsed, workspaceEnabled]);

  useEffect(() => {
    if (!workspaceEnabled) return;
    const onWorkspaceKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      event.preventDefault();
      setWorkspaceSidebarCollapsed(
        !workspaceSidebars[workspaceActiveRailSide].collapsed,
        currentUserId,
        workspaceActiveRailSide,
      );
    };
    // keydown-global-exempt: workspace sidebar visibility shortcut preserves the current focus target
    document.addEventListener("keydown", onWorkspaceKeyDown);
    return () => document.removeEventListener("keydown", onWorkspaceKeyDown);
  }, [
    currentUserId,
    setWorkspaceSidebarCollapsed,
    workspaceEnabled,
    workspaceActiveRailSide,
    workspaceSidebars,
  ]);

  // One-time hash migration: redirect old hash URLs to new paths
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || !serverSlug) return;
    // Clear the hash
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const base = `/s/${serverSlug}`;
    if (hash === "settings") {
      navigate(`${base}/settings`, { replace: true });
      return;
    }
    const [type, id] = hash.split("/");
    if (id && ["channel", "dm", "agent", "machine", "human", "member"].includes(type)) {
      navigate(`${base}/${type}/${id}`, { replace: true });
    }
  }, [serverSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  useMainLayoutRealtimeBridge(mainLayoutRealtimeBridgeDriver);

  const path = location.pathname;
  const pathBase = serverSlug ? `/s/${serverSlug}` : "";

  // Show sidebar inline as main content on mobile when the URL is one of
  // the per-rail-mode master pages — chat root, members root, or settings
  // root. Detail URLs (/channel/<id>, /agent/<id>, /settings/account, etc.)
  // instead show the main panel and hide the sidebar. /computers renders a
  // dedicated MobileComputersPanel on mobile (stdrc msg 2a500cb7 2026-05-01)
  // and /tasks has no sidebar at all (handled separately below).
  const isDefaultRoute = path === pathBase || path === `${pathBase}/`;
  const isMembersRoot = path === `${pathBase}/members` || path === `${pathBase}/members/`;
  const isSettingsRoot = path === `${pathBase}/settings` || path === `${pathBase}/settings/`;
  const isMobileMasterRoute = isDefaultRoute || isMembersRoot || isSettingsRoot;
  const mobileShowSidebarInline = !isDesktop && isMobileMasterRoute;

  // Tasks rail mode is single-page: TasksPanel owns its own filtering UI
  // and there is no master/detail navigation inside Tasks, so we skip the
  // Sidebar entirely and let the panel take the full width next to LeftRail.
  // Search rail mode (task #311 stdrc #proj-uiux:c2313b1d 2026-05-25) starts
  // single-page (full-width MessageSearchPage next to LeftRail). Once the
  // user picks a result and `searchContentStore.slot` opens, we flip into a
  // 3-column master/detail (LeftRail | MessageSearchPage | picked-entity)
  // by reusing the Sidebar slot to host MessageSearchPage and rendering the
  // picked entity in the routes container via SearchContentRoute.
  const isTasksRoute = path === `${pathBase}/tasks` || path.startsWith(`${pathBase}/tasks/`);
  const isSearchRoute = path === `${pathBase}/search` || path.startsWith(`${pathBase}/search/`);
  // Inbox (Activity) is the second content master/detail route. It reuses the
  // exact same slot store, URL sync, column assembly, widths, and resize
  // handlers as /search — only col-2's content differs (ThreadsInbox vs
  // MessageSearchPage). stdrc #proj-activity:171042a3 2026-06-23.
  // /activity always gets the search-style master/detail (the rail-vs-sidebar
  // placement A/B was dropped 2026-06-30 — rail is the default).
  const isActivityRoute = path === `${pathBase}/activity` || path.startsWith(`${pathBase}/activity/`);
  const isInboxRoute = isActivityRoute;
  const isContentRoute = isSearchRoute || isInboxRoute;
  const isWikiRoute = path === `${pathBase}/wiki` || path.startsWith(`${pathBase}/wiki/`);
  const searchSlotOpen = useSearchContentStore((s) => !!s.slot);
  const searchSlotKind = useSearchContentStore((s) => s.slot?.kind ?? null);
  const threadOpenForLayout = useThreadStore((s) => !!s.openParentMessageId);
  const profileOpenForLayout = useProfileStore((s) => !!s.profileId);
  // Desktop only: when the slot is open we want a real 3-col layout. Mobile
  // keeps the single-page surface — the picked entity uses the same
  // mobile-detail-route mechanism as a normal channel push (the slot's
  // kind→route fallback is reserved for desktop in this iteration; mobile path
  // is tracked as 311c follow-up).
  const searchMasterDetail = isContentRoute && searchSlotOpen && isDesktop;
  // When a content route has three visible work panes, col 2 swaps from
  // searchPanelWidth (wide master) to searchPanelCompactWidth (independent
  // persisted compact width) so col 3 is not squeezed by col-2 + right-panel
  // stacking (stdrc msg=ea3dd8b3 + msg=6fa799a7 + msg=0ed291ab 2026-05-28).
  // Thread overlay compacting only applies when col 3 is not already a thread;
  // profile overlay compacting applies even when col 3 is a thread, because
  // Activity/Search can show List | Thread | Profile.
  const contentRouteThreadOverlayOpen =
    searchMasterDetail && threadOpenForLayout && !!searchSlotKind && searchSlotKind !== "thread";
  const contentRouteProfileOverlayOpen = searchMasterDetail && profileOpenForLayout;
  const searchColTwoCompact = contentRouteThreadOverlayOpen || contentRouteProfileOverlayOpen;
  const workspaceInitialPanel = useMemo(() => {
    const relativePath = pathBase && path.startsWith(`${pathBase}/`)
      ? path.slice(pathBase.length + 1)
      : "";
    const [kind, encodedId] = relativePath.split("/");
    const id = encodedId ? decodeURIComponent(encodedId) : null;

    if (kind === "channel" && id) {
      const channel = workspaceChannels.find((candidate) => candidate.id === id);
      return {
        ref: { kind: "channel", id } satisfies WorkspacePanelRef,
        title: channel ? `#${channel.name}` : `#${id}`,
        subtitle: formatMessage({ id: "workspace.panel.channel" }),
      };
    }
    if (kind === "dm" && id) {
      const dm = workspaceDmChannels.find((candidate) => candidate.id === id);
      return {
        ref: { kind: "dm", id } satisfies WorkspacePanelRef,
        title: `@${dm?.peerDisplayName || dm?.peerName || dm?.name || id}`,
        subtitle: formatMessage({ id: "workspace.panel.directMessage" }),
      };
    }
    if (kind === "agent" && id) {
      const agent = workspaceAgents.find((candidate) => candidate.id === id);
      return {
        ref: { kind: "agent", id } satisfies WorkspacePanelRef,
        title: `@${agent?.displayName || agent?.name || id}`,
        subtitle: formatMessage({ id: "workspace.panel.agent" }),
      };
    }
    if (kind === "human" && id) {
      return {
        ref: { kind: "human", id } satisfies WorkspacePanelRef,
        title: `@${id}`,
        subtitle: formatMessage({ id: "workspace.panel.human" }),
      };
    }
    if ((kind === "computer" || kind === "machine") && id) {
      const machine = workspaceMachines.find((candidate) => candidate.id === id);
      return {
        ref: { kind: "machine", id } satisfies WorkspacePanelRef,
        title: machine?.name ?? id,
        subtitle: formatMessage({ id: "workspace.panel.computer" }),
      };
    }
    if (kind === "tasks") {
      return {
        ref: { kind: "tasks", scope: "server" } satisfies WorkspacePanelRef,
        title: formatMessage({ id: "workspace.panel.tasks" }),
        subtitle: formatMessage({ id: "workspace.panel.taskQueue" }),
      };
    }

    const fallbackChannel = workspaceChannels.find((channel) => channel.joined && channel.archivedAt == null)
      ?? workspaceChannels.find((channel) => channel.archivedAt == null);
    return fallbackChannel
      ? {
          ref: { kind: "channel", id: fallbackChannel.id } satisfies WorkspacePanelRef,
          title: `#${fallbackChannel.name}`,
          subtitle: formatMessage({ id: "workspace.panel.channel" }),
        }
      : undefined;
  }, [formatMessage, path, pathBase, workspaceAgents, workspaceChannels, workspaceDmChannels, workspaceMachines]);
  const openWorkspaceInboxItem = useCallback((item: InboxItem) => {
    if (item.kind === "thread") {
      emitWorkspaceGridOpenPanel(
        {
          kind: "thread",
          channelId: item.parentChannelId,
          threadRootId: item.parentMessageId,
          threadChannelId: item.threadChannelId,
        },
        { title: formatMessage({ id: "search.panelThreadTitle" }, { id: item.parentMessageId.slice(0, 8) }), subtitle: `#${item.parentChannelName}` },
      );
      return;
    }
    emitWorkspaceGridOpenPanel(
      { kind: item.channelType === "dm" ? "dm" : "channel", id: item.channelId },
      { title: `${item.channelType === "dm" ? "@" : "#"}${item.channelName}`, subtitle: formatMessage({ id: "workspace.panel.activityItem" }) },
    );
  }, [formatMessage]);
  const openWorkspaceTask = useCallback((task: Task) => {
    emitWorkspaceGridOpenPanel(
      { kind: "thread", channelId: task.channelId, threadRootId: task.messageId },
      { title: `task #${task.taskNumber}`, subtitle: task.title },
    );
  }, []);
  const openWorkspaceSavedEntry = useCallback((entry: SavedEntry) => {
    if (entry.channelType === "thread" && entry.parentChannelId && entry.parentMessageId) {
      emitWorkspaceGridOpenPanel(
        {
          kind: "thread",
          channelId: entry.parentChannelId,
          threadRootId: entry.parentMessageId,
          threadChannelId: entry.channelId,
        },
        { title: formatMessage({ id: "search.panelThreadTitle" }, { id: entry.parentMessageId.slice(0, 8) }), subtitle: entry.parentChannelName ?? formatMessage({ id: "workspace.panel.savedMessage" }) },
      );
      return;
    }
    emitWorkspaceGridOpenPanel(
      { kind: entry.channelType === "dm" ? "dm" : "channel", id: entry.channelId },
      { title: `${entry.channelType === "dm" ? "@" : "#"}${entry.channelName}`, subtitle: formatMessage({ id: "workspace.panel.savedMessage" }) },
    );
  }, [formatMessage]);
  const dragWorkspaceInboxItem = useCallback((event: React.DragEvent<HTMLDivElement>, item: InboxItem) => {
    if (item.kind === "thread") {
      emitWorkspaceGridDragPanel(
        event.nativeEvent,
        {
          kind: "thread",
          channelId: item.parentChannelId,
          threadRootId: item.parentMessageId,
          threadChannelId: item.threadChannelId,
        },
        { title: formatMessage({ id: "search.panelThreadTitle" }, { id: item.parentMessageId.slice(0, 8) }), subtitle: `#${item.parentChannelName}` },
      );
      return;
    }
    emitWorkspaceGridDragPanel(
      event.nativeEvent,
      { kind: item.channelType === "dm" ? "dm" : "channel", id: item.channelId },
      { title: `${item.channelType === "dm" ? "@" : "#"}${item.channelName}`, subtitle: formatMessage({ id: "workspace.panel.activityItem" }) },
    );
  }, [formatMessage]);
  const dragWorkspaceTask = useCallback((event: React.DragEvent<HTMLDivElement>, task: Task) => {
    emitWorkspaceGridDragPanel(
      event.nativeEvent,
      { kind: "thread", channelId: task.channelId, threadRootId: task.messageId },
      { title: `task #${task.taskNumber}`, subtitle: task.title },
    );
  }, []);
  const dragWorkspaceSavedEntry = useCallback((event: React.DragEvent<HTMLButtonElement>, entry: SavedEntry) => {
    if (entry.channelType === "thread" && entry.parentChannelId && entry.parentMessageId) {
      emitWorkspaceGridDragPanel(
        event.nativeEvent,
        {
          kind: "thread",
          channelId: entry.parentChannelId,
          threadRootId: entry.parentMessageId,
          threadChannelId: entry.channelId,
        },
        { title: formatMessage({ id: "search.panelThreadTitle" }, { id: entry.parentMessageId.slice(0, 8) }), subtitle: entry.parentChannelName ?? formatMessage({ id: "workspace.panel.savedMessage" }) },
      );
      return;
    }
    emitWorkspaceGridDragPanel(
      event.nativeEvent,
      { kind: entry.channelType === "dm" ? "dm" : "channel", id: entry.channelId },
      { title: `${entry.channelType === "dm" ? "@" : "#"}${entry.channelName}`, subtitle: formatMessage({ id: "workspace.panel.savedMessage" }) },
    );
  }, [formatMessage]);
  const dragWorkspaceSearchResult = useCallback((
    event: React.DragEvent<HTMLButtonElement>,
    ref: WorkspacePanelRef,
    source?: { title?: string; subtitle?: string },
  ) => {
    emitWorkspaceGridDragPanel(event.nativeEvent, ref, source);
  }, []);
  const hideSidebar = isWikiRoute || (workspaceEnabled
    ? workspaceSidebars.left.collapsed || workspaceSidebars.left.activeItem === null
    : isTasksRoute || (isContentRoute && !searchMasterDetail));
  const isMobileTabRoot = mobileShowSidebarInline || (!isDesktop && isTasksRoute);
  const browserChromeColor = !isDesktop && !isMobileTabRoot ? THEME_CHROME_WHITE : THEME_CHROME_YELLOW;
  const mobileTabBarVisible = useMobileTabBarVisible();

  const renderWorkspaceSidebarContent = (side: "left" | "right") => {
    const workspaceRailMode = workspaceSidebars[side].activeItem;
    const borderClass = side === "left" ? "border-r border-black/25" : "border-l border-black/25";
    if (workspaceRailMode === "activity") {
      return (
        <WorkspaceRailPanelFrame mode="activity" borderClass={borderClass}>
          <Suspense fallback={<PanelFallback />}>
            <ThreadsInbox onOpenItem={openWorkspaceInboxItem} onDragItem={dragWorkspaceInboxItem} />
          </Suspense>
        </WorkspaceRailPanelFrame>
      );
    }
    if (workspaceRailMode === "tasks") {
      return (
        <WorkspaceRailPanelFrame mode="tasks" borderClass={borderClass}>
          <Suspense fallback={<PanelFallback />}>
            <TasksPanel onOpenTask={openWorkspaceTask} onDragTask={dragWorkspaceTask} />
          </Suspense>
        </WorkspaceRailPanelFrame>
      );
    }
    if (workspaceRailMode === "search") {
      return (
        <WorkspaceRailPanelFrame mode="search" borderClass={borderClass}>
          <MessageSearchPage
            onOpenPanelRef={emitWorkspaceGridOpenPanel}
            onDragPanelRef={dragWorkspaceSearchResult}
          />
        </WorkspaceRailPanelFrame>
      );
    }
    if (workspaceRailMode === "saved") {
      return (
        <WorkspaceRailPanelFrame mode="saved" borderClass={borderClass}>
          <Suspense fallback={<PanelFallback />}>
            <SavedPanel onOpenEntry={openWorkspaceSavedEntry} onDragEntry={dragWorkspaceSavedEntry} />
          </Suspense>
        </WorkspaceRailPanelFrame>
      );
    }
    return (
      <div className={`h-full ${side === "left" ? "" : borderClass}`}>
        <Sidebar
          workspaceRailMode={workspaceRailMode}
          bottomSlot={side === "left" ? <LiveAgentActivityBar variant="sidebar" /> : undefined}
        />
      </div>
    );
  };

  useEffect(() => {
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!themeColor) return;
    themeColor.content = browserChromeColor;
  }, [browserChromeColor]);

  const handleCloseWorkspaceSettings = useCallback(() => {
    closeWorkspaceSettingsModal();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="workspace-settings-trigger"]')?.focus();
      });
    });
  }, [closeWorkspaceSettingsModal]);

  return (
    <div
      // iOS standalone first-principles contract:
      // - browsers/PWA manifests default to theme yellow when route-level chrome
      //   cannot be applied reliably
      // - mobile detail routes still update theme-color and this wrapper to match
      //   their white top surface
      className={`flex min-h-0 flex-1 flex-col font-display ${isMobileTabRoot ? "bg-soft-signal" : "bg-white md:bg-brutal-cream"}`}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* System notifications live in the Notification Center popup, hung off the LeftRail
          (desktop) and the Chat-tab navbar (mobile). The previous global
          top banner stack covered itself when multiple conditions fired at
          once; collecting them into a notification-center popover (per
          stdrc 2026-05-02 #proj-uiux:f87f6eb9 task #94) makes the full
          list visible without stealing layout height. */}
      <PwaInstallPrompt />

      <div className="flex min-h-0 flex-1">
        {/* Left rail — desktop only. Hosts server switcher (top), sidebar tab
            icons (Chat/Members), and Settings (bottom). On mobile the
            equivalent surfaces live in the in-Sidebar server header and the
            bottom MobileTabBar. */}
        <LeftRail
          hidden={mobileShowSidebarInline}
          workspaceModeAvailable={isLg && workspaceAvailability.resolved && workspaceAvailability.enabled}
        />

        {/* Sidebar container:
            - Mobile root: relative, full width, inline as main content (the "Chat tab")
            - Mobile detail: hidden (no drawer on mobile — detail views cover everything)
            - Desktop: always relative inline at resizable width
            - Tasks rail mode: hidden (TasksPanel takes the full main area). */}
        <div
          className={
            hideSidebar
              ? "hidden"
              : mobileShowSidebarInline
                ? "relative z-auto flex min-w-0 flex-1"
                : `hidden md:relative md:flex md:z-auto`
          }
        >
          <div
            ref={workspaceEnabled ? leftWorkspaceSidebarResize.panelRef : undefined}
            data-testid={workspaceEnabled ? "workspace-primary-sidebar" : undefined}
            // stdrc 2026-05-02 #proj-uiux:95e25b5b ec1523d9: invert
            // sidebar/main relationship — sidebar uses warm cream
            // (`bg-brutal-cream`), main panel uses bright white. After
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
            className={`bg-brutal-cream relative min-w-0 ${mobileShowSidebarInline ? "flex-1" : "shrink-0"} ${searchMasterDetail ? "flex flex-col border-r-2 border-black" : ""}`}
            style={
              mobileShowSidebarInline
                ? undefined
                : {
                    width: searchMasterDetail
                      ? resolveMasterDetailPanelWidth({
                          isLargeViewport: isLg,
                          isCompactLayout: searchColTwoCompact,
                          wideWidth: searchPanelWidth,
                          compactWidth: searchPanelCompactWidth,
                        })
                      : workspaceEnabled ? workspaceSidebarWidths.left : sidebarWidth,
                    ...(workspaceEnabled ? {
                      minWidth: MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,
                      maxWidth: `min(${MAX_WORKSPACE_GRID_SIDEBAR_WIDTH}px, 40vw)`,
                    } : {}),
                  }
            }
          >
            {workspaceEnabled ? renderWorkspaceSidebarContent("left") : searchMasterDetail ? (
              // Col 2 master list: the Activity list on /inbox, the search
              // results on /search — same master/detail slot drives col 3.
              isInboxRoute ? (
                <Suspense fallback={<PanelFallback />}><ThreadsInbox compactActivitySidebar /></Suspense>
              ) : (
                <MessageSearchPage />
              )
            ) : (
              <Sidebar
                mobileInline={mobileShowSidebarInline}
                workspaceRailMode={null}
                bottomSlot={isDesktop && !hideSidebar ? (
                  <LiveAgentActivityBar variant="sidebar" />
                ) : undefined}
              />
            )}
            {/* Resize handle (desktop only). Search master/detail at lg+
                resizes the search-specific width; at md (768-1023) it
                resizes the chat-sidebar-shape width that's currently shown
                (per (3c) responsive policy above). Non-search uses
                sidebarWidth as before. Two persisted widths never bleed
                across (slock:searchPanelWidth vs slock:sidebarWidth). */}
            {workspaceEnabled ? (
              <div
                className="group absolute -right-1 top-0 bottom-0 z-20 hidden w-2 cursor-col-resize touch-none select-none md:block"
                onPointerDown={leftWorkspaceSidebarResize.handlePointerDown}
                onPointerMove={leftWorkspaceSidebarResize.handlePointerMove}
                onPointerUp={leftWorkspaceSidebarResize.handlePointerUp}
                onPointerCancel={leftWorkspaceSidebarResize.handlePointerCancel}
                onDoubleClick={leftWorkspaceSidebarResize.resetWidth}
                data-testid="workspace-left-sidebar-resize-handle"
              >
                <span className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-black/25 group-hover:bg-black" />
              </div>
            ) : (
              <div
                className="hidden md:block absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize touch-none select-none"
                onPointerDown={
                  searchMasterDetail
                    ? (isLg
                        ? (searchColTwoCompact ? handleSearchPanelCompactResizeStart : handleSearchPanelResizeStart)
                        : handleSearchPanelCompactResizeStart)
                    : handleSidebarResizeStart
                }
                onPointerMove={
                  searchMasterDetail
                    ? (isLg
                        ? (searchColTwoCompact ? handleSearchPanelCompactResizeMove : handleSearchPanelResizeMove)
                        : handleSearchPanelCompactResizeMove)
                    : handleSidebarResizeMove
                }
                onPointerUp={
                  searchMasterDetail
                    ? (isLg
                        ? (searchColTwoCompact ? handleSearchPanelCompactResizeEnd : handleSearchPanelResizeEnd)
                        : handleSearchPanelCompactResizeEnd)
                    : handleSidebarResizeEnd
                }
                onPointerCancel={
                  searchMasterDetail
                    ? (isLg
                        ? (searchColTwoCompact ? handleSearchPanelCompactResizeEnd : handleSearchPanelResizeEnd)
                        : handleSearchPanelCompactResizeEnd)
                    : handleSidebarResizeEnd
                }
              />
            )}
          </div>
        </div>

        {/* Main content — hidden on mobile root views (sidebar is the content),
            visible on mobile detail views and always on desktop.
            stdrc 2026-05-02 #proj-uiux:95e25b5b ec1523d9: bg-white on
            desktop so the whole main column reads as bright white,
            inverted with sidebar's warm cream. Mobile keeps the
            inherited cream so sidebar↔main aren't visually separated
            on small screens where they aren't side-by-side. */}
        <div className={`relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${mobileShowSidebarInline ? "hidden" : "flex"} md:bg-white`}>
          <div
            className="thread-layout-container flex min-h-0 min-w-0 flex-1"
            data-testid="thread-layout-container"
          >
            <div
              className="thread-main-column flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              data-testid="thread-main-column"
            >
              {workspaceEnabled && !isWikiRoute ? (
                <Suspense fallback={<PanelFallback />}>
                  <WorkspaceGridDemo initialPanel={workspaceInitialPanel} />
                </Suspense>
              ) : (
                <Routes>
                  <Route path="channel/:channelId" element={<ChannelRoute />} />
                  <Route path="dm/:dmId" element={<DmRoute />} />
                  <Route path="agent/:agentId" element={<AgentRoute />} />
                  <Route path="computer/:machineId" element={<MachineRoute />} />
                  {/* Legacy /machine/:id — kept so external links and bookmarks
                      still work; redirected to /computer/:id by RailNavCompat. */}
                  <Route path="machine/:machineId" element={<MachineRoute />} />
                  <Route path="human/:userId" element={<HumanRoute />} />
                  <Route path="members/graph" element={<MemberGraphRoute />} />
                  <Route path="members" element={<EmptyRoute />} />
                  <Route path="computers" element={<ComputersRoute />} />
                  <Route path="search" element={<SearchContentRoute />} />
                  <Route path="wiki" element={<WikiRoute />} />
                  <Route path="settings/:tab?/*" element={<SettingsRoute />} />
                  <Route path="activity" element={<InboxContentRoute />} />
                  {/* Legacy /inbox + /threads → /activity (stdrc renamed the route
                      #proj-activity:171042a3 2026-06-23). Keep redirects so old
                      links/bookmarks resolve. */}
                  <Route path="inbox" element={<LegacyThreadsRedirect />} />
                  <Route path="threads" element={<LegacyThreadsRedirect />} />
                  <Route path="tasks" element={<TasksRoute />} />
                  <Route path="saved" element={<SavedRoute />} />
                  <Route path="release-notes" element={<ReleaseNotesRoute />} />
                  <Route path={WORKSPACE_GRID_DEMO_ROUTE} element={<LegacyWorkspaceGridRedirect />} />
                  <Route path="*" element={<DefaultRoute />} />
                </Routes>
              )}
            </div>
            {!workspaceEnabled ? <RightPanel /> : null}
          </div>

        </div>

        {workspaceEnabled && !isWikiRoute && !workspaceSidebars.right.collapsed && workspaceSidebars.right.activeItem !== null ? (
          <div
            ref={rightWorkspaceSidebarResize.panelRef}
            className="relative hidden min-w-0 shrink-0 bg-brutal-cream md:block"
            style={{
              width: workspaceSidebarWidths.right,
              minWidth: MIN_WORKSPACE_GRID_SIDEBAR_WIDTH,
              maxWidth: `min(${MAX_WORKSPACE_GRID_SIDEBAR_WIDTH}px, 40vw)`,
            }}
            data-testid="workspace-secondary-sidebar"
          >
            {renderWorkspaceSidebarContent("right")}
            <div
              className="group absolute -left-1 top-0 bottom-0 z-20 hidden w-2 cursor-col-resize touch-none select-none md:block"
              onPointerDown={rightWorkspaceSidebarResize.handlePointerDown}
              onPointerMove={rightWorkspaceSidebarResize.handlePointerMove}
              onPointerUp={rightWorkspaceSidebarResize.handlePointerUp}
              onPointerCancel={rightWorkspaceSidebarResize.handlePointerCancel}
              onDoubleClick={rightWorkspaceSidebarResize.resetWidth}
              data-testid="workspace-right-sidebar-resize-handle"
            >
              <span className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-black/25 group-hover:bg-black" />
            </div>
          </div>
        ) : null}
        {workspaceEnabled && !isWikiRoute ? <LeftRail side="right" hidden={mobileShowSidebarInline} /> : null}
      </div>

      {/* Mobile bottom bars stay in normal flow at the bottom of the root flex
          column so the activity strip cannot overlap or leave a gap above the
          tab bar. */}
      <MobileBottomBarStack
        showLiveActivity={!isDesktop && mobileTabBarVisible}
        liveActivity={<LiveAgentActivityBar variant="mobile" />}
        tabBar={<MobileTabBar />}
      />
      {workspaceEnabled && workspaceSettingsModalOpen ? (
        <Modal onClose={handleCloseWorkspaceSettings} closeOnBackdrop>
          <div
            className="relative flex h-[min(86vh,880px)] w-[min(1040px,calc(100vw-2rem))] min-h-0 flex-col overflow-hidden border-2 border-black bg-white shadow-brutal"
            role="dialog"
            aria-modal="true"
            aria-label={formatMessage({ id: "layout.main.settingsAria" })}
            data-testid="workspace-settings-modal"
            data-settings-trigger-side={workspaceSettingsModalSide}
          >
            <Suspense fallback={<PanelFallback />}>
              <WorkspaceSettingsModal />
            </Suspense>
            <button
              type="button"
              className="absolute right-3 top-3 z-20 inline-flex size-8 items-center justify-center text-black/55 outline-none hover:bg-black/[0.08] hover:text-black focus-visible:outline focus-visible:outline-1 focus-visible:outline-black"
              onClick={handleCloseWorkspaceSettings}
              aria-label={formatMessage({ id: "layout.main.closeSettingsAria" })}
              title={formatMessage({ id: "common.close" })}
            >
              <X size={18} />
            </button>
          </div>
        </Modal>
      ) : null}
      {currentServerId && serverSlug ? (
        <ServerSetupProjectionGate
          serverId={currentServerId}
          serverSlug={serverSlug}
        />
      ) : null}
      {showAddMachine && (
        <AddMachineDialog onClose={() => setShowAddMachine(false)} />
      )}
      {showCreateAgent && (
        <CreateAgentDialog
          onboarding={createAgentOnboarding}
          onClose={() => setShowCreateAgent(false)}
        />
      )}
      <AnnouncementModal suppressed={shouldSuppressAnnouncements(announcementGateState, sawOnboardingThisSession)} />
    </div>
  );
}

export const __testInternals = {
  ComputersRoute,
  RightPanel,
  AgentById,
  DefaultRoute,
  renderContentSlot,
};
