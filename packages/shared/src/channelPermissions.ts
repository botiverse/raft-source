import {
  hasServerCapability,
  type ServerCapability,
  type ServerRole,
} from "./serverPermissions";

export const CHANNEL_ROLES = ["member", "admin"] as const;
export type ChannelRole = typeof CHANNEL_ROLES[number];
export type ChannelActorAdmissionClass = "current_member" | "guest" | "visitor";

/**
 * The deliberately closed set a stored channel admin role may grant. Keep
 * channel access/membership as a separate prerequisite: this list must never
 * make a private channel visible to a server-level outsider.
 */
export const CHANNEL_ADMIN_CAPABILITIES = [
  "editChannelMetadata",
  "archiveChannels",
  "removeChannelMembers",
  "changeChannelMemberRoles",
] as const satisfies readonly ServerCapability[];

/**
 * Management capabilities projected to channel clients. This is deliberately
 * broader than the local-admin allowlist so inherited server authority and
 * explicit denials share one stable response shape.
 */
export const CHANNEL_MANAGEMENT_CAPABILITIES = [
  "editChannelMetadata",
  "archiveChannels",
  "deleteChannels",
  "changeChannelVisibility",
  "manageVisitorAccess",
  "federateChannels",
  "addChannelMembers",
  "removeChannelMembers",
  "changeChannelMemberRoles",
] as const satisfies readonly ServerCapability[];

export type ChannelAdminCapability = typeof CHANNEL_ADMIN_CAPABILITIES[number];
export type ChannelAdminBasis = "server_role" | "channel_role" | "both" | null;

const CHANNEL_ADMIN_CAPABILITY_SET = new Set<ServerCapability>(CHANNEL_ADMIN_CAPABILITIES);

/** Public, private and joint channels carry channel roles; DMs, threads and #all do not. */
export function channelSupportsRoles(channelType: string, channelName: string | null | undefined): boolean {
  return (channelType === "channel" || channelType === "private" || channelType === "joint")
    && channelName !== "all";
}

export function isChannelRole(value: unknown): value is ChannelRole {
  return typeof value === "string" && (CHANNEL_ROLES as readonly string[]).includes(value);
}

export type GuestChannelKind = "channel" | "private" | "joint" | "dm" | "thread" | "task";

export interface GuestChannelPolicyInput {
  serverRole: ServerRole | null | undefined;
  /** The channel being checked (a sub-conversation's caller passes its parent). */
  channelId: string;
  channelType: GuestChannelKind;
  /** The one channel this Guest belongs to (server_members.guest_channel_id). */
  guestChannelId: string | null | undefined;
  isChannelMember: boolean;
  archived: boolean;
  deleted: boolean;
  /**
   * Joint channels only (P3): the server resolved that this Guest enters the
   * joint through the host projection it is bound to (host external_channels_v1
   * on, current joint membership). Absent or false keeps the joint closed.
   */
  jointEntry?: boolean;
}

/**
 * A Guest belongs to exactly one channel of its server (guest + external
 * channels, #wg-rbac:#15) and reads only that channel and its threads and
 * tasks: it must be the bound channel, the Guest must still be its member, and
 * it must be live (an archived channel cuts its Guest off). Nothing else is
 * readable: no other channel, #all or DM. A joint channel is readable only when
 * it is the bound channel (the host's projection) and the server resolved the
 * joint entry (`jointEntry`, P3: host external_channels_v1 and current joint
 * membership). A Guest with no binding (legacy) reads nothing. Sub-conversation
 * (thread / task conversation) callers must resolve against the parent first.
 */
export function canGuestReadChannel(input: GuestChannelPolicyInput): boolean {
  if (input.serverRole !== "guest" || input.deleted || input.archived) return false;
  if (!input.guestChannelId || input.channelId !== input.guestChannelId) return false;
  if (input.channelType === "joint") return input.jointEntry === true && input.isChannelMember;
  if (input.channelType !== "channel" && input.channelType !== "private") return false;
  return input.isChannelMember;
}

/**
 * A Guest's bound channel on a member payload (GET /servers/:id/members, sync
 * rows, the member profile): set only for a Guest, and only for a viewer who
 * may read that channel, so a private channel's name never leaks.
 */
export interface GuestChannelField {
  guestChannel?: { id: string; name: string } | null;
}

/** A Guest posts, replies and assigns tasks wherever it can read. */
export function canGuestPostToChannel(input: GuestChannelPolicyInput): boolean {
  return canGuestReadChannel(input);
}

export function isChannelAdminCapability(
  capability: ServerCapability,
  channelType: string,
): capability is ChannelAdminCapability {
  // A joint channel's management follows its host (the server's
  // channelActorHasCapability jointAuthority: host owner/admin and host-
  // appointed managers), never a stored role read on its own.
  return channelType !== "joint" && CHANNEL_ADMIN_CAPABILITY_SET.has(capability);
}

/**
 * Object-aware add-member policy. This intentionally does not derive
 * authority from `channelRole`: current human/Agent members may add peers
 * without being local admins, while a future visitor remains denied even
 * though its stored channel role may also be `member`.
 *
 * Server owner/admin authority is server-scoped and therefore does not
 * require a stored channel membership on public and private channels; on a
 * joint channel it does. Every other caller must be a joined current member.
 * Public, private and joint channels are addable; DMs, threads and the system
 * #all channel are not.
 */
export function canAddChannelMembers(input: {
  serverRole: ServerRole | null | undefined;
  admissionClass: ChannelActorAdmissionClass;
  isChannelMember: boolean;
  channelType: string;
  channelName?: string | null;
  archived: boolean;
  deleted: boolean;
}): boolean {
  // Joint channels carry ordinary membership, so they are addable under the
  // same admission rules. The write path is already joint-aware: membership
  // lands on the addressed projection while the "was added" notice is stored
  // canonically, and each server's roster reads the joint union - so both
  // sides see the person. A DM has two fixed parties and a thread is
  // follow/unfollow, which is why those two stay out.
  const addableChannel = (
    input.channelType === "channel"
    || input.channelType === "private"
    || input.channelType === "joint"
  ) && input.channelName !== "all";
  if (!addableChannel || input.archived || input.deleted) return false;
  // A joint channel is shared with other servers, so even a server owner/admin
  // must be in it to add someone (decided by cindyz, #wg-rbac B6).
  if (input.serverRole === "owner" || input.serverRole === "admin") {
    return input.channelType !== "joint" || input.isChannelMember;
  }
  return input.serverRole === "member"
    && input.admissionClass === "current_member"
    && input.isChannelMember;
}

export function hasEffectiveChannelCapability(input: {
  serverRole: ServerRole | null | undefined;
  channelRole: ChannelRole | null | undefined;
  isChannelMember: boolean;
  supportsChannelRoles: boolean;
  capability: ServerCapability;
  /**
   * Required so no caller can forget it: a stored admin role on a joint
   * channel grants nothing here (its authority is the host's).
   */
  channelType: string;
}): boolean {
  if (hasServerCapability(input.serverRole, input.capability)) {
    return true;
  }

  return input.isChannelMember
    && input.supportsChannelRoles
    && input.channelRole === "admin"
    // A stale or concurrently observed stored grant must never elevate a Guest.
    && (input.serverRole === "owner" || input.serverRole === "admin" || input.serverRole === "member")
    && isChannelAdminCapability(input.capability, input.channelType);
}

export function getChannelAdminBasis(input: {
  serverRole: ServerRole | null | undefined;
  channelRole: ChannelRole | null | undefined;
  isChannelMember: boolean;
  supportsChannelRoles: boolean;
}): ChannelAdminBasis {
  const inherited = input.serverRole === "owner" || input.serverRole === "admin";
  const stored = input.isChannelMember
    && input.supportsChannelRoles
    && input.channelRole === "admin"
    // Keep the projected basis aligned with the effective-capability fail-closed rule above.
    && (input.serverRole === "owner" || input.serverRole === "admin" || input.serverRole === "member");
  if (inherited && stored) return "both";
  if (inherited) return "server_role";
  if (stored) return "channel_role";
  return null;
}
