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
