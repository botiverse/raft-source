import assert from "node:assert/strict";
import { createMessageWindowHarness, flushAsyncWork } from "./messageWindowHarness";
import { CONTEXT_BEYOND_HISTORY_ERROR, useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useHiddenHistoryStore } from "../src/store/hiddenHistoryStore";
import { useThreadStore } from "../src/store/threadStore";

/**
 * Jumping to a message on a Free server (task #8, frames 3, 4, 5 and the
 * aged-out remembered position): the store keeps what the context route says
 * about the history window.
 */

const CHANNEL_ID = "channel-jump";

function message(seq: number): Message {
  return {
    id: `m-${seq}`, seq, channelId: CHANNEL_ID, senderType: "user", senderId: "u-1", senderName: "local",
    messageType: "chat", content: `message ${seq}`, createdAt: "2026-10-20T00:00:00.000Z",
  };
}

function hiddenRow(id: string, preview: string) {
  return { id, senderType: "user", senderId: "u-2", senderName: "Lin Mo", senderAvatarUrl: null, createdAt: "2026-09-16T10:30:00.000Z", preview };
}

afterEach(() => {
  useHiddenHistoryStore.setState({ byChannel: {}, targetByChannel: {} });
});

test("a target behind the window: its previews are kept and the window after it loads under the paywall", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages(Promise.reject({
      response: {
        status: 404,
        data: {
          error: "Message is older than the plan's history window",
          code: "history_limited",
          channelId: CHANNEL_ID,
          targetMessageId: "m-old",
          hiddenTarget: {
            target: { ...hiddenRow("m-old", "the final design is in Figma"), seq: 7 },
            before: [hiddenRow("m-before", "agreed")],
            after: [hiddenRow("m-after", "copy updated")],
            thread: null,
            replies: null,
          },
        },
      },
    }));
    // An after page always says hasNewer; two messages of 50 are the end.
    h.enqueueChannelPages({ messages: [message(20), message(21)], ...({ messageWindow: { hasNewer: true } } as object) });

    await h.loadMessageContext(CHANNEL_ID, "m-old");
    await flushAsyncWork();

    assert.deepEqual(h.getCalls(), [`/messages/context/m-old`, `/messages/channel/${CHANNEL_ID}?limit=50&after=7`]);
    const snapshot = h.snapshot(CHANNEL_ID);
    assert.deepEqual(snapshot.messageIds, ["m-20", "m-21"]);
    assert.equal(snapshot.hasMore, false, "nothing older loads above the paywall");
    assert.equal(snapshot.hasNewer, false, "a short page after the target is the newest");
    assert.equal(snapshot.highlightedMessageId, null);
    assert.equal(snapshot.contextLoadError, CONTEXT_BEYOND_HISTORY_ERROR);
    assert.equal(h.windowMeta(CHANNEL_ID).historyLimited, true);
    const target = useHiddenHistoryStore.getState().targetByChannel[CHANNEL_ID];
    assert.equal(target?.target.id, "m-old");
    assert.deepEqual(target?.after.map((row) => row.id), ["m-after"]);
  } finally {
    h.restore();
  }
});

test("a reply behind the window opens its thread, focused on it, and the channel loads its latest page", async () => {
  const h = createMessageWindowHarness();
  const originalOpenThread = useThreadStore.getState().openThread;
  const openRequests: Array<{ parentChannelId: string; parentMessageId: string; focusedMessageId?: string | null }> = [];
  try {
    useThreadStore.setState({ openThread: async (request) => { openRequests.push(request); } });
    h.enqueueContextPages(Promise.reject({
      response: {
        status: 404,
        data: {
          code: "history_limited",
          channelId: CHANNEL_ID,
          targetMessageId: "r-old",
          canonicalTarget: { kind: "thread", channelId: CHANNEL_ID, messageId: "r-old", threadParentMessageId: "p-old", threadChannelId: "thread-old" },
          hiddenTarget: {
            target: { ...hiddenRow("r-old", "one more number"), seq: 3 },
            before: [hiddenRow("p-old", "the plan")],
            after: [],
            thread: { hiddenReplyCount: 4, hiddenReplyCountCapped: false, parentHidden: true },
            replies: null,
          },
        },
      },
    }));
    h.enqueueChannelPages({ messages: [message(40)] });

    await h.loadMessageContext(CHANNEL_ID, "r-old");
    await flushAsyncWork();

    assert.deepEqual(openRequests, [{ parentChannelId: CHANNEL_ID, parentMessageId: "p-old", focusedMessageId: "r-old" }]);
    assert.deepEqual(h.getCalls(), [`/messages/context/r-old`, `/messages/channel/${CHANNEL_ID}?limit=50`]);
    assert.notEqual(h.snapshot(CHANNEL_ID).contextLoadError, CONTEXT_BEYOND_HISTORY_ERROR, "the channel is not the reply's paywall");
    assert.equal(useHiddenHistoryStore.getState().targetByChannel[CHANNEL_ID], undefined);
  } finally {
    useThreadStore.setState({ openThread: originalOpenThread });
    h.restore();
  }
});

test("a target inside the window whose context reaches the cutoff keeps the limit and the hidden count", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages({
      messages: [message(30), message(31)],
      hasOlder: false,
      hasNewer: false,
      targetMessageId: "m-30",
      ...({ historyLimited: true, hiddenHistory: { hiddenCount: 6, hiddenCountCapped: false, latest: [] } } as object),
    });

    await h.loadMessageContext(CHANNEL_ID, "m-30");

    assert.equal(h.windowMeta(CHANNEL_ID).historyLimited, true, "the paywall goes above, not \"Beginning of messages\"");
    assert.equal(useHiddenHistoryStore.getState().byChannel[CHANNEL_ID]?.hiddenCount, 6);
    assert.equal(h.snapshot(CHANNEL_ID).highlightedMessageId, "m-30");
  } finally {
    h.restore();
  }
});

test("a remembered position that is gone opens at the latest messages, not an empty channel", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages(Promise.reject({ response: { status: 404, data: { error: "Message not found" } } }));
    h.enqueueChannelPages({ messages: [message(40), message(41)] });

    await h.loadMessageWindowSilent(CHANNEL_ID, "m-aged-out");
    await flushAsyncWork();

    assert.deepEqual(h.getCalls(), [`/messages/context/m-aged-out`, `/messages/channel/${CHANNEL_ID}?limit=50`]);
    assert.deepEqual(h.snapshot(CHANNEL_ID).messageIds, ["m-40", "m-41"]);
    assert.equal(useMessageStore.getState().loading, false);
  } finally {
    h.restore();
  }
});
