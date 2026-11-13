/**
 * `web.view.switch`: from the input that switched the view (a click on a
 * channel, a DM, a thread, a message link or a search result; Back and
 * Forward) to the frame after the target view's message list first showed
 * its messages. Defined with the o11y owner and QA in #triage:8c0d2318;
 * docs/observability/reading-telemetry.md says how to read it.
 *
 * Start hooks: useAppNavigate's guarded navigation and the window's popstate
 * (beginViewSwitchToPath), threadStore.openThread (beginViewSwitch). End
 * hook: useViewSwitchPaint in the channel and thread message lists. The HTTP
 * client's trace (utils/webHttpClientTrace.ts) reports the requests.
 *
 * Attributes are closed enums and numbers only: the view keys and ids kept
 * here to match requests and lists never leave this module. Tracing never
 * throws into the app.
 */
import { useLayoutEffect } from "react";
import { BasicTracer } from "@botiverse/raft-shared";
import type { ActiveSpan, TraceSink, TraceStatus } from "@botiverse/raft-shared";
import { webTraceSink } from "./webSpanSink";
import { performanceNow } from "./resourceTiming";
import type { RequestTiming } from "./resourceTiming";

export type ViewSwitchTarget = "channel" | "dm" | "thread" | "message_jump";
export type ViewSwitchCache = "hit" | "stale" | "miss";
export type ViewSwitchEnd = "rendered" | "superseded" | "error" | "hidden";
/** What a message list shows: a skeleton or a "Loading replies…" placeholder, its messages (or its loaded empty state), or a failure. */
export type ViewListState = "pending" | "data" | "error";

export interface ViewSwitchRequest {
  /** When it was sent (the switch's clock). */
  sentAt: number;
  /** A message page or a window around a message (`message_requests`). */
  messages?: boolean;
  done: boolean;
  doneAt?: number;
  bytes?: number;
  timing?: RequestTiming | null;
}

interface ActiveSwitch {
  span: ActiveSpan;
  target: ViewSwitchTarget;
  view: string;
  /** Ids whose presence in a request URL makes it this switch's request. */
  matches: Set<string>;
  firstVisit: boolean;
  startAt: number;
  /** The input event's timeStamp to the start hook running (browser work before the handler, plus handler work before navigating); null when the start is not the event's. */
  inputDelayMs: number | null;
  requests: ViewSwitchRequest[];
  /** When the list first showed data, and how many requests had answered by then. */
  dataAt: number | null;
  answeredBeforeData: number;
  lastAnswerAt: number | null;
  ended: boolean;
  /** `tab.visibility` at the start. */
  visibility: "visible" | "hidden";
  cancelPaint?: () => void;
  cancelStop?: () => void;
}

/** An input event's timestamp is used when it is at most this old (a later handler, a slow prompt). */
const EVENT_MAX_AGE_MS = 10_000;
/** A switch whose list never shows data ends as `error` after this long. */
const SWITCH_MAX_MS = 30_000;
/** A hidden tab paints no frame: the end falls back to this long after the data. */
const PAINT_FALLBACK_MS = 1_000;

type Raf = (callback: () => void) => () => void;
/** setTimeout behind the test seam; returns its cancel. */
type SetTimer = (callback: () => void, ms: number) => () => void;

const defaultSetTimer: SetTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

const defaultRaf: Raf = (callback) => {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  const id = requestAnimationFrame(() => callback());
  return () => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  };
};

let tracer = new BasicTracer({ sink: webTraceSink });
let clock: () => number = () => Date.now();
let raf: Raf = defaultRaf;
let setTimer: SetTimer = defaultSetTimer;
let active: ActiveSwitch | null = null;
/** Views that have been switched to in this tab, for `first_visit`. */
let visited = new Set<string>();
/** Views whose list shows data now. */
let onScreen = new Set<string>();

/** The internal key of a conversation's main message list. */
export function conversationView(channelId: string): string {
  return `conversation:${channelId}`;
}

/** The internal key of a thread panel's replies, by the parent message. */
export function threadView(parentMessageId: string): string {
  return `thread:${parentMessageId}`;
}

/**
 * The user's input that is being dispatched, or null. window.event is set
 * for every listener (React's scheduler MessageChannel, network callbacks),
 * so only a trusted event of an input type counts.
 */
const USER_INPUT_TYPES = new Set(["click", "auxclick", "pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup", "touchend", "popstate"]);

function userInputEvent(event: unknown): { timeStamp?: unknown } | null {
  try {
    const candidate = (event ?? (globalThis as { event?: unknown }).event) as { isTrusted?: unknown; type?: unknown } | null | undefined;
    if (!candidate || candidate.isTrusted !== true || typeof candidate.type !== "string") return null;
    return USER_INPUT_TYPES.has(candidate.type) ? candidate as { timeStamp?: unknown } : null;
  } catch {
    return null;
  }
}

function tabVisibility(): "visible" | "hidden" {
  try {
    return typeof document !== "undefined" && document.visibilityState === "hidden" ? "hidden" : "visible";
  } catch {
    return "visible";
  }
}

/**
 * The input event's time on the tracer clock (event.timeStamp is on
 * performance.now()'s), and how long before now it was: the input delay
 * (the browser's work before the handler ran). Without a usable event, now
 * and no delay.
 */
function inputStart(event: unknown): { startAt: number; inputDelayMs: number | null } {
  const now = clock();
  try {
    const stamp = userInputEvent(event)?.timeStamp;
    const perfNow = performanceNow();
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0 || perfNow === null) return { startAt: now, inputDelayMs: null };
    const age = perfNow - stamp;
    return age >= 0 && age <= EVENT_MAX_AGE_MS ? { startAt: now - age, inputDelayMs: age } : { startAt: now, inputDelayMs: null };
  } catch {
    return { startAt: now, inputDelayMs: null };
  }
}

function slowestTiming(requests: readonly ViewSwitchRequest[]): RequestTiming | null {
  let slowest: RequestTiming | null = null;
  for (const request of requests) {
    if (request.timing && (!slowest || request.timing.durationMs > slowest.durationMs)) slowest = request.timing;
  }
  return slowest;
}

function finish(sw: ActiveSwitch, end: ViewSwitchEnd): void {
  if (sw.ended) return;
  sw.ended = true;
  if (active === sw) active = null;
  sw.cancelPaint?.();
  sw.cancelStop?.();
  try {
    const at = clock();
    const answered = sw.dataAt === null ? 0 : sw.answeredBeforeData;
    const cache: ViewSwitchCache | undefined = sw.dataAt === null
      ? undefined
      : answered > 0 ? "miss" : sw.requests.length > 0 ? "stale" : "hit";
    const bytes = sw.requests.reduce((sum, request) => sum + (request.bytes ?? 0), 0);
    const slowest = slowestTiming(sw.requests)?.segments;
    // Data in hand: the last answer before the list showed it (a miss), else the start.
    const dataInHand = cache === "miss" && sw.lastAnswerAt !== null ? sw.lastAnswerAt : sw.startAt;
    const status: TraceStatus = end === "rendered" ? "ok" : end === "superseded" || end === "hidden" ? "cancelled" : "error";
    sw.span.end(status, {
      attrs: {
        target: sw.target,
        end,
        "tab.visibility": sw.visibility,
        first_visit: sw.firstVisit,
        requests: sw.requests.length,
        // Of those, the message pages and windows: more than one is a view reading its messages twice.
        message_requests: sw.requests.filter((request) => request.messages).length,
        bytes,
        // The input event to the switch's start (browser work, plus handler work before navigating): part of request_delay_ms.
        ...(sw.inputDelayMs !== null ? { input_delay_ms: Math.round(sw.inputDelayMs) } : {}),
        // Click to the first request sent: the wait before any network, input delay included (InNOut, AndyLok).
        ...(sw.requests.length > 0 ? {
          request_delay_ms: Math.max(0, Math.round(Math.min(...sw.requests.map((request) => request.sentAt)) - sw.startAt)),
        } : {}),
        ...(cache ? { cache } : {}),
        ...(slowest?.ttfb_ms !== undefined ? {
          queue_ms: (slowest.queue_ms ?? 0) + (slowest.connect_ms ?? 0),
          ttfb_ms: slowest.ttfb_ms,
          download_ms: slowest.download_ms,
        } : {}),
        ...(end === "rendered" ? { render_ms: Math.max(0, Math.round(at - dataInHand)) } : {}),
      },
    });
  } catch {
    // Diagnostic only.
  }
}

function markData(sw: ActiveSwitch): void {
  sw.dataAt = clock();
  sw.answeredBeforeData = sw.requests.filter((request) => request.done).length;
  const cancelFrame = raf(() => finish(sw, "rendered"));
  // No frame in time: a hidden tab. Not time anyone waited, so not "rendered" (AndyLok).
  const cancelFallback = setTimer(() => finish(sw, "hidden"), PAINT_FALLBACK_MS);
  sw.cancelPaint = () => {
    cancelFrame();
    cancelFallback();
  };
}

export interface BeginViewSwitchInput {
  target: ViewSwitchTarget;
  /** conversationView(...) or threadView(...): the list whose data ends the switch. */
  view: string;
  /** Ids that appear in this switch's request URLs (channel, thread or message ids). */
  matches: ReadonlyArray<string | null | undefined>;
  /** The input event; defaults to the event being dispatched (window.event). */
  event?: Event | null;
  /** Only while a trusted user input is being dispatched: not for a restore at boot, a URL sync after Back or an open after an await. */
  requireInput?: boolean;
}

/**
 * Start a switch. The one in flight to the same view stays (a message link
 * also opens its thread through the URL); one to another view ends as
 * `superseded`. A switch to a list already showing data is not timed, except
 * a message jump, which ends at the next frame.
 */
export function beginViewSwitch(input: BeginViewSwitchInput): void {
  try {
    if (active && active.view === input.view && !active.ended) return;
    if (input.requireInput && !userInputEvent(input.event)) return;
    const already = onScreen.has(input.view);
    if (already && input.target !== "message_jump") {
      if (active) finish(active, "superseded");
      return;
    }
    const { startAt, inputDelayMs } = inputStart(input.event);
    if (active) finish(active, "superseded");
    const sw: ActiveSwitch = {
      span: tracer.startSpan("web.view.switch", { surface: "web", kind: "internal", startTimeMs: startAt }),
      target: input.target,
      view: input.view,
      matches: new Set(input.matches.filter((id): id is string => typeof id === "string" && id.length > 0)),
      firstVisit: !visited.has(input.view),
      startAt,
      inputDelayMs,
      requests: [],
      dataAt: null,
      answeredBeforeData: 0,
      lastAnswerAt: null,
      ended: false,
      visibility: tabVisibility(),
    };
    visited.add(input.view);
    active = sw;
    sw.cancelStop = setTimer(() => finish(sw, "error"), SWITCH_MAX_MS);
    if (already) markData(sw);
  } catch {
    // Diagnostic only.
  }
}

/** The switch the app path leads to: a channel or DM, its message link, a thread link; null for any other page. */
export function viewSwitchForPath(path: string): Omit<BeginViewSwitchInput, "event"> | null {
  try {
    const url = new URL(path, "http://raft.invalid");
    const route = /\/(channel|dm)\/([^/]+)\/?$/.exec(url.pathname);
    if (!route) return null;
    const kind = route[1] as "channel" | "dm";
    const channelId = decodeURIComponent(route[2]!);
    const messageId = url.searchParams.get("msg");
    const thread = url.searchParams.get("thread");
    const separator = thread ? thread.lastIndexOf(":") : -1;
    if (thread && separator > 0) {
      // Not the parent channel: its requests are not the thread's. The thread
      // channel's id joins once known (addViewSwitchMatch).
      const parentMessageId = thread.slice(separator + 1);
      return {
        target: messageId ? "message_jump" : "thread",
        view: threadView(parentMessageId),
        matches: [parentMessageId, messageId],
      };
    }
    if (messageId) return { target: "message_jump", view: conversationView(channelId), matches: [channelId, messageId] };
    return { target: kind, view: conversationView(channelId), matches: [channelId] };
  } catch {
    return null;
  }
}

/**
 * A navigation to an app path: a conversation, its message or a thread starts
 * a switch; any other page ends the one in flight as `superseded`.
 */
export function beginViewSwitchToPath(path: string, event?: Event | null): void {
  try {
    const next = viewSwitchForPath(path);
    if (next) beginViewSwitch({ ...next, event });
    else if (active) finish(active, "superseded");
  } catch {
    // Diagnostic only.
  }
}

/** Back and Forward: the location has already changed when popstate fires. */
function onPopState(event: Event): void {
  const { pathname, search } = window.location;
  beginViewSwitchToPath(`${pathname}${search}`, event);
}

let installed = false;

/** Listen for Back and Forward. Once per page; nothing without a window. */
export function installViewSwitchTracking(): void {
  try {
    if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    installed = true;
    window.addEventListener("popstate", onPopState);
  } catch {
    // Diagnostic only.
  }
}

/** A messages page (`/messages/channel/:id?…`, not its sub-routes) or a window around a message (`/messages/context/:id`). */
const MESSAGE_READ = /\/messages\/(?:channel\/[^/?#]+(?:[?#]|$)|context\/)/;

/**
 * A request is being sent: when it is for the switch in flight (its URL
 * names one of the switch's ids) it is counted, and the returned handle
 * takes its answer. Requests sent after the end are not counted.
 */
export function noteViewSwitchRequest(url: string | undefined): ViewSwitchRequest | null {
  try {
    const sw = active;
    if (!sw || sw.ended || !url) return null;
    let matched = false;
    for (const id of sw.matches) {
      if (url.includes(id)) {
        matched = true;
        break;
      }
    }
    if (!matched) return null;
    const request: ViewSwitchRequest = { sentAt: clock(), done: false, messages: MESSAGE_READ.test(url) };
    sw.requests.push(request);
    return request;
  } catch {
    return null;
  }
}

/** An id learned after the start (a thread's channel, once resolved) joins the switch to that view's request matching. */
export function addViewSwitchMatch(view: string, id: string | null | undefined): void {
  try {
    const sw = active;
    if (sw && !sw.ended && sw.view === view && id) sw.matches.add(id);
  } catch {
    // Diagnostic only.
  }
}

/** A counted request's answer arrived (or failed): its size and timing. */
export function finishViewSwitchRequest(
  request: ViewSwitchRequest | null | undefined,
  answer: { bytes?: number; timing?: RequestTiming | null },
): void {
  try {
    if (!request || request.done) return;
    request.done = true;
    request.doneAt = clock();
    request.bytes = answer.bytes;
    request.timing = answer.timing ?? null;
    const sw = active;
    if (sw && sw.dataAt === null && sw.requests.includes(request)) sw.lastAnswerAt = request.doneAt;
  } catch {
    // Diagnostic only.
  }
}

/** A message list's state changed: data ends the switch to it at the next frame, an error ends it now. */
export function reportViewList(view: string, state: ViewListState): void {
  try {
    if (state === "data") onScreen.add(view);
    else onScreen.delete(view);
    const sw = active;
    if (!sw || sw.ended || sw.view !== view || sw.dataAt !== null) return;
    if (state === "data") markData(sw);
    else if (state === "error") finish(sw, "error");
  } catch {
    // Diagnostic only.
  }
}

/** The list is gone (or shows another view). */
export function forgetViewList(view: string): void {
  onScreen.delete(view);
}

/**
 * End hook for a message list: what it shows for which view, after each
 * commit. `matchId` (a thread's channel id) joins the switch's request
 * matching; a layout effect, so before the list's fetch in its passive effects.
 */
export function useViewSwitchPaint(view: string | null, state: ViewListState, matchId?: string | null): void {
  useLayoutEffect(() => {
    if (view) addViewSwitchMatch(view, matchId);
  }, [view, matchId]);
  useLayoutEffect(() => {
    if (!view) return undefined;
    reportViewList(view, state);
    return () => forgetViewList(view);
  }, [view, state]);
}

/** Test seam: a memory sink, a fixed clock, manual frames and timers; resets all state. */
export function __resetViewSwitchForTest(options: { sink?: TraceSink; clock?: () => number; raf?: Raf; setTimer?: SetTimer } = {}): void {
  if (active) {
    active.cancelPaint?.();
    active.cancelStop?.();
  }
  active = null;
  visited = new Set();
  onScreen = new Set();
  clock = options.clock ?? (() => Date.now());
  raf = options.raf ?? defaultRaf;
  setTimer = options.setTimer ?? defaultSetTimer;
  tracer = new BasicTracer({ sink: options.sink ?? webTraceSink, clock });
}
