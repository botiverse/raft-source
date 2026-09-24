import type { Agent } from "../../store/agentStore";
import type { Channel } from "../../store/channelStore";

export interface AgentDmProfileSource {
  displayName: string;
  description: string | null;
  avatarUrl: string | null;
}

type AgentProfileFallback = Pick<Agent, "displayName" | "name" | "description" | "avatarUrl">;
type AgentDmProfile = Pick<Channel, "peerDisplayName" | "peerName" | "peerDescription" | "peerAvatarUrl">;

export function buildAgentDmChannelByAgentId(dmChannels: Channel[]): Record<string, Channel> {
  const byAgentId: Record<string, Channel> = {};
  for (const dm of dmChannels) {
    if (dm.peerType === "agent" && dm.peerId) {
      byAgentId[dm.peerId] = dm;
    }
  }
  return byAgentId;
}

export function resolveAgentDmProfileSource(
  agent: AgentProfileFallback,
  dm: AgentDmProfile | undefined,
): AgentDmProfileSource {
  return {
    displayName: agent.displayName || agent.name,
    description: agent.description,
    // DM peer fields are discovery snapshots. Once the agent directory knows
    // this identity, profile mutations must flow from that one live source.
    avatarUrl: agent.avatarUrl ?? dm?.peerAvatarUrl ?? null,
  };
}
