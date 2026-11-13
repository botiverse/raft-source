import type { Message } from "./messageStore";
import { useChannelActivityStore } from "./channelActivityStore";
import { readThreadRepliesSyncWindowEnvelope } from "./threadRepliesSocket";
import { useThreadStore } from "./threadStore";

/** The part of a `thread:updated` frame a forum-style channel reads. */
export interface ForumThreadUpdated {
  parentMessageId: string;
  threadChannelId: string;
  lastReplyAt: string | null;
  latestReply?: Message;
  syncCoreReplyWindow?: unknown;
}

// The parent's channel: the sync window and the reply's conversation context
// name it; an older server's frame falls back to the followed threads.
function parentChannelIdOf(data: ForumThreadUpdated): string | null {
  const fromWindow = readThreadRepliesSyncWindowEnvelope(data)?.parentChannelId;
  if (fromWindow) return fromWindow;
  const fromReply = data.latestReply?.conversationContext?.parentChannelId;
  if (fromReply) return fromReply;
  return useThreadStore.getState().followedThreads.find((t) => t.threadChannelId === data.threadChannelId)?.parentChannelId ?? null;
}

/**
 * Forum-style channels (#proj-chat:#24): a reply moves its parent to the newest
 * end of an activity-ordered channel, whatever path the reply summary takes
 * (an own reply arrives here too). Only the parent's own channel is touched,
 * and only while its forum window is open.
 */
export function noteForumThreadUpdated(data: ForumThreadUpdated): void {
  useChannelActivityStore.getState().noteThreadReply({
    parentMessageId: data.parentMessageId,
    lastReplyAt: data.lastReplyAt,
    parentChannelId: parentChannelIdOf(data),
  });
}
