import { useMemo } from "react";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { hasSidebarPinnedRef } from "../../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../../utils/sidebarPinnedRefs";
import type { SidebarSectionItemKind } from "../../store/sidebarSections";
import { pinnedRefForDmChannel } from "../../features/sidebar/sidebarDisplayItems";
import type { MessageId } from "../../i18n/messages";
import { sidebarChannelHomeSectionKey, sidebarExternalSectionLabelId } from "../layout/sidebarChannelVisibility";

const NO_STALE_REFS: SidebarPinnedRef[] = [];

/**
 * How the sidebar models one conversation for Move to section: the item its
 * custom-section placement is keyed by, the ref it is pinned by, and the
 * home section it otherwise sits in.
 */
export interface ConversationSidebarSection {
  item: { kind: SidebarSectionItemKind; id: string };
  /** Null when the sidebar cannot pin it (a DM without a peer). */
  pinnedRef: SidebarPinnedRef | null;
  /**
   * Pins the sidebar does not show as this item's but that still hide it from
   * a custom section; every move drops them.
   */
  stalePinnedRefs: SidebarPinnedRef[];
  homeKey: string;
  homeLabelId: MessageId;
}

/**
 * The sidebar's model of a channel or a DM, as the sidebar itself resolves it:
 *
 * - a channel is the item and the pinned ref `channel:<id>`, at home in
 *   Channels, or Joint Channels / External;
 * - a DM is placed as `channel:<dm id>` and pinned by its peer
 *   (`pinnedRefForDmChannel`: `human:` / `agent:<peer id>`), at home in
 *   Direct Messages. An agent DM whose agent is pinned or placed is the agent
 *   item, as the sidebar row menu's Move to Section ▸ treats it
 *   (useSidebarMenuActions). A `channel:<dm id>` pin (what the old DM Pin
 *   switch wrote) is stale: the sidebar never shows it as Pinned, but it
 *   hides the DM from a custom section.
 */
export function useConversationSidebarSection(
  channelId: string,
  conversationKind: "channel" | "dm",
): ConversationSidebarSection {
  const channels = useChannelStore((s) => s.channels);
  const dm = useChannelStore((s) => (conversationKind === "dm" ? s.dmChannels.find((c) => c.id === channelId) ?? null : null));
  const pinned = useServerStore((s) => s.sidebarOrder.pinned);
  const sectionPlacements = useServerStore((s) => s.sidebarOrder.sectionPlacements);
  const externalChannelsEnabled = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;

  const channel = conversationKind === "channel" ? channels.find((c) => c.id === channelId) ?? null : null;
  const channelHomeKey = channel ? sidebarChannelHomeSectionKey(channel) : "system:channels";
  const channelHomeLabelId = channelHomeKey === "system:joint"
    ? sidebarExternalSectionLabelId(externalChannelsEnabled, channels)
    : "layout.sidebar.channels";

  const agentId = dm?.peerType === "agent" && dm.peerId ? dm.peerId : null;
  // Legacy fixtures and older payloads may omit these arrays.
  const agentIsItem = !!agentId && (
    hasSidebarPinnedRef(pinned ?? [], { kind: "agent", id: agentId })
    || (sectionPlacements ?? []).some((placement) => placement.kind === "agent" && placement.id === agentId)
  );

  return useMemo<ConversationSidebarSection>(() => {
    if (conversationKind === "channel") {
      const ref = { kind: "channel" as const, id: channelId };
      return { item: ref, pinnedRef: ref, stalePinnedRefs: NO_STALE_REFS, homeKey: channelHomeKey, homeLabelId: channelHomeLabelId };
    }
    return {
      item: agentIsItem && agentId ? { kind: "agent", id: agentId } : { kind: "channel", id: channelId },
      pinnedRef: dm ? pinnedRefForDmChannel(dm) : null,
      stalePinnedRefs: [{ kind: "channel", id: channelId }],
      homeKey: "system:dms",
      homeLabelId: "layout.sidebar.directMessages",
    };
  }, [agentId, agentIsItem, channelHomeKey, channelHomeLabelId, channelId, conversationKind, dm]);
}
