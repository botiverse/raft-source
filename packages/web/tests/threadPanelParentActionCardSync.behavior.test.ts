import assert from "node:assert/strict";
import { test } from "node:test";

// ThreadPanel imports authStore at module load; unit-fast does not install DOM globals.
if (typeof globalThis.localStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear() {},
      get length() {
        return 0;
      },
      getItem() {
        return null;
      },
      key() {
        return null;
      },
      removeItem() {},
      setItem() {},
    },
  });
}

const {
  findCachedThreadParentMessage,
  findThreadParentMessage,
  pickFreshThreadParentMessage,
  syncThreadParentMessageFromStore,
} = await import("../src/components/message/ThreadPanel");
import type { Message } from "../src/store/messageStore";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "parent-1",
    channelId: "parent-channel",
    senderType: "user",
    senderId: "u-1",
    senderName: "Owner",
    messageType: "chat",
    content: "pending",
    createdAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

test("findThreadParentMessage returns the current parent-channel store entry", () => {
  const parent = message({ id: "parent-1", content: "approved" });
  const other = message({ id: "other-parent", content: "pending" });

  assert.equal(findThreadParentMessage([other, parent], "parent-1", "parent-channel"), parent);
});

test("findThreadParentMessage returns null until the parent identity is known", () => {
  const parent = message();

  assert.equal(findThreadParentMessage([parent], null, "parent-channel"), null);
  assert.equal(findThreadParentMessage([parent], "parent-1", null), null);
});

test("findCachedThreadParentMessage tolerates a missing parent-channel bucket", () => {
  assert.equal(findCachedThreadParentMessage(undefined, "parent-channel", "parent-1"), null);
  assert.equal(findCachedThreadParentMessage({}, "parent-channel", "parent-1"), null);
});

test("findCachedThreadParentMessage returns the cached parent from the parent-channel bucket", () => {
  const parent = message({ content: "approved" });

  assert.equal(
    findCachedThreadParentMessage({ "parent-channel": [parent] }, "parent-channel", "parent-1"),
    parent,
  );
});

test("pickFreshThreadParentMessage prefers cached action-card metadata over context response", () => {
  const contextParent = message({ content: "pending" });
  const cachedParent = message({ content: "approved" });

  assert.equal(pickFreshThreadParentMessage(contextParent, cachedParent), cachedParent);
});

test("syncThreadParentMessageFromStore updates local parent snapshot when store has a parent", () => {
  const storeParent = message({ content: "approved" });
  let localParent: Message | null = message({ content: "pending" });

  syncThreadParentMessageFromStore(storeParent, (next) => {
    localParent = typeof next === "function" ? next(localParent) : next;
  });

  assert.equal(localParent, storeParent);
});

test("syncThreadParentMessageFromStore leaves local parent untouched without a store parent", () => {
  let called = false;

  syncThreadParentMessageFromStore(null, () => {
    called = true;
  });

  assert.equal(called, false);
});
