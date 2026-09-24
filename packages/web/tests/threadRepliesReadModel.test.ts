/**
 * Task #47 — the two gates @赵梓淇 required on the thread-replies read model.
 * Both are ORDERING invariants, and both are the class of bug that is silent
 * when wrong: the preview just quietly shows the wrong replies.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyThreadReplyFrame,
  emptyThreadRepliesScope,
  hydrateThreadRepliesScope,
  INLINE_REPLY_CAP,
} from "../src/store/threadRepliesReadModel";
import type {
  ThreadReplyPreview,
} from "../src/store/threadRepliesReadModel";

function reply(seq: number, overrides: Partial<ThreadReplyPreview> = {}): ThreadReplyPreview {
  return {
    messageId: `m-${seq}`,
    seq,
    preview: `reply ${seq}`,
    senderId: "u-1",
    senderType: "user",
    senderName: "alice",
    senderAvatarUrl: null,
    createdAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

// ── GATE 1: top-N by seq, never a naive unshift ─────────────────────────────

test("a late frame lands in seq order, it does NOT jump to the newest slot", () => {
  // Snapshot holds 5,6,7. A delayed frame for seq 4 arrives afterwards.
  // A naive unshift would show reply 4 as the newest — the preview would claim
  // the last thing said was an old message. It must simply be too old to show.
  const scope = hydrateThreadRepliesScope([reply(5), reply(6), reply(7)], 7);

  const afterLate = applyThreadReplyFrame(scope, reply(4), 7);

  assert.deepEqual(
    afterLate.replies.map((r) => r.seq), [5, 6, 7],
    "a frame older than the whole window must not enter it, let alone lead it",
  );
  assert.equal(afterLate, scope, "an unchanged scope must keep its reference (render isolation)");
});

test("an in-order frame advances the window and evicts the oldest", () => {
  const scope = hydrateThreadRepliesScope([reply(5), reply(6), reply(7)], 7);

  const next = applyThreadReplyFrame(scope, reply(8), 8);

  assert.deepEqual(next.replies.map((r) => r.seq), [6, 7, 8], "newest N, oldest evicted");
  assert.equal(next.replies.length, INLINE_REPLY_CAP);
  assert.equal(next.replyCount, 8, "the count advances with the reply");
  assert.equal(next.snapshotSeq, 7, "the snapshot seam does NOT move when a live frame lands");
});

test("out-of-order arrival converges to the same window as in-order arrival", () => {
  // The permutation property: replies 8,9,10 arriving in ANY order must leave the
  // same window. If insertion were positional (unshift), arrival order would decide
  // the display and these two would differ.
  const base = hydrateThreadRepliesScope([reply(5)], 5);

  const inOrder = [reply(8), reply(9), reply(10)]
    .reduce((s, r, i) => applyThreadReplyFrame(s, r, 6 + i), base);
  const shuffled = [reply(9), reply(8), reply(10)]
    .reduce((s, r, i) => applyThreadReplyFrame(s, r, 6 + i), base);

  assert.deepEqual(
    shuffled.replies.map((r) => r.seq),
    inOrder.replies.map((r) => r.seq),
    "display order must be a function of seq, not of arrival",
  );
});

// ── GATE 2: snapshot watermark (reconnect replay must not duplicate) ────────

test("a reconnect replaying the snapshot's own frames changes nothing", () => {
  // THE case this gate exists for: on reconnect the server replays a window of
  // history. Without the watermark, every reply already in the snapshot gets
  // patched in again — duplicating the preview and inflating replyCount.
  const scope = hydrateThreadRepliesScope([reply(5), reply(6), reply(7)], 7);

  const replayed = [reply(5), reply(6), reply(7)].reduce((s, r) => applyThreadReplyFrame(s, r, 7), scope);

  assert.deepEqual(replayed.replies.map((r) => r.seq), [5, 6, 7], "no duplicates");
  assert.equal(replayed.replyCount, 7, "the count must NOT inflate on a replay");
  assert.equal(replayed, scope, "and the scope must not even churn its reference");
});

test("the watermark does not block genuinely new replies after a replay", () => {
  const scope = hydrateThreadRepliesScope([reply(5), reply(6), reply(7)], 7);
  const afterReplay = [reply(6), reply(7)].reduce((s, r) => applyThreadReplyFrame(s, r, 7), scope);

  const live = applyThreadReplyFrame(afterReplay, reply(8), 8);

  assert.deepEqual(live.replies.map((r) => r.seq), [6, 7, 8], "a real new reply still lands");
  assert.equal(live.replyCount, 8);
});

test("a duplicate message id is dropped even if its seq advanced", () => {
  const scope = hydrateThreadRepliesScope([reply(7)], 7);

  const dup = applyThreadReplyFrame(scope, reply(8, { messageId: "m-7" }), 7);

  assert.equal(dup.replies.length, 1, "the same message must not appear twice");
  assert.equal(dup.replyCount, 7, "nor double-count");
  assert.equal(dup, scope);
});

// ── hydrate ────────────────────────────────────────────────────────────────

test("hydrate caps the window and sets the watermark to the newest seq", () => {
  const scope = hydrateThreadRepliesScope([reply(1), reply(2), reply(3), reply(4)], 4);

  assert.deepEqual(scope.replies.map((r) => r.seq), [2, 3, 4], "keeps the newest N");
  assert.equal(scope.snapshotSeq, 4, "seam = newest seq in the snapshot");
});

test("system history is excluded without consuming preview capacity or weakening the snapshot seam", () => {
  const scope = hydrateThreadRepliesScope([
    reply(2),
    reply(3),
    reply(4),
    reply(5, { senderType: "system", senderName: "System", senderId: "system" }),
  ], 4);

  assert.deepEqual(scope.replies.map((r) => r.seq), [2, 3, 4], "the three newest conversation replies remain visible");
  assert.equal(scope.replyCount, 4, "system history remains part of the truthful total");
  assert.equal(scope.snapshotSeq, 5, "the filtered system frame is still covered by the snapshot replay seam");
});

test("a live system frame advances only the truthful count and never evicts a conversation reply", () => {
  const scope = hydrateThreadRepliesScope([reply(2), reply(3), reply(4)], 3);

  const next = applyThreadReplyFrame(
    scope,
    reply(5, { senderType: "system", senderName: "System", senderId: "system" }),
    4,
  );

  assert.deepEqual(next.replies.map((r) => r.seq), [2, 3, 4]);
  assert.equal(next.replyCount, 4);
  assert.equal(next.snapshotSeq, scope.snapshotSeq, "live frames never move the fixed snapshot seam");
});

test("an empty scope ingests its first reply, and the seam stays at zero", () => {
  const first = applyThreadReplyFrame(emptyThreadRepliesScope(), reply(1), 1);

  assert.deepEqual(first.replies.map((r) => r.seq), [1]);
  assert.equal(first.replyCount, 1);
  assert.equal(
    first.snapshotSeq, 0,
    "no snapshot was ever loaded, so the seam is 0 — and a live frame must never move it",
  );
});

test("a reply BELOW the seam is ignored even when the window has room", () => {
  // Guards the seam against a plausible-looking 'optimisation': only applying it
  // when the window is full. A reply already counted by the snapshot must stay
  // out regardless of how much room the display has.
  const scope = hydrateThreadRepliesScope([reply(9)], 9);

  const stale = applyThreadReplyFrame(scope, reply(3), 9);

  assert.deepEqual(stale.replies.map((r) => r.seq), [9], "an already-counted reply must not be re-added");
  assert.equal(stale.replyCount, 9, "nor inflate the count");
  assert.equal(stale, scope);
});
