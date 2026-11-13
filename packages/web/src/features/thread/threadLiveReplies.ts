import type { Message } from "../../store/messageStore";
import { mergeThreadMessages } from "./threadMessages";

/** Batches the read write for a burst of live replies landing in view. */
export const THREAD_LIVE_REPLY_READ_DEBOUNCE_MS = 500;

/**
 * Shared ingest for a live reply arriving on EITHER `message:new` or
 * `thread:updated`. Returns the next list and whether to bump the "new messages"
 * count.
 *
 * Why both events (the bug this fixes): the open ThreadPanel renders from local
 * state and originally depended on `message:new` for live replies. But for a
 * thread whose PARENT is a DM or private channel, the server emits `message:new`
 * only to thread FOLLOWERS' user rooms — never the thread channel room the open
 * panel joined — so a viewer who merely opened the thread (didn't follow it)
 * never receives the reply and the panel stays stale until re-open.
 * `thread:updated` reliably reaches EVERY viewer (public parent → parent channel
 * room; DM/private parent → each participant's user room) and carries the full
 * reply, so both handlers now funnel through here.
 *
 * Because both events fire for a public thread, counting must be de-duped ACROSS
 * entries and ACROSS orders. List-id membership is not enough: a reply beyond a
 * bounded newer window is intentionally NOT inserted (surfaced as "new"), so it
 * would never be in the list to de-dup against. So the count is guarded by an
 * explicit `countedReplyIds` set (owned by the open-thread effect, independent of
 * the visible window): each reply id bumps the count AT MOST ONCE. Mirrors the
 * original `message:new` seq-gap rule.
 */
export function ingestThreadLiveReply(
  state: { messages: Message[]; seenReplyIds: Set<string> },
  reply: Message,
  opts: { hasNewer: boolean; isNearBottom: boolean },
): { messages: Message[]; countedNew: boolean; landedInView: boolean } {
  // "Seen" separates ALREADY-HANDLED from NEEDS-ALERT (the two must not be
  // conflated). A reply is seen if we ingested it on an earlier frame OR it is
  // already in the loaded window (initial fetch / a prior event). A seen reply is
  // never counted again — this is what stops the same reply being counted twice
  // across message:new + thread:updated (either order), stops a bottom-received
  // reply being re-counted after the reader scrolls up, and stops a re-play of an
  // already-loaded reply from counting. seenReplyIds is tracked independently of
  // the visible window, so a gap reply that was never inserted also can't recount.
  const alreadySeen = state.seenReplyIds.has(reply.id) || state.messages.some((msg) => msg.id === reply.id);
  state.seenReplyIds.add(reply.id);

  const currentMaxSeq = state.messages.reduce((max, msg) => Math.max(max, msg.seq ?? 0), 0);
  if (opts.hasNewer && reply.seq && currentMaxSeq > 0 && reply.seq > currentMaxSeq + 1) {
    // Beyond a bounded newer window: never insert; surface as "new" only the
    // first time this reply is seen.
    return { messages: state.messages, countedNew: !alreadySeen, landedInView: false };
  }

  const messages = mergeThreadMessages(state.messages, [reply]);
  if (alreadySeen) return { messages, countedNew: false, landedInView: false };
  // First time handling this reply: alert only if the reader wouldn't already see
  // it land (i.e. they're scrolled up or a newer window is loaded). Either way it
  // is now marked seen (above), so a later frame can't re-count it.
  const countedNew = !opts.isNearBottom || opts.hasNewer;
  return { messages, countedNew, landedInView: !countedNew };
}

/**
 * Debounces read writes for replies landing in view: a burst becomes one write
 * of the highest seq. `flush` writes any pending seq now (panel teardown: the
 * reader already saw it).
 */
export function createThreadLiveReadBatcher(
  persist: (seq: number) => void,
  delayMs = THREAD_LIVE_REPLY_READ_DEBOUNCE_MS,
): { add: (seq: number) => void; flush: () => void } {
  let pendingSeq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pendingSeq > 0) persist(pendingSeq);
    pendingSeq = 0;
  };
  return {
    add: (seq) => {
      pendingSeq = Math.max(pendingSeq, seq);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}

/**
 * Wire the two live-reply socket entries for an open thread through the shared
 * ingest, sharing ONE seen-id set so a reply delivered on both events counts at
 * most once. Extracted so the wiring itself is testable with a fake socket (the
 * dedup lives here, not just in the pure helper). Returns an unsubscribe.
 */
export interface ThreadLiveReplySocket {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export function subscribeThreadLiveReplies(params: {
  socket: ThreadLiveReplySocket;
  threadChannelId: string;
  parentMessageId: string | null;
  /** Normalize + gate a raw payload to a reply that belongs to THIS thread, else null. */
  normalizeReply: (raw: unknown) => Message | null;
  getScroll: () => { hasNewer: boolean; isNearBottom: boolean };
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  bumpNewCount: () => void;
  /** A first-seen reply landed where the reader sees it (bottom of the latest window). */
  onReplyLandedInView?: (seq: number) => void;
  /** Every delivery of a reply, on either event (message:new doesn't reach everyone; see above). */
  onReply?: (reply: Message) => void;
}): () => void {
  const seenReplyIds = new Set<string>();
  const ingest = (reply: Message) => {
    params.onReply?.(reply);
    params.setMessages((prev) => {
      const { messages, countedNew, landedInView } = ingestThreadLiveReply({ messages: prev, seenReplyIds }, reply, params.getScroll());
      if (countedNew) params.bumpNewCount();
      if (landedInView && reply.seq) params.onReplyLandedInView?.(reply.seq);
      return messages;
    });
  };
  const onMessageNew = (payload: unknown) => {
    const reply = params.normalizeReply(payload);
    if (reply) ingest(reply);
  };
  const onThreadUpdated = (payload: unknown) => {
    const frame = payload as { threadChannelId?: unknown; parentMessageId?: unknown; latestReply?: unknown } | null;
    if (!frame || typeof frame !== "object") return;
    const matchesThisThread =
      frame.threadChannelId === params.threadChannelId
      || (frame.parentMessageId != null && frame.parentMessageId === params.parentMessageId);
    if (!matchesThisThread) return;
    const reply = params.normalizeReply(frame.latestReply);
    if (reply) ingest(reply);
  };
  params.socket.on("message:new", onMessageNew);
  params.socket.on("thread:updated", onThreadUpdated);
  return () => {
    params.socket.off("message:new", onMessageNew);
    params.socket.off("thread:updated", onThreadUpdated);
  };
}
