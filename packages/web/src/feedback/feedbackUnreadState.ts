import type { ProductFeedbackUnreadEvent } from "@botiverse/raft-shared";
import api from "../api/client";
import { FEEDBACK_LIST_DEGRADED_OK, degradedRetryAfterMs, isDegradedFeedbackPage } from "./productFeedbackListContract";
import type { ApiDegradedTicketPage } from "./productFeedbackListContract";

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

// The count is pushed: the server sends `product_feedback:unread` (shared
// productFeedbackUnread.ts, the total, never a delta) to the user's own
// connections when a Hands reply lands or the count changes elsewhere. The
// list (`GET /product-feedback/tickets?limit=1`, for `unread_total`) is read
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

/** Detail GET advances Hands' read-through cursor. Invalidate older list reads. */
export function acceptFeedbackUnread(userId: string | null, count: number) {
  if (!userId || userId !== owner || !isCurrentUser(userId) || !validCount(count)) return;
  // A ticket read answered: Hands is back, reads need not wait.
  resetBackoff();
  setFresh(count);
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
  setFresh(count);
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
    const { data } = await api.get<{ unread_total: number } | ApiDegradedTicketPage>("/product-feedback/tickets", {
      params: { limit: 1, ...FEEDBACK_LIST_DEGRADED_OK },
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
    if (version === revision && owner === userId && isCurrentUser(userId) && validCount(data.unread_total)) {
      setFresh(data.unread_total);
    }
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
  return (count: number) => {
    if (session === generation) acceptFeedbackUnread(userId, count);
  };
}

/**
 * The feedback panel's own list read (the transport's listTickets), captured
 * when it is sent: its `unread_total` is the read the panel's opening owes, so
 * no second request is made. Like a list read here, it loses to anything newer
 * (a push, a ticket read, another list read) that landed while it was in flight.
 */
export function captureFeedbackUnreadListRead() {
  const userId = owner;
  const session = generation;
  const version = revision;
  return (count: number) => {
    if (session !== generation || version !== revision || !userId || userId !== owner
      || !isCurrentUser(userId) || !validCount(count)) return;
    resetBackoff();
    setFresh(count);
  };
}
