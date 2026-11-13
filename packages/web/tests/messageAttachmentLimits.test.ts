import assert from "node:assert/strict";
import {
  applyMessageAttachmentLimits,
  decideMessageAttachmentSelection,
  MAX_MESSAGE_ATTACHMENTS,
} from "../src/utils/messageAttachmentLimits";

// These helpers no longer carry a client-side default ceiling — the server owns
// it. Tests therefore state the ceiling explicitly, exactly as the composer now
// must. `SERVED_LIMIT_BYTES` stands in for "whatever the server said"; nothing
// here may re-derive it from a plan.
const SERVED_LIMIT_BYTES = 50 * 1024 * 1024;

function file(size: number) {
  return { size };
}

test("accepts files until the message attachment cap", () => {
  const files = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 2 }, () => file(1024));
  const result = applyMessageAttachmentLimits(0, files, SERVED_LIMIT_BYTES);

  assert.equal(result.accepted.length, MAX_MESSAGE_ATTACHMENTS);
  assert.equal(result.rejectedForCount.length, 2);
  assert.equal(result.rejectedForEmpty.length, 0);
  assert.equal(result.rejectedForSize.length, 0);
});

test("honors existing pending attachments before accepting new files", () => {
  const result = applyMessageAttachmentLimits(MAX_MESSAGE_ATTACHMENTS - 1, [file(1024), file(1024), file(1024)], SERVED_LIMIT_BYTES);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejectedForCount.length, 2);
});

test("rejects empty and oversized files without consuming attachment slots", () => {
  const result = applyMessageAttachmentLimits(4, [
    file(0),
    file(SERVED_LIMIT_BYTES + 1),
    file(1024),
  ], SERVED_LIMIT_BYTES);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejectedForEmpty.length, 1);
  assert.equal(result.rejectedForSize.length, 1);
  assert.equal(result.rejectedForCount.length, 0);
});

const limits = (maxBytes: number, remainingBytes: number | null = null) => ({
  maxBytes,
  monthlyUpload: remainingBytes === null ? null : { month: "2026-10", limitBytes: 100 * 1024 * 1024, remainingBytes },
});
const MIB = 1024 * 1024;

test("the decision follows an arbitrary served ceiling", () => {
  // Deliberately a third number — neither the Free nor the Pro plan limit. Any
  // implementation that re-derives the ceiling from a plan fails here, which is
  // the whole point of this test.
  const servedBytes = 137 * MIB;
  const justOver = file(servedBytes + 1);
  const justUnder = file(servedBytes);

  const decision = decideMessageAttachmentSelection(0, [justOver, justUnder], limits(servedBytes));
  assert.deepEqual(decision.accepted, [justUnder]);
  assert.deepEqual(decision.rejection, { rejected: [{ file: justOver, reason: "size" }], limits: limits(servedBytes) });
});

test("a lower served ceiling moves the decision", () => {
  // Same file, a different served number: the boundary must track the server,
  // not a constant baked into the client.
  const candidate = file(20 * MIB);
  assert.deepEqual(decideMessageAttachmentSelection(0, [candidate], limits(137 * MIB)).accepted, [candidate]);
  assert.deepEqual(decideMessageAttachmentSelection(0, [candidate], limits(12 * MIB)).rejection?.rejected, [{ file: candidate, reason: "size" }]);
});

test("an unknown ceiling refuses the batch as unchecked, not as oversized", () => {
  // The composer's fail-safe. If this ever starts accepting files, the client
  // has reacquired a local ceiling from somewhere — which is the defect this
  // change exists to remove. 1 byte is under every plan limit that has ever
  // existed, so the reason is what tells "we do not know the limit" from "your
  // file is too big", and only the former is honest here.
  const tiny = file(1);
  const decision = decideMessageAttachmentSelection(0, [tiny], null);

  assert.deepEqual(decision.accepted, []);
  assert.deepEqual(decision.rejection, { rejected: [{ file: tiny, reason: "unchecked" }], limits: null });
});

test("a clean batch under a known ceiling rejects nothing", () => {
  const decision = decideMessageAttachmentSelection(0, [file(1024)], limits(137 * MIB));

  assert.equal(decision.accepted.length, 1);
  assert.equal(decision.rejection, null);
});

test("every file that isn't attached is named with its reason, in the order picked", () => {
  const empty = file(0);
  const big = file(SERVED_LIMIT_BYTES + 1);
  const ok = Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, () => file(1024));
  const extra = file(1024);
  const decision = decideMessageAttachmentSelection(0, [empty, big, ...ok, extra], limits(SERVED_LIMIT_BYTES));

  assert.deepEqual(decision.accepted, ok);
  assert.deepEqual(decision.rejection?.rejected, [
    { file: empty, reason: "empty" },
    { file: big, reason: "size" },
    { file: extra, reason: "count" },
  ]);
});

test("files beyond what's left of the month are refused for the quota, the rest attach", () => {
  // 5 MB left: 3 MB fits, then 4 MB doesn't (2 MB are left), then 2 MB does.
  const three = file(3 * MIB);
  const four = file(4 * MIB);
  const two = file(2 * MIB);
  const decision = decideMessageAttachmentSelection(0, [three, four, two], limits(SERVED_LIMIT_BYTES, 5 * MIB));

  assert.deepEqual(decision.accepted, [three, two]);
  assert.deepEqual(decision.rejection?.rejected, [{ file: four, reason: "quota" }]);
});

test("a file refused for the quota doesn't use an attachment slot", () => {
  const files = [file(10 * MIB), ...Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, () => file(1024))];
  const decision = decideMessageAttachmentSelection(0, files, limits(SERVED_LIMIT_BYTES, MIB));

  assert.equal(decision.accepted.length, MAX_MESSAGE_ATTACHMENTS);
  assert.deepEqual(decision.rejection?.rejected.map(({ reason }) => reason), ["quota"]);
});

test("no monthly quota (Pro) refuses nothing for it", () => {
  const decision = decideMessageAttachmentSelection(0, [file(40 * MIB), file(40 * MIB)], limits(SERVED_LIMIT_BYTES));
  assert.equal(decision.rejection, null);
});
