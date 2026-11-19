/**
 * What kind of work the browser's main thread did after a click: script,
 * style recalculation, layout, and how many times it recalculated the style
 * of a large part of the page. Read from a Chrome trace (`interact --trace`);
 * long tasks alone say that the thread was busy, not with what. Pure, pinned
 * by workSplit.test.ts. docs/frontend/perf-measure.md, "What the main thread did".
 *
 * The window starts at the press that became the click (the trace's own
 * `EventDispatch` of type `pointerdown` just before the one of type `click`,
 * so no clock has to be mapped; the click itself when no press is recorded)
 * and is `windowMs` long. The press is part of what a click costs: on a page
 * whose container had `:has()` rules, 1,400 to 1,900 elements were restyled
 * within 10 ms of the press, some 20 ms before the click event. The length is fixed: work that
 * follows the paint (a late page-wide style pass, a refresh being applied)
 * is part of what the click cost. An event that crosses either edge of the
 * window counts for the part inside it (the task that dispatched the click
 * began before it).
 *
 * Script is everything under one of the browser's entry points into
 * JavaScript, not only `FunctionCall`: a React render after a click or after
 * a response runs from the microtask queue (`RunMicrotasks`, which Chrome
 * records only with the `v8.execute` category; on a channel switch measured
 * 2026-11-14 that was 400 of 500 ms of script).
 */

/** The fields of a trace event this reads (Chrome's trace event format; times in microseconds). */
export interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { data?: { type?: string }; elementCount?: number };
}

export interface StylePass {
  /** ms from the start of the window (the press). */
  atMs: number;
  ms: number;
  elements: number;
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
/** Chrome has named the style pass both ways. */
const STYLE = new Set(["UpdateLayoutTree", "RecalcStyle"]);

/** Null when the trace holds no click: there is nothing to start the window at. `windowMs` is counted from the press. */
export function workSplit(events: readonly TraceEvent[], windowMs: number): WorkSplit | null {
  const click = events.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "click").sort((a, b) => a.ts - b.ts)[0];
  if (!click) return null;
  // the press of this click: the last pointerdown on its thread in the second before it
  const press = events.filter((e) => e.name === "EventDispatch" && e.args?.data?.type === "pointerdown" && e.pid === click.pid && e.tid === click.tid && e.ts <= click.ts && e.ts > click.ts - PRESS_BEFORE_CLICK_US).sort((a, b) => b.ts - a.ts)[0];
  const from = (press ?? click).ts;
  const to = from + windowMs * 1000;
  const inWindow = events
    .filter((e) => e.ph === "X" && e.pid === click.pid && e.tid === click.tid && e.ts + (e.dur ?? 0) > from && e.ts < to)
    .map((e) => ({ name: e.name, start: Math.max(e.ts, from), end: Math.min(e.ts + (e.dur ?? 0), to), elements: e.args?.elementCount ?? 0 }));
  type Span = (typeof inWindow)[number];
  /** Events of one kind that are not inside another of the same kind (a function called from a function is one piece of script). */
  const outermost = (of: (name: string) => boolean): Span[] => {
    const out: Span[] = [];
    for (const e of inWindow.filter((e) => of(e.name)).sort((a, b) => a.start - b.start || b.end - a.end)) if (!out.length || e.start >= out[out.length - 1]!.end) out.push(e);
    return out;
  };
  const total = (spans: readonly Span[]) => spans.reduce((sum, e) => sum + (e.end - e.start), 0);
  const script = outermost((n) => SCRIPT.has(n));
  const style = outermost((n) => STYLE.has(n));
  const layout = outermost((n) => n === "Layout");
  const forced = total([...style, ...layout].filter((e) => script.some((s) => e.start >= s.start && e.end <= s.end)));
  const ms = (us: number) => Math.round(us / 100) / 10;
  // any thread of any process: stopping a recording itself records tasks at that instant, so the last event is when it stopped (an idle page can go half a second without one before that)
  const recordedUntil = events.reduce((last, e) => Math.max(last, e.ts + (e.dur ?? 0)), from);
  return {
    windowMs,
    recordedMs: Math.min(windowMs, Math.floor((recordedUntil - from) / 1000)),
    taskMs: ms(total(outermost((n) => n === "RunTask"))),
    scriptMs: ms(total(script) - forced),
    styleMs: ms(total(style)),
    layoutMs: ms(total(layout)),
    forcedMs: ms(forced),
    stylePasses: style.length,
    styleElements: style.reduce((sum, e) => sum + e.elements, 0),
    layouts: layout.length,
    largeStylePasses: style.filter((e) => e.elements >= LARGE_PASS_ELEMENTS).map((e) => ({ atMs: ms(e.start - from), ms: ms(e.end - e.start), elements: e.elements })),
  };
}
