import assert from "node:assert/strict";
import { createMessageWindowHarness } from "./messageWindowHarness";
import { reuseUnchangedMessages } from "../src/store/messageReuse";
import type { Message } from "../src/store/messageStore";

// Task #441: a page read over a list that is already shown must not hand every
// row a new message object for the same message.

const CHANNEL_ID = "channel-reuse";

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `m-${seq}`, seq, channelId: CHANNEL_ID, senderType: "user", senderId: "u-1", senderName: "local",
    messageType: "chat", content: `message ${seq}`, createdAt: "2026-10-30T00:00:00.000Z",
    mentions: [], attachments: [],
    reactions: [{ emoji: "👍", count: 2, userIds: ["u-1", "u-2"] }] as unknown as Message["reactions"],
    ...over,
  };
}

test("a fetched message with the same data is the shown object; the page keeps its own order and length", () => {
  const shown = [message(1), message(2), message(3)];
  const fetched = [message(2), message(3), message(4)];
  const next = reuseUnchangedMessages(shown, fetched);
  assert.equal(next.length, 3);
  assert.equal(next[0], shown[1]);
  assert.equal(next[1], shown[2]);
  assert.equal(next[2], fetched[2]);
});

test("any differing field keeps the fetched object", () => {
  const shown = [message(1)];
  const differing: Message[] = [
    message(1, { content: "edited" }),
    message(1, { updatedAt: "2026-10-30T00:00:01.000Z" }),
    message(1, { reactions: [{ emoji: "👍", count: 3, userIds: ["u-1", "u-2", "u-3"] }] as unknown as Message["reactions"] }),
    message(1, { reactions: [{ emoji: "👍", count: 2, userIds: ["u-2", "u-1"] }] as unknown as Message["reactions"] }),
    message(1, { reactions: [] }),
    message(1, { attachments: [{ id: "a-1" }] as unknown as Message["attachments"] }),
    message(1, { mentions: undefined }),
    message(1, { threadId: null }),
    message(1, { threadId: "t-1" }),
    message(1, { deletedAt: "2026-10-30T00:00:02.000Z" }),
    message(1, { seq: 2 }),
  ];
  for (const fetchedMessage of differing) {
    const next = reuseUnchangedMessages(shown, [fetchedMessage]);
    assert.equal(next[0], fetchedMessage);
  }
  // A field the shown row has and the fetched one lacks, too.
  const fetchedPlain = message(1);
  assert.equal(reuseUnchangedMessages([message(1, { threadId: null })], [fetchedPlain])[0], fetchedPlain);
  // A key holding undefined is not an absent key.
  assert.equal(reuseUnchangedMessages([message(1, { updatedAt: undefined })], [fetchedPlain])[0], fetchedPlain);
});

test("nothing to reuse returns the fetched page itself", () => {
  const fetched = [message(1), message(2)];
  assert.equal(reuseUnchangedMessages(undefined, fetched), fetched);
  assert.equal(reuseUnchangedMessages([], fetched), fetched);
  assert.equal(reuseUnchangedMessages([message(7)], fetched), fetched);
  assert.equal(reuseUnchangedMessages([message(1, { content: "other" })], fetched), fetched);
  // Values that are not JSON data are equal only to themselves.
  const when = { at: new Date(0) } as unknown as Partial<Message>;
  const dated = [message(1, { ...when })];
  assert.equal(reuseUnchangedMessages([message(1, { at: new Date(0) } as unknown as Partial<Message>)], dated), dated);
});

test("opening a channel again keeps the message objects its cached list shows, and takes a changed one", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueChannelPages([message(1), message(2), message(3)]);
    await h.loadMessages(CHANNEL_ID);
    const first = h.messages(CHANNEL_ID);
    assert.deepEqual(first.map((m) => m.id), ["m-1", "m-2", "m-3"]);

    h.enqueueChannelPages([message(1), message(2, { content: "edited while away" }), message(3), message(4)]);
    await h.loadMessages(CHANNEL_ID);
    const second = h.messages(CHANNEL_ID);
    assert.deepEqual(second.map((m) => m.id), ["m-1", "m-2", "m-3", "m-4"]);
    assert.equal(second[0], first[0]);
    assert.notEqual(second[1], first[1]);
    assert.equal(second[1]?.content, "edited while away");
    assert.equal(second[2], first[2]);
  } finally {
    h.restore();
  }
});

test("a remembered-position window read over a shown list keeps the unchanged message objects too", async () => {
  const h = createMessageWindowHarness();
  try {
    h.enqueueChannelPages([message(1), message(2), message(3)]);
    await h.loadMessages(CHANNEL_ID);
    const first = h.messages(CHANNEL_ID);

    h.enqueueContextPages({
      messages: [message(1), message(2, { content: "edited while away" }), message(3), message(4)],
      hasOlder: false, hasNewer: false, targetMessageId: "m-2",
    });
    await h.loadMessageWindowSilent(CHANNEL_ID, "m-2");
    const second = h.messages(CHANNEL_ID);
    assert.deepEqual(second.map((m) => m.id), ["m-1", "m-2", "m-3", "m-4"]);
    assert.equal(second[0], first[0]);
    assert.notEqual(second[1], first[1]);
    assert.equal(second[1]?.content, "edited while away");
    assert.equal(second[2], first[2]);
  } finally {
    h.restore();
  }
});
