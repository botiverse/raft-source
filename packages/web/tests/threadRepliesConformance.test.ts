/**
 * Task #47 — CROSS-PLATFORM CONFORMANCE (@赵梓淇's equal-verdict gate, #731 discipline).
 *
 * Web runs the SAME vector file KMP runs:
 *   packages/shared/src/testVectors/threadRepliesReadModel.vectors.json
 *
 * The point is not that web passes. It is that web and KMP produce BYTE-IDENTICAL
 * snapshots from identical input. Two hand-written suites would drift; one shared
 * vector file cannot. A divergence here is a contract violation, not a platform
 * quirk — which is exactly the failure mode a "both sides implemented the spec"
 * agreement cannot catch on its own.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import vectors from "@botiverse/raft-shared/src/testVectors/threadRepliesReadModel.vectors.json" with { type: "json" };
import {
  applyThreadReplyFrame,
  hydrateThreadRepliesScope,
} from "../src/store/threadRepliesReadModel";
import type {
  ThreadReplyPreview,
  ThreadRepliesScope,
} from "../src/store/threadRepliesReadModel";

type FrameSpec = { seq: number; replyCount: number; messageId?: string };

interface VectorCase {
  name: string;
  why?: string;
  snapshot: { replies: number[]; replyCount: number };
  frames: FrameSpec[];
  expect: {
    replies: number[];
    replyCount: number;
    snapshotSeq: number;
    unchanged: boolean;
    lastFrameUnchanged?: boolean;
  };
}

/** Deterministic reply from a seq — both platforms must build it identically. */
function reply(spec: FrameSpec | number): ThreadReplyPreview {
  const seq = typeof spec === "number" ? spec : spec.seq;
  const messageId = typeof spec === "number" ? `m-${seq}` : (spec.messageId ?? `m-${seq}`);
  return {
    messageId,
    seq,
    preview: `reply ${seq}`,
    senderId: "u-1",
    senderType: "user",
    senderName: "alice",
    senderAvatarUrl: null,
    createdAt: "2026-07-12T00:00:00Z",
  };
}

for (const testCase of vectors.cases as unknown as VectorCase[]) {
  test(`conformance: ${testCase.name}`, () => {
    const initial: ThreadRepliesScope = hydrateThreadRepliesScope(
      testCase.snapshot.replies.map(reply),
      testCase.snapshot.replyCount,
    );

    let beforeLast: ThreadRepliesScope = initial;
    const final = testCase.frames.reduce<ThreadRepliesScope>((scope, frame, i) => {
      if (i === testCase.frames.length - 1) beforeLast = scope;
      return applyThreadReplyFrame(scope, reply(frame), frame.replyCount);
    }, initial);

    assert.deepEqual(
      final.replies.map((r) => r.seq),
      testCase.expect.replies,
      testCase.why ?? "window must match the shared vector",
    );
    assert.equal(final.replyCount, testCase.expect.replyCount, "replyCount must match the shared vector");
    assert.equal(final.snapshotSeq, testCase.expect.snapshotSeq, "snapshot seam must match the shared vector");

    if (testCase.expect.lastFrameUnchanged) {
      // @Android-Developer-2's eviction case: the LAST frame (a replay of an evicted
      // reply) must change nothing — same window, same count, SAME reference. A model
      // that derives the count double-counts here and returns a fresh object.
      assert.equal(
        final, beforeLast,
        "a replayed frame for an EVICTED reply must be a no-op — window-scoped identity "
        + "no longer sees it, so a derived count would double-count it",
      );
    }

    if (testCase.expect.unchanged) {
      // Reference identity is part of the contract, not an implementation detail:
      // "no change => do not push" is what keeps a reply in one thread from
      // re-rendering every other message (#4434 class).
      assert.equal(final, initial, "an unchanged window must not churn its reference");
    }
  });
}

test("the vector file caps the window at the contracted N", () => {
  assert.equal(vectors.cap, 3, "the shared cap must match what both platforms implement");
});
