import type { InboxItem } from "../../store/inboxStore";

export type ChannelLike = {
  id: string;
  name: string;
  type?: string | null;
  archivedAt?: string | null;
  peerDisplayName?: string | null;
  peerName?: string | null;
};

export function itemFilterChannelId(item: InboxItem): string {
  if (item.kind === "thread") return item.parentChannelId;
  return item.channelId;
}

export function itemFilterChannelLabel(
  item: InboxItem,
  channels: ChannelLike[],
  dmChannels: ChannelLike[],
): string {
  if (item.kind === "thread") {
    if (item.parentChannelType === "dm") {
      const ch = channels.find((c) => c.id === item.parentChannelId)
        || dmChannels.find((c) => c.id === item.parentChannelId);
      return `@${ch?.peerDisplayName || ch?.peerName || item.parentChannelName}`;
    }
    return `#${item.parentChannelName}`;
  }
  if (item.kind === "mention_action") {
    if (item.channelType === "dm") return `@${item.channelName}`;
    return `#${item.channelName}`;
  }
  if (item.kind === "dm") {
    const ch = dmChannels.find((c) => c.id === item.channelId);
    return `@${ch?.peerDisplayName || ch?.peerName || item.channelName}`;
  }
  return `#${item.channelName}`;
}

export function channelFilterOptionLabel(channel: ChannelLike): string {
  if (channel.type === "dm") {
    return `@${channel.peerDisplayName || channel.peerName || channel.name}`;
  }
  return `#${channel.name}`;
}

export function inboxChannelFilterOptions(
  channels: ChannelLike[],
  dmChannels: ChannelLike[],
): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  for (const channel of [...channels, ...dmChannels]) {
    if (channel.type === "thread" || channel.archivedAt) continue;
    if (!byId.has(channel.id)) byId.set(channel.id, channelFilterOptionLabel(channel));
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
