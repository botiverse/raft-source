import assert from "node:assert/strict";
import { createMessageWindowHarness, flushAsyncWork } from "./messageWindowHarness";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function page(channelId: string, first: number, count = 50): Message[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `${channelId}-${first + offset}`, seq: first + offset, channelId,
    senderType: "user", senderId: "u-1", senderName: "local", messageType: "chat",
    content: "local fixture", createdAt: "2026-10-17T00:00:00.000Z",
  }));
}

for (const outcome of ["success", "failure"] as const) {
  test(`pending older remains exclusive through latest reload; ${outcome} releases for another page`, async () => {
    const h = createMessageWindowHarness();
    const id = `older-reload-${outcome}`;
    const olderResponse = deferred<Message[]>();
    const latestResponse = deferred<Message[]>();
    try {
      h.primeWindow(id, page(id, 162, 1), { hasMore: true });
      h.enqueueChannelPages(olderResponse.promise, latestResponse.promise);
      const older = h.loadOlderMessages(id);
      await h.loadOlderMessages(id);
      assert.equal(h.getCalls().length, 1, "pending older alone excludes repeated scroll calls");
      const latest = useMessageStore.getState().loadMessages(id);
      await h.loadOlderMessages(id);
      assert.deepEqual(h.getCalls(), [
        `/messages/channel/${id}?limit=50&before=162&threadPreviewChars=200`,
        `/messages/channel/${id}?limit=50&threadPreviewChars=200`,
      ], "latest reload must not admit another older while both responses remain pending");
      latestResponse.resolve(page(id, 162));
      await latest;
      await h.loadOlderMessages(id);
      assert.equal(h.getCalls().length, 2, "latest completion also cannot release older ownership");
      if (outcome === "success") olderResponse.resolve(page(id, 112));
      else olderResponse.reject(new Error("controlled page failure"));
      await older;
      assert.equal(h.windowMeta(id).loadingOlder, false);
      const nextCursor = outcome === "success" ? 112 : 162;
      h.enqueueChannelPages(page(id, nextCursor - 50));
      await h.loadOlderMessages(id);
      assert.equal(h.getCalls().at(-1), `/messages/channel/${id}?limit=50&before=${nextCursor}&threadPreviewChars=200`);
      assert.equal(h.getCalls().length, 3, "settled older allows a legitimate next page (or same-cursor retry)");
      assert.equal(h.messages(id)[0].seq, nextCursor - 50);
    } finally {
      olderResponse.resolve([]);
      latestResponse.resolve([]);
      await flushAsyncWork();
      h.restore();
    }
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`old principal ${outcome} cannot release a newer principal's older request`, async () => {
    const h = createMessageWindowHarness();
    const id = `older-principal-${outcome}`;
    const oldResponse = deferred<Message[]>();
    const newResponse = deferred<Message[]>();
    try {
      h.setCurrentUser("principal-old");
      h.primeWindow(id, page(id, 162, 1), { hasMore: true });
      h.enqueueChannelPages(oldResponse.promise, newResponse.promise);
      const oldRequest = h.loadOlderMessages(id);
      h.setCurrentUser("principal-new");
      h.primeWindow(id, page(id, 162, 1), { hasMore: true });
      const newRequest = h.loadOlderMessages(id);
      assert.equal(h.getCalls().length, 2, "stale namespace cannot block current principal");
      if (outcome === "success") oldResponse.resolve(page(id, 112));
      else oldResponse.reject(new Error("old principal failure"));
      await oldRequest;
      assert.equal(h.windowMeta(id).loadingOlder, true, "stale completion cannot clear current spinner");
      // Resettable window metadata cannot be the only thing protecting this flight.
      h.setWindowMeta(id, { loadingOlder: false });
      await h.loadOlderMessages(id);
      assert.equal(h.getCalls().length, 2, "stale completion cannot remove replacement ownership");
      newResponse.resolve(page(id, 112));
      await newRequest;
      h.enqueueChannelPages(page(id, 62));
      await h.loadOlderMessages(id);
      assert.equal(h.getCalls().length, 3);
      assert.equal(h.messages(id)[0].seq, 62);
    } finally {
      oldResponse.resolve([]);
      newResponse.resolve([]);
      await flushAsyncWork();
      h.restore();
    }
  });
}
