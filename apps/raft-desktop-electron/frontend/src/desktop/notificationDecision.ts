// Pure decision for desktop native notifications: given a channelId whose unread
// just went up, should we raise an OS notification, and how do we open it?
//
// The bridge used to notify for ANY unread increase, but messageStore.unreadCounts
// is keyed by channelId and INCLUDES thread channels AND muted channels — so it
// buzzed for unfollowed threads / un-joined / muted channels, and opened threads
// as a bare "#thread-<id>" channel. This mirrors the web's attention model using
// the reused stores' own state:
//   - a channel: notify only if joined AND not muted (like web hasUnmutedUnread);
//   - a DM: notify unless muted;
//   - a thread: notify only if FOLLOWED, and open it with parent context;
//   - anything else (an unfollowed thread channel, an unknown id): skip.

export interface ChannelLike {
  id: string;
  joined?: boolean;
  activityMuted?: boolean;
  type?: string;
}

export interface FollowedThreadLike {
  threadChannelId: string;
  parentChannelId: string;
  parentMessageId: string;
}

export type NotifyDecision =
  | { notify: false }
  | { notify: true; kind: "channel" }
  | { notify: true; kind: "dm" }
  | { notify: true; kind: "thread"; parentChannelId: string; parentMessageId: string };

export function decideNotification(
  channelId: string,
  channels: readonly ChannelLike[],
  dmChannels: readonly ChannelLike[],
  followedThreads: readonly FollowedThreadLike[],
): NotifyDecision {
  // A FOLLOWED thread → notify and open with its parent channel + anchor message.
  // (An UNfollowed thread isn't here, falls through, and is skipped below.)
  const thread = followedThreads.find((t) => t.threadChannelId === channelId);
  if (thread) {
    return {
      notify: true,
      kind: "thread",
      parentChannelId: thread.parentChannelId,
      parentMessageId: thread.parentMessageId,
    };
  }

  const channel = channels.find((c) => c.id === channelId);
  const isDm = dmChannels.some((c) => c.id === channelId) || channel?.type === "dm";
  if (isDm) {
    const dm = dmChannels.find((c) => c.id === channelId) ?? channel;
    // DMs are personal; notify unless explicitly muted.
    return dm?.activityMuted ? { notify: false } : { notify: true, kind: "dm" };
  }

  // A regular channel: notify only if the user is a member (joined) and it isn't
  // muted — mirroring the web's "loud unread" rule.
  if (channel && channel.joined === true && !channel.activityMuted) {
    return { notify: true, kind: "channel" };
  }

  // Unknown id (an unfollowed thread channel, an un-joined channel, or one not in
  // the store) → don't raise a notification.
  return { notify: false };
}
