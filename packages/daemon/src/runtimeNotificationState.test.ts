import assert from "node:assert/strict";
import { test } from "vitest";
import { computeInboxNoticeFingerprint, RuntimeNotificationState } from "./runtimeNotificationState.js";

test("runtime notification state tracks pending notification debt separately from scheduling", () => {
  const state = new RuntimeNotificationState();

  assert.equal(state.add(), 1);
  assert.equal(state.add(2), 3);
  assert.equal(state.pendingCount, 3);
  assert.equal(state.hasTimer, false);
});

test("runtime notification state schedules at most one timer", () => {
  const state = new RuntimeNotificationState();
  let calls = 0;

  assert.equal(state.schedule(() => calls++, 10_000), true);
  assert.equal(state.schedule(() => calls++, 10_000), false);
  assert.equal(state.hasTimer, true);

  state.clearTimer();
  assert.equal(state.hasTimer, false);
  assert.equal(calls, 0);
});

test("runtime notification state default scheduler fires through the runtime timer path", { timeout: 1000 }, async () => {
  const state = new RuntimeNotificationState();
  let calls = 0;
  let resolveFired!: () => void;
  const fired = new Promise<void>((resolve) => {
    resolveFired = resolve;
  });

  assert.equal(state.schedule(() => {
    calls++;
    resolveFired();
  }, 1), true);
  await fired;

  assert.equal(calls, 1);
  assert.equal(state.hasTimer, true);
  state.clearTimer();
  assert.equal(state.hasTimer, false);
});

test("runtime notification state takes pending count and clears timer for send attempt", () => {
  const state = new RuntimeNotificationState();
  state.add(4);
  state.schedule(() => {}, 10_000);

  assert.equal(state.takePendingAndClearTimer(), 4);
  assert.equal(state.pendingCount, 0);
  assert.equal(state.hasTimer, false);
});

test("runtime notification state can clear pending count and timer together", () => {
  const state = new RuntimeNotificationState();
  state.add(2);
  state.schedule(() => {}, 10_000);

  state.clear();

  assert.equal(state.pendingCount, 0);
  assert.equal(state.hasTimer, false);
});

// --- #58 notice-coalescing dedup-key ---

test("inbox notice fingerprint is set-based and order-independent (seq preferred)", () => {
  const a = computeInboxNoticeFingerprint([{ seq: 11 }, { seq: 9 }]);
  const b = computeInboxNoticeFingerprint([{ seq: 9 }, { seq: 11 }]);
  assert.equal(a, b, "same set in any order → same fingerprint");
  // Canonical form is a lexicographic sort of the identity keys — consistency
  // is all the dedup needs (not numeric order), so "s:11" sorts before "s:9".
  assert.equal(a, "s:11,s:9");
});

test("inbox notice fingerprint falls back to message_id / id when seq is absent", () => {
  assert.equal(computeInboxNoticeFingerprint([{ message_id: "m2" }, { message_id: "m1" }]), "m:m1,m:m2");
  assert.equal(computeInboxNoticeFingerprint([{ id: "x" }]), "m:x");
  // seq wins over id on the same message
  assert.equal(computeInboxNoticeFingerprint([{ seq: 5, message_id: "m9" }]), "s:5");
});

test("inbox notice fingerprint is empty when no message carries an identity", () => {
  assert.equal(computeInboxNoticeFingerprint([{}, { seq: 0 }, { message_id: "" }]), "");
});

// The load-bearing over-suppress discriminator: a count-based or
// (count,first,latest) key collides here; the set key must NOT.
test("inbox notice fingerprint distinguishes a changed set with an unchanged count", () => {
  const before = computeInboxNoticeFingerprint([{ seq: 100 }, { seq: 101 }]); // [A,B]
  const after = computeInboxNoticeFingerprint([{ seq: 101 }, { seq: 102 }]); // read A, new C → [B,C]
  assert.notEqual(before, after, "read-one + new-one keeps count=2 but the set changed → must differ");
});

test("notice dedup suppresses only an identical set already written in the same session", () => {
  const state = new RuntimeNotificationState();
  const fp = computeInboxNoticeFingerprint([{ seq: 1 }, { seq: 2 }]);

  // Nothing written yet → not a duplicate.
  assert.equal(state.isDuplicateNotice(fp, "sess-1"), false);

  state.recordNoticeWritten(fp, "sess-1");
  assert.equal(state.isDuplicateNotice(fp, "sess-1"), true, "same set + same session → duplicate");

  // A changed set is never suppressed.
  const fp2 = computeInboxNoticeFingerprint([{ seq: 2 }, { seq: 3 }]);
  assert.equal(state.isDuplicateNotice(fp2, "sess-1"), false);

  // Cross-session must never suppress (per-(agent,session) scope).
  assert.equal(state.isDuplicateNotice(fp, "sess-2"), false, "different session → not a duplicate");
});

test("notice contribution filters already-written pending messages in the same session", () => {
  const state = new RuntimeNotificationState();
  const first = { seq: 31, message_id: "first" };
  const second = { seq: 32, message_id: "second" };
  const anonymous = {};
  const fp = computeInboxNoticeFingerprint([first]);

  state.recordNoticeWritten(fp, "sess-1", [first]);

  assert.equal(state.hasContributedMessage(first, "sess-1"), true);
  assert.equal(state.hasContributedMessage(second, "sess-1"), false);
  assert.deepEqual(
    state.filterUncontributedMessages([first, second, anonymous], "sess-1"),
    [second, anonymous],
    "same-session contribution memo filters only identified messages that already contributed",
  );
  assert.deepEqual(
    state.filterUncontributedMessages([first, second], "sess-2"),
    [first, second],
    "cross-session contribution memo must not suppress a fresh session",
  );
});

test("notice contribution pruning lets a consumed row re-arrive with the same identity", () => {
  const state = new RuntimeNotificationState();
  const message = { seq: 41, message_id: "reappears" };
  const fp = computeInboxNoticeFingerprint([message]);

  state.recordNoticeWritten(fp, "sess-1", [message]);
  assert.deepEqual(state.filterUncontributedMessages([message], "sess-1"), []);

  state.pruneContributedToPending([], "sess-1");
  assert.deepEqual(
    state.filterUncontributedMessages([message], "sess-1"),
    [message],
    "once the pending row is gone, the write memo cannot hide a later re-arrival",
  );
});

test("notice dedup never suppresses an empty fingerprint (fail toward sending)", () => {
  const state = new RuntimeNotificationState();
  state.recordNoticeWritten("", "sess-1");
  assert.equal(state.isDuplicateNotice("", "sess-1"), false);
});

test("clear() resets the notice fingerprint so a fresh launch re-notifies", () => {
  const state = new RuntimeNotificationState();
  const fp = computeInboxNoticeFingerprint([{ seq: 7 }]);
  state.recordNoticeWritten(fp, "sess-1");
  assert.equal(state.isDuplicateNotice(fp, "sess-1"), true);

  state.clear();
  assert.equal(state.isDuplicateNotice(fp, "sess-1"), false, "post-clear → no stale suppression");
});

test("failed encode memo suppresses only identical failed attempts in the same session", () => {
  const state = new RuntimeNotificationState();
  const fp = computeInboxNoticeFingerprint([{ seq: 21 }]);

  assert.equal(state.isDuplicateEncodeFailedNotice(fp, "sess-1"), false);
  state.recordNoticeEncodeFailed(fp, "sess-1");
  assert.equal(state.isDuplicateEncodeFailedNotice(fp, "sess-1"), true);
  assert.equal(state.isDuplicateEncodeFailedNotice(fp, "sess-2"), false);
  assert.equal(state.isDuplicateEncodeFailedNotice(computeInboxNoticeFingerprint([{ seq: 22 }]), "sess-1"), false);

  state.recordNoticeWritten(fp, "sess-1");
  assert.equal(state.isDuplicateEncodeFailedNotice(fp, "sess-1"), false, "successful write clears failed-attempt memo");

  state.recordNoticeEncodeFailed(fp, "sess-1");
  state.clear();
  assert.equal(state.isDuplicateEncodeFailedNotice(fp, "sess-1"), false, "fresh launch must not inherit failed-attempt memo");
});
