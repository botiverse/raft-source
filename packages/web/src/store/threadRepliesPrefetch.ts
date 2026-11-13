/**
 * Fetch-at-click for a thread's replies (#triage:8c0d2318): the click that
 * opens a thread (threadStore.openThread) sends the replies' first request
 * while the panel renders, instead of after it mounted. The panel's loader
 * (useThreadTimeline) asks for the same request (threadRepliesRequest) and
 * takes the one under way, or already answered, instead of sending its own
 * (heldRead.ts). Replies posted after that read, before the panel joined the
 * thread's room, come from a catch-up read after the page (the loader's).
 *
 * Sent at every open, also over replies cached in the thread's bucket (a
 * channel load brings a summary's last replies there): the panel draws those
 * at once and refreshes them with this read, but takes it only while it is
 * still in flight (takeInFlightThreadRepliesPrefetch). An answer that came in
 * before the panel mounted may predate an edit, reaction or delete applied
 * to those rows since; the panel reads again instead.
 */
import { buildMessageContextRequest } from "../components/message/messageContextRequest";
import { SHORT_MESSAGE_ID, THREAD_LATEST_WINDOW_LIMIT } from "../features/thread/threadMessages";
import { addViewSwitchMatch, threadView } from "../observability/viewSwitchSpan";
import { createHeldRead } from "./heldRead";
import type { HeldReadRequest, TakenRead } from "./heldRead";
import { useMessageStore } from "./messageStore";

const slot = createHeldRead();

/** The reply the open focuses: not the parent (by its full id or its short id). */
export function threadInitialFocusId(focusedMessageId: string | null, parentMessageId: string | null): string | null {
  if (!focusedMessageId || focusedMessageId === parentMessageId) return null;
  if (SHORT_MESSAGE_ID.test(focusedMessageId) && parentMessageId?.startsWith(focusedMessageId)) return null;
  return focusedMessageId;
}

/** The replies' first request: the focused reply's context, or the latest page. */
export function threadRepliesRequest(threadChannelId: string, initialFocusId: string | null): HeldReadRequest {
  return initialFocusId
    ? buildMessageContextRequest(initialFocusId, threadChannelId) as HeldReadRequest
    : { url: `/messages/channel/${threadChannelId}?limit=${THREAD_LATEST_WINDOW_LIMIT}` };
}

/**
 * At the open: send the replies' first request, network only (the panel
 * applies it). With cached replies it is their refresh, which the panel joins
 * only while it is in flight.
 */
export function prefetchThreadReplies(threadChannelId: string, parentMessageId: string, focusedMessageId: string | null): void {
  const focusId = threadInitialFocusId(focusedMessageId, parentMessageId);
  slot.send(threadRepliesRequest(threadChannelId, focusId), useMessageStore.getState().currentUserId);
}

/**
 * openThread's lookup by the parent answered with the thread's channel: the
 * replies' request goes out before the panel renders with it, when that open
 * is still the one on screen and had no channel yet. The thread's channel
 * joins the switch first (web.view.switch), so the request counts for it.
 */
export function prefetchResolvedThreadReplies(
  open: { openServerSlug: string | null; openParentMessageId: string | null; openThreadChannelId: string | null; focusedMessageId: string | null },
  routeServerSlug: string | null,
  parentMessageId: string,
  threadChannelId: string,
): void {
  if (open.openServerSlug !== routeServerSlug || open.openParentMessageId !== parentMessageId || open.openThreadChannelId) return;
  addViewSwitchMatch(threadView(parentMessageId), threadChannelId);
  prefetchThreadReplies(threadChannelId, parentMessageId, open.focusedMessageId);
}

/** The panel's loader: the request sent at the open for this same request, once, or null. */
export function takeThreadRepliesPrefetch(request: HeldReadRequest): TakenRead | null {
  return slot.take(request, useMessageStore.getState().currentUserId);
}

/**
 * The panel's refresh over cached replies: the open's request only while it
 * is in flight. Those rows are on screen and take live edits, reactions and
 * deletes; an answer already in may predate them, so it is dropped and the
 * panel reads again.
 */
export function takeInFlightThreadRepliesPrefetch(request: HeldReadRequest): TakenRead | null {
  return slot.takeInFlight(request, useMessageStore.getState().currentUserId);
}

export function __resetThreadRepliesPrefetchForTest(): void {
  slot.reset();
}
