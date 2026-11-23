import "./helpers/domSetup";
import assert from "node:assert/strict";

import { vi } from "vitest";

import { useInboxStore } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { createMainLayoutRealtimeBridgeDriver } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";

/**
 * #triage:#244: a frozen page (an iOS installed web app in the background)
 * receives no socket events, so it owes no Activity read; the live-session
 * recovery re-reads Activity once when it comes back, and a quick switch
 * reads nothing.
 */

const socket: MainLayoutSocketBridgeSocket = {
  connected: true, emit: () => undefined, on() { return this; }, off() { return this; },
  onAny() { return this; }, offAny() { return this; }, disconnect: () => undefined, connect: () => undefined,
} as never;

let visibility: DocumentVisibilityState = "visible";
let now = 1_000_000;

function install(socketConnected: () => boolean = () => true) {
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const reads: unknown[] = [];
  const saved = { inbox: { ...useInboxStore.getState() }, message: { ...useMessageStore.getState() } };
  useServerStore.setState({ current: { id: "srv-resume", slug: "r" } } as never);
  useMessageStore.setState({ loadUnreadCounts: async () => undefined, markCurrentChannelRead: () => undefined } as never);
  useInboxStore.setState({ loaded: true, loading: false, loadInbox: async (opts: { reason?: unknown }) => { reads.push(opts.reason); } } as never);
  const uninstall = createMainLayoutRealtimeBridgeDriver({
    getSocket: () => socket as never, reconnectSocket: () => undefined, ensureSocketConnected: () => undefined, isSocketConnected: socketConnected,
  }).install();
  return {
    reads,
    restore() {
      uninstall();
      useInboxStore.setState(saved.inbox as never);
      useMessageStore.setState(saved.message as never);
      vi.restoreAllMocks();
      visibility = "visible";
    },
  };
}

const hide = () => { visibility = "hidden"; document.dispatchEvent(new window.Event("visibilitychange")); };
const show = () => { visibility = "visible"; document.dispatchEvent(new window.Event("visibilitychange")); };

test("frozen, then resumed: Activity is re-read once, reason visibility", () => {
  const t = install();
  try {
    hide();
    document.dispatchEvent(new window.Event("freeze"));
    now += 1_000;
    visibility = "visible";
    document.dispatchEvent(new window.Event("resume"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("focus"));
    assert.deepEqual(t.reads, ["visibility"]);
  } finally { t.restore(); }
});

test("hidden past the platform's floor re-reads; a quick switch does not", () => {
  const t = install();
  try {
    hide();
    now += 1_000;
    show();
    assert.deepEqual(t.reads, [], "a quick switch");
    hide();
    now += 120_000;
    show();
    assert.deepEqual(t.reads, ["visibility"]);
  } finally { t.restore(); }
});

test("gone after the bridge is torn down: a resume reads nothing", () => {
  const t = install();
  t.restore();
  hide();
  document.dispatchEvent(new window.Event("freeze"));
  visibility = "visible";
  document.dispatchEvent(new window.Event("resume"));
  assert.deepEqual(t.reads, []);
  visibility = "visible";
});

/** Raft Desktop's system resume (installSystemResumeRecovery), with a stored session so the recovery runs. */
function installDesktopWake() {
  const bridge = { handler: null as ((event: { reason: "resume" | "unlock-screen" }) => void) | null };
  (window as { raftDesktop?: unknown }).raftDesktop = {
    onSystemResume: (handler: typeof bridge.handler) => {
      bridge.handler = handler;
      return () => { bridge.handler = null; };
    },
  };
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  localStorage.setItem("slock_access_token", "a");
  localStorage.setItem("slock_refresh_token", "r");
  return {
    wake() {
      bridge.handler?.({ reason: "resume" });
      vi.advanceTimersByTime(1_000); // SYSTEM_RESUME_COALESCE_MS
    },
    restore() {
      delete (window as { raftDesktop?: unknown }).raftDesktop;
      delete (navigator as { onLine?: unknown }).onLine;
      localStorage.removeItem("slock_access_token");
      localStorage.removeItem("slock_refresh_token");
    },
  };
}

test("a Raft Desktop wake with the page visible re-reads Activity once; the focus that follows reads nothing more", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const desktop = installDesktopWake();
  const t = install();
  try {
    desktop.wake();
    assert.deepEqual(t.reads, ["visibility"]);
    window.dispatchEvent(new window.Event("focus"));
    assert.deepEqual(t.reads, ["visibility"]);
  } finally { t.restore(); desktop.restore(); vi.useRealTimers(); }
});

test("a Raft Desktop wake while hidden re-reads Activity once at the next show, not at the wake", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const desktop = installDesktopWake();
  const t = install();
  try {
    hide();
    desktop.wake();
    assert.deepEqual(t.reads, []);
    now += 1_000;
    show();
    window.dispatchEvent(new window.Event("focus"));
    assert.deepEqual(t.reads, ["visibility"]);
  } finally { t.restore(); desktop.restore(); vi.useRealTimers(); }
});

test("a Raft Desktop wake with the socket dropped leaves Activity to the reconnect's read (rooms:joined), not a second wake read", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const desktop = installDesktopWake();
  let connected = false;
  const t = install(() => connected);
  try {
    desktop.wake();
    assert.deepEqual(t.reads, [], "no wake re-read while the socket is down");
    connected = true;
    desktop.wake();
    assert.deepEqual(t.reads, ["visibility"], "connected at the wake: one re-read");
  } finally { t.restore(); desktop.restore(); vi.useRealTimers(); }
});
