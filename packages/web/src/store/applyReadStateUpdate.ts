import { useServerStore } from "./serverStore";
import { useMessageStore } from "./messageStore";
import { useThreadStore } from "./threadStore";
import { useInboxStore } from "./inboxStore";
import { compareActivitySeq } from "./activitySeq";
import { noteInPlaceReadState } from "./inboxInPlaceUnread";
import { inboxItemChannelId } from "./inboxItem";
import { consumeReadStateUpdate } from "./readStateSync";
import type { ReadStateUpdate } from "./readStateSync";

export function applyReadStateUpdate(update: ReadStateUpdate) {
  const currentServerId = useServerStore.getState().current?.id;
  if (update.serverId !== currentServerId) return;
  if (consumeReadStateUpdate(update) !== "accepted") return;
  if (!update.markedUnread) noteInPlaceReadState(update.scopeId);
  const projection = useMessageStore.getState().applyReadStateProjection(update.scopeId);
  if (!projection.complete) {
    // This tab cannot count the thread's unread from loaded replies (read in
    // another tab, Activity "mark all read"); use the server's count so the
    // channel "N new" badge does not keep a stale number.
    const latest = useThreadStore.getState().followedThreads
      .find((thread) => thread.threadChannelId === update.scopeId)?.latestActivitySeq;
    // A read-all zero describes its captured frontier, not a newer reply this
    // tab already knows about. Loaded windows project that reply above; an
    // unloaded thread must not erase it just because the zero receipt is late.
    const hasNewerActivity = latest != null && BigInt(latest) > BigInt(update.maxReadSeq);
    if (update.unreadCount !== undefined && !(update.unreadCount === 0 && hasNewerActivity)) {
      useThreadStore.getState().applyServerThreadUnread(update.scopeId, update.unreadCount);
    }
    clearActivityRowReadThrough(update);
    return;
  }
  useInboxStore.getState().applyReadStateProjection(update.scopeId, projection);
  useThreadStore.getState().applyReadStateProjection(update.scopeId, projection);
}

/**
 * A read this tab cannot project (the conversation's messages are not loaded
 * here: read on another device or tab) still clears its Activity row when it
 * covers the row's latest message: nothing after the read point is left to
 * count. Covered = the row's read-state frontier (the cursor's seq domain; the
 * display seq of a zero-reply thread is its parent's) and its display seq,
 * which a live reply advances, are both at or below the read. A row with a
 * newer message, or a read the server says leaves some unread, keeps its
 * count for the re-read.
 */
function clearActivityRowReadThrough(update: ReadStateUpdate): void {
  if (update.markedUnread || (update.unreadCount ?? 0) > 0) return;
  const row = useInboxStore.getState().items.find((item) =>
    item.kind !== "mention_action" && item.kind !== "object" && inboxItemChannelId(item) === update.scopeId);
  if (!row || row.kind === "mention_action" || row.kind === "object") return;
  const readSeq = String(update.maxReadSeq);
  const covered = (seq: string | null | undefined) => seq != null && compareActivitySeq(seq, readSeq) <= 0;
  if (!covered(row.readStateLatestActivitySeq) || !covered(row.latestActivitySeq)) return;
  useInboxStore.getState().applyReadStateProjection(update.scopeId, {
    unreadCount: 0, hasMention: false, firstUnreadMessageId: null, firstMentionMessageId: null, complete: true,
  });
}
