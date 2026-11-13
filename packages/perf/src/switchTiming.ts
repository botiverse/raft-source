/**
 * Where the time of one view switch went: the click on a channel, a thread or
 * a message link, up to the frame that shows the target's messages. Start, end
 * and attribute names follow the web's own `web.view.switch` span, so that a
 * lab number and a field number can be put side by side
 * (docs/frontend/perf-measure.md, "View switches"). Pure, pinned by
 * switchTiming.test.ts.
 *
 * The page is watched from outside, so `cache` is inferred from what the
 * network did, not read from the app:
 *   miss   a message request finished before the paint: the paint waited for it
 *   stale  a message request was sent but had not finished at the paint: painted
 *          from local data, refreshed behind
 *   hit    no message request seen: none started between the click and one
 *          second after the paint (one started earlier, e.g. on pointer down,
 *          or still out when the collection stopped waiting, also reads as a hit)
 * A paint that used local data while a fast request happened to finish first
 * reads as `miss`; the segments still say where the time was.
 *
 * Two ends are reported. `totalMs` is the first frame with the target's
 * messages; after a stale paint those may be a few live rows or an old page.
 * `settledMs` is when the view is also current: after a stale paint, the last
 * byte of the refresh, which is the message request the page asked for first
 * (a lower bound: applying it is not timed). For a hit or a miss the two are
 * equal: once a message request has painted the view, other message requests
 * still out do not move it. A later top-up request (the web sends a small `after=` one once a
 * thread panel has joined its room) does not move it: it covers the moments
 * since the refresh, not the view the person is waiting for.
 */

export interface SwitchRequest {
  /** Path with ids replaced, e.g. /api/messages/channel/:id. */
  path: string;
  /** It carries the messages of the view switched to (see `isMessageRoute`; the collector also checks the channel). */
  message: boolean;
  /** ms from the click: the page asked for it, the browser sent it, first byte, last byte. */
  startMs: number;
  sentMs: number;
  responseMs: number;
  endMs: number;
  bytes: number;
}

export interface SwitchLongTask {
  startMs: number;
  durationMs: number;
}

export type SwitchCache = "hit" | "stale" | "miss";

export interface SwitchTiming {
  totalMs: number;
  settledMs: number;
  cache: SwitchCache;
  /** Requests the page started before the paint, and their response bytes. */
  requests: number;
  bytes: number;
  /** Main-thread long tasks inside the switch, ms. Only tasks over 50 ms are observable: a lower bound. */
  mainThreadMs: number;
  /** Message requests of the switch, top-ups included (the span's `message_requests`). More than one for a plain channel switch is worth a look. */
  messageRequests: number;
  /** From the click event's timestamp to the page asking for the messages: the first message request it started. Null for a hit. The span's `request_delay_ms`. */
  requestDelayMs: number | null;
  /**
   * Input delay: from the click event's own timestamp to the page starting to handle it. The browser was busy
   * (rendering, another task); none of it is the click handler's code. On a slow or GPU-less runner this is most
   * of `requestDelayMs`.
   */
  inputDelayMs: number;
  /** `requestDelayMs` without the input delay: from the page starting to handle the click to it asking for the messages. The app's own share. */
  appRequestDelayMs: number | null;
  /**
   * The message request the view waited for: for a miss, the one that finished last before the paint; for a stale
   * paint, the refresh (the first one asked for). When the page asked for it (from the click), waiting in the browser
   * before it was sent, sent to first byte, first to last byte. These four add up to `settledMs` for a stale paint
   * and, with `renderMs` (last byte to paint, a miss only), to `totalMs` for a miss. Null for a hit. Usually
   * `waitedStartMs` equals `requestDelayMs`; it is later when the paint waited for a second request.
   * A cross-origin API without Timing-Allow-Origin reports no sent or first-byte time (and no bytes): the collector
   * then puts the whole wait in `ttfbMs`, with queue and download 0.
   */
  waitedStartMs: number | null;
  queueMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  renderMs: number | null;
}

/**
 * Routes that carry the messages a view shows: a channel's (or a thread's) page, or the window around one message.
 * Exactly those: not sync, search, actions, or a channel's outline or activity under the same prefix.
 */
export const isMessageRoute = (route: string): boolean => /^\/api\/messages\/(channel|context)\/:id$/.test(route);

/** Replace ids in a path, so a path names a route and never a channel or a message. */
export const routeOf = (pathname: string): string => pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");

/**
 * `requests` may include ones started after the paint (a refresh behind a local
 * paint is what tells `stale` from `hit`); they are not counted in `requests` and `bytes`.
 */
export function switchTiming(totalMs: number, requests: readonly SwitchRequest[], longTasks: readonly SwitchLongTask[], inputDelayMs = 0): SwitchTiming {
  const total = Math.round(totalMs);
  const inputDelay = Math.min(total, Math.max(0, Math.round(inputDelayMs)));
  const before = requests.filter((r) => r.startMs < total);
  const data = requests.filter((r) => r.message);
  const byEnd = (list: readonly SwitchRequest[]) => [...list].sort((a, b) => b.endMs - a.endMs)[0];
  const waited = byEnd(data.filter((r) => Math.round(r.endMs) <= total));
  const cache: SwitchCache = waited ? "miss" : data.length ? "stale" : "hit";
  const mainThreadMs = Math.round(longTasks.reduce((sum, t) => sum + Math.max(0, Math.min(t.startMs + t.durationMs, total) - Math.max(t.startMs, 0)), 0));
  const base = { totalMs: total, cache, requests: before.length, bytes: before.reduce((sum, r) => sum + r.bytes, 0), mainThreadMs: Math.min(mainThreadMs, total), inputDelayMs: inputDelay, messageRequests: data.length };
  // the request the page asked for first is the one a person's wait depends on; a later top-up is not
  const first = [...data].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs)[0];
  if (!first) return { ...base, settledMs: total, requestDelayMs: null, appRequestDelayMs: null, waitedStartMs: null, queueMs: null, ttfbMs: null, downloadMs: null, renderMs: null };
  const request = waited ?? first;
  const requestDelayMs = Math.round(first.startMs);
  // whole-millisecond cut points, so the pieces add up exactly
  const [start, sent, response, end] = [request.startMs, request.sentMs, request.responseMs, request.endMs].map((v) => Math.round(v)) as [number, number, number, number];
  return { ...base, settledMs: waited ? total : Math.max(total, end), requestDelayMs, appRequestDelayMs: Math.max(0, requestDelayMs - inputDelay), waitedStartMs: start, queueMs: sent - start, ttfbMs: response - sent, downloadMs: end - response, renderMs: waited ? total - end : null };
}
