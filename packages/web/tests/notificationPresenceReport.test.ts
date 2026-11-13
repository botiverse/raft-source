// presence:activity (contract §1.3, §5): active = "computer active" (input
// under 3 minutes old and the screen not locked, whatever has focus), sent
// with `locked` and a separate `attended` (the window / tab in front). Sent on
// a change of active / locked (including the moment the last input turns 3
// minutes old), as a heartbeat every 60 s while connected, and on every
// (re)connect of the current or a replacing socket; never queued, and input
// while already active never emits per event.
import assert from "node:assert/strict";
import { ACTIVE_INPUT_WINDOW_MS, PRESENCE_ACTIVITY_EVENT, PRESENCE_HEARTBEAT_MS, PRESENCE_INPUT_REPORT_STEP_MS } from "@botiverse/raft-shared";
import type { DesktopWindowActivity } from "@botiverse/raft-shared";
import {
  createPresenceReporter,
  desktopScreenLocked,
  pushEndpointHashOf,
  startDesktopPresenceReport,
  startWebPresenceReport,
  WEB_PRESENCE_INPUT_EVENTS,
} from "../src/notifications/presenceReport";
import type { WebPresenceEnvironment } from "../src/notifications/presenceReport";
import type { NotificationSocket, SocketSource } from "../src/notifications/desktopNative/followSocket";
import { markDesktopAlertConsumerRunning } from "../src/notifications/desktopNative/alertAckCapability";

const MINUTE = 60_000;

class FakeSocket implements NotificationSocket {
  connected: boolean;
  emits: Array<[string, unknown]> = [];
  private handlers = new Map<string, Set<(...args: never[]) => void>>();
  constructor(connected: boolean) { this.connected = connected; }
  emit(event: string, payload: unknown) { this.emits.push([event, payload]); }
  on(event: string, handler: (...args: never[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }
  off(event: string, handler: (...args: never[]) => void) { this.handlers.get(event)?.delete(handler); }
  fire(event: "connect" | "disconnect") {
    this.connected = event === "connect";
    for (const h of [...(this.handlers.get(event) ?? [])]) (h as () => void)();
  }
  removeAllListeners() { this.handlers.clear(); }
  listenerCount(event: string) { return this.handlers.get(event)?.size ?? 0; }
  reports() { return this.emits.filter(([e]) => e === PRESENCE_ACTIVITY_EVENT).map(([, p]) => p); }
}

function harness(connected = true) {
  let clock = 50_000_000;
  const timeouts = new Map<number, { handler: () => void; at: number }>();
  let nextId = 1;
  const timers = {
    setTimeout: (handler: () => void, ms: number) => { const id = nextId++; timeouts.set(id, { handler, at: clock + Math.max(0, ms) }); return id; },
    clearTimeout: (id: unknown) => { timeouts.delete(id as number); },
  };
  const now = () => clock;
  /** Move the clock, firing due timers in order. */
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timeouts.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timeouts.delete(due[0]);
      clock = due[1].at;
      due[1].handler();
    }
    clock = end;
  };
  let socket = new FakeSocket(connected);
  const replaced = new Set<(s: FakeSocket) => void>();
  const sockets: SocketSource<NotificationSocket> = {
    current: () => socket,
    onReplaced: (listener) => { replaced.add(listener as (s: FakeSocket) => void); return () => { replaced.delete(listener as (s: FakeSocket) => void); }; },
  };
  /** api/socket.ts resetSocket(): the old instance drops every listener, a new one replaces it. */
  const replace = (next: FakeSocket) => {
    socket.removeAllListeners();
    socket = next;
    for (const l of [...replaced]) l(next);
  };
  return { timers, now, advance, timeouts, sockets, socket: () => socket, replace, replacedListeners: replaced };
}

type Report = { active: boolean; idleSeconds: number | null; locked: boolean; attended: boolean };
const report = (active: boolean, idleSeconds: number | null, extra: { locked?: boolean; attended?: boolean } = {}): Report =>
  ({ active, idleSeconds, locked: extra.locked ?? false, attended: extra.attended ?? true });
/** The two signals only (attended is checked where it matters). */
const signal = (value: unknown) => {
  const { active, idleSeconds, locked } = value as Report;
  return { active, idleSeconds, locked };
};
const signals = (values: unknown[]) => values.map(signal);
/** A web tab names its own push subscription (none here). */
const webReport = (...args: Parameters<typeof report>) => ({ ...report(...args), pushSubscribed: false, pushEndpointHash: null });
/** Raft Desktop says it acks alerts. */
const deskReport = (...args: Parameters<typeof report>) => ({ ...report(...args), ackAlerts: true });
const at = (active: boolean, idleSeconds: number | null, locked = false) => ({ active, idleSeconds, locked });
const state = (lastInputAt: number | null, extra: { attended?: boolean; locked?: boolean } = {}) =>
  ({ attended: extra.attended ?? true, locked: extra.locked ?? false, lastInputAt });

test("constants: 3-minute window, 60 s heartbeat", () => {
  assert.equal(ACTIVE_INPUT_WINDOW_MS, 3 * MINUTE);
  assert.equal(PRESENCE_HEARTBEAT_MS, MINUTE);
});

test("connected at start: the unknown state goes out once, then a change at once, with locked and attended", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  assert.deepEqual(h.socket().reports(), [report(false, null, { attended: false })], "online, nothing known yet");
  r.update(state(h.now() - 2_000));
  assert.deepEqual(h.socket().reports().at(-1), report(true, 2));
  r.update(state(h.now() - 2_000));
  assert.equal(h.socket().reports().length, 2, "same state: nothing");
  r.dispose();
});

test("focus is not activity: Raft in the background on a computer in use stays active", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now(), { attended: true }));
  const n = h.socket().reports().length;
  r.update(state(h.now(), { attended: false }));
  assert.equal(h.socket().reports().length, n, "blur alone changes neither signal: nothing sent");
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(h.socket().reports().at(-1), report(true, 60, { attended: false }), "the heartbeat carries attended: false, still active");
  r.dispose();
});

test("a lock is sent at once and is never active, however recent the input; unlock is active again at once", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now()));
  r.update(state(h.now(), { locked: true, attended: false }));
  assert.deepEqual(h.socket().reports().at(-1), report(false, 0, { locked: true, attended: false }));
  h.advance(30_000);
  r.update(state(h.now() - 30_000, { locked: true, attended: false }));
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 0, true), "no new report while nothing changed");
  r.update(state(h.now()));
  assert.deepEqual(h.socket().reports().at(-1), report(true, 0));
  r.dispose();
});

test("input while active is not sent per event: once it moved on by 30 s, then the heartbeat", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now()));
  const start = h.socket().reports().length;
  for (let i = 0; i < 29; i++) {
    h.advance(1_000);
    r.update(state(h.now()));
  }
  assert.equal(h.socket().reports().length, start, "29 s of typing: no extra report");
  h.advance(1_000);
  r.update(state(h.now()));
  assert.equal(PRESENCE_INPUT_REPORT_STEP_MS, 30_000);
  assert.equal(h.socket().reports().length, start + 1, "the input moved on 30 s: the server hears it (S1's same-computer test stays honest)");
  assert.deepEqual(h.socket().reports().at(-1), report(true, 0));
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.equal(h.socket().reports().length, start + 2, "then the heartbeat");
  r.dispose();
});

test("a heartbeat a throttled background timer held back goes on the next update", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: { setTimeout: () => 0, clearTimeout: () => {} }, now: h.now });
  const lastInputAt = h.now();
  r.update(state(lastInputAt));
  const n = h.socket().reports().length;
  h.advance(PRESENCE_HEARTBEAT_MS - 1);
  r.update(state(lastInputAt));
  assert.equal(h.socket().reports().length, n, "not yet due");
  h.advance(1);
  r.update(state(lastInputAt));
  assert.equal(h.socket().reports().length, n + 1, "due: sent although the timer never fired");
  r.dispose();
});

test("pushEndpointHashOf matches the server's rule (shared vector)", async () => {
  assert.equal(await pushEndpointHashOf("https://fcm.googleapis.com/fcm/send/vector"), "SqlB9EmZz4HGASE_");
});

test("web: the tab reports its own push subscription, and a change of it at once", async () => {
  const h = harness();
  const w = fakeWebEnv({ visible: true, focused: true });
  let endpoint: string | null = null;
  const stop = startWebPresenceReport({ sockets: h.sockets, timers: h.timers, now: h.now, env: w.env, pushEndpoint: async () => endpoint });
  await vi.waitFor(() => assert.equal((h.socket().reports().at(-1) as { pushSubscribed: boolean }).pushSubscribed, false));
  endpoint = "https://fcm.googleapis.com/fcm/send/vector";
  w.fire("focus");
  await vi.waitFor(() => assert.deepEqual(h.socket().reports().at(-1), { ...report(true, 0), pushSubscribed: true, pushEndpointHash: "SqlB9EmZz4HGASE_" }));
  endpoint = null; // permission revoked
  h.advance(PRESENCE_HEARTBEAT_MS); // the periodic re-read
  await vi.waitFor(() => assert.equal((h.socket().reports().at(-1) as { pushEndpointHash: string | null }).pushEndpointHash, null));
  stop();
});

test("crossing the 3-minute line is reported at once, then heartbeats continue as not active with the growing idle time", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  const lastInputAt = h.now();
  r.update(state(lastInputAt));
  h.advance(ACTIVE_INPUT_WINDOW_MS - 1);
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(true, 120), "heartbeats at 60 s and 120 s");
  h.advance(1);
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 180), "told the moment it turns 3 minutes old");
  const n = h.socket().reports().length;
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.equal(h.socket().reports().length, n + 1, "still heartbeating while connected (online TTL)");
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 240), "the server measures longer delays (5m / 10m) from it");
  r.update(state(h.now()));
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(true, 0), "input again: active at once");
  r.dispose();
});

test("newer input moves the crossing: no early 'not active'", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now()));
  h.advance(2 * MINUTE);
  r.update(state(h.now()));
  h.advance(2 * MINUTE);
  assert.ok(h.socket().reports().every((p) => (p as Report).active || (p as Report).idleSeconds === null));
  h.advance(MINUTE);
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 180));
  r.dispose();
});

test("offline nothing is queued; reconnect re-reports and restarts the heartbeat", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now()));
  r.update(state(h.now(), { locked: true }));
  assert.deepEqual(signals(h.socket().reports().slice(-2)), [at(true, 0), at(false, 0, true)]);
  const n = h.socket().reports().length;
  h.socket().fire("disconnect");
  r.update(state(h.now()));
  h.advance(5 * MINUTE);
  assert.equal(h.socket().reports().length, n, "nothing sent or queued while offline");
  r.update(state(h.now() - 4_000));
  h.socket().fire("connect");
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(true, 4));
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.equal(h.socket().reports().length, n + 2, "heartbeat resumed");
  r.dispose();
});

test("regression: a replaced socket gets the reports (connect on the new instance), the old one none", () => {
  const h = harness();
  const r = createPresenceReporter({ sockets: h.sockets, timers: h.timers, now: h.now });
  r.update(state(h.now()));
  const old = h.socket();
  const fresh = new FakeSocket(false);
  h.replace(fresh);
  h.advance(PRESENCE_HEARTBEAT_MS * 2);
  const oldCount = old.reports().length;
  assert.equal(fresh.reports().length, 0, "not connected yet: nothing");
  fresh.fire("connect");
  assert.deepEqual(fresh.reports(), [report(true, 120)]);
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.equal(fresh.reports().length, 2, "heartbeat on the new socket");
  assert.equal(old.reports().length, oldCount, "the replaced socket hears nothing more");
  // An already connected replacement is reported to at once.
  const live = new FakeSocket(true);
  h.replace(live);
  assert.equal(live.reports().length, 1);
  r.dispose();
  assert.equal(live.listenerCount("connect"), 0);
  assert.equal(h.replacedListeners.size, 0);
  assert.equal(h.timeouts.size, 0, "no timers left");
  r.update(state(h.now()));
  assert.equal(live.reports().length, 1, "disposed: quiet");
});

// ---------------------------------------------------------------------------
// Web flavour
// ---------------------------------------------------------------------------

function fakeWebEnv(initial: { visible: boolean; focused: boolean }) {
  const listeners = new Map<string, Set<() => void>>();
  const add = (event: string, handler: EventListenerOrEventListenerObject) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(handler as () => void);
  };
  const remove = (event: string, handler: EventListenerOrEventListenerObject) => { listeners.get(event)?.delete(handler as () => void); };
  const state = { ...initial };
  const env = {
    document: {
      get visibilityState() { return state.visible ? "visible" : "hidden"; },
      hasFocus: () => state.focused,
      addEventListener: add,
      removeEventListener: remove,
    },
    window: { addEventListener: add, removeEventListener: remove },
  } as unknown as WebPresenceEnvironment;
  const fire = (event: string) => { for (const h of [...(listeners.get(event) ?? [])]) h(); };
  const total = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { env, state, fire, total };
}

test("web: input in the tab is computer activity; blur or hiding the tab only changes attended", () => {
  const h = harness();
  const w = fakeWebEnv({ visible: true, focused: true });
  const stop = startWebPresenceReport({ sockets: h.sockets, timers: h.timers, now: h.now, env: w.env });
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 0), "opening the tab counts as input");
  const opened = h.socket().reports().length;
  w.state.focused = false;
  w.fire("blur");
  w.state.visible = false;
  w.fire("visibilitychange");
  assert.equal(h.socket().reports().length, opened, "switched to another app a moment ago: still at the computer");
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 60, { attended: false }));
  // The approximation: a browser cannot see input in other apps.
  h.advance(2 * MINUTE);
  assert.deepEqual(h.socket().reports().at(-1), webReport(false, 180, { attended: false }), "away 3 minutes after the last input in the tab");
  w.state.visible = true;
  w.state.focused = true;
  w.fire("focus");
  w.fire("pointerdown");
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 0));
  stop();
  assert.equal(w.total(), 0, "every listener removed");
});

test("web: a background tab is not active until input; input while active does not emit; never locked", () => {
  const h = harness();
  const w = fakeWebEnv({ visible: true, focused: false });
  const stop = startWebPresenceReport({ sockets: h.sockets, timers: h.timers, now: h.now, env: w.env });
  assert.deepEqual(h.socket().reports(), [report(false, null, { attended: false })], "the connect report goes before the tab's first state");
  w.state.focused = true;
  w.fire("focus");
  assert.equal(h.socket().reports().length, 1, "focused but no input yet: nothing to report");
  w.fire("keydown");
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 0));
  const n = h.socket().reports().length;
  for (let i = 0; i < 200; i++) {
    h.advance(100);
    w.fire(WEB_PRESENCE_INPUT_EVENTS[i % WEB_PRESENCE_INPUT_EVENTS.length]!);
  }
  assert.equal(h.socket().reports().length, n, "20 s of input: no per-event reports");
  h.advance(ACTIVE_INPUT_WINDOW_MS);
  assert.deepEqual(h.socket().reports().at(-1), webReport(false, 180), "3 minutes after the last input");
  assert.ok(h.socket().reports().every((p) => (p as Report).locked === false), "a browser cannot see a lock");
  stop();
});

test("web: only real input counts: auto-scroll and pointer moves keep nobody active", () => {
  assert.deepEqual([...WEB_PRESENCE_INPUT_EVENTS].sort(), ["keydown", "pointerdown", "touchstart", "wheel"]);
  const h = harness();
  const w = fakeWebEnv({ visible: true, focused: true });
  const stop = startWebPresenceReport({ sockets: h.sockets, timers: h.timers, now: h.now, env: w.env });
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 0));
  // Nobody at the computer; the timeline keeps scrolling to new messages.
  for (let i = 0; i < 40; i++) {
    h.advance(5_000);
    w.fire("scroll");
    w.fire("pointermove");
  }
  assert.deepEqual(h.socket().reports().at(-1), webReport(false, 180), "inactive 3 minutes after the last real input, scrolls or not");
  w.fire("wheel");
  assert.deepEqual(h.socket().reports().at(-1), webReport(true, 0), "a wheel turn is a person");
  stop();
});

// ---------------------------------------------------------------------------
// Desktop flavour
// ---------------------------------------------------------------------------

function desktopHarness(consumerRunning = true) {
  const stopConsumer = consumerRunning ? markDesktopAlertConsumerRunning() : () => {};
  const h = harness();
  let listener!: (state: DesktopWindowActivity) => void;
  let unsubscribed = false;
  const stop = startDesktopPresenceReport(
    { getWindowActivity: () => new Promise(() => {}), onWindowActivity: (cb) => { listener = cb; return () => { unsubscribed = true; }; } },
    { sockets: h.sockets, timers: h.timers, now: h.now },
  );
  let revision = 0;
  const push = (state: Omit<DesktopWindowActivity, "revision">) => listener({ revision: ++revision, ...state });
  return { h, push, stop: () => { stop(); stopConsumer(); }, unsubscribed: () => unsubscribed };
}

const FRONT = { visible: true, minimized: false, focused: true, away: false, locked: false };
const BEHIND = { visible: true, minimized: false, focused: false, away: false, locked: false };

test("desktop: system input drives active whatever window has focus; the unknown default is never claimed active", () => {
  const { h, push, stop, unsubscribed } = desktopHarness();
  assert.deepEqual(h.socket().reports(), [report(false, null, { attended: false })], "before the snapshot: not active (and nothing claimed)");
  push({ ...FRONT, lastInputAt: h.now() - 10_000 });
  assert.deepEqual(h.socket().reports().at(-1), deskReport(true, 10));
  // Raft in the background, typing in another app: still active, not attended.
  push({ ...BEHIND, lastInputAt: h.now() - 1_000 });
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(h.socket().reports().at(-1), deskReport(true, 61, { attended: false }));
  // Minimized / hidden: the same.
  push({ ...FRONT, minimized: true, focused: false, lastInputAt: h.now() });
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(true, 60));
  // Nobody there: main keeps publishing the same lastInputAt; the local timer reports the crossing.
  h.advance(ACTIVE_INPUT_WINDOW_MS - PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 180));
  const count = h.socket().reports().length;
  push({ ...FRONT, lastInputAt: null });
  assert.equal(h.socket().reports().length, count, "idle unknown: stays not active");
  h.advance(PRESENCE_HEARTBEAT_MS);
  assert.deepEqual(h.socket().reports().at(-1), deskReport(false, null), "the heartbeat says so");
  stop();
  assert.equal(unsubscribed(), true);
  assert.equal(h.timeouts.size, 0);
});

test("desktop: the shell's lock is reported at once, unfocused or not; unlock at once", () => {
  const { h, push, stop } = desktopHarness();
  push({ ...BEHIND, lastInputAt: h.now() });
  assert.deepEqual(h.socket().reports().at(-1), deskReport(true, 0, { attended: false }));
  h.advance(5_000);
  push({ ...BEHIND, away: true, locked: true, lastInputAt: h.now() - 5_000 });
  assert.deepEqual(h.socket().reports().at(-1), deskReport(false, 5, { locked: true, attended: false }));
  h.advance(10 * MINUTE);
  push({ ...FRONT, lastInputAt: h.now() });
  assert.deepEqual(h.socket().reports().at(-1), deskReport(true, 0));
  stop();
});

test("desktop: an older shell without `locked` reads away as possibly locked", () => {
  assert.equal(desktopScreenLocked({ away: true }), true);
  assert.equal(desktopScreenLocked({ away: false }), false);
  assert.equal(desktopScreenLocked({ away: true, locked: false }), false, "a new shell's idle away is not a lock");
  assert.equal(desktopScreenLocked({ away: false, locked: true }), true);
  const { h, push, stop } = desktopHarness();
  const legacy = { visible: true, minimized: false, focused: false };
  push({ ...legacy, away: false, lastInputAt: h.now() });
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(true, 0));
  push({ ...legacy, away: true, lastInputAt: h.now() });
  assert.deepEqual(signal(h.socket().reports().at(-1)), at(false, 0, true));
  stop();
});

test("N3: the desktop says it acks alerts only while the alert consumer runs, and re-reports when that changes", () => {
  const { h, push, stop } = desktopHarness(false);
  push({ visible: true, minimized: false, focused: false, away: false, locked: false, lastInputAt: h.now() });
  assert.equal("ackAlerts" in (h.socket().reports().at(-1) as object), false, "no consumer: the server must not wait for acks");
  const stopConsumer = markDesktopAlertConsumerRunning();
  assert.equal((h.socket().reports().at(-1) as { ackAlerts?: boolean }).ackAlerts, true, "the consumer started: reported at once");
  stopConsumer();
  assert.equal("ackAlerts" in (h.socket().reports().at(-1) as object), false, "and stopped");
  stop();
});
