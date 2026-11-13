import { useMessageStore } from "./messageStore";
import type { Message } from "./messageStore";
import { useThreadStore } from "./threadStore";
import { isShownReadIn, threadConversationsOnScreenIn } from "./threadUnreadLocal";

/**
 * Which thread-like conversations are in front of the person, and what a live
 * reply in one does to its unread (#triage:#157). Every place outside the
 * thread store that counts a live reply asks here, so they agree: "if I can
 * see it, it's read". The rules themselves live in threadUnreadLocal.
 */
export function threadConversationsOnScreen(): string[] {
  return threadConversationsOnScreenIn(useThreadStore.getState());
}

/**
 * On screen and not held unread. A held conversation (Mark as Unread, or one
 * Activity reopened on its own) is shown but stays unread until the person
 * acts in it, so its replies count like anywhere else.
 */
export function isConversationShownRead(channelId: string): boolean {
  return isShownReadIn(useThreadStore.getState(), channelId);
}

export function isOwnMessage(message: Pick<Message, "senderType" | "senderId"> | null | undefined): boolean {
  const currentUserId = useMessageStore.getState().currentUserId;
  return !!message && message.senderType === "user" && !!currentUserId && message.senderId === currentUserId;
}

/**
 * What a live reply does to its conversation's unread: read where the person
 * is reading it, unchanged when it is their own (sent from this or another
 * device or window), one more otherwise.
 */
export type LiveReplyUnread = "read" | "unchanged" | "unread";

export function liveReplyUnread(channelId: string, reply: Pick<Message, "senderType" | "senderId"> | null | undefined): LiveReplyUnread {
  if (isConversationShownRead(channelId)) return "read";
  return isOwnMessage(reply) ? "unchanged" : "unread";
}
