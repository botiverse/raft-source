import type { ServerRole } from "@botiverse/raft-shared";

type ServerMemberRoleRef = {
  userId: string;
  serverId?: string;
  role: ServerRole;
};

type ChannelHumanRoleRef = {
  id: string;
  serverId?: string;
  role: ServerRole;
};

function isLocalRole(serverId: string | null | undefined, expectedServerId: string | null | undefined) {
  return !expectedServerId || !serverId || serverId === expectedServerId;
}

export function resolveChannelMemberViewerRole({
  currentUserId,
  currentServerId,
  channelServerId,
  channelHumans,
  serverMembers,
}: {
  currentUserId: string | null | undefined;
  currentServerId: string | null | undefined;
  channelServerId: string | null | undefined;
  channelHumans: ChannelHumanRoleRef[];
  serverMembers: ServerMemberRoleRef[];
}): ServerRole | null {
  if (!currentUserId) return null;

  const localChannelRole = channelHumans.find((human) =>
    human.id === currentUserId && isLocalRole(human.serverId, channelServerId ?? currentServerId)
  )?.role;
  if (localChannelRole) return localChannelRole;

  return serverMembers.find((member) =>
    member.userId === currentUserId && isLocalRole(member.serverId, currentServerId)
  )?.role ?? null;
}

export function canUseChannelMemberAction({
  hasChannelMemberCapability,
  isAllChannel = false,
  ...roleInput
}: Parameters<typeof resolveChannelMemberViewerRole>[0] & {
  hasChannelMemberCapability: boolean;
  /** The system #all channel never has a member-management surface. */
  isAllChannel?: boolean;
}) {
  return !isAllChannel
    && hasChannelMemberCapability
    && resolveChannelMemberViewerRole(roleInput) !== null;
}
