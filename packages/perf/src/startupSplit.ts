/**
 * Pure parts of `raft-perf startup` (src/startup.ts; docs/frontend/perf-measure.md, "Opening a channel: where the time goes"):
 * one open of a channel page reduced to the pieces its time is made of. Pinned by startupSplit.test.ts.
 *
 * Times are milliseconds since navigation start, as the browser's Resource Timing gives them: it records them in the
 * network stack, so a busy main thread does not move them.
 */

/** One Resource Timing entry of an API request, as read in the page. */
export interface ApiTiming {
  /** Path with ids replaced by `:id` (the opened channel's own id by `:channel`), no query. */
  path: string;
  /** The query's keys, without their values ("?limit&before"); "" when there is none. */
  query: string;
  /** What issued it: `fetch` (the inline boot script reads with fetch) or `xmlhttprequest` (the app). */
  initiator: string;
  protocol: string;
  start: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  encodedBytes: number;
  decodedBytes: number;
}

/** A CORS preflight seen on the DevTools protocol (Resource Timing does not list them). */
export interface Preflight {
  path: string;
  /** When it was sent, ms since navigation start (the command moves the DevTools clock onto the page's; see `toPageClock`). */
  at: number;
  /** Until its answer's headers; null when none came. */
  ms: number | null;
}

/** One request cut at the points the browser recorded. */
export interface RequestSplit {
  start: number;
  /**
   * From the page asking to the request leaving: a cross-origin preflight, DNS and connection setup, and the browser's own
   * queue. Zero for a reused connection with a cached preflight. Null when the browser hid the timing (a cross-origin
   * response without Timing-Allow-Origin reports requestStart 0).
   */
  beforeSendMs: number | null;
  /** Request sent to first byte of the answer: the network both ways plus the server's own time. */
  firstByteMs: number | null;
  /** First byte to last. */
  downloadMs: number | null;
  end: number;
  encodedBytes: number;
  decodedBytes: number;
  protocol: string;
  initiator: string;
}

export function splitRequest(t: ApiTiming): RequestSplit {
  const hidden = t.requestStart === 0 || t.responseStart === 0;
  return {
    start: t.start,
    beforeSendMs: hidden ? null : Math.max(0, t.requestStart - t.start),
    firstByteMs: hidden ? null : Math.max(0, t.responseStart - t.requestStart),
    downloadMs: hidden ? null : Math.max(0, t.responseEnd - t.responseStart),
    end: t.responseEnd,
    encodedBytes: t.encodedBytes,
    decodedBytes: t.decodedBytes,
    protocol: t.protocol,
    initiator: t.initiator,
  };
}

/** A long main-thread task (50 ms or more), with the script the browser blames when it names one. */
export interface LongTask {
  start: number;
  ms: number;
  /** The script, function or invoker the browser attributed most of it to; "" when it gave none. */
  from: string;
}

/** A long animation frame as the browser reports it: the frame's span and the script it spent the most time in. */
export interface BlamedFrame {
  start: number;
  ms: number;
  /** File and function (or what invoked it) of the frame's longest script; "" when the frame named none. */
  script: string;
}

/**
 * Long tasks with the script of the long animation frame each one falls in. The two are separate browser reports that
 * arrive in no fixed order (a frame is reported when it ends, after its tasks), so they are joined after the load, by
 * overlap: the frame that covers the most of the task.
 */
export function blameTasks(tasks: ReadonlyArray<{ start: number; ms: number }>, frames: readonly BlamedFrame[]): LongTask[] {
  return tasks.map((task) => {
    let best = { covered: 0, script: "" };
    for (const frame of frames) {
      const covered = Math.min(task.start + task.ms, frame.start + frame.ms) - Math.max(task.start, frame.start);
      if (covered > best.covered) best = { covered, script: frame.script };
    }
    return { start: task.start, ms: task.ms, from: best.script };
  });
}

/** What one load recorded, before it is reduced. */
export interface StartupLoad {
  /** Every API request of the load, in start order. */
  api: ApiTiming[];
  preflights: Preflight[];
  longTasks: LongTask[];
  /** The page's own report (slock.web.boot_timing): when it had the conversation's messages. Null when the page reported none. */
  contentMs: number | null;
  /** The first message row was in the DOM / the frame after it. Null when no row appeared. */
  firstRowMs: number | null;
  paintedMs: number | null;
  /** When the socket's handshake was answered; null when no socket opened. */
  socketOpenMs: number | null;
  commitSha: string | null;
}

/**
 * The page of messages the opened channel starts with: that channel's own path (`:channel`, not another channel's or a
 * thread's `:id`: the web reads threads from the same endpoint, also on its own when a reply arrives), and no cursor in
 * the query (a later `before` / `after` / `around` page is not it).
 */
export function isFirstPage(t: Pick<ApiTiming, "path" | "query">): boolean {
  return t.path === "/api/messages/channel/:channel" && !/[?&](before|after|around|cursor|since_seq)(&|$)/.test(t.query);
}

export interface StartupSplit {
  /** The first request for the opened channel's first page of messages (when it was asked twice, which answer the page used is not known); null when none was made. */
  messages: RequestSplit | null;
  /**
   * The same page asked for again. `race`: a second request started before the first had answered (the app and the boot
   * script both asking). `refetch`: started after the first had answered (the app reading again what it already had).
   */
  secondFirstPage: { kind: "race" | "refetch"; start: number; decodedBytes: number } | null;
  /** The preflight sent for the first-page request, when there was one: the one for its path sent nearest to when the page asked, before the request left. */
  messagesPreflightMs: number | null;
  preflights: number;
  preflightTotalMs: number;
  /** API requests started before the first message row was in the DOM (all of them when no row appeared). */
  apiBeforeFirstRow: number;
  /** Endpoints (path and query) requested more than once in the load, with how often. Resource Timing does not say the method, so a GET and a POST to one URL count together. */
  repeated: Array<{ endpoint: string; times: number }>;
  /** From the answer's last byte to the page having the messages / the row in the DOM / the next frame. Null without both ends, and null when the end came first (the page showed the messages from another answer: see `shownBeforeAnswer`). */
  responseToContentMs: number | null;
  responseToRowMs: number | null;
  responseToPaintMs: number | null;
  /** Long tasks that ran between the answer's last byte and the paint: what the main thread was doing in that gap. */
  longTasksInGap: LongTask[];
  longTaskMsInGap: number;
  /** The page had the messages (its own content time; the first row when it reported none) before this request's last byte: it did not wait for this answer (a race the other request won). The three gaps are then null. */
  shownBeforeAnswer: boolean;
  firstRowMs: number | null;
  paintedMs: number | null;
  contentMs: number | null;
  socketOpenMs: number | null;
  /**
   * What came before the page asked for the first page (null when it never asked). `longTaskMs`: main-thread time in
   * long tasks up to the asking (only tasks of 50 ms or more are reported, so a lower bound of the script work; a task
   * still running at the asking counts up to it). `lastAnswer`: the API request whose answer ended last before the
   * asking, and how long before: when the page asks right after it, that answer is what it was waiting for (an
   * observation of order, not of cause); `endpoint` is its path, without the query. Null when no API answer had ended yet.
   */
  beforeAsk: { longTaskMs: number; lastAnswer: { endpoint: string; endMs: number; askedAfterMs: number } | null } | null;
}

const gap = (from: number | null | undefined, to: number | null): number | null => (from == null || to == null || to < from ? null : Math.round(to - from));

/** How far a preflight may sit from its request on the page's clock and still be its own: the two clocks are joined at the document request, which is good to a few milliseconds. */
export const PREFLIGHT_SLACK_MS = 50;

/**
 * A DevTools-protocol time on the page's clock (ms since its time origin). The protocol stamps events on its own
 * monotonic clock and gives the wall time of each request; the page's time origin is a wall time too, so the document
 * request, which has both, joins the two: `at = (timestamp - documentTimestamp) + (documentWallTime - timeOrigin)`, in ms.
 */
export function toPageClock(timestamp: number, document: { timestamp: number; wallTime: number }, timeOriginMs: number): number {
  return Math.round((timestamp - document.timestamp) * 1000 + (document.wallTime * 1000 - timeOriginMs));
}

/** Only what happened up to `untilMs` on the page's clock: loads are read at different moments, and what a page polls or defers afterwards must not count for one load and not the other. */
export function withinWindow(load: StartupLoad, untilMs: number): StartupLoad {
  return { ...load, api: load.api.filter((t) => t.start <= untilMs), preflights: load.preflights.filter((p) => p.at <= untilMs), longTasks: load.longTasks.filter((t) => t.start <= untilMs) };
}

export function splitStartup(load: StartupLoad): StartupSplit {
  const pages = load.api.filter(isFirstPage).sort((a, b) => a.start - b.start);
  const first = pages[0] ?? null;
  const second = pages[1] ?? null;
  const messages = first ? splitRequest(first) : null;
  // Before the request left; when the browser hid that time, before its answer ended. The two clocks agree to a few ms (toPageClock), hence the slack.
  const leftBy = first ? (first.requestStart === 0 ? first.responseEnd : first.requestStart + PREFLIGHT_SLACK_MS) : 0;
  const preflight = first ? (load.preflights.filter((p) => p.path === first.path && p.at >= first.start - PREFLIGHT_SLACK_MS && p.at <= leftBy).sort((a, b) => Math.abs(a.at - first.start) - Math.abs(b.at - first.start))[0] ?? null) : null;
  const counts = new Map<string, number>();
  for (const t of load.api) counts.set(t.path + t.query, (counts.get(t.path + t.query) ?? 0) + 1);
  const end = first?.responseEnd ?? null;
  const until = load.paintedMs ?? load.firstRowMs;
  // the page showing the messages before this answer ended means it used another one: no gap belongs to this answer then
  const shown = load.contentMs ?? load.firstRowMs;
  const early = end != null && shown != null && shown < end;
  const inGap = end == null || until == null || early ? [] : load.longTasks.filter((t) => t.start + t.ms > end && t.start < until);
  const lastAnswer = first ? (load.api.filter((t) => t !== first && t.responseEnd > 0 && t.responseEnd <= first.start).sort((x, y) => y.responseEnd - x.responseEnd)[0] ?? null) : null;
  return {
    beforeAsk: first
      ? {
          longTaskMs: Math.round(load.longTasks.reduce((sum, t) => sum + Math.max(0, Math.min(t.start + t.ms, first.start) - t.start), 0)),
          lastAnswer: lastAnswer ? { endpoint: lastAnswer.path, endMs: lastAnswer.responseEnd, askedAfterMs: Math.round(first.start - lastAnswer.responseEnd) } : null,
        }
      : null,
    messages,
    secondFirstPage: first && second ? { kind: second.start < first.responseEnd ? "race" : "refetch", start: second.start, decodedBytes: second.decodedBytes } : null,
    messagesPreflightMs: preflight?.ms ?? null,
    preflights: load.preflights.length,
    preflightTotalMs: Math.round(load.preflights.reduce((sum, p) => sum + (p.ms ?? 0), 0)),
    apiBeforeFirstRow: load.firstRowMs == null ? load.api.length : load.api.filter((t) => t.start < load.firstRowMs!).length,
    repeated: [...counts.entries()].filter(([, n]) => n > 1).map(([endpoint, times]) => ({ endpoint, times })).sort((a, b) => b.times - a.times || a.endpoint.localeCompare(b.endpoint)),
    responseToContentMs: early ? null : gap(end, load.contentMs),
    responseToRowMs: early ? null : gap(end, load.firstRowMs),
    responseToPaintMs: early ? null : gap(end, load.paintedMs),
    longTasksInGap: inGap,
    longTaskMsInGap: Math.round(inGap.reduce((sum, t) => sum + t.ms, 0)),
    shownBeforeAnswer: early,
    firstRowMs: load.firstRowMs,
    paintedMs: load.paintedMs,
    contentMs: load.contentMs,
    socketOpenMs: load.socketOpenMs,
  };
}

/** The median of the numbers given, nulls left out; null when none is left. */
export function median(values: ReadonlyArray<number | null | undefined>): number | null {
  const sorted = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface StartupSummary {
  loads: number;
  /** Medians over the loads that have the value. */
  messagesStartMs: number | null;
  beforeSendMs: number | null;
  firstByteMs: number | null;
  downloadMs: number | null;
  messagesEndMs: number | null;
  responseToPaintMs: number | null;
  paintedMs: number | null;
  contentMs: number | null;
  preflights: number | null;
  apiBeforeFirstRow: number | null;
  encodedBytes: number | null;
  decodedBytes: number | null;
  /** Before the asking (see StartupSplit.beforeAsk): the median long-task time, and the endpoint whose answer most often ended last before it (the first by name on a tie) with the loads it did so in and their median wait from that answer to the asking. Null when no load has it. */
  beforeAskLongTaskMs: number | null;
  lastAnswerBeforeAsk: { endpoint: string; loads: number; askedAfterMs: number } | null;
  /** Loads in which the first page was asked for twice, by kind. */
  raced: number;
  refetched: number;
  /** Loads in which no first message row appeared: they are in `loads` and in no median that needs the row. */
  withoutRow: number;
  /** Loads that asked for the first page / whose request had visible timing / in which the page reported its own content time: how many loads each median above stands on. */
  withFirstPage: number;
  withTiming: number;
  withContent: number;
  /** Loads in which the messages were on screen before the first request's answer ended (their answer-to-paint gap is null). */
  shownBeforeAnswer: number;
  /** Endpoints repeated in at least half of the loads, each with its most frequent count (the higher one on a tie) and the number of loads it was repeated in. */
  repeatedInHalfOrMore: Array<{ endpoint: string; times: number; loads: number }>;
}

export function summarize(splits: readonly StartupSplit[]): StartupSummary {
  const seen = new Map<string, number[]>();
  for (const s of splits) for (const r of s.repeated) seen.set(r.endpoint, [...(seen.get(r.endpoint) ?? []), r.times]);
  const last = new Map<string, number[]>();
  for (const s of splits) if (s.beforeAsk?.lastAnswer) last.set(s.beforeAsk.lastAnswer.endpoint, [...(last.get(s.beforeAsk.lastAnswer.endpoint) ?? []), s.beforeAsk.lastAnswer.askedAfterMs]);
  const usual = [...last.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0] ?? null;
  return {
    loads: splits.length,
    beforeAskLongTaskMs: median(splits.map((s) => s.beforeAsk?.longTaskMs)),
    lastAnswerBeforeAsk: usual ? { endpoint: usual[0], loads: usual[1].length, askedAfterMs: median(usual[1])! } : null,
    messagesStartMs: median(splits.map((s) => s.messages?.start)),
    beforeSendMs: median(splits.map((s) => s.messages?.beforeSendMs)),
    firstByteMs: median(splits.map((s) => s.messages?.firstByteMs)),
    downloadMs: median(splits.map((s) => s.messages?.downloadMs)),
    messagesEndMs: median(splits.map((s) => s.messages?.end)),
    responseToPaintMs: median(splits.map((s) => s.responseToPaintMs)),
    paintedMs: median(splits.map((s) => s.paintedMs)),
    contentMs: median(splits.map((s) => s.contentMs)),
    preflights: median(splits.map((s) => s.preflights)),
    apiBeforeFirstRow: median(splits.map((s) => s.apiBeforeFirstRow)),
    encodedBytes: median(splits.map((s) => s.messages?.encodedBytes)),
    decodedBytes: median(splits.map((s) => s.messages?.decodedBytes)),
    raced: splits.filter((s) => s.secondFirstPage?.kind === "race").length,
    refetched: splits.filter((s) => s.secondFirstPage?.kind === "refetch").length,
    withoutRow: splits.filter((s) => s.firstRowMs == null).length,
    withFirstPage: splits.filter((s) => s.messages != null).length,
    withTiming: splits.filter((s) => s.messages?.firstByteMs != null).length,
    withContent: splits.filter((s) => s.contentMs != null).length,
    shownBeforeAnswer: splits.filter((s) => s.shownBeforeAnswer).length,
    repeatedInHalfOrMore: [...seen.entries()]
      .filter(([, times]) => times.length * 2 >= splits.length)
      .map(([endpoint, times]) => ({ endpoint, times: [...times].sort((a, b) => times.filter((t) => t === b).length - times.filter((t) => t === a).length || b - a)[0], loads: times.length }))
      .sort((a, b) => b.times - a.times || a.endpoint.localeCompare(b.endpoint)),
  };
}

/**
 * An API URL as a report names it: the path with UUIDs (bare or prefixed, `pt_<uuid>`) replaced by `:id`, the opened
 * channel's own id by `:channel`, and the query reduced to its keys. Values of the query never reach a report; a path
 * segment that is not a UUID does (slugs and short ids: none is requested by a channel open today, and this is a
 * denylist, not a guarantee).
 */
export function endpointOf(url: string, openedChannelId?: string): { path: string; query: string } {
  const u = new URL(url);
  const opened = openedChannelId?.toLowerCase();
  const path = u.pathname
    .split("/")
    .map((segment) => {
      const bare = segment.replace(/^[a-z]{2,4}_/i, "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare)) return segment;
      return opened !== undefined && segment.toLowerCase() === opened ? ":channel" : ":id";
    })
    .join("/");
  const keys = [...new Set([...u.searchParams.keys()])];
  return { path, query: keys.length ? `?${keys.join("&")}` : "" };
}

/** Two sessions disagree when their medians are this far apart, both as a ratio and in milliseconds (0.3 s: the smallest change worth chasing, Artea 2026-11-15). */
export const SESSION_DISAGREE_RATIO = 1.5;
export const SESSION_DISAGREE_MS = 300;

export interface SessionAgreement {
  /** Median of each session's values (null for a session with none). */
  medians: Array<number | null>;
  /** Largest over smallest session median; null with fewer than two sessions that have one. */
  ratio: number | null;
  /** False when the slowest and fastest session medians differ by more than both thresholds. */
  agree: boolean;
}

/**
 * Do separate browser sessions tell the same story? Measured 2026-11-16 on Browser Run: the same build read 1.24 s in one
 * session and 2.78 s in another, so a single session's median is not evidence of a change. One session always "agrees".
 */
export function sessionAgreement(perSession: ReadonlyArray<ReadonlyArray<number | null | undefined>>): SessionAgreement {
  const medians = perSession.map((values) => median(values));
  const known = medians.filter((m): m is number => m != null);
  // a session with no reading next to one with readings is itself a disagreement (one browser never painted)
  if (known.length && known.length < medians.length) return { medians, ratio: null, agree: false };
  if (known.length < 2) return { medians, ratio: null, agree: true };
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  // ratio is null when the fastest median is 0; then only the milliseconds decide. Rounded before it is compared, so
  // the report never shows "1.5" beside agree: false.
  const ratio = lo > 0 ? Math.round((hi / lo) * 100) / 100 : null;
  const agree = !(hi - lo > SESSION_DISAGREE_MS && (ratio == null || ratio > SESSION_DISAGREE_RATIO));
  return { medians, ratio, agree };
}
