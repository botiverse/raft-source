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

export function shouldShowSidebarChannelEmptyState(channels: Channel[]): boolean {
  return channels.length === 0;
}
