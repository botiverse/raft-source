export interface ChatAttentionChannel {
  id: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  joined?: boolean;
}

/**
 * Chat's pink rail attention follows the conversation list the user owns:
 * DMs and joined channels. Public discovery rows keep their gray row-level
 * unread state, but an unjoined public channel must not light the global Chat
 * entry.
 */
export function selectChatAttentionChannelIds(
  channels: readonly ChatAttentionChannel[],
  dmChannels: readonly Pick<ChatAttentionChannel, "id">[],
): string[] {
  return [
    ...channels
      .filter((channel) => channel.type !== "channel" || channel.joined === true)
      .map((channel) => channel.id),
    ...dmChannels.map((channel) => channel.id),
  ];
}

export function hasChatAttentionUnread(
  channelIds: readonly string[],
  unreadCounts: Readonly<Record<string, number>>,
): boolean {
  return channelIds.some((channelId) => (unreadCounts[channelId] ?? 0) > 0);
}
