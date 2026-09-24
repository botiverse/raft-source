/**
 * Task #47 — the socket seam: `thread:updated` → read model.
 *
 * The gate under test is the one that is silent when wrong. `seq` is OPTIONAL on
 * the shared message payload (`seq?: number`), and every ordering gate in the
 * read model is a magnitude comparison on it. An absent seq does not throw — it
 * passes the seam (`undefined <= 7` is false) and then turns the sort comparator
 * into NaN, scrambling the window. A frame we cannot order is a frame we cannot
 * apply.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { projectThreadReplyFrame } from "../src/store/threadRepliesSocket";

const validLatestReply = {
  id: "m-8",
  seq: 8,
  content: "hello",
  senderId: "u-1",
  senderType: "user",
  senderName: "alice",
  senderDisplayName: "Alice",
  senderAvatarUrl: null,
  createdAt: "2026-07-12T00:00:00Z",
};

test("a well-formed frame projects to a reply preview", () => {
  const frame = projectThreadReplyFrame({
    parentMessageId: "parent-1",
    replyCount: 8,
    latestReply: validLatestReply,
  });

  assert.ok(frame);
  assert.equal(frame.parentMessageId, "parent-1");
  assert.equal(frame.replyCount, 8);
  assert.equal(frame.reply.seq, 8);
  assert.equal(frame.reply.messageId, "m-8");
  assert.equal(frame.reply.preview, "hello");
  assert.equal(frame.reply.senderName, "alice");
  assert.equal(frame.reply.senderDisplayName, "Alice");
});

test("a legacy frame falls back from senderDisplayName to senderName", () => {
  const frame = projectThreadReplyFrame({
    parentMessageId: "parent-1",
    replyCount: 8,
    latestReply: { ...validLatestReply, senderDisplayName: undefined },
  });

  assert.ok(frame);
  assert.equal(frame.reply.senderDisplayName, "alice");
});

test("a frame with NO seq is DROPPED, not admitted with an unordered seq", () => {
  // The silent one. `undefined <= snapshotSeq` is false, so an unguarded frame
  // sails through the seam and then poisons the comparator with NaN.
  const frame = projectThreadReplyFrame({
    parentMessageId: "parent-1",
    replyCount: 8,
    latestReply: { ...validLatestReply, seq: undefined },
  });

  assert.equal(frame, null, "a frame that cannot be ordered must not be applied at all");
});

test("a frame with a non-numeric or non-finite seq is dropped", () => {
  for (const seq of ["8", NaN, Infinity, null]) {
    assert.equal(
      projectThreadReplyFrame({
        parentMessageId: "parent-1",
        replyCount: 8,
        latestReply: { ...validLatestReply, seq },
      }),
      null,
      `seq=${String(seq)} must be rejected rather than coerced — coercion is how NaN gets in`,
    );
  }
});

test("a frame with no authoritative replyCount is dropped", () => {
  // The count is adopted, never derived — so a frame without one has nothing to
  // adopt. Defaulting it to 0 or to +1 would reintroduce the double-count.
  assert.equal(
    projectThreadReplyFrame({ parentMessageId: "parent-1", latestReply: validLatestReply }),
    null,
  );
});

test("a thread:updated with no latestReply (e.g. a count-only update) is dropped", () => {
  assert.equal(
    projectThreadReplyFrame({ parentMessageId: "parent-1", replyCount: 8, latestReply: null }),
    null,
  );
});

test("an unknown senderType degrades to user rather than admitting a bad union value", () => {
  const frame = projectThreadReplyFrame({
    parentMessageId: "parent-1",
    replyCount: 8,
    latestReply: { ...validLatestReply, senderType: "wizard" },
  });

  assert.ok(frame);
  assert.equal(frame.reply.senderType, "user");
});
