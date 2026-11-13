/**
 * Shared (joint) channel member list, computed joint membership (cindyz
 * 2026-11-04, #wg-rbac:fc8d488f): the
 * server marks each row `inViewerServer`, and the list groups by it -
 * members of the viewed server (any role, guests too) apart from everyone
 * else, people before agents in each group. A person's tags are their
 * sources other than the viewed server (the server filters them). Without
 * the field the list keeps its Humans and Agents sections.
 */
import type { ServerRole } from "@botiverse/raft-shared";
import type { ChannelAgent, ChannelHuman } from "../../hooks/useChannelMembers";
import { LOCAL_MEMBER_ORIGIN, memberOrigin } from "../../utils/memberOrigin";
import type { MemberOrigin, MemberOriginSource } from "../../utils/memberOrigin";

export interface ViewerServerGroup {
  inViewerServer: boolean;
  humans: ChannelHuman[];
  agents: ChannelAgent[];
}

/** Whether this roster is grouped by the viewed server (computed joint rows carry `inViewerServer`). */
export function groupsByViewerServer(channelType: string | undefined, humans: readonly ChannelHuman[], agents: readonly ChannelAgent[]): boolean {
  return channelType === "joint"
    && (humans.some((human) => human.inViewerServer !== undefined) || agents.some((agent) => agent.inViewerServer !== undefined));
}

/** The two groups, viewed server first; an empty group is left out. */
export function splitByViewerServer(humans: readonly ChannelHuman[], agents: readonly ChannelAgent[]): ViewerServerGroup[] {
  return [true, false].map((inViewerServer) => ({
    inViewerServer,
    humans: humans.filter((human) => (human.inViewerServer === true) === inViewerServer),
    agents: agents.filter((agent) => (agent.inViewerServer === true) === inViewerServer),
  })).filter((group) => group.humans.length + group.agents.length > 0);
}

/** Whether a joint roster row is a person of the viewed server: `inViewerServer` when the server sent it, else the row's own server. */
function isViewerServerRow(human: Pick<ChannelHuman, "serverId" | "inViewerServer">, viewerServerId: string | null | undefined): boolean {
  if (human.inViewerServer !== undefined) return human.inViewerServer;
  return !viewerServerId || !human.serverId || human.serverId === viewerServerId;
}

/**
 * The role a roster row is tagged with: the one the server sent
 * (`effectiveChannelRole`, else `role`). A Guest label is a fact of the viewed
 * server only (P3, #wg-rbac:#25): the host's Guest in a joint channel reads to
 * other servers as a plain member "from <host>", and the server sends them no
 * role. So a joint row from another server never shows Guest, whatever its
 * fields say; nothing else (sources, tags, binding) ever makes one.
 */
export function rosterRoleTag(
  human: Pick<ChannelHuman, "effectiveChannelRole" | "role" | "serverId" | "inViewerServer">,
  channel: { type?: string; serverId?: string | null } | null | undefined,
): ServerRole | null {
  const role = human.effectiveChannelRole ?? human.role;
  if (role === "guest" && channel?.type === "joint" && !isViewerServerRow(human, channel.serverId)) return "member";
  return role;
}

/**
 * Where a roster row is from, seen from the channel's server (#wg-rbac:#46):
 * someone from another server carries that server's tile on the avatar and its
 * name after theirs. Only a joint channel has such rows.
 */
export function jointMemberOrigin(
  member: MemberOriginSource,
  channel: { type?: string; serverId?: string | null } | null | undefined,
): MemberOrigin {
  return channel?.type === "joint" ? memberOrigin(member, channel.serverId) : LOCAL_MEMBER_ORIGIN;
}
