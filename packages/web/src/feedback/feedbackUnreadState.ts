import type { ProductFeedbackAppSource, ProductFeedbackAppUnreadEvent, ProductFeedbackUnreadEvent } from "@botiverse/raft-shared";
import api from "../api/client";
import {
  FEEDBACK_LIST_ALL_SOURCES,
  FEEDBACK_LIST_DEGRADED_OK,
  degradedRetryAfterMs,
  feedbackListUnread,
  feedbackUnreadCount,
  isDegradedFeedbackPage,
  isProductFeedbackAppSource,
} from "./productFeedbackListContract";
import type { ApiDegradedTicketPage, FeedbackListUnread, FeedbackUnreadBySource } from "./productFeedbackListContract";

// Shared by desktop/mobile notification hosts. Do not import the feedback SDK:
// the workspace and its CSS must stay behind the existing lazy boundary.
const listeners = new Set<() => void>();
let owner: string | null = null;
let unread = 0;
let consumers = 0;
let revision = 0;
let generation = 0;
let isCurrentUser = (_userId: string): boolean => false;
let pending: AbortController | null = null;
// While retained: the page's show/focus listeners (owed and safety reads).
let stopListening: (() => void) | null = null;
// A read asked for while the page is hidden runs when it shows.
let owedOnShow = false;
// When the count was last known fresh: a list read, a push, a ticket read.
let freshAt = 0;
// Each Hands app's total, once a list read has carried `unread_by_source`;
// the dot is their sum. Null until then (see "Every client's tickets" below).
let bySource: FeedbackUnreadBySource | null = null;

// The count is pushed: the server sends `product_feedback:unread` (shared
// productFeedbackUnread.ts, the total, never a delta) to the user's own
// connections when a Hands reply lands or the count changes elsewhere. The
// list (`GET /product-feedback/tickets?limit=1&sources=all`, for its totals) is read
// only when a pushed value may have been missed: once when retained (start,
// another account), on the socket's first connect and after each reconnect
// (socketBridge.ts; pushes are not replayed), and the feedback panel's own
// list read when it opens (handsFeedbackTransport.ts). There is no minute
// poll: one per tab was 9.69M calls in 30 days (proj-o11y #35).
//
// Push delivery is best-effort (a server emit lost between replicas, a
// socket that looks connected but is not), so a page that shows or gets
// focus reads once if nothing has refreshed the count for SAFETY_READ_MS.
const SAFETY_READ_MS = 30 * 60_000;
//
// Every client's tickets: the Feedback list merges every Hands app's
// (`?sources=all`, productFeedbackListContract.ts), so the dot counts every
// app's unread replies. A list read's first page carries `unread_by_source`,
// each app's total; they are kept per app, an app missing from it keeps its
// last value, and the dot is the sum. Then `product_feedback:unread` replaces
// the web's, `product_feedback:app_unread` that app's, and a ticket read the
// total of the ticket's app.
//
// FALLBACK, while the server sends no `unread_by_source` (it lands in a
// follow-up server PR; remove this then): the dot is as before, the web's
// total: a list read's `unread_total` (null: keep the count), web pushes and
// web ticket reads replace it, another app's push or ticket read is ignored.
//
// The list read needs Hands (route binding, then the list). When Hands was
// down every open tab's read failed with it, hundreds of 5xx in a few
// minutes (#triage:#111), and a reconnect storm must not repeat that. After a
// failure a read waits 1 min doubling to 10 min, or the server's Retry-After
// when that is longer (the binding error sends 5 s). One retry is scheduled
// for the end of the wait, so a start-up read failing in an outage does not
// leave the count unknown; any read asked for inside the wait is deferred to
// that one retry. A success, a ticket read or another account resets it.
// Every failure backs off, on purpose: a 401 is the client's to handle, and
// the rest (not configured, invalid) gain nothing from asking again soon.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;
let failures = 0;
let notBefore = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function retryAfterMs(error: unknown): number | null {
  const header = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers?.["retry-after"];
  const seconds = typeof header === "string" ? Number(header) : typeof header === "number" ? header : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, BACKOFF_MAX_MS) : null;
}

function cancelRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

/** The one retry at the end of the wait; idempotent. */
function scheduleRetry() {
  if (retryTimer !== null || !stopListening) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void refresh();
  }, Math.max(0, notBefore - Date.now()));
}

function backOff(retryAfter: number | null) {
  failures += 1;
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  notBefore = Date.now() + Math.max(exponential, retryAfter ?? 0);
  scheduleRetry();
}

function resetBackoff() {
  failures = 0;
  notBefore = 0;
  cancelRetry();
}

/** Tests only: forget the backoff (and its retry). */
export function __resetFeedbackUnreadBackoffForTest() {
  resetBackoff();
}

function emit() {
  for (const listener of listeners) listener();
}

function validCount(count: number) {
  return Number.isSafeInteger(count) && count >= 0;
}

/** A newer count than any list read in flight: those reads cannot overwrite it. */
function setFresh(count: number) {
  owedOnShow = false;
  freshAt = Date.now();
  revision += 1;
  unread = count;
  emit();
}

function sum(counts: FeedbackUnreadBySource) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/**
 * One app's total is known: the dot is the new sum. Fallback (no
 * `unread_by_source` yet): only the web's counts, as the whole dot.
 */
function setSourceFresh(source: ProductFeedbackAppSource, count: number) {
  if (bySource) {
    bySource = { ...bySource, [source]: count };
    setFresh(sum(bySource));
  } else if (source === "web") {
    setFresh(count);
  }
}

/** A real first list page's totals. */
function setListFresh(page: FeedbackListUnread) {
  if (page.bySource) {
    bySource = { ...bySource, ...page.bySource };
    setFresh(sum(bySource));
    return;
  }
  // Fallback: a server without `unread_by_source`; the page's total is the dot.
  bySource = null;
  if (page.total !== null) setFresh(page.total);
}

/**
 * Detail GET advances Hands' read-through cursor. Invalidate older list
 * reads. `count` is the total of `source`, the ticket's app.
 */
export function acceptFeedbackUnread(userId: string | null, count: number, source: ProductFeedbackAppSource = "web") {
  if (!userId || userId !== owner || !isCurrentUser(userId) || !validCount(count)) return;
  // Fallback: another app's ticket read says nothing the dot shows.
  if (!bySource && source !== "web") return;
  // A ticket read answered: Hands is back, reads need not wait.
  resetBackoff();
  setSourceFresh(source, count);
}

/**
 * The server's `product_feedback:unread` push (socketBridge.ts). It applies
 * only to the retained owner it names, while that is still the signed-in
 * user: after a token swap the old account's socket may still be connected.
 * Nothing retained, nothing applies. It does not end a backoff (it says
 * nothing about Hands' list), but it is a fresh count: the scheduled retry is
 * dropped, and a later read inside the wait schedules it again.
 */
export function acceptFeedbackUnreadPush(payload: Partial<ProductFeedbackUnreadEvent> | undefined) {
  const count = payload?.unreadTotal;
  if (!owner || payload?.userId !== owner || !isCurrentUser(owner)
    || typeof count !== "number" || !validCount(count)) return;
  cancelRetry();
  setSourceFresh("web", count);
}

/**
 * The server's `product_feedback:app_unread` push: a mobile App's total. It
 * names no user (the room does), so it applies while a retained owner is the
 * signed-in user. Only counted once a list read carried `unread_by_source`.
 */
export function acceptFeedbackAppUnreadPush(payload: Partial<ProductFeedbackAppUnreadEvent> | undefined) {
  // Untrusted wire value: the web's own total never comes on this event.
  const source: unknown = payload?.source;
  const count = feedbackUnreadCount(payload?.unreadTotal);
  if (!owner || !isCurrentUser(owner) || !bySource || source === "web"
    || !isProductFeedbackAppSource(source) || count === null) return;
  cancelRetry();
  setSourceFresh(source, count);
}

/**
 * The socket connected: pushes sent while it was down are lost, read the list
 * once. Also on the first connect: the retain read may have finished before
 * the socket joined the user's room. A retain read still in flight then is
 * not repeated; the moment between its answer and the join is left to the
 * safety read.
 */
export function refreshFeedbackUnreadAfterReconnect() {
  void refresh();
}

async function refresh() {
  if (!owner || !isCurrentUser(owner) || pending) return;
  if (document.visibilityState === "hidden") {
    owedOnShow = true;
    return;
  }
  if (Date.now() < notBefore) {
    scheduleRetry();
    return;
  }
  owedOnShow = false;
  const userId = owner;
  const version = revision;
  const controller = new AbortController();
  pending = controller;
  try {
    const { data } = await api.get<{ unread_total?: number | null; unread_by_source?: FeedbackUnreadBySource } | ApiDegradedTicketPage>("/product-feedback/tickets", {
      params: { limit: 1, ...FEEDBACK_LIST_ALL_SOURCES, ...FEEDBACK_LIST_DEGRADED_OK },
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (isDegradedFeedbackPage(data)) {
      // Hands is briefly unavailable (server #12566): unread_total is null,
      // unknown rather than 0. Keep the last count and back off as for a 503.
      backOff(Math.min(degradedRetryAfterMs(data), BACKOFF_MAX_MS));
      return;
    }
    resetBackoff();
    if (version === revision && owner === userId && isCurrentUser(userId)) setListFresh(feedbackListUnread(data));
  } catch (error) {
    // A transient outage is not evidence that the user has read their replies:
    // keep the last count, and wait before asking again.
    if (!controller.signal.aborted) backOff(retryAfterMs(error));
  } finally {
    if (pending === controller) pending = null;
  }
}

function listenWhileRetained() {
  const onShow = () => {
    if (document.visibilityState === "hidden") return;
    if (owedOnShow || Date.now() - freshAt >= SAFETY_READ_MS) void refresh();
  };
  window.addEventListener("focus", onShow);
  document.addEventListener("visibilitychange", onShow);
  return () => {
    window.removeEventListener("focus", onShow);
    document.removeEventListener("visibilitychange", onShow);
  };
}

function endSession() {
  stopListening?.();
  stopListening = null;
  owedOnShow = false;
  freshAt = 0;
  pending?.abort();
  pending = null;
  generation += 1;
  unread = 0;
  bySource = null;
  revision += 1;
  resetBackoff();
}

export function retainFeedbackUnread(userId: string, validateUser: (id: string) => boolean) {
  isCurrentUser = validateUser;
  if (owner !== userId) {
    endSession();
    owner = userId;
    consumers = 0;
    emit();
  }
  consumers += 1;
  if (!stopListening) {
    stopListening = listenWhileRetained();
    void refresh();
  }
  return () => {
    if (owner !== userId) return;
    consumers -= 1;
    if (consumers > 0) return;
    endSession();
    owner = null;
    emit();
  };
}

export const subscribeFeedbackUnread = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const feedbackUnreadSnapshot = (userId: string | null) => userId && owner === userId ? unread : 0;

// Capture the mounted session, so a detail response from a prior login cannot
// update another account (or a later login to the same account).
export function captureFeedbackUnreadUpdate() {
  const userId = owner;
  const session = generation;
  return (count: number, source: ProductFeedbackAppSource) => {
    if (session === generation) acceptFeedbackUnread(userId, count, source);
  };
}

/**
 * The feedback panel's own list read (the transport's listTickets), captured
 * when it is sent: its first page's totals are the read the panel's opening
 * owes, so no second request is made. Like a list read here, it loses to
 * anything newer (a push, a ticket read, another list read) that landed while
 * it was in flight. A page that knows no total (a cursor page) changes nothing.
 */
export function captureFeedbackUnreadListRead() {
  const userId = owner;
  const session = generation;
  const version = revision;
  return (page: FeedbackListUnread) => {
    if (session !== generation || version !== revision || !userId || userId !== owner
      || !isCurrentUser(userId) || (page.bySource === null && page.total === null)) return;
    resetBackoff();
    setListFresh(page);
  };
}
