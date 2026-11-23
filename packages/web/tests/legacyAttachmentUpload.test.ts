import assert from "node:assert/strict";
import { vi } from "vitest";

import { AttachmentUploadClientError, AttachmentUploadTimeoutError } from "../src/utils/directAttachmentUpload";
import {
  LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
  LEGACY_ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
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

test("legacy upload swaps the transfer-stall deadline for the response deadline after every byte is sent", async () => {
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
  assert.equal(scheduler.deadlines.length, 3, "the wait for the answer is bounded too");
  assert.equal(scheduler.deadlines[2]?.timeoutMs, LEGACY_ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS);
  markProgress();
  assert.equal(scheduler.deadlines.length, 3, "late progress cannot re-arm a completed transfer");

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

// #triage:#545: the response to a fully sent upload used to be awaited
// forever (a network switch or a backgrounded tab loses it), leaving the
// attachment at ~99%.
test("an upload whose answer never comes after the last byte ends in a retryable stall and is aborted", async () => {
  vi.useFakeTimers();
  try {
    let requestSignal: AbortSignal | undefined;
    let rejected = false;
    const result = uploadLegacyAttachmentWithIdleTimeout({
      upload: async (context) => {
        requestSignal = context.signal;
        context.markProgress();
        context.markTransferComplete();
        // Never settles, even once aborted: the deadline must not depend on it.
        return await new Promise<string>(() => undefined);
      },
    });
    const settled = assert.rejects(
      result,
      (error: unknown) => error instanceof AttachmentUploadTimeoutError
        && error.code === "UPLOAD_STALLED"
        && error.phase === "response"
        && error.retryable,
    ).then(() => { rejected = true; });

    await vi.advanceTimersByTimeAsync(LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
    assert.equal(rejected, false, "server-side saving is not a stalled transfer");
    await vi.advanceTimersByTimeAsync(LEGACY_ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS - LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS);
    await settled;
    assert.equal(requestSignal?.aborted, true, "the request is aborted so a late answer cannot land");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("a success arriving after the response deadline is not used", async () => {
  const scheduler = fakeDeadlineScheduler();
  let finishUpload: (value: string) => void = () => undefined;
  const result = uploadLegacyAttachmentWithIdleTimeout({
    scheduleDeadline: scheduler.scheduleDeadline,
    upload: async (context) => {
      context.markTransferComplete();
      return await new Promise<string>((resolve) => {
        finishUpload = resolve;
      });
    },
  });

  scheduler.deadlines.at(-1)!.onTimeout();
  finishUpload("late-attachment");
  await assert.rejects(
    result,
    (error: unknown) => error instanceof AttachmentUploadTimeoutError && error.phase === "response",
  );
});
