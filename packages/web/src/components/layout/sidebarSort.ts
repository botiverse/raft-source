import type { Channel } from "../../store/channelStore";

export type SidebarSortMode = "manual" | "recent" | "az";

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function labelKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

export function sidebarDmLabel(dm: Channel): string {
  return dm.peerDisplayName || dm.peerName || dm.name;
}

/** Per-channel last-message timestamps for recency sorting. `lastMessageAt`
 *  lives in this slice (not on the `Channel` objects), so sorting reads activity
 *  by id without touching the stable channel identity objects. */
export type ChannelActivity = Record<string, string | null>;

function sortSidebarItems<T extends { id: string; createdAt: string }>(
  items: T[],
  mode: SidebarSortMode,
  getLabel: (item: T) => string,
  getActivity: (item: T) => string | null | undefined,
): T[] {
  if (mode === "manual") return items;
  return [...items].sort((a, b) => {
    if (mode === "recent") {
      const aTime = timestampMs(getActivity(a)) || timestampMs(a.createdAt);
      const bTime = timestampMs(getActivity(b)) || timestampMs(b.createdAt);
      if (aTime !== bTime) return bTime - aTime;
    }

    const labelResult = compareLabels(labelKey(getLabel(a)), labelKey(getLabel(b)));
    if (labelResult !== 0) return labelResult;
    return a.id.localeCompare(b.id);
  });
}

export function sortSidebarChannels(
  channels: Channel[],
  mode: SidebarSortMode,
  activity: ChannelActivity,
  allChannelId?: string | null,
): Channel[] {
  if (mode === "manual") return channels;
  const allChannel = allChannelId ? channels.find((channel) => channel.id === allChannelId) ?? null : null;
  const rest = channels.filter((channel) => channel.id !== allChannelId);
  const sorted = sortSidebarItems(rest, mode, (channel) => channel.name, (channel) => activity[channel.id]);
  return allChannel ? [allChannel, ...sorted] : sorted;
}

export function sortSidebarDms(dms: Channel[], mode: SidebarSortMode, activity: ChannelActivity): Channel[] {
  return sortSidebarItems(dms, mode, sidebarDmLabel, (dm) => activity[dm.id]);
}

export interface SidebarPinnedSortItem {
  id: string;
  createdAt: string;
  lastMessageAt?: string | null;
  label: string;
}

export function sortSidebarPinnedItems<T extends SidebarPinnedSortItem>(items: T[], mode: SidebarSortMode): T[] {
  // Pinned items already carry their activity timestamp (the Sidebar sets it
  // from the `channelActivity` slice when building them).
  return sortSidebarItems(items, mode, (item) => item.label, (item) => item.lastMessageAt);
}
