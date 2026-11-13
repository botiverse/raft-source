import type { Channel } from "../../store/channelStore";

const STORAGE_PREFIX = "slock:sidebarJoinedChannelsOnly";

type SidebarVisibilityStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): SidebarVisibilityStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function sidebarJoinedChannelsOnlyStorageKey(serverId: string): string {
  return `${STORAGE_PREFIX}:${serverId}`;
}

export function readSidebarJoinedChannelsOnly(
  serverId: string | undefined,
  storage?: SidebarVisibilityStorage,
): boolean {
  const target = storage ?? getDefaultStorage();
  if (!serverId || !target) return false;
  try {
    return target.getItem(sidebarJoinedChannelsOnlyStorageKey(serverId)) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarJoinedChannelsOnly(
  serverId: string | undefined,
  joinedOnly: boolean,
  storage?: SidebarVisibilityStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!serverId || !target) return;
  try {
    target.setItem(sidebarJoinedChannelsOnlyStorageKey(serverId), String(joinedOnly));
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

export function filterSidebarChannelsByMembership(
  channels: Channel[],
  joinedOnly: boolean,
): Channel[] {
  return joinedOnly ? channels.filter((channel) => channel.joined === true) : channels;
}

/**
 * A conversion receipt is authoritative until finalize commits the Joint
 * projection. The API may briefly expose `type=joint` ahead of that receipt;
 * sidebar sections must keep such a channel in the ordinary list so the
 * visible classification matches the Settings state machine.
 */
export function hasActiveChannelConversion(
  channel: Pick<Channel, "conversionJob">,
): boolean {
  const status = channel.conversionJob?.status;
  return status === "pending" || status === "running" || status === "failed";
}

export function isSidebarJointChannel(
  channel: Pick<Channel, "type" | "conversionJob">,
): boolean {
  return channel.type === "joint" && !hasActiveChannelConversion(channel);
}

/**
 * A channel with people from outside the Server that no other server has
 * joined (a Guest or an open external invite; `hasExternalRelation`). Not
 * gated by external_channels_v1: a channel that is already external keeps
 * its group and icon when the flag is off (plan §2a).
 */
export function isSidebarExternalOnlyChannel(
  channel: Pick<Channel, "type" | "hasExternalRelation">,
): boolean {
  return channel.hasExternalRelation === true && (channel.type === "channel" || channel.type === "private");
}

/** The External section (formerly Joint Channels): joint channels and external-only ones. */
export function isSidebarExternalSectionChannel(
  channel: Pick<Channel, "type" | "conversionJob" | "hasExternalRelation">,
): boolean {
  return isSidebarJointChannel(channel) || isSidebarExternalOnlyChannel(channel);
}

export function shouldShowSidebarChannelEmptyState(channels: Channel[]): boolean {
  return channels.length === 0;
}

/**
 * The External section's title: "External" once external channels are on or
 * any of its (active) channels is external-only, else "Joint Channels".
 * Pass the section's channels or all of them: only active external-only ones count.
 */
export function sidebarExternalSectionLabelId(
  externalChannelsEnabled: boolean,
  channels: ReadonlyArray<Pick<Channel, "type" | "hasExternalRelation" | "archivedAt">>,
): "layout.sidebar.external" | "layout.sidebar.jointChannels" {
  return externalChannelsEnabled
    || channels.some((channel) => !channel.archivedAt && isSidebarExternalOnlyChannel(channel))
    ? "layout.sidebar.external"
    : "layout.sidebar.jointChannels";
}

/** A channel's home section (where it sits unpinned and unplaced), as a sectionOrder key. */
export function sidebarChannelHomeSectionKey(
  channel: Pick<Channel, "type" | "conversionJob" | "hasExternalRelation">,
): "system:joint" | "system:channels" {
  return isSidebarExternalSectionChannel(channel) ? "system:joint" : "system:channels";
}
