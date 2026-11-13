import { useAgentContextViewStore } from "../../store/agentContextViewStore";

/**
 * Whether the agent section (a message's context view, View Context,
 * AgentContextViewSection) is open beside this channel on a desktop. A phone
 * shows it as a page of its own instead.
 */
export function useAgentSideSectionOpen(channelId: string | null, phoneLayout: boolean): boolean {
  const context = useAgentContextViewStore((s) => s.open?.hostChannelId === channelId);
  return context && !phoneLayout;
}
