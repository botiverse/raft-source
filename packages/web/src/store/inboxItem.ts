import type { InboxItem } from "./inboxStore";

/** Pure helpers on one Activity row, shared by the inbox store and the kept open row. */

export function getInboxItemKey(item: InboxItem): string {
  if (item.kind === "mention_action") return `mention_action:${item.id}`;
  if (item.kind === "object") return `object:${item.objectKind}:${item.objectId}`;
  return item.kind === "thread" ? `thread:${item.threadChannelId}` : `${item.kind}:${item.channelId}`;
}

/** The conversation the row is: a thread's own channel. An object row is none. */
export function inboxItemChannelId(item: InboxItem): string | null {
  if (item.kind === "mention_action" || item.kind === "object") return null;
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

/** The channel (or DM) the row sits in: a thread's parent. An object row is in no channel group. */
export function inboxItemGroupChannelId(item: InboxItem): string | null {
  if (item.kind === "mention_action" || item.kind === "object") return null;
  return item.kind === "thread" ? item.parentChannelId : item.channelId;
}

/** The row once read: nothing unread, no unread mention. */
export function readInboxItem(item: InboxItem): InboxItem {
  if (item.kind === "object") return { ...item, unreadCount: 0, hasMention: false };
  return { ...item, unreadCount: 0, firstUnreadMessageId: null, hasMention: false } as InboxItem;
}

type ThreadRow = Extract<InboxItem, { kind: "thread" }>;

/**
 * The saved thread rows, for a first load to compare with what it served. A
 * saved row's counts can be a session old, so it stays only for what a live
 * reply writes; its unread shows on the next read, as for a channel row.
 */
export function savedThreadRowsOverServed(saved: readonly InboxItem[], served: readonly InboxItem[]): InboxItem[] {
  const servedThreads = new Map(served
    .filter((row): row is ThreadRow => row.kind === "thread")
    .map((row) => [row.threadChannelId, row]));
  return saved.map((row) => {
    const incoming = row.kind === "thread" ? servedThreads.get(row.threadChannelId) : undefined;
    if (row.kind !== "thread" || !incoming) return row;
    return {
      ...incoming,
      latestActivityPreview: row.latestActivityPreview,
      latestActivitySenderType: row.latestActivitySenderType,
      latestActivitySenderId: row.latestActivitySenderId,
      latestActivityMessageId: row.latestActivityMessageId,
      senderAvatarUrl: row.senderAvatarUrl,
      latestDelegatedBy: row.latestDelegatedBy,
      latestRetracted: row.latestRetracted,
      latestActivitySeq: row.latestActivitySeq,
      replyCount: row.replyCount,
      lastActivityAt: row.lastActivityAt,
      lastReplyAt: row.lastReplyAt,
    };
  });
}
