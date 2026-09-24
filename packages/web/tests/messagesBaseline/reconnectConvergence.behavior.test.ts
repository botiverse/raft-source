import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageWindowHarness,
  flushAsyncWork,
} from "../messageWindowHarness.js";
import {
  buildMainLayoutSocketBindings,
} from "../../src/store/socketBridge.js";
import type {
  MainLayoutSocketBridgeSocket,
  SocketBinding,
} from "../../src/store/socketBridge.js";
import { useInboxStore } from "../../src/store/inboxStore.js";
import { useMessageStore } from "../../src/store/messageStore.js";
import type { Message } from "../../src/store/messageStore.js";

const CHANNEL_ID = "channel-1";
const SERIAL = { concurrency: false };
const originalEvent = globalThis.Event;

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];

  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }

  on() {
    return undefined;
  }

  off() {
    return undefined;
  }

  onAny() {
    return undefined;
  }

  offAny() {
    return undefined;
  }

  disconnect() {
    this.connected = false;
  }

  connect() {
    this.connected = true;
  }
}

function message(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${seq}`,
    seq,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "u-1",
    senderName: "Zhao",
    messageType: "chat",
    content: `message ${seq}`,
    createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, seq)).toISOString(),
    ...overrides,
  };
}

function bindHandlers(
  socket: FakeSocket,
  syncVisibleScopes: () => Promise<void>,
) {
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    syncVisibleScopes,
    () => undefined,
    () => undefined,
  );

  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const binding of bindings) byEvent.set(binding.event, binding.handler);
  return {
    connect: byEvent.get("connect")!,
    roomsJoined: byEvent.get("rooms:joined")!,
    resumeResponse: byEvent.get("sync:resume:response")!,
  };
}

function useDomEventConstructor() {
  if (typeof window === "undefined" || !window.Event) return () => undefined;
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: window.Event,
  });
  return () => {
    Object.defineProperty(globalThis, "Event", {
      configurable: true,
      value: originalEvent,
    });
  };
}

function stubInboxHydrate() {
  const originalLoadInbox = useInboxStore.getState().loadInbox;
  useInboxStore.setState({ loadInbox: async () => undefined });
  return () => {
    useInboxStore.setState({ loadInbox: originalLoadInbox });
  };
}

test("reconnect resume delivers disconnect-period messages once and preserves visible history", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const socket = new FakeSocket();
  const restoreEvent = useDomEventConstructor();
  const restoreInbox = stubInboxHydrate();
  try {
    harness.primeWindow(CHANNEL_ID, [message(1)]);
    harness.enqueueSyncPages([message(2), message(3)]);
    const visibleBeforeReconnect = harness.rawMessages(CHANNEL_ID);
    const handlers = bindHandlers(socket, async () => {
      await useMessageStore.getState().syncGap(CHANNEL_ID);
    });

    socket.disconnect();
    socket.connect();
    handlers.connect(undefined);

    assert.equal(harness.rawMessages(CHANNEL_ID), visibleBeforeReconnect);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((item) => item.id), ["m-1"]);

    handlers.roomsJoined(undefined);
    await flushAsyncWork();

    assert.deepEqual(socket.emitted, [
      { event: "sync:resume", args: [{ lastSeq: 1 }] },
    ]);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((item) => item.id), ["m-1", "m-2", "m-3"]);

    handlers.resumeResponse({
      messages: [message(2), message(3)],
      currentSeq: 3,
      hasMore: false,
    });

    assert.deepEqual(harness.messages(CHANNEL_ID).map((item) => item.id), ["m-1", "m-2", "m-3"]);
    assert.equal(harness.messages(CHANNEL_ID).filter((item) => item.id === "m-2").length, 1);
    assert.equal(harness.messages(CHANNEL_ID).filter((item) => item.id === "m-3").length, 1);
    assert.equal(useMessageStore.getState().lastSeq, 3);
  } finally {
    restoreInbox();
    restoreEvent();
    harness.restore();
  }
});

test("resume overflow falls back to full hydrate and converges to the same terminal view", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const socket = new FakeSocket();
  try {
    harness.primeWindow(CHANNEL_ID, [message(1)]);
    harness.enqueueChannelPages([message(1), message(2), message(3), message(4)]);
    const handlers = bindHandlers(socket, async () => {
      await useMessageStore.getState().loadMessages(CHANNEL_ID);
    });

    handlers.resumeResponse({
      messages: [message(4)],
      currentSeq: 4,
      hasMore: true,
    });
    await flushAsyncWork();

    assert.deepEqual(harness.getCalls(), ["/messages/channel/channel-1?limit=50"]);
    assert.deepEqual(harness.messages(CHANNEL_ID).map((item) => item.id), ["m-1", "m-2", "m-3", "m-4"]);
    assert.equal(harness.messages(CHANNEL_ID).filter((item) => item.id === "m-4").length, 1);
    assert.equal(useMessageStore.getState().lastSeq, 4);
  } finally {
    harness.restore();
  }
});
