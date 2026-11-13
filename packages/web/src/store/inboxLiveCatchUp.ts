/**
 * #244 under-count, the socket bridge's side. A message the store got first
 * from a catch-up (`/messages/sync`, `sync:resume`) still takes its live
 * count once when its `message:new` comes: "already applied to the inbox" is
 * the row's counted set (inboxCountedIds), not the message store. And what no
 * live event will count (messages a resume brought, replies a thread:updated
 * says were missed) asks for an Activity re-read.
 */
import { releaseActivityReadHoldForMessage } from "./activityReadState";
import { isMessageActivitySuppressedByMute } from "./channelRealtimeSync";
import type { ScheduleInboxRefresh } from "./channelRealtimeSync";
import { isInboxCounted } from "./inboxCountedIds";
import { liveActivityUnread } from "./inboxInPlaceUnread";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import { inboxItemChannelId } from "./inboxItem";
import { useInboxStore } from "./inboxStore";
import { useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { useServerStore } from "./serverStore";

/**
 * `message:new` for a message the store already had: its live unread
 * (`via: "sync"`), or undefined when its row already counted it (a repeat
 * delivery) or a mute stops it.
 */
export function storedMessageLive(msg: Message): InboxLiveUnread | undefined {
  if (isInboxCounted(msg.channelId, msg.id)) return undefined;
  releaseActivityReadHoldForMessage(
    { serverId: useServerStore.getState().current?.id ?? null, principalId: useMessageStore.getState().currentUserId },
    msg.channelId,
    msg.seq,
  );
  if (isMessageActivitySuppressedByMute(msg)) return undefined;
  return { ...liveActivityUnread(msg, "message_new"), via: "sync" };
}

/** `sync:resume` brought messages: re-read Activity when one is for a listed row (no live patch counts them). */
export function requestResumeGapReread(messages: readonly Message[], scheduleInboxRefresh: ScheduleInboxRefresh): void {
  if (messages.length === 0) return;
  const scopes = new Set(messages.map((message) => message.channelId));
  if (useInboxStore.getState().items.some((item) => scopes.has(inboxItemChannelId(item) ?? ""))) scheduleInboxRefresh("resume_gap");
}

/** A thread:updated `replyCount` more than one past the listed thread row's: replies this tab never saw. */
export function isThreadReplyGap(threadChannelId: string, replyCount: number): boolean {
  const row = useInboxStore.getState().items.find((item) => item.kind === "thread" && item.threadChannelId === threadChannelId);
  return row?.kind === "thread" && replyCount - row.replyCount > 1;
}
