import { shouldShowActivityMutedIcon } from "./channelUnreadIndicator";

export interface ChatAttentionChannel {
  id: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  joined?: boolean;
  activityMuted?: boolean;
}

export interface ChatAttentionChannelIds {
  /** Conversations whose unread lights Chat (the row's loud badge). */
  loud: string[];
  /**
   * Muted joined channels: their unread count is quiet on the row, so it lights
   * Chat only with the row's @you marker (a mention of the viewer).
   */
  mutedChannels: string[];
}

/**
 * Chat's pink rail attention follows the conversation list the user owns:
 * DMs and joined channels. Public discovery rows keep their gray row-level
 * unread state, but an unjoined public channel must not light the global Chat
 * entry.
 *
 * Muting follows the rows exactly (utils/channelUnreadIndicator): a muted
 * joined channel shows a quiet count, so its unread lights Chat only while the
 * row shows the @you marker; a muted DM stays quiet whatever else is true (a
 * mention does not pierce a DM's mute), so it never lights Chat.
 */
export function selectChatAttentionChannelIds(
  channels: readonly ChatAttentionChannel[],
  dmChannels: readonly Pick<ChatAttentionChannel, "id" | "activityMuted">[],
): ChatAttentionChannelIds {
  const loud: string[] = [];
  const mutedChannels: string[] = [];
  for (const channel of channels) {
    if (channel.type === "channel" && channel.joined !== true) continue;
    if (shouldShowActivityMutedIcon({ activityMuted: channel.activityMuted, joined: channel.joined })) {
      mutedChannels.push(channel.id);
    } else {
      loud.push(channel.id);
    }
  }
  for (const dm of dmChannels) {
    if (dm.activityMuted !== true) loud.push(dm.id);
  }
  return { loud, mutedChannels };
}

export function hasChatAttentionUnread(
  channelIds: ChatAttentionChannelIds,
  unreadCounts: Readonly<Record<string, number>>,
  mentionFlags: Readonly<Record<string, boolean>> = {},
): boolean {
  return channelIds.loud.some((channelId) => (unreadCounts[channelId] ?? 0) > 0)
    || channelIds.mutedChannels.some((channelId) => (
      mentionFlags[channelId] === true && (unreadCounts[channelId] ?? 0) > 0
    ));
}
