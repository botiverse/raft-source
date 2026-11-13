import { useState, useEffect, useCallback, useRef } from "react";
import { useAppearanceStore } from "../../../store/appearanceStore";
import { useServerStore } from "../../../store/serverStore";
import { useRailMode } from "../../../hooks/useSidebarTab";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useExternalChannelCreateAccess } from "../../../components/channel/externalInvites";
import { useExternalLimitGate } from "../../../components/channel/externalChannelSlot";
import type { SidebarSortMode } from "../../../components/layout/sidebarSort";
import { readSidebarJoinedChannelsOnly, writeSidebarJoinedChannelsOnly } from "../../../components/layout/sidebarChannelVisibility";
import { canOpenSettingsTab } from "../../../components/settings/settingsNavigation";
import type { SidebarCustomSection } from "../../../store/sidebarSections";
import { readSidebarCollapsedSections, readSidebarCustomSectionCollapsed } from "../../../components/layout/sidebarCollapsedSections";
import type { SidebarCollapsedSections } from "../../../components/layout/sidebarCollapsedSections";
import { shouldHideEmptySidebarSection } from "../../../components/layout/sidebarEmptySectionVisibility";
import type { SectionCtxMenu, SidebarSurfaceCtxMenu } from "../sidebarContextMenu";
import type { SidebarSortSection } from "../sections/sidebarSortSections";
import type { SidebarMovableItem } from "../sidebarDisplayItems";
import type { SidebarData } from "./useSidebarData";

/* oxlint-disable react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change, react-doctor/no-event-handler --
 * this state and these effects were the single Sidebar component's own (#proj-frontend:#27); the rules
 * read the values an earlier Sidebar hook passes in as props. */
/**
 * The Sidebar's view state: section and surface menus, the section dialog,
 * collapsed sections, confirmations, permissions, the rail
 * mode, sort modes and the joined-only / hide-empty display choices.
 */
export function useSidebarViewState(data: SidebarData) {
  const {
    formatMessage, recencyActiveRef, allAgents, userId, serverId,
    sidebarOrder, customSections, updateSidebarOrder, sidebarDndActiveId, sidebarDndSourceContainerId,
    externalChannelsEnabled,
  } = data;

  const [sectionCtxMenu, setSectionCtxMenu] = useState<SectionCtxMenu | null>(null);
  const sectionCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarSurfaceCtxMenu, setSidebarSurfaceCtxMenu] = useState<SidebarSurfaceCtxMenu | null>(null);
  const sidebarSurfaceCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const [sectionDialog, setSectionDialog] = useState<
    // `insertBefore`: the sectionOrder key of the section the menu was opened
    // on, so the new section lands right above it (task #34).
    | { mode: "create"; moveItem?: SidebarMovableItem; insertBefore?: string }
    | { mode: "edit"; section: SidebarCustomSection }
    // Step 2 of create: the section exists; pick conversations to move in.
    | { mode: "add"; sectionId: string; sectionName: string; initialKeys: string[] }
    | null
  >(null);
  const [collapsedCustomSections, setCollapsedCustomSections] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(customSections.map((section) => [
      section.id,
      readSidebarCustomSectionCollapsed(userId, section.id),
    ]))
  ));
  const collapsedCustomSectionUserIdRef = useRef(userId);
  const customSectionIdsKey = customSections.map((section) => section.id).join("\u0000");
  const collapsedCustomSectionIdsKeyRef = useRef(customSectionIdsKey);
  useEffect(() => {
    if (
      collapsedCustomSectionUserIdRef.current === userId
      && collapsedCustomSectionIdsKeyRef.current === customSectionIdsKey
    ) return;
    collapsedCustomSectionUserIdRef.current = userId;
    collapsedCustomSectionIdsKeyRef.current = customSectionIdsKey;
    // oxlint-disable-next-line react-doctor/no-chain-state-updates -- disclosure state must reset when the authenticated user or server sections change.
    setCollapsedCustomSections(Object.fromEntries(customSections.map((section) => [
      section.id,
      readSidebarCustomSectionCollapsed(userId, section.id),
    ])));
  }, [customSectionIdsKey, customSections, userId]);
  const [deleteSectionConfirm, setDeleteSectionConfirm] = useState<SidebarCustomSection | null>(null);
  // iOS PWA (display:standalone) does not reliably suppress the synthetic
  // click after a long-press touchend, even with e.preventDefault(). That
  // phantom click would land on the context menu overlay or a menu button
  // and close the menu the instant the finger lifted. We absorb clicks with
  // an invisible full-screen shield for ~500ms after a long-press opens the
  // menu, then remove it so the user can interact normally.
  const [ctxMenuClickShielded, setCtxMenuClickShielded] = useState(false);
  const ctxMenuShieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: "channel" | "agent";
    id: string;
    name: string;
  } | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState<{ id: string; name: string } | null>(null);

  // Stryker disable all: pre-existing deleted-agent confirmation cleanup is outside the workspace mutation corpus.
  useEffect(() => {
    if (deleteConfirm?.type !== "agent") return;
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (allAgents.some((agent) => agent.id === deleteConfirm.id && agent.deletedAt)) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setDeleteConfirm(null);
    }
  }, [allAgents, deleteConfirm]);
  // Stryker restore all

  // Stryker disable next-line all: pre-existing account menu state is outside the workspace mutation corpus.
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  // Stryker disable next-line all: pre-existing member subscription is covered by sidebar behavior tests.
  const members = useServerStore((s) => s.members);
  const { role: currentRole, capabilities } = useServerPermissions();
  const canManageServer = capabilities.editServerSettings;
  const canCreateChannel = capabilities.createChannels;
  // The Joint Channels / External section's create entries ("+", section and
  // surface menus): with external_channels_v1 on they open Create Channel with
  // External chosen, for whoever Create Channel offers External to (owners and
  // admins); off, the Joint Channel dialog for federateChannels, as before.
  const externalChannelCreateAccess = useExternalChannelCreateAccess();
  const canCreateJointChannel = externalChannelsEnabled ? externalChannelCreateAccess : capabilities.federateChannels;
  // A Free server whose one external channel is taken (cindyz, Warden): those
  // entries open the upgrade dialog instead (externalChannelSlot). Still being
  // read when clicked: Create Channel, which says so itself.
  const gateExternalCreate = useExternalLimitGate(externalChannelsEnabled && externalChannelCreateAccess, "sidebar");
  const canRegisterMachines = capabilities.registerMachines;
  const canManageExternalAuth = capabilities.manageExternalAuth;
  const canViewBillingSettings = canOpenSettingsTab("billing", capabilities);
  const canViewAdministrationSettings = canOpenSettingsTab("administration", capabilities);
  const canViewApplicationsSettings = canOpenSettingsTab("integrations", capabilities);
  // The single source of truth for which left-column surface is active.
  // Both Sidebar and LeftRail derive from useRailMode(), which reads the
  // URL — so the rail's highlighted button and the sidebar's content stay
  // strictly in sync. On mobile the LeftRail is hidden; the 4-tab mobile
  // bar maps /computers back to the Settings tab (Computers is reachable
  // from the Settings sub-nav, not Members).
  const { railMode } = useRailMode();
  const showSettingsRail = railMode === "settings";
  const showComputersRail = railMode === "computers";
  const showChatRail = railMode !== "members";
  const railLabel = railMode === "settings" ? formatMessage({ id: "layout.sidebar.headerSettings" })
    : railMode === "tasks" ? formatMessage({ id: "layout.sidebar.headerTasks" })
    : railMode === "computers" ? formatMessage({ id: "layout.sidebar.headerComputers" })
    : railMode === "members" ? formatMessage({ id: "layout.sidebar.headerMembers" })
    : formatMessage({ id: "layout.sidebar.headerChat" });
  // Stryker restore all

  const [collapsed, setCollapsed] = useState<SidebarCollapsedSections>(() => (
    readSidebarCollapsedSections(userId)
  ));
  const collapsedPreferenceUserIdRef = useRef(userId);
  useEffect(() => {
    if (collapsedPreferenceUserIdRef.current === userId) return;
    collapsedPreferenceUserIdRef.current = userId;
    setCollapsed(readSidebarCollapsedSections(userId));
  }, [userId]);
  const channelSortMode = sidebarOrder.channelSortMode;
  const jointChannelSortMode = sidebarOrder.jointChannelSortMode;
  const dmSortMode = sidebarOrder.dmSortMode;
  const pinnedSortMode = sidebarOrder.pinnedSortMode;
  // When any list sorts by recency, `lastMessageAt` order matters → the
  // channels/dmChannels subscriptions (above) must react to every bump. In the
  // default manual/az modes it does not, so those bumps are ignored.
  recencyActiveRef.current =
    channelSortMode === "recent" ||
    jointChannelSortMode === "recent" ||
    dmSortMode === "recent" ||
    pinnedSortMode === "recent";
  const [openSortMenu, setOpenSortMenu] = useState<SidebarSortSection | null>(null);
  // Stryker disable all: React persistence wiring is browser/DOM verified; storage and membership semantics are mutation-tested in sidebarChannelVisibility.
  // Per server: the stored choice is for the server it was made on; another
  // server reads its own (no effect re-syncing state after a switch).
  const [joinedChannelsOnlyChoice, setJoinedChannelsOnlyChoice] = useState(() => ({
    serverId,
    value: readSidebarJoinedChannelsOnly(serverId),
  }));
  const joinedChannelsOnly = joinedChannelsOnlyChoice.serverId === serverId
    ? joinedChannelsOnlyChoice.value
    : readSidebarJoinedChannelsOnly(serverId);
  // Global display preference (not per-server): drop sections that are currently
  // empty. Lives in appearanceStore so the Settings → Appearance toggle and this
  // section context menu stay in sync. Defaults OFF (web and desktop).
  const hideEmptySections = useAppearanceStore((s) => s.hideEmptySidebarSections);

  const updatePinnedSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ pinnedSortMode: mode });
  }, [updateSidebarOrder]);

  const updateChannelSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ channelSortMode: mode });
  }, [updateSidebarOrder]);

  const updateJointChannelSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ jointChannelSortMode: mode });
  }, [updateSidebarOrder]);

  const updateDmSortMode = useCallback((mode: SidebarSortMode) => {
    void updateSidebarOrder({ dmSortMode: mode });
  }, [updateSidebarOrder]);

  const updateJoinedChannelsOnly = useCallback((joinedOnly: boolean) => {
    setJoinedChannelsOnlyChoice({ serverId, value: joinedOnly });
    writeSidebarJoinedChannelsOnly(serverId, joinedOnly);
  }, [serverId]);

  const updateHideEmptySections = useAppearanceStore((s) => s.setHideEmptySidebarSections);

  // A section is dropped only once its contents have settled and it is genuinely
  // empty. Guards, in order: never mid-load (so it can't flash in on first
  // paint); never while this section is the source of an in-flight drag —
  // `count` comes from the LIVE drag projection, so dragging the last item out
  // would otherwise unmount the source mid-drag and strand the gesture. Other
  // hidden empty sections stay hidden unless a section opts into being a drag
  // target. The main Channels section is intentionally exempt — its empty state
  // carries the channel-discovery / onboarding hint. Joint Channels is exempt
  // too while the user can create one: its header "+" is the only visible entry
  // point to create a joint channel, so hiding it would strand the action.
  // `loading` is the section's own; a loading section that was empty the last
  // time it loaded here is treated as settled, so it stays hidden instead of
  // showing for the load and then going.
  const isEmptySectionHidden = useCallback(
    // alwaysHide: a section only filled from elsewhere (External) hides when empty whatever the
    // person's "hide empty sections" setting, keeping the loading and dragging guards below.
    (count: number, loading: boolean, rememberedCount: number | null, containerId?: string, revealWhileDragging?: boolean, alwaysHide?: boolean) =>
      shouldHideEmptySidebarSection({
        hideEmptySections: hideEmptySections || alwaysHide === true,
        loading: loading && rememberedCount !== 0,
        itemCount: count,
        dragActive: Boolean(sidebarDndActiveId),
        dragStartedInSection: containerId != null && containerId === sidebarDndSourceContainerId,
        revealWhileDragging,
      }),
    [hideEmptySections, sidebarDndActiveId, sidebarDndSourceContainerId],
  );

  // Stryker restore all
  return {
    setSectionCtxMenu, sectionCtxMenu, sectionCtxMenuRef, setSidebarSurfaceCtxMenu, sidebarSurfaceCtxMenu,
    sidebarSurfaceCtxMenuRef, setSectionDialog, sectionDialog, setCollapsedCustomSections,
    collapsedCustomSections, setDeleteSectionConfirm, deleteSectionConfirm, ctxMenuClickShielded,
    setCtxMenuClickShielded, ctxMenuShieldTimerRef, setDeleteConfirm, deleteConfirm, archiveConfirm,
    setArchiveConfirm, setLeaveConfirm, leaveConfirm, setShowUserMenu, showUserMenu, showServerMenu,
    setShowServerMenu, members, currentRole, capabilities, canManageServer, canCreateChannel,
    canCreateJointChannel, gateExternalCreate, canRegisterMachines, canManageExternalAuth, canViewBillingSettings,
    canViewAdministrationSettings, canViewApplicationsSettings, railMode, showSettingsRail,
    showComputersRail, showChatRail, railLabel, collapsed, setCollapsed, channelSortMode,
    jointChannelSortMode, dmSortMode, pinnedSortMode, openSortMenu, setOpenSortMenu, joinedChannelsOnly,
    hideEmptySections, updatePinnedSortMode, updateChannelSortMode, updateJointChannelSortMode,
    updateDmSortMode, updateJoinedChannelsOnly, updateHideEmptySections, isEmptySectionHidden,
  };
}

export type SidebarViewState = ReturnType<typeof useSidebarViewState>;
