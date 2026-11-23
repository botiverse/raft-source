/**
 * slock.web.vitals — real-user Web Vitals (LCP, session-window CLS, INP) and
 * Long Task summary for a tab (#proj-frontend:#77; consumer: AndyLok's daily
 * app report, registered in packages/shared traceFamilyRegistry).
 *
 * Emitted on EVERY `visibilitychange -> hidden` (and on `pagehide` when dirty)
 * via the urgent keepalive path (`emitWebEventAndFlushBeforeUnload`) with a
 * monotonically increasing `report_seq` (1, 2, 3, ...), so long-lived tabs
 * never drop late slow interactions (INP) and ScopeDB takes `MAX(report_seq)`
 * per `tabId`.
 *
 * `tabId`, `releaseSha`, `appVersion`, `clientPlatform`, `deploymentEnv`, and
 * `webAssetId` come with every web trace event; `trace_user_id` is added on
 * authenticated ingest. Every numeric metric is emitted as a JSON number (or
 * null when unsupported/unobserved), never a string. Deliberately NOT recorded:
 * URLs, element selectors/text, or any server/channel/message/user IDs.
 */

import { bootLandingOf } from "../boot/bootTiming";
import type { BootLanding } from "../boot/bootTiming";
import { clientPlatformHint } from "../utils/clientPlatformHint";
import { authBootBrowserBucketFromUserAgent, emitWebEventAndFlushBeforeUnload } from "../utils/webAuthTrace";

type WebVitalsTraceEventName = "slock.web.vitals";
const WEB_VITALS_EVENT: WebVitalsTraceEventName = "slock.web.vitals";
const MAX_TRACKED_WORST_INTERACTIONS = 10;
const CLS_SESSION_GAP_MS = 1_000;
const CLS_SESSION_MAX_MS = 5_000;

export type LcpElementKind = "text" | "image" | "other";
export type InpInteractionKind = "click" | "key" | "pointer";
export type WebVitalsTrigger = "hidden" | "pagehide";

export interface WebVitalsAttrs extends Record<string, unknown> {
  report_seq: number;
  trigger: WebVitalsTrigger;
  lcp_ms: number | null;
  lcp_element: LcpElementKind | null;
  cls: number | null;
  inp_ms: number | null;
  inp_interaction: InpInteractionKind | null;
  long_task_count: number | null;
  long_task_max_ms: number | null;
  long_task_total_ms: number | null;
  page_visible_ms: number;
  landing: BootLanding;
  nav_type: string | null;
  started_hidden: boolean;
  browser_family: string;
  form_factor: "phone" | "computer";
  platform: string;
  ui_locale: string | null;
}

type WebVitalsEmitter = (name: WebVitalsTraceEventName, attrs: WebVitalsAttrs) => void;

interface LayoutShiftLike extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface LargestContentfulPaintLike extends PerformanceEntry {
  url?: string;
  element?: { tagName?: string | null } | null;
}

interface EventTimingLike extends PerformanceEntry {
  interactionId?: number;
}

interface WorstInteraction {
  id: number;
  duration: number;
  kind: InpInteractionKind;
}

const defaultEmitter: WebVitalsEmitter = (name, attrs) => {
  void emitWebEventAndFlushBeforeUnload(name, attrs);
};

let emitter: WebVitalsEmitter = defaultEmitter;
let clock: () => number = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
let observerCtorOverride: typeof PerformanceObserver | null | undefined;

let started = false;
let detach: () => void = () => {};

let landing: BootLanding = "other";
let startedHidden = false;
let firstHiddenTimeMs = Infinity;
let visibleSinceMs: number | null = null;
let accumulatedVisibleMs = 0;
let reportSeq = 0;
let dirtySinceLastReport = true;

// LCP
let lcpMs: number | null = null;
let lcpElement: LcpElementKind | null = null;

// CLS (W3C session window)
let clsSupported = false;
let clsMaxSessionValue = 0;
let clsSessionValue = 0;
let clsSessionStartMs = 0;
let clsSessionLastMs = 0;

// INP (W3C p98 approximation across distinct interactionIds)
let inpSupported = false;
let totalInteractionCount = 0;
const seenInteractionIds = new Set<number>();
const worstInteractions: WorstInteraction[] = [];

// Long Tasks (> 50 ms)
let longTaskSupported = false;
let longTaskCount = 0;
let longTaskMaxMs = 0;
let longTaskTotalMs = 0;

const IMAGE_LCP_TAGS = new Set(["IMG", "IMAGE", "VIDEO", "SVG", "CANVAS", "PICTURE"]);
const TEXT_LCP_TAGS = new Set([
  "P", "SPAN", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "A", "LI", "PRE", "CODE", "BLOCKQUOTE", "TD", "TH", "LABEL", "BUTTON", "STRONG", "EM", "ARTICLE", "SECTION",
]);

export function classifyLcpElement(entry: Pick<LargestContentfulPaintLike, "url" | "element">): LcpElementKind {
  if (typeof entry.url === "string" && entry.url.length > 0) return "image";
  const tag = entry.element?.tagName?.toUpperCase();
  if (!tag) return "other";
  if (IMAGE_LCP_TAGS.has(tag)) return "image";
  if (TEXT_LCP_TAGS.has(tag)) return "text";
  return "other";
}

export function classifyInpInteraction(entryName: string): InpInteractionKind | null {
  switch (entryName) {
    case "keydown":
    case "keypress":
    case "keyup":
      return "key";
    case "click":
    case "auxclick":
    case "dblclick":
    case "contextmenu":
      return "click";
    case "pointerdown":
    case "pointerup":
    case "pointercancel":
    case "mousedown":
    case "mouseup":
    case "touchstart":
    case "touchend":
      return "pointer";
    default:
      return null;
  }
}

function recordLcpEntry(entry: LargestContentfulPaintLike): void {
  if (typeof entry.startTime !== "number" || !Number.isFinite(entry.startTime)) return;
  if (entry.startTime >= firstHiddenTimeMs) return;
  lcpMs = Math.round(entry.startTime);
  lcpElement = classifyLcpElement(entry);
  dirtySinceLastReport = true;
}

function recordLayoutShiftEntry(entry: LayoutShiftLike): void {
  if (entry.hadRecentInput) return;
  if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value <= 0) return;
  const start = typeof entry.startTime === "number" ? entry.startTime : 0;
  if (
    clsSessionValue > 0 &&
    start - clsSessionLastMs < CLS_SESSION_GAP_MS &&
    start - clsSessionStartMs < CLS_SESSION_MAX_MS
  ) {
    clsSessionValue += entry.value;
    clsSessionLastMs = start;
  } else {
    clsSessionValue = entry.value;
    clsSessionStartMs = start;
    clsSessionLastMs = start;
  }
  if (clsSessionValue > clsMaxSessionValue) {
    clsMaxSessionValue = clsSessionValue;
    dirtySinceLastReport = true;
  }
}

function recordEventTimingEntry(entry: EventTimingLike): void {
  const id = entry.interactionId;
  if (typeof id !== "number" || id <= 0) return;
  if (typeof entry.duration !== "number" || !Number.isFinite(entry.duration) || entry.duration < 0) return;
  const kind = classifyInpInteraction(entry.name);
  if (!kind) return;

  if (!seenInteractionIds.has(id)) {
    seenInteractionIds.add(id);
    totalInteractionCount += 1;
    // Prevent unbounded growth on multi-day tabs: we only need exact counts
    // plus recent IDs for multi-event interaction grouping.
    if (seenInteractionIds.size > 512) {
      const oldest = seenInteractionIds.values().next().value;
      if (oldest !== undefined) seenInteractionIds.delete(oldest);
    }
  }

  const existing = worstInteractions.find((item) => item.id === id);
  if (existing) {
    if (entry.duration > existing.duration) {
      existing.duration = entry.duration;
      // Prefer "click" over "pointer" when a single click interaction emits both pointerup and click.
      if (kind === "click" || existing.kind === "pointer") existing.kind = kind;
    } else if (kind === "click" && existing.kind === "pointer") {
      existing.kind = "click";
    }
  } else {
    const minTracked = worstInteractions.length < MAX_TRACKED_WORST_INTERACTIONS
      ? -1
      : worstInteractions[worstInteractions.length - 1]!.duration;
    if (entry.duration > minTracked) {
      worstInteractions.push({ id, duration: entry.duration, kind });
    }
  }

  worstInteractions.sort((a, b) => b.duration - a.duration);
  if (worstInteractions.length > MAX_TRACKED_WORST_INTERACTIONS) {
    worstInteractions.length = MAX_TRACKED_WORST_INTERACTIONS;
  }
  dirtySinceLastReport = true;
}

function readBrowserInteractionCount(): number {
  try {
    const raw = (globalThis.performance as { interactionCount?: unknown } | undefined)?.interactionCount;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
}

function computeInp(): { ms: number | null; kind: InpInteractionKind | null } {
  const interactionTotal = Math.max(totalInteractionCount, readBrowserInteractionCount());
  if (!inpSupported || interactionTotal === 0 || worstInteractions.length === 0) {
    return { ms: null, kind: null };
  }
  // Google web-vitals p98 estimate: ignore 1 worst interaction per 50 interactions.
  const idx = Math.min(Math.floor(interactionTotal / 50), worstInteractions.length - 1);
  const winner = worstInteractions[idx]!;
  return { ms: Math.round(winner.duration), kind: winner.kind };
}

function recordLongTaskEntry(entry: PerformanceEntry): void {
  if (typeof entry.duration !== "number" || !Number.isFinite(entry.duration) || entry.duration <= 0) return;
  longTaskCount += 1;
  if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
  longTaskTotalMs += entry.duration;
  dirtySinceLastReport = true;
}

function navType(): string | null {
  try {
    const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type ?? null;
  } catch {
    return null;
  }
}

function formFactor(): "phone" | "computer" {
  try {
    return window.matchMedia?.("(max-width: 767px)").matches ? "phone" : "computer";
  } catch {
    return "computer";
  }
}

function flushVisibleDuration(nowMs: number): void {
  if (visibleSinceMs === null) return;
  const delta = nowMs - visibleSinceMs;
  if (delta > 0 && Number.isFinite(delta)) {
    accumulatedVisibleMs += delta;
    dirtySinceLastReport = true;
  }
  visibleSinceMs = null;
}

function currentVisibleMs(nowMs: number): number {
  const openDelta = visibleSinceMs !== null ? Math.max(0, nowMs - visibleSinceMs) : 0;
  return Math.round(accumulatedVisibleMs + openDelta);
}

function buildAttrs(trigger: WebVitalsTrigger, nowMs: number): WebVitalsAttrs {
  const inp = computeInp();
  return {
    report_seq: reportSeq,
    trigger,
    lcp_ms: lcpMs,
    lcp_element: lcpMs !== null ? lcpElement : null,
    cls: clsSupported ? Math.round(clsMaxSessionValue * 10_000) / 10_000 : null,
    inp_ms: inp.ms,
    inp_interaction: inp.kind,
    long_task_count: longTaskSupported ? longTaskCount : null,
    long_task_max_ms: longTaskSupported && longTaskCount > 0 ? Math.round(longTaskMaxMs) : null,
    long_task_total_ms: longTaskSupported ? Math.round(longTaskTotalMs) : null,
    page_visible_ms: currentVisibleMs(nowMs),
    landing,
    nav_type: navType(),
    started_hidden: startedHidden,
    browser_family: authBootBrowserBucketFromUserAgent(typeof navigator === "undefined" ? null : navigator.userAgent),
    form_factor: formFactor(),
    platform: clientPlatformHint(),
    ui_locale: typeof document === "undefined" ? null : (document.documentElement.lang || null),
  };
}

function emitSnapshot(trigger: WebVitalsTrigger, observers: PerformanceObserver[]): void {
  try {
    // Pull any buffered entries not yet delivered to callbacks before reading state.
    for (const obs of observers) {
      try {
        const pending = obs.takeRecords?.() ?? [];
        for (const entry of pending) {
          if (entry.entryType === "largest-contentful-paint") recordLcpEntry(entry as LargestContentfulPaintLike);
          else if (entry.entryType === "layout-shift") recordLayoutShiftEntry(entry as LayoutShiftLike);
          else if (entry.entryType === "event" || entry.entryType === "first-input") recordEventTimingEntry(entry as EventTimingLike);
          else if (entry.entryType === "longtask") recordLongTaskEntry(entry);
        }
      } catch {
        // Ignore observer errors during teardown.
      }
    }
    const nowMs = clock();
    if (firstHiddenTimeMs === Infinity) firstHiddenTimeMs = nowMs;
    flushVisibleDuration(nowMs);
    if (trigger === "pagehide" && !dirtySinceLastReport) return;
    reportSeq += 1;
    dirtySinceLastReport = false;
    emitter(WEB_VITALS_EVENT, buildAttrs(trigger, nowMs));
  } catch {
    // Telemetry must never affect the app.
  }
}

function observeType(
  ObserverCtor: typeof PerformanceObserver,
  options: PerformanceObserverInit & { durationThreshold?: number },
  onEntry: (entry: PerformanceEntry) => void,
  observers: PerformanceObserver[],
): boolean {
  try {
    const supported = ObserverCtor.supportedEntryTypes;
    if (Array.isArray(supported) && options.type && !supported.includes(options.type)) {
      return false;
    }
    const obs = new ObserverCtor((list) => {
      try {
        for (const entry of list.getEntries()) onEntry(entry);
      } catch {
        // Diagnostic only.
      }
    });
    obs.observe(options);
    observers.push(obs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start observing real-user Web Vitals (LCP, CLS, INP) and Long Tasks once per
 * page load (called from main.tsx beside startBootTiming). Safe no-op in SSR
 * or browsers without PerformanceObserver.
 */
export function startWebVitals(location: Pick<Location, "pathname" | "search"> = window.location): void {
  if (started) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  started = true;
  landing = bootLandingOf(location.pathname, location.search);
  startedHidden = document.visibilityState === "hidden";
  firstHiddenTimeMs = startedHidden ? 0 : Infinity;
  visibleSinceMs = startedHidden ? null : clock();

  const observers: PerformanceObserver[] = [];
  const ObserverCtor =
    observerCtorOverride !== undefined
      ? observerCtorOverride
      : (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver ?? null;

  if (ObserverCtor) {
    observeType(ObserverCtor, { type: "largest-contentful-paint", buffered: true }, (e) => {
      recordLcpEntry(e as LargestContentfulPaintLike);
    }, observers);
    clsSupported = observeType(ObserverCtor, { type: "layout-shift", buffered: true }, (e) => {
      recordLayoutShiftEntry(e as LayoutShiftLike);
    }, observers);
    inpSupported = observeType(ObserverCtor, { type: "event", buffered: true, durationThreshold: 40 }, (e) => {
      recordEventTimingEntry(e as EventTimingLike);
    }, observers);
    if (inpSupported) {
      observeType(ObserverCtor, { type: "first-input", buffered: true }, (e) => {
        recordEventTimingEntry(e as EventTimingLike);
      }, observers);
    }
    longTaskSupported = observeType(ObserverCtor, { type: "longtask", buffered: true }, (e) => {
      recordLongTaskEntry(e);
    }, observers);
  }

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      emitSnapshot("hidden", observers);
    } else if (document.visibilityState === "visible" && visibleSinceMs === null) {
      visibleSinceMs = clock();
      dirtySinceLastReport = true;
    }
  };
  const onPageHide = () => {
    emitSnapshot("pagehide", observers);
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  detach = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    for (const obs of observers) {
      try {
        obs.disconnect();
      } catch {
        // Ignore disconnect error.
      }
    }
  };
}

/** Test seam: reset all module state and optionally inject emitter, clock, and PerformanceObserver. */
export function __resetWebVitalsForTest(options?: {
  emitter?: WebVitalsEmitter | null;
  clock?: (() => number) | null;
  observerCtor?: typeof PerformanceObserver | null;
}): void {
  detach();
  detach = () => {};
  emitter = options?.emitter ?? defaultEmitter;
  clock = options?.clock ?? (() => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()));
  observerCtorOverride = options && "observerCtor" in options ? options.observerCtor : undefined;

  started = false;
  landing = "other";
  startedHidden = false;
  firstHiddenTimeMs = Infinity;
  visibleSinceMs = null;
  accumulatedVisibleMs = 0;
  reportSeq = 0;
  dirtySinceLastReport = true;

  lcpMs = null;
  lcpElement = null;
  clsSupported = false;
  clsMaxSessionValue = 0;
  clsSessionValue = 0;
  clsSessionStartMs = 0;
  clsSessionLastMs = 0;
  inpSupported = false;
  totalInteractionCount = 0;
  seenInteractionIds.clear();
  worstInteractions.length = 0;
  longTaskSupported = false;
  longTaskCount = 0;
  longTaskMaxMs = 0;
  longTaskTotalMs = 0;
}
