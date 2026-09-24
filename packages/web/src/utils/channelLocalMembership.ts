export interface ChannelLocalMembershipContext {
  serverId?: string | null;
}

export interface ProjectionMember {
  serverId?: string | null;
}

export function isLocalProjectionMember(
  member: ProjectionMember,
  channel: ChannelLocalMembershipContext | null | undefined,
) {
  if (!channel?.serverId) return true;
  if (!member.serverId) return true;
  return member.serverId === channel.serverId;
}

