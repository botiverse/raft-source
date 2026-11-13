import assert from "node:assert/strict";
import { MemoryTraceSink } from "@botiverse/raft-shared";
import type { CompletedTraceSpan } from "@botiverse/raft-shared";
import { __resetResourceTimingForTest } from "../src/observability/resourceTiming";
import {
  __resetViewSwitchForTest,
  addViewSwitchMatch,
  beginViewSwitch,
  beginViewSwitchToPath,
  conversationView,
  reportViewList,
  threadView,
  viewSwitchForPath,
} from "../src/observability/viewSwitchSpan";
import {
  __setWebHttpClientTraceSinkForTest,
  attachWebHttpClientTrace,
  finishWebHttpClientTrace,
} from "../src/utils/webHttpClientTrace";
import { apiRouteTemplate } from "../src/observability/apiRouteTemplate";
import { threadRepliesState } from "../src/features/thread/useThreadViewSwitch";
import { chatPanelListState } from "../src/features/channel/useChatPanelViewSwitch";

// `web.view.switch` (#triage:8c0d2318): from the input to the frame after the
// target view's message list first shows data, and what `web.http.client`
// adds (route template, size, Resource Timing).

const CHANNEL = "c0ffee00-1111-4222-8333-444455556666";
const OTHER_CHANNEL = "deadbeef-1111-4222-8333-444455556666";
const PARENT_MESSAGE = "a11ce000-1111-4222-8333-444455556666";
const MESSAGE = "b0b00000-1111-4222-8333-444455556666";
const IDS = [CHANNEL, OTHER_CHANNEL, PARENT_MESSAGE, MESSAGE, "my-server", "general"];
const ALLOWED_ATTRS = new Set([
  "target", "cache", "first_visit", "requests", "message_requests", "bytes", "request_delay_ms", "input_delay_ms", "queue_ms", "ttfb_ms", "download_ms", "render_ms", "end", "tab.visibility",
]);

let now = 1_000_000;
let frames: Array<() => void> = [];
let timers: Array<{ at: number; callback: () => void }> = [];
const sink = new MemoryTraceSink();
const httpSink = new MemoryTraceSink();
const realPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
const realObserver = Object.getOwnPropertyDescriptor(globalThis, "PerformanceObserver");

/** A trusted user input of this type, dispatched at `timeStamp` on performance.now()'s clock. */
function input(timeStamp: number, type = "click"): Event {
  return { isTrusted: true, type, timeStamp } as Event;
}

/** Move the clock and run the timers that are due. */
function advance(ms: number): void {
  now += ms;
  const due = timers.filter((timer) => timer.at <= now);
  timers = timers.filter((timer) => timer.at > now);
  for (const timer of due) timer.callback();
}

function flushFrame(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

function switchSpans(): CompletedTraceSpan[] {
  return sink.getAllSpans().filter((span) => span.name === "web.view.switch");
}

function only(): CompletedTraceSpan {
  const spans = switchSpans();
  assert.equal(spans.length, 1, "one web.view.switch span");
  return spans[0]!;
}

/** A Resource Timing entry for a URL, and performance.now() at a fixed point. */
function stubPerformance(entries: Array<Partial<PerformanceResourceTiming> & { name: string }>, perfNow = 50_000): void {
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now: () => perfNow,
      getEntriesByName: (name: string) => entries.filter((entry) => entry.name === name),
      getEntriesByType: () => entries,
    },
  });
}

/** One API request through the HTTP client trace, as the Axios interceptors run it. */
function request(url: string, answer: { status?: number; contentLength?: number } = {}): () => void {
  const config = { method: "get", url, baseURL: "https://api.example.test/api", headers: {} as Record<string, unknown> };
  attachWebHttpClientTrace(config);
  return () => {
    now += 5;
    finishWebHttpClientTrace(config, {
      statusCode: answer.status ?? 200,
      responseHeaders: answer.contentLength === undefined ? {} : { "content-length": String(answer.contentLength) },
    });
  };
}

beforeEach(() => {
  now = 1_000_000;
  frames = [];
  timers = [];
  sink.clear();
  httpSink.clear();
  stubPerformance([]);
  Object.defineProperty(globalThis, "PerformanceObserver", { configurable: true, value: undefined });
  __resetResourceTimingForTest();
  __resetViewSwitchForTest({
    sink,
    clock: () => now,
    raf: (callback) => {
      frames.push(callback);
      return () => {
        frames = frames.filter((frame) => frame !== callback);
      };
    },
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
  });
  __setWebHttpClientTraceSinkForTest(httpSink);
});

afterEach(() => {
  __resetViewSwitchForTest();
  __setWebHttpClientTraceSinkForTest(null);
  if (realPerformance) Object.defineProperty(globalThis, "performance", realPerformance);
  if (realObserver) Object.defineProperty(globalThis, "PerformanceObserver", realObserver);
  else Reflect.deleteProperty(globalThis, "PerformanceObserver");
  Reflect.deleteProperty(globalThis, "event");
  __resetResourceTimingForTest();
});

test("a channel switch painted from local data is a hit, timed from the click's timestamp to the next frame", () => {
  // The click happened 40 ms before the handler ran (event.timeStamp is on performance.now()'s clock).
  stubPerformance([], 50_000);
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`, input(49_960));
  now += 3;
  reportViewList(conversationView(CHANNEL), "data");
  assert.equal(switchSpans().length, 0, "ends in the frame after the data, not before");
  now += 16;
  flushFrame();

  const span = only();
  assert.equal(span.startTimeMs, 1_000_000 - 40);
  assert.equal(span.endTimeMs, 1_000_019);
  assert.equal(span.status, "ok");
  assert.deepEqual(span.attrs, {
    target: "channel",
    end: "rendered",
    "tab.visibility": "visible",
    first_visit: true,
    requests: 0,
    message_requests: 0,
    bytes: 0,
    input_delay_ms: 40,
    cache: "hit",
    render_ms: 59,
  });
});

test("input_delay_ms is the input event's timestamp to the handler start, a part of request_delay_ms; absent without an input event", () => {
  // The click happened 40 ms before the handler ran; the handler sends 5 ms in.
  stubPerformance([], 50_000);
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`, input(49_960));
  now += 5;
  request(`/messages/channel/${CHANNEL}?limit=50`)();
  reportViewList(conversationView(CHANNEL), "data");
  flushFrame();
  const clicked = only();
  assert.equal(clicked.attrs?.input_delay_ms, 40, "the browser's work before the handler");
  assert.equal(clicked.attrs?.request_delay_ms, 45, "the input delay plus the app's 5 ms");

  sink.clear();
  beginViewSwitchToPath(`/s/my-server/channel/${OTHER_CHANNEL}`, null);
  now += 5;
  request(`/messages/channel/${OTHER_CHANNEL}?limit=50`)();
  reportViewList(conversationView(OTHER_CHANNEL), "data");
  flushFrame();
  const unstamped = only();
  assert.equal(unstamped.attrs?.request_delay_ms, 5);
  assert.ok(!("input_delay_ms" in (unstamped.attrs ?? {})), "no input event: no input delay");
});

test("a miss waits for the network: the skeleton does not end it, the data does", () => {
  stubPerformance([{
    name: `https://api.example.test/api/messages/channel/${CHANNEL}?limit=50`,
    startTime: 50_000,
    fetchStart: 50_001,
    domainLookupStart: 50_010,
    requestStart: 50_030,
    responseStart: 50_130,
    responseEnd: 50_150,
    encodedBodySize: 2048,
  }], 50_000);
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`, null);
  reportViewList(conversationView(CHANNEL), "pending");
  now += 220;
  const answer = request(`/messages/channel/${CHANNEL}?limit=50`);
  flushFrame();
  now += 200;
  flushFrame();
  assert.equal(switchSpans().length, 0, "a skeleton is not the list with data");

  answer();
  const answeredAt = now;
  now += 10;
  reportViewList(conversationView(CHANNEL), "data");
  now += 6;
  flushFrame();

  const span = only();
  assert.equal(span.attrs?.cache, "miss");
  assert.equal(span.attrs?.requests, 1);
  assert.equal(span.attrs?.message_requests, 1, "the page");
  assert.equal(span.attrs?.bytes, 2048);
  assert.equal(span.attrs?.request_delay_ms, 220, "the click to the first request sent");
  assert.equal(span.attrs?.queue_ms, 30, "queue + connect: start to request sent");
  assert.equal(span.attrs?.ttfb_ms, 100);
  assert.equal(span.attrs?.download_ms, 20);
  assert.equal(span.attrs?.render_ms, now - answeredAt, "data in hand to painted");
});

test("local data then a refresh is stale", () => {
  beginViewSwitchToPath(`/s/my-server/dm/${CHANNEL}`);
  reportViewList(conversationView(CHANNEL), "data");
  // The refresh goes out in the passive effects, before the frame.
  const answer = request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 512 });
  flushFrame();
  answer();
  const span = only();
  assert.equal(span.attrs?.target, "dm");
  assert.equal(span.attrs?.cache, "stale");
  assert.equal(span.attrs?.requests, 1);
  assert.equal(span.attrs?.bytes, 0, "its answer came after the end");
});

test("a newer switch supersedes the one in flight, which is still emitted with its end", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  reportViewList(conversationView(CHANNEL), "pending");
  now += 100;
  beginViewSwitchToPath(`/s/my-server/channel/${OTHER_CHANNEL}`);
  reportViewList(conversationView(OTHER_CHANNEL), "data");
  // The first channel's data arriving late ends nothing.
  reportViewList(conversationView(CHANNEL), "data");
  flushFrame();

  const [first, second] = switchSpans();
  assert.equal(first?.attrs?.end, "superseded");
  assert.equal(first?.status, "cancelled");
  assert.equal(first?.attrs?.cache, undefined, "never showed data");
  assert.equal(first?.attrs?.render_ms, undefined);
  assert.equal(second?.attrs?.end, "rendered");
  assert.equal(switchSpans().length, 2);
});

test("leaving for a page that is not a conversation supersedes the switch in flight", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  beginViewSwitchToPath("/s/my-server/settings/account");
  assert.equal(only().attrs?.end, "superseded");
});

test("a failed list ends the switch as error", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  reportViewList(conversationView(CHANNEL), "error");
  const span = only();
  assert.equal(span.attrs?.end, "error");
  assert.equal(span.status, "error");
});

test("thread and message_jump targets", () => {
  assert.deepEqual(viewSwitchForPath(`/s/x/channel/${CHANNEL}?msg=${MESSAGE}`), {
    target: "message_jump", view: conversationView(CHANNEL), matches: [CHANNEL, MESSAGE],
  });
  assert.deepEqual(viewSwitchForPath(`/s/x/channel/${CHANNEL}?thread=${CHANNEL}:${PARENT_MESSAGE}`)?.target, "thread");
  assert.deepEqual(viewSwitchForPath(`/s/x/channel/${CHANNEL}?msg=${MESSAGE}&thread=${CHANNEL}:${PARENT_MESSAGE}`), {
    target: "message_jump", view: threadView(PARENT_MESSAGE), matches: [PARENT_MESSAGE, MESSAGE],
  });
  assert.equal(viewSwitchForPath(`/s/x/channel/${CHANNEL}/search`), null);
  assert.equal(viewSwitchForPath("/s/x/agent/a1"), null);

  // A thread opened from its message; its link then also opens it through the URL: one switch.
  beginViewSwitch({ target: "thread", view: threadView(PARENT_MESSAGE), matches: [CHANNEL, PARENT_MESSAGE, null] });
  beginViewSwitchToPath(`/s/x/channel/${CHANNEL}?thread=${CHANNEL}:${PARENT_MESSAGE}`);
  reportViewList(threadView(PARENT_MESSAGE), "pending");
  reportViewList(threadView(PARENT_MESSAGE), "data");
  flushFrame();
  assert.equal(only().attrs?.target, "thread");

  // Opening the thread already on screen is no switch; a jump to a message in it ends at the next frame.
  sink.clear();
  beginViewSwitch({ target: "thread", view: threadView(PARENT_MESSAGE), matches: [PARENT_MESSAGE] });
  flushFrame();
  assert.equal(switchSpans().length, 0);
  beginViewSwitchToPath(`/s/x/channel/${CHANNEL}?msg=${MESSAGE}&thread=${CHANNEL}:${PARENT_MESSAGE}`);
  flushFrame();
  const jump = only();
  assert.equal(jump.attrs?.target, "message_jump");
  assert.equal(jump.attrs?.cache, "hit");
  assert.equal(jump.attrs?.first_visit, false);
});

test("a thread opened with no input (a restore at boot, a URL sync) is not timed", () => {
  const thread = { target: "thread" as const, view: threadView(PARENT_MESSAGE), matches: [PARENT_MESSAGE], requireInput: true };
  beginViewSwitch(thread);
  reportViewList(threadView(PARENT_MESSAGE), "data");
  flushFrame();
  assert.equal(switchSpans().length, 0);
  reportViewList(threadView(PARENT_MESSAGE), "pending");
  beginViewSwitch({ ...thread, event: input(49_990) });
  reportViewList(threadView(PARENT_MESSAGE), "data");
  flushFrame();
  assert.equal(only().attrs?.target, "thread");
});

test("only a trusted user input counts as the input: not the scheduler's or a network callback's window.event", () => {
  const thread = { target: "thread" as const, view: threadView(PARENT_MESSAGE), matches: [PARENT_MESSAGE], requireInput: true };
  for (const event of [
    { isTrusted: true, type: "message", timeStamp: 49_990 },
    { isTrusted: true, type: "load", timeStamp: 49_990 },
    { isTrusted: false, type: "click", timeStamp: 49_990 },
  ]) {
    Object.defineProperty(globalThis, "event", { configurable: true, value: event });
    beginViewSwitch(thread);
  }
  assert.equal(sink.getAllSpans().length, 0);
  assert.equal(frames.length + timers.length, 0, "no switch started");

  // A navigation with a non-input window.event is timed from now, not from that event.
  stubPerformance([], 50_000);
  Object.defineProperty(globalThis, "event", { configurable: true, value: { isTrusted: true, type: "message", timeStamp: 49_000 } });
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  Object.defineProperty(globalThis, "event", { configurable: true, value: input(49_900, "keydown") });
  reportViewList(conversationView(CHANNEL), "data");
  flushFrame();
  assert.equal(only().startTimeMs, 1_000_000);
});

test("a thread's replies are matched by its channel id once known; the parent channel's requests are not its", () => {
  const THREAD_CHANNEL = "71ead000-1111-4222-8333-444455556666";
  beginViewSwitch({ target: "thread", view: threadView(PARENT_MESSAGE), matches: [PARENT_MESSAGE, null], event: input(49_990) });
  const lookup = request(`/channels/${CHANNEL}/threads/${PARENT_MESSAGE}`, { contentLength: 30 });
  const parentPage = request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 4000 });
  lookup();
  parentPage();
  // The lookup answered: the thread channel is known; the replies list's hook adds it.
  addViewSwitchMatch(threadView(PARENT_MESSAGE), THREAD_CHANNEL);
  const replies = request(`/messages/channel/${THREAD_CHANNEL}?limit=50`, { contentLength: 700 });
  replies();
  reportViewList(threadView(PARENT_MESSAGE), "data");
  flushFrame();

  const span = only();
  assert.equal(span.attrs?.requests, 2, "the lookup and the replies");
  assert.equal(span.attrs?.bytes, 730);
  assert.equal(span.attrs?.cache, "miss");
});

test("a switch whose list never shows data ends as error at 30 s; a hidden tab ends as hidden 1 s after the data", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  reportViewList(conversationView(CHANNEL), "pending");
  advance(29_999);
  assert.equal(switchSpans().length, 0);
  advance(1);
  assert.equal(only().attrs?.end, "error");

  sink.clear();
  beginViewSwitchToPath(`/s/my-server/channel/${OTHER_CHANNEL}`);
  reportViewList(conversationView(OTHER_CHANNEL), "data");
  advance(999);
  assert.equal(switchSpans().length, 0);
  advance(1); // no frame came (a hidden tab)
  const span = only();
  assert.equal(span.attrs?.end, "hidden", "not counted as a rendered switch");
  assert.equal(span.attrs?.render_ms, undefined);
  assert.equal(span.endTimeMs, now);
  assert.equal(timers.length, 0, "its 30 s cap is cancelled");
  flushFrame();
  assert.equal(switchSpans().length, 1, "the frame after it ends nothing again");
});

test("requests and bytes count only this switch's requests, sent before its end", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`);
  const mine = request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 1000 });
  const info = request(`/channels/${CHANNEL}`, { contentLength: 200 });
  const unrelated = request(`/messages/channel/${OTHER_CHANNEL}?limit=50`, { contentLength: 9999 });
  const poll = request("/messages/sync?after=1", { contentLength: 7777 });
  mine();
  info();
  unrelated();
  poll();
  reportViewList(conversationView(CHANNEL), "data");
  flushFrame();
  const late = request(`/messages/channel/${CHANNEL}?limit=50&before=10`, { contentLength: 5000 });
  late();

  const span = only();
  assert.equal(span.attrs?.requests, 2);
  assert.equal(span.attrs?.bytes, 1200);
  assert.equal(span.attrs?.cache, "miss");
});

test("attributes are closed enums and numbers: no ids, slugs or text", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}?msg=${MESSAGE}&thread=${CHANNEL}:${PARENT_MESSAGE}`);
  request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 10 })();
  reportViewList(threadView(PARENT_MESSAGE), "data");
  flushFrame();
  beginViewSwitchToPath(`/s/my-server/channel/${OTHER_CHANNEL}`);
  beginViewSwitchToPath("/s/my-server/members");

  for (const span of switchSpans()) {
    for (const [key, value] of Object.entries(span.attrs ?? {})) {
      assert.ok(ALLOWED_ATTRS.has(key), `unexpected attribute ${key}`);
      assert.ok(["number", "boolean"].includes(typeof value) || /^[a-z_]+$/.test(String(value)), `${key}=${String(value)}`);
    }
    const serialized = JSON.stringify(span.attrs);
    for (const id of IDS) assert.ok(!serialized.includes(id), `attributes carry ${id}`);
  }
  for (const span of httpSink.getAllSpans()) {
    const serialized = JSON.stringify(span.attrs);
    for (const id of IDS) assert.ok(!serialized.includes(id), `web.http.client carries ${id}`);
    assert.ok(!serialized.includes("limit=50"), "no query string");
  }
});

test("web.http.client carries the route template, the response size and the Resource Timing segments", () => {
  stubPerformance([{
    name: `https://api.example.test/api/servers/my-server/channels/${CHANNEL}/threads/${PARENT_MESSAGE}`,
    startTime: 50_000,
    fetchStart: 50_002,
    domainLookupStart: 50_005,
    requestStart: 50_025,
    responseStart: 50_085,
    responseEnd: 50_095,
    encodedBodySize: 321,
  }], 50_000);
  request(`/servers/my-server/channels/${CHANNEL}/threads/${PARENT_MESSAGE}`, { contentLength: 999 })();
  request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 64 })();

  const [timed, sized] = httpSink.getAllSpans();
  assert.equal(timed?.attrs?.["http.route"], "/api/servers/:id/channels/:id/threads/:id");
  assert.equal(timed?.attrs?.response_bytes, 321, "the entry's body size first");
  assert.equal(timed?.attrs?.queue_ms, 5);
  assert.equal(timed?.attrs?.connect_ms, 20);
  assert.equal(timed?.attrs?.ttfb_ms, 60);
  assert.equal(timed?.attrs?.download_ms, 10);
  assert.equal(sized?.attrs?.["http.route"], "/api/messages/channel/:id");
  assert.equal(sized?.attrs?.response_bytes, 64, "Content-Length without an entry");
  assert.equal(sized?.attrs?.ttfb_ms, undefined);

  assert.equal(apiRouteTemplate("https://api.example.test/api/channels/general/members?x=1#y"), "/api/channels/:id/members");
  assert.equal(apiRouteTemplate("https://elsewhere.example.test/upload/abc"), ":other");
  assert.equal(apiRouteTemplate(undefined), ":other");
});

test("Resource Timing comes from a PerformanceObserver's bounded map before getEntriesByName", () => {
  const url = `https://api.example.test/api/messages/channel/${CHANNEL}`;
  let callback: ((list: { getEntries: () => PerformanceEntryList }) => void) | null = null;
  const pending: PerformanceEntry[] = [];
  class FakeObserver {
    constructor(cb: typeof callback) { callback = cb; }
    observe(options: { type?: string; buffered?: boolean }) { assert.deepEqual(options, { type: "resource", buffered: true }); }
    takeRecords() { return pending.splice(0); }
    disconnect() {}
  }
  Object.defineProperty(globalThis, "PerformanceObserver", { configurable: true, value: FakeObserver });
  // The browser's buffer is full: getEntriesByName has nothing.
  stubPerformance([], 50_000);
  const entry = (name: string, ttfb: number) => ({
    name, entryType: "resource", startTime: 50_000, fetchStart: 50_000, domainLookupStart: 50_000,
    requestStart: 50_010, responseStart: 50_010 + ttfb, responseEnd: 50_020 + ttfb, encodedBodySize: 11,
  }) as unknown as PerformanceEntry;

  // Delivered to the callback (other URLs push nothing out under the cap)...
  request(`/messages/channel/${CHANNEL}?limit=50`);
  callback!({ getEntries: () => [entry(`${url}?limit=50`, 40), ...Array.from({ length: 50 }, (_, i) => entry(`${url}/x${i}`, 1))] });
  // ...or still undelivered at the answer: taken from takeRecords().
  const answer = request(`/messages/channel/${CHANNEL}?limit=20`);
  pending.push(entry(`${url}?limit=20`, 70));
  answer();
  request(`/messages/channel/${CHANNEL}?limit=50`)();

  const [observed, first] = httpSink.getAllSpans();
  assert.equal(observed?.attrs?.ttfb_ms, 70);
  assert.equal(first?.attrs?.ttfb_ms, 40);
  assert.equal(first?.attrs?.response_bytes, 11);

  // The map stays bounded.
  callback!({ getEntries: () => Array.from({ length: 500 }, (_, i) => entry(`${url}/y${i}`, 1)) });
  request(`/messages/channel/${CHANNEL}?limit=50`)();
  assert.equal(httpSink.getAllSpans()[2]?.attrs?.ttfb_ms, undefined, "evicted, and not in the full buffer");
});

test("nothing throws without the performance APIs (SSR, jsdom)", () => {
  Object.defineProperty(globalThis, "performance", { configurable: true, value: undefined });
  assert.doesNotThrow(() => {
    beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}`, input(12));
    request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 8 })();
    reportViewList(conversationView(CHANNEL), "data");
    flushFrame();
  });
  const span = only();
  assert.equal(span.startTimeMs, 1_000_000, "no performance clock: the start is now");
  assert.equal(span.attrs?.bytes, 8);
  assert.equal(span.attrs?.ttfb_ms, undefined);
  assert.equal(httpSink.getAllSpans()[0]?.attrs?.["http.route"], "/api/messages/channel/:id");

  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => { throw new Error("broken"); }, getEntriesByName: () => { throw new Error("broken"); } },
  });
  assert.doesNotThrow(() => {
    beginViewSwitchToPath(`/s/my-server/channel/${OTHER_CHANNEL}`, input(12));
    request(`/messages/channel/${OTHER_CHANNEL}`)();
  });
});

test("the list hooks' states: skeletons, 'Loading replies…' and live rows only are pending", () => {
  const shown = { unavailable: false, held: false, loading: false, hasMessages: true, forumMode: false };
  assert.equal(chatPanelListState(shown, true), "data");
  assert.equal(chatPanelListState({ ...shown, hasMessages: false }, true), "data", "a loaded empty channel");
  assert.equal(chatPanelListState(shown, false), "pending", "only live rows, no page fetched yet");
  assert.equal(chatPanelListState({ ...shown, loading: true, hasMessages: false }, false), "pending");
  assert.equal(chatPanelListState({ ...shown, held: true }, true), "pending", "held for a landed link");
  assert.equal(chatPanelListState({ ...shown, unavailable: true }, true), "error");

  const replies = { threadChannelId: "t1", repliesFor: "t1", loading: false, failed: false, resolving: false, resolveFailed: false };
  assert.equal(threadRepliesState(replies), "data");
  assert.equal(threadRepliesState({ ...replies, loading: true }), "pending", "Loading replies…");
  assert.equal(threadRepliesState({ ...replies, repliesFor: "t0" }), "pending", "the previous thread's replies");
  assert.equal(threadRepliesState({ ...replies, threadChannelId: null, resolving: true }), "pending");
  assert.equal(threadRepliesState({ ...replies, threadChannelId: null }), "data", "no replies yet");
  assert.equal(threadRepliesState({ ...replies, failed: true }), "error");
});

test("message_requests counts the switch's message pages and windows, so a page read twice shows", () => {
  beginViewSwitchToPath(`/s/my-server/channel/${CHANNEL}?msg=${MESSAGE}`);
  const page = request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 100 });
  const again = request(`/messages/channel/${CHANNEL}?limit=50`, { contentLength: 100 });
  const window = request(`/messages/context/${MESSAGE}`, { contentLength: 100 });
  const outline = request(`/messages/channel/${CHANNEL}/human-outline?limit=200`, { contentLength: 100 });
  const info = request(`/channels/${CHANNEL}`, { contentLength: 100 });
  for (const answer of [page, again, window, outline, info]) answer();
  reportViewList(conversationView(CHANNEL), "data");
  flushFrame();

  const span = only();
  assert.equal(span.attrs?.requests, 5);
  assert.equal(span.attrs?.message_requests, 3, "two pages and a window; not the outline or the channel row");
});
