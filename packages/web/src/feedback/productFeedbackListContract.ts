// The first-page contract of `GET /api/product-feedback/tickets` when the
// client opts in with `degraded_ok=1` (server #12566). Hands briefly slow or
// refusing (a release cutover: binding timeouts, the open breaker, Hands 5xx)
// answers 200 with this page instead of 503:
//
//   { tickets: [], next_cursor: null, unread_total: null,
//     degraded: true, retry_after_seconds: 5 }   (+ `Retry-After: 5`)
//
// The empty list is NOT "no feedback" and the null total is unknown, not 0.
// Later pages (with `cursor`) never degrade; they still 503.
//
// No feedback SDK import here: feedbackUnreadState shares this and must stay
// outside the workspace's lazy boundary.

import type { ProductFeedbackAppSource } from "@botiverse/raft-shared";

/** Query flag that opts a first-page list read into the degraded answer. */
export const FEEDBACK_LIST_DEGRADED_OK = { degraded_ok: 1 } as const;

export type ApiDegradedTicketPage = {
  tickets: [];
  next_cursor: null;
  unread_total: null;
  degraded: true;
  retry_after_seconds: number;
};

/** The server's current value; used when a degraded page omits or garbles it. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export function isDegradedFeedbackPage(data: unknown): data is ApiDegradedTicketPage {
  return typeof data === "object" && data !== null && (data as { degraded?: unknown }).degraded === true;
}

/** How long the server asked a degraded reader to wait, in ms. */
export function degradedRetryAfterMs(page: ApiDegradedTicketPage): number {
  const seconds = page.retry_after_seconds;
  return (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RETRY_AFTER_SECONDS) * 1000;
}

// `?sources=all` (server #14722): one list of the reporter's tickets in every
// Hands app (web, android, ios, ohos), each ticket naming its `source` (the
// app) and `client` (the Raft client it was filed from). The first page's
// `unread_total` is the sum over the apps that answered, and `null` when one
// did not; a cursor page's is `null` or absent: either way "keep the value you
// have". The first page may also carry `unread_by_source`, each app's own
// total, with no key for an app that failed (a follow-up server PR; until then
// feedbackUnreadState.ts keeps the dot as before). A page may hold fewer
// tickets than `limit`, even none, and still have a `next_cursor`.

/** Query flag that merges every app's tickets into the list. Sent on every page. */
export const FEEDBACK_LIST_ALL_SOURCES = { sources: "all" } as const;

const APP_SOURCES: readonly ProductFeedbackAppSource[] = ["web", "android", "ios", "ohos"];

export function isProductFeedbackAppSource(value: unknown): value is ProductFeedbackAppSource {
  return (APP_SOURCES as readonly unknown[]).includes(value);
}

/** A count the server sent, or null when it sent none (`null`, absent) or garbage. */
export function feedbackUnreadCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Each app's unread total; an app that is missing is not known. */
export type FeedbackUnreadBySource = Partial<Record<ProductFeedbackAppSource, number>>;

/** `unread_by_source` as sent, keeping only known apps with valid counts; null when absent. */
export function feedbackUnreadBySource(value: unknown): FeedbackUnreadBySource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const counts: FeedbackUnreadBySource = {};
  for (const source of APP_SOURCES) {
    const count = feedbackUnreadCount((value as Record<string, unknown>)[source]);
    if (count !== null) counts[source] = count;
  }
  return counts;
}

/** What a real (not degraded) first list page says about unread replies. */
export type FeedbackListUnread = { total: number | null; bySource: FeedbackUnreadBySource | null };

export function feedbackListUnread(page: { unread_total?: number | null; unread_by_source?: FeedbackUnreadBySource }): FeedbackListUnread {
  return { total: feedbackUnreadCount(page.unread_total), bySource: feedbackUnreadBySource(page.unread_by_source) };
}
