import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { DaemonTraceBundleUploader } from "./traceBundleUpload.js";
import { computeTraceJitter, NO_JITTER } from "@botiverse/raft-trace-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

// The mock-timer tests use fire-and-forget `void this.uploadOnce()` chains, so
// keep this suite explicitly sequential if Vitest's defaults change later.
describe.sequential("DaemonTraceBundleUploader", () => {
  let originalMinFileAgeMs: string | undefined;
  let originalUploadIntervalMs: string | undefined;

  beforeEach(() => {
    originalMinFileAgeMs = process.env.SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS;
    originalUploadIntervalMs = process.env.SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS;
    delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS;
    delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS;
  });

  afterEach(() => {
    if (originalMinFileAgeMs === undefined) {
      delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS;
    } else {
      process.env.SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS = originalMinFileAgeMs;
    }
    if (originalUploadIntervalMs === undefined) {
      delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS;
    } else {
      process.env.SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS = originalUploadIntervalMs;
    }
  });

test("uploads closed trace files with server-signed metadata", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-upload-test-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    const closedFile = path.join(traceDir, "daemon-trace-2026-05-08T00-00-00-000Z-1000-0000.jsonl");
    const currentFile = path.join(traceDir, "daemon-trace-2026-05-08T00-05-00-000Z-1000-0001.jsonl");
    await writeFile(closedFile, "{\"type\":\"span\",\"schema_version\":1,\"trace_id\":\"t\",\"span_id\":\"s\"}\n");
    await writeFile(currentFile, "{\"type\":\"span\",\"schema_version\":1,\"trace_id\":\"current\",\"span_id\":\"s\"}\n");
    const oldTraceTime = new Date("2026-05-08T00:00:00.000Z");
    await utimes(closedFile, oldTraceTime, oldTraceTime);
    await utimes(currentFile, oldTraceTime, oldTraceTime);

    const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
    const uploadedBodies: Buffer[] = [];

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      currentFileProvider: () => currentFile,
      fetchImpl: async (url, init) => {
        let body: unknown = null;
        if (typeof init?.body === "string") {
          body = JSON.parse(init.body);
        } else if (init?.body instanceof Blob) {
          const buffer = Buffer.from(await init.body.arrayBuffer());
          uploadedBodies.push(buffer);
          body = init.body;
        }
        calls.push({ url, init, body });

        if (url === "https://server.test/internal/machine/scope-attestation") {
          const requestBody = body as { metadata: { bundleId: string; bundleSha256: string; bundleSizeBytes: number } };
          assert.equal(requestBody.metadata.bundleSha256.length, 64);
          assert.equal(requestBody.metadata.bundleSizeBytes > 0, true);
          return jsonResponse({
            attestation: "signed-trace-token",
            scope: "daemon-trace-bundle:create",
            audience: "trace-ingest-worker",
            resource: "servers/server-1/machines/machine-1/trace-bundles",
            metadata: {
              uploadId: "upload-1",
              objectKey: "trace-bundles/server-1/machine-1/upload-1.jsonl.gz",
              bundleId: requestBody.metadata.bundleId,
              bundleSha256: requestBody.metadata.bundleSha256,
              bundleSizeBytes: requestBody.metadata.bundleSizeBytes,
              maxBytes: 50 * 1024 * 1024,
            },
            expiresAt: "2026-05-08T00:00:00.000Z",
          });
        }

        if (url === "https://worker.test/api/trace-bundles") {
          return jsonResponse({
            upload: {
              method: "PUT",
              url: "https://storage.test/upload-1",
              headers: { "Content-Type": "application/x-ndjson" },
            },
          });
        }

        if (url === "https://storage.test/upload-1") {
          return new Response(null, { status: 200 });
        }

        return jsonResponse({ error: `unexpected ${url}` }, 500);
      },
    });

    assert.deepEqual(await uploader.uploadOnce(), { attempted: 1, uploaded: 1 });
    assert.deepEqual(await uploader.uploadOnce(), { attempted: 0, uploaded: 0 });

    assert.deepEqual(calls.map((call) => call.url), [
      "https://server.test/internal/machine/scope-attestation",
      "https://worker.test/api/trace-bundles",
      "https://storage.test/upload-1",
    ]);

    const attestationBody = calls[0].body as {
      scope: string;
      metadata: { bundleId: string; bundleSha256: string; bundleSizeBytes: number };
    };
    assert.equal(attestationBody.scope, "daemon-trace-bundle:create");
    assert.equal(attestationBody.metadata.bundleSha256, sha256Hex(uploadedBodies[0]));
    assert.equal(attestationBody.metadata.bundleSizeBytes, uploadedBodies[0].byteLength);

    assert.deepEqual(calls[1].body, {
      bundleSha256: attestationBody.metadata.bundleSha256,
      bundleSizeBytes: attestationBody.metadata.bundleSizeBytes,
      attestation: "signed-trace-token",
    });
    assert.equal(gunzipSync(uploadedBodies[0]).toString("utf8"), await readFile(closedFile, "utf8"));

    const stateFile = path.join(machineDir, "trace-uploads", `${path.basename(closedFile)}.uploaded.json`);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      file: string;
      bundleId: string;
      bundleSha256: string;
      bundleSizeBytes: number;
    };
    assert.equal(state.file, path.basename(closedFile));
    assert.equal(state.bundleId, attestationBody.metadata.bundleId);
    assert.equal(state.bundleSha256, attestationBody.metadata.bundleSha256);
    assert.equal(state.bundleSizeBytes, attestationBody.metadata.bundleSizeBytes);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("derives jitter from lockId and applies initial delay", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-upload-jitter-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await writeFile(
      path.join(traceDir, "daemon-trace-2026-05-08T00-00-00-000Z-1000-0000.jsonl"),
      '{"type":"span"}\n',
    );

    const lockId = "machine-jitter-test-seed";
    const expectedJitter = computeTraceJitter(lockId);

    // Capture scheduled delays without actually firing the callbacks. start()
    // calls this.timers.setTimeout synchronously, so we can observe the delay
    // argument immediately and then stop() before any upload chain runs. This
    // keeps the jitter assertion deterministic and avoids the fire-and-forget
    // upload race that was causing intermittent hangs.
    const scheduledDelays: number[] = [];

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      lockId,
      timers: {
        setTimeout: ((_fn: () => void, ms: number) => {
          scheduledDelays.push(ms);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof globalThis.setTimeout,
        setInterval: globalThis.setInterval.bind(globalThis),
        clearTimeout: () => {},
        clearInterval: globalThis.clearInterval.bind(globalThis),
      },
      fetchImpl: async () => {
        throw new Error("fetch should not be called in jitter-only test");
      },
    });

    uploader.start();
    uploader.stop();

    // Initial delay should match the deterministic jitter derived from lockId
    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], expectedJitter.initialUploadDelayMs);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("uses NO_JITTER when lockId is not provided", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-upload-nojitter-"));
  try {
    const traceDir = path.join(machineDir, "traces");
    await mkdir(traceDir, { recursive: true });
    await writeFile(
      path.join(traceDir, "daemon-trace-2026-05-08T00-00-00-000Z-1000-0000.jsonl"),
      '{"type":"span"}\n',
    );

    const scheduledDelays: number[] = [];

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      minFileAgeMs: 0,
      // No lockId → should use NO_JITTER
      timers: {
        setTimeout: ((_fn: () => void, ms: number) => {
          scheduledDelays.push(ms);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof globalThis.setTimeout,
        setInterval: globalThis.setInterval.bind(globalThis),
        clearTimeout: () => {},
        clearInterval: globalThis.clearInterval.bind(globalThis),
      },
      fetchImpl: async () => {
        throw new Error("fetch should not be called in jitter-only test");
      },
    });

    uploader.start();
    uploader.stop();

    // NO_JITTER → initial delay is 0
    assert.equal(scheduledDelays.length, 1);
    assert.equal(scheduledDelays[0], 0);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("stop prevents further uploads after startup", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-upload-stop-"));
  try {
    let timerFn: (() => void) | null = null;

    const uploader = new DaemonTraceBundleUploader({
      machineDir,
      serverUrl: "https://server.test",
      apiKey: "sk_machine_test",
      workerUrl: "https://worker.test/",
      jitter: NO_JITTER,
      timers: {
        setTimeout: ((fn: () => void, _ms: number) => {
          timerFn = fn;
          return 42 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof globalThis.setTimeout,
        setInterval: globalThis.setInterval.bind(globalThis),
        clearTimeout: () => {},
        clearInterval: globalThis.clearInterval.bind(globalThis),
      },
      fetchImpl: async () => {
        throw new Error("should not be called after stop");
      },
    });

    uploader.start();
    assert.ok(timerFn !== null, "setTimeout should have been called");

    uploader.stop();
    // Firing the timer after stop should be a no-op
    (timerFn as unknown as () => void)();

    // If we get here without an Error from fetchImpl, stop() worked
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

});
