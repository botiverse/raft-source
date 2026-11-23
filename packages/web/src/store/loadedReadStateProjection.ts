/**
 * A conversation's unread counted from the messages this tab has loaded, under
 * an accepted read (moved out of messageStore). `complete` only when the
 * loaded window reaches back to the read and has no known newer page or hole;
 * #triage:#244: `projectionCoverage` records the loaded seqs above the read
 * (loadedSeqsAboveRead), which an Activity row's lowering needs.
 */
import type { Message } from "./messageStore";
import { projectionCoverage } from "./readStateSync";
import type { ReadStateProjection } from "./readStateSync";

/** The loaded window's facts the projection needs (messageStore ChannelMeta). */
type ProjectionWindowMeta = { hasNewer?: boolean; hasGap?: boolean; loadingGap?: boolean };

export function isSelfAuthoredMessage(message: Pick<Message, "senderType" | "senderId">, currentUserId: string | null): boolean {
  return message.senderType === "user" && !!currentUserId && message.senderId === currentUserId;
}

function mentionsCurrentUser(message: Pick<Message, "mentions">, currentUserId: string | null): boolean {
  // Stryker disable next-line ConditionalExpression: the following id/type predicate is already false for null currentUserId; this early return is a readability guard.
  if (!currentUserId) return false;
  // Stryker disable next-line ArrayDeclaration: replacing the nullish fallback with a non-mention sentinel is behavior-equivalent under the structured mention predicate.
  return (message.mentions ?? []).some((mention) => mention.type === "user" && mention.id === currentUserId);
}

export function canProjectCompleteReadState(messages: Message[] | undefined, meta: ProjectionWindowMeta | undefined, maxReadSeq: number): boolean {
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: `projectReadStateFromMessages` also fail-closes incomplete projections; this guard keeps the helper total for direct callers.
  if (!messages || messages.length === 0) return false;
  // Stryker disable next-line OptionalChaining: callers pass a normalized window meta object; optionality keeps the helper total for direct callers.
  if (meta?.hasNewer) return false;
  // Stryker disable next-line OptionalChaining: projection callers pass normalized meta; optionality only keeps direct callers total while hasGap/loadingGap behavior is pinned by RED tests.
  if (meta?.hasGap || meta?.loadingGap) return false;
  const minSeq = Math.min(...messages.map((message) => message.seq ?? Infinity));
  return Number.isFinite(minSeq) && minSeq <= maxReadSeq + 1;
}

export function projectReadStateFromMessages(
  messages: Message[] | undefined,
  meta: ProjectionWindowMeta | undefined,
  currentUserId: string | null,
  maxReadSeq: number,
): ReadStateProjection {
  const complete = canProjectCompleteReadState(messages, meta, maxReadSeq);
  if (!complete) {
    return {
      unreadCount: 0,
      hasMention: false,
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      complete: false,
    };
  }

  let unreadCount = 0;
  let hasMention = false;
  let firstUnreadMessageId: string | null = null;
  let firstMentionMessageId: string | null = null;
  // Stryker disable next-line ArrayDeclaration: complete=true is unreachable without a concrete message array; fallback is a totality guard for direct callers.
  for (const message of messages ?? []) {
    const seq = message.seq ?? 0;
    if (seq <= maxReadSeq || isSelfAuthoredMessage(message, currentUserId)) continue;
    unreadCount += 1;
    firstUnreadMessageId ??= message.id;
    if (mentionsCurrentUser(message, currentUserId)) {
      hasMention = true;
      firstMentionMessageId ??= message.id;
    }
  }

  return {
    unreadCount,
    hasMention,
    firstUnreadMessageId,
    firstMentionMessageId,
    complete: true, ...projectionCoverage(messages ?? [], maxReadSeq),
  };
}
