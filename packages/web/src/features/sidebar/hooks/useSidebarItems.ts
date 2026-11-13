import { useEffect, useMemo } from "react";
import type { MessageId } from "../../../i18n/messages";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { buildAgentDmChannelByAgentId } from "../../../components/layout/agentDmProfileSource";
import { sortSidebarChannels, sortSidebarPinnedItems, sidebarDmLabel } from "../../../components/layout/sidebarSort";
import { filterSidebarChannelsByMembership, isSidebarExternalSectionChannel, sidebarExternalSectionLabelId } from "../../../components/layout/sidebarChannelVisibility";
import { agentLoungeSidebarEntry, loungeAgentDisplayName, useAgentLoungeEnabled } from "../../../components/agent/agentLounge";
import { sidebarPinnedRefKey } from "../../../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../../../utils/sidebarPinnedRefs";
import type { PinnedDisplayItem, CustomSectionDisplayItem, SidebarLoungeEntry } from "../sidebarDisplayItems";
import { orderByIds } from "../sidebarOrderIds";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarSync } from "./useSidebarSync";

const EMPTY_PINNED_REFS: SidebarPinnedRef[] = [];
/** A stable empty Lounge list for a store state written without the slice. */
const NO_LOUNGES: Channel[] = [];

/**
 * What each section lists: pinned refs and items, custom-section items, the
 * regular and joint channels after sort and membership filters, and the agent
 * DM and Lounge lookups.
 */
export function useSidebarItems(data: SidebarData, view: SidebarViewState, sync: SidebarSync) {
  const {
    dmChannels, channels, channelActivity, agents, sidebarOrder, customSections, sectionPlacements,
    externalChannelsEnabled, formatMessage,
  } = data;
  const {
    members, channelSortMode, jointChannelSortMode, dmSortMode, pinnedSortMode, joinedChannelsOnly,
  } = view;
  const { channelOrderIds, allChannelId } = sync;

  // Stryker disable all: typed-pinned projection is covered by dedicated DOM/source contracts and browser preview.
  const pinnedRefs = Array.isArray(sidebarOrder.pinned) ? sidebarOrder.pinned : EMPTY_PINNED_REFS;
  const pinnedChannelIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "channel").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedAgentIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "agent").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedHumanIdSet = useMemo(
    () => new Set(pinnedRefs.filter((ref) => ref.kind === "human").map((ref) => ref.id)),
    [pinnedRefs],
  );
  const pinnedChannelIds = useMemo(() => {
    const ids = pinnedRefs.filter((ref) => ref.kind === "channel").map((ref) => ref.id);
    for (const dm of dmChannels) {
      if (dm.peerType === "user" && dm.peerId && pinnedHumanIdSet.has(dm.peerId)) ids.push(dm.id);
      if (dm.peerType === "agent" && dm.peerId && pinnedAgentIdSet.has(dm.peerId)) ids.push(dm.id);
    }
    return ids;
  }, [dmChannels, pinnedAgentIdSet, pinnedHumanIdSet, pinnedRefs]);
  const pinnedAgentIds = useMemo(
    () => pinnedRefs.filter((ref) => ref.kind === "agent").map((ref) => ref.id),
    [pinnedRefs],
  );
  const customPlacedChannelIds = useMemo(
    () => new Set(sectionPlacements.filter((placement) => placement.kind === "channel").map((placement) => placement.id)),
    [sectionPlacements],
  );
  const customPlacedAgentIds = useMemo(
    () => new Set(sectionPlacements.filter((placement) => placement.kind === "agent").map((placement) => placement.id)),
    [sectionPlacements],
  );

  const activeChannels = useMemo(
    () => channels.filter((channel) => !channel.archivedAt),
    [channels],
  );
  const orderedRegularChannels = useMemo(
    () => sortSidebarChannels(
      orderByIds(activeChannels.filter((channel) => !isSidebarExternalSectionChannel(channel)), channelOrderIds),
      channelSortMode,
      channelActivity,
      allChannelId,
    ),
    [activeChannels, channelOrderIds, channelSortMode, channelActivity, allChannelId],
  );
  // Stryker disable all: memo/dependency wiring is rendered-DOM verified; membership behavior is mutation-tested in sidebarChannelVisibility.
  const visibleRegularChannels = useMemo(
    () => filterSidebarChannelsByMembership(orderedRegularChannels, joinedChannelsOnly),
    [orderedRegularChannels, joinedChannelsOnly],
  );
  const orderedJointChannels = useMemo(
    () => sortSidebarChannels(
      orderByIds(activeChannels.filter((channel) => isSidebarExternalSectionChannel(channel)), channelOrderIds),
      jointChannelSortMode,
      channelActivity,
    ),
    [activeChannels, channelOrderIds, jointChannelSortMode, channelActivity],
  );
  const jointSectionLabelId: MessageId = sidebarExternalSectionLabelId(externalChannelsEnabled, orderedJointChannels);
  const pinnedChannel = useMemo(
    () => visibleRegularChannels.find((channel) => channel.id === allChannelId && !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)) ?? null,
    [visibleRegularChannels, allChannelId, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const sortableChannels = useMemo(
    () => visibleRegularChannels.filter((channel) => channel.id !== allChannelId && !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)),
    [visibleRegularChannels, allChannelId, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const fallbackRegularChannels = useMemo(
    () => pinnedChannel ? [pinnedChannel, ...sortableChannels] : sortableChannels,
    [pinnedChannel, sortableChannels],
  );
  // Stryker restore all
  const sortableJointChannels = useMemo(
    () => orderedJointChannels.filter((channel) => !pinnedChannelIdSet.has(channel.id) && !customPlacedChannelIds.has(channel.id)),
    [orderedJointChannels, pinnedChannelIdSet, customPlacedChannelIds],
  );
  const channelManualSort = channelSortMode === "manual";
  const jointChannelManualSort = jointChannelSortMode === "manual";
  const dmManualSort = dmSortMode === "manual";
  const pinnedManualSort = pinnedSortMode === "manual";

  // Map agent ID → DM channel ID (for navigation + per-row unread subscription).
  // Unread itself is NOT computed here anymore — it lives in the <AgentDmRow>
  // leaf so this map stays stable across `message:new` churn.
  const agentDmChannelId = useMemo(() => {
    const channelId: Record<string, string> = {};
    for (const dm of dmChannels) {
      if (dm.peerType === "agent" && dm.peerId) {
        channelId[dm.peerId] = dm.id;
      }
    }
    return channelId;
  }, [dmChannels]);
  const agentDmChannelByAgentId = useMemo(() => {
    return buildAgentDmChannelByAgentId(dmChannels);
  }, [dmChannels]);
  // Agent Lounge v0: each agent's Lounge row the store holds, by agent.
  const loungeEnabled = useAgentLoungeEnabled();
  const loungeChannels = useChannelStore((s) => s.loungeChannels ?? NO_LOUNGES);
  const loungeByAgentId = useMemo(() => {
    const byAgent = new Map<string, Channel>();
    for (const lounge of loungeChannels) {
      if (lounge.loungeAgentId) byAgent.set(lounge.loungeAgentId, lounge);
    }
    return byAgent;
  }, [loungeChannels]);
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  // Agent Lounge v0: every Lounge the sidebar knows (the store's Lounge rows
  // and the summaries the agent DM rows carried), by its channel id. Each is
  // its own row: in Direct Messages while `listed`, in Pinned once pinned.
  // None while the flag is off or for a Guest.
  const loungeEntryById = useMemo(() => {
    const byId = new Map<string, SidebarLoungeEntry>();
    if (!loungeEnabled) return byId;
    const agentIds = new Set(loungeByAgentId.keys());
    for (const dm of dmChannels) {
      if (dm.peerType === "agent" && dm.peerId && dm.lounge) agentIds.add(dm.peerId);
    }
    for (const agentId of agentIds) {
      const dm = agentDmChannelByAgentId[agentId];
      const slice = loungeByAgentId.get(agentId);
      const channelId = slice?.id ?? dm?.lounge?.channelId;
      if (!channelId || slice?.archivedAt) continue;
      const summary = dm?.lounge?.channelId === channelId ? dm.lounge : undefined;
      const name = loungeAgentDisplayName(agentById.get(agentId), slice?.name ?? dm?.peerName ?? "");
      byId.set(channelId, {
        channelId,
        agentId,
        title: formatMessage({ id: "agent.lounge.title" }, { name }),
        channel: slice,
        createdAt: slice?.createdAt ?? dm?.createdAt ?? "",
        summaryUnread: summary?.unreadCount ?? 0,
        summaryMentioned: (summary?.mentionCount ?? 0) > 0,
        listed: agentLoungeSidebarEntry(dm?.lounge, slice) !== null,
      });
    }
    return byId;
  }, [agentById, agentDmChannelByAgentId, dmChannels, formatMessage, loungeByAgentId, loungeEnabled]);
  // A listed Lounge row only has the DM row's summary until the Lounge is
  // opened; its menu's Mute and the row's muted look need the channel itself,
  // so load each listed Lounge the store doesn't hold yet (once: ensureChannel
  // dedupes and keeps it in the Lounge slice).
  const missingLoungeIds = useMemo(
    () => [...loungeEntryById.values()].filter((lounge) => lounge.listed && !lounge.channel).map((lounge) => lounge.channelId).join(","),
    [loungeEntryById],
  );
  useEffect(() => {
    if (!missingLoungeIds) return;
    const { ensureChannel } = useChannelStore.getState();
    for (const channelId of missingLoungeIds.split(",")) void ensureChannel(channelId);
  }, [missingLoungeIds]);
  const dmContextPeerIds = useMemo(() => ({
    agentIds: new Set(agents.map((agent) => agent.id)),
    humanIds: new Set(members.map((member) => member.userId)),
  }), [agents, members]);

  const pinnedItems = useMemo(() => {
    const channelById = new Map(channels.filter((channel) => !channel.archivedAt).map((channel) => [channel.id, channel]));
    const humanDmByPeerId = new Map(dmChannels.filter((dm) => dm.peerType === "user" && dm.peerId).map((dm) => [dm.peerId!, dm]));
    const agentDmById = new Map(dmChannels.filter((dm) => dm.peerType === "agent" && dm.peerId).map((dm) => [dm.peerId!, dm]));
    const manualItems: PinnedDisplayItem[] = [];
    for (const ref of pinnedRefs) {
      const id = sidebarPinnedRefKey(ref);
      if (ref.kind === "channel") {
        const channel = channelById.get(ref.id);
        if (channel) {
          manualItems.push({ id, ref, type: "channel", channel, createdAt: channel.createdAt, lastMessageAt: channelActivity[channel.id], label: channel.name });
          continue;
        }
        // A Lounge is pinned as `channel:<lounge id>` but never in `channels`.
        const lounge = loungeEntryById.get(ref.id);
        if (lounge) manualItems.push({ id, ref, type: "lounge", lounge, createdAt: lounge.createdAt, lastMessageAt: channelActivity[lounge.channelId], label: lounge.title });
        continue;
      }
      if (ref.kind === "human") {
        const dm = humanDmByPeerId.get(ref.id);
        if (dm) manualItems.push({ id, ref, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm) });
        continue;
      }
      const agent = agentById.get(ref.id);
      if (agent) {
        const dmChannel = agentDmById.get(agent.id);
        manualItems.push({
          id,
          ref,
          type: "agent",
          agent,
          createdAt: dmChannel?.createdAt ?? agent.createdAt,
          lastMessageAt: dmChannel ? channelActivity[dmChannel.id] : undefined,
          label: agent.displayName || agent.name,
        });
        continue;
      }
      const dm = agentDmById.get(ref.id);
      if (dm) manualItems.push({ id, ref, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm) });
    }

    return sortSidebarPinnedItems(manualItems, pinnedSortMode);
  }, [pinnedRefs, channels, dmChannels, agentById, loungeEntryById, pinnedSortMode, channelActivity]);
  const pinnedDmIdSet = useMemo(
    () => new Set(pinnedItems.filter((item) => item.type === "dm").map((item) => item.dm.id)),
    [pinnedItems],
  );

  const customSectionItems = useMemo(() => {
    const channelById = new Map(channels.filter((channel) => !channel.archivedAt).map((channel) => [channel.id, channel]));
    const dmById = new Map(dmChannels.map((dm) => [dm.id, dm]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const result = new Map<string, CustomSectionDisplayItem[]>();
    for (const placement of [...sectionPlacements].sort((a, b) => a.position - b.position)) {
      const channel = channelById.get(placement.id);
      const dm = dmById.get(placement.id);
      const agent = agentById.get(placement.id);
      if (placement.kind === "channel" && (
        pinnedChannelIdSet.has(placement.id)
        || (dm?.peerType === "user" && !!dm.peerId && pinnedHumanIdSet.has(dm.peerId))
        || (dm?.peerType === "agent" && !!dm.peerId && pinnedAgentIdSet.has(dm.peerId))
      )) continue;
      if (placement.kind === "agent" && pinnedAgentIdSet.has(placement.id)) continue;
      let item: CustomSectionDisplayItem | null = null;
      if (dm) {
        item = { id: dm.id, type: "dm", dm, createdAt: dm.createdAt, lastMessageAt: channelActivity[dm.id], label: sidebarDmLabel(dm), placementKind: "channel" };
      } else if (channel) {
        item = { id: channel.id, type: "channel", channel, createdAt: channel.createdAt, lastMessageAt: channelActivity[channel.id], label: channel.name, placementKind: "channel" };
      } else if (agent) {
        const dmChannel = agentDmChannelByAgentId[agent.id];
        item = {
          id: agent.id,
          type: "agent",
          agent,
          createdAt: dmChannel?.createdAt ?? agent.createdAt,
          lastMessageAt: dmChannel ? channelActivity[dmChannel.id] : undefined,
          label: agent.displayName || agent.name,
          placementKind: "agent",
        };
      }
      if (!item) continue;
      const items = result.get(placement.sectionId) ?? [];
      items.push(item);
      result.set(placement.sectionId, items);
    }
    for (const section of customSections) {
      const items = result.get(section.id) ?? [];
      if (section.sortMode === "az") items.sort((a, b) => a.label.localeCompare(b.label));
      if (section.sortMode === "recent") items.sort((a, b) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt)));
      result.set(section.id, items);
    }
    return result;
  }, [agents, agentDmChannelByAgentId, channelActivity, channels, customSections, dmChannels, pinnedAgentIdSet, pinnedChannelIdSet, pinnedHumanIdSet, sectionPlacements]);

  return {
    pinnedRefs, pinnedChannelIdSet, pinnedAgentIdSet, pinnedHumanIdSet, pinnedChannelIds, pinnedAgentIds,
    customPlacedChannelIds, customPlacedAgentIds, activeChannels, visibleRegularChannels,
    orderedJointChannels, jointSectionLabelId, fallbackRegularChannels, sortableJointChannels,
    channelManualSort, jointChannelManualSort, dmManualSort, pinnedManualSort, agentDmChannelId,
    agentDmChannelByAgentId, loungeEnabled, loungeEntryById, agentById, dmContextPeerIds, pinnedItems,
    pinnedDmIdSet, customSectionItems,
  };
}

export type SidebarItems = ReturnType<typeof useSidebarItems>;
