import {
  hasServerCapability,
  type ServerCapability,
  type ServerRole,
} from "./serverPermissions.js";

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
  "manageGuestAccess",
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
  "manageGuestAccess",
  "federateChannels",
  "addChannelMembers",
  "removeChannelMembers",
  "changeChannelMemberRoles",
] as const satisfies readonly ServerCapability[];

export type ChannelAdminCapability = typeof CHANNEL_ADMIN_CAPABILITIES[number];
export type ChannelAdminBasis = "server_role" | "channel_role" | "both" | null;

const CHANNEL_ADMIN_CAPABILITY_SET = new Set<ServerCapability>(CHANNEL_ADMIN_CAPABILITIES);

export function isChannelRole(value: unknown): value is ChannelRole {
  return typeof value === "string" && (CHANNEL_ROLES as readonly string[]).includes(value);
}

export type GuestChannelKind = "channel" | "private" | "joint" | "dm" | "thread";

export interface GuestChannelPolicyInput {
  gateEnabled: boolean;
  serverRole: ServerRole | null | undefined;
  channelType: GuestChannelKind;
  channelName?: string | null;
  allChannelHidden?: boolean;
  guestVisible: boolean;
  guestJoinable: boolean;
  isChannelMember: boolean;
  archived: boolean;
  deleted: boolean;
}

function isEnabledAllForGuest(input: GuestChannelPolicyInput): boolean {
  return input.channelName === "all" && input.allChannelHidden !== true;
}

/**
 * Guest access is a separate axis from ordinary server membership. Missing or
 * disabled rollout state fails closed, and joint channels remain out of v1.
 * Thread callers must resolve against the parent before invoking this helper.
 */
export function canGuestReadChannel(input: GuestChannelPolicyInput): boolean {
  if (!input.gateEnabled || input.serverRole !== "guest" || input.deleted) return false;
  if (input.channelType === "joint" || input.channelType === "thread") return false;
  if (input.channelType === "dm" || input.channelType === "private") return input.isChannelMember;
  // #all is a special read-only Guest surface, never a Guest membership.
  // Its one Guest control is discoverability/read access; explicit/stale
  // membership rows must not widen that policy.
  if (input.channelName === "all") return isEnabledAllForGuest(input) && input.guestVisible;
  return input.isChannelMember || input.guestVisible;
}

export function canGuestJoinChannel(input: GuestChannelPolicyInput): boolean {
  if (!canGuestReadChannel(input) || input.archived || input.isChannelMember) return false;
  if (input.channelName === "all") return false;
  if (input.channelType !== "channel") return false;
  return input.guestVisible && input.guestJoinable;
}

export function canGuestPostToChannel(input: GuestChannelPolicyInput): boolean {
  if (!input.gateEnabled || input.serverRole !== "guest" || input.archived || input.deleted) return false;
  if (input.channelName === "all") return false;
  if (!input.isChannelMember || input.channelType === "joint" || input.channelType === "thread") return false;
  return true;
}

export function isValidGuestChannelPolicy(input: { guestVisible: boolean; guestJoinable: boolean }): boolean {
  return !input.guestJoinable || input.guestVisible;
}

export function isChannelAdminCapability(
  capability: ServerCapability,
): capability is ChannelAdminCapability {
  return CHANNEL_ADMIN_CAPABILITY_SET.has(capability);
}

/**
 * Object-aware add-member policy. This intentionally does not derive
 * authority from `channelRole`: current human/Agent members may add peers
 * without being local admins, while a future visitor remains denied even
 * though its stored channel role may also be `member`.
 *
 * Server owner/admin authority is server-scoped and therefore does not
 * require a stored channel membership. Every other caller must be a joined
 * current member. Public, private and joint channels are addable; DMs,
 * threads and the system #all channel are not.
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
  if (input.serverRole === "owner" || input.serverRole === "admin") return true;
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
}): boolean {
  if (hasServerCapability(input.serverRole, input.capability)) {
    return true;
  }

  return input.isChannelMember
    && input.supportsChannelRoles
    && input.channelRole === "admin"
    // A stale or concurrently observed stored grant must never elevate a Guest.
    && (input.serverRole === "owner" || input.serverRole === "admin" || input.serverRole === "member")
    && isChannelAdminCapability(input.capability);
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
