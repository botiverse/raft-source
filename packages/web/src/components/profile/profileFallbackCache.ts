import type { Agent } from "../../store/agentStore";
import type { ChannelHuman } from "../../hooks/useChannelMembers";
import type { HumanProfile } from "../member/HumanDetailPanel";
import { registerServerReset } from "../../store/serverResetRegistry";

const agentProfileCache = new Map<string, Agent>();
const humanProfileCache = new Map<string, HumanProfile>();

// A person's profile names their servers in the channel it was opened from
// (`?channelId=`, #wg-rbac:#58), so the same person opened from two channels
// is two entries; "" is the profile opened from no channel.
function humanCacheKey(serverId: string, userId: string, channelId: string | null | undefined) {
  return `${serverId}:${channelId ?? ""}:${userId}`;
}

function agentCacheKey(viewerServerId: string, agentId: string) {
  return `${viewerServerId}:${agentId}`;
}

export function getCachedAgentProfile(viewerServerId: string | null | undefined, agentId: string): Agent | null {
  if (!viewerServerId) return null;
  return agentProfileCache.get(agentCacheKey(viewerServerId, agentId)) ?? null;
}

export function setCachedAgentProfile(viewerServerId: string | null | undefined, agent: Agent) {
  if (!viewerServerId) return;
  agentProfileCache.set(agentCacheKey(viewerServerId, agent.id), agent);
}

export function getCachedHumanProfile(serverId: string, userId: string, channelId?: string | null): HumanProfile | null {
  return humanProfileCache.get(humanCacheKey(serverId, userId, channelId)) ?? null;
}

export function setCachedHumanProfile(serverId: string, human: HumanProfile, channelId?: string | null) {
  humanProfileCache.set(humanCacheKey(serverId, human.userId, channelId), human);
}

/** The roster row of `channelId`, shown at once while that channel's profile loads. */
export function primeHumanProfileFromChannelMember(serverId: string, channelId: string, human: ChannelHuman) {
  setCachedHumanProfile(serverId, {
    userId: human.id,
    serverId: human.serverId,
    serverName: human.serverName,
    serverSlug: human.serverSlug,
    ...(human.servers ? { servers: human.servers } : {}),
    email: null,
    name: human.name,
    displayName: human.displayName,
    description: human.description,
    avatarUrl: human.avatarUrl,
    role: null,
    joinedAt: null,
    membershipStatus: "active",
    createdAgents: [],
  }, channelId);
}

registerServerReset(() => {
  agentProfileCache.clear();
  humanProfileCache.clear();
});
