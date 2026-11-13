/**
 * Fetch-at-click for a conversation's first window (#triage:8c0d2318): the
 * click (navigation/conversationPrefetch.ts) sends the read the view's loader
 * will send, and loadMessages / loadMessageWindowSilent / loadMessageContext
 * take it at mount instead of sending their own (heldRead.ts). Everything
 * else (opening the channel in the store, unread and read marking, the
 * history-read bookkeeping) still happens at mount.
 */
import { createHeldRead } from "./heldRead";
import type { HeldReadRequest, TakenRead } from "./heldRead";
import { noteMessageHistoryRequest } from "./messageStore";
import type { Message } from "./messageStore";

const slot = createHeldRead();

/** loadMessages' latest page. */
export function latestPageRequest(channelId: string): HeldReadRequest {
  return { url: `/messages/channel/${channelId}?limit=50` };
}

/** loadMessageContext's and loadMessageWindowSilent's window around a message. */
export function messageWindowRequest(channelId: string, messageId: string): HeldReadRequest {
  return { url: `/messages/context/${messageId}`, config: { params: { channelId } } };
}

/**
 * Sent at the click. It is a history read from now on, for the sync horizon
 * rules (startingSyncHorizon, loadMessages' page horizon); the loader counts
 * it again at mount, which is only stricter. `bucket` is the conversation's
 * list at the click: rows after its newest arrived since (withLiveRowsAfter).
 */
export function prefetchMessagePage(request: HeldReadRequest, userId: string | null, bucket: readonly Message[] | undefined): void {
  noteMessageHistoryRequest();
  slot.send(request, userId, maxSeq(bucket ?? []));
}

function maxSeq(messages: readonly Message[]): number {
  return Math.max(0, ...messages.map((message) => message.seq || 0));
}

export function takeMessagePage(request: HeldReadRequest, userId: string | null): TakenRead | null {
  return slot.take(request, userId);
}

/**
 * For a cached list (loadMessages' refresh): only a read still in flight. Its
 * rows are on screen, so an edit, reaction or delete applied to them after
 * an answer came in would be undone by that answer (withLiveRowsAfter keeps
 * only rows newer than the click); the refresh reads again instead.
 */
export function takeInFlightMessagePage(request: HeldReadRequest, userId: string | null): TakenRead | null {
  return slot.takeInFlight(request, userId);
}

/**
 * A page read at the click is applied later, at mount: the live rows that
 * reached the bucket since the click (message:new: newer than the bucket's
 * newest then, and than the page's last row) stay, after it, instead of being
 * replaced with the older page. Rows from an earlier visit do not: the page
 * says what is there now (one deleted since is gone).
 */
export function withLiveRowsAfter(page: Message[], bucket: readonly Message[] | undefined, seqAtSend: number): Message[] {
  const after = Math.max(maxSeq(page), seqAtSend);
  const known = new Set(page.map((message) => message.id));
  const newer = (bucket ?? []).filter((message) => (message.seq ?? 0) > after && !known.has(message.id));
  return newer.length === 0 ? page : [...page, ...newer.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))];
}

export function __resetMessagePagePrefetchForTest(): void {
  slot.reset();
}
