import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useIntl } from "react-intl";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import { orderSidebarMachineIds } from "../../../components/layout/sidebarMachineOrder";
import { useShallow } from "zustand/react/shallow";
import { useAuthStore } from "../../../store/authStore";
import { useServerStore } from "../../../store/serverStore";
import { useLocalComputerMachineId } from "../../../components/machine/localComputer/localComputerStore";
import { useChannelsShownWhileLoading } from "../../../components/layout/useChannelsShownWhileLoading";
import { useUIStore } from "../../../store/uiStore";
import { useMessageStore } from "../../../store/messageStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useSavedStore } from "../../../store/savedStore";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { placeSidebarContextSubmenu } from "../../../components/layout/sidebarContextMenuPosition";
import type { SidebarCustomSection, SidebarSectionPlacement } from "../../../store/sidebarSections";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, SERVER_LABS_UI_FEATURE_FLAG_KEY, SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { isSlackBridgeSurfaceEnabled } from "../../../components/settings/slackBridgeVisibility";
import { RAFTBENCH_OVERVIEW_FLAG_KEY, useServerFeatureFlag } from "../../../store/serverFeatureFlags";
import { readSidebarComputerRowCount, readSidebarSectionRowCounts, writeSidebarComputerRowCount } from "../../../components/layout/sidebarSectionRowCounts";
import { isSidebarOrderLoaded } from "../../../store/events/serverEvents";
import { accessTokenSubject } from "../../../utils/hostAccessTokenSync";
import type { ExternalInviteEntry } from "../../../analytics/externalInvites";
import type { SidebarDndProjection } from "../../../components/layout/sidebarDnd";
import type { CtxMenu } from "../sidebarContextMenu";
import { createSidebarDndProjectionStore } from "../dnd/sidebarDndProjectionStore";
import { DEFAULT_SECTION_ORDER } from "../sections/sidebarSortSections";
import { useStagedSidebarRows } from "./useStagedSidebarRows";

// Stryker disable all: accessible section labels are asserted by rendered DOM tests; mutating copy inside Sidebar does not exercise a separate domain seam.
const EMPTY_CUSTOM_SECTIONS: SidebarCustomSection[] = [];
const EMPTY_SECTION_PLACEMENTS: SidebarSectionPlacement[] = [];
// Stryker restore all

/**
 * The Sidebar's store reads (channels, DMs, agents, computers, server, sidebar order,
 * unread and saved totals), its feature flags, and the open/closed state of its
 * dialogs, row context menu and drag.
 */
export function useSidebarData() {
  // Display-language (react-intl) — layout namespace. The 8 settings sub-nav
  // destinations below reuse the `settings.tabs.*` ids (identical English
  // source + same destination) rather than forking the copy under `layout.*`;
  // everything else here resolves `layout.sidebar.*`.
  const { formatMessage } = useIntl();
  // `lastMessageAt` lives in the `channelActivity` slice (not the channel
  // objects), so `channels`/`dmChannels` are stable across inbound-message
  // activity bumps — plain subscriptions no longer re-render the whole Sidebar
  // per message (the channel-switch freeze / hover jank root).
  const storeChannels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  // Loading flag so the channels/DMs lists show a skeleton WHILE loading
  // instead of the "No X yet" empty state, which otherwise renders first and
  // then flashes to the real list once data arrives (闪回 fix, task #32).
  const channelsLoading = useChannelStore((s) => s.loading);
  // The DM list answers on its own request (GET /channels/dm).
  const dmsLoading = useChannelStore((s) => s.dmsLoading);
  // Until the list loads, last visit's channels from the device, shown in its
  // place; a section that has rows shows them instead of its skeleton.
  const deviceChannels = useChannelsShownWhileLoading();
  const channels = (deviceChannels ?? storeChannels) as Channel[];
  // Device rows are shown only (Tenny, #triage:458d78f1): no row menu on them
  // and no drag, both of which write to the server, until the list loads.
  const channelRowsDisplayOnlyRef = useRef(false);
  useEffect(() => {
    channelRowsDisplayOnlyRef.current = deviceChannels !== null;
  }, [deviceChannels]);
  // `channelActivity` drives recency sorting. Subscribe it LIVE only when a
  // recency sort is active; otherwise freeze the snapshot so an inbound-message
  // bump doesn't re-render the Sidebar. `recencyActiveRef` is set below once the
  // sort modes are known; the (stable) snapshot reads it at compare time (between
  // renders), so a one-render lag on a sort-mode toggle is harmless.
  const recencyActiveRef = useRef(false);
  const activitySnapRef = useRef<Record<string, string | null>>({});
  const getActivitySnap = useCallback(() => {
    if (recencyActiveRef.current) {
      activitySnapRef.current = useChannelStore.getState().channelActivity;
    }
    return activitySnapRef.current;
  }, []);
  const channelActivity = useSyncExternalStore(useChannelStore.subscribe, getActivitySnap);
  const deleteChannel = useChannelStore((s) => s.deleteChannel);
  const archiveChannel = useChannelStore((s) => s.archiveChannel);
  const leaveChannel = useChannelStore((s) => s.leaveChannel);
  const allAgents = useAgentStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => !a.deletedAt), [allAgents]);
  // Loading flag so the computers list shows a skeleton WHILE loading
  // instead of flashing "No computers yet" then the real rows (闪回 fix).
  const machinesLoading = useMachineStore((s) => s.loading);
  // Parent subscribes ONLY stable machine identity (id → name), never the
  // status-bearing machine objects. `useShallow` short-circuits when the
  // id/name set is unchanged, so the high-frequency `machine:status` event
  // stream (cross-replica mirror / presence flaps) no longer re-renders the
  // whole Sidebar (× its ~140 rows). Per-machine status lives in <ComputerRow>.
  const machineNames = useMachineStore(
    useShallow((s) => Object.fromEntries(s.machines.map((m) => [m.id, m.name] as const))),
  );
  // Display order of the Computers rows: this device → mine (isMyComputer) → rest
  // (sidebarMachineOrder.ts). Same subscription discipline: `useShallow` on the
  // id array, so only an id, its group or this device changing re-renders.
  const localMachineId = useLocalComputerMachineId();
  const userId = useAuthStore((s) => s.user?.id);
  const sidebarMachineIds = useMachineStore(
    useShallow((s) => orderSidebarMachineIds(s.machines, localMachineId, userId)),
  );
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  // Narrow reads (web perf): the user and server records are replaced on every
  // auth refresh / server-list answer; the sidebar uses a few fields of each.
  const serverId = useServerStore((s) => s.current?.id);
  // Rows each section mounts on a server's first render; the rest follow in a transition.
  const sidebarRowLimit = useStagedSidebarRows(serverId);
  const serverName = useServerStore((s) => s.current?.name);
  const serverAvatarUrl = useServerStore((s) => s.current?.avatarUrl);
  const serverPublicPageLive = useServerStore((s) => s.current?.publicPageLive === true);
  // Narrow: the server list is replaced on every /servers response (web perf).
  const serversCount = useServerStore((s) => s.servers.length);
  const sidebarOrder = useServerStore((s) => s.sidebarOrder);
  const sidebarOrderLoaded = isSidebarOrderLoaded(sidebarOrder);
  // Each section holds its skeleton, rather than drawing what it has so far,
  // until everything that places a row in it is read; otherwise rows appear
  // in the wrong section or order and move once the rest lands (layout shift
  // on cold and warm starts). The sidebar order decides every section (pins,
  // custom sections, sort and manual order); the device's channel list counts
  // as the channel list while it loads; the DM list has no device copy.
  // Pinned resolves its refs against both lists, so until all three are read
  // it cannot tell "no pins" from "not read yet" either. Every read, a failed
  // one included, ends its hold (the stores clear `loading`/`dmsLoading` and
  // store a fresh sidebar order on failure).
  const channelListShown = !channelsLoading || deviceChannels !== null;
  const pinnedHeld = !sidebarOrderLoaded || dmsLoading || !channelListShown;
  const channelSectionsHeld = !sidebarOrderLoaded || !channelListShown;
  const dmsHeld = !sidebarOrderLoaded || dmsLoading;
  // Rows each section held when it last loaded on this server
  // (sidebarSectionRowCounts): a loading section's skeleton draws that many,
  // so the real rows land in place. Keyed like the device channel list, by the
  // stored token's person before /auth/me answers.
  const rowCountUserId = useAuthStore((s) => s.user?.id ?? accessTokenSubject(s.accessToken));
  const rememberedRows = useMemo(
    () => readSidebarSectionRowCounts(rowCountUserId, serverId),
    [rowCountUserId, serverId],
  );
  // The Computers rail's rows when its list last loaded here, for its
  // skeleton (null: never loaded here), remembered once each load lands.
  const rememberedComputerRows = useMemo(
    () => readSidebarComputerRowCount(rowCountUserId, serverId),
    [rowCountUserId, serverId],
  );
  // A failed first load says nothing about the count; the server switch's
  // reset puts the list back to "loading" before the next server's rows.
  const machinesLoaded = useMachineStore((s) => s.loadStatus === "loaded");
  const machineRowCount = sidebarMachineIds.length;
  useEffect(() => {
    if (!machinesLoaded) return;
    writeSidebarComputerRowCount(rowCountUserId, serverId, machineRowCount);
  }, [machinesLoaded, rowCountUserId, serverId, machineRowCount]);
  const customSections = sidebarOrder.customSections ?? EMPTY_CUSTOM_SECTIONS;
  const sectionOrder = sidebarOrder.sectionOrder ?? DEFAULT_SECTION_ORDER;
  const sectionPlacements = sidebarOrder.sectionPlacements ?? EMPTY_SECTION_PLACEMENTS;
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  // NOTE: the parent intentionally does NOT subscribe to the whole
  // `unreadCounts` / `drafts` Records — those churn a new reference on every
  // inbound `message:new`, which previously re-rendered this entire (~2300-line,
  // hundreds-of-rows) component on every message and froze channel-switching in
  // large servers. Per-row unread/draft now lives in the <ChannelRow>/<DmRow>/
  // <AgentDmRow> leaves; the parent derives only narrowed aggregates below
  // (`unreadFlags` for collapsed-section dots, `closedDmUnreadIds` for the
  // closed-DM auto-reopen). Non-reactive one-off reads use getState().
  // Narrowed trigger for the eager cross-server unread-summary refetch below.
  // Subscribing the effect to the whole `unreadCounts` Record made it re-run
  // (and fire GET /servers/unread-summary) on EVERY inbound message, because
  // messageStore rebuilds the Record with a new reference per `message:new`.
  // The cross-server badge only cares whether *any* local unread exists, so we
  // collapse to a boolean — it flips on 0↔nonzero transitions, not per message.
  // (Mirrors the LeftRail/ChatPanel narrowing in PR #2590.)
  const hasLocalUnread = useMessageStore((s) =>
    Object.values(s.unreadCounts).some((count) => count > 0),
  );
  // Stryker disable next-line all: pre-existing inbox loading is outside the workspace mutation corpus.
  const loadInbox = useInboxStore((s) => s.loadInbox);
  // Subscribe to the server-provided total (not the loaded `saved` page) so the
  // badge reflects the true count, and so this always-mounted row doesn't
  // re-render on every saved-list page mutation — just on count change.
  const savedTotal = useSavedStore((s) => s.total);
  const navigate = useNavigate();
  const nav = useAppNavigate();
  const location = useLocation();
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const handledSidebarFocusLocationKeyRef = useRef<string | null>(null);
  const raftBenchEnabled = useServerFeatureFlag(RAFTBENCH_OVERVIEW_FLAG_KEY).enabled;
  const labsUiEnabled = useServerFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY).enabled;
  const providerConnectionsEnabled = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY).enabled;
  // External channels (#wg-rbac:#16): the Joint Channels section holds joint
  // channels and channels with a Guest or an open external invite, flag or
  // not (an external channel keeps its group when the flag is off). Its label
  // is "External" while the flag is on, or while it holds a non-joint
  // channel; with the flag off and only joint channels it keeps its old name.
  const externalChannelsEnabled = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const slackBridgeGate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const slackBridgeEnabled = isSlackBridgeSurfaceEnabled(slackBridgeGate);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  // Open when set: which of the sidebar's entries opened it (product events: `external_invite_opened.entry`).
  const [showCreateJointChannel, setShowCreateJointChannel] = useState<ExternalInviteEntry | false>(false);
  // Single source of truth: the store owns the cross-server unread summary and
  // coalesces concurrent loads, so this component no longer fetches it itself.
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const loadServerUnreadSummary = useServerStore((s) => s.loadServerUnreadSummary);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const moveToSectionTriggerRef = useRef<HTMLDivElement | null>(null);
  const [moveToSectionMenuOpen, setMoveToSectionMenuOpen] = useState(false);
  const [moveToSectionMenuPosition, setMoveToSectionMenuPosition] = useState<{ x: number; y: number } | null>(null);
  // The live drag projection is a store, not state: each section subscribes to
  // its own container, so a move doesn't re-render the Sidebar.
  const [sidebarDndProjectionStore] = useState(createSidebarDndProjectionStore);
  const setSidebarDndProjection = useCallback((projection: SidebarDndProjection | null) => {
    sidebarDndProjectionStore.setState({ projection });
  }, [sidebarDndProjectionStore]);
  const [sidebarDndActiveId, setSidebarDndActiveId] = useState<string | null>(null);
  const [sidebarDndSourceContainerId, setSidebarDndSourceContainerId] = useState<string | null>(null);
  const sidebarDndSnapshotRef = useRef<SidebarDndProjection | null>(null);
  const sidebarDndProjectionRef = useRef<SidebarDndProjection | null>(null);
  const setMoveToSectionMenuNode = useCallback((menu: HTMLDivElement | null) => {
    const trigger = moveToSectionTriggerRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    setMoveToSectionMenuPosition(placeSidebarContextSubmenu({
      anchor: {
        left: triggerRect.left,
        right: triggerRect.right,
        top: triggerRect.top,
      },
      menuWidth: menuRect.width,
      menuHeight: menuRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, []);
  return {
    sidebarRowLimit,
    formatMessage, dmChannels, channelsLoading, dmsLoading, channels, channelRowsDisplayOnlyRef,
    recencyActiveRef, channelActivity, deleteChannel, archiveChannel, leaveChannel,
    allAgents, agents, machinesLoading, machineNames, sidebarMachineIds, setShowAddMachine, userId,
    serverId, serverName, serverAvatarUrl, serverPublicPageLive, serversCount, sidebarOrder,
    sidebarOrderLoaded, pinnedHeld, channelSectionsHeld, dmsHeld, rowCountUserId, rememberedRows, rememberedComputerRows,
    customSections, sectionOrder, sectionPlacements, updateSidebarOrder, setSidebarOpen, hasLocalUnread,
    loadInbox, savedTotal, navigate, nav, location, sidebarScrollRef,
    handledSidebarFocusLocationKeyRef, raftBenchEnabled, labsUiEnabled, providerConnectionsEnabled,
    externalChannelsEnabled, slackBridgeEnabled, showCreateChannel, setShowCreateChannel,
    setShowCreateJointChannel, showCreateJointChannel, serverUnreadCounts, loadServerUnreadSummary,
    setCtxMenu, ctxMenu, ctxMenuRef, moveToSectionTriggerRef, setMoveToSectionMenuOpen,
    moveToSectionMenuOpen, moveToSectionMenuPosition, setMoveToSectionMenuPosition,
    setSidebarDndProjection, sidebarDndProjectionStore, sidebarDndActiveId, setSidebarDndActiveId,
    sidebarDndSourceContainerId, setSidebarDndSourceContainerId, sidebarDndSnapshotRef,
    sidebarDndProjectionRef, setMoveToSectionMenuNode,
  };
}

export type SidebarData = ReturnType<typeof useSidebarData>;
