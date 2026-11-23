import assert from "node:assert/strict";

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
  applyThreadParentMessagePatch,
  findCachedThreadParentMessage,
  findThreadParentMessage,
  mergeThreadMessageUpdates,
  mergeThreadMessages,
  pickFreshThreadParentMessage,
  syncThreadParentMessageFromStore,
} = await import("../threadMessages");
const {
  applyLocalMessagePatch,
  applyMessageUpdated,
  subscribeMessageUpdated,
} = await import("../../../store/messageUpdatedApply");
const {
  captureReceiverPrivateIngressContext,
  useMessageStore,
} = await import("../../../store/messageStore");
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import type { Message } from "../../../store/messageStore";

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

function questionCardMetadata(state: "prepared" | "executed"): ActionCardMetadata {
  return {
    kind: "action-card",
    state,
    confirmationVersion: 1,
    action: {
      type: "question:ask",
      to: "@owner",
      questions: [
        {
          id: "q1",
          kind: "single",
          text: "Strategy?",
          required: true,
          options: [{ value: "scale", label: "Scale" }, { value: "keep", label: "Keep" }],
          other: true,
        },
      ],
    },
  };
}

test("applyLocalMessagePatch flips an uncached ThreadPanel parent action card to executed", () => {
  useMessageStore.setState({ channelMessages: {}, messages: [] });
  const preparedMeta = questionCardMetadata("prepared");
  const executedMeta = questionCardMetadata("executed");
  let localParent: Message | null = message({
    id: "card-parent-1",
    channelId: "uncached-parent-channel",
    actionMetadata: preparedMeta,
  });

  const unsubscribe = subscribeMessageUpdated((patch) => {
    applyThreadParentMessagePatch("card-parent-1", patch, (next) => {
      localParent = typeof next === "function" ? next(localParent) : next;
    });
  });

  try {
    applyLocalMessagePatch({
      id: "card-parent-1",
      channelId: "uncached-parent-channel",
      actionMetadata: executedMeta,
    });

    assert.equal(useMessageStore.getState().channelMessages["uncached-parent-channel"], undefined);
    assert.equal(localParent?.actionMetadata, executedMeta);

    // An out-of-order stale prepared snapshot must not revert an executed action card.
    applyLocalMessagePatch({
      id: "card-parent-1",
      channelId: "uncached-parent-channel",
      actionMetadata: preparedMeta,
    });
    assert.equal(localParent?.actionMetadata, executedMeta);
  } finally {
    unsubscribe();
  }
});

test("applyMessageUpdated updates an uncached ThreadPanel parent message on live socket delivery", () => {
  useMessageStore.setState({ channelMessages: {}, messages: [], currentUserId: "u-1" });
  const preparedMeta = questionCardMetadata("prepared");
  const executedMeta = questionCardMetadata("executed");
  let localParent: Message | null = message({
    id: "card-parent-2",
    channelId: "uncached-parent-channel",
    actionMetadata: preparedMeta,
  });

  const unsubscribe = subscribeMessageUpdated((patch) => {
    applyThreadParentMessagePatch("card-parent-2", patch, (next) => {
      localParent = typeof next === "function" ? next(localParent) : next;
    });
  });

  try {
    applyMessageUpdated(
      message({
        id: "card-parent-2",
        channelId: "uncached-parent-channel",
        actionMetadata: executedMeta,
      }),
      captureReceiverPrivateIngressContext("u-1"),
    );

    assert.equal(localParent?.actionMetadata, executedMeta);
  } finally {
    unsubscribe();
  }
});

test("applyLocalMessagePatch and mergeThreadMessages propagate actionMetadata-only updates on thread replies", () => {
  useMessageStore.setState({ channelMessages: {}, messages: [] });
  const preparedMeta = questionCardMetadata("prepared");
  const executedMeta = questionCardMetadata("executed");
  const reply = message({
    id: "reply-card-1",
    channelId: "thread-channel-1",
    seq: 10,
    actionMetadata: preparedMeta,
  });
  let localReplies: Message[] = [reply];

  const unsubscribe = subscribeMessageUpdated((patch) => {
    if (patch.channelId !== "thread-channel-1") return;
    localReplies = mergeThreadMessageUpdates(localReplies, [patch]);
  });

  try {
    applyLocalMessagePatch({
      id: "reply-card-1",
      channelId: "thread-channel-1",
      actionMetadata: executedMeta,
    });

    assert.equal(localReplies[0]?.actionMetadata, executedMeta);
  } finally {
    unsubscribe();
  }

  // mergeThreadMessages (used by mergeThreadBucketWithinWindow) must also detect actionMetadata changes.
  const merged = mergeThreadMessages(
    [reply],
    [{ ...reply, actionMetadata: executedMeta }],
  );
  assert.notEqual(merged, [reply]);
  assert.equal(merged[0]?.actionMetadata, executedMeta);
});
