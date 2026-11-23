import assert from "node:assert/strict";
import "./helpers/domSetup";
import {
  __resetWebVitalsForTest,
  classifyInpInteraction,
  classifyLcpElement,
  startWebVitals,
} from "../src/observability/webVitals";
import type { WebVitalsAttrs } from "../src/observability/webVitals";

type FakeEntry = Record<string, unknown> & { entryType: string; name?: string; startTime?: number; duration?: number };

interface ObserverInstance {
  type: string;
  cb: (list: { getEntries: () => PerformanceEntry[] }) => void;
  pending: FakeEntry[];
  disconnected: boolean;
}

let events: WebVitalsAttrs[] = [];
let nowMs = 0;
let observers: ObserverInstance[] = [];
let supportedTypes: string[] = ["largest-contentful-paint", "layout-shift", "event", "first-input", "longtask"];

class FakePerformanceObserver {
  static get supportedEntryTypes(): string[] {
    return supportedTypes;
  }

  private instance: ObserverInstance | null = null;
  private cb: (list: { getEntries: () => PerformanceEntry[] }) => void;

  constructor(cb: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    this.cb = cb;
  }

  observe(options: PerformanceObserverInit): void {
    const type = options.type ?? "";
    this.instance = { type, cb: this.cb, pending: [], disconnected: false };
    observers.push(this.instance);
  }

  takeRecords(): PerformanceEntry[] {
    if (!this.instance) return [];
    return this.instance.pending.splice(0) as unknown as PerformanceEntry[];
  }

  disconnect(): void {
    if (this.instance) this.instance.disconnected = true;
  }
}

function deliver(entryType: string, entries: FakeEntry[]): void {
  for (const obs of observers) {
    if (!obs.disconnected && obs.type === entryType) {
      obs.cb({ getEntries: () => entries as unknown as PerformanceEntry[] });
    }
  }
}

function queuePending(entryType: string, entries: FakeEntry[]): void {
  for (const obs of observers) {
    if (!obs.disconnected && obs.type === entryType) {
      obs.pending.push(...entries);
    }
  }
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new window.Event("visibilitychange"));
}

beforeEach(() => {
  events = [];
  nowMs = 1_000;
  observers = [];
  supportedTypes = ["largest-contentful-paint", "layout-shift", "event", "first-input", "longtask"];
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  __resetWebVitalsForTest({
    emitter: (_name, attrs) => {
      events.push(attrs);
    },
    clock: () => nowMs,
    observerCtor: FakePerformanceObserver as unknown as typeof PerformanceObserver,
  });
});

afterEach(() => {
  __resetWebVitalsForTest();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

test("classifies LCP elements and INP interactions into closed enums without URLs or selectors", () => {
  assert.equal(classifyLcpElement({ url: "https://cdn.example.test/secret.png", element: { tagName: "DIV" } }), "image");
  assert.equal(classifyLcpElement({ url: "", element: { tagName: "IMG" } }), "image");
  assert.equal(classifyLcpElement({ url: "", element: { tagName: "P" } }), "text");
  assert.equal(classifyLcpElement({ url: "", element: { tagName: "CUSTOM-EL" } }), "other");
  assert.equal(classifyLcpElement({}), "other");

  assert.equal(classifyInpInteraction("keydown"), "key");
  assert.equal(classifyInpInteraction("click"), "click");
  assert.equal(classifyInpInteraction("pointerup"), "pointer");
  assert.equal(classifyInpInteraction("mousemove"), null);
});

test("emits LCP, session-window CLS, INP, long tasks, and page_visible_ms with numeric types and no IDs", () => {
  startWebVitals({ pathname: "/s/acme/channel/c0ffee00-1111-4222-8333-444455556666", search: "" });

  // LCP updates to latest candidate before first hide
  deliver("largest-contentful-paint", [
    { entryType: "largest-contentful-paint", startTime: 420.4, element: { tagName: "DIV" } },
    { entryType: "largest-contentful-paint", startTime: 1185.6, url: "https://cdn.example.test/avatar.png", element: { tagName: "IMG" } },
  ]);

  // CLS session windows:
  // Window 1: 0.05 + 0.04 = 0.09 (within 1s gap & 5s window), plus hadRecentInput ignored
  // Window 2 (gap > 1s): 0.03 + 0.02 + 0.02 + 0.02 + 0.03 + 0.03 = 0.15 across <1s gaps spanning 4.5s (max!)
  // Window 3 (600ms gap from 7500, but 8100 - 3000 = 5100ms >= 5s cap -> MUST split, not add to 0.15): 0.06
  deliver("layout-shift", [
    { entryType: "layout-shift", startTime: 1000, value: 0.05, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 1500, value: 0.04, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 1600, value: 0.99, hadRecentInput: true },
    { entryType: "layout-shift", startTime: 3000, value: 0.03, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 3900, value: 0.02, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 4800, value: 0.02, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 5700, value: 0.02, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 6600, value: 0.03, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 7500, value: 0.03, hadRecentInput: false },
    { entryType: "layout-shift", startTime: 8100, value: 0.06, hadRecentInput: false },
  ]);

  // INP: interaction 10 emits pointerup (96ms) then click (144ms) -> grouped as click 144ms
  // interaction 11 emits keydown (64ms)
  deliver("event", [
    { entryType: "event", name: "pointerup", interactionId: 10, duration: 96 },
    { entryType: "event", name: "click", interactionId: 10, duration: 144 },
    { entryType: "event", name: "keydown", interactionId: 11, duration: 64 },
    { entryType: "event", name: "click", interactionId: 0, duration: 999 },
  ]);

  // Long tasks (>50ms): full duration summed, max tracked
  deliver("longtask", [
    { entryType: "longtask", startTime: 2000, duration: 72 },
    { entryType: "longtask", startTime: 2500, duration: 185 },
  ]);

  nowMs = 5_500;
  setVisibility("hidden");

  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.report_seq, 1);
  assert.equal(ev.trigger, "hidden");
  assert.equal(ev.lcp_ms, 1186);
  assert.equal(ev.lcp_element, "image");
  assert.equal(ev.cls, 0.15);
  assert.equal(ev.inp_ms, 144);
  assert.equal(ev.inp_interaction, "click");
  assert.equal(ev.long_task_count, 2);
  assert.equal(ev.long_task_max_ms, 185);
  assert.equal(ev.long_task_total_ms, 257);
  assert.equal(ev.page_visible_ms, 4500);
  assert.equal(ev.landing, "channel");
  assert.equal(ev.started_hidden, false);

  for (const key of [
    "report_seq", "lcp_ms", "cls", "inp_ms",
    "long_task_count", "long_task_max_ms", "long_task_total_ms", "page_visible_ms",
  ]) {
    assert.equal(typeof ev[key], "number", `${key} must be a JSON number`);
  }
  const serialized = JSON.stringify(ev);
  assert.equal(serialized.includes("c0ffee00"), false, "no channel id");
  assert.equal(serialized.includes("avatar.png"), false, "no element URL");
  assert.equal(serialized.includes("acme"), false, "no server slug");
});

test("re-emits on every visibilitychange -> hidden with monotonic report_seq, captures late INP, and deduplicates clean pagehide", () => {
  startWebVitals({ pathname: "/s/acme/dm/d1", search: "" });

  nowMs = 3_000;
  setVisibility("hidden");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.report_seq, 1);
  assert.equal(events[0]!.inp_ms, null);
  assert.equal(events[0]!.page_visible_ms, 2000);

  // Clean pagehide right after hidden emits nothing
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(events.length, 1);

  // User returns to the tab 60s later (hidden duration must NOT count in page_visible_ms)
  nowMs = 63_000;
  setVisibility("visible");

  // Late slow keydown interaction + late LCP candidate (must be ignored after first hide!)
  deliver("largest-contentful-paint", [
    { entryType: "largest-contentful-paint", startTime: 64_000, element: { tagName: "P" } },
  ]);
  queuePending("event", [
    { entryType: "event", name: "keydown", interactionId: 42, duration: 280 },
  ]);

  nowMs = 68_000;
  setVisibility("hidden");
  assert.equal(events.length, 2);
  const second = events[1]!;
  assert.equal(second.report_seq, 2);
  assert.equal(second.trigger, "hidden");
  assert.equal(second.lcp_ms, null, "LCP after first hide is ignored");
  assert.equal(second.inp_ms, 280, "late slow interaction drained via takeRecords");
  assert.equal(second.inp_interaction, "key");
  assert.equal(second.page_visible_ms, 7000, "2000ms first spell + 5000ms second spell");

  // Dirty pagehide (e.g. long task happened right before unload) DOES emit with report_seq = 3
  deliver("longtask", [{ entryType: "longtask", startTime: 68_500, duration: 90 }]);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(events.length, 3);
  assert.equal(events[2]!.report_seq, 3);
  assert.equal(events[2]!.trigger, "pagehide");
  assert.equal(events[2]!.long_task_count, 1);
});

test("uses W3C p98 INP rule (drops 1 worst interaction per 50 interactions)", () => {
  startWebVitals({ pathname: "/s/acme/channel/c1", search: "" });

  // 55 distinct interactions: 1 outlier at 400ms, 1 at 120ms, 53 at 48ms -> idx = floor(55/50) = 1 -> 120ms
  const batch: FakeEntry[] = [
    { entryType: "event", name: "click", interactionId: 1, duration: 400 },
    { entryType: "event", name: "keydown", interactionId: 2, duration: 120 },
  ];
  for (let i = 3; i <= 55; i += 1) {
    batch.push({ entryType: "event", name: "pointerup", interactionId: i, duration: 48 });
  }
  deliver("event", batch);

  nowMs = 2_000;
  setVisibility("hidden");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.inp_ms, 120);
  assert.equal(events[0]!.inp_interaction, "key");
});

test("degrades cleanly to null metrics when PerformanceObserver is unavailable or types are unsupported", () => {
  __resetWebVitalsForTest({
    emitter: (_name, attrs) => {
      events.push(attrs);
    },
    clock: () => nowMs,
    observerCtor: null,
  });
  startWebVitals({ pathname: "/", search: "" });
  nowMs = 1_500;
  setVisibility("hidden");

  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.landing, "root");
  assert.equal(ev.lcp_ms, null);
  assert.equal(ev.lcp_element, null);
  assert.equal(ev.cls, null);
  assert.equal(ev.inp_ms, null);
  assert.equal(ev.inp_interaction, null);
  assert.equal(ev.long_task_count, null);
  assert.equal(ev.long_task_max_ms, null);
  assert.equal(ev.long_task_total_ms, null);
  assert.equal(ev.page_visible_ms, 500);
});

test("marks started_hidden and ignores LCP when the tab begins hidden", () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  startWebVitals({ pathname: "/s/acme/channel/c1", search: "" });
  deliver("largest-contentful-paint", [
    { entryType: "largest-contentful-paint", startTime: 100, element: { tagName: "P" } },
  ]);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.started_hidden, true);
  assert.equal(events[0]!.lcp_ms, null);
  assert.equal(events[0]!.page_visible_ms, 0);
});
