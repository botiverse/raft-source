/** An Activity row as a read-state projection of its conversation sets its unread fields (inboxStore hydration, applyReadStateProjection). */
import type { InboxItem } from "./inboxStore";
import { compareActivitySeq } from "./activitySeq";
import { projectionCoversActivity, projectionProvesLowering } from "./readStateSync";
import type { ReadStateProjection } from "./readStateSync";

// Stryker disable all: pure Activity-row projection glue is covered by read-state behavior tests; surviving mutants here are identity/no-op variants or mention_action type narrowing.
export function projectInboxItem(item: InboxItem, projection: ReadStateProjection, loadedSeqOf?: (messageId: string) => number | null): InboxItem {
  // #triage:#244: a row with a message the loaded messages lack (never received here) keeps its count.
  if (item.kind === "mention_action" || item.kind === "object" || !projectionCoversActivity(projection, item.readStateLatestActivitySeq)) return item;
  // #triage:#244 (AndyLok's 1,215 projection lowerings, served 53 kept at 1):
  // a count BELOW the row's is only taken when the read covers the row's
  // newest known activity, or the complete loaded window (no gap, reaches the
  // latest and back to the read) has that activity's message loaded. Unknown
  // activity (no seq on the row, and its last message not loaded here) or an
  // incomplete window keeps the row's count.
  const lowers = projection.unreadCount < item.unreadCount || (item.hasMention && !projection.hasMention);
  if (lowers && !projectionProvesLowering(projection, proofActivitySeq(item, loadedSeqOf))) return item;
  const nextFirstMentionMessageId = projection.hasMention ? projection.firstMentionMessageId : null;
  if (
    item.unreadCount === projection.unreadCount
    && item.firstUnreadMessageId === projection.firstUnreadMessageId
    && item.firstMentionMessageId === nextFirstMentionMessageId
    && item.hasMention === projection.hasMention
  ) {
    return item;
  }
  return {
    ...item,
    unreadCount: projection.unreadCount,
    firstUnreadMessageId: projection.firstUnreadMessageId,
    firstMentionMessageId: nextFirstMentionMessageId,
    hasMention: projection.hasMention,
  } as InboxItem;
}
// Stryker restore all

/**
 * The row's newest known activity seq in its own scope's seq domain: its
 * read-state seq; null when unknown. Not the display `latestActivitySeq`: a
 * reply-less thread's is its parent channel's (inboxStore), another domain.
 */
export function newestKnownActivitySeq(item: InboxItem): string | null {
  if (item.kind === "mention_action" || item.kind === "object") return null;
  const seq = item.readStateLatestActivitySeq;
  return typeof seq === "string" && compareActivitySeq(seq, "0") >= 0 ? seq : null;
}

/**
 * The activity seq a lowering is proven against (projectInboxItem), and the
 * one the lowered-row report judges coverage by: the row's newest known
 * activity seq, else its last message's seq when this tab has it loaded.
 */
export function proofActivitySeq(item: InboxItem, loadedSeqOf?: (messageId: string) => number | null): string | null {
  return newestKnownActivitySeq(item) ?? loadedLastMessageSeq(item, loadedSeqOf);
}

/** The seq of the row's last message when this tab has it loaded (a row served without activity seqs). */
function loadedLastMessageSeq(item: InboxItem, loadedSeqOf: ((messageId: string) => number | null) | undefined): string | null {
  if (!loadedSeqOf) return null;
  const messageId = item.kind === "thread" ? item.latestActivityMessageId : item.kind === "channel" || item.kind === "dm" ? item.lastMessageId : null;
  const seq = messageId ? loadedSeqOf(messageId) : null;
  return seq == null ? null : String(seq);
}
