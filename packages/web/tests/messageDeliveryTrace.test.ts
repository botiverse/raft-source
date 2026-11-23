import assert from "node:assert/strict";
import "./helpers/domSetup";

import { afterEach, test, vi } from "vitest";
import {
  MESSAGE_RECEIVE_EVENT,
  MESSAGE_RECEIVE_SAMPLE_RATE,
  SYNC_GAP_RECOVERED_EVENT,
  __setMessageDeliveryTraceForTest,
  reportLiveMessageReceive,
  reportMessagesSyncGap,
  reportSyncResumeGap,
} from "../src/utils/messageDeliveryTrace";

type CapturedEvent = { name: string; attrs: Record<string, unknown> };

afterEach(() => {
  __setMessageDeliveryTraceForTest(null);
  vi.restoreAllMocks();
});

function capture(overrides: Omit<Parameters<typeof __setMessageDeliveryTraceForTest>[0] & object, "emitter"> = {}) {
  const events: CapturedEvent[] = [];
  __setMessageDeliveryTraceForTest({
    ...overrides,
    emitter: ((name, attrs) => {
      events.push({ name, attrs: attrs ?? {} });
    }) as NonNullable<NonNullable<Parameters<typeof __setMessageDeliveryTraceForTest>[0]>["emitter"]>,
  });
  return events;
}

function makeMainLayoutSocket() {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    connected: true,
    emit: () => undefined,
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
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

const CHANNEL_ID = "delivery-trace-ch-secret-id";

function wireMessage(seq: number, id = `msg-secret-${seq}`, createdAt = "2026-11-17T05:00:00.000Z") {
  return {
    id,
    seq,
    channelId: CHANNEL_ID,
    senderType: "agent" as const,
    senderId: "agent-secret-99",
    senderName: "NotZZ",
    messageType: "chat" as const,
    content: `hello ${seq}`,
    createdAt,
    reactions: [],
    actionMetadata: null,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("default 5% sampling admits values under 0.05, clamps negative clock skew, and emits closed attributes without ids", () => {
  assert.equal(MESSAGE_RECEIVE_SAMPLE_RATE, 0.05);
  const baseMs = Date.parse("2026-11-17T05:00:00.000Z");

  let roll = 0.05;
  const events = capture({
    random: () => roll,
    now: () => baseMs + 247,
    visibility: () => "visible",
  });

  // At the boundary (>= 0.05): skipped.
  reportLiveMessageReceive(wireMessage(10), "message:new");
  assert.equal(events.length, 0);

  // Selected (< 0.05): recorded with lag_ms and no ids.
  roll = 0.049;
  reportLiveMessageReceive(wireMessage(11), "message:new");
  assert.deepEqual(events, [
    {
      name: MESSAGE_RECEIVE_EVENT,
      attrs: {
        event: "message:new",
        lag_ms: 247,
        clock_skew: false,
        sender_kind: "agent",
        visibility: "visible",
      },
    },
  ]);

  // Future createdAt (client clock behind server) clamps lag_ms to 0 and flags clock_skew.
  const skewed = capture({
    sampleRate: 1,
    now: () => baseMs - 150,
    visibility: () => "hidden",
  });
  reportLiveMessageReceive({ createdAt: "2026-11-17T05:00:00.000Z", senderType: "unexpected-role" }, "thread:updated");
  assert.deepEqual(skewed, [
    {
      name: MESSAGE_RECEIVE_EVENT,
      attrs: {
        event: "thread:updated",
        lag_ms: 0,
        clock_skew: true,
        sender_kind: "unknown",
        visibility: "hidden",
      },
    },
  ]);

  const serialized = JSON.stringify([...events, ...skewed]);
  assert.equal(serialized.includes(CHANNEL_ID), false);
  assert.equal(serialized.includes("msg-secret"), false);
  assert.equal(serialized.includes("agent-secret"), false);
});

test("malformed inputs and throwing emitters are swallowed and never throw into socket paths", () => {
  __setMessageDeliveryTraceForTest({
    sampleRate: 1,
    emitter: () => {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => {
    reportLiveMessageReceive(null, "message:new");
    reportLiveMessageReceive({ createdAt: "not-a-date", senderType: "user" }, "message:new");
    reportLiveMessageReceive(wireMessage(1), "message:new");
    reportMessagesSyncGap(2, "read", true);
    reportSyncResumeGap(3, false, false);
  });
});

test("socketBridge integration (sampling disabled): live message:new emits lag_ms once and skips duplicate echoes", async () => {
  const { installMainLayoutSocketBridge } = await import("../src/store/socketBridge");
  const { useMessageStore } = await import("../src/store/messageStore");
  (await import("../src/store/liveGapFill")).resetGapFillForTests();
  const api = (await import("../src/api/client")).default;
  vi.spyOn(api, "get").mockImplementation((async () => ({ data: [] })) as typeof api.get);

  window.history.pushState({}, "", `/s/team/channel/${CHANNEL_ID}`);
  useMessageStore.setState({
    channelMessages: { [CHANNEL_ID]: [wireMessage(5)] },
    messages: [wireMessage(5)],
    currentChannelId: CHANNEL_ID,
    lastSeq: 5,
    loadingGap: false,
    currentUserId: "viewer-user-1",
  });

  const baseMs = Date.parse("2026-11-17T05:00:00.000Z");
  const events = capture({
    sampleRate: 1,
    now: () => baseMs + 183,
    visibility: () => "visible",
  });

  const { socket, fire } = makeMainLayoutSocket();
  const uninstall = installMainLayoutSocketBridge({
    getSocket: () => socket,
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  });
  try {
    // First socket delivery of seq 6 -> emits slock.web.message_receive with lag_ms = 183.
    fire("message:new", wireMessage(6, "msg-secret-6", "2026-11-17T05:00:00.000Z"));
    // Duplicate/echo delivery of the same message -> accepted is false, does NOT emit again.
    fire("message:new", wireMessage(6, "msg-secret-6", "2026-11-17T05:00:00.000Z"));
    await settle();

    const receiveEvents = events.filter((e) => e.name === MESSAGE_RECEIVE_EVENT);
    assert.deepEqual(receiveEvents, [
      {
        name: MESSAGE_RECEIVE_EVENT,
        attrs: {
          event: "message:new",
          lag_ms: 183,
          clock_skew: false,
          sender_kind: "agent",
          visibility: "visible",
        },
      },
    ]);
  } finally {
    uninstall();
  }
});

test("gap-fill integration: real syncGap and sync:resume emit slock.web.sync_gap_recovered on missed rows and skip empty global-seq jumps", async () => {
  const { installMainLayoutSocketBridge } = await import("../src/store/socketBridge");
  const { useMessageStore } = await import("../src/store/messageStore");
  (await import("../src/store/liveGapFill")).resetGapFillForTests();
  const api = (await import("../src/api/client")).default;

  let syncAnswer: unknown[] = [];
  vi.spyOn(api, "get").mockImplementation((async (url: string) => {
    if (url.startsWith("/messages/sync")) {
      const rows = syncAnswer;
      syncAnswer = [];
      return { data: rows };
    }
    return { data: [] };
  }) as typeof api.get);

  window.history.pushState({}, "", `/s/team/channel/${CHANNEL_ID}`);
  useMessageStore.setState({
    channelMessages: { [CHANNEL_ID]: [wireMessage(10)] },
    messages: [wireMessage(10)],
    currentChannelId: CHANNEL_ID,
    lastSeq: 10,
    loadingGap: false,
    currentUserId: "viewer-user-1",
  });

  const events = capture({
    sampleRate: 0,
    visibility: () => "visible",
  });

  const { socket, fire } = makeMainLayoutSocket();
  const uninstall = installMainLayoutSocketBridge({
    getSocket: () => socket,
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  });
  try {
    // 1. Global seq jumped to 15 because of another channel (`syncAnswer = []`):
    //    live row seq 15 triggers background syncGap, which returns 0 missing messages -> NO gap event!
    syncAnswer = [];
    fire("message:new", wireMessage(15));
    await settle();
    assert.deepEqual(
      events.filter((e) => e.name === SYNC_GAP_RECOVERED_EVENT),
      [],
    );

    // 2. Real missed messages (seqs 16 and 17 missed before live seq 18 arrives):
    //    syncGap recovers 2 unseen messages (plus echoes seq 18, which dedupes out) -> emits recovered_count = 2!
    syncAnswer = [wireMessage(16), wireMessage(17), wireMessage(18)];
    fire("message:new", wireMessage(18));
    await settle();
    assert.deepEqual(
      events.filter((e) => e.name === SYNC_GAP_RECOVERED_EVENT),
      [
        {
          name: SYNC_GAP_RECOVERED_EVENT,
          attrs: {
            source: "messages_sync",
            recovered_count: 2,
            outcome: "read",
            had_pending_hole: true,
            has_more: false,
            horizon_reset: false,
            visibility: "visible",
          },
        },
      ],
    );

    // 3. Reconnect sync:resume:response with 1 already-known row and 1 missed row -> emits source = sync_resume, recovered_count = 1.
    fire("sync:resume:response", {
      messages: [wireMessage(18), wireMessage(19)],
      currentSeq: 19,
      hasMore: false,
      horizon: "h-19",
      horizonReset: false,
    });
    await settle();
    assert.deepEqual(events.filter((e) => e.name === SYNC_GAP_RECOVERED_EVENT).at(-1), {
      name: SYNC_GAP_RECOVERED_EVENT,
      attrs: {
        source: "sync_resume",
        recovered_count: 1,
        outcome: "read",
        had_pending_hole: false,
        has_more: false,
        horizon_reset: false,
        visibility: "visible",
      },
    });
  } finally {
    uninstall();
  }
});
