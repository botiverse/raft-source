import assert from "node:assert/strict";
import test from "node:test";
import { createMessageWindowHarness, flushAsyncWork } from "../messageWindowHarness.js";
import { useMessageStore } from "../../src/store/messageStore.js";
import type { Message } from "../../src/store/messageStore.js";

const SERIAL = { concurrency: false };
const CHANNEL_ID = "t4a-j1-send-echo";

function persistedMessage(seq: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `server-${seq}`,
    seq,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-1",
    senderName: "User One",
    messageType: "chat",
    content: `message ${seq}`,
    createdAt: new Date(Date.UTC(2026, 6, 10, 6, 0, seq)).toISOString(),
    ...overrides,
  };
}

function optimisticMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "optimistic-msg-1001",
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-1",
    senderName: "User One",
    messageType: "chat",
    content: "draft body",
    createdAt: "2026-07-10T06:00:30.000Z",
    randomId: "msg-1001",
    ...overrides,
  };
}

test("T4a-J1 baseline: local send creates exactly one pending shadow row with content", SERIAL, () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persistedMessage(1), persistedMessage(2)], { lastSeq: 2 });

    useMessageStore.getState().addOptimisticMessage(optimisticMessage());

    const rows = harness.messages(CHANNEL_ID);
    assert.equal(rows.length, 3, "pending send appends one visible row");
    assert.deepEqual(rows.map((row) => row.id), ["server-1", "server-2", "optimistic-msg-1001"]);
    assert.equal(rows[2]?.content, "draft body", "pending row keeps the submitted body");
    assert.equal(rows[2]?.randomId, "msg-1001", "pending row carries the randomId used for echo absorption");
    assert.equal(rows[2]?.optimisticDisplaySeq, 3, "pending row stays adjacent to the eventual server tail");
  } finally {
    harness.restore();
  }
});

test("T4a-J1 baseline: canonical echo with the same randomId absorbs the pending row in place", SERIAL, () => {
  const harness = createMessageWindowHarness();
  try {
    harness.primeWindow(CHANNEL_ID, [persistedMessage(1), persistedMessage(2)], { lastSeq: 2 });
    useMessageStore.getState().addOptimisticMessage(optimisticMessage());
    const beforeEcho = harness.messages(CHANNEL_ID);
    const pendingIndex = beforeEcho.findIndex((row) => row.id === "optimistic-msg-1001");

    harness.socketMessage(
      persistedMessage(3, {
        id: "server-1001",
        randomId: "msg-1001",
        content: "draft body",
      }),
    );

    const afterEcho = harness.messages(CHANNEL_ID);
    assert.equal(afterEcho.length, beforeEcho.length, "echo replacement must not add a second visible row");
    assert.equal(afterEcho.findIndex((row) => row.id === "server-1001"), pendingIndex, "replacement keeps the row slot");
    assert.deepEqual(afterEcho.map((row) => row.id), ["server-1", "server-2", "server-1001"]);
    assert.equal(afterEcho.some((row) => row.id === "optimistic-msg-1001"), false, "pending id is consumed");
    assert.equal(afterEcho[2]?.randomId, "msg-1001");
  } finally {
    harness.restore();
  }
});

test("T4a-J1 baseline: REST echo and duplicate socket echo do not produce a second row", SERIAL, async () => {
  const harness = createMessageWindowHarness();
  const canonical = persistedMessage(3, {
    id: "server-1001",
    randomId: "msg-1001",
    content: "draft body",
  });
  try {
    harness.primeWindow(CHANNEL_ID, [persistedMessage(1), persistedMessage(2)], { lastSeq: 2 });
    useMessageStore.getState().addOptimisticMessage(optimisticMessage());
    harness.enqueuePostResponses(canonical);

    await harness.sendMessage(CHANNEL_ID, "draft body", "optimistic-msg-1001", "msg-1001");
    await flushAsyncWork();
    harness.socketMessage(canonical);
    harness.socketMessage(canonical);

    const rows = harness.messages(CHANNEL_ID);
    assert.deepEqual(rows.map((row) => row.id), ["server-1", "server-2", "server-1001"]);
    assert.equal(rows.filter((row) => row.randomId === "msg-1001").length, 1, "same randomId remains one row");
    assert.equal(rows.some((row) => row.id === "optimistic-msg-1001"), false, "pending row does not hang forever");
    assert.deepEqual(harness.postCalls(), [
      {
        url: "/v2/messages",
        body: {
          channelId: CHANNEL_ID,
          content: "draft body",
          attachmentIds: undefined,
          asTask: undefined,
          randomId: "msg-1001",
          mentions: undefined,
        },
      },
    ]);
  } finally {
    harness.restore();
  }
});
