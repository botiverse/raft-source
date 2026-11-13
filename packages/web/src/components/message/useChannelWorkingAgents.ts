import { useMemo } from "react";
import { WORKING_ID_SEPARATOR } from "../../features/channel/chatPanelHelpers";
import { useAppearanceStore } from "../../store/appearanceStore";
import { useLiveAgentActivityStore } from "../../store/liveAgentActivityStore";
import type { LiveAgentActivityItem } from "../../utils/liveAgentActivity";

const NONE: LiveAgentActivityItem[] = [];

/**
 * The agents at work among a channel's members, in the order they started
 * (the live-activity store keeps that order), or nothing while the Live agent
 * activity setting is off. `agentIdKey` is the channel's agent ids joined by
 * WORKING_ID_SEPARATOR: a stable key, so the list re-filters only when the
 * roster or the activity changes.
 */
export function useChannelWorkingAgents(agentIdKey: string | undefined): LiveAgentActivityItem[] {
  // Without a channel key (a DM, a thread) nothing here reads the activity, so no activity update re-renders it.
  const items = useLiveAgentActivityStore((state) => (agentIdKey ? state.items : NONE));
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);
  return useMemo(() => {
    if (!visible || !agentIdKey || items.length === 0) return NONE;
    const ids = new Set(agentIdKey.split(WORKING_ID_SEPARATOR));
    return items.filter((item) => ids.has(item.agentId));
  }, [agentIdKey, items, visible]);
}
