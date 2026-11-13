import assert from "node:assert/strict";
import { createMessageWindowHarness, flushAsyncWork } from "./messageWindowHarness";
import type { Message } from "../src/store/messageStore";

/**
 * Opening a channel that is not loaded yet from Activity (artin, v1.21.41):
 * live messages that arrived while the channel was closed made a list of just
 * those rows, and the open used it as the whole channel, at "beginning of
 * channel" with a stale `hasMore: false` from an earlier visit (kept across a
 * server switch). Only a list fetched from the API may be shown as-is; a
 * live-only one fetches its history.
 */

const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");

const CHANNEL_ID = "channel-open";
const OTHER_CHANNEL_ID = "channel-other";

function message(seq: number, channelId = CHANNEL_ID): Message {
  return {
    id: `m-${seq}`, seq, channelId, senderType: "user", senderId: "u-1", senderName: "local",
    messageType: "chat", content: `message ${seq}`, createdAt: "2026-10-30T00:00:00.000Z",
  };
}

function range(from: number, to: number): Message[] {
  return Array.from({ length: to - from + 1 }, (_, index) => message(from + index));
}

type OpenTrace = { event: string; entityId: string; outcomeDetail: string };

function captureOpenTraces(): { traces: OpenTrace[]; stop: () => void } {
  const traces: OpenTrace[] = [];
  __setStateTransitionEmitterForTest((_name, attrs) => {
    const { key, meta } = attrs as { key: { domain: string; event: string; entityId: string }; meta: { outcomeDetail: string } };
    if (key.domain === "messages" && key.event === "window.open") {
      traces.push({ event: key.event, entityId: key.entityId, outcomeDetail: meta.outcomeDetail });
    }
  });
  return { traces, stop: () => __setStateTransitionEmitterForTest(null) };
}

/** A visit that fetched a short channel (hasMore false), then a switch to another server and back. */
async function visitThenSwitchServerAndBack(h: ReturnType<typeof createMessageWindowHarness>) {
  h.enqueueChannelPages(range(1, 10));
  await h.loadMessages(CHANNEL_ID);
  assert.equal(h.windowMeta(CHANNEL_ID).hasMore, false);
  triggerServerReset();
  triggerServerReset();
}

test("Activity open of a live-only list fetches the context and shows the whole channel", async () => {
  const h = createMessageWindowHarness();
  const trace = captureOpenTraces();
  try {
    await visitThenSwitchServerAndBack(h);
    h.socketMessage(message(11));
    h.socketMessage(message(12));
    assert.deepEqual(h.messages(CHANNEL_ID).map((m) => m.id), ["m-11", "m-12"]);

    h.enqueueContextPages({ messages: range(1, 12), hasOlder: true, hasNewer: false, targetMessageId: "m-12" });
    await h.loadMessageContext(CHANNEL_ID, "m-12");
    await flushAsyncWork();

    assert.ok(h.getCalls().some((url) => url.startsWith("/messages/context/m-12")), "the context was fetched");
    const snapshot = h.snapshot(CHANNEL_ID);
    assert.equal(snapshot.messageIds.length, 12);
    assert.equal(snapshot.hasMore, true, "hasMore comes from the fetch, not the old visit");
    assert.equal(h.windowMeta(CHANNEL_ID).hasMore, true);
    assert.deepEqual(trace.traces.at(-1), {
      event: "window.open",
      entityId: CHANNEL_ID,
      outcomeDetail: "branch=context;cache=miss;cached=2;history=live_only",
    });
  } finally {
    trace.stop();
    h.restore();
  }
});

test("sync:resume rows of a closed channel are live-only too", async () => {
  const h = createMessageWindowHarness();
  try {
    await visitThenSwitchServerAndBack(h);
    h.batchMessages([message(11), message(12)]);

    h.enqueueContextPages({ messages: range(1, 12), hasOlder: false, hasNewer: false, targetMessageId: "m-11" });
    await h.loadMessageContext(CHANNEL_ID, "m-11");
    await flushAsyncWork();

    assert.ok(h.getCalls().some((url) => url.startsWith("/messages/context/m-11")));
    assert.equal(h.snapshot(CHANNEL_ID).messageIds.length, 12);
    assert.equal(h.snapshot(CHANNEL_ID).hasMore, false);
  } finally {
    h.restore();
  }
});

test("a latest-page open of a live-only list loads instead of showing it as the channel", async () => {
  const h = createMessageWindowHarness();
  try {
    await visitThenSwitchServerAndBack(h);
    h.socketMessage(message(11));
    h.socketMessage(message(12));

    let resolvePage!: (page: Message[]) => void;
    h.enqueueChannelPages(new Promise<Message[]>((resolve) => { resolvePage = resolve; }));
    const opening = h.loadMessages(CHANNEL_ID);
    assert.equal(h.snapshot(CHANNEL_ID).loading, true, "no live-only list shown as loaded");
    assert.equal(h.snapshot(CHANNEL_ID).hasMore, true);

    resolvePage(range(1, 12));
    await opening;
    assert.equal(h.snapshot(CHANNEL_ID).messageIds.length, 12);
  } finally {
    h.restore();
  }
});

test("a server switch drops the window meta of the earlier visit", async () => {
  const h = createMessageWindowHarness();
  try {
    await visitThenSwitchServerAndBack(h);
    h.switchCurrentChannel(CHANNEL_ID);
    h.socketMessage(message(11));
    assert.equal(h.windowMeta(CHANNEL_ID).hasMore, true, "no hasMore: false left over from before the switch");
  } finally {
    h.restore();
  }
});

test("a fetched list still opens from cache without another request", async () => {
  const h = createMessageWindowHarness();
  const trace = captureOpenTraces();
  try {
    h.enqueueChannelPages(range(1, 10));
    await h.loadMessages(CHANNEL_ID);
    h.switchCurrentChannel(OTHER_CHANNEL_ID);
    h.socketMessage(message(11));
    const callsBefore = h.getCalls().length;

    await h.loadMessageContext(CHANNEL_ID, "m-11");

    assert.equal(h.getCalls().length, callsBefore, "no request for a fetched list");
    const snapshot = h.snapshot(CHANNEL_ID);
    assert.equal(snapshot.messageIds.length, 11);
    assert.equal(snapshot.hasMore, false);
    assert.equal(snapshot.highlightedMessageId, "m-11");
    assert.deepEqual(trace.traces.map((entry) => entry.outcomeDetail), [
      "branch=latest;cache=miss;cached=0;history=none",
      "branch=context;cache=hit;cached=11;history=fetched",
    ]);
    assert.ok(trace.traces.every((entry) => entry.entityId === CHANNEL_ID));
  } finally {
    trace.stop();
    h.restore();
  }
});

test("a remembered-position open always fetches and is traced as such", async () => {
  const h = createMessageWindowHarness();
  const trace = captureOpenTraces();
  try {
    h.socketMessage(message(11));
    h.enqueueContextPages({ messages: range(1, 11), hasOlder: false, hasNewer: false });
    await h.loadMessageWindowSilent(CHANNEL_ID, "m-5");

    assert.equal(h.snapshot(CHANNEL_ID).messageIds.length, 11);
    assert.deepEqual(trace.traces, [{
      event: "window.open",
      entityId: CHANNEL_ID,
      outcomeDetail: "branch=remembered;cache=miss;cached=1;history=live_only",
    }]);
  } finally {
    trace.stop();
    h.restore();
  }
});

test("a live row past the end of a closed context window makes its list unfetched, so opening it fetches", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages({ messages: range(1, 5), hasOlder: false, hasNewer: true, targetMessageId: "m-3" });
    await h.loadMessageContext(CHANNEL_ID, "m-3");
    h.switchCurrentChannel(OTHER_CHANNEL_ID);
    h.socketMessage(message(6));
    h.socketMessage(message(40));
    // A reconnect's sync:resume replays the same row: it is still known, so it counts once.
    h.batchMessages([message(40)]);
    h.socketMessage(message(40));
    assert.deepEqual(h.messages(CHANNEL_ID).map((m) => m.id), ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-40"]);
    assert.equal(h.snapshot(CHANNEL_ID).unreadCount, 2);

    h.enqueueContextPages({ messages: range(30, 40), hasOlder: true, hasNewer: false, targetMessageId: "m-40" });
    await h.loadMessageContext(CHANNEL_ID, "m-40");

    assert.ok(h.getCalls().some((url) => url.startsWith("/messages/context/m-40")));
    assert.equal(h.snapshot(CHANNEL_ID).messageIds[0], "m-30");
  } finally {
    h.restore();
  }
});

test("a sync:resume batch past the end of a closed context window does the same", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages({ messages: range(1, 5), hasOlder: false, hasNewer: true, targetMessageId: "m-3" });
    await h.loadMessageContext(CHANNEL_ID, "m-3");
    h.switchCurrentChannel(OTHER_CHANNEL_ID);
    h.batchMessages([message(6), message(7)]);
    const callsBefore = h.getCalls().length;
    await h.loadMessageContext(CHANNEL_ID, "m-7");
    assert.equal(h.getCalls().length, callsBefore, "contiguous rows keep the window fetched");

    h.switchCurrentChannel(OTHER_CHANNEL_ID);
    h.batchMessages([message(41)]);
    h.enqueueContextPages({ messages: range(30, 41), hasOlder: true, hasNewer: false, targetMessageId: "m-41" });
    await h.loadMessageContext(CHANNEL_ID, "m-41");
    assert.ok(h.getCalls().some((url) => url.startsWith("/messages/context/m-41")));
  } finally {
    h.restore();
  }
});
