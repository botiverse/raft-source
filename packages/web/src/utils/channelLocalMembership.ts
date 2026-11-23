import { isGuestRole } from "@botiverse/raft-shared";
import type { GuestChannelField, ServerRole } from "@botiverse/raft-shared";

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

/**
 * Whether a person may be offered as a candidate to add to `channel`. A Guest
 * belongs to its one bound channel: the server's addHuman refuses it in any
 * other channel (403 guest_other_channel, #15347) and in a joint channel, so
 * the add pickers leave it out there. Guests already in the channel still show
 * in its member list; this only narrows who can be added.
 */
export function isAddableToChannel(
  member: GuestChannelField & { role: ServerRole },
  channel: { id: string; type?: string | null } | null | undefined,
): boolean {
  if (!isGuestRole(member.role)) return true;
  return !!channel && channel.type !== "joint" && member.guestChannel?.id === channel.id;
}

/**
 * Whether a person may be offered as an initial member of a channel being
 * created. A new channel is never a Guest's bound channel, so the server's
 * createChannel refuses any Guest among its initial members (403
 * guest_other_channel, #15358) and the create pickers leave Guests out.
 */
export function isAddableToNewChannel(member: { role: ServerRole }): boolean {
  return !isGuestRole(member.role);
}

/** A server a joint channel member participates through (RFC 075 phase 1). */
export interface ChannelMemberServer {
  id: string;
  name: string;
  slug: string;
  /** The server's logo, or null; absent from older servers. */
  avatarUrl?: string | null;
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
