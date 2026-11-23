/**
 * #244 (inbox_row_position_v1, default off): a `thread:updated` for a thread
 * with no row in the loaded Activity list inserts the row it can build
 * (inboxInsertedThreadRow.ts) instead of re-reading the list. Flag off, or
 * anything this client cannot decide, and the list re-reads as before
 * (`X-Raft-Fetch-Refused: not_listed`):
 * - another server than the frame's, a reply gap (replies may be missed: for
 *   a thread not listed, the frame's reply count is not the entry's plus one);
 * - a list not settled for an in-place change (inboxListSettled plain: a
 *   first window accepted, not the saved page, no read in flight, the plain
 *   All list newest first; a filter, facet, scope or search cannot say
 *   whether the row is theirs), or a list read already asked for (its answer
 *   stands for the row, as before);
 * - a local Done or read still holding the row, a Mark as Unread on it;
 * - a thread not followed here (isThreadFollowed), or anything the row
 *   would need that is not known (see buildInsertedThreadRow);
 * - a row whose time sorts below the loaded window (insertedRowIndex).
 *
 * An inserted row is the per-row rule's from then on: its state is the
 * followed entry's position with this reply applied above it (a repeat of the
 * reply, on `message:new`, changes nothing; a lagging answer adds it back).
 * A first-window answer without it within the stale-list bound is the read
 * model's lag: the row is kept, once, and re-read (`catch_up_retry`, scope
 * row); a row read that leaves it out re-reads the list (`row_missing`), and
 * the next answer without it wins (mergeAnswerByPosition).
 * It is noted for the drift check (`inbox.inplace.reread=inserted`,
 * `row_existed=false`), audited as the rule's applied rows are, and counted
 * once (`activity:live_row_inserted`), since it sends no read.
 */
import { currentTimeMs } from "@botiverse/raft-shared";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { incrementInboxGroupCounts, hasInboxGroup, touchInboxGroupActivity } from "./inboxGroups";
import { LIVE_ROW_SKIPPED, noteInPlaceRow, noteInsertedRow } from "./inboxInPlaceUnread";
import type { InboxLiveUnread, LiveRowReceipt } from "./inboxInPlaceUnread";
import { buildInsertedThreadRow, insertedRowIndex } from "./inboxInsertedThreadRow";
import type { ThreadUpdatedFrame } from "./inboxInsertedThreadRow";
import { auditLiveApplied, keepRowState, rowPositionOn } from "./inboxRowPosition";
import { hasInboxLocalRowHold, inboxBackgroundRefreshPending, inboxListSettled, useInboxStore } from "./inboxStore";
import { isScopeMarkedUnread } from "./markedUnreadStore";
import { useChannelStore } from "./channelStore";
import { useMessageStore } from "./messageStore";
import { useServerStore } from "./serverStore";
import { isThreadFollowed, useThreadStore } from "./threadStore";
import type { FollowedThread } from "./threadStore";

/**
 * After receiveThreadReply (`receipt`): its `not_listed` becomes a skipped
 * re-read when the row is inserted; any other receipt, and every fallback,
 * is returned as it came. `followed`: the followed-thread entry before this
 * frame updated it; `serverId`: the server the frame came on.
 */
export function receiveUnlistedThreadReply(
  frame: ThreadUpdatedFrame,
  followed: FollowedThread | undefined,
  live: InboxLiveUnread | undefined,
  replyGap: boolean,
  receipt: LiveRowReceipt,
  serverId: string | null,
): LiveRowReceipt {
  if (receipt.skipped || receipt.refused !== "not_listed" || !live || replyGap) return receipt;
  if (!serverId || serverId !== (useServerStore.getState().current?.id ?? null) || !rowPositionOn(serverId)) return receipt;
  const state = useInboxStore.getState();
  if (!inboxListSettled(state, true) || inboxBackgroundRefreshPending()) return receipt;
  const key = `thread:${frame.threadChannelId}`;
  if (hasInboxLocalRowHold(key) || isScopeMarkedUnread(frame.threadChannelId)) return receipt;
  if (!isThreadFollowed(useThreadStore.getState(), frame.parentMessageId)) return receipt;
  const parentChannelId = frame.latestReply?.conversationContext?.parentChannelId;
  const channels = useChannelStore.getState();
  const parent = channels.channels.find((channel) => channel.id === parentChannelId) ?? channels.dmChannels.find((channel) => channel.id === parentChannelId);
  const built = buildInsertedThreadRow({ frame, live, followed, parent, viewerId: useMessageStore.getState().currentUserId });
  if ("refused" in built) return receipt;
  const { row } = built;
  const index = insertedRowIndex(state.items, row, state.hasMore);
  if (index === null) return receipt;
  const message = frame.latestReply!;
  keepRowState(frame.threadChannelId, built.state);
  // New to the list unless more rows follow and its channel's group is listed: then it may be one past
  // the loaded window, which the totals already count (its earlier unread, followed.unreadCount, included).
  const known = state.hasMore && hasInboxGroup(state.groups, row);
  const baseline = known ? followed?.unreadCount ?? 0 : 0;
  const unreadDelta = row.unreadCount - baseline;
  noteInsertedRow(frame.threadChannelId, row.latestActivitySeq!, baseline);
  noteInPlaceRow(row, live, message, "inserted");
  useInboxStore.setState((current) => ({
    items: [...current.items.slice(0, index), row, ...current.items.slice(index)],
    totalUnreadCount: Math.max(0, current.totalUnreadCount + unreadDelta),
    activeUnreadCount: Math.max(0, current.activeUnreadCount + unreadDelta),
    groups: touchInboxGroupActivity(known ? current.groups : incrementInboxGroupCounts(current.groups, [row]), row, message.createdAt),
    ...(known ? {} : { totalCount: current.totalCount + 1, allCount: current.allCount === null ? null : current.allCount + 1 }),
  }));
  emitStateTransitionTrace({
    domain: "inbox",
    event: "activity:live_row_inserted",
    entityId: key,
    outcome: "applied",
    outcomeDetail: `trigger=thread_reply;index=${index};unread=${row.unreadCount};mention=${row.hasMention ? 1 : 0};counts=${live.counts ? 1 : 0};has_more=${state.hasMore ? 1 : 0};known=${known ? 1 : 0}`,
    touched: 1,
    timestamp: currentTimeMs(),
  }, { "inbox.inplace.trigger": "thread_reply", "inbox.inplace.reread": "inserted" });
  auditLiveApplied(frame.threadChannelId, row);
  return LIVE_ROW_SKIPPED;
}
