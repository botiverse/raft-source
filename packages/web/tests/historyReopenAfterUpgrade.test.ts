import assert from "node:assert/strict";
import { createMessageWindowHarness, flushAsyncWork } from "./messageWindowHarness";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useHiddenHistoryStore } from "../src/store/hiddenHistoryStore";

/**
 * An upgrade while a Free channel shows its history paywall (task #8, frame
 * 12): the paywall goes and the older messages load above, without a reload.
 */

function page(channelId: string, first: number, count: number): Message[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `${channelId}-${first + offset}`, seq: first + offset, channelId,
    senderType: "user", senderId: "u-1", senderName: "local", messageType: "chat",
    content: "local fixture", createdAt: "2026-10-20T00:00:00.000Z",
  }));
}

test("reopening a cut channel drops its paywall state and loads the page before its oldest message", async () => {
  const h = createMessageWindowHarness();
  const id = "history-reopen";
  try {
    h.enqueueChannelPages({
      messages: page(id, 200, 3),
      historyLimited: true,
      hiddenHistory: { hiddenCount: 6, hiddenCountCapped: false, latest: [] },
    });
    await useMessageStore.getState().loadMessages(id);
    assert.equal(h.windowMeta(id).historyLimited, true);
    assert.equal(useHiddenHistoryStore.getState().byChannel[id]?.hiddenCount, 6);

    h.enqueueChannelPages({ messages: page(id, 150, 50), historyLimited: false });
    useMessageStore.getState().reopenHistoryWindow(id);
    assert.equal(h.windowMeta(id).historyLimited, false, "the paywall goes at once");
    assert.ok(!(id in useHiddenHistoryStore.getState().byChannel));
    await flushAsyncWork();
    assert.equal(h.getCalls().at(-1), `/messages/channel/${id}?limit=50&before=200`);
    assert.equal(h.messages(id)[0].seq, 150, "the older messages are above");

    // Not cut: nothing to reopen, nothing fetched.
    const calls = h.getCalls().length;
    useMessageStore.getState().reopenHistoryWindow(id);
    await flushAsyncWork();
    assert.equal(h.getCalls().length, calls);
  } finally {
    await flushAsyncWork();
    h.restore();
    useHiddenHistoryStore.setState({ byChannel: {} });
  }
});
