/**
 * The time ledger of one page load: every millisecond from navigation start
 * to "ready" belongs to exactly one segment, so the segments add up to the
 * total and the most a fix could save can be computed instead of guessed
 * (docs/frontend/perf-measure.md, "The time ledger"). Pure, pinned by
 * ledger.test.ts.
 *
 * At each instant, by priority:
 *   main_thread   a long task is running (the page cannot paint or react)
 *   download      else, a response body is arriving
 *   network_wait  else, a request is out and its response has not started. Not only
 *                 the server: also DNS and connection setup, the browser queueing the
 *                 request, and slow requests the page may not need for ready.
 *   unexplained   else: nothing we observe is happening
 *
 * All times are rounded to whole milliseconds before the split, so the four
 * segments add up to the total exactly.
 */

export interface LedgerRequest {
  /** ms from navigation start: request sent, first response byte (null if none), finished. */
  startMs: number;
  responseMs: number | null;
  endMs: number;
}

export interface LedgerLongTask {
  startMs: number;
  durationMs: number;
}

export interface TimeLedger {
  totalMs: number;
  mainThreadMs: number;
  downloadMs: number;
  networkWaitMs: number;
  unexplainedMs: number;
  /** Share of the total nothing observed explains, 0..1: how well the load is understood. */
  unexplainedShare: number;
}

type Interval = [number, number];

/** Merge overlapping intervals, clipped to [0, limit]. */
export function mergeIntervals(intervals: readonly Interval[], limit: number): Interval[] {
  const clipped = intervals.map(([a, b]) => [Math.max(0, a), Math.min(limit, b)] as Interval).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of clipped) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const length = (intervals: readonly Interval[]) => intervals.reduce((sum, [a, b]) => sum + (b - a), 0);

/** `intervals` minus `cover` (both merged and sorted). */
export function subtractIntervals(intervals: readonly Interval[], cover: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of intervals) {
    let at = a;
    for (const [c, d] of cover) {
      if (d <= at) continue;
      if (c >= b) break;
      if (c > at) out.push([at, c]);
      at = Math.max(at, d);
      if (at >= b) break;
    }
    if (at < b) out.push([at, b]);
  }
  return out;
}

/**
 * Split [0, readyMs] into the four segments. Requests and long tasks that end
 * before 0 or start after ready do not count; partial ones are clipped.
 */
export function timeLedger(readyMs: number, requests: readonly LedgerRequest[], longTasks: readonly LedgerLongTask[]): TimeLedger {
  // whole milliseconds in, so interval lengths are integers and the segments sum exactly; a non-finite time is dropped
  const ms = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0);
  const total = Math.max(0, ms(readyMs));
  const main = mergeIntervals(longTasks.map((t) => [ms(t.startMs), ms(t.startMs + t.durationMs)]), total);
  const downloading = mergeIntervals(requests.filter((r) => r.responseMs != null).map((r) => [ms(r.responseMs!), ms(r.endMs)]), total);
  const waiting = mergeIntervals(requests.map((r) => [ms(r.startMs), ms(r.responseMs ?? r.endMs)]), total);
  const download = subtractIntervals(downloading, main);
  const busy = mergeIntervals([...main, ...downloading], total);
  const networkWait = subtractIntervals(waiting, busy);
  const mainThreadMs = length(main);
  const downloadMs = length(download);
  const networkWaitMs = length(networkWait);
  // the three are disjoint parts of [0, total] with integer bounds, so the remainder is exact and never negative
  const unexplainedMs = total - mainThreadMs - downloadMs - networkWaitMs;
  return { totalMs: total, mainThreadMs, downloadMs, networkWaitMs, unexplainedMs, unexplainedShare: total ? Math.round((unexplainedMs / total) * 1000) / 1000 : 0 };
}
