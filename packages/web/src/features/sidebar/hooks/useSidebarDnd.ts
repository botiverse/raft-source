import { toast } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { closestCenter, pointerWithin } from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { isSidebarDndProbeEnabled, recordSidebarDndCollisionBranch } from "../../../utils/sidebarDndE2eProbe";
import type { Channel } from "../../../store/channelStore";
import { toggleChannelActivityMute as toggleSharedChannelActivityMute } from "../../../store/channelActivityMuteToggle";
import { isSidebarExternalSectionChannel } from "../../../components/layout/sidebarChannelVisibility";
import { moveSidebarItemToCustomSection, moveSidebarItemToCustomSectionAtPosition, reorderSidebarSectionOrder, removeSidebarItemPlacement, sidebarCreateSectionUpdate, sidebarMoveToCustomSectionUpdate, sidebarMoveToPinnedUpdate, sidebarSectionItemKey } from "../../../store/sidebarSections";
import type { SidebarCustomSection } from "../../../store/sidebarSections";
import { hasSidebarPinnedRef, removeSidebarPinnedRef, sidebarPinnedRefKey, upsertSidebarPinnedRef } from "../../../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../../../utils/sidebarPinnedRefs";
import { findSidebarDndContainer, isPointerWithinSidebarDndBounds, isSidebarDndData, moveSidebarDndItem, SIDEBAR_DND_DROP_INDEX_KEY, sidebarDndCollisionDropIndex, sidebarDndContainerDropIndex, resolveSidebarDndRetainedContainer, replaceSidebarSubsetOrder, sidebarCustomSectionId, SIDEBAR_CHANNELS_CONTAINER_ID, SIDEBAR_DMS_CONTAINER_ID, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID, SIDEBAR_PINNED_CONTAINER_ID } from "../../../components/layout/sidebarDnd";
import type { SidebarDndData, SidebarDndProjection } from "../../../components/layout/sidebarDnd";
import { pinnedRefForDmChannel } from "../sidebarDisplayItems";
import type { SidebarMovableItem } from "../sidebarDisplayItems";
import { parseDragId, getSidebarDropIndicatorEdge } from "../dnd/sidebarDragIds";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarSync } from "./useSidebarSync";
import type { SidebarItems } from "./useSidebarItems";
import type { SidebarProjection } from "./useSidebarProjection";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * Pin, custom-section and drag-and-drop mutations of the sidebar order, and
 * the drag handlers and collision detection.
 */
export function useSidebarDnd(data: SidebarData, view: SidebarViewState, sync: SidebarSync, items: SidebarItems, projection: SidebarProjection) {
  const {
    formatMessage, dmChannels, channels, channelRowsDisplayOnlyRef, customSections, sectionOrder,
    sectionPlacements, updateSidebarOrder, setSidebarDndProjection, setSidebarDndActiveId,
    setSidebarDndSourceContainerId, sidebarDndSnapshotRef, sidebarDndProjectionRef,
  } = data;
  const { setSectionCtxMenu, setSectionDialog } = view;
  const {
    setChannelOrderIds, channelOrderIds, setDmOrderIds, dmOrderIds, allChannelId, closeCtx, closeSectionCtx,
  } = sync;
  const { pinnedRefs, channelManualSort, jointChannelManualSort, dmManualSort, pinnedManualSort, loungeEntryById } = items;
  const { sidebarDndBaseProjection } = projection;

  const resolvePinnedRefFromDragId = useCallback((id: string): SidebarPinnedRef | null => {
    const parsed = parseDragId(id);
    if (!parsed) return null;
    if (parsed.kind === "agent") return { kind: "agent", id: parsed.id };
    const dm = dmChannels.find((channel) => channel.id === parsed.id);
    return dm ? pinnedRefForDmChannel(dm) : { kind: "channel", id: parsed.id };
  }, [dmChannels]);

  const resolveMovableItemFromDragId = useCallback((id: string): SidebarMovableItem | null => {
    const parsed = parseDragId(id);
    if (!parsed) return null;
    if (parsed.kind === "channel" || parsed.kind === "dm") {
      return { kind: "channel", id: parsed.id };
    }
    if (parsed.kind === "agent") return { kind: "agent", id: parsed.id };
    return null;
  }, []);

  const getSidebarDndHomeContainer = useCallback((itemId: string): string | null => {
    const parsed = parseDragId(itemId);
    if (!parsed) return null;
    if (parsed.kind === "agent") {
      return dmChannels.some((dm) => dm.peerType === "agent" && dm.peerId === parsed.id)
        ? SIDEBAR_DMS_CONTAINER_ID
        : null;
    }
    if (parsed.kind === "dm" || dmChannels.some((dm) => dm.id === parsed.id)) {
      return SIDEBAR_DMS_CONTAINER_ID;
    }
    const channel = channels.find((candidate) => candidate.id === parsed.id);
    if (!channel) return null;
    return isSidebarExternalSectionChannel(channel)
      ? SIDEBAR_JOINT_CHANNELS_CONTAINER_ID
      : SIDEBAR_CHANNELS_CONTAINER_ID;
  }, [channels, dmChannels]);

  const getSidebarDndDefaultOrderId = useCallback((itemId: string): string | null => {
    const parsed = parseDragId(itemId);
    if (!parsed) return null;
    if (parsed.kind === "agent") {
      return dmChannels.find((dm) => dm.peerType === "agent" && dm.peerId === parsed.id)?.id ?? null;
    }
    // A Lounge row sits among the DMs but has no place in their saved order.
    if (loungeEntryById.has(parsed.id)) return null;
    return parsed.id;
  }, [dmChannels, loungeEntryById]);

  const isSidebarDndContainerManual = useCallback((containerId: string): boolean => {
    if (containerId === SIDEBAR_PINNED_CONTAINER_ID) return pinnedManualSort;
    if (containerId === SIDEBAR_CHANNELS_CONTAINER_ID) return channelManualSort;
    if (containerId === SIDEBAR_JOINT_CHANNELS_CONTAINER_ID) return jointChannelManualSort;
    if (containerId === SIDEBAR_DMS_CONTAINER_ID) return dmManualSort;
    const customSectionId = sidebarCustomSectionId(containerId);
    return !!customSectionId
      && customSections.some((section) => section.id === customSectionId && section.sortMode === "manual");
  }, [
    channelManualSort,
    customSections,
    dmManualSort,
    jointChannelManualSort,
    pinnedManualSort,
  ]);

  const isValidSidebarDndDestination = useCallback((itemId: string, containerId: string): boolean => {
    if (!isSidebarDndContainerManual(containerId)) return false;
    if (
      containerId === SIDEBAR_PINNED_CONTAINER_ID
      || sidebarCustomSectionId(containerId)
    ) return true;
    return getSidebarDndHomeContainer(itemId) === containerId;
  }, [getSidebarDndHomeContainer, isSidebarDndContainerManual]);

  const togglePinnedRef = useCallback((ref: SidebarPinnedRef, placementsToRemove: SidebarMovableItem[] = []) => {
    const isPinned = hasSidebarPinnedRef(pinnedRefs, ref);
    const next = isPinned ? removeSidebarPinnedRef(pinnedRefs, ref) : upsertSidebarPinnedRef(pinnedRefs, ref);
    const nextPlacements = isPinned
      ? sectionPlacements
      : placementsToRemove.reduce(
          (placements, item) => removeSidebarItemPlacement(placements, item),
          sectionPlacements,
        );
    void updateSidebarOrder({
      pinned: next,
      ...(nextPlacements === sectionPlacements ? {} : { sectionPlacements: nextPlacements }),
    });
  }, [pinnedRefs, sectionPlacements, updateSidebarOrder]);

  const pinnedRefForMovableItem = useCallback((item: SidebarMovableItem): SidebarPinnedRef | null => {
    if (item.kind === "agent") return { kind: "agent", id: item.id };
    const dm = dmChannels.find((channel) => channel.id === item.id);
    return dm ? pinnedRefForDmChannel(dm) : { kind: "channel", id: item.id };
  }, [dmChannels]);

  const moveItemToPinned = useCallback((item: SidebarMovableItem) => {
    const ref = pinnedRefForMovableItem(item);
    if (!ref) return;
    void updateSidebarOrder(sidebarMoveToPinnedUpdate({ pinned: pinnedRefs, sectionPlacements }, item, ref));
  }, [pinnedRefForMovableItem, pinnedRefs, sectionPlacements, updateSidebarOrder]);

  const moveItemToCustomSection = useCallback((item: SidebarMovableItem, sectionId: string) => {
    void updateSidebarOrder(sidebarMoveToCustomSectionUpdate(
      { pinned: pinnedRefs, sectionPlacements },
      item,
      sectionId,
      pinnedRefForMovableItem(item),
    ));
  }, [pinnedRefForMovableItem, pinnedRefs, sectionPlacements, updateSidebarOrder]);

  // Placements and pins after moving `added` into the section and `removed`
  // back to their default sections.
  const placementsForSectionChange = useCallback((change: { added: SidebarMovableItem[]; removed: SidebarMovableItem[] }, sectionId: string) => {
    let nextPlacements = sectionPlacements;
    let nextPinned = pinnedRefs;
    for (const item of change.added) {
      nextPlacements = moveSidebarItemToCustomSection(nextPlacements, item, sectionId);
      const ref = pinnedRefForMovableItem(item);
      if (ref) nextPinned = removeSidebarPinnedRef(nextPinned, ref);
    }
    // A removed conversation goes back to its default section.
    for (const item of change.removed) nextPlacements = removeSidebarItemPlacement(nextPlacements, item);
    return { sectionPlacements: nextPlacements, pinned: nextPinned };
  }, [pinnedRefForMovableItem, pinnedRefs, sectionPlacements]);

  const removeItemFromCustomSection = useCallback((item: SidebarMovableItem) => {
    void updateSidebarOrder({ sectionPlacements: removeSidebarItemPlacement(sectionPlacements, item) });
  }, [sectionPlacements, updateSidebarOrder]);

  const createCustomSection = useCallback((value: { name: string; emoji: string | null }, moveItem?: SidebarMovableItem, insertBefore?: string) => {
    const id = crypto.randomUUID();
    const section: SidebarCustomSection = { id, name: value.name, emoji: value.emoji, sortMode: "manual" };
    void updateSidebarOrder(sidebarCreateSectionUpdate(
      { customSections, sectionOrder, sectionPlacements, pinned: pinnedRefs },
      section,
      { insertBefore, moveItem, moveItemRef: moveItem ? pinnedRefForMovableItem(moveItem) : null },
    ));
    // The section is saved now; step 2 only adds to it, so closing it there
    // still leaves the section in place.
    setSectionDialog({
      mode: "add",
      sectionId: id,
      sectionName: value.name,
      initialKeys: moveItem ? [sidebarSectionItemKey(moveItem.kind, moveItem.id)] : [],
    });
  }, [customSections, pinnedRefForMovableItem, pinnedRefs, sectionOrder, sectionPlacements, updateSidebarOrder]);


  const deleteCustomSection = useCallback((sectionId: string) => {
    void updateSidebarOrder({
      customSections: customSections.filter((section) => section.id !== sectionId),
      sectionOrder: sectionOrder.filter((id) => id !== sectionId),
      sectionPlacements: sectionPlacements.filter((placement) => placement.sectionId !== sectionId),
    });
    setSectionCtxMenu(null);
  }, [customSections, sectionOrder, sectionPlacements, updateSidebarOrder]);

  const togglePinChannel = useCallback((channelId: string) => {
    togglePinnedRef({ kind: "channel", id: channelId }, [{ kind: "channel", id: channelId }]);
  }, [togglePinnedRef]);

  const toggleChannelActivityMute = useCallback(async (channel: Channel) => {
    const outcome = await toggleSharedChannelActivityMute(channel);
    if (outcome.status !== "failed") return true;
    toast.error(outcome.activityMuted
      ? formatMessage({ id: "layout.sidebar.failedMuteActivity" })
      : formatMessage({ id: "layout.sidebar.failedUnmuteActivity" }));
    return false;
  }, [formatMessage]);

  const togglePinAgent = useCallback((agentId: string) => {
    const agentDm = dmChannels.find((dm) => dm.peerType === "agent" && dm.peerId === agentId);
    togglePinnedRef(
      { kind: "agent", id: agentId },
      [
        { kind: "agent", id: agentId },
        ...(agentDm ? [{ kind: "channel", id: agentDm.id } satisfies SidebarMovableItem] : []),
      ],
    );
  }, [dmChannels, togglePinnedRef]);

  const togglePinDm = useCallback((dm: Channel) => {
    const ref = pinnedRefForDmChannel(dm);
    if (!ref) return;
    togglePinnedRef(ref, [{ kind: "channel", id: dm.id }]);
  }, [togglePinnedRef]);

  const sidebarCollisionDetection = useCallback<CollisionDetection>((args) => {
    const activeId = String(args.active.id);
    const pointerX = args.pointerCoordinates?.x;
    const pointerY = args.pointerCoordinates?.y;
    if (sectionOrder.includes(activeId)) {
      const sectionCollisions = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => (
          sectionOrder.includes(String(container.id))
        )),
      });
      if (import.meta.env.VITE_E2E === "true" && isSidebarDndProbeEnabled()) {
        recordSidebarDndCollisionBranch({ branch: "section-sort", resultIds: sectionCollisions.map((collision) => String(collision.id)), x: pointerX, y: pointerY });
      }
      return sectionCollisions;
    }

    const validContainers = args.droppableContainers.filter((container) => {
      const data = container.data.current;
      if (!isSidebarDndData(data)) return false;
      return isValidSidebarDndDestination(activeId, data.containerId);
    });
    const collisionArgs = { ...args, droppableContainers: validContainers };
    const pointerCollisions = pointerWithin(collisionArgs);
    const itemCollision = pointerCollisions.find((collision) => {
      const container = validContainers.find((candidate) => candidate.id === collision.id);
      return (container?.data.current as SidebarDndData | undefined)?.type === "item";
    });
    const branchContext = () => ({
      validContainerIds: validContainers.map((container) => String(container.id)),
      rectIds: [...args.droppableRects.keys()].map(String),
      x: pointerX,
      y: pointerY,
    });
    if (itemCollision) {
      if (import.meta.env.VITE_E2E === "true" && isSidebarDndProbeEnabled()) {
        recordSidebarDndCollisionBranch({ branch: "pointer-item", resultIds: [String(itemCollision.id)], ...branchContext() });
      }
      return [itemCollision];
    }
    if (pointerCollisions.length > 0) {
      if (import.meta.env.VITE_E2E === "true" && isSidebarDndProbeEnabled()) {
        recordSidebarDndCollisionBranch({ branch: "pointer-container", resultIds: pointerCollisions.map((collision) => String(collision.id)), ...branchContext() });
      }
      // Over a section's drop zone but none of its rows (the 8px at its ends,
      // the 2px between two rows): place the row by the pointer, so the band
      // under the heading puts it first rather than last.
      const rows = args.droppableContainers.map((container) => ({
        data: container.data.current,
        rect: args.droppableRects.get(container.id),
      }));
      return pointerCollisions.map((collision) => ({
        ...collision,
        data: {
          ...collision.data,
          [SIDEBAR_DND_DROP_INDEX_KEY]: sidebarDndContainerDropIndex(String(collision.id), activeId, pointerY, rows),
        },
      }));
    }

    // Keyboard drags have no pointer, and a pointer outside the section list
    // (past the last section, off the sidebar, or beyond an auto-scrolling
    // edge) has no local target: snap to the nearest valid container.
    if (
      !args.pointerCoordinates
      || !isPointerWithinSidebarDndBounds(args.pointerCoordinates, args.droppableRects.values())
    ) {
      const boundsCollisions = closestCenter(collisionArgs);
      if (import.meta.env.VITE_E2E === "true" && isSidebarDndProbeEnabled()) {
        recordSidebarDndCollisionBranch({ branch: "bounds-closest-center", resultIds: boundsCollisions.map((collision) => String(collision.id)), ...branchContext() });
      }
      return boundsCollisions;
    }

    // Inside the list the pointer is over no valid destination: a gap between
    // sections, a section header, or a section this item may not enter (a
    // regular channel crossing Joint Channels). Keep the item where the live
    // projection already put it. Any geometry-based answer here (nearest valid
    // container, or the
    // drag-start container) feeds back into itself: the projection changes the
    // height of the containers the item leaves and enters, which moves the
    // pointer in or out of them, which flips the answer again. dnd-kit re-runs
    // collision detection on every remeasure, so that alternation loops without
    // pointer movement until React hits its update-depth guard (#185).
    const retainedContainerId = resolveSidebarDndRetainedContainer(
      sidebarDndProjectionRef.current,
      sidebarDndSnapshotRef.current,
      activeId,
    );
    const retainedCollisions = retainedContainerId ? [{ id: retainedContainerId }] : [];
    if (import.meta.env.VITE_E2E === "true" && isSidebarDndProbeEnabled()) {
      recordSidebarDndCollisionBranch({
        branch: retainedContainerId ? "retained" : "empty",
        resultIds: retainedCollisions.map((collision) => String(collision.id)),
        ...branchContext(),
      });
    }
    return retainedCollisions;
  }, [isValidSidebarDndDestination, sectionOrder]);

  const resetSidebarDnd = useCallback(() => {
    sidebarDndSnapshotRef.current = null;
    sidebarDndProjectionRef.current = null;
    setSidebarDndProjection(null);
    setSidebarDndActiveId(null);
    setSidebarDndSourceContainerId(null);
  }, []);

  const handleSidebarDragStart = useCallback(({ active }: DragStartEvent) => {
    // On a touch screen the long press that armed the drag has opened the
    // row's or the section header's menu; picking it up closes them.
    closeCtx();
    closeSectionCtx();
    if (channelRowsDisplayOnlyRef.current) {
      resetSidebarDnd();
      return;
    }
    const data = active.data.current as SidebarDndData | undefined;
    if (data?.type !== "item") {
      resetSidebarDnd();
      return;
    }
    sidebarDndSnapshotRef.current = sidebarDndBaseProjection;
    sidebarDndProjectionRef.current = sidebarDndBaseProjection;
    setSidebarDndProjection(sidebarDndBaseProjection);
    setSidebarDndActiveId(data.itemId);
    setSidebarDndSourceContainerId(findSidebarDndContainer(sidebarDndBaseProjection, data.itemId));
  }, [closeCtx, closeSectionCtx, resetSidebarDnd, sidebarDndBaseProjection]);

  const projectSidebarDndOver = useCallback((
    active: DragOverEvent["active"],
    over: NonNullable<DragOverEvent["over"]>,
    current: SidebarDndProjection,
    containerDropIndex: number | null,
  ): SidebarDndProjection => {
    const activeData = active.data.current;
    const overData = over.data.current;
    if (
      !isSidebarDndData(activeData)
      || activeData.type !== "item"
      || !isSidebarDndData(overData)
    ) return current;
    if (!isValidSidebarDndDestination(activeData.itemId, overData.containerId)) return current;
    const destinationItems = current[overData.containerId];
    if (!destinationItems) return current;

    let destinationIndex = containerDropIndex ?? destinationItems.length;
    if (overData.type === "item" && overData.itemId !== activeData.itemId) {
      const itemsWithoutActive = destinationItems.filter((itemId) => itemId !== activeData.itemId);
      const overIndex = itemsWithoutActive.indexOf(overData.itemId);
      if (overIndex === -1) return current;
      const activeRect = active.rect.current.translated ?? active.rect.current.initial;
      const edge = getSidebarDropIndicatorEdge(
        activeRect ? activeRect.top + activeRect.height / 2 : over.rect.top,
        over.rect.top + over.rect.height / 2,
      );
      destinationIndex = overIndex + (edge === "after" ? 1 : 0);
    } else if (overData.type === "item") {
      return current;
    } else if (destinationItems.includes(activeData.itemId)) {
      // Container-level hover of the container that already holds the item
      // (including the retained-container collision above) keeps its slot.
      return current;
    }

    return moveSidebarDndItem(
      current,
      activeData.itemId,
      overData.containerId,
      destinationIndex,
    );
  }, [isValidSidebarDndDestination]);

  const handleSidebarDragOver = useCallback(({ active, over, collisions }: DragOverEvent) => {
    if (!over) return;
    const current = sidebarDndProjectionRef.current ?? sidebarDndBaseProjection;
    const next = projectSidebarDndOver(active, over, current, sidebarDndCollisionDropIndex(collisions, over.id));
    if (next === current) return;
    sidebarDndProjectionRef.current = next;
    setSidebarDndProjection(next);
  }, [projectSidebarDndOver, sidebarDndBaseProjection]);

  const handleSidebarDragEnd = useCallback(({ active, over, collisions }: DragEndEvent) => {
    if (channelRowsDisplayOnlyRef.current) {
      resetSidebarDnd();
      return;
    }
    const activeId = String(active.id);
    if (over && sectionOrder.includes(activeId) && sectionOrder.includes(String(over.id))) {
      const overId = String(over.id);
      const nextOrder = reorderSidebarSectionOrder(sectionOrder, activeId, overId);
      if (nextOrder !== sectionOrder) void updateSidebarOrder({ sectionOrder: nextOrder });
      resetSidebarDnd();
      return;
    }

    const snapshot = sidebarDndSnapshotRef.current;
    const currentProjection = sidebarDndProjectionRef.current;
    const projection = over && currentProjection
      ? projectSidebarDndOver(active, over, currentProjection, sidebarDndCollisionDropIndex(collisions, over.id))
      : currentProjection;
    const sourceContainerId = snapshot ? findSidebarDndContainer(snapshot, activeId) : null;
    const destinationContainerId = projection ? findSidebarDndContainer(projection, activeId) : null;
    resetSidebarDnd();
    if (
      !over
      || !snapshot
      || !projection
      || !sourceContainerId
      || !destinationContainerId
      || !isValidSidebarDndDestination(activeId, destinationContainerId)
    ) {
      return;
    }

    const movableItem = resolveMovableItemFromDragId(activeId);
    if (!movableItem) return;

    if (destinationContainerId === SIDEBAR_PINNED_CONTAINER_ID) {
      const seen = new Set<string>();
      const nextPinned = projection[SIDEBAR_PINNED_CONTAINER_ID]
        .map(resolvePinnedRefFromDragId)
        .filter((ref): ref is SidebarPinnedRef => {
          if (!ref) return false;
          const key = sidebarPinnedRefKey(ref);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      void updateSidebarOrder({
        pinned: nextPinned,
        sectionPlacements: removeSidebarItemPlacement(sectionPlacements, movableItem),
      });
      return;
    }

    const customSectionId = sidebarCustomSectionId(destinationContainerId);
    if (customSectionId) {
      const destinationIndex = projection[destinationContainerId].indexOf(activeId);
      const ref = resolvePinnedRefFromDragId(activeId);
      void updateSidebarOrder({
        sectionPlacements: moveSidebarItemToCustomSectionAtPosition(
          sectionPlacements,
          movableItem,
          customSectionId,
          destinationIndex,
        ),
        pinned: ref ? removeSidebarPinnedRef(pinnedRefs, ref) : pinnedRefs,
      });
      return;
    }

    const activeDefaultOrderId = getSidebarDndDefaultOrderId(activeId);
    if (!activeDefaultOrderId) return;
    const nextSubset = projection[destinationContainerId]
      .map(getSidebarDndDefaultOrderId)
      .filter((id): id is string => !!id);
    const previousSubset = [
      ...new Set([
        ...snapshot[destinationContainerId]
          .map(getSidebarDndDefaultOrderId)
          .filter((id): id is string => !!id),
        activeDefaultOrderId,
      ]),
    ];
    const ref = resolvePinnedRefFromDragId(activeId);
    const nextPlacements = removeSidebarItemPlacement(sectionPlacements, movableItem);
    const nextPinned = ref ? removeSidebarPinnedRef(pinnedRefs, ref) : pinnedRefs;

    if (destinationContainerId === SIDEBAR_DMS_CONTAINER_ID) {
      const nextOrder = replaceSidebarSubsetOrder(dmOrderIds, previousSubset, nextSubset);
      setDmOrderIds(nextOrder);
      void updateSidebarOrder({
        dmOrder: nextOrder,
        pinned: nextPinned,
        sectionPlacements: nextPlacements,
      });
      return;
    }
    const nextOrder = replaceSidebarSubsetOrder(channelOrderIds, previousSubset, nextSubset);
    setChannelOrderIds(nextOrder);
    void updateSidebarOrder({
      channelOrder: nextOrder.filter((id) => id !== allChannelId),
      pinned: nextPinned,
      sectionPlacements: nextPlacements,
    });
  }, [
    allChannelId,
    channelOrderIds,
    dmOrderIds,
    getSidebarDndDefaultOrderId,
    isValidSidebarDndDestination,
    pinnedRefs,
    resetSidebarDnd,
    resolveMovableItemFromDragId,
    resolvePinnedRefFromDragId,
    projectSidebarDndOver,
    sectionOrder,
    sectionPlacements,
    updateSidebarOrder,
  ]);
  // Stryker restore all
  return {
    togglePinnedRef, moveItemToPinned, moveItemToCustomSection, placementsForSectionChange,
    removeItemFromCustomSection, createCustomSection, deleteCustomSection, togglePinChannel,
    toggleChannelActivityMute, togglePinAgent, togglePinDm, sidebarCollisionDetection, resetSidebarDnd,
    handleSidebarDragStart, handleSidebarDragOver, handleSidebarDragEnd,
  };
}

export type SidebarDnd = ReturnType<typeof useSidebarDnd>;
