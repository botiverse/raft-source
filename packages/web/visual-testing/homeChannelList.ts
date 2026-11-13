// screens.home.channel-list: the followed threads behind each fixture channel's
// `followedThreadsWithNewReplies` (fixtureData.json `homeChannelList`). Shared by
// the render host's store priming and the playwright followed-threads stub, so
// both hand the Sidebar the same list. No imports: the spec loads it as is.

type HomeChannelListChannel = {
  id: string;
  name: string;
  type: string;
  followedThreadsWithNewReplies: number;
};

export function homeChannelListFollowedThreads(
  channels: readonly HomeChannelListChannel[],
  senderId: string,
  parentMessageCreatedAt: string,
  lastReplyAt: string,
) {
  return channels.flatMap((channel) =>
    Array.from({ length: channel.followedThreadsWithNewReplies }, (_, index) => ({
      threadChannelId: `thread-${channel.id}-${index + 1}`,
      parentMessageId: `message-${channel.id}-${index + 1}`,
      parentChannelId: channel.id,
      parentChannelName: channel.name,
      parentChannelType: channel.type,
      parentMessagePreview: "Release checklist",
      parentMessageSenderType: "user",
      parentMessageSenderId: senderId,
      parentMessageCreatedAt,
      latestActivitySeq: null,
      replyCount: 2,
      lastReplyAt,
      unreadCount: 1,
      hasMention: false,
      firstUnreadMessageId: null,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    })));
}
