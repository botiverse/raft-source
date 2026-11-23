/**
 * What kind of work the browser's main thread did inside a trace window: script,
 * style recalculation, layout, and how many times it recalculated the style
 * of a large part of the page. Read from a Chrome trace (`interact --trace`,
 * `ab`, or `diagnose`); long tasks alone say that the thread was busy, not with
 * what. Pure, pinned by workSplit.test.ts. docs/frontend/perf-measure.md,
 * "What the main thread did".
 *
 * For clicks (`workSplit`), the window starts at the press that became the click
 * (the trace's own `EventDispatch` of type `pointerdown` just before the one of
 * type `click`, so no clock has to be mapped; the click itself when no press is
 * recorded) and is `windowMs` long. For arbitrary phases such as channel startup's
 * post-response render gap (`workSplitRange`), callers anchor `performance.now()`
 * onto the trace's microsecond clock via `findTraceMark` (`blink.user_timing`).
 *
 * Script is everything under one of the browser's entry points into
 * JavaScript, not only `FunctionCall`: a React render after a click or after
 * a response runs from the microtask queue (`RunMicrotasks`, which Chrome
 * records only with the `v8.execute` category; on a channel switch measured
 * 2026-11-14 that was 400 of 500 ms of script).
 */

export interface TraceStackFrame {
  functionName?: string;
  url?: string;
  scriptId?: string | number;
  /** 1-based in DevTools timeline events. */
  lineNumber?: number;
  /** 1-based in DevTools timeline events. */
  columnNumber?: number;
}

/** The fields of a trace event this reads (Chrome's trace event format; times in microseconds). */
export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: {
    data?: { type?: string; stackTrace?: TraceStackFrame[] };
    beginData?: { stackTrace?: TraceStackFrame[] };
    elementCount?: number;
  };
}

export interface StylePass {
  /** ms from the start of the window. */
  atMs: number;
  ms: number;
  elements: number;
}

export interface ForcedSpan {
  kind: "layout" | "style";
  startUs: number;
  endUs: number;
  /** ms from the start of the window. */
  atMs: number;
  durationMs: number;
  elements: number;
  stackTrace: TraceStackFrame[];
}

export interface WorkSplit {
  windowMs: number;
  /** How much of the window the trace covers, ms: under `windowMs` when the recording stopped early, and the numbers below then miss the end. */
  recordedMs: number;
  /** Every main-thread task in the window. */
  taskMs: number;
  /** Script, without the style and layout work it forced (that is in `styleMs` / `layoutMs`, and again in `forcedMs`). */
  scriptMs: number;
  styleMs: number;
  layoutMs: number;
  /** Style and layout work done inside script: something read a layout value after changing the DOM. */
  forcedMs: number;
  stylePasses: number;
  /** Elements whose style was recalculated, over all passes. */
  styleElements: number;
  layouts: number;
  /** Style passes over at least `LARGE_PASS_ELEMENTS` elements, in order. One is expected when a view mounts; each further one is a recalculation of content that was already styled. */
  largeStylePasses: StylePass[];
}

/** A style pass this large is not one component updating. */
export const LARGE_PASS_ELEMENTS = 150;

/** A press longer than this before the click is not looked for: automation presses and releases within milliseconds, a person within a few hundred. */
const PRESS_BEFORE_CLICK_US = 1_000_000;

/** The browser's entry points into JavaScript: a callback, a script, the microtask queue, an event's listeners, a timer, an animation frame, a response handler. */
const SCRIPT = new Set(["FunctionCall", "EvaluateScript", "RunMicrotasks", "EventDispatch", "TimerFire", "FireAnimationFrame", "XHRLoad", "XHRReadyStateChange"]);
/** What a recording needs for this split; `v8.execute` carries `RunMicrotasks`. */
export const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute"];
/** Extended trace categories for `startup` A/B and `diagnose`: adds `blink.user_timing` clock marks and forced-layout call stacks. */
export const DIAGNOSE_TRACE_CATEGORIES = [...TRACE_CATEGORIES, "blink.user_timing", "disabled-by-default-devtools.timeline.stack"];
/** Chrome has named the style pass both ways. */
const STYLE = new Set(["UpdateLayoutTree", "RecalcStyle"]);

/** Find a `performance.mark(markName)` event emitted under `blink.user_timing` to join `performance.now()` with the trace/profiler microsecond clock. */
export function findTraceMark(events: readonly TraceEvent[], markName: string): { pid: number; tid: number; ts: number } | null {
  const hit = events
    .filter((e) => e.name === markName && e.ts > 0)
    .sort((a, b) => a.ts - b.ts)[0];
  return hit ? { pid: hit.pid, tid: hit.tid, ts: hit.ts } : null;
}

/** Find the first `EventDispatch` click (and its preceding `pointerdown` press within 1s) in a trace. */
export function findClickStart(events: readonly TraceEvent[]): { pid: number; tid: number; ts: number } | null {
  const click = events.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "click").sort((a, b) => a.ts - b.ts)[0];
  if (!click) return null;
  const press = events
    .filter(
      (e) =>
        e.name === "EventDispatch" &&
        e.args?.data?.type === "pointerdown" &&
        e.pid === click.pid &&
        e.tid === click.tid &&
        e.ts <= click.ts &&
        e.ts > click.ts - PRESS_BEFORE_CLICK_US,
    )
    .sort((a, b) => b.ts - a.ts)[0];
  return { pid: click.pid, tid: click.tid, ts: (press ?? click).ts };
}

/** Split main-thread work over an explicit `[fromUs, toUs]` microsecond window on `(pid, tid)`. */
export function workSplitRange(events: readonly TraceEvent[], pid: number, tid: number, fromUs: number, toUs: number): WorkSplit {
  const from = fromUs;
  const to = Math.max(fromUs, toUs);
  const windowMs = Math.round((to - from) / 100) / 10;
  const inWindow = events
    .filter((e) => e.ph === "X" && e.pid === pid && e.tid === tid && e.ts + (e.dur ?? 0) > from && e.ts < to)
    .map((e) => ({
      name: e.name,
      start: Math.max(e.ts, from),
      end: Math.min(e.ts + (e.dur ?? 0), to),
      elements: e.args?.elementCount ?? 0,
    }));
  type Span = (typeof inWindow)[number];
  /** Events of one kind that are not inside another of the same kind (a function called from a function is one piece of script). */
  const outermost = (of: (name: string) => boolean): Span[] => {
    const out: Span[] = [];
    for (const e of inWindow.filter((e) => of(e.name)).sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (!out.length || e.start >= out[out.length - 1]!.end) out.push(e);
    }
    return out;
  };
  const total = (spans: readonly Span[]) => spans.reduce((sum, e) => sum + (e.end - e.start), 0);
  const script = outermost((n) => SCRIPT.has(n));
  const style = outermost((n) => STYLE.has(n));
  const layout = outermost((n) => n === "Layout");
  const forced = total([...style, ...layout].filter((e) => script.some((s) => e.start >= s.start && e.end <= s.end)));
  const ms = (us: number) => Math.round(us / 100) / 10;
  const recordedUntil = events.reduce((last, e) => Math.max(last, e.ts + (e.dur ?? 0)), from);
  return {
    windowMs,
    recordedMs: Math.min(windowMs, Math.floor((recordedUntil - from) / 1000)),
    taskMs: ms(total(outermost((n) => n === "RunTask"))),
    scriptMs: ms(Math.max(0, total(script) - forced)),
    styleMs: ms(total(style)),
    layoutMs: ms(total(layout)),
    forcedMs: ms(forced),
    stylePasses: style.length,
    styleElements: style.reduce((sum, e) => sum + e.elements, 0),
    layouts: layout.length,
    largeStylePasses: style
      .filter((e) => e.elements >= LARGE_PASS_ELEMENTS)
      .map((e) => ({ atMs: ms(e.start - from), ms: ms(e.end - e.start), elements: e.elements })),
  };
}

/** Extract every forced synchronous `Layout` / `RecalcStyle` span executed inside JavaScript during `[fromUs, toUs]`. */
export function forcedSpansRange(events: readonly TraceEvent[], pid: number, tid: number, fromUs: number, toUs: number): ForcedSpan[] {
  const from = fromUs;
  const to = Math.max(fromUs, toUs);
  const inWindow = events
    .filter((e) => e.ph === "X" && e.pid === pid && e.tid === tid && e.ts + (e.dur ?? 0) > from && e.ts < to)
    .map((e) => ({
      name: e.name,
      start: Math.max(e.ts, from),
      end: Math.min(e.ts + (e.dur ?? 0), to),
      elements: e.args?.elementCount ?? 0,
      stackTrace: e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? [],
    }));
  const scriptSpans: Array<{ start: number; end: number }> = [];
  for (const e of inWindow.filter((e) => SCRIPT.has(e.name)).sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!scriptSpans.length || e.start >= scriptSpans[scriptSpans.length - 1]!.end) {
      scriptSpans.push({ start: e.start, end: e.end });
    }
  }
  const candidates: typeof inWindow = [];
  for (const kind of [STYLE, new Set(["Layout"])]) {
    const outer: typeof inWindow = [];
    for (const e of inWindow.filter((x) => kind.has(x.name)).sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (!outer.length || e.start >= outer[outer.length - 1]!.end) outer.push(e);
    }
    candidates.push(...outer);
  }
  const ms = (us: number) => Math.round(us / 100) / 10;
  return candidates
    .filter((e) => scriptSpans.some((s) => e.start >= s.start && e.end <= s.end))
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      kind: e.name === "Layout" ? "layout" : "style",
      startUs: e.start,
      endUs: e.end,
      atMs: ms(e.start - from),
      durationMs: ms(e.end - e.start),
      elements: e.elements,
      stackTrace: e.stackTrace,
    }));
}

/** Null when the trace holds no click: there is nothing to start the window at. `windowMs` is counted from the press. */
export function workSplit(events: readonly TraceEvent[], windowMs: number): WorkSplit | null {
  const start = findClickStart(events);
  if (!start) return null;
  const split = workSplitRange(events, start.pid, start.tid, start.ts, start.ts + windowMs * 1000);
  return { ...split, windowMs };
}
