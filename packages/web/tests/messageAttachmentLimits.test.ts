import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
const fmt = createIntl({ locale: DEFAULT_LOCALE, messages: mergedMessages(DEFAULT_LOCALE) }).formatMessage;
import {
  applyMessageAttachmentLimits,
  decideMessageAttachmentSelection,
  formatMessageAttachmentLimitError,
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

test("formats all skipped-file reasons together", () => {
  const error = formatMessageAttachmentLimitError({
    rejectedForCount: [file(1024), file(1024)],
    rejectedForEmpty: [file(0)],
    rejectedForSize: [file(51 * 1024 * 1024)],
  }, fmt, SERVED_LIMIT_BYTES);

  assert.equal(
    error,
    "Only 10 attachments per message. 2 extra files skipped. 1 empty file skipped. Max 50MB per file. Current largest file is 51.0MB.",
  );
});

test("validation and copy both follow an arbitrary served ceiling", () => {
  // Deliberately a third number — neither the Free nor the Pro plan limit. Any
  // implementation that re-derives the ceiling from a plan fails here, which is
  // the whole point of this test.
  const servedBytes = 137 * 1024 * 1024;
  const justOver = file(servedBytes + 1);
  const justUnder = file(servedBytes);

  const result = applyMessageAttachmentLimits(0, [justOver, justUnder], servedBytes);
  assert.deepEqual(result.accepted, [justUnder]);
  assert.deepEqual(result.rejectedForSize, [justOver]);

  assert.equal(
    formatMessageAttachmentLimitError(result, fmt, servedBytes),
    "Max 137MB per file. Current largest file is 137.0MB.",
  );
});

test("a lower served ceiling moves both the decision and the copy", () => {
  // Same files, a different served number: the boundary must track the server,
  // not a constant baked into the client.
  const servedBytes = 12 * 1024 * 1024;
  const candidate = file(20 * 1024 * 1024);

  const result = applyMessageAttachmentLimits(0, [candidate], servedBytes);
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejectedForSize, [candidate]);

  assert.equal(
    formatMessageAttachmentLimitError(result, fmt, servedBytes),
    "Max 12MB per file. Current largest file is 20.0MB.",
  );
});

test("an unknown ceiling refuses the batch instead of guessing one", () => {
  // The composer's fail-safe. If this ever starts accepting files, the client
  // has reacquired a local ceiling from somewhere — which is the defect this
  // change exists to remove.
  const decision = decideMessageAttachmentSelection(0, [file(1024)], null, fmt);

  assert.deepEqual(decision.accepted, []);
  assert.equal(decision.error, "The upload size limit could not be checked. Try again in a moment.");
});

test("an unknown ceiling refuses as unknown, not as oversized", () => {
  // 1 byte is under every plan limit that has ever existed, so an empty
  // `accepted` alone proves nothing — a missing fail-safe would also reject it
  // by comparing against a zero-ish ceiling. The message is what distinguishes
  // "we do not know the limit" from "your file is too big", and only the former
  // is honest here.
  const decision = decideMessageAttachmentSelection(0, [file(1)], null, fmt);

  assert.deepEqual(decision.accepted, []);
  assert.equal(decision.error, "The upload size limit could not be checked. Try again in a moment.");
  assert.ok(!decision.error.includes("per file"), "must not render a size-limit message for an unknown ceiling");
});

test("a known ceiling drives both the accepted set and the copy", () => {
  const servedBytes = 137 * 1024 * 1024;
  const justUnder = file(servedBytes);
  const justOver = file(servedBytes + 1);

  const decision = decideMessageAttachmentSelection(0, [justUnder, justOver], servedBytes, fmt);

  assert.deepEqual(decision.accepted, [justUnder]);
  assert.equal(decision.error, "Max 137MB per file. Current largest file is 137.0MB.");
});

test("a clean batch under a known ceiling reports no error", () => {
  const decision = decideMessageAttachmentSelection(0, [file(1024)], 137 * 1024 * 1024, fmt);

  assert.equal(decision.accepted.length, 1);
  assert.equal(decision.error, "");
});
