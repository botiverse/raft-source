import type { FollowedThread } from "../store/threadStore";

type FollowedThreadUnreadFields = Pick<
  FollowedThread,
  "threadChannelId" | "parentChannelId" | "unreadCount" | "hasMention" | "lastReplyAt" | "parentMessageCreatedAt"
> & Partial<Pick<FollowedThread, "conversationKind">>;

/** Followed-thread unread folded onto one parent channel. Never part of the channel's own unreadCount. */
export type ParentThreadUnread = {
  /** Followed threads under the channel with unread replies (threads, not replies). */
  count: number;
  /** One of those threads has an unread reply that mentions the user. */
  hasMention: boolean;
};

export const NO_PARENT_THREAD_UNREAD: ParentThreadUnread = Object.freeze({ count: 0, hasMention: false });

/**
 * Followed-thread unread of every parent channel, in one pass over the list.
 * The followed-thread list is replaced (never mutated) on every change, so the
 * index is cached per list: each sidebar row then looks its channel up instead
 * of scanning the whole list once per row on every store update.
 */
const unreadByParentCache = new WeakMap<readonly FollowedThreadUnreadFields[], ReadonlyMap<string, ParentThreadUnread>>();

export function groupThreadUnreadByParent(
  threads: readonly FollowedThreadUnreadFields[],
): ReadonlyMap<string, ParentThreadUnread> {
  const cached = unreadByParentCache.get(threads);
  if (cached) return cached;
  const byParent = new Map<string, ParentThreadUnread>();
  for (const thread of threads) {
    // A task conversation (task v2) shows its unread in Activity only
    // (stdrc): the channel can neither lead to it nor mark it read
    // (conversation read-all covers threads), so it never counts here.
    if (thread.unreadCount <= 0 || thread.conversationKind === "task") continue;
    const current = byParent.get(thread.parentChannelId);
    byParent.set(thread.parentChannelId, {
      count: (current?.count ?? 0) + 1,
      hasMention: current?.hasMention === true || thread.hasMention === true,
    });
  }
  unreadByParentCache.set(threads, byParent);
  return byParent;
}

/**
 * The sidebar mark for one channel, derived from the followed-thread list.
 * That list is already the live source for thread unread (loaded at connect,
 * bumped by thread replies, lowered by reads, pruned on unfollow/done), so
 * deriving here keeps the mark and the Threads inbox from ever disagreeing.
 */
export function summarizeParentThreadUnread(
  threads: readonly FollowedThreadUnreadFields[],
  parentChannelId: string,
): ParentThreadUnread {
  return groupThreadUnreadByParent(threads).get(parentChannelId) ?? NO_PARENT_THREAD_UNREAD;
}

function timeOrLast(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * Where the thread sits in its channel: its parent message's time. An older
 * server does not send it, so fall back to the latest reply (the old order).
 */
function channelPositionTime(thread: FollowedThreadUnreadFields): number {
  return timeOrLast(thread.parentMessageCreatedAt ?? thread.lastReplyAt);
}

/**
 * Unread followed threads of one channel in jump order: top to bottom as the
 * channel shows them, by parent message time (earliest parent first), so
 * "Jump to first" lands on the topmost and "next" moves down. Mentions get no
 * priority here (product call); the sidebar's @ marker already surfaces them.
 */
export function orderParentUnreadThreadsForJump<T extends FollowedThreadUnreadFields>(
  threads: readonly T[],
  parentChannelId: string,
): T[] {
  return threads
    // A task conversation (task v2) is not counted, as in the sidebar mark.
    .filter((thread) => thread.parentChannelId === parentChannelId && thread.unreadCount > 0 && thread.conversationKind !== "task")
    .sort((a, b) => channelPositionTime(a) - channelPositionTime(b));
}
