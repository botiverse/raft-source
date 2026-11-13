import assert from "node:assert/strict";

import {
  AttachmentUploadClientError,
  cancelAttachmentUploadSession,
  uploadAttachmentFile,
} from "../src/utils/directAttachmentUpload";
import {
  __setDirectPutFailureEmitterForTest,
  directPutClientScheme,
  directPutElapsedBucket,
  directPutSentBucket,
  directPutSizeBucket,
} from "../src/utils/directPutFailureTrace";
import type {
  AttachmentUploadApi,
} from "../src/utils/directAttachmentUpload";

type ApiCall = Readonly<{ method: string; url: string; body?: unknown }>;

function fileOf(size: number, type = "application/octet-stream", name = "payload.bin"): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return Object.assign(blob, { name, lastModified: 0 }) as File;
}

function responseError(status: number, data: unknown) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

function makeApi(options: {
  capabilities?: unknown;
  status?: unknown[];
  create?: unknown[];
  complete?: unknown[];
}) {
  const calls: ApiCall[] = [];
  const queues = {
    status: [...(options.status ?? [])],
    create: [...(options.create ?? [])],
    complete: [...(options.complete ?? [])],
  };
  const next = (queue: unknown[], label: string) => {
    const value = queue.shift();
    if (value instanceof Error) throw value;
    assert.notEqual(value, undefined, `missing ${label} response`);
    return { data: value };
  };
  const api: AttachmentUploadApi = {
    async get(url) {
      calls.push({ method: "GET", url });
      if (url === "/attachments/upload-capabilities") {
        if (options.capabilities instanceof Error) throw options.capabilities;
        return { data: options.capabilities as never };
      }
      return next(queues.status, "status") as never;
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
      return url.endsWith("/complete")
        ? next(queues.complete, "complete") as never
        : next(queues.create, "create") as never;
    },
    async delete(url) {
      calls.push({ method: "DELETE", url });
      return { data: { uploadId: "upload-1", state: "canceled" } as never };
    },
  };
  return { api, calls };
}

const capabilities = {
  directUploadEnabled: true,
  directUploadThresholdBytes: 4,
  maxBytes: 20,
  sessionExpiresInSeconds: 900,
} as const;

const created = {
  uploadId: "upload-1",
  attachmentId: "attachment-1",
  state: "pending",
  expiresAt: "2026-08-01T09:00:00.000Z",
  upload: {
    method: "PUT",
    url: "https://objects.example.test/signed-secret",
    headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
  },
} as const;

const completed = {
  uploadId: "upload-1",
  state: "completed",
  attachment: {
    id: "attachment-1",
    filename: "payload.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 8,
    thumbnailUrl: null,
  },
} as const;

test("uses capability max first and preserves multipart below the direct threshold", async () => {
  const { api, calls } = makeApi({ capabilities });
  let legacyCalls = 0;
  const attachmentId = await uploadAttachmentFile({
    api,
    file: fileOf(3),
    channelId: "channel-1",
    clientRequestId: "request-1",
    legacyUpload: async () => {
      legacyCalls += 1;
      return "legacy-attachment";
    },
  });

  assert.equal(attachmentId, "legacy-attachment");
  assert.equal(legacyCalls, 1);
  assert.deepEqual(calls, [{ method: "GET", url: "/attachments/upload-capabilities" }]);

  await assert.rejects(
    uploadAttachmentFile({
      api,
      file: fileOf(21),
      channelId: "channel-1",
      clientRequestId: "request-2",
      legacyUpload: async () => "must-not-run",
    }),
    (error: unknown) => error instanceof AttachmentUploadClientError && error.code === "UPLOAD_TOO_LARGE",
  );
});

/**
 * Task #187 INVERTED the second half of this test. It used to assert that a 503
 * from the capability route REJECTS with `SERVER_5XX` and that legacy
 * "must-not-run" — i.e. fail closed. That is the 2026-08-02 outage shape: the
 * capability route 500'd and uploads died although the legacy path was healthy.
 *
 * The 404 half is unchanged. The 503 half now asserts the opposite, and the
 * property it used to protect (a failing probe must not silently create a
 * session) is preserved below by asserting the exact call list.
 * Broader coverage — timeout, network, 4xx, abort — lives in
 * `directAttachmentUploadFailSafe.test.ts`.
 */
test("falls back to legacy multipart whenever the capability route does not explicitly enable direct upload", async () => {
  const unavailable = makeApi({
    capabilities: responseError(404, { code: "NOT_FOUND", message: "Not found" }),
  });
  let legacyCalls = 0;
  const attachmentId = await uploadAttachmentFile({
    api: unavailable.api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "request-stable",
    legacyUpload: async () => {
      legacyCalls += 1;
      return "legacy-attachment";
    },
  });

  assert.equal(attachmentId, "legacy-attachment");
  assert.equal(legacyCalls, 1);
  assert.deepEqual(unavailable.calls, [
    { method: "GET", url: "/attachments/upload-capabilities" },
  ]);

  const unavailableServer = makeApi({
    capabilities: responseError(503, { code: "SERVER_5XX", message: "Unavailable" }),
  });
  let serverErrorLegacyCalls = 0;
  const viaLegacy = await uploadAttachmentFile({
    api: unavailableServer.api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "request-stable",
    legacyUpload: async () => {
      serverErrorLegacyCalls += 1;
      return "legacy-after-5xx";
    },
  });

  assert.equal(viaLegacy, "legacy-after-5xx", "a 5xx probe must degrade, not kill the upload");
  assert.equal(serverErrorLegacyCalls, 1);
  assert.deepEqual(
    unavailableServer.calls,
    [{ method: "GET", url: "/attachments/upload-capabilities" }],
    "a failed probe must still never create a session",
  );
});

test("direct upload sends a raw File through XHR, reports byte progress, and completes once", async () => {
  const responseWithForbiddenExtraHeader = {
    ...created,
    upload: {
      ...created.upload,
      headers: {
        ...created.upload.headers,
        Authorization: "Bearer must-never-leave-the-Raft-origin",
      },
    },
  };
  const { api, calls } = makeApi({ capabilities, create: [responseWithForbiddenExtraHeader], complete: [completed] });
  const requestCalls: Array<Record<string, unknown>> = [];
  const sessions: string[] = [];
  const progress: number[] = [];
  const file = fileOf(8);

  const attachmentId = await uploadAttachmentFile({
    api,
    file,
    channelId: "channel-1",
    clientRequestId: "request-stable",
    legacyUpload: async () => "must-not-run",
    requestImpl: async (config) => {
      requestCalls.push(config as unknown as Record<string, unknown>);
      config.onUploadProgress?.({ loaded: 1, total: 8 } as never);
      config.onUploadProgress?.({ loaded: 4, total: 8 } as never);
      config.onUploadProgress?.({ loaded: 8, total: 8 } as never);
      return { status: 200 };
    },
    onSession: ({ uploadId }) => sessions.push(uploadId),
    onProgress: (value) => progress.push(value),
  });

  assert.equal(attachmentId, "attachment-1");
  assert.deepEqual(sessions, ["upload-1"]);
  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0]!.url, created.upload.url);
  assert.equal(requestCalls[0]!.method, "PUT");
  assert.equal(requestCalls[0]!.adapter, "xhr");
  assert.equal(requestCalls[0]!.withCredentials, false);
  assert.equal("fetchOptions" in requestCalls[0]!, false);
  assert.equal(requestCalls[0]!.data, file);
  assert.equal("body" in requestCalls[0]!, false);
  assert.equal("duplex" in requestCalls[0]!, false);
  assert.equal(typeof requestCalls[0]!.onUploadProgress, "function");
  assert.deepEqual(progress, [13, 50, 99]);
  assert.deepEqual(requestCalls[0]!.headers, created.upload.headers);
  assert.equal((requestCalls[0]!.validateStatus as (status: number) => boolean)(412), true);
  assert.deepEqual(calls, [
    { method: "GET", url: "/attachments/upload-capabilities" },
    {
      method: "POST",
      url: "/attachments/upload-sessions",
      body: {
        channelId: "channel-1",
        filename: "payload.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 8,
        clientRequestId: "request-stable",
      },
    },
    { method: "POST", url: "/attachments/upload-sessions/upload-1/complete", body: undefined },
  ]);
});

test("412 and a lost PUT response recover through status/complete without a duplicate session", async () => {
  for (const put of [
    async () => ({ status: 412 }),
    async () => { throw new TypeError("network failed at https://objects.example.test/signed-secret"); },
  ]) {
    const { api, calls } = makeApi({
      capabilities,
      create: [created],
      status: [{ uploadId: "upload-1", state: "pending", expiresAt: created.expiresAt, attachment: null, terminalReason: null }],
      complete: [completed],
    });
    const attachmentId = await uploadAttachmentFile({
      api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: put,
    });

    assert.equal(attachmentId, "attachment-1");
    assert.equal(calls.filter((call) => call.url === "/attachments/upload-sessions").length, 1);
    if (put.toString().includes("network failed")) {
      assert.ok(calls.some((call) => call.method === "GET" && call.url.endsWith("/upload-1")));
    }
  }
});

test("retry resumes a completed session without PUT, create, or duplicate attachment", async () => {
  const { api, calls } = makeApi({
    capabilities,
    status: [{
      uploadId: "upload-1",
      state: "completed",
      expiresAt: created.expiresAt,
      attachment: completed.attachment,
      terminalReason: null,
    }],
  });
  let putCalls = 0;
  const attachmentId = await uploadAttachmentFile({
    api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "request-stable",
    previousSession: { uploadId: "upload-1" },
    legacyUpload: async () => "must-not-run",
    requestImpl: async () => {
      putCalls += 1;
      return { status: 200 };
    },
  });

  assert.equal(attachmentId, "attachment-1");
  assert.equal(putCalls, 0);
  assert.equal(calls.some((call) => call.url === "/attachments/upload-sessions"), false);
});

test("retry checks the prior session before reusing the same request id and object key", async () => {
  const missing = responseError(404, {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "Uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 1,
  });
  const { api, calls } = makeApi({
    capabilities,
    status: [{
      uploadId: "upload-1",
      state: "pending",
      expiresAt: created.expiresAt,
      attachment: null,
      terminalReason: null,
    }],
    complete: [missing, missing, missing, completed],
    create: [created],
  });
  let putCalls = 0;
  const attachmentId = await uploadAttachmentFile({
    api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "request-stable",
    previousSession: { uploadId: "upload-1" },
    legacyUpload: async () => "must-not-run",
    requestImpl: async () => {
      putCalls += 1;
      return { status: 412 };
    },
    sleep: async () => undefined,
  });

  assert.equal(attachmentId, "attachment-1");
  assert.equal(putCalls, 1);
  const createCall = calls.find((call) => call.url === "/attachments/upload-sessions");
  assert.deepEqual(createCall?.body, {
    channelId: "channel-1",
    filename: "payload.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 8,
    clientRequestId: "request-stable",
  });
  assert.equal(calls.filter((call) => call.url === "/attachments/upload-sessions").length, 1);
});

test("retries only contract-marked complete failures and preserves the same upload", async () => {
  const retryable = responseError(409, {
    code: "UPLOAD_VERIFICATION_IN_PROGRESS",
    message: "Verification is already in progress.",
    retryable: true,
    retryAfterMs: 25,
  });
  const { api, calls } = makeApi({ capabilities, create: [created], complete: [retryable, completed] });
  const waits: number[] = [];
  const attachmentId = await uploadAttachmentFile({
    api,
    file: fileOf(8),
    channelId: "channel-1",
    clientRequestId: "request-stable",
    legacyUpload: async () => "must-not-run",
    requestImpl: async () => ({ status: 200 }),
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(attachmentId, "attachment-1");
  assert.deepEqual(waits, [25]);
  assert.equal(calls.filter((call) => call.url.endsWith("/complete")).length, 2);

  const terminal = responseError(410, {
    code: "UPLOAD_SESSION_EXPIRED",
    message: "Upload session expired.",
    retryable: false,
  });
  const terminalApi = makeApi({ capabilities, create: [created], complete: [terminal] });
  await assert.rejects(
    uploadAttachmentFile({
      api: terminalApi.api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: async () => ({ status: 200 }),
    }),
    (error: unknown) => error instanceof AttachmentUploadClientError && error.code === "UPLOAD_SESSION_EXPIRED",
  );
  assert.equal(terminalApi.calls.filter((call) => call.url.endsWith("/complete")).length, 1);
});

test("explicit cancel calls the authenticated session endpoint without exposing the object URL", async () => {
  const { api, calls } = makeApi({});
  await cancelAttachmentUploadSession(api, "upload-1");
  assert.deepEqual(calls, [{ method: "DELETE", url: "/attachments/upload-sessions/upload-1" }]);
});

test("an exposed redirect response fails closed without completing", async () => {
  const { api, calls } = makeApi({ capabilities, create: [created] });
  await assert.rejects(
    uploadAttachmentFile({
      api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: async () => ({ status: 302 }),
    }),
    (error: unknown) => error instanceof AttachmentUploadClientError
      && error.code === "UPLOAD_OBJECT_PUT_FAILED"
      && !error.message.includes(created.upload.url),
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/upload-1")));
  assert.equal(calls.some((call) => call.url.endsWith("/complete")), false);
});

test("a blocked redirect or network failure preserves the session for a safe retry", async () => {
  const missing = responseError(404, {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "Uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 1,
  });
  const { api, calls } = makeApi({
    capabilities,
    create: [created],
    status: [{
      uploadId: "upload-1",
      state: "pending",
      expiresAt: created.expiresAt,
      attachment: null,
      terminalReason: null,
    }],
    complete: [missing, missing, missing],
  });

  await assert.rejects(
    uploadAttachmentFile({
      api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: async () => {
        throw new TypeError("Network Error");
      },
      sleep: async () => undefined,
    }),
    (error: unknown) => error instanceof AttachmentUploadClientError
      && error.code === "UPLOAD_OBJECT_PUT_UNCERTAIN"
      && error.retryable
      && !error.message.includes(created.upload.url),
  );
  assert.ok(calls.some((call) => call.method === "GET" && call.url.endsWith("/upload-1")));
  assert.equal(calls.filter((call) => call.url.endsWith("/complete")).length, 3);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/upload-1")), false);
});


// ---------------------------------------------------------------------------
// R2 direct PUT transport.
//
// Chromium request streams require HTTP/2, while R2's S3 API endpoint
// negotiates HTTP/1.1. The direct path therefore always sends the original
// File exactly once through XHR. The progress callback must observe bytes from
// that request without changing the request body or creating another PUT.
// ---------------------------------------------------------------------------

test("direct PUT stays a single plain-File XHR request while delivering progress", async () => {
  const file = fileOf(8);
  const progress: number[] = [];
  const configs: Array<Record<string, unknown>> = [];
  const { api } = makeApi({ capabilities, create: [created], complete: [completed] });
  const options = {
    api,
    file,
    channelId: "channel-1",
    clientRequestId: "request-stable",
    legacyUpload: async () => "must-not-run",
    onProgress: (value: number) => progress.push(value),
    requestImpl: async (config: Parameters<NonNullable<Parameters<typeof uploadAttachmentFile>[0]["requestImpl"]>>[0]) => {
      configs.push(config as unknown as Record<string, unknown>);
      config.onUploadProgress?.({ loaded: 2, total: 8 } as never);
      config.onUploadProgress?.({ loaded: 6, total: 8 } as never);
      return { status: 200 };
    },
  };

  const attachmentId = await uploadAttachmentFile(options);

  assert.equal(attachmentId, "attachment-1");
  assert.equal(configs.length, 1, "R2 must receive exactly one PUT attempt");
  assert.equal(configs[0]!.data, file, "the first and only request body must be the original File");
  assert.equal(configs[0]!.adapter, "xhr");
  assert.equal("fetchOptions" in configs[0]!, false);
  assert.deepEqual(progress, [25, 75]);
});

test("an uncertain plain-File PUT keeps the session and enters recovery without a transport retry", async () => {
  const missing = responseError(404, {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "Uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 1,
  });
  const configs: Array<Record<string, unknown>> = [];
  const { api, calls } = makeApi({
    capabilities,
    create: [created],
    status: [{
      uploadId: "upload-1",
      state: "pending",
      expiresAt: created.expiresAt,
      attachment: null,
      terminalReason: null,
    }],
    complete: [missing, missing, missing],
  });

  await assert.rejects(
    uploadAttachmentFile({
      api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: async (config) => {
        configs.push(config as unknown as Record<string, unknown>);
        throw Object.assign(new TypeError("Failed to fetch"), { code: "ERR_NETWORK" });
      },
      sleep: async () => undefined,
    }),
    (error: unknown) => error instanceof AttachmentUploadClientError
      && error.code === "UPLOAD_OBJECT_PUT_UNCERTAIN"
      && error.retryable,
  );

  assert.equal(configs.length, 1, "a failed File PUT must not be replayed blindly");
  assert.equal(typeof (configs[0]!.data as ReadableStream)?.getReader, "undefined");
  assert.ok(calls.some((call) => call.method === "GET" && call.url.endsWith("/upload-1")));
  assert.equal(calls.filter((call) => call.url.endsWith("/complete")).length, 3);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/upload-1")), false);
});


// ---------------------------------------------------------------------------
// slock.attachment.direct_put_failed (#triage:#327): one event per failed
// direct PUT, after recovery, with no URL / filename / id. Behaviour is
// unchanged: these tests only add the trace assertions.
// ---------------------------------------------------------------------------

type EmittedEvent = Readonly<{ name: string; attrs: Record<string, unknown> }>;

async function withDirectPutTrace(
  protocol: string | undefined,
  run: (emitted: EmittedEvent[]) => Promise<void>,
): Promise<void> {
  const emitted: EmittedEvent[] = [];
  __setDirectPutFailureEmitterForTest((name, attrs) => { emitted.push({ name, attrs }); });
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const previous = (globalThis as { location?: unknown }).location;
  if (protocol !== undefined) {
    Object.defineProperty(globalThis, "location", {
      value: { protocol, host: "raft", href: `${protocol}//raft/` },
      configurable: true,
      writable: true,
    });
  }
  try {
    await run(emitted);
  } finally {
    __setDirectPutFailureEmitterForTest(null);
    if (protocol !== undefined) {
      if (hadLocation) {
        Object.defineProperty(globalThis, "location", { value: previous, configurable: true, writable: true });
      } else {
        delete (globalThis as { location?: unknown }).location;
      }
    }
  }
}

const pendingSession = {
  uploadId: "upload-1",
  state: "pending",
  expiresAt: created.expiresAt,
  attachment: null,
  terminalReason: null,
} as const;

function assertNoSensitiveAttrs(attrs: Record<string, unknown>): void {
  const serialized = JSON.stringify(attrs);
  for (const secret of [created.upload.url, "payload.bin", "upload-1", "attachment-1", "channel-1", "raft/"]) {
    assert.equal(serialized.includes(secret), false, `trace must not carry ${secret}`);
  }
}

test("a status-less PUT network error (CORS-blocked preflight) is traced with recovery not_found and still asks for a retry", async () => {
  const missing = responseError(404, {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "Uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 1,
  });
  await withDirectPutTrace("app:", async (emitted) => {
    const { api, calls } = makeApi({
      capabilities,
      create: [created],
      status: [pendingSession],
      complete: [missing, missing, missing],
    });
    let legacyCalls = 0;
    await assert.rejects(
      uploadAttachmentFile({
        api,
        file: fileOf(8),
        channelId: "channel-1",
        clientRequestId: "request-stable",
        legacyUpload: async () => { legacyCalls += 1; return "must-not-run"; },
        requestImpl: async () => {
          throw Object.assign(new TypeError("Network Error"), { code: "ERR_NETWORK" });
        },
        sleep: async () => undefined,
      }),
      (error: unknown) => error instanceof AttachmentUploadClientError
        && error.code === "UPLOAD_OBJECT_PUT_UNCERTAIN"
        && error.retryable,
    );
    assert.equal(legacyCalls, 0, "tracing only: no fallback to the legacy upload");
    assert.equal(calls.some((call) => call.method === "DELETE"), false, "the session is kept for a safe retry");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.name, "slock.attachment.direct_put_failed");
    assert.deepEqual(emitted[0]!.attrs, {
      reason: "network_error",
      http_status: null,
      error_name: "TypeError",
      error_code: "ERR_NETWORK",
      size_bucket: "<10MB",
      elapsed_bucket: "<1s",
      sent_bucket: null,
      client_scheme: "app",
      recovery: "not_found",
    });
    assertNoSensitiveAttrs(emitted[0]!.attrs);
  });
});

test("an HTTP 503 PUT is traced with its status and progress, and recovery that finds the object still succeeds", async () => {
  await withDirectPutTrace("https:", async (emitted) => {
    const { api } = makeApi({
      capabilities,
      create: [created],
      status: [pendingSession],
      complete: [completed],
    });
    const attachmentId = await uploadAttachmentFile({
      api,
      file: fileOf(8),
      channelId: "channel-1",
      clientRequestId: "request-stable",
      legacyUpload: async () => "must-not-run",
      requestImpl: async (config) => {
        config.onUploadProgress?.({ loaded: 4, total: 8 } as never);
        config.onUploadProgress?.({ loaded: 8, total: 8 } as never);
        return { status: 503 };
      },
      sleep: async () => undefined,
    });
    assert.equal(attachmentId, "attachment-1");
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0]!.attrs, {
      reason: "http_status",
      http_status: 503,
      error_name: null,
      error_code: null,
      size_bucket: "<10MB",
      elapsed_bucket: "<1s",
      sent_bucket: "100%",
      client_scheme: "https",
      recovery: "found",
    });
    assertNoSensitiveAttrs(emitted[0]!.attrs);
  });
});

test("an HTTP 503 PUT whose object is absent keeps today's retryable error and is traced", async () => {
  const missing = responseError(404, {
    code: "UPLOAD_OBJECT_NOT_FOUND",
    message: "Uploaded object is not visible yet.",
    retryable: true,
    retryAfterMs: 1,
  });
  await withDirectPutTrace(undefined, async (emitted) => {
    const { api } = makeApi({
      capabilities,
      create: [created],
      status: [pendingSession],
      complete: [missing, missing, missing],
    });
    await assert.rejects(
      uploadAttachmentFile({
        api,
        file: fileOf(8),
        channelId: "channel-1",
        clientRequestId: "request-stable",
        legacyUpload: async () => "must-not-run",
        requestImpl: async () => ({ status: 503 }),
        sleep: async () => undefined,
      }),
      (error: unknown) => error instanceof AttachmentUploadClientError
        && error.code === "UPLOAD_OBJECT_PUT_UNCERTAIN",
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.attrs.reason, "http_status");
    assert.equal(emitted[0]!.attrs.http_status, 503);
    assert.equal(emitted[0]!.attrs.recovery, "not_found");
  });
});

test("a non-retryable PUT status is traced without recovery and still fails closed", async () => {
  await withDirectPutTrace(undefined, async (emitted) => {
    const { api, calls } = makeApi({ capabilities, create: [created] });
    await assert.rejects(
      uploadAttachmentFile({
        api,
        file: fileOf(8),
        channelId: "channel-1",
        clientRequestId: "request-stable",
        legacyUpload: async () => "must-not-run",
        requestImpl: async () => ({ status: 403 }),
      }),
      (error: unknown) => error instanceof AttachmentUploadClientError
        && error.code === "UPLOAD_OBJECT_PUT_FAILED"
        && error.message === "Direct object upload failed with HTTP 403.",
    );
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/upload-1")));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.attrs.http_status, 403);
    assert.equal(emitted[0]!.attrs.recovery, "not_attempted");
  });
});

test("an aborted PUT is a cancel, not a failure, and emits no trace", async () => {
  await withDirectPutTrace("app:", async (emitted) => {
    const controller = new AbortController();
    const { api } = makeApi({ capabilities, create: [created] });
    await assert.rejects(
      uploadAttachmentFile({
        api,
        file: fileOf(8),
        channelId: "channel-1",
        clientRequestId: "request-stable",
        legacyUpload: async () => "must-not-run",
        signal: controller.signal,
        requestImpl: async () => {
          controller.abort();
          throw Object.assign(new Error("canceled"), { name: "CanceledError", code: "ERR_CANCELED" });
        },
      }),
      (error: unknown) => (error as Error).name === "CanceledError",
    );
    assert.deepEqual(emitted, []);
  });
});

test("a cancel that lands during recovery or races a 4xx emits no trace", async () => {
  for (const status of [503, 403]) {
    await withDirectPutTrace("app:", async (emitted) => {
      const controller = new AbortController();
      const { api } = makeApi({ capabilities, create: [created] });
      await assert.rejects(
        uploadAttachmentFile({
          api,
          file: fileOf(8),
          channelId: "channel-1",
          clientRequestId: "request-stable",
          legacyUpload: async () => "must-not-run",
          signal: controller.signal,
          requestImpl: async () => {
            controller.abort();
            return { status };
          },
          sleep: async () => undefined,
        }),
      );
      assert.deepEqual(emitted, [], `status ${status}`);
    });
  }
});

test("direct PUT trace buckets stay coarse", () => {
  const MB = 1024 * 1024;
  assert.equal(directPutSizeBucket(10 * MB), "10-50MB");
  assert.equal(directPutSizeBucket(175 * MB), "50-200MB");
  assert.equal(directPutSizeBucket(200 * MB), ">200MB");
  assert.equal(directPutElapsedBucket(999), "<1s");
  assert.equal(directPutElapsedBucket(30_000), "10-60s");
  assert.equal(directPutElapsedBucket(600_000), ">5m");
  assert.equal(directPutSentBucket(null, 100), null);
  assert.equal(directPutSentBucket(0, 100), "<10%");
  assert.equal(directPutSentBucket(60, 100), "50-90%");
  assert.equal(directPutSentBucket(95, 100), "90-99%");
  assert.equal(directPutClientScheme("app:"), "app");
  assert.equal(directPutClientScheme("file:"), "other");
  assert.equal(directPutClientScheme(undefined), "other");
});
