import assert from "node:assert/strict";
import test from "node:test";

import { uploadAttachmentFile } from "../src/utils/directAttachmentUpload";
import type { AttachmentUploadApi } from "../src/utils/directAttachmentUpload";
import { __setUploadFallbackEmitterForTest } from "../src/utils/attachmentUploadFallbackTrace";

/**
 * Task #187 — the capability probe must fail SAFE.
 *
 * Before this, only a 404 fell back to the legacy path; every other failure threw
 * `UPLOAD_CAPABILITY_FAILED` and killed the upload. That is the 2026-08-02
 * production shape: the capability route 500'd and nobody could upload, while a
 * working legacy path sat behind an `=== 404` check.
 *
 * Scope, per @Huarong / @Eric: PRE-SESSION only. Nothing here touches the object
 * PUT (or ALPN), which happens after a session exists and keeps PR #5884's
 * no-blind-fallback contract — falling back there could duplicate an object that
 * was already written.
 */

function fileOf(size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type: "application/octet-stream" });
  return Object.assign(blob, { name: "payload.bin", lastModified: 0 }) as File;
}

function responseError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
}

/** An API whose capability probe fails in a given way; nothing else is reachable. */
function apiFailingCapabilityWith(error: unknown) {
  const calls: string[] = [];
  const api: AttachmentUploadApi = {
    async get(url) { calls.push(`GET ${url}`); throw error; },
    async post(url) { calls.push(`POST ${url}`); throw new Error("must not be reached"); },
    async delete(url) { calls.push(`DELETE ${url}`); return { data: {} as never }; },
  };
  return { api, calls };
}

function apiWithCapabilities(capabilities: unknown) {
  const calls: string[] = [];
  const api: AttachmentUploadApi = {
    async get(url) { calls.push(`GET ${url}`); return { data: capabilities as never }; },
    async post(url) { calls.push(`POST ${url}`); throw new Error("must not be reached"); },
    async delete(url) { calls.push(`DELETE ${url}`); return { data: {} as never }; },
  };
  return { api, calls };
}

type Emitted = Readonly<{ name: string; attrs: Record<string, unknown> }>;

function captureTelemetry(): { emitted: Emitted[]; restore: () => void } {
  const emitted: Emitted[] = [];
  __setUploadFallbackEmitterForTest((name, attrs) => { emitted.push({ name, attrs }); });
  return { emitted, restore: () => __setUploadFallbackEmitterForTest(null) };
}

async function runWith(api: AttachmentUploadApi, signal?: AbortSignal) {
  return uploadAttachmentFile({
    api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "req-1",
    legacyUpload: async () => "legacy-attachment-id",
    signal,
  });
}

/* ---------- the three anomalies that used to kill the upload ---------- */

for (const [label, error, expectedReason, expectedStatus] of [
  ["a 500 from the capability route", responseError(500), "capability_server_error", 500],
  ["a 503 from the capability route", responseError(503), "capability_server_error", 503],
  ["a network failure with no response at all", Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", name: "AxiosError" }), "capability_network", null],
  ["a timeout with no response at all", Object.assign(new Error("timeout of 0ms exceeded"), { code: "ECONNABORTED", name: "AxiosError" }), "capability_timeout", null],
  ["an unrecognisable failure with no response", new Error("something odd"), "capability_unreachable", null],
  ["a 403 from the capability route", responseError(403), "capability_client_error", 403],
  ["a 404 — the only case that already worked", responseError(404), "capability_not_found", 404],
] as const) {
  test(`falls back to the legacy upload on ${label}`, async () => {
    const t = captureTelemetry();
    try {
      const { api, calls } = apiFailingCapabilityWith(error);
      const id = await runWith(api);

      assert.equal(id, "legacy-attachment-id", "the upload must still succeed via the legacy path");
      assert.deepEqual(calls, ["GET /attachments/upload-capabilities"],
        "no session may be created once the probe failed");
      assert.deepEqual(t.emitted.map((e) => e.name), ["slock.attachment.upload_capability_fallback"]);
      assert.equal(t.emitted[0]!.attrs.reason, expectedReason);
      assert.equal(t.emitted[0]!.attrs.http_status, expectedStatus);
    } finally { t.restore(); }
  });
}

/* ---------- the exception: a cancel is not an anomaly ---------- */

test("an aborted probe rethrows and does NOT quietly run a legacy upload", async () => {
  const t = captureTelemetry();
  try {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("canceled"), { name: "AbortError" });
    const { api } = apiFailingCapabilityWith(abortError);

    await assert.rejects(
      () => runWith(api, controller.signal),
      (e: Error) => e.name === "AbortError",
      "the user cancelled — uploading anyway is the opposite of what they asked for",
    );
    assert.deepEqual(t.emitted, [], "a cancel is not a fallback and must not be reported as one");
  } finally { t.restore(); }
});

test("axios-style ERR_CANCELED is also treated as a cancel, not an anomaly", async () => {
  const t = captureTelemetry();
  try {
    const canceled = Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" });
    const { api } = apiFailingCapabilityWith(canceled);
    await assert.rejects(() => runWith(api), (e: Error) => e.name === "CanceledError");
    assert.deepEqual(t.emitted, []);
  } finally { t.restore(); }
});

/* ---------- healthy fallbacks still report, so anomalies have a denominator ---------- */

test("a disabled server reports not_enabled rather than staying silent", async () => {
  const t = captureTelemetry();
  try {
    const { api } = apiWithCapabilities({
      directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: 20, sessionExpiresInSeconds: 900,
    });
    assert.equal(await runWith(api), "legacy-attachment-id");
    assert.equal(t.emitted[0]!.attrs.reason, "not_enabled");
    assert.equal(t.emitted[0]!.attrs.http_status, null);
  } finally { t.restore(); }
});

test("a file under the direct-upload threshold reports below_threshold", async () => {
  const t = captureTelemetry();
  try {
    const { api } = apiWithCapabilities({
      directUploadEnabled: true, directUploadThresholdBytes: 1024, maxBytes: 4096, sessionExpiresInSeconds: 900,
    });
    assert.equal(await runWith(api), "legacy-attachment-id");
    assert.equal(t.emitted[0]!.attrs.reason, "below_threshold");
  } finally { t.restore(); }
});

/* ---------- the fail-safe must not be defeatable by its own telemetry ---------- */

test("a throwing telemetry emitter cannot break the upload", async () => {
  __setUploadFallbackEmitterForTest(() => { throw new Error("pipeline exploded"); });
  try {
    const { api } = apiFailingCapabilityWith(responseError(500));
    assert.equal(await runWith(api), "legacy-attachment-id",
      "observability must never be able to take down the path it observes");
  } finally { __setUploadFallbackEmitterForTest(null); }
});

/* ---------- limits still apply before any fallback decision ---------- */

test("an oversized file is still rejected, not silently sent down the legacy path", async () => {
  const t = captureTelemetry();
  try {
    const { api } = apiWithCapabilities({
      directUploadEnabled: true, directUploadThresholdBytes: 4, maxBytes: 4, sessionExpiresInSeconds: 900,
    });
    await assert.rejects(() => runWith(api), (e: Error & { code?: string }) => e.code === "UPLOAD_TOO_LARGE");
    assert.deepEqual(t.emitted, [], "a plan-limit rejection is not a fallback");
  } finally { t.restore(); }
});


/* ---------- @tygg's requirement: the fail-safe must not swallow the error ---------- */

/**
 * A degrade that hides WHY it degraded is only half an improvement. My first
 * version carried `reason` + `http_status` only, which made a timeout and an
 * unreachable network identical (`capability_unreachable`, `http_status: null`)
 * — the exact swallowing @Eric gated on. These pin that every fallback stays
 * reconstructable from the trace alone.
 */
test("a timeout and a network failure are distinguishable, not both 'unreachable'", async () => {
  const seen: Array<Record<string, unknown>> = [];
  __setUploadFallbackEmitterForTest((_n, attrs) => { seen.push(attrs); });
  try {
    const timeout = Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED", name: "AxiosError" });
    await runWith(apiFailingCapabilityWith(timeout).api);
    const network = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", name: "AxiosError" });
    await runWith(apiFailingCapabilityWith(network).api);

    assert.equal(seen[0]!.reason, "capability_timeout");
    assert.equal(seen[0]!.error_code, "ECONNABORTED");
    assert.equal(seen[1]!.reason, "capability_network");
    assert.equal(seen[1]!.error_code, "ERR_NETWORK");
    assert.notEqual(seen[0]!.reason, seen[1]!.reason,
      "the two most different no-status causes must not share one value");
  } finally { __setUploadFallbackEmitterForTest(null); }
});

test("the error's own name and code ride along on every anomaly fallback", async () => {
  const seen: Array<Record<string, unknown>> = [];
  __setUploadFallbackEmitterForTest((_n, attrs) => { seen.push(attrs); });
  try {
    const err = Object.assign(new Error("boom"), { name: "AxiosError", code: "ERR_BAD_RESPONSE", response: { status: 502, data: {} } });
    await runWith(apiFailingCapabilityWith(err).api);
    assert.deepEqual(seen[0], {
      reason: "capability_server_error",
      http_status: 502,
      error_name: "AxiosError",
      error_code: "ERR_BAD_RESPONSE",
    });
  } finally { __setUploadFallbackEmitterForTest(null); }
});

test("the free-form error MESSAGE is never emitted", async () => {
  const seen: Array<Record<string, unknown>> = [];
  __setUploadFallbackEmitterForTest((_n, attrs) => { seen.push(attrs); });
  try {
    // A message that would leak a signed URL if it were ever included verbatim.
    const err = Object.assign(new Error("failed GET https://objects.example.test/signed?token=SECRET"), {
      code: "ERR_BAD_RESPONSE", response: { status: 500, data: {} },
    });
    await runWith(apiFailingCapabilityWith(err).api);
    const serialized = JSON.stringify(seen[0]);
    assert.equal(serialized.includes("SECRET"), false, "no free-form message may reach the trace");
    assert.equal(serialized.includes("signed"), false);
  } finally { __setUploadFallbackEmitterForTest(null); }
});
