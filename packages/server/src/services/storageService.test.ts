import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BasicTracer, MemoryTraceSink, traceEventRowsForSpan, traceSpanFactRowForSpan } from "@botiverse/raft-shared";
import {
  buildSdkLoggerWithSaturationCounter,
  ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX,
  buildDirectAttachmentStorageKey,
  buildServerAttachmentStorageKey,
  AttachmentDirectUploadStorageUnavailableError,
  UnknownAttachmentStorageRouteError,
  PUBLIC_CONTENT_V2_KEY_PREFIX,
  PublicContentStorageUnavailableError,
  UnknownPublicContentStorageRouteError,
  buildAttachmentThumbnailKey,
  classifyPublicAssetKey,
  createPublicContentStorageRouter,
  getCdnStorage,
  getDirectUploadStorage,
  getPublicContentBaseUrl,
  getPublicContentStorage,
  getStorage,
  initializeLocalStoragePresenceIdentity,
  isPublicContentV2WriteConfigured,
  resolvePublicAssetUrl,
  resolvePublicContentStorageConfig,
  type StorageBackend,
  parseS3MaxSockets,
  parseS3RequestTimeoutMs,
  canWriteDedicatedAttachmentKeys,
  resetStorageForTests,
  setStorageTracer,
} from "./storageService";
import { s3SocketPoolSaturationTotal } from "../metrics";
import { readStreamPrefix } from "./attachmentPreviews/utils";

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

test("attachment presence probe uses object-specific GET errors and preserves unknown failures", async () => {
  const envKeys = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT", "S3_DIRECT_UPLOAD_ACCESS_KEY_ID", "S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY",
    "S3_DIRECT_UPLOAD_BUCKET", "UPLOADS_LOCAL"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalSend = S3Client.prototype.send;
  let failure: Error | null = null;
  const calls: { key: string | undefined; bucket: string | undefined; range: string | undefined }[] = [];
  try {
    Object.assign(process.env, { S3_ENDPOINT: "https://legacy.example.test", S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "test-key", S3_SECRET_ACCESS_KEY: "test-secret", S3_ATTACHMENTS_BUCKET: "legacy",
      S3_DIRECT_UPLOAD_ENDPOINT: "https://direct.example.test", S3_DIRECT_UPLOAD_ACCESS_KEY_ID: "test-direct-key",
      S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY: "test-direct-secret", S3_DIRECT_UPLOAD_BUCKET: "direct", UPLOADS_LOCAL: "false" });
    resetStorageForTests();
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      assert.ok(command instanceof GetObjectCommand, "presence proof must use GET, never ambiguous HEAD");
      calls.push({ key: command.input.Key, bucket: command.input.Bucket, range: command.input.Range });
      if (failure) throw failure;
      return { Body: Readable.from(["x"]) };
    }) as typeof originalSend;
    const storage = getStorage();
    assert.ok(storage?.probeObjectPresence);
    const probe = storage.probeObjectPresence.bind(storage);
    assert.equal(await probe("legacy/file"), "present");
    failure = Object.assign(new Error("no key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    assert.equal(await probe("attachments/v2/server/direct/file"), "missing");
    for (const name of ["NoSuchBucket", "AccessDenied", "NotFound", "TimeoutError"]) {
      failure = Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
      await assert.rejects(probe("legacy/file"), (error: unknown) => error === failure);
    }
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(probe("legacy/file", aborted.signal));
    assert.deepEqual(calls.map((call) => [call.bucket, call.range]), [
      ["legacy", "bytes=0-0"], ["direct", "bytes=0-0"],
      ["legacy", "bytes=0-0"], ["legacy", "bytes=0-0"], ["legacy", "bytes=0-0"], ["legacy", "bytes=0-0"],
    ]);
  } finally {
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = originalSend;
    resetStorageForTests();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("local attachment presence distinguishes ENOENT from permission and routing failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-presence-"));
  const envKeys = ["S3_ENDPOINT", "S3_DIRECT_UPLOAD_ENDPOINT", "UPLOADS_LOCAL", "UPLOADS_DIR"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalOpen = fs.promises.open;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const initialization = { directory: dir, configuredDirectory: dir, expectedObjectKey: "attachments/v2/test/present" };
  try {
    delete process.env.S3_ENDPOINT; delete process.env.S3_DIRECT_UPLOAD_ENDPOINT;
    process.env.UPLOADS_LOCAL = "true"; process.env.UPLOADS_DIR = dir;
    resetStorageForTests();
    let storage = getStorage();
    assert.ok(storage?.probeObjectPresence);
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/missing"), /unverified/,
      "an empty auto-created root is not proof of a missing historical object");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /slack:initialize-local-storage-identity.*--expect-object/);
    assert.throws(() => initializeLocalStoragePresenceIdentity(initialization), /not present/,
      "an existing empty directory cannot be certified");
    await storage.put("attachments/v2/test/present", Buffer.from("a"), "text/plain");
    assert.equal(await storage.probeObjectPresence("attachments/v2/test/present"), "present");
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/missing"), /unverified/,
      "a new upload or successful read cannot certify an empty replacement volume");
    assert.equal(fs.existsSync(path.join(dir, ".raft-storage-presence-v2")), false);
    fs.writeFileSync(path.join(dir, ".raft-storage-presence-v1"), "00000000-0000-0000-0000-000000000001\n");
    resetStorageForTests(); storage = getStorage(); assert.ok(storage?.probeObjectPresence);
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/missing"), /unverified/,
      "a legacy automatically created identity is not explicit operator proof");
    assert.throws(() => initializeLocalStoragePresenceIdentity({ ...initialization, configuredDirectory: os.tmpdir() }), /match UPLOADS_DIR/);
    assert.throws(() => initializeLocalStoragePresenceIdentity({ ...initialization, configuredDirectory: undefined }), /match UPLOADS_DIR/);
    for (const expectedObjectKey of ["", "../outside", dir, ".raft-storage-presence-v1"]) {
      assert.throws(() => initializeLocalStoragePresenceIdentity({ ...initialization, expectedObjectKey }));
    }
    fs.symlinkSync(process.execPath, path.join(dir, "attachments/v2/test/outside"));
    assert.throws(() => initializeLocalStoragePresenceIdentity({ ...initialization, expectedObjectKey: "attachments/v2/test/outside" }), /not a file on this storage volume/);
    assert.equal(initializeLocalStoragePresenceIdentity(initialization), "initialized");
    assert.equal(initializeLocalStoragePresenceIdentity(initialization), "already_initialized");
    resetStorageForTests(); storage = getStorage(); assert.ok(storage?.probeObjectPresence);
    assert.equal(await storage.probeObjectPresence("attachments/v2/test/missing"), "missing");
    (fs.promises as unknown as { open: typeof originalOpen }).open = (async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }) as typeof originalOpen;
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/restricted"), /permission denied/);
    assert.throws(() => storage.probeObjectPresence!("attachments/v3/test/file"), UnknownAttachmentStorageRouteError);
    (fs.promises as unknown as { open: typeof originalOpen }).open = originalOpen;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/missing"),
      "a recreated empty mountpoint lacks the original sentinel");
    resetStorageForTests();
    const replaced = getStorage()!;
    await replaced.put("attachments/v2/test/new-upload", Buffer.from("new bytes"), "text/plain");
    await replaced.putStream!("attachments/v2/test/new-stream", Readable.from("new"), "text/plain", 3);
    assert.equal(await replaced.probeObjectPresence!("attachments/v2/test/new-upload"), "present");
    await assert.rejects(replaced.probeObjectPresence!("attachments/v2/test/missing"), /unverified/,
      "restarting and uploading into a recreated mountpoint cannot certify old objects as missing");
    assert.throws(() => initializeLocalStoragePresenceIdentity({ ...initialization, directory: "relative-path" }), /existing absolute/);
    assert.equal(warnings.length, 1, "repeated failures across storage instances warn only once per process");
    fs.rmSync(dir, { recursive: true, force: true });
    await assert.rejects(storage.probeObjectPresence("attachments/v2/test/missing"),
      "a missing storage root is not object-level absence");
  } finally {
    console.warn = originalWarn;
    (fs.promises as unknown as { open: typeof originalOpen }).open = originalOpen;
    resetStorageForTests();
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dedicated attachment bucket routes v1/v2 reads, deletes, and download URLs by key namespace", async () => {
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
    const currentDirectKey = buildDirectAttachmentStorageKey("server", "upload", "direct-object");
    const currentServerKey = buildServerAttachmentStorageKey("server", "attachment", "server-object", ".txt");
    await storage.head(legacyKey);
    await storage.head(directKey);
    await storage.head(currentDirectKey);
    await storage.head(currentServerKey);
    await storage.get(legacyKey);
    await storage.get(directKey);
    await storage.get(currentDirectKey);
    await storage.get(currentServerKey);
    await storage.delete(legacyKey);
    await storage.delete(directKey);
    await storage.delete(currentDirectKey);
    await storage.delete(currentServerKey);
    assert.deepEqual(operations, [
      { operation: "head", bucket: "legacy-attachments", key: legacyKey },
      { operation: "head", bucket: "direct-attachments", key: directKey },
      { operation: "head", bucket: "direct-attachments", key: currentDirectKey },
      { operation: "head", bucket: "direct-attachments", key: currentServerKey },
      { operation: "get", bucket: "legacy-attachments", key: legacyKey },
      { operation: "get", bucket: "direct-attachments", key: directKey },
      { operation: "get", bucket: "direct-attachments", key: currentDirectKey },
      { operation: "get", bucket: "direct-attachments", key: currentServerKey },
      { operation: "delete", bucket: "legacy-attachments", key: legacyKey },
      { operation: "delete", bucket: "direct-attachments", key: directKey },
      { operation: "delete", bucket: "direct-attachments", key: currentDirectKey },
      { operation: "delete", bucket: "direct-attachments", key: currentServerKey },
    ]);

    assert.ok(storage.getPresignedUrl);
    assert.equal(storage.getRange, undefined, "S3 range fallback must continue through routed GET");
    const legacyDownload = new URL(await storage.getPresignedUrl(legacyKey));
    const directDownload = new URL(await storage.getPresignedUrl(directKey));
    const currentDirectDownload = new URL(await storage.getPresignedUrl(currentDirectKey));
    const currentServerDownload = new URL(await storage.getPresignedUrl(currentServerKey));
    assert.match(legacyDownload.hostname, /legacy-storage\.example\.test$/);
    assert.match(directDownload.hostname, /direct-storage\.example\.test$/);
    assert.match(currentDirectDownload.hostname, /direct-storage\.example\.test$/);
    assert.match(currentServerDownload.hostname, /direct-storage\.example\.test$/);
    assert.throws(
      () => storage.get("attachments/v3/server/upload/object"),
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
    assert.throws(
      () => storage.get(buildServerAttachmentStorageKey("server", "attachment", "object")),
      AttachmentDirectUploadStorageUnavailableError,
      "a new server-upload key must never fall back to legacy storage when dedicated config is missing",
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

test("SDK logger never prints command inputs (object keys, upload bytes) through the SDK's logger middleware", async () => {
  const secretKey = "attachments/v2/private-object-key";
  const secretBody = "user-file-content-that-must-not-be-logged";
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("fail")) {
        res.writeHead(500, { "content-type": "application/xml" });
        res.end("<Error><Code>InternalError</Code><Message>boom</Message></Error>");
        return;
      }
      res.writeHead(200, { etag: '"etag"' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const printed: unknown[][] = [];
  const saved = { trace: console.trace, debug: console.debug, info: console.info, log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved) as (keyof typeof saved)[]) {
    console[level] = (...args: unknown[]) => { printed.push(args); };
  }
  try {
    const { port } = server.address() as { port: number };
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: "auto",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      logger: buildSdkLoggerWithSaturationCounter({ bucket: "test-log-bucket", endpoint_host: "127.0.0.1" }),
    });
    await client.send(new PutObjectCommand({ Bucket: "b", Key: secretKey, Body: Buffer.from(secretBody) }));
    await assert.rejects(client.send(new PutObjectCommand({ Bucket: "b", Key: `${secretKey}-fail`, Body: Buffer.from(secretBody) })));
    client.destroy();
  } finally {
    Object.assign(console, saved);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const text = printed.map((args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? String(arg))).join(" ")).join("\n");
  assert.ok(!text.includes("private-object-key"), `object key leaked into logs: ${text}`);
  assert.ok(!text.includes("user-file-content"), `upload bytes leaked into logs: ${text}`);
  // The failure itself is still visible to operators.
  assert.ok(printed.some((args) => JSON.stringify(args).includes("PutObjectCommand")), "command failure should still be logged");
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

function recordingStorage(name: string, operations: string[]): StorageBackend {
  return {
    put: async (key) => { operations.push(`${name}:put:${key}`); },
    get: async (key) => {
      operations.push(`${name}:get:${key}`);
      return Readable.from([]);
    },
    delete: async (key) => { operations.push(`${name}:delete:${key}`); },
    head: async (key) => {
      operations.push(`${name}:head:${key}`);
      return null;
    },
  };
}

const PUBLIC_CONTENT_ENV_KEYS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ATTACHMENTS_BUCKET",
  "S3_CDN_BUCKET",
  "S3_CDN_ENDPOINT",
  "S3_CDN_REGION",
  "S3_CDN_ACCESS_KEY_ID",
  "S3_CDN_SECRET_ACCESS_KEY",
  "S3_CDN_FORCE_PATH_STYLE",
  "S3_PUBLIC_CONTENT_ENDPOINT",
  "S3_PUBLIC_CONTENT_REGION",
  "S3_PUBLIC_CONTENT_ACCESS_KEY_ID",
  "S3_PUBLIC_CONTENT_SECRET_ACCESS_KEY",
  "S3_PUBLIC_CONTENT_BUCKET",
  "S3_PUBLIC_CONTENT_FORCE_PATH_STYLE",
  "PUBLIC_CONTENT_BASE_URL",
  "CDN_BASE_URL",
  "UPLOADS_LOCAL",
] as const;

async function withPublicContentEnv(
  values: Partial<Record<(typeof PUBLIC_CONTENT_ENV_KEYS)[number], string>>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previousEnv = new Map(PUBLIC_CONTENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of PUBLIC_CONTENT_ENV_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStorageForTests();
    await run();
  } finally {
    resetStorageForTests();
    for (const key of PUBLIC_CONTENT_ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const LEGACY_CDN_ENV = {
  S3_ENDPOINT: "https://legacy-storage.example.test",
  S3_ACCESS_KEY_ID: "legacy-key",
  S3_SECRET_ACCESS_KEY: "legacy-secret",
  S3_ATTACHMENTS_BUCKET: "legacy-attachments",
  S3_CDN_BUCKET: "legacy-cdn",
  UPLOADS_LOCAL: "false",
} as const;

/** The deprecated public-content names, read only where a CDN name is unset. */
const PUBLIC_CONTENT_STORAGE_ENV = {
  S3_PUBLIC_CONTENT_ENDPOINT: "https://content-storage.example.test",
  S3_PUBLIC_CONTENT_ACCESS_KEY_ID: "content-key",
  S3_PUBLIC_CONTENT_SECRET_ACCESS_KEY: "content-secret",
  S3_PUBLIC_CONTENT_BUCKET: "public-content",
} as const;

/** The CDN's own connection and bucket: the names content/v2 storage reads first. */
const CDN_STORAGE_ENV = {
  S3_CDN_ENDPOINT: "https://cdn-storage.example.test",
  S3_CDN_ACCESS_KEY_ID: "cdn-key",
  S3_CDN_SECRET_ACCESS_KEY: "cdn-secret",
  S3_CDN_BUCKET: "cdn-content",
} as const;

function silencingWarnings<T>(run: () => T): { result: T; warnings: unknown[][] } {
  const consoleWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = consoleWarn;
  }
}

test("content/v2 storage and its base read only the CDN names when only they are set", async () => {
  assert.deepEqual(resolvePublicContentStorageConfig({
    ...CDN_STORAGE_ENV,
    S3_CDN_REGION: "eu",
    S3_CDN_FORCE_PATH_STYLE: "true",
  }), {
    kind: "configured",
    endpoint: "https://cdn-storage.example.test",
    region: "eu",
    accessKeyId: "cdn-key",
    secretAccessKey: "cdn-secret",
    bucket: "cdn-content",
    forcePathStyle: true,
    fallbacks: [],
  });
  await withPublicContentEnv({ ...CDN_STORAGE_ENV, CDN_BASE_URL: "https://cdn.example.test/" }, () => {
    const { result, warnings } = silencingWarnings(() => ({
      base: getPublicContentBaseUrl(),
      writable: isPublicContentV2WriteConfigured(),
    }));
    assert.deepEqual(result, { base: "https://cdn.example.test", writable: true });
    assert.deepEqual(warnings, [], "no deprecation warning when the CDN names are set");
  });
});

test("content/v2 storage and its base fall back to the deprecated public-content names, logged once", async () => {
  assert.deepEqual(resolvePublicContentStorageConfig({
    ...PUBLIC_CONTENT_STORAGE_ENV,
    S3_PUBLIC_CONTENT_REGION: "eu",
    S3_PUBLIC_CONTENT_FORCE_PATH_STYLE: "true",
    // Blank is unset: it never shadows the deprecated value.
    S3_CDN_BUCKET: " ",
  }), {
    kind: "configured",
    endpoint: "https://content-storage.example.test",
    region: "eu",
    accessKeyId: "content-key",
    secretAccessKey: "content-secret",
    bucket: "public-content",
    forcePathStyle: true,
    fallbacks: [
      "S3_PUBLIC_CONTENT_ENDPOINT",
      "S3_PUBLIC_CONTENT_ACCESS_KEY_ID",
      "S3_PUBLIC_CONTENT_SECRET_ACCESS_KEY",
      "S3_PUBLIC_CONTENT_BUCKET",
      "S3_PUBLIC_CONTENT_REGION",
      "S3_PUBLIC_CONTENT_FORCE_PATH_STYLE",
    ],
  });
  await withPublicContentEnv({
    ...PUBLIC_CONTENT_STORAGE_ENV,
    PUBLIC_CONTENT_BASE_URL: "https://content.example.test/",
  }, () => {
    const { result, warnings } = silencingWarnings(() => {
      const writable = isPublicContentV2WriteConfigured();
      getPublicContentBaseUrl();
      return { writable, url: resolvePublicAssetUrl(`${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`) };
    });
    assert.deepEqual(result, {
      writable: true,
      url: `https://content.example.test/${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`,
    });
    const logged = JSON.stringify(warnings);
    for (const name of [...Object.keys(PUBLIC_CONTENT_STORAGE_ENV), "PUBLIC_CONTENT_BASE_URL"]) {
      assert.equal(logged.split(`"${name} (use `).length - 1, 1, `${name} is logged exactly once`);
    }
    for (const value of ["content-key", "content-secret", "content-storage.example.test", "content.example.test"]) {
      assert.equal(logged.includes(value), false, "the log names the settings, never their values");
    }
  });
});

test("content/v2 storage and its base: a CDN name wins over its deprecated name when both are set", async () => {
  assert.deepEqual(resolvePublicContentStorageConfig({
    ...PUBLIC_CONTENT_STORAGE_ENV,
    ...CDN_STORAGE_ENV,
    S3_PUBLIC_CONTENT_REGION: "eu",
    S3_CDN_REGION: "us",
    S3_PUBLIC_CONTENT_FORCE_PATH_STYLE: "true",
    S3_CDN_FORCE_PATH_STYLE: "false",
  }), {
    kind: "configured",
    endpoint: "https://cdn-storage.example.test",
    region: "us",
    accessKeyId: "cdn-key",
    secretAccessKey: "cdn-secret",
    bucket: "cdn-content",
    forcePathStyle: false,
    fallbacks: [],
  });
  // A partial CDN key pair never mixes with the deprecated one: the whole
  // deprecated connection fills in, and the CDN bucket still wins.
  const mixed = resolvePublicContentStorageConfig({
    ...PUBLIC_CONTENT_STORAGE_ENV,
    S3_CDN_ACCESS_KEY_ID: "cdn-key",
    S3_CDN_BUCKET: "cdn-content",
  });
  assert.equal(mixed.kind, "configured");
  if (mixed.kind === "configured") {
    assert.equal(mixed.accessKeyId, "content-key");
    assert.equal(mixed.secretAccessKey, "content-secret");
    assert.equal(mixed.bucket, "cdn-content");
  }
  await withPublicContentEnv({
    CDN_BASE_URL: "https://cdn.example.test",
    PUBLIC_CONTENT_BASE_URL: "https://content.example.test",
  }, () => {
    const { result, warnings } = silencingWarnings(() => getPublicContentBaseUrl());
    assert.equal(result, "https://cdn.example.test");
    assert.deepEqual(warnings, []);
  });
});

test("content/v2 storage is disabled quietly with only the legacy CDN bucket, and incomplete otherwise", () => {
  assert.deepEqual(resolvePublicContentStorageConfig({}), { kind: "disabled" });
  assert.deepEqual(resolvePublicContentStorageConfig({ S3_CDN_BUCKET: "cdn-content" }), { kind: "disabled" });
  assert.deepEqual(resolvePublicContentStorageConfig({ S3_PUBLIC_CONTENT_BUCKET: "public-content" }), {
    kind: "incomplete",
    missing: ["S3_CDN_ENDPOINT", "S3_CDN_ACCESS_KEY_ID", "S3_CDN_SECRET_ACCESS_KEY"],
  });
  assert.deepEqual(resolvePublicContentStorageConfig({
    S3_CDN_ENDPOINT: "https://cdn-storage.example.test",
    S3_CDN_ACCESS_KEY_ID: "cdn-key",
    S3_CDN_SECRET_ACCESS_KEY: "cdn-secret",
  }), { kind: "incomplete", missing: ["S3_CDN_BUCKET"] });
});

test("public-content router sends content/v2 keys to the dedicated bucket and keeps legacy CDN keys", async () => {
  const operations: string[] = [];
  const storage = createPublicContentStorageRouter(
    recordingStorage("legacy", operations),
    recordingStorage("content", operations),
  );
  const legacyKey = buildAttachmentThumbnailKey("server", "attachment", "legacy");
  const v2Key = buildAttachmentThumbnailKey("server", "attachment", "v2");
  assert.equal(legacyKey, "thumbs/server/attachment.webp");
  assert.equal(v2Key, `${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`);

  await storage.put(legacyKey, Buffer.from("legacy"), "image/webp");
  await storage.put(v2Key, Buffer.from("v2"), "image/webp");
  await storage.get(v2Key);
  assert.ok(storage.head);
  await storage.head(v2Key);
  await storage.delete(legacyKey);
  await storage.delete(v2Key);
  assert.deepEqual(operations, [
    `legacy:put:${legacyKey}`,
    `content:put:${v2Key}`,
    `content:get:${v2Key}`,
    `content:head:${v2Key}`,
    `legacy:delete:${legacyKey}`,
    `content:delete:${v2Key}`,
  ]);
  assert.throws(
    () => storage.get("content/v3/thumbs/server/attachment.webp"),
    UnknownPublicContentStorageRouteError,
    "unknown public-content versions must never fall back to the legacy CDN bucket",
  );
});

test("content/v2 keys fail closed when the public-content bucket is missing", async () => {
  const operations: string[] = [];
  const storage = createPublicContentStorageRouter(recordingStorage("legacy", operations), null);
  await storage.delete("thumbs/server/attachment.webp");
  assert.throws(
    () => storage.delete(`${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`),
    PublicContentStorageUnavailableError,
  );
  assert.deepEqual(operations, ["legacy:delete:thumbs/server/attachment.webp"]);
});

test("getCdnStorage routes content/v2 keys to the public-content backend on the CDN's names first", async () => {
  const originalSend = S3Client.prototype.send;
  const operations: Array<{ bucket: string | undefined; key: string | undefined }> = [];
  const consoleWarn = console.warn;
  try {
    console.warn = () => {};
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = (async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) {
        operations.push({ bucket: command.input.Bucket, key: command.input.Key });
      }
      return {};
    }) as typeof originalSend;
    const legacyKey = "thumbs/server/attachment.webp";
    const v2Key = `${PUBLIC_CONTENT_V2_KEY_PREFIX}previews/server/attachment.webp`;
    // Only the deprecated names for content/v2: they still route it.
    const { S3_CDN_BUCKET: _legacyCdnBucket, ...mainStorageEnv } = LEGACY_CDN_ENV;
    await withPublicContentEnv({
      ...mainStorageEnv,
      ...PUBLIC_CONTENT_STORAGE_ENV,
      PUBLIC_CONTENT_BASE_URL: "https://content.example.test/",
    }, async () => {
      assert.equal(isPublicContentV2WriteConfigured(), true);
      const storage = getCdnStorage();
      assert.ok(storage);
      await storage.delete(legacyKey);
      await storage.delete(v2Key);
    });
    // Both set: S3_CDN_BUCKET wins, so legacy and content/v2 keys share the CDN bucket.
    await withPublicContentEnv({
      ...LEGACY_CDN_ENV,
      ...PUBLIC_CONTENT_STORAGE_ENV,
      PUBLIC_CONTENT_BASE_URL: "https://content.example.test/",
    }, async () => {
      assert.equal(isPublicContentV2WriteConfigured(), true);
      const storage = getCdnStorage();
      assert.ok(storage);
      await storage.delete(legacyKey);
      await storage.delete(v2Key);
    });
    assert.deepEqual(operations, [
      { bucket: "legacy-attachments", key: legacyKey },
      { bucket: "public-content", key: v2Key },
      { bucket: "legacy-cdn", key: legacyKey },
      { bucket: "legacy-cdn", key: v2Key },
    ]);
  } finally {
    console.warn = consoleWarn;
    (S3Client.prototype as unknown as { send: typeof originalSend }).send = originalSend;
  }
});

test("incomplete public-content config keeps fresh writes legacy and never falls back for v2 keys", async () => {
  const consoleWarn = console.warn;
  try {
    console.warn = () => {};
    await withPublicContentEnv({
      ...LEGACY_CDN_ENV,
      S3_PUBLIC_CONTENT_ENDPOINT: "https://content-storage.example.test",
      S3_PUBLIC_CONTENT_BUCKET: "public-content",
      PUBLIC_CONTENT_BASE_URL: "https://content.example.test",
    }, () => {
      assert.equal(getPublicContentStorage(), null);
      assert.equal(isPublicContentV2WriteConfigured(), false);
      const storage = getCdnStorage();
      assert.ok(storage);
      assert.throws(
        () => storage.get(`${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`),
        PublicContentStorageUnavailableError,
        "a persisted v2 key must never fall back to the legacy CDN bucket",
      );
    });
    await withPublicContentEnv({ ...LEGACY_CDN_ENV, ...PUBLIC_CONTENT_STORAGE_ENV }, () => {
      assert.notEqual(getPublicContentStorage(), null);
      assert.equal(
        isPublicContentV2WriteConfigured(),
        false,
        "a v2 key needs a public domain before it may be persisted",
      );
    });
  } finally {
    console.warn = consoleWarn;
  }
});

test("public asset URLs follow the persisted key generation, both on CDN_BASE_URL", async () => {
  const consoleWarn = console.warn;
  try {
    console.warn = () => {};
    await withPublicContentEnv({
      CDN_BASE_URL: "https://cdn.example.test/",
      PUBLIC_CONTENT_BASE_URL: "https://content.example.test",
    }, () => {
      const v2Key = `${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`;
      assert.equal(
        resolvePublicAssetUrl("thumbs/server/attachment.webp"),
        "https://cdn.example.test/thumbs/server/attachment.webp",
      );
      assert.equal(
        resolvePublicAssetUrl(v2Key),
        `https://cdn.example.test/${v2Key}`,
        "CDN_BASE_URL wins over the deprecated PUBLIC_CONTENT_BASE_URL",
      );
      assert.equal(classifyPublicAssetKey("content/v3/thumbs/server/attachment.webp"), "unknown");
      assert.equal(resolvePublicAssetUrl("content/v3/thumbs/server/attachment.webp"), null);
      assert.equal(resolvePublicAssetUrl(null), null);
      for (const originalKey of [
        buildServerAttachmentStorageKey("server", "attachment", "object", ".svg"),
        buildDirectAttachmentStorageKey("server", "upload", "object"),
      ]) {
        assert.equal(classifyPublicAssetKey(originalKey), "legacy");
        assert.doesNotMatch(resolvePublicAssetUrl(originalKey) ?? "", /content\.example\.test/);
      }
    });
    await withPublicContentEnv({ PUBLIC_CONTENT_BASE_URL: "https://content.example.test" }, () => {
      assert.equal(
        resolvePublicAssetUrl(`${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`),
        `https://content.example.test/${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`,
        "without CDN_BASE_URL a v2 key falls back to the deprecated PUBLIC_CONTENT_BASE_URL",
      );
      assert.equal(
        resolvePublicAssetUrl("thumbs/server/attachment.webp"),
        null,
        "legacy keys read CDN_BASE_URL only",
      );
    });
    await withPublicContentEnv({}, () => {
      assert.equal(resolvePublicAssetUrl(`${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/server/attachment.webp`), null);
    });
  } finally {
    console.warn = consoleWarn;
  }
});

test("S3 GET releases its connection when a checksummed object is only partially read", async () => {
  // R2/S3 return x-amz-checksum-* when asked; the SDK then wraps Body in a
  // validator whose destroy() does not reach the socket. The attachment
  // preview path reads a prefix and destroys, so each truncated preview
  // pinned one pool socket until the task was replaced.
  const body = Buffer.alloc(4 * 1024 * 1024, 7);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  let openConnections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
      etag: '"etag"',
      "x-amz-checksum-crc32": crc.toString("base64"),
    });
    res.end(body);
  });
  server.on("connection", (socket) => {
    openConnections += 1;
    socket.on("close", () => { openConnections -= 1; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const envKeys = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ATTACHMENTS_BUCKET", "UPLOADS_LOCAL"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    const { port } = server.address() as { port: number };
    process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "legacy-attachments";
    process.env.UPLOADS_LOCAL = "false";
    resetStorageForTests();
    const storage = getStorage();
    assert.ok(storage);

    const reads = 5;
    for (let i = 0; i < reads; i += 1) {
      const { truncated } = await readStreamPrefix(await storage.get(`attachments/server/object-${i}`), 64 * 1024);
      assert.equal(truncated, true);
    }
    const deadline = Date.now() + 2_000;
    while (openConnections > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(openConnections, 0, `${openConnections}/${reads} storage connections still open after prefix reads`);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStorageForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("attachments/v2 keys are written only where the dedicated attachment bucket exists", () => {
  const envKeys = [
    "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ATTACHMENTS_BUCKET",
    "S3_DIRECT_UPLOAD_ENDPOINT", "S3_DIRECT_UPLOAD_REGION", "S3_DIRECT_UPLOAD_ACCESS_KEY_ID",
    "S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY", "S3_DIRECT_UPLOAD_BUCKET", "UPLOADS_LOCAL",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const setLegacyS3 = () => {
    process.env.S3_ENDPOINT = "https://legacy-storage.example.test";
    process.env.S3_ACCESS_KEY_ID = "legacy-key";
    process.env.S3_SECRET_ACCESS_KEY = "legacy-secret";
    process.env.S3_ATTACHMENTS_BUCKET = "legacy-attachments";
  };
  try {
    for (const key of envKeys) delete process.env[key];

    // S3 without the dedicated bucket (e.g. a self-hosted deployment).
    setLegacyS3();
    resetStorageForTests();
    assert.equal(canWriteDedicatedAttachmentKeys(), false);

    // S3 with it.
    process.env.S3_DIRECT_UPLOAD_ENDPOINT = "https://direct-storage.example.test";
    process.env.S3_DIRECT_UPLOAD_ACCESS_KEY_ID = "direct-key";
    process.env.S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY = "direct-secret";
    process.env.S3_DIRECT_UPLOAD_BUCKET = "direct-attachments";
    resetStorageForTests();
    assert.equal(canWriteDedicatedAttachmentKeys(), true);

    // Local disk serves both namespaces from one root.
    for (const key of envKeys) delete process.env[key];
    resetStorageForTests();
    assert.equal(canWriteDedicatedAttachmentKeys(), true);
  } finally {
    resetStorageForTests();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
