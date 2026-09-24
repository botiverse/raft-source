import assert from "node:assert/strict";
import test from "node:test";

import { AttachmentUploadClientError } from "../src/utils/directAttachmentUpload";
import {
  LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
  uploadLegacyAttachmentWithIdleTimeout,
} from "../src/utils/legacyAttachmentUpload";

type ScheduledDeadline = {
  active: boolean;
  onTimeout: () => void;
  timeoutMs: number;
};

function fakeDeadlineScheduler() {
  const deadlines: ScheduledDeadline[] = [];
  return {
    deadlines,
    scheduleDeadline(onTimeout: () => void, timeoutMs: number) {
      const deadline = { active: true, onTimeout, timeoutMs };
      deadlines.push(deadline);
      return () => {
        deadline.active = false;
      };
    },
  };
}

function pendingUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Request aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("legacy upload progress renews the idle deadline and a true stall becomes retryable", async () => {
  const scheduler = fakeDeadlineScheduler();
  let markProgress = () => undefined;
  const result = uploadLegacyAttachmentWithIdleTimeout({
    scheduleDeadline: scheduler.scheduleDeadline,
    upload: async (context) => {
      markProgress = context.markProgress;
      return pendingUntilAbort(context.signal);
    },
  });

  assert.equal(scheduler.deadlines.length, 1);
  assert.equal(scheduler.deadlines[0]?.timeoutMs, LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
  markProgress();
  assert.equal(scheduler.deadlines[0]?.active, false, "progress cancels the stale deadline");
  assert.equal(scheduler.deadlines.length, 2, "progress starts a fresh idle window");

  scheduler.deadlines[1]!.onTimeout();
  await assert.rejects(
    result,
    (error: unknown) => error instanceof AttachmentUploadClientError
      && error.code === "UPLOAD_STALLED"
      && error.retryable,
  );
  assert.equal(scheduler.deadlines[1]?.active, false, "terminal cleanup cancels the live deadline");
});

test("legacy upload stops applying the transfer-stall deadline after every byte is sent", async () => {
  const scheduler = fakeDeadlineScheduler();
  let markProgress = () => undefined;
  let markTransferComplete = () => undefined;
  let finishUpload: (value: string) => void = () => undefined;
  const result = uploadLegacyAttachmentWithIdleTimeout({
    scheduleDeadline: scheduler.scheduleDeadline,
    upload: async (context) => {
      markProgress = context.markProgress;
      markTransferComplete = context.markTransferComplete;
      return await new Promise<string>((resolve) => {
        finishUpload = resolve;
      });
    },
  });

  markProgress();
  assert.equal(scheduler.deadlines.length, 2);
  assert.equal(scheduler.deadlines[1]?.active, true);

  markTransferComplete();
  assert.equal(
    scheduler.deadlines[1]?.active,
    false,
    "server-side saving must not be mislabeled as a stalled browser transfer",
  );
  markProgress();
  assert.equal(scheduler.deadlines.length, 2, "late progress cannot re-arm a completed transfer");

  finishUpload("attachment-after-slow-save");
  assert.equal(await result, "attachment-after-slow-save");
});

test("caller cancellation stays cancellation instead of being misreported as a stall", async () => {
  const scheduler = fakeDeadlineScheduler();
  const caller = new AbortController();
  const result = uploadLegacyAttachmentWithIdleTimeout({
    signal: caller.signal,
    scheduleDeadline: scheduler.scheduleDeadline,
    upload: ({ signal }) => pendingUntilAbort(signal),
  });

  caller.abort(new DOMException("Composer closed", "AbortError"));
  await assert.rejects(
    result,
    (error: unknown) => error instanceof DOMException
      && error.name === "AbortError"
      && !(error instanceof AttachmentUploadClientError),
  );
  assert.equal(scheduler.deadlines[0]?.active, false);
});
