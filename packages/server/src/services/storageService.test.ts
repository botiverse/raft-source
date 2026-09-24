import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import {
  buildSdkLoggerWithSaturationCounter,
  ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX,
  AttachmentDirectUploadStorageUnavailableError,
  UnknownAttachmentStorageRouteError,
  getDirectUploadStorage,
  getStorage,
  parseS3MaxSockets,
  parseS3RequestTimeoutMs,
  resetStorageForTests,
  setStorageTracer,
  isStoragePreconditionFailedError,
} from "./storageService.js";
import { s3SocketPoolSaturationTotal } from "../metrics.js";

const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

test("S3 storage transport config falls back to production-safe defaults", () => {
  assert.equal(parseS3RequestTimeoutMs(undefined), 30_000);
  assert.equal(parseS3RequestTimeoutMs(""), 30_000);
  assert.equal(parseS3RequestTimeoutMs("0"), 30_000);
  assert.equal(parseS3RequestTimeoutMs("-1"), 30_000);
  assert.equal(parseS3RequestTimeoutMs("not-a-number"), 30_000);
  assert.equal(parseS3RequestTimeoutMs("15000"), 15_000);

  assert.equal(parseS3MaxSockets(undefined), 300);
  assert.equal(parseS3MaxSockets(""), 300);
  assert.equal(parseS3MaxSockets("0"), 300);
  assert.equal(parseS3MaxSockets("-1"), 300);
  assert.equal(parseS3MaxSockets("not-a-number"), 300);
  assert.equal(parseS3MaxSockets("500"), 500);
});

test("dedicated direct-upload bucket routes reads and deletes by immutable storage-key namespace", async () => {
  const envKeys = [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT",
    "S3_DIRECT_UPLOAD_REGION",
    "S3_DIRECT_UPLOAD_ACCESS_KEY_ID",
    "S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY",
    "S3_DIRECT_UPLOAD_BUCKET",
    "UPLOADS_LOCAL",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  const operations: Array<{ operation: "get" | "head" | "delete"; bucket: string | undefined; key: string | undefined }> = [];
  try {
    process.env.S3_ENDPOINT = "https://legacy-storage.example.test";
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = "legacy-key";
    process.env.S3_SECRET_ACCESS_KEY = "legacy-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "legacy-attachments";
    process.env.S3_DIRECT_UPLOAD_ENDPOINT = "https://direct-storage.example.test";
    process.env.S3_DIRECT_UPLOAD_REGION = "auto";
    process.env.S3_DIRECT_UPLOAD_ACCESS_KEY_ID = "direct-key";
    process.env.S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY = "direct-secret";
    process.env.S3_DIRECT_UPLOAD_BUCKET = "direct-attachments";
    process.env.UPLOADS_LOCAL = "false";
    resetStorageForTests();
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        operations.push({ operation: "head", bucket: command.input.Bucket, key: command.input.Key });
        return { ContentLength: 1, ContentType: "text/plain", ETag: "etag" };
      }
      if (command instanceof GetObjectCommand) {
        operations.push({ operation: "get", bucket: command.input.Bucket, key: command.input.Key });
        return { Body: Readable.from(["body"]), ETag: "etag" };
      }
      if (command instanceof DeleteObjectCommand) {
        operations.push({ operation: "delete", bucket: command.input.Bucket, key: command.input.Key });
        return {};
      }
      return {};
    }) as typeof originalSend;

    const storage = getStorage();
    assert.ok(storage?.head);
    const legacyKey = "attachments/legacy/object";
    const directKey = `${ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX}server/upload/object`;
    await storage.head(legacyKey);
    await storage.head(directKey);
    await storage.get(legacyKey);
    await storage.get(directKey);
    await storage.delete(legacyKey);
    await storage.delete(directKey);
    assert.deepEqual(operations, [
      { operation: "head", bucket: "legacy-attachments", key: legacyKey },
      { operation: "head", bucket: "direct-attachments", key: directKey },
      { operation: "get", bucket: "legacy-attachments", key: legacyKey },
      { operation: "get", bucket: "direct-attachments", key: directKey },
      { operation: "delete", bucket: "legacy-attachments", key: legacyKey },
      { operation: "delete", bucket: "direct-attachments", key: directKey },
    ]);

    assert.ok(storage.getPresignedUrl);
    assert.equal(storage.getRange, undefined, "S3 range fallback must continue through routed GET");
    const legacyDownload = new URL(await storage.getPresignedUrl(legacyKey));
    const directDownload = new URL(await storage.getPresignedUrl(directKey));
    assert.match(legacyDownload.hostname, /legacy-storage\.example\.test$/);
    assert.match(directDownload.hostname, /direct-storage\.example\.test$/);
    assert.throws(
      () => storage.get("attachments/v2/server/upload/object"),
      UnknownAttachmentStorageRouteError,
      "unknown versioned namespaces must never fall back to the legacy bucket",
    );
  } finally {
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = originalSend;
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("incomplete direct-upload bucket config fails closed instead of inheriting legacy credentials", () => {
  const envKeys = [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT",
    "S3_DIRECT_UPLOAD_ACCESS_KEY_ID",
    "S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY",
    "S3_DIRECT_UPLOAD_BUCKET",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const consoleWarn = console.warn;
  try {
    process.env.S3_ENDPOINT = "https://legacy-storage.example.test";
    process.env.S3_ACCESS_KEY_ID = "legacy-key";
    process.env.S3_SECRET_ACCESS_KEY = "legacy-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "legacy-attachments";
    process.env.S3_DIRECT_UPLOAD_ENDPOINT = "https://direct-storage.example.test";
    delete process.env.S3_DIRECT_UPLOAD_ACCESS_KEY_ID;
    delete process.env.S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY;
    delete process.env.S3_DIRECT_UPLOAD_BUCKET;
    console.warn = () => {};
    resetStorageForTests();
    assert.equal(getDirectUploadStorage(), null);
    const storage = getStorage();
    assert.ok(storage);
    assert.throws(
      () => storage.get(`${ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX}server/upload/object`),
      AttachmentDirectUploadStorageUnavailableError,
      "a persisted direct key must never fall back to legacy storage when dedicated config is missing",
    );
  } finally {
    console.warn = consoleWarn;
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function counterValueFor(labels: { bucket: string; endpoint_host: string }): Promise<number> {
  const json = await s3SocketPoolSaturationTotal.get();
  const match = json.values.find(
    (v) => v.labels.bucket === labels.bucket && v.labels.endpoint_host === labels.endpoint_host,
  );
  return match?.value ?? 0;
}

test("SDK logger increments saturation counter on socket-pool capacity warning", async () => {
  // Use a label pair scoped to this test so we don't collide with other
  // suites that touch the same registry.
  const labels = { bucket: "test-saturation-bucket", endpoint_host: "test.saturation.host" };
  const consoleWarn = console.warn;
  console.warn = () => {};
  try {
    const logger = buildSdkLoggerWithSaturationCounter(labels);
    const before = await counterValueFor(labels);

    // The exact shape the SDK emits, including the multi-line tail.
    logger.warn(
      "@smithy/node-http-handler:WARN - socket usage at capacity=50 and 111 additional requests are enqueued.\nSee https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html\nor increase socketAcquisitionWarningTimeout=(millis) in the NodeHttpHandler config.",
    );
    logger.warn(
      "@smithy/node-http-handler:WARN - socket usage at capacity=300 and 600 additional requests are enqueued.",
    );

    const after = await counterValueFor(labels);
    assert.equal(after - before, 2, "expected two saturation matches to increment the counter twice");
  } finally {
    console.warn = consoleWarn;
  }
});

test("SDK logger does NOT increment saturation counter for unrelated warnings", async () => {
  const labels = { bucket: "test-saturation-noise-bucket", endpoint_host: "test.saturation.noise.host" };
  const consoleWarn = console.warn;
  console.warn = () => {};
  try {
    const logger = buildSdkLoggerWithSaturationCounter(labels);
    const before = await counterValueFor(labels);

    // Warnings the SDK might emit that should NOT count as saturation.
    logger.warn("some unrelated warning about retry backoff");
    logger.warn("@smithy/middleware-retry:WARN - max retries exceeded");
    logger.warn(""); // empty
    logger.warn(123); // non-string first arg
    logger.warn({ message: "socket usage at capacity=50" }); // shape we don't accept

    const after = await counterValueFor(labels);
    assert.equal(after - before, 0, "non-matching warnings must not increment the saturation counter");
  } finally {
    console.warn = consoleWarn;
  }
});

test("local storage exposes strong versions for create-only and compare-and-swap writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-storage-cas-"));
  const envKeys = [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "UPLOADS_LOCAL",
    "UPLOADS_DIR",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ATTACHMENTS_BUCKET;
    process.env.UPLOADS_LOCAL = "true";
    process.env.UPLOADS_DIR = dir;
    resetStorageForTests();

    const storage = getStorage();
    assert.ok(storage);
    assert.ok(storage.putConditional);
    assert.ok(storage.getVersioned);
    const created = await storage.putConditional(
      "wiki/manifest.json",
      Buffer.from("v1"),
      "application/json",
      { ifNoneMatch: "*" },
    );
    assert.ok(created.etag);
    await assert.rejects(
      storage.putConditional(
        "wiki/manifest.json",
        Buffer.from("duplicate"),
        "application/json",
        { ifNoneMatch: "*" },
      ),
      isStoragePreconditionFailedError,
    );

    const first = await storage.getVersioned("wiki/manifest.json");
    assert.equal(first.etag, created.etag);
    await assert.rejects(
      storage.putConditional(
        "wiki/manifest.json",
        Buffer.from("wrong"),
        "application/json",
        { ifMatch: "\"stale\"" },
      ),
      isStoragePreconditionFailedError,
    );

    const updated = await storage.putConditional(
      "wiki/manifest.json",
      Buffer.from("v2"),
      "application/json",
      { ifMatch: first.etag },
    );
    assert.ok(updated.etag);
    assert.notEqual(updated.etag, first.etag);
  } finally {
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local storage publishes exact-length streams atomically and removes partial files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-storage-stream-"));
  const envKeys = ["S3_ENDPOINT", "UPLOADS_LOCAL", "UPLOADS_DIR"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.S3_ENDPOINT;
    process.env.UPLOADS_LOCAL = "true";
    process.env.UPLOADS_DIR = dir;
    resetStorageForTests();
    const storage = getStorage();
    assert.ok(storage?.putStream);
    await storage.putStream(
      "external/inbound/complete.txt",
      Readable.from([Buffer.from("provider-"), Buffer.from("neutral")]),
      "text/plain",
      16,
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "external/inbound/complete.txt"), "utf8"),
      "provider-neutral",
    );
    await assert.rejects(
      storage.putStream(
        "external/inbound/partial.txt",
        Readable.from([Buffer.from("short")]),
        "text/plain",
        20,
      ),
      /content length did not match/,
    );
    assert.equal(fs.existsSync(path.join(dir, "external/inbound/partial.txt")), false);
    assert.equal(
      fs.readdirSync(path.join(dir, "external/inbound")).some((name) => name.endsWith(".part")),
      false,
    );
  } finally {
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 put trace rows promote closed storage axes without raw object content", async () => {
  const envKeys = [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "S3_FORCE_PATH_STYLE",
    "S3_REQUEST_TIMEOUT_MS",
    "S3_MAX_SOCKETS",
    "UPLOADS_LOCAL",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "7".repeat(32),
    spanIdGenerator: () => "8".repeat(16),
  });
  const putInputs: PutObjectCommand["input"][] = [];

  try {
    process.env.S3_ENDPOINT = "https://s3.trace.test";
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "trace-bucket";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_REQUEST_TIMEOUT_MS = "5000";
    process.env.S3_MAX_SOCKETS = "12";
    process.env.UPLOADS_LOCAL = "false";
    resetStorageForTests();
    setStorageTracer(tracer);
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (command instanceof PutObjectCommand) putInputs.push(command.input);
      return {};
    }) as typeof originalSend;

    const storage = getStorage();
    assert.ok(storage);
    await storage.put("safe/object.txt", Buffer.from("secret object body"), "text/plain");
    assert.ok(storage.putStream);
    await storage.putStream("safe/stream.txt", Readable.from([Buffer.from("stream")]), "text/plain", 6);
    assert.equal(putInputs[0]?.ContentLength, Buffer.byteLength("secret object body"));
    assert.equal(putInputs[1]?.ContentLength, 6);
    assert.ok(putInputs[1]?.Body instanceof Readable);

    const [span] = sink.getAllSpans().filter((candidate) => candidate.name === "server.storage.s3.put");
    assert.ok(span);
    assert.equal(span.status, "ok");
    assert.equal(span.attrs?.event_kind, "storage_s3_put");
    assert.equal(span.attrs?.outcome, "ok");
    assert.equal(span.attrs?.reason, "put_completed");
    assert.equal(Object.values(span.attrs ?? {}).includes("secret object body"), false);

    const [eventRow] = traceEventRowsForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE);
    assert.equal(eventRow.event_name, "storage.s3.put.finished");
    assert.equal(eventRow.event_kind, "storage_s3_put");
    assert.equal(eventRow.outcome, "ok");
    assert.equal(eventRow.reason, "put_completed");
    const spanFact = traceSpanFactRowForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE);
    assert.equal(spanFact.row_kind, "span_fact");
    assert.equal(spanFact.event_name, "server.storage.s3.put");
    assert.equal(spanFact.event_kind, "storage_s3_put");
    assert.equal(spanFact.outcome, "ok");
    assert.equal(spanFact.reason, "put_completed");
  } finally {
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = originalSend;
    setStorageTracer(null);
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("S3 direct upload signs write-once headers and HEAD returns trusted metadata", async () => {
  const envKeys = [
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_ATTACHMENTS_BUCKET",
    "UPLOADS_LOCAL",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  let observedHeadInput: { Bucket?: string; Key?: string } | null = null;
  try {
    process.env.S3_ENDPOINT = "https://s3.direct.test";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "direct-bucket";
    process.env.UPLOADS_LOCAL = "false";
    resetStorageForTests();
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        observedHeadInput = command.input;
        return { ContentLength: 123, ContentType: "video/quicktime", ETag: "etag-123" };
      }
      return {};
    }) as typeof originalSend;

    const storage = getStorage();
    assert.ok(storage?.getPresignedPutUrl);
    assert.ok(storage.head);
    const url = new URL(await storage.getPresignedPutUrl("attachments/pending/server/upload/object", {
      expiresIn: 900,
      contentType: "video/quicktime",
      ifNoneMatch: "*",
    }));
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    assert.ok(signedHeaders.includes("content-type"));
    assert.ok(signedHeaders.includes("if-none-match"));
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(url.searchParams.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
    assert.equal(
      url.searchParams.get("x-amz-checksum-crc32"),
      null,
      "a bodyless presign command must not bind a later browser PUT to the empty-payload CRC32",
    );
    assert.equal(url.searchParams.get("x-amz-sdk-checksum-algorithm"), null);

    assert.deepEqual(await storage.head("attachments/pending/server/upload/object"), {
      sizeBytes: 123,
      contentType: "video/quicktime",
      etag: "etag-123",
    });
    const headInput = observedHeadInput as { Bucket?: string; Key?: string } | null;
    assert.ok(headInput);
    assert.equal(headInput.Bucket, "direct-bucket");
    assert.equal(headInput.Key, "attachments/pending/server/upload/object");
  } finally {
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = originalSend;
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
