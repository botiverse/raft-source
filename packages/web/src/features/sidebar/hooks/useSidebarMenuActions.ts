import { useCallback, useMemo } from "react";
import { canToggleActivityMute } from "../../../store/channelDomain";
import { useServerStore } from "../../../store/serverStore";
import type { NotificationLevelTarget } from "../../../components/notifications/NotificationLevelMenu";
import type { SidebarSortMode } from "../../../components/layout/sidebarSort";
import { sidebarChannelHomeSectionKey } from "../../../components/layout/sidebarChannelVisibility";
import type { SidebarSectionCandidate, SidebarSectionConversationChange } from "../../../components/layout/SidebarSectionAddConversationsDialog";
import { sidebarSectionItemKey } from "../../../store/sidebarSections";
import { sidebarSectionOrderKey } from "../sections/sidebarSortSections";
import { toMovableChange } from "../sidebarDisplayItems";
import type { SidebarMovableItem } from "../sidebarDisplayItems";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarSync } from "./useSidebarSync";
import type { SidebarItems } from "./useSidebarItems";
import type { SidebarDnd } from "./useSidebarDnd";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * The targets and actions of the row, section and surface context menus, the
 * move-to-section submenu, and the dialogs' open/close/submit handlers.
 */
export function useSidebarMenuActions(data: SidebarData, view: SidebarViewState, sync: SidebarSync, items: SidebarItems, dnd: SidebarDnd) {
  const {
    dmChannels, channels, deleteChannel, archiveChannel, leaveChannel, agents, customSections,
    sectionPlacements, updateSidebarOrder, setShowCreateChannel, setShowCreateJointChannel, ctxMenu,
    setCtxMenu, moveToSectionTriggerRef, setMoveToSectionMenuOpen, moveToSectionMenuPosition,
  } = data;
  const {
    sectionCtxMenu, setSectionDialog, sectionDialog, setDeleteSectionConfirm, deleteSectionConfirm,
    setDeleteConfirm, deleteConfirm, archiveConfirm, setArchiveConfirm, setLeaveConfirm, leaveConfirm, joinedChannelsOnly, hideEmptySections,
    updatePinnedSortMode, updateChannelSortMode, updateJointChannelSortMode, updateDmSortMode,
    updateJoinedChannelsOnly, updateHideEmptySections, gateExternalCreate,
  } = view;
  const { closedDmIds, closeDm, closeCtx, closeSectionCtx, closeSidebarSurfaceCtx } = sync;
  const {
    pinnedChannelIds, pinnedAgentIds, customPlacedAgentIds, visibleRegularChannels, orderedJointChannels,
    agentDmChannelId, agentDmChannelByAgentId, agentById, loungeEntryById,
  } = items;
  const {
    togglePinnedRef, moveItemToPinned, moveItemToCustomSection, placementsForSectionChange,
    removeItemFromCustomSection, createCustomSection, deleteCustomSection, togglePinChannel,
    toggleChannelActivityMute, togglePinAgent, togglePinDm,
  } = dnd;

  const contextCustomSection = sectionCtxMenu?.section.startsWith("custom:")
    ? customSections.find((section) => section.id === sectionCtxMenu.section.slice("custom:".length)) ?? null
    : null;
  const contextMovableItem: SidebarMovableItem | null = (() => {
    if (!ctxMenu) return null;
    if (ctxMenu.type === "channel" || ctxMenu.type === "dm") return { kind: "channel", id: ctxMenu.id };
    if (ctxMenu.type === "human") {
      const dm = dmChannels.find((candidate) => candidate.peerType === "user" && candidate.peerId === ctxMenu.id);
      return dm ? { kind: "channel", id: dm.id } : null;
    }
    if (ctxMenu.type === "agent") {
      if (pinnedAgentIds.includes(ctxMenu.id) || customPlacedAgentIds.has(ctxMenu.id)) return { kind: "agent", id: ctxMenu.id };
      const dm = dmChannels.find((candidate) => candidate.peerType === "agent" && candidate.peerId === ctxMenu.id);
      return dm ? { kind: "channel", id: dm.id } : { kind: "agent", id: ctxMenu.id };
    }
    return null;
  })();
  const contextPlacement = contextMovableItem
    ? sectionPlacements.find((placement) => sidebarSectionItemKey(placement.kind, placement.id) === sidebarSectionItemKey(contextMovableItem.kind, contextMovableItem.id)) ?? null
    : null;
  const contextItemPinned = contextMovableItem?.kind === "channel"
    ? pinnedChannelIds.includes(contextMovableItem.id)
    : contextMovableItem?.kind === "agent" && pinnedAgentIds.includes(contextMovableItem.id);
  // The section the right-clicked row is shown in, as a sectionOrder key.
  const contextItemSectionKey: string | null = (() => {
    if (!contextMovableItem) return null;
    if (contextPlacement) return contextPlacement.sectionId;
    if (contextItemPinned) return "system:pinned";
    if (contextMovableItem.kind === "agent") return "system:dms";
    const channel = channels.find((candidate) => candidate.id === contextMovableItem.id);
    if (channel) return sidebarChannelHomeSectionKey(channel);
    return dmChannels.some((dm) => dm.id === contextMovableItem.id) ? "system:dms" : null;
  })();
  // Dialog handlers. Each dialog only mounts while its state is set, so the
  // null guards below never fire in practice; they keep the callbacks total.
  const closeCreateChannelDialog = useCallback(() => setShowCreateChannel(false), []);
  const closeCreateJointChannelDialog = useCallback(() => setShowCreateJointChannel(false), []);
  const closeDeleteConfirm = useCallback(() => setDeleteConfirm(null), []);
  const confirmDelete = useCallback(async () => {
    if (deleteConfirm?.type !== "channel") return;
    await deleteChannel(deleteConfirm.id);
    setDeleteConfirm(null);
  }, [deleteChannel, deleteConfirm]);
  const closeArchiveConfirm = useCallback(() => setArchiveConfirm(null), []);
  const confirmArchive = useCallback(async () => {
    if (archiveConfirm) await archiveChannel(archiveConfirm.id);
  }, [archiveChannel, archiveConfirm]);
  const closeLeaveConfirm = useCallback(() => setLeaveConfirm(null), []);
  const confirmLeave = useCallback(async () => {
    if (leaveConfirm) await leaveChannel(leaveConfirm.id);
  }, [leaveChannel, leaveConfirm]);
  const closeSectionDialog = useCallback(() => setSectionDialog(null), []);
  const sectionAddCandidates = useMemo<SidebarSectionCandidate[]>(() => {
    if (sectionDialog?.mode !== "add" && sectionDialog?.mode !== "edit") return [];
    const channelCandidates = [...visibleRegularChannels, ...orderedJointChannels].map((channel) => ({
      key: sidebarSectionItemKey("channel", channel.id),
      kind: "channel" as const,
      id: channel.id,
      label: channel.name,
      icon: "channel" as const,
    }));
    const dmCandidates = dmChannels
      .filter((dm) => !closedDmIds.has(dm.id))
      .map((dm): SidebarSectionCandidate => {
        const peerAgent = dm.peerType === "agent" && dm.peerId ? agentById.get(dm.peerId) : undefined;
        return {
          key: sidebarSectionItemKey("channel", dm.id),
          kind: "channel" as const,
          id: dm.id,
          label: dm.peerDisplayName || dm.peerName || dm.name,
          icon: "dm" as const,
          appBot: peerAgent?.managedByAppInstallId ? { appName: peerAgent.managedByApp?.name ?? null } : null,
        };
      });
    return [...channelCandidates, ...dmCandidates];
  }, [agentById, closedDmIds, dmChannels, orderedJointChannels, sectionDialog?.mode, visibleRegularChannels]);
  const submitCreateSection = useCallback((value: { name: string; emoji: string | null }) => {
    if (sectionDialog?.mode === "create") createCustomSection(value, sectionDialog.moveItem, sectionDialog.insertBefore);
  }, [createCustomSection, sectionDialog]);
  const editSectionId = sectionDialog?.mode === "edit" ? sectionDialog.section.id : null;
  const editSectionConversations = useMemo(() => editSectionId
    ? {
      candidates: sectionAddCandidates,
      initialSelectedKeys: sectionPlacements
        .filter((placement) => placement.sectionId === editSectionId)
        .map((placement) => sidebarSectionItemKey(placement.kind, placement.id)),
    }
    : undefined,
  [editSectionId, sectionAddCandidates, sectionPlacements]);
  const submitAddToSection = useCallback((change: SidebarSectionConversationChange) => {
    if (sectionDialog?.mode !== "add") return;
    void updateSidebarOrder(placementsForSectionChange(toMovableChange(change), sectionDialog.sectionId));
    setSectionDialog(null);
  }, [placementsForSectionChange, sectionDialog, updateSidebarOrder]);
  // Edit renames and adds / removes conversations in one dialog and one write.
  const submitEditSection = useCallback((value: { name: string; emoji: string | null; conversationChange?: SidebarSectionConversationChange }) => {
    if (sectionDialog?.mode !== "edit") return;
    const sectionId = sectionDialog.section.id;
    void updateSidebarOrder({
      customSections: customSections.map((section) => section.id === sectionId
        ? { ...section, name: value.name, emoji: value.emoji }
        : section),
      ...(value.conversationChange ? placementsForSectionChange(toMovableChange(value.conversationChange), sectionId) : {}),
    });
    setSectionDialog(null);
  }, [customSections, placementsForSectionChange, sectionDialog, updateSidebarOrder]);
  const closeDeleteSectionConfirm = useCallback(() => setDeleteSectionConfirm(null), []);
  const confirmDeleteSection = useCallback(() => {
    if (!deleteSectionConfirm) return;
    deleteCustomSection(deleteSectionConfirm.id);
    setDeleteSectionConfirm(null);
  }, [deleteCustomSection, deleteSectionConfirm]);

  // Section context-menu actions. The menu only renders while
  // `sectionCtxMenu` is set; each action reads the section it was opened for.
  const selectSectionSortMode = useCallback((mode: SidebarSortMode) => {
    if (!sectionCtxMenu) return;
    if (contextCustomSection) {
      void updateSidebarOrder({
        customSections: customSections.map((section) => section.id === contextCustomSection.id ? { ...section, sortMode: mode } : section),
      });
    } else if (sectionCtxMenu.section === "pinned") updatePinnedSortMode(mode);
    else if (sectionCtxMenu.section === "jointChannels") updateJointChannelSortMode(mode);
    else if (sectionCtxMenu.section === "channels") updateChannelSortMode(mode);
    else updateDmSortMode(mode);
    closeSectionCtx();
  }, [
    closeSectionCtx,
    contextCustomSection,
    customSections,
    sectionCtxMenu,
    updateChannelSortMode,
    updateDmSortMode,
    updateJointChannelSortMode,
    updatePinnedSortMode,
    updateSidebarOrder,
  ]);
  const toggleJoinedChannelsOnlyFromMenu = useCallback(() => {
    updateJoinedChannelsOnly(!joinedChannelsOnly);
    closeSectionCtx();
  }, [closeSectionCtx, joinedChannelsOnly, updateJoinedChannelsOnly]);
  const toggleHideEmptySectionsFromMenu = useCallback(() => {
    updateHideEmptySections(!hideEmptySections);
    closeSectionCtx();
  }, [closeSectionCtx, hideEmptySections, updateHideEmptySections]);
  const renameContextSection = useCallback(() => {
    if (!contextCustomSection) return;
    setSectionDialog({ mode: "edit", section: contextCustomSection });
    closeSectionCtx();
  }, [closeSectionCtx, contextCustomSection]);
  const createSectionFromSectionMenu = useCallback(() => {
    setSectionDialog({ mode: "create", insertBefore: sectionCtxMenu ? sidebarSectionOrderKey(sectionCtxMenu.section) : undefined });
    closeSectionCtx();
  }, [closeSectionCtx, sectionCtxMenu]);
  const deleteContextSection = useCallback(() => {
    if (!contextCustomSection) return;
    setDeleteSectionConfirm(contextCustomSection);
    closeSectionCtx();
  }, [closeSectionCtx, contextCustomSection]);

  // Sidebar surface context-menu actions.
  const createChannelFromSurfaceMenu = useCallback(() => {
    setShowCreateChannel(true);
    closeSidebarSurfaceCtx();
  }, [closeSidebarSurfaceCtx]);
  // Create External Channel; the Free plan's one external channel taken: the upgrade dialog instead.
  const createJointChannelFromSurfaceMenu = useCallback(() => {
    gateExternalCreate(() => setShowCreateJointChannel("sidebar_surface_menu"));
    closeSidebarSurfaceCtx();
  }, [closeSidebarSurfaceCtx, gateExternalCreate]);
  const createSectionFromSurfaceMenu = useCallback(() => {
    setSectionDialog({ mode: "create" });
    closeSidebarSurfaceCtx();
  }, [closeSidebarSurfaceCtx]);

  // Row context-menu targets and actions. Targets are resolved from the id the
  // menu was opened with; actions only run while the menu (and so its target)
  // is rendered.
  const ctxChannel = ctxMenu?.type === "channel" ? channels.find((c) => c.id === ctxMenu.id) : undefined;
  const ctxHumanDmChannel = ctxMenu?.type === "human"
    ? dmChannels.find((dm) => dm.peerType === "user" && dm.peerId === ctxMenu.id)
    : undefined;
  const ctxDmChannel = ctxMenu?.type === "dm" ? dmChannels.find((dm) => dm.id === ctxMenu.id) : undefined;
  const ctxAgent = ctxMenu?.type === "agent" ? agents.find((a) => a.id === ctxMenu.id) : undefined;
  const ctxAgentDmChannelId = ctxMenu?.type === "agent" && ctxAgent ? agentDmChannelId[ctxAgent.id] : undefined;
  const ctxDmIdToClose = ctxHumanDmChannel?.id ?? ctxDmChannel?.id ?? ctxAgentDmChannelId;
  // Agent Lounge v0: a Lounge row's menu (no Move to section: a Lounge goes
  // only in Direct Messages or Pinned).
  const ctxLounge = ctxMenu?.type === "lounge" ? loungeEntryById.get(ctxMenu.id) : undefined;

  const closeMoveToSectionMenuFromHover = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const menuItem = (event.target as Element).closest('[role="menuitem"]');
    if (menuItem && !moveToSectionTriggerRef.current?.contains(menuItem)) {
      setMoveToSectionMenuOpen(false);
    }
  }, []);
  const closeMoveToSectionMenuFromFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (!moveToSectionTriggerRef.current?.contains(event.target)) {
      setMoveToSectionMenuOpen(false);
    }
  }, []);
  const openMoveToSectionMenu = useCallback(() => setMoveToSectionMenuOpen(true), []);
  // What a row menu's Mute / Unmute acts on: the channel, or the DM of a
  // person, agent or DM row (only a DM with an App bot can be muted).
  const ctxMuteTarget = ctxChannel ?? ctxHumanDmChannel ?? ctxDmChannel ?? ctxLounge?.channel
    ?? (ctxMenu?.type === "agent" && ctxAgent ? agentDmChannelByAgentId[ctxAgent.id] : undefined);
  const toggleContextActivityMute = useCallback(() => {
    if (!ctxMuteTarget) return;
    void toggleChannelActivityMute(ctxMuteTarget);
    setCtxMenu(null);
  }, [ctxMuteTarget, toggleChannelActivityMute]);
  // Notifications ▸ (design §4.3), as in Slack: a channel's one choice of All /
  // Only what involves me / Mute, so a channel row has no separate Mute item.
  // DMs and Lounges keep only Mute and threads only Follow.
  const ctxNotificationServerId = useServerStore((s) => s.current?.id ?? null);
  const ctxIsLounge = ctxMenu?.type === "lounge";
  const contextNotificationLevelTarget = useMemo<Extract<NotificationLevelTarget, { scope: "channel" }> | null>(() => {
    if (!ctxMuteTarget || !ctxNotificationServerId || ctxIsLounge || ctxMuteTarget.type === "thread" || ctxMuteTarget.type === "dm") return null;
    const muted = ctxMuteTarget.activityMuted === true;
    return {
      scope: "channel",
      serverId: ctxNotificationServerId,
      channelId: ctxMuteTarget.id,
      mute: canToggleActivityMute(ctxMuteTarget)
        ? { muted, setMuted: (next: boolean) => (next === muted ? undefined : toggleChannelActivityMute(ctxMuteTarget)) }
        : undefined,
    };
  }, [ctxIsLounge, ctxMuteTarget, ctxNotificationServerId, toggleChannelActivityMute]);
  // Stryker disable all: pin behavior predates the Activity mute action and has separate coverage.
  const toggleContextChannelPin = useCallback(() => {
    if (!ctxMenu) return;
    togglePinChannel(ctxMenu.id);
    setCtxMenu(null);
  }, [ctxMenu, togglePinChannel]);
  // Stryker restore all
  const archiveContextChannel = useCallback(() => {
    if (!ctxMenu) return;
    setArchiveConfirm({ id: ctxMenu.id, name: ctxChannel?.name ?? "" });
    setCtxMenu(null);
  }, [ctxChannel, ctxMenu]);
  const leaveContextChannel = useCallback(() => {
    if (!ctxMenu) return;
    setLeaveConfirm({ id: ctxMenu.id, name: ctxChannel?.name ?? "" });
    setCtxMenu(null);
  }, [ctxChannel, ctxMenu]);
  const toggleContextHumanPin = useCallback(() => {
    if (!ctxMenu) return;
    togglePinnedRef({ kind: "human", id: ctxMenu.id });
    setCtxMenu(null);
  }, [ctxMenu, togglePinnedRef]);
  const toggleContextDmPin = useCallback(() => {
    if (!ctxDmChannel) return;
    togglePinDm(ctxDmChannel);
    setCtxMenu(null);
  }, [ctxDmChannel, togglePinDm]);
  const toggleContextAgentPin = useCallback(() => {
    if (!ctxMenu) return;
    togglePinAgent(ctxMenu.id);
    setCtxMenu(null);
  }, [ctxMenu, togglePinAgent]);
  const closeContextDm = useCallback(() => {
    if (!ctxDmIdToClose) return;
    closeDm(ctxDmIdToClose);
    setCtxMenu(null);
  }, [closeDm, ctxDmIdToClose]);
  const toggleContextLoungePin = useCallback(() => {
    if (!ctxLounge) return;
    togglePinChannel(ctxLounge.channelId);
    setCtxMenu(null);
  }, [ctxLounge, togglePinChannel]);
  const closeContextLounge = useCallback(() => {
    if (!ctxLounge) return;
    closeDm(ctxLounge.channelId);
    setCtxMenu(null);
  }, [closeDm, ctxLounge]);
  // Move-to-section submenu actions.
  const moveToSectionMenuStyle = useMemo<React.CSSProperties>(() => ({
    left: moveToSectionMenuPosition?.x ?? 0,
    top: moveToSectionMenuPosition?.y ?? 0,
    visibility: moveToSectionMenuPosition ? "visible" : "hidden",
  }), [moveToSectionMenuPosition]);
  const moveContextItemToPinned = useCallback(() => {
    if (!contextMovableItem) return;
    moveItemToPinned(contextMovableItem);
    closeCtx();
  }, [closeCtx, contextMovableItem, moveItemToPinned]);
  const moveContextItemToSection = useCallback((sectionId: string) => {
    if (!contextMovableItem) return;
    moveItemToCustomSection(contextMovableItem, sectionId);
    closeCtx();
  }, [closeCtx, contextMovableItem, moveItemToCustomSection]);
  const createSectionWithContextItem = useCallback(() => {
    if (!contextMovableItem) return;
    setSectionDialog({ mode: "create", moveItem: contextMovableItem, insertBefore: contextItemSectionKey ?? undefined });
    closeCtx();
  }, [closeCtx, contextItemSectionKey, contextMovableItem]);
  const removeContextItemFromSection = useCallback(() => {
    if (!contextMovableItem) return;
    removeItemFromCustomSection(contextMovableItem);
    closeCtx();
  }, [closeCtx, contextMovableItem, removeItemFromCustomSection]);
  return {
    contextCustomSection, contextMovableItem, contextPlacement, contextItemPinned, closeCreateChannelDialog,
    closeCreateJointChannelDialog, closeDeleteConfirm, confirmDelete, closeArchiveConfirm, confirmArchive,
    closeLeaveConfirm, confirmLeave, closeSectionDialog, sectionAddCandidates, submitCreateSection,
    editSectionConversations, submitAddToSection, submitEditSection, closeDeleteSectionConfirm,
    confirmDeleteSection, selectSectionSortMode, toggleJoinedChannelsOnlyFromMenu,
    toggleHideEmptySectionsFromMenu, renameContextSection, createSectionFromSectionMenu,
    deleteContextSection, createChannelFromSurfaceMenu, createJointChannelFromSurfaceMenu,
    createSectionFromSurfaceMenu, ctxChannel, ctxHumanDmChannel, ctxDmChannel, ctxAgent,
    ctxAgentDmChannelId, closeMoveToSectionMenuFromHover, closeMoveToSectionMenuFromFocus,
    openMoveToSectionMenu, ctxMuteTarget, toggleContextActivityMute, contextNotificationLevelTarget,
    toggleContextChannelPin, archiveContextChannel, leaveContextChannel, toggleContextHumanPin,
    toggleContextDmPin, toggleContextAgentPin, closeContextDm, ctxLounge, toggleContextLoungePin,
    closeContextLounge, moveToSectionMenuStyle,
    moveContextItemToPinned, moveContextItemToSection, createSectionWithContextItem,
    removeContextItemFromSection,
  };
}

export type SidebarMenuActions = ReturnType<typeof useSidebarMenuActions>;
