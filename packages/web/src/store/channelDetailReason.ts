/**
 * Why the web asked for `GET /api/channels/:id`, sent as a header so the
 * server span can tell the callers apart (#proj-deploy:ee85db9e).
 */
export type ChannelDetailReason =
  /** A conversation opened and loads its read receipts. */
  | "receipts"
  /** The read-receipt summary changed; re-read it. */
  | "summary_changed"
  /** The channel row is not loaded yet (first open, a notification, a thread window). */
  | "ensure"
  /** A route about to open is fetched ahead of its mount. */
  | "preload"
  /** An event said the channel changed; re-read it. */
  | "refresh";

export const CHANNEL_DETAIL_REASON_HEADER = "X-Raft-Fetch-Reason";

export function channelDetailRequestConfig(reason: ChannelDetailReason) {
  return { headers: { [CHANNEL_DETAIL_REASON_HEADER]: reason } };
}
