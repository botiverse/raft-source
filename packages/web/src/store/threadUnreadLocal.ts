import { isAutoReadHeld } from "./autoReadHold";
import type { FollowedThread, ThreadSummary } from "./threadStore";

interface ThreadUnreadState {
  summaries: Record<string, ThreadSummary>;
  followedThreads: FollowedThread[];
  openParentMessageId: string | null;
  openThreadChannelId: string | null;
  taskModal: { threadChannelId: string | null } | null;
}

/**
 * The thread-like conversations in front of the person: the side panel's
 * thread (the same identity drives Activity's detail pane and the phone's
 * thread page) and the task modal's conversation. store/visibleConversations
 * is the entry point for everything outside this store.
 */
export function threadConversationsOnScreenIn(state: Pick<ThreadUnreadState, "openThreadChannelId" | "taskModal">): string[] {
  const ids = [state.openThreadChannelId, state.taskModal?.threadChannelId ?? null].filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** On screen and not held unread (Mark as Unread, Activity's own reopen keep it unread while shown). */
export function isShownReadIn(state: Pick<ThreadUnreadState, "openThreadChannelId" | "taskModal">, threadChannelId: string): boolean {
  return threadConversationsOnScreenIn(state).includes(threadChannelId) && !isAutoReadHeld(threadChannelId);
}

/**
 * A summary the server bundles with a page of messages carries the server's
 * unread; for a thread the person is reading right now that count is at best
 * a read still in flight, so it stays read here (#triage:#157).
 */
export function keepShownThreadsRead(summaries: Record<string, ThreadSummary>, state: Pick<ThreadUnreadState, "openThreadChannelId" | "taskModal">): Record<string, ThreadSummary> {
  let next = summaries;
  for (const [parentMessageId, summary] of Object.entries(summaries)) {
    if (!summary?.unreadCount || !summary.threadChannelId || !isShownReadIn(state, summary.threadChannelId)) continue;
    if (next === summaries) next = { ...summaries };
    next[parentMessageId] = { ...summary, unreadCount: 0, firstUnreadMessageId: null };
  }
  return next;
}

/** The thread shows unread here: its parent's summary or its followed row. */
export function isThreadUnreadLocally(state: Pick<ThreadUnreadState, "summaries" | "followedThreads">, parentMessageId: string | null, threadChannelId: string | null): boolean {
  if (!threadChannelId) return false;
  if (parentMessageId && (state.summaries[parentMessageId]?.unreadCount ?? 0) > 0) return true;
  return state.followedThreads.some((thread) => thread.threadChannelId === threadChannelId && thread.unreadCount > 0);
}

/**
 * Picking the thread that is already open again (its reply area, a link to
 * it) keeps the panel, so the panel's open read never runs again: openThread
 * reads it when it is unread again, unless it is held unread (#triage:#157).
 * No visibility check: as the panel's open read, it only follows a person's
 * own pick.
 */
export function isReopenedThreadUnread(state: ThreadUnreadState, parentMessageId: string, threadChannelId: string | null): boolean {
  return !!threadChannelId && state.openThreadChannelId === threadChannelId && state.openParentMessageId === parentMessageId
    && !isAutoReadHeld(threadChannelId) && isThreadUnreadLocally(state, parentMessageId, threadChannelId);
}

/** The same for the task modal: picking the task it already shows (#triage:#157). */
export function isReopenedTaskUnread(state: ThreadUnreadState, threadChannelId: string | null): boolean {
  return !!threadChannelId && state.taskModal?.threadChannelId === threadChannelId
    && !isAutoReadHeld(threadChannelId) && isThreadUnreadLocally(state, null, threadChannelId);
}

export function applyThreadUnreadProjectionToSummaries(
  summaries: Record<string, ThreadSummary>,
  threadChannelId: string,
  unreadCount: number,
  firstUnreadMessageId: string | null,
): Record<string, ThreadSummary> {
  let next = summaries;
  for (const [parentMessageId, summary] of Object.entries(summaries)) {
    if (
      summary.threadChannelId !== threadChannelId
      || (
        summary.unreadCount === unreadCount
        && summary.firstUnreadMessageId === firstUnreadMessageId
      )
    ) continue;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: copying once vs redundantly for several matching summaries is an equivalent final projection; source immutability is behavior-pinned.
    if (next === summaries) next = { ...summaries };
    next[parentMessageId] = {
      ...summary,
      unreadCount,
      firstUnreadMessageId,
    };
  }
  return next;
}
