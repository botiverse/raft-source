// The ledger's adjudication of a served Activity row (moved out of inboxStore).
import type { InboxScopeReadFrontier } from "@botiverse/raft-shared";
import { inboxItemChannelId } from "./inboxItem";
import { isUnreadInboxFilter } from "./inboxLivePatch";
import type { InboxFilter, InboxItem } from "./inboxStore";
import { getAcceptedReadState } from "./readStateSync";

/**
 * A served Activity row is one consistent generation (RisingWave reads are
 * checkpoint-consistent), but it can be OLDER than what this client already
 * knows: the client's own read reaches the ledger through its ack before
 * RisingWave has ingested the cursor. An older generation must not override a
 * newer one, so the ledger adjudicates such rows: when its cursor already
 * covers the row's latest activity, the row is read. A row the ledger knows
 * nothing newer about, or whose latest activity is beyond the ledger's cursor,
 * is served as-is (there is genuinely unread content).
 */
export function adjudicateServedUnreadAgainstLedger(
  serverId: string | null,
  items: InboxItem[],
  servedFrontiers: readonly (InboxScopeReadFrontier | undefined)[],
  filter: InboxFilter,
): { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number } {
  let suppressedCount = 0;
  let suppressedUnreadCount = 0;
  const nextItems: InboxItem[] = [];
  items.forEach((item, index) => {
    const served = servedFrontiers[index];
    const scopeId = inboxItemChannelId(item);
    const ledger = scopeId ? getAcceptedReadState(serverId, scopeId) : null;
    const latestSeq = served?.kind === "present" ? served.latestActivity?.seq ?? null : null;
    if (
      !ledger
      || served?.kind !== "present"
      || ledger.readStateVersion <= served.readStateVersion
      || latestSeq === null
      || BigInt(ledger.maxReadSeq) < BigInt(latestSeq)
      || item.unreadCount === 0
    ) {
      nextItems.push(item);
      return;
    }
    suppressedUnreadCount += item.unreadCount;
    if (isUnreadInboxFilter(filter)) {
      suppressedCount += 1;
      return;
    }
    nextItems.push({
      ...item,
      unreadCount: 0,
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      hasMention: false,
    } as InboxItem);
  });
  return { items: nextItems, suppressedCount, suppressedUnreadCount };
}
