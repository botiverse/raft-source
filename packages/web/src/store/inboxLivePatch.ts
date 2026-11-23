/**
 * #244: a live message patched in place on its Activity row (inboxStore
 * receiveThreadReply / receiveChannelMessage): the list's unread totals, and
 * a late message counted once on a row already past it.
 */
import { incrementInboxGroupCounts } from "./inboxGroups";
import { lateLiveUnreadFields, noteInPlaceRow, noteLiveApplied } from "./inboxInPlaceUnread";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import type { ActivityPersistedItem, ChannelInboxItem, InboxFilter, InboxState, ThreadInboxItem } from "./inboxStore";
import type { Message } from "./messageStore";

export function isUnreadInboxFilter(filter: InboxFilter): boolean {
  return filter === "unread" || filter === "unread_mentions";
}

/**
 * #244: the list's totals after a live message added `added` unread to `row`
 * in place, so a later read (clearReadForChannel, a projection) takes back
 * only what was added. Under an Unread filter a row that was read joins its group;
 * `revived`: one the list kept read comes back into the store (activityUnreadRevive).
 */
export function inPlaceUnreadTotals(state: InboxState, row: ActivityPersistedItem, added: number, revived = false): Partial<InboxState> {
  if (added <= 0) return {};
  return {
    ...(revived ? { totalCount: state.totalCount + 1 } : {}),
    totalUnreadCount: state.totalUnreadCount + added,
    activeUnreadCount: state.activeUnreadCount + added,
    ...(isUnreadInboxFilter(state.filter) && row.unreadCount === added ? { groups: incrementInboxGroupCounts(state.groups, [row]) } : {}),
  };
}

/**
 * #244: a live message its row is already past (it came after a newer one, or
 * moved the row without being counted) counts once: the unread fields only
 * (lateLiveUnreadFields), not the preview, order or seq. `kept`: false when
 * the row's counted set is full (ask for a re-read).
 */
export function lateLivePatch<T extends ThreadInboxItem | ChannelInboxItem>(state: InboxState, row: T, message: Message, live: InboxLiveUnread | undefined): { next: T; patch: Partial<InboxState>; kept: boolean } | null {
  const fields = lateLiveUnreadFields(row, message, live);
  if (!fields || !live) return null;
  const next: T = { ...row, ...fields };
  noteInPlaceRow(next, live, message, null, true);
  const patch = { items: state.items.map((item) => (item === row ? next : item)), ...inPlaceUnreadTotals(state, next, next.unreadCount - row.unreadCount) };
  return { next, patch, kept: noteLiveApplied(row, message, live) };
}
