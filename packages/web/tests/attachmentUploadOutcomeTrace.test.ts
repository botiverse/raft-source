import assert from "node:assert/strict";

import {
  __setUploadFinishedEmitterForTest,
  reportAttachmentUploadFinished,
} from "../src/utils/attachmentUploadOutcomeTrace";
import { AttachmentUploadClientError, AttachmentUploadTimeoutError } from "../src/utils/directAttachmentUpload";

type Emitted = Readonly<{ name: string; attrs: Record<string, unknown> }>;

function capture(): Emitted[] {
  const emitted: Emitted[] = [];
  __setUploadFinishedEmitterForTest((name, attrs) => { emitted.push({ name, attrs }); });
  return emitted;
}

afterEach(() => {
  __setUploadFinishedEmitterForTest(null);
});

const MB = 1024 * 1024;

test("a timed-out upload reports its route, the step that ran out of time and coarse size and time", () => {
  const emitted = capture();
  reportAttachmentUploadFinished({
    route: "legacy",
    sizeBytes: 3 * MB,
    durationMs: 125_400.6,
    error: new AttachmentUploadTimeoutError("response"),
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.name, "slock.attachment.upload_finished");
  const { client_scheme: clientScheme, ...attrs } = emitted[0]!.attrs;
  assert.deepEqual(attrs, {
    route: "legacy",
    outcome: "timeout",
    timeout_phase: "response",
    error_code: "UPLOAD_STALLED",
    size_bucket: "<10MB",
    elapsed_bucket: "1-5m",
    duration_ms: 125_401,
    resized: false,
    resize_outcome: null,
    resize_ratio_pct: null,
  });
  assert.ok(["app", "https", "http", "other"].includes(clientScheme as string));
});

test("success, failure and cancel are told apart, and a cancel is never a timeout", () => {
  const emitted = capture();
  reportAttachmentUploadFinished({ route: "direct", sizeBytes: 60 * MB, durationMs: 4_000 });
  reportAttachmentUploadFinished({
    route: "direct",
    sizeBytes: 60 * MB,
    durationMs: 4_000,
    error: new AttachmentUploadClientError("UPLOAD_OBJECT_PUT_FAILED", "Direct object upload failed with HTTP 403."),
  });
  reportAttachmentUploadFinished({
    route: null,
    sizeBytes: 1,
    durationMs: 10,
    error: new AttachmentUploadTimeoutError("channel"),
    cancelled: true,
  });
  reportAttachmentUploadFinished({ route: "legacy", sizeBytes: 1, durationMs: 10, error: new TypeError("Network Error") });

  assert.deepEqual(
    emitted.map(({ attrs }) => [attrs.route, attrs.outcome, attrs.timeout_phase, attrs.error_code]),
    [
      ["direct", "ok", null, null],
      ["direct", "error", null, "UPLOAD_OBJECT_PUT_FAILED"],
      ["unknown", "cancelled", null, null],
      ["legacy", "error", null, null],
    ],
  );
  assert.equal(emitted[0]!.attrs.size_bucket, "50-200MB");
});

test("a resized photo reports the outcome and the sent share of the original, never exact sizes", () => {
  const emitted = capture();
  const sent = new File([new Uint8Array(1_234)], "photo.jpg", { type: "image/jpeg" });
  reportAttachmentUploadFinished({
    route: "legacy",
    sizeBytes: sent.size,
    durationMs: 900,
    resize: { file: sent, outcome: "resized", originalBytes: 4_936 },
  });
  reportAttachmentUploadFinished({
    route: "legacy",
    sizeBytes: 4_936,
    durationMs: 900,
    resize: { file: sent, outcome: "not_smaller", originalBytes: 4_936 },
  });

  assert.deepEqual(
    emitted.map(({ attrs }) => [attrs.resized, attrs.resize_outcome, attrs.resize_ratio_pct]),
    [
      [true, "resized", 25],
      [false, "not_smaller", null],
    ],
  );
  assert.equal(Object.values(emitted[0]!.attrs).includes(4_936), false);
});

test("a failing emitter never breaks the upload", () => {
  __setUploadFinishedEmitterForTest(() => {
    throw new Error("pipeline down");
  });
  assert.doesNotThrow(() => reportAttachmentUploadFinished({ route: "legacy", sizeBytes: 1, durationMs: 1 }));
});
