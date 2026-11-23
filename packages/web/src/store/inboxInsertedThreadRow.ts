/**
 * #244 (inbox_row_position_v1): the Activity row a `thread:updated` brings
 * for a thread the loaded list does not show, built from the frame and what
 * this client already holds, or why it cannot be (the list re-reads, as
 * before, with `X-Raft-Fetch-Refused: not_listed`). Pure: every input is
 * passed in; inboxThreadInsert.ts gathers them and inserts the row.
 *
 * The frame alone does not carry a row: it has the thread, its reply count
 * and the latest reply (sender, preview, seq, time, its conversationContext
 * with the parent channel's id and type), but not the parent channel's name,
 * the parent message's preview and sender, the thread's unread before this
 * reply, or its first unread and mention. Those come from the followed-thread
 * entry (`GET /channels/threads/followed`, the same read model's thread
 * stats), as it was before the frame. The server lists a followed thread in
 * Activity All while its parent is live and visible (rw_inbox_items_v12) and
 * a new reply clears its Done for every follower (clearThreadDoneForAll), so
 * a followed thread with a new reply is listed. An unfollowed thread is
 * listed only through the unfollowed overlay, which this client cannot
 * decide: never inserted.
 *
 * Its unread is the entry's plus this reply's verdict (activityLiveUnread),
 * only where that is exact: my own reply reads the thread on the server
 * (unread 0, no @); another's counts one more, or (read on arrival) leaves a
 * read thread read. A first unread or first mention the entry does not have
 * is not guessed: the row is not built.
 */
import { activityLiveUnread, isCanonicalActivitySeq, compareActivityRowSeq } from "@botiverse/raft-shared";
import type { ActivityRowState, ActivityUnreadMessage } from "@botiverse/raft-shared";
import { isRetractedMessage } from "../components/message/delegatedMessage";
import type { DelegatedByWire } from "../components/message/delegatedMessage";
import { safeSeqToDecimalString } from "./activitySeq";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import type { InboxItem, ThreadInboxItem } from "./inboxStore";
import type { Message } from "./messageStore";
import type { FollowedThread } from "./threadStore";

/** The `thread:updated` frame's fields a row is built from (socketBridge). */
export type ThreadUpdatedFrame = {
  parentMessageId: string;
  threadChannelId: string;
  replyCount: number;
  latestReply?: Message;
};

/** The parent channel as this client lists it (channelStore). */
export type KnownParentChannel = { id: string; name: string; type: string; archivedAt?: string | null };

/** Why no row is built: the list re-reads (`not_listed`). Not sent; for tests and the reader. */
export type ThreadInsertRefusal =
  | "no_reply" | "no_seq" | "not_thread" | "joint" | "not_followed" | "followed_mismatch" | "parent_history"
  | "parent_unknown" | "own_mentions" | "system" | "loaded" | "unjudged" | "no_position" | "not_newer"
  | "unread_unknown" | "mention_unknown" | "reply_gap";

export type ThreadInsertInput = {
  frame: ThreadUpdatedFrame;
  live: InboxLiveUnread;
  /** The followed-thread entry as it was before this frame (socketBridge reads it before updating it). */
  followed: FollowedThread | undefined;
  parent: KnownParentChannel | undefined;
  viewerId: string | null;
};

/** The row, and the per-row rule's state for it: its last known position, with this reply applied above it. */
export type InsertedThreadRow = { row: ThreadInboxItem; state: ActivityRowState };

const PARENT_TYPES: ReadonlySet<string> = new Set(["channel", "private", "dm"]);
const PARENT_SENDER_TYPES: ReadonlySet<string> = new Set(["user", "agent", "external_projection"]);

export function buildInsertedThreadRow(input: ThreadInsertInput): InsertedThreadRow | { refused: ThreadInsertRefusal } {
  const { frame, live, followed, parent, viewerId } = input;
  const message = frame.latestReply;
  if (!message || message.channelId !== frame.threadChannelId) return { refused: "no_reply" };
  const seq = safeSeqToDecimalString(message.seq);
  if (!isCanonicalActivitySeq(seq)) return { refused: "no_seq" };
  const context = message.conversationContext;
  if (context?.channelType !== "thread" || context.parentMessageId !== frame.parentMessageId || !context.parentChannelId) return { refused: "not_thread" };
  if (!context.parentChannelType || !PARENT_TYPES.has(context.parentChannelType)) return { refused: "joint" };
  if (!followed) return { refused: "not_followed" };
  if (followed.threadChannelId !== frame.threadChannelId || followed.parentMessageId !== frame.parentMessageId
    || followed.parentChannelId !== context.parentChannelId || followed.parentChannelType !== context.parentChannelType
    || followed.conversationKind === "task" || !PARENT_SENDER_TYPES.has(followed.parentMessageSenderType)) return { refused: "followed_mismatch" };
  // The parent behind the plan's history window: the served row's parent preview is not this one.
  if (followed.parentInHistory !== true) return { refused: "parent_history" };
  if (!parent || parent.id !== context.parentChannelId || parent.type !== context.parentChannelType || parent.archivedAt) return { refused: "parent_unknown" };
  const own = message.senderType === "user" && !!viewerId && message.senderId === viewerId;
  // My own reply with mentions may add a mention_action row (as the position rule).
  if (own && (message.mentions ?? []).length > 0) return { refused: "own_mentions" };
  if (message.messageType === "system") return { refused: "system" };
  // The loaded messages' projection already set this thread's unread: not the entry's.
  if (live.loaded) return { refused: "loaded" };
  if (!viewerId) return { refused: "unjudged" };
  const verdict = activityLiveUnread(message as unknown as ActivityUnreadMessage, { type: "user", id: viewerId }, { rowKind: "thread", threadFollowed: true, readOnArrival: !live.counts });
  if (verdict.counts === null || !verdict.moves) return { refused: "unjudged" };
  const base = followed.latestActivitySeq;
  if (!isCanonicalActivitySeq(base)) return { refused: "no_position" };
  if (compareActivityRowSeq(seq, base) <= 0) return { refused: "not_newer" };
  // Replies the entry has not counted (missed here, or the entry is older): its unread is not this thread's.
  if (frame.replyCount !== followed.replyCount + 1) return { refused: "reply_gap" };
  const before = { unread: followed.unreadCount, mention: followed.unreadCount > 0 && followed.hasMention === true };
  let unread: Pick<ThreadInboxItem, "unreadCount" | "hasMention" | "firstUnreadMessageId" | "firstMentionMessageId">;
  if (own) {
    unread = { unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null };
  } else if (verdict.counts) {
    const first = before.unread === 0 ? message.id : followed.firstUnreadMessageId;
    if (!first) return { refused: "unread_unknown" };
    // An earlier unread mention: its message is not known here.
    if (before.mention) return { refused: "mention_unknown" };
    unread = { unreadCount: before.unread + 1, hasMention: verdict.mention, firstUnreadMessageId: first, firstMentionMessageId: verdict.mention ? message.id : null };
  } else {
    // Read as it arrives: only a thread already read stays exactly read.
    if (before.unread !== 0 || before.mention) return { refused: "unread_unknown" };
    unread = { unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null };
  }
  const row: ThreadInboxItem = {
    kind: "thread",
    threadChannelId: frame.threadChannelId,
    parentMessageId: frame.parentMessageId,
    parentChannelId: followed.parentChannelId,
    parentChannelName: followed.parentChannelName,
    parentChannelType: context.parentChannelType,
    parentMessagePreview: followed.parentMessagePreview,
    parentMessageSenderType: followed.parentMessageSenderType as ThreadInboxItem["parentMessageSenderType"],
    parentMessageSenderId: followed.parentMessageSenderId,
    latestActivityPreview: message.content,
    latestActivitySenderType: message.senderType,
    latestActivitySenderId: message.senderId,
    latestActivitySenderName: message.senderName ?? null,
    latestDelegatedBy: (message as { delegatedBy?: DelegatedByWire | null }).delegatedBy ?? null,
    latestRetracted: isRetractedMessage(message),
    senderAvatarUrl: (message as { senderAvatarUrl?: string | null }).senderAvatarUrl ?? null,
    latestActivityMessageId: message.id,
    latestActivitySeq: seq,
    // Not joint: the storage-space frontiers are the display seq (the served row's are its last reply's).
    doneFrontierSeq: seq,
    readStateLatestActivitySeq: seq,
    replyCount: frame.replyCount,
    lastActivityAt: message.createdAt,
    lastReplyAt: message.createdAt,
    ...unread,
    taskNumber: followed.taskNumber,
    taskStatus: followed.taskStatus,
    taskClaimedByName: followed.taskClaimedByName,
    isFollowing: true,
    unfollowedAt: null,
  };
  const counts = !own && verdict.counts;
  const state: ActivityRowState = {
    unreadCount: row.unreadCount,
    hasMention: row.hasMention,
    mentionOnly: false,
    position: base,
    applied: [{ seq, counts, mention: !own && verdict.mention }],
    inversionObserved: false,
  };
  return { row, state };
}

/** A conversation row's activity time (newest first); object and mention-action rows sort last, as placeKeptRows. */
export function inboxRowPlaceAt(item: InboxItem): number {
  if (item.kind === "mention_action" || item.kind === "object") return Number.NEGATIVE_INFINITY;
  const at = Date.parse(item.kind === "thread" ? item.lastActivityAt : item.lastMessageAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * Where the inserted row goes in a newest-first list: by its time, as the
 * position rule places a row it keeps (placeKeptRows), before the first row
 * older than it (a new reply: the top). Null when it sorts below every
 * loaded row and more rows follow: its place is past the loaded window.
 */
export function insertedRowIndex(items: readonly InboxItem[], row: ThreadInboxItem, hasMore: boolean): number | null {
  const at = inboxRowPlaceAt(row);
  if (at === Number.NEGATIVE_INFINITY) return null;
  const index = items.findIndex((other) => inboxRowPlaceAt(other) < at);
  if (index >= 0) return index;
  return hasMore ? null : items.length;
}
