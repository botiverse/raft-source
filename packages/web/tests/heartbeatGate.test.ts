import assert from "node:assert/strict";
import "./helpers/domSetup";

// The socket heartbeat's gap sync (store/heartbeatGate.ts) and every other
// GET /messages/sync (messageStore syncGap): a hidden page reads nothing on a
// heartbeat, a reconnect's rooms:joined, a sync:resume re-read or a live seq
// gap, and fills the gap once when it shows again; visible reads are as
// before, and a read asked for while another is in flight is not dropped.

function makeMainLayoutSocket() {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    connected: true,
    emit: () => undefined,
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? new Set<Handler>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
  return {
    socket,
    fire(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

const channelId = "heartbeat-scope";

function message(seq: number, id = `m-${seq}`) {
  return {
    id,
    seq,
    channelId,
    senderType: "user" as const,
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat" as const,
    content: `message ${seq}`,
    createdAt: "2026-11-04T07:00:00.000Z",
    reactions: [],
    actionMetadata: null,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type SyncCall = { sinceSeq: number; channelId: string | null };

async function setup(transport: { connected?: boolean; ensureSocketConnected?: () => void } = {}) {
  const { installMainLayoutSocketBridge } = await import("../src/store/socketBridge");
  const { useMessageStore } = await import("../src/store/messageStore");
  (await import("../src/store/liveGapFill")).resetGapFillForTests();
  const api = (await import("../src/api/client")).default;
  window.history.pushState({}, "", `/s/team/channel/${channelId}`);
  useMessageStore.setState({
    channelMessages: { [channelId]: [message(5)] },
    messages: [message(5)],
    currentChannelId: channelId,
    lastSeq: 5,
    loadingGap: false,
    currentUserId: null,
  });
  const calls: SyncCall[] = [];
  // What the next /messages/sync answers; `hold` keeps the next read open until released.
  const next = { rows: [] as unknown[], hold: null as Promise<void> | null, fail: false };
  vi.spyOn(api, "get").mockImplementation((async (url: string) => {
    if (url.startsWith("/messages/sync")) {
      const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      calls.push({ sinceSeq: Number(params.get("since_seq")), channelId: params.get("channel_id") });
      const rows = next.rows;
      next.rows = [];
      const hold = next.hold;
      next.hold = null;
      if (hold) await hold;
      if (next.fail) {
        next.fail = false;
        throw new Error("offline");
      }
      return { data: rows };
    }
    return { data: [] };
  }) as never);
  const { socket, fire } = makeMainLayoutSocket();
  const cleanup = installMainLayoutSocketBridge({
    getSocket: () => socket,
    reconnectSocket: () => undefined,
    ensureSocketConnected: transport.ensureSocketConnected ?? (() => undefined),
    isSocketConnected: () => transport.connected ?? true,
  });
  return { fire, calls, next, cleanup, useMessageStore };
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });
});
afterEach(async () => {
  (await import("../src/store/liveGapFill")).resetGapFillForTests();
  vi.restoreAllMocks();
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (document as { hidden?: unknown }).hidden;
});

test("a visible page syncs the scope on each heartbeat above lastSeq, as before", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.sinceSeq, 5);
    fire("heartbeat", { seq: 5, ts: 0 });
    await settle();
    assert.equal(calls.length, 2, "a seq at lastSeq reads nothing");
  } finally {
    cleanup();
  }
});

test("heartbeats while the page is hidden do not sync; becoming visible fills the gap once", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    for (let beat = 0; beat < 4; beat += 1) {
      fire("heartbeat", { seq: 9 + beat, ts: 0 });
      await settle();
    }
    assert.equal(calls.length, 0, "no sync while hidden");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(calls.length, 1, "one gap fill on becoming visible (focus with it does not add one)");
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1, "no fill owed without a hidden heartbeat");
  } finally {
    cleanup();
  }
});

test("a message in another channel raising lastSeq while hidden does not cancel the owed fill", async () => {
  const { fire, calls, cleanup, useMessageStore } = await setup();
  try {
    visibility = "hidden";
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    // Seq 10 lands in another channel over the live socket: lastSeq passes the
    // hidden beat's seq, but says nothing about this channel's missing 6..9.
    fire("message:new", { ...message(10, "elsewhere-10"), channelId: "another-channel" });
    await settle();
    assert.equal(useMessageStore.getState().lastSeq, 10, "the other channel's message raised lastSeq");
    assert.equal(calls.length, 0, "nothing read while hidden");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1, "the owed fill still runs");
    assert.equal(calls[0]!.sinceSeq, 5, "from what this channel holds");
  } finally {
    cleanup();
  }
});

test("a hidden sync:resume that needs a re-read reads nothing; showing reads once, also with a heartbeat owed", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    fire("heartbeat", { seq: 9, ts: 0 });
    fire("sync:resume:response", { messages: [], currentSeq: 5, hasMore: true });
    fire("sync:resume:response", { messages: [], currentSeq: 5, horizonReset: true, hasMore: false });
    await settle();
    assert.equal(calls.length, 0, "no /messages/sync while hidden");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1, "one catch-up on show");
    assert.equal(calls[0]!.sinceSeq, 5);
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1, "nothing owed after it");
  } finally {
    cleanup();
  }
});

test("a visible sync:resume reads at once, and one asked for during a heartbeat read runs after it", async () => {
  const { fire, calls, next, cleanup } = await setup();
  try {
    let release!: () => void;
    next.hold = new Promise<void>((resolve) => { release = resolve; });
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    assert.equal(calls.length, 1, "the heartbeat read is in flight");
    fire("sync:resume:response", { messages: [], currentSeq: 5, hasMore: true });
    await settle();
    assert.equal(calls.length, 1, "one read at a time");
    release();
    await settle();
    assert.equal(calls.length, 2, "the resume's read runs after the heartbeat read instead of being dropped");
  } finally {
    cleanup();
  }
});

/** rooms:joined dispatches `new Event(...)` on window: Node's global Event, which jsdom's window refuses. */
function withWindowEvent(run: () => void) {
  const NodeEvent = globalThis.Event;
  globalThis.Event = window.Event;
  try {
    run();
  } finally {
    globalThis.Event = NodeEvent;
  }
}

test("a reconnect's rooms:joined syncs the visible scope at once while visible, as before", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    withWindowEvent(() => fire("rooms:joined"));
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sinceSeq, 5);
  } finally {
    cleanup();
  }
});

test("hidden reconnects' rooms:joined sync nothing; showing syncs the scope once", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    for (let round = 0; round < 3; round += 1) {
      withWindowEvent(() => fire("rooms:joined"));
      await settle();
    }
    assert.equal(calls.length, 0, "no /messages/sync while hidden");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(calls.length, 1, "one catch-up on show");
    assert.equal(calls[0]!.sinceSeq, 5);
  } finally {
    cleanup();
  }
});

test("a live message with a seq gap: synced at once while visible; while hidden, once on show", async () => {
  const { fire, calls, cleanup, useMessageStore } = await setup();
  try {
    fire("message:new", message(8));
    await settle();
    assert.equal(calls.length, 1, "visible: the gap is read at once");
    assert.equal(calls[0]!.sinceSeq, 5);

    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    fire("message:new", message(12));
    await settle();
    fire("message:new", message(14));
    await settle();
    assert.equal(calls.length, 1, "hidden: nothing read");
    assert.equal(useMessageStore.getState().hasGap, true, "the gap is still known");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 2, "one gap read on show");
  } finally {
    cleanup();
  }
});

test("hidden reconnect and a later hidden heartbeat: showing reads each visible scope once", async () => {
  const { useThreadStore } = await import("../src/store/threadStore");
  const { fire, calls, cleanup, useMessageStore } = await setup();
  const threadId = "heartbeat-thread";
  useMessageStore.setState((state) => ({
    channelMessages: { ...state.channelMessages, [threadId]: [{ ...message(3, "t-3"), channelId: threadId }] },
  }));
  useThreadStore.setState({ openThreadChannelId: threadId } as never);
  try {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    withWindowEvent(() => fire("rooms:joined"));
    await settle();
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    assert.equal(calls.length, 0, "nothing while hidden");
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.deepEqual(
      calls.map((call) => `${call.channelId}@${call.sinceSeq}`).sort(),
      [`${channelId}@5`, `${threadId}@3`],
      "one read per scope",
    );
  } finally {
    useThreadStore.setState({ openThreadChannelId: null } as never);
    cleanup();
  }
});

test("a page back on screen without a visibilitychange (PWA) pays the owed reads on its focus", async () => {
  const { fire, calls, cleanup } = await setup();
  try {
    visibility = "hidden";
    withWindowEvent(() => fire("rooms:joined"));
    await settle();
    assert.equal(calls.length, 0);
    visibility = "visible";
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(calls.length, 1, "the focus pays it");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    assert.equal(calls.length, 1, "and a late visibilitychange adds none");
  } finally {
    cleanup();
  }
});

test("teardown (logout unmounts the layout) drops what a hidden page owed: no stray read on show", async () => {
  const { fire, calls, cleanup } = await setup();
  visibility = "hidden";
  withWindowEvent(() => fire("rooms:joined"));
  fire("heartbeat", { seq: 9, ts: 0 });
  await settle();
  cleanup();
  visibility = "visible";
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle();
  assert.equal(calls.length, 0);
});

test("a live-session recovery that reloads is traced with its trigger and the tab's visibility; a skipped one is not", async () => {
  const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");
  const traces: Array<Record<string, unknown>> = [];
  __setStateTransitionEmitterForTest(((_name: string, attrs: Record<string, unknown>) => { traces.push(attrs); }) as never);
  // A recovery reloads only online and with a stored session.
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  localStorage.setItem("slock_access_token", "a");
  localStorage.setItem("slock_refresh_token", "r");
  const { cleanup } = await setup();
  try {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("focus"));
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    const recoveries = traces
      .filter((t) => (t.key as { domain: string }).domain === "live_session")
      .map((t) => [(t.key as { event: string }).event, (t.key as { entityId: string }).entityId, (t.meta as { outcomeDetail: string }).outcomeDetail, t["tab.visibility"]]);
    assert.deepEqual(recoveries, [["recover", "visibilitychange", "reload", "visible"]]);
  } finally {
    delete (navigator as { onLine?: unknown }).onLine;
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
    __setStateTransitionEmitterForTest(null);
    cleanup();
  }
});

/** A recovery (focus / visibility / online) reloads only online and with a stored session. */
function withRecoverableSession() {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  localStorage.setItem("slock_access_token", "a");
  localStorage.setItem("slock_refresh_token", "r");
  return () => {
    delete (navigator as { onLine?: unknown }).onLine;
    localStorage.removeItem("slock_access_token");
    localStorage.removeItem("slock_refresh_token");
  };
}

test("a visible scope with a live row whose hole is unconfirmed is re-read on a heartbeat at lastSeq", async () => {
  const { fire, calls, next, cleanup, useMessageStore } = await setup();
  try {
    next.fail = true;
    fire("message:new", message(8));
    await settle();
    assert.equal(calls.length, 1, "the gap fill ran");
    assert.ok(useMessageStore.getState().messages.some((row) => row.id === "m-8"), "the live row is shown");
    assert.equal(useMessageStore.getState().hasGap, true, "the failed fill left the hole unconfirmed");
    assert.equal(useMessageStore.getState().lastSeq, 8);

    fire("heartbeat", { seq: 8, ts: 0 });
    await settle();
    assert.equal(calls.length, 2, "the heartbeat re-reads the scope although its seq is not above lastSeq");
    assert.equal(calls[1]!.sinceSeq, 5, "from the hole, not from the live row");
    assert.equal(useMessageStore.getState().hasGap, false);

    fire("heartbeat", { seq: 8, ts: 0 });
    await settle();
    assert.equal(calls.length, 2, "nothing owed: a heartbeat at lastSeq reads nothing again");
  } finally {
    cleanup();
  }
});

test("focus, visibility and online re-read the visible scopes once per burst, including the open thread", async () => {
  const { useThreadStore } = await import("../src/store/threadStore");
  const restoreSession = withRecoverableSession();
  const { calls, cleanup, useMessageStore } = await setup();
  const threadId = "heartbeat-thread";
  useMessageStore.setState((state) => ({
    channelMessages: { ...state.channelMessages, [threadId]: [{ ...message(3, "t-3"), channelId: threadId }] },
  }));
  useThreadStore.setState({ openThreadChannelId: threadId } as never);
  try {
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.deepEqual(
      calls.map((call) => `${call.channelId}@${call.sinceSeq}`).sort(),
      [`${channelId}@5`, `${threadId}@3`],
      "a focus re-reads every visible scope, not just the unread counts",
    );
    for (let i = 0; i < 5; i += 1) window.dispatchEvent(new window.Event("focus"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("online"));
    await settle();
    assert.equal(calls.length, 2, "a burst of focus / visibility / online events reads once");
  } finally {
    useThreadStore.setState({ openThreadChannelId: null } as never);
    restoreSession();
    cleanup();
  }
});

async function afterResumeCoalesce() {
  const { SYSTEM_RESUME_COALESCE_MS } = await import("../src/store/heartbeatGate");
  await new Promise((resolve) => setTimeout(resolve, SYSTEM_RESUME_COALESCE_MS + 20));
  await settle();
}

function installDesktopResume() {
  const bridge = { handler: null as ((event: { reason: "resume" | "unlock-screen" }) => void) | null };
  (window as { raftDesktop?: unknown }).raftDesktop = {
    onSystemResume: (handler: typeof bridge.handler) => {
      bridge.handler = handler;
      return () => { bridge.handler = null; };
    },
  };
  return bridge;
}

test("Raft Desktop resume + unlock: one recovery that reconnects a dropped socket, then re-reads the visible scopes", async () => {
  const restoreSession = withRecoverableSession();
  const bridge = installDesktopResume();
  let ensured = 0;
  const transport = { connected: false, ensureSocketConnected: () => { ensured += 1; } };
  const { calls, cleanup } = await setup(transport);
  try {
    assert.ok(bridge.handler, "the bridge subscribes to the shell's resume");
    bridge.handler!({ reason: "resume" });
    bridge.handler!({ reason: "unlock-screen" });
    await settle();
    assert.equal(calls.length, 0, "coalescing a wake's resume and unlock");
    await afterResumeCoalesce();
    assert.equal(ensured, 1, "the dropped socket is reconnected");
    assert.equal(calls.length, 1, "one re-read for both events");
    assert.equal(calls[0]!.sinceSeq, 5);

    transport.connected = true;
    bridge.handler!({ reason: "unlock-screen" });
    await afterResumeCoalesce();
    assert.equal(ensured, 1, "a connected socket is left alone");
    assert.equal(calls.length, 1, "an unlock seconds after that recovery shares its read");
  } finally {
    cleanup();
    assert.equal(bridge.handler, null, "teardown unsubscribes");
    delete (window as { raftDesktop?: unknown }).raftDesktop;
    restoreSession();
  }
});

test("Raft Desktop resume while offline waits for online instead of dropping the recovery", async () => {
  const restoreSession = withRecoverableSession();
  let online = false;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  const bridge = installDesktopResume();
  const { calls, cleanup } = await setup();
  try {
    bridge.handler!({ reason: "resume" });
    await afterResumeCoalesce();
    assert.equal(calls.length, 0, "nothing read offline");
    online = true;
    window.dispatchEvent(new window.Event("online"));
    await settle();
    assert.equal(calls.length, 1, "the recovery runs once the machine is online");
  } finally {
    cleanup();
    delete (window as { raftDesktop?: unknown }).raftDesktop;
    restoreSession();
  }
});

test("re-reads skip a channel showing a jumped-to history window (hasNewer)", async () => {
  const restoreSession = withRecoverableSession();
  const { fire, calls, cleanup, useMessageStore } = await setup();
  useMessageStore.setState({ hasNewer: true });
  try {
    fire("heartbeat", { seq: 9, ts: 0 });
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(calls.length, 0, "neither the heartbeat nor a focus pages the window up to the latest");
    useMessageStore.setState({ hasNewer: false });
    fire("heartbeat", { seq: 9, ts: 0 });
    await settle();
    assert.equal(calls.length, 1, "back at the latest window it reads again");
  } finally {
    restoreSession();
    cleanup();
  }
});

test("rooms:join_failed: never a reconnect; each heartbeat re-reads the visible scope until rooms:joined", async () => {
  let reconnects = 0;
  const { fire, calls, cleanup } = await setup({ ensureSocketConnected: () => { reconnects += 1; } });
  try {
    fire("rooms:join_failed");
    fire("heartbeat", { seq: 5, ts: 0 });
    await settle();
    fire("heartbeat", { seq: 5, ts: 0 });
    await settle();
    assert.equal(calls.length, 2, "degraded: a heartbeat at lastSeq still re-reads");
    assert.equal(reconnects, 0, "no reconnect loop");
    withWindowEvent(() => fire("rooms:joined"));
    await settle();
    const afterJoin = calls.length;
    fire("heartbeat", { seq: 5, ts: 0 });
    await settle();
    assert.equal(calls.length, afterJoin, "joined: a heartbeat at lastSeq reads nothing again");
  } finally {
    cleanup();
  }
});
