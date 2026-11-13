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


/** A server a joint channel member participates through (RFC 075 phase 1). */
export interface ChannelMemberServer {
  id: string;
  name: string;
  slug: string;
}

export interface ServerBadgeMember {
  serverId?: string | null;
  serverName?: string | null;
  serverSlug?: string | null;
  /** Joint rosters only: every server the person participates through,
   *  the viewed server first. Absent elsewhere and on older servers. In
   *  computed membership mode: the person's current sources, the viewed
   *  server already left out by the server. */
  servers?: ChannelMemberServer[] | null;
}

/**
 * Server badge labels for a roster member, as seen from `viewerServerId`.
 * Empty when the member is purely local (every server is the viewer's), so
 * ordinary members never get a badge; otherwise every server the member
 * participates through, viewed server included, so a person who belongs to
 * both sides of a joint channel shows both. Falls back to the single
 * `serverId`/`serverName`/`serverSlug` when `servers` is absent (not when empty).
 */
export function memberServerBadgeLabels(
  member: ServerBadgeMember,
  viewerServerId: string | null | undefined,
): string[] {
  if (!viewerServerId) return [];
  // `servers` is the server's answer, an empty list included (a profile
  // opened from a channel the person is not listed in names no server).
  const servers: Array<{ id: string; name?: string | null; slug?: string | null }> = member.servers
    ? member.servers
    : member.serverId
      ? [{ id: member.serverId, name: member.serverName, slug: member.serverSlug }]
      : [];
  if (servers.every((server) => server.id === viewerServerId)) return [];
  return servers
    .map((server) => server.name || server.slug || "")
    .filter((label) => label.length > 0);
}
