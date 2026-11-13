/**
 * Thread-replies read model (task #47).
 *
 * CONTRACT (agreed with @赵梓淇, RFC 043 Appendix B — `Message × Replies =
 * SyncScope`): the inline preview is the **latest-N read-model of one thread
 * scope**. Consumers know ONLY this interface — never where the data came from.
 * Today the source is the live path (initial SQL top-N + `thread:updated`
 * increments); when sync-core messages reaches sole-apply, the source swaps to
 * the canonical fold and no consumer changes. That is the whole point of putting
 * the contract here rather than patching a store ad hoc.
 *
 * TWO GATES live in this module, so they hold structurally instead of depending
 * on every caller remembering them:
 *
 *  1. TOP-N BY SEQ, never a naive unshift. A late or reordered `thread:updated`
 *     frame carries an OLDER seq; unshifting it would promote a stale reply into
 *     the newest slot and silently corrupt the preview. Insert by seq, keep the
 *     newest N. (Idempotence is not ordering — dedupe by id buys the first, not
 *     the second. Learned on #4612, where the inbox reducer had exactly this hole.)
 *
 *  2. SNAPSHOT WATERMARK. The initial SQL snapshot records its max seq. Socket
 *     frames are applied only when `seq > watermark`. On reconnect the server
 *     replays a window of history frames; without the watermark those old replies
 *     get patched back into the preview and duplicate.
 */

import { isOlderCardRevision } from "./messageCardRevision";

export interface ThreadReplyPreview {
  messageId: string;
  seq: number;
  preview: string;
  senderId: string;
  senderType: "user" | "agent" | "system" | "external_projection";
  senderName: string;
  /** Explicit UI label. Older servers may omit it, so consumers fall back to senderName. */
  senderDisplayName?: string;
  senderAvatarUrl: string | null;
  createdAt: string;
  /** Content revision; optional for snapshots from older servers. */
  updatedAt?: string;
  /** RFC 082: the card revision this preview was taken from, once a card update reached it. */
  cardRevision?: number;
}

export interface ThreadRepliesSnapshotOptions {
  historyLimited?: boolean;
  principalId?: string | null;
  parentMessageId?: string | null;
  threadChannelId?: string | null;
  epoch?: string | null;
}

export interface ThreadRepliesLiveFrameOptions {
  source?: "thread-updated" | "sync-core";
}

/** The latest-N read-model for a single thread scope. */
export interface ThreadRepliesScope {
  /** Newest-last (display order). Never longer than the cap. */
  replies: ThreadReplyPreview[];
  replyCount: number;
  /**
   * The SNAPSHOT SEAM: the highest seq present in the initial SQL snapshot.
   *
   * FIXED — it does NOT advance as live frames are applied, and that distinction
   * is load-bearing. A running high-water mark looks equivalent and is not: if
   * seq 9 is delivered before seq 8 (reordering, both genuinely new), a running
   * mark would rise to 9 and then discard 8 as "old" — silently losing a real
   * reply. The seam only answers "was this already in my snapshot?", which is
   * exactly the reconnect-replay question. Live duplicates are caught by message
   * IDENTITY below, not by seq magnitude.
   *
   * (My own permutation test caught this: I first wrote it as a running mark and
   * the out-of-order case lost a reply.)
   */
  snapshotSeq: number;
  historyLimited?: boolean;
  principalId?: string | null;
  parentMessageId?: string | null;
  threadChannelId?: string | null;
  epoch?: string | null;
}

export const INLINE_REPLY_CAP = 3;

export function emptyThreadRepliesScope(): ThreadRepliesScope {
  return { replies: [], replyCount: 0, snapshotSeq: 0 };
}

/**
 * Ingest the initial snapshot (SQL top-N). Establishes the watermark at the
 * highest seq present, so any socket frame at or below it is already accounted
 * for.
 */
export function hydrateThreadRepliesScope(
  replies: ThreadReplyPreview[],
  replyCount: number,
  options: ThreadRepliesSnapshotOptions = {},
): ThreadRepliesScope {
  const orderedSnapshot = sortBySeqAscending(replies);
  const ordered = orderedSnapshot
    .filter(isConversationReply)
    .slice(-INLINE_REPLY_CAP);
  return {
    replies: ordered,
    replyCount,
    // The seam is the newest seq the snapshot actually contained.
    snapshotSeq: orderedSnapshot.reduce((max, reply) => Math.max(max, reply.seq), 0),
    ...(options.historyLimited === undefined ? {} : { historyLimited: options.historyLimited }),
    ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
    ...(options.parentMessageId === undefined ? {} : { parentMessageId: options.parentMessageId }),
    ...(options.threadChannelId === undefined ? {} : { threadChannelId: options.threadChannelId }),
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
  };
}

/**
 * Apply one live reply frame.
 *
 * Returns the SAME scope object when the frame changes nothing (stale, duplicate,
 * or below the watermark). Reference identity is load-bearing: the caller patches
 * a map of scopes per message, and an unchanged scope MUST keep its reference or
 * the memoized message row re-renders for a reply that belongs to another thread
 * (#4434 class).
 */
export function applyThreadReplyFrame(
  scope: ThreadRepliesScope,
  reply: ThreadReplyPreview,
  /**
   * The AUTHORITATIVE reply count carried by the frame (`thread:updated` spreads
   * `threadInfo`, which includes it). We take it rather than derive it.
   *
   * Deriving it (`scope.replyCount + 1`) is what @Android-Developer-2 caught:
   * once a reply is EVICTED from the N-window, an identity check against the
   * window no longer sees it, so a replayed frame for that evicted reply takes
   * the "new" branch and DOUBLE-COUNTS. Window-scoped identity cannot be the
   * dedupe authority, because the window forgets. The server's count cannot
   * drift, so we adopt it and the whole class of double-count disappears.
   */
  authoritativeReplyCount: number,
  _options: ThreadRepliesLiveFrameOptions = {},
): ThreadRepliesScope {
  // GATE 2 — the snapshot seam. A frame at or below the snapshot's newest seq was
  // already counted by the snapshot, so a reconnect replaying that history is a
  // no-op. NOTE this compares against the FIXED seam, never a running maximum:
  // comparing against a running max would discard a genuinely new reply that
  // merely arrived out of order (see snapshotSeq's note).
  if (reply.seq <= scope.snapshotSeq) return scope;

  const nextReplyCount = Math.max(scope.replyCount, authoritativeReplyCount);
  if (!isConversationReply(reply)) {
    if (nextReplyCount === scope.replyCount) return scope;
    return {
      ...scope,
      replyCount: nextReplyCount,
    };
  }

  // GATE 1 — dedupe by identity WITHIN the window, then insert BY SEQ and keep the
  // newest N. Not an unshift: a frame arriving late lands in its rightful position
  // rather than leading the window, so arrival order cannot decide the display.
  const withoutDuplicate = scope.replies.filter((existing) => existing.messageId !== reply.messageId);
  const replies = sortBySeqAscending([...withoutDuplicate, reply]).slice(-INLINE_REPLY_CAP);

  // A replayed frame for an EVICTED reply reaches here (the window no longer holds
  // it), but sorting drops it straight back out — so the visible window is
  // unchanged. Return the SAME scope in that case: identical window + identical
  // authoritative count means nothing a message displays has changed, and churning
  // the reference would re-render the row for nothing (contract §4, render isolation).
  // MONOTONIC apply, not a naked overwrite. @HanXin / @Android-Developer-2 caught
  // this before it shipped: adopting the authoritative count fixes double-counting,
  // but ASSIGNING it lets an out-of-order frame carrying an OLDER authoritative
  // count roll the total backwards — the count would visibly tick down and back up.
  //
  // This is "idempotence is not monotonicity" for the third time on this feature,
  // now on the count field: the seq gate orders the WINDOW, and nothing was ordering
  // the COUNT. Take the max — add-only, so a stale frame cannot regress it.
  //
  // Arrival frames remain add-only. Body edits take the separate identity-
  // matched path below, ordered by the server's monotonic updatedAt, without
  // advancing this arrival seam or changing reply counts.
  const windowUnchanged = replies.length === scope.replies.length
    && replies.every((next, i) => next.messageId === scope.replies[i].messageId);
  if (windowUnchanged && nextReplyCount === scope.replyCount) return scope;

  return {
    replies,
    replyCount: nextReplyCount,
    snapshotSeq: scope.snapshotSeq,
    ...(scope.historyLimited === undefined ? {} : { historyLimited: scope.historyLimited }),
    ...(scope.principalId === undefined ? {} : { principalId: scope.principalId }),
    ...(scope.parentMessageId === undefined ? {} : { parentMessageId: scope.parentMessageId }),
    ...(scope.threadChannelId === undefined ? {} : { threadChannelId: scope.threadChannelId }),
    ...(scope.epoch === undefined ? {} : { epoch: scope.epoch }),
  };
}

function sortBySeqAscending(replies: ThreadReplyPreview[]): ThreadReplyPreview[] {
  // Deterministic: seq is unique per message, so no tiebreak is needed — and a
  // wall-clock tiebreak would be exactly the mistake seq exists to avoid.
  return [...replies].sort((a, b) => a.seq - b.seq);
}

function isConversationReply(reply: ThreadReplyPreview): boolean {
  return reply.senderType !== "system";
}


export function threadReplyContentVersion(reply: Pick<ThreadReplyPreview, "updatedAt" | "createdAt">): number {
  const version = Date.parse(reply.updatedAt ?? reply.createdAt);
  return Number.isFinite(version) ? version : 0;
}

/** Edit an already retained reply; never insert, reorder or change counts. */
export function applyThreadReplyUpdate(
  scope: ThreadRepliesScope,
  update: { messageId: string; seq: number; preview: string; updatedAt: string; cardRevision?: number },
): ThreadRepliesScope {
  const version = Date.parse(update.updatedAt);
  if (!Number.isFinite(version)) return scope;
  const index = scope.replies.findIndex((reply) => reply.messageId === update.messageId && reply.seq === update.seq);
  const existing = scope.replies[index];
  // RFC 082: an older card revision never replaces a newer one, whatever its updatedAt (the conversation's rows' rule).
  if (!existing || isOlderCardRevision(existing.cardRevision, update.cardRevision)) return scope;
  if (version <= threadReplyContentVersion(existing)) return scope;
  const replies = [...scope.replies];
  replies[index] = { ...existing, preview: update.preview, updatedAt: update.updatedAt,
    ...(update.cardRevision === undefined ? {} : { cardRevision: update.cardRevision }) };
  return { ...scope, replies };
}

/** A delayed HTTP snapshot must not roll back an accepted socket edit. */
export function retainNewerThreadReplyContent(next: ThreadRepliesScope, current: ThreadRepliesScope | null): ThreadRepliesScope {
  if (!current) return next;
  let changed = false;
  const replies = next.replies.map((reply) => {
    const existing = current.replies.find((old) => old.messageId === reply.messageId && old.seq === reply.seq);
    if (!existing || threadReplyContentVersion(existing) <= threadReplyContentVersion(reply)) return reply;
    changed = true;
    return { ...reply, preview: existing.preview, updatedAt: existing.updatedAt,
      ...(existing.cardRevision === undefined ? {} : { cardRevision: existing.cardRevision }) };
  });
  return changed ? { ...next, replies } : next;
}
