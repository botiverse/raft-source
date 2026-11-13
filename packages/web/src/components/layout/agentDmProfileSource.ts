import type { Agent } from "../../store/agentStore";
import type { Channel } from "../../store/channelStore";

export interface AgentDmProfileSource {
  displayName: string;
  description: string | null;
  avatarUrl: string | null;
}

type AgentProfileFallback = Pick<Agent, "displayName" | "name" | "description" | "avatarUrl">;

export function buildAgentDmChannelByAgentId(dmChannels: Channel[]): Record<string, Channel> {
  const byAgentId: Record<string, Channel> = {};
  for (const dm of dmChannels) {
    if (dm.peerType === "agent" && dm.peerId) {
      byAgentId[dm.peerId] = dm;
    }
  }
  return byAgentId;
}

export function resolveAgentDmProfileSource(agent: AgentProfileFallback): AgentDmProfileSource {
  return {
    displayName: agent.displayName || agent.name,
    description: agent.description,
    // DM peer fields are discovery snapshots. Once the agent directory knows
    // this identity, profile mutations must flow from that one live source.
    // A null avatar is the default avatar, not "unknown": falling back to the
    // snapshot here kept showing the old avatar after a reset until reload.
    avatarUrl: agent.avatarUrl,
  };
}
