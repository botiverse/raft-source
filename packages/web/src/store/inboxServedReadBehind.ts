/**
 * #triage:#244 under-count: an Activity answer whose read cursor is behind the
 * read this tab already accepted. RisingWave takes the cursor and the messages
 * from separate change streams, so an answer can have a reply before it has
 * the read the person made just before it (the read's ack, or the cursor a
 * reply of their own moved, reached the ledger first). Its count is then from
 * the older cursor: replies the person already read count again. When the
 * ledger covers the row's latest activity the row is read
 * (adjudicateServedUnreadAgainstLedger); here, a row with activity past the
 * ledger's cursor keeps the unread fields it shows at that same activity (the
 * read cleared it, the live messages since counted in place), and the drift
 * check waits for an answer that has the read (checkInPlaceDrift).
 */
import type { InboxScopeReadFrontier } from "@botiverse/raft-shared";
import { inPlaceUnreadOf } from "./inboxInPlaceUnread";
import { inboxItemChannelId } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { getAcceptedReadState } from "./readStateSync";

type ConversationRow = Exclude<InboxItem, { kind: "mention_action" | "object" }>;

function isConversationRow(item: InboxItem): item is ConversationRow {
  return item.kind !== "mention_action" && item.kind !== "object";
}

/**
 * The scopes of served rows (index-aligned with their frontiers) whose read
 * cursor is older and lower than the accepted read, with activity past it.
 */
export function servedReadBehindScopes(
  serverId: string | null,
  items: readonly InboxItem[],
  frontiers: readonly (InboxScopeReadFrontier | undefined)[],
): Set<string> {
  const behind = new Set<string>();
  items.forEach((item, index) => {
    const served = frontiers[index];
    const scopeId = inboxItemChannelId(item);
    if (!scopeId || served?.kind !== "present" || !served.latestActivity) return;
    const ledger = getAcceptedReadState(serverId, scopeId);
    if (!ledger || ledger.markedUnread || ledger.readStateVersion <= served.readStateVersion) return;
    const ledgerSeq = BigInt(ledger.maxReadSeq);
    if (ledgerSeq > BigInt(served.maxReadSeq) && ledgerSeq < BigInt(served.latestActivity.seq)) behind.add(scopeId);
  });
  return behind;
}

/**
 * A reset answer, after the live-activity holds (`preserved`): each row of a
 * read-behind scope that this list shows at the same activity keeps its
 * unread fields, when they count no more than the answer's (the older cursor
 * can only add). `totalUnreadDelta` is added to the preserved one.
 */
export function keepUnreadOverReadBehind(
  preserved: { items: InboxItem[]; totalUnreadDelta: number },
  current: readonly InboxItem[],
  behind: ReadonlySet<string>,
): { items: InboxItem[]; totalUnreadDelta: number } {
  if (behind.size === 0) return preserved;
  let delta = 0;
  const items = preserved.items.map((item) => {
    const scopeId = isConversationRow(item) ? inboxItemChannelId(item) : null;
    if (!isConversationRow(item) || !scopeId || !behind.has(scopeId)) return item;
    const shown = current.find((row): row is ConversationRow => isConversationRow(row) && row.kind === item.kind && inboxItemChannelId(row) === scopeId);
    if (!shown || shown.latestActivitySeq !== item.latestActivitySeq || shown.unreadCount > item.unreadCount) return item;
    delta += shown.unreadCount - item.unreadCount;
    return { ...item, ...inPlaceUnreadOf(shown) } as InboxItem;
  });
  return { items, totalUnreadDelta: preserved.totalUnreadDelta + delta };
}
