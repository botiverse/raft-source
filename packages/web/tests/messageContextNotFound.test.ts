import assert from "node:assert/strict";
import { createMessageWindowHarness, flushAsyncWork } from "./messageWindowHarness";
import { CONTEXT_LOAD_FAILED_ERROR, CONTEXT_NOT_FOUND_ERROR } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";

/**
 * Deep links v1 review (P2-1): only the server's final answer about a jump
 * target (400 bad id, 403, 404) is "not found"; a failed read (5xx, timeout,
 * offline) is not, so a landed link never shows "Message not found" for a
 * network blip. Both still load the newest messages and raise the old toast.
 */

const CHANNEL_ID = "channel-context";

function message(seq: number): Message {
  return {
    id: `m-${seq}`, seq, channelId: CHANNEL_ID, senderType: "user", senderId: "u-1", senderName: "local",
    messageType: "chat", content: `message ${seq}`, createdAt: "2026-10-20T00:00:00.000Z",
  };
}

async function jumpFailingWith(failure: unknown) {
  const h = createMessageWindowHarness();
  try {
    h.enqueueContextPages(Promise.reject(failure));
    h.enqueueChannelPages([message(1), message(2)]);
    await h.loadMessageContext(CHANNEL_ID, "m-target");
    await flushAsyncWork();
    const snapshot = h.snapshot(CHANNEL_ID);
    return { error: snapshot.contextLoadError, ids: snapshot.messageIds };
  } finally {
    h.restore();
  }
}

test("404, 403 and a bad id are a final not-found", async () => {
  for (const status of [404, 403, 400]) {
    const { error, ids } = await jumpFailingWith({ response: { status, data: { error: "Message not found" } } });
    assert.equal(error, CONTEXT_NOT_FOUND_ERROR, `status ${status}`);
    assert.deepEqual(ids, ["m-1", "m-2"]);
  }
});

test("a 500, a timeout or no network is a failed read, not a not-found", async () => {
  for (const failure of [
    { response: { status: 500, data: { error: "boom" } } },
    { response: { status: 503 } },
    { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" },
    new Error("Network Error"),
  ]) {
    const { error, ids } = await jumpFailingWith(failure);
    assert.equal(error, CONTEXT_LOAD_FAILED_ERROR);
    assert.deepEqual(ids, ["m-1", "m-2"], "the newest messages still load");
  }
});
