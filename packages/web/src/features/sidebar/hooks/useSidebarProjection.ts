import { useState, useEffect, useLayoutEffect, useMemo } from "react";
import type { Channel } from "../../../store/channelStore";
import type { Agent } from "../../../store/agentStore";
import { useShallow } from "zustand/react/shallow";
import { useMessageStore } from "../../../store/messageStore";
import { sortSidebarDms, sortSidebarItems, sidebarDmLabel } from "../../../components/layout/sidebarSort";
import { isSidebarExternalSectionChannel } from "../../../components/layout/sidebarChannelVisibility";
import { hasUnmutedUnread } from "../../../utils/channelUnreadIndicator";
import { centeredSidebarScrollTop, conversationFromPathname, implicitSidebarFocusRequest, isSidebarDisclosureRestoreState, nearestSidebarScrollTop, readSidebarChannelFocusRequest } from "../../../components/layout/sidebarChannelFocus";
import type { SidebarChannelFocusRequest } from "../../../components/layout/sidebarChannelFocus";
import { sidebarCustomContainerId, SIDEBAR_CHANNELS_CONTAINER_ID, SIDEBAR_DMS_CONTAINER_ID, SIDEBAR_JOINT_CHANNELS_CONTAINER_ID, SIDEBAR_PINNED_CONTAINER_ID } from "../../../components/layout/sidebarDnd";
import { writeSidebarSectionRowCounts } from "../../../components/layout/sidebarSectionRowCounts";
import type { SidebarDndProjection } from "../../../components/layout/sidebarDnd";
import type { CustomSectionDisplayItem, SidebarDndDisplayItem, SidebarLoungeEntry } from "../sidebarDisplayItems";
import { orderByIds } from "../sidebarOrderIds";
import { channelDragId, agentDragId } from "../dnd/sidebarDragIds";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarSync } from "./useSidebarSync";
import type { SidebarItems } from "./useSidebarItems";

/** A row of the Direct Messages section: a DM, or an Agent Lounge (v0). */
type DmSectionRow =
  | { kind: "dm"; id: string; createdAt: string; dm: Channel }
  | { kind: "lounge"; id: string; createdAt: string; lounge: SidebarLoungeEntry };

/** A Lounge as the section unread dot reads it (its mute from the row the store holds). */
function loungeUnreadChannel(lounge: SidebarLoungeEntry) {
  return { id: lounge.channelId, activityMuted: lounge.channel?.activityMuted };
}

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * The route's reveal of the active conversation, the per-section unread flags,
 * the DM list, the drag projection and the remembered row counts.
 */
export function useSidebarProjection(data: SidebarData, view: SidebarViewState, sync: SidebarSync, items: SidebarItems) {
  const {
    dmChannels, channelsLoading, dmsLoading, channelActivity, serverId, sidebarOrderLoaded, rowCountUserId,
    customSections, location, sidebarScrollRef, handledSidebarFocusLocationKeyRef, sidebarRowLimit,
  } = data;
  const {
    setCollapsedCustomSections, collapsedCustomSections, showChatRail, collapsed, setCollapsed, dmSortMode,
  } = view;
  const { closedDmIds, dmOrderIds } = sync;
  const {
    pinnedChannelIdSet, pinnedAgentIdSet, pinnedHumanIdSet, customPlacedChannelIds, customPlacedAgentIds,
    activeChannels, visibleRegularChannels, fallbackRegularChannels, sortableJointChannels,
    agentDmChannelByAgentId, pinnedItems, pinnedDmIdSet, customSectionItems, loungeEntryById,
  } = items;

  // Reveal the active conversation in the sidebar (task #125). Two sources:
  //  - an explicit one-shot request carried in route state (search "Open"):
  //    centre the row;
  //  - the route change itself: whenever the active channel / DM changes after
  //    mount, bring its row into view ("nearest" — no scroll if it is already
  //    visible), so ⌘K, deep links, mention clicks and
  //    notifications all land with the sidebar showing where you are. Tracked
  //    per location.key with React's adjust-state-during-render so the
  //    follow-up render after a section expands still sees the same request;
  //    the first render is never a navigation.
  const explicitSidebarFocusRequest = readSidebarChannelFocusRequest(location.state);
  const [sidebarRouteTrack, setSidebarRouteTrack] = useState<{
    key: string;
    pathname: string;
    implicit: SidebarChannelFocusRequest | null;
  }>(() => ({ key: location.key, pathname: location.pathname, implicit: null }));
  if (sidebarRouteTrack.key !== location.key) {
    setSidebarRouteTrack({
      key: location.key,
      pathname: location.pathname,
      // A Chat-root redirect restores the page the user left; like the route
      // auto-expand above, it is not a navigation and reveals nothing.
      implicit: isSidebarDisclosureRestoreState(location.state)
        ? null
        : implicitSidebarFocusRequest(sidebarRouteTrack.pathname, location.pathname),
    });
  }
  const routeConversation = conversationFromPathname(location.pathname);
  // An explicit request only counts for the conversation the route actually
  // shows; a stale or mismatched state falls back to the route's own reveal.
  const sidebarChannelFocusRequest =
    explicitSidebarFocusRequest
    && routeConversation
    && explicitSidebarFocusRequest.kind === routeConversation.kind
    && explicitSidebarFocusRequest.id === routeConversation.id
      ? explicitSidebarFocusRequest
      : sidebarRouteTrack.key === location.key
        ? sidebarRouteTrack.implicit
        : null;
  useLayoutEffect(() => {
    if (
      !showChatRail
      || !sidebarChannelFocusRequest
      || handledSidebarFocusLocationKeyRef.current === location.key
    ) {
      return;
    }
    const shown = conversationFromPathname(location.pathname);
    if (!shown || shown.kind !== sidebarChannelFocusRequest.kind || shown.id !== sidebarChannelFocusRequest.id) return;

    // Which disclosure owns the row — resolved from the SAME data the sidebar
    // renders from, in render precedence: pinned → a custom section → joint /
    // regular channels → the Direct Messages section (whose disclosure reuses
    // `agents`; every non-pinned, non-custom DM lives there, human or agent).
    // Guessing from the conversation's type is wrong (a pinned human DM is in
    // `pinned`, a placed channel is in its custom section).
    type Owner = { builtin: keyof typeof collapsed } | { custom: string };
    let owner: Owner | null = null;
    const customOwnerOf = (match: (item: CustomSectionDisplayItem) => boolean): Owner | null => {
      for (const [sectionId, items] of customSectionItems) {
        if (items.some(match)) return { custom: sectionId };
      }
      return null;
    };
    const targetId = sidebarChannelFocusRequest.id;
    if (sidebarChannelFocusRequest.kind === "channel") {
      const targetChannel = activeChannels.find((channel) => channel.id === targetId);
      if (!targetChannel) return;
      owner = pinnedChannelIdSet.has(targetId)
        ? { builtin: "pinned" }
        : customOwnerOf((item) => item.type === "channel" && item.channel.id === targetId)
          ?? (isSidebarExternalSectionChannel(targetChannel)
            ? { builtin: "jointChannels" }
            : visibleRegularChannels.some((channel) => channel.id === targetId)
              ? { builtin: "channels" }
              : null);
    } else {
      const dm = dmChannels.find((candidate) => candidate.id === targetId);
      if (!dm) return;
      owner = pinnedDmIdSet.has(targetId)
        ? { builtin: "pinned" }
        : customOwnerOf((item) =>
          (item.type === "dm" && item.dm.id === targetId)
          || (item.type === "agent" && agentDmChannelByAgentId[item.agent.id]?.id === targetId))
          ?? { builtin: "agents" };
    }

    if (!owner) {
      handledSidebarFocusLocationKeyRef.current = location.key;
      return;
    }

    const ownerCollapsed = "custom" in owner
      ? collapsedCustomSections[owner.custom] === true
      : collapsed[owner.builtin];
    if (ownerCollapsed) {
      // A reveal — explicit or implied by the navigation — may open the owning
      // section transiently (it never writes the user's disclosure preference;
      // only a header click does). The route auto-expand above only opens
      // `channels`, so pinned / joint / custom sections and DMs depend on this.
      // The first render and the Chat-root restore redirect never get here:
      // they produce no request.
      if ("custom" in owner) {
        const sectionId = owner.custom;
        // oxlint-disable-next-line react-doctor/no-chain-state-updates -- the follow-up render is required before the row exists to measure.
        setCollapsedCustomSections((previous) => ({ ...previous, [sectionId]: false }));
      } else {
        const key = owner.builtin;
        // oxlint-disable-next-line react-doctor/no-chain-state-updates -- the follow-up render is required before the row exists to measure.
        setCollapsed((previous) => ({ ...previous, [key]: false }));
      }
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const scroller = sidebarScrollRef.current;
      if (!scroller) return;
      const row = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-sidebar-channel-id]"),
      ).find((candidate) => (
        candidate.dataset.sidebarChannelId === sidebarChannelFocusRequest.id
      ));
      // Right after a server opens, a long section mounts its first rows only
      // (useStagedSidebarRows): wait for the rest rather than give up on the reveal.
      if (!row && sidebarRowLimit !== Infinity) return;
      // A row inside a hidden container has no geometry; never scroll to a zero rect.
      if (!row || row.closest("[hidden]")) {
        handledSidebarFocusLocationKeyRef.current = location.key;
        return;
      }

      const viewportRect = scroller.getBoundingClientRect();
      const itemRect = row.getBoundingClientRect();
      const geometry = {
        currentScrollTop: scroller.scrollTop,
        itemHeight: itemRect.height,
        itemTop: itemRect.top,
        viewportHeight: scroller.clientHeight,
        viewportTop: viewportRect.top,
      };
      const top = sidebarChannelFocusRequest.align === "center"
        ? centeredSidebarScrollTop(geometry)
        : nearestSidebarScrollTop(geometry);
      if (top !== null) scroller.scrollTo({ top, behavior: "auto" });
      handledSidebarFocusLocationKeyRef.current = location.key;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeChannels,
    agentDmChannelByAgentId,
    collapsed,
    sidebarRowLimit,
    collapsedCustomSections,
    customSectionItems,
    dmChannels,
    location.key,
    location.pathname,
    pinnedChannelIdSet,
    pinnedDmIdSet,
    showChatRail,
    sidebarChannelFocusRequest,
    visibleRegularChannels,
  ]);

  // Agent Lounge v0: the Lounges with their own row in Direct Messages:
  // joined or mentioned there (`listed`), not pinned, and not closed (its id in
  // `hiddenDmIds`, as a closed DM's), unless it has unread or a mention for you
  // now: shown again then, the way a closed DM is (display only; opening it
  // or posting there takes it off `hiddenDmIds`). Narrowed to the ids of
  // closed Lounges with unread, so a message elsewhere does not re-render the
  // parent.
  const closedLoungeUnreadIds = useMessageStore(
    useShallow((s) => [...loungeEntryById.values()]
      .filter((lounge) => {
        if (!closedDmIds.has(lounge.channelId)) return false;
        const liveUnread = s.unreadCounts[lounge.channelId];
        const unread = liveUnread ?? lounge.summaryUnread;
        const mentioned = s.mentionFlags[lounge.channelId] === true || (liveUnread === undefined && lounge.summaryMentioned);
        return unread > 0 || mentioned;
      })
      .map((lounge) => lounge.channelId)),
  );
  const dmSectionLounges = useMemo(() => {
    const back = new Set(closedLoungeUnreadIds);
    return [...loungeEntryById.values()].filter((lounge) => (
      lounge.listed
      && !pinnedChannelIdSet.has(lounge.channelId)
      && (!closedDmIds.has(lounge.channelId) || back.has(lounge.channelId))
    ));
  }, [closedDmIds, closedLoungeUnreadIds, loungeEntryById, pinnedChannelIdSet]);

  // Narrowed unread aggregates. These subscribe to `unreadCounts` but collapse
  // it to 4 booleans (one per collapsible section) so the parent re-renders ONLY
  // when a section's "has unread" state flips — not on every inbound message.
  const unreadFlags = useMessageStore(
    useShallow((s) => {
      const has = (...unreadChannels: Array<Pick<Channel, "id" | "activityMuted"> | undefined>) => (
        hasUnmutedUnread(s.unreadCounts, unreadChannels)
      );
      return {
        pinned: pinnedItems.some((item) => {
          if (item.type === "channel") return has(item.channel);
          if (item.type === "dm") return has(item.dm);
          if (item.type === "lounge") return has(loungeUnreadChannel(item.lounge));
          return has(agentDmChannelByAgentId[item.agent.id]);
        }),
        joint: has(...sortableJointChannels),
        // Stryker disable next-line MethodExpression,ArrowFunction: collapsed unread chrome follows the browser-visible filtered list; store selector mutation is outside this task's domain seam.
        channels: has(...fallbackRegularChannels),
        dms: has(...dmChannels.filter(
          (dm) =>
            !pinnedDmIdSet.has(dm.id) &&
            !(dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) &&
            !(dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) &&
            !customPlacedChannelIds.has(dm.id) &&
            !(dm.peerType === "agent" && dm.peerId && customPlacedAgentIds.has(dm.peerId)),
        )) || has(...dmSectionLounges.map(loungeUnreadChannel)),
      };
    }),
  );
  const customUnreadSectionIds = useMessageStore(
    useShallow((state) => [...customSectionItems.entries()]
      .filter(([, items]) => items.some((item) => {
        const unreadChannel = item.type === "channel" ? item.channel
          : item.type === "dm" ? item.dm
            : agentDmChannelByAgentId[item.agent.id];
        return hasUnmutedUnread(state.unreadCounts, [unreadChannel]);
      }))
      .map(([sectionId]) => sectionId)),
  );
  const customUnreadSectionIdSet = useMemo(() => new Set(customUnreadSectionIds), [customUnreadSectionIds]);
  // Closed DMs that currently have unread must stay visible (auto-reopen on a
  // new message). Narrowed to the id list so a message to an already-visible DM
  // does not re-render the parent — only a closed→unread transition does.
  const closedDmUnreadIds = useMessageStore(
    useShallow((s) =>
      dmChannels
        .filter((dm) => closedDmIds.has(dm.id) && (s.unreadCounts[dm.id] || 0) > 0)
        .map((dm) => dm.id),
    ),
  );
  const closedDmUnreadSet = useMemo(() => new Set(closedDmUnreadIds), [closedDmUnreadIds]);

  const orderedDms = useMemo(() => {
    const visibleDmSet = new Set(
      dmChannels
        .filter((dm) =>
          (!closedDmIds.has(dm.id) || closedDmUnreadSet.has(dm.id)) &&
          !(dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) &&
          !(dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) &&
          !pinnedDmIdSet.has(dm.id) &&
          !customPlacedChannelIds.has(dm.id) &&
          !(dm.peerType === "agent" && dm.peerId && customPlacedAgentIds.has(dm.peerId))
        )
        .map((dm) => dm.id),
    );
    return sortSidebarDms(
      orderByIds(dmChannels, dmOrderIds),
      dmSortMode,
      channelActivity,
    ).filter((dm) => visibleDmSet.has(dm.id));
  }, [
    channelActivity,
    closedDmIds,
    closedDmUnreadSet,
    customPlacedAgentIds,
    customPlacedChannelIds,
    dmChannels,
    dmOrderIds,
    dmSortMode,
    pinnedAgentIdSet,
    pinnedDmIdSet,
    pinnedHumanIdSet,
  ]);

  // The Direct Messages rows: the DMs and the Lounges, sorted together by the
  // section's mode. Manual order is the DMs' own (a Lounge row is not
  // draggable): the Lounges follow them, latest activity first.
  const dmSectionRows = useMemo<DmSectionRow[]>(() => {
    const dmRows: DmSectionRow[] = orderedDms.map((dm) => ({ kind: "dm", id: dm.id, createdAt: dm.createdAt, dm }));
    if (dmSectionLounges.length === 0) return dmRows;
    const loungeRows: DmSectionRow[] = dmSectionLounges.map((lounge) => ({ kind: "lounge", id: lounge.channelId, createdAt: lounge.createdAt, lounge }));
    const label = (row: DmSectionRow) => (row.kind === "dm" ? sidebarDmLabel(row.dm) : row.lounge.title);
    const activity = (row: DmSectionRow) => channelActivity[row.id];
    if (dmSortMode === "manual") return [...dmRows, ...sortSidebarItems(loungeRows, "recent", label, activity)];
    return sortSidebarItems([...dmRows, ...loungeRows], dmSortMode, label, activity);
  }, [channelActivity, dmSectionLounges, dmSortMode, orderedDms]);

  const sidebarDndDisplayItems = useMemo(() => {
    const items = new Map<string, SidebarDndDisplayItem>();
    const addChannel = (channel: Channel) => {
      items.set(channelDragId(channel.id), { type: "channel", channel, label: channel.name });
    };
    const addDm = (dm: Channel) => {
      items.set(channelDragId(dm.id), { type: "dm", dm, label: sidebarDmLabel(dm) });
    };
    const addAgent = (agent: Agent) => {
      items.set(agentDragId(agent.id), { type: "agent", agent, label: agent.displayName || agent.name });
    };
    const addLounge = (lounge: SidebarLoungeEntry) => {
      items.set(channelDragId(lounge.channelId), { type: "lounge", lounge, label: lounge.title });
    };

    for (const item of pinnedItems) {
      if (item.type === "channel") addChannel(item.channel);
      else if (item.type === "dm") addDm(item.dm);
      else if (item.type === "lounge") addLounge(item.lounge);
      else addAgent(item.agent);
    }
    for (const sectionItems of customSectionItems.values()) {
      for (const item of sectionItems) {
        if (item.type === "channel") addChannel(item.channel);
        else if (item.type === "dm") addDm(item.dm);
        else addAgent(item.agent);
      }
    }
    for (const channel of fallbackRegularChannels) addChannel(channel);
    for (const channel of sortableJointChannels) addChannel(channel);
    for (const row of dmSectionRows) {
      if (row.kind === "dm") addDm(row.dm);
      else addLounge(row.lounge);
    }
    return items;
  }, [
    customSectionItems,
    dmSectionRows,
    fallbackRegularChannels,
    pinnedItems,
    sortableJointChannels,
  ]);

  const sidebarDndBaseProjection = useMemo<SidebarDndProjection>(() => {
    const projection: SidebarDndProjection = {
      [SIDEBAR_PINNED_CONTAINER_ID]: pinnedItems.map((item) => (
        item.type === "agent" ? agentDragId(item.agent.id)
          : item.type === "dm" ? channelDragId(item.dm.id)
            : item.type === "lounge" ? channelDragId(item.lounge.channelId)
              : channelDragId(item.channel.id)
      )),
      [SIDEBAR_JOINT_CHANNELS_CONTAINER_ID]: sortableJointChannels.map((channel) => channelDragId(channel.id)),
      [SIDEBAR_CHANNELS_CONTAINER_ID]: fallbackRegularChannels.map((channel) => channelDragId(channel.id)),
      [SIDEBAR_DMS_CONTAINER_ID]: dmSectionRows.map((row) => channelDragId(row.id)),
    };
    for (const section of customSections) {
      projection[sidebarCustomContainerId(section.id)] = (customSectionItems.get(section.id) ?? []).map((item) => (
        item.type === "agent" ? agentDragId(item.agent.id)
          : item.type === "dm" ? channelDragId(item.dm.id)
            : channelDragId(item.channel.id)
      ));
    }
    return projection;
  }, [
    customSectionItems,
    customSections,
    dmSectionRows,
    fallbackRegularChannels,
    pinnedItems,
    sortableJointChannels,
  ]);
  // The live projection during a drag is `data.sidebarDndProjectionStore`,
  // read by each section for its own container (SidebarDndProjectedItems /
  // SidebarDndProjectedCount), never here: a move doesn't render the Sidebar.

  // Remember each section's rows once everything they are built from is read
  // (the drag-free projection, so a drag in flight never counts).
  const sidebarRowCountsSettled = sidebarOrderLoaded && !channelsLoading && !dmsLoading;
  const pinnedRowCount = sidebarDndBaseProjection[SIDEBAR_PINNED_CONTAINER_ID].length;
  const jointChannelRowCount = sidebarDndBaseProjection[SIDEBAR_JOINT_CHANNELS_CONTAINER_ID].length;
  const channelRowCount = sidebarDndBaseProjection[SIDEBAR_CHANNELS_CONTAINER_ID].length;
  const dmRowCount = sidebarDndBaseProjection[SIDEBAR_DMS_CONTAINER_ID].length;
  useEffect(() => {
    if (!sidebarRowCountsSettled) return;
    writeSidebarSectionRowCounts(rowCountUserId, serverId, {
      pinned: pinnedRowCount,
      jointChannels: jointChannelRowCount,
      channels: channelRowCount,
      dms: dmRowCount,
    });
  }, [sidebarRowCountsSettled, rowCountUserId, serverId, pinnedRowCount, jointChannelRowCount, channelRowCount, dmRowCount]);
  return {
    unreadFlags, customUnreadSectionIdSet, sidebarDndDisplayItems, sidebarDndBaseProjection,
  };
}

export type SidebarProjection = ReturnType<typeof useSidebarProjection>;
