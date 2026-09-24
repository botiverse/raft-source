import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TraceAttributes, Tracer } from "@botiverse/raft-shared";
import { noopTracer } from "@botiverse/raft-shared";
import { s3PutDuration, s3PutRequestsTotal, s3SocketPoolQueueLength, s3SocketPoolSaturationTotal, s3SocketPoolSocketsInUse } from "../metrics.js";

/**
 * Pattern the SDK uses to format its socket-pool saturation warning, e.g.
 *   `@smithy/node-http-handler:WARN - socket usage at capacity=50 and 111 additional requests are enqueued.`
 *
 * Source: @smithy/node-http-handler dist-es/node-http-handler.js — the warning
 * is emitted via the configured `logger.warn(...)`, throttled to once per 15s,
 * exactly when `socketsInUse >= maxSockets` AND `requestsEnqueued >= 2 * maxSockets`.
 * That is the SDK author's own "we are about to start stalling" threshold.
 *
 * Match is intentionally loose on whitespace and the trailing newline + URL,
 * but anchored on the literal `socket usage at capacity=` so we don't accept
 * unrelated `logger.warn` calls.
 */
const SDK_SOCKET_SATURATION_PATTERN = /socket usage at capacity=(\d+) and (\d+) additional requests are enqueued/;

/**
 * Build a smithy-shaped Logger that forwards every level to console (so we
 * preserve the operator-visible warning) and additionally increments the
 * dedicated saturation counter when `warn` matches the SDK's own
 * socket-pool-capacity message.
 */
export function buildSdkLoggerWithSaturationCounter(labels: { bucket: string; endpoint_host: string }) {
  return {
    trace: (...args: unknown[]) => console.trace(...args),
    debug: (...args: unknown[]) => console.debug(...args),
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => {
      try {
        const first = args[0];
        if (typeof first === "string" && SDK_SOCKET_SATURATION_PATTERN.test(first)) {
          s3SocketPoolSaturationTotal.labels(labels.bucket, labels.endpoint_host).inc();
        }
      } catch {
        // Never let the metric path swallow the warning itself.
      }
      console.warn(...args);
    },
    error: (...args: unknown[]) => console.error(...args),
  };
}
import { getCurrentTraceContext } from "../tracing/semanticTrace.js";

const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_S3_MAX_SOCKETS = 300;

export class StorageTimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number
  ) {
    super(`Storage ${operation} timed out after ${timeoutMs}ms`);
    this.name = "StorageTimeoutError";
  }
}

export function isStorageTimeoutError(error: unknown): error is StorageTimeoutError {
  return error instanceof StorageTimeoutError || (
    error instanceof Error && error.name === "StorageTimeoutError"
  );
}

export class StoragePreconditionFailedError extends Error {
  constructor(
    public readonly key: string,
    public readonly condition: StorageWriteCondition,
  ) {
    super(`Storage write precondition failed for ${key}`);
    this.name = "StoragePreconditionFailedError";
  }
}

export function isStoragePreconditionFailedError(error: unknown): error is StoragePreconditionFailedError {
  return error instanceof StoragePreconditionFailedError || (
    error instanceof Error && error.name === "StoragePreconditionFailedError"
  );
}

export function isStorageNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "File not found on disk") return true;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  return "$metadata" in error
    && (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

export type StorageWriteCondition =
  | { ifMatch: string; ifNoneMatch?: never }
  | { ifNoneMatch: "*"; ifMatch?: never };

export type VersionedStorageObject = {
  body: Readable;
  etag: string;
};

export type StorageWriteReceipt = {
  etag: string | null;
};

export function parseS3RequestTimeoutMs(raw = process.env.S3_REQUEST_TIMEOUT_MS): number {
  if (!raw) return DEFAULT_S3_REQUEST_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_S3_REQUEST_TIMEOUT_MS;
  return parsed;
}

export function parseS3MaxSockets(raw = process.env.S3_MAX_SOCKETS): number {
  if (!raw) return DEFAULT_S3_MAX_SOCKETS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_S3_MAX_SOCKETS;
  return parsed;
}

function describeStorageError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const maybeCode = "code" in error ? (error as { code?: unknown }).code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(maybeCode ? { code: maybeCode } : {}),
    };
  }
  return { message: String(error) };
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}

function countAgentEntries(entries: Record<string, unknown[] | undefined>): number {
  return Object.values(entries).reduce((total, values) => total + (values?.length ?? 0), 0);
}

export interface StorageBackend {
  /** Store a file. Returns the storage key. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Store a bounded stream when the exact content length is known in advance. */
  putStream?(
    key: string,
    data: Readable,
    contentType: string,
    contentLength: number,
  ): Promise<void>;
  /** Store a file only when the supplied ETag/create condition still holds. */
  putConditional?(
    key: string,
    data: Buffer,
    contentType: string,
    condition: StorageWriteCondition,
  ): Promise<StorageWriteReceipt>;
  /** Get a readable stream for a file. */
  get(key: string): Promise<Readable>;
  /** Get a readable stream and the strong object version used for conditional writes. */
  getVersioned?(key: string): Promise<VersionedStorageObject>;
  /** Get a readable stream for a byte range. Local/dev storage uses this for media previews. */
  getRange?(key: string, start: number, end: number): Promise<Readable>;
  /** Delete a file. */
  delete(key: string): Promise<void>;
  /** Read server-trusted object metadata without downloading the body. */
  head?(key: string): Promise<{
    sizeBytes: number;
    contentType: string | null;
    etag: string | null;
  } | null>;
  /** Get a presigned URL for direct access (S3 only, returns null for local storage). */
  getPresignedUrl?(
    key: string,
    options?: {
      expiresIn?: number;
      responseContentDisposition?: string;
      responseContentType?: string;
    }
  ): Promise<string>;
  /** Get a presigned URL for direct upload (S3 only, returns null/undefined for local storage). */
  getPresignedPutUrl?(
    key: string,
    options?: {
      expiresIn?: number;
      contentType?: string;
      ifNoneMatch?: "*";
    }
  ): Promise<string>;
}

/**
 * Immutable namespace for objects that live in the dedicated browser-direct
 * upload bucket. The prefix is persisted as part of attachment storage keys,
 * so every later read and lifecycle operation can resolve the physical
 * backend without copying bytes back to the legacy attachment bucket.
 */
export const ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX = "attachments/v1/";

export function isAttachmentDirectUploadStorageKey(key: string): boolean {
  return key.startsWith(ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX);
}

const VERSIONED_ATTACHMENT_STORAGE_KEY_PATTERN = /^attachments\/v\d+\//;

export class UnknownAttachmentStorageRouteError extends Error {
  constructor() {
    super("Attachment storage key uses an unsupported versioned namespace");
    this.name = "UnknownAttachmentStorageRouteError";
  }
}

export class AttachmentDirectUploadStorageUnavailableError extends Error {
  constructor() {
    super("Dedicated direct-upload attachment storage is unavailable");
    this.name = "AttachmentDirectUploadStorageUnavailableError";
  }
}

function requireStorageOperation<K extends keyof StorageBackend>(
  storage: StorageBackend,
  operation: K,
): NonNullable<StorageBackend[K]> {
  const implementation = storage[operation];
  if (typeof implementation !== "function") {
    throw new Error(`Storage backend does not support ${String(operation)}`);
  }
  return implementation.bind(storage) as NonNullable<StorageBackend[K]>;
}

/**
 * Route immutable direct-upload keys to their dedicated bucket while keeping
 * historical keys on the legacy attachment backend. Optional capabilities
 * are exposed only when both physical backends support them, preserving the
 * capability checks used by callers such as media range reads and CAS writes.
 */
export function createAttachmentStorageRouter(
  legacy: StorageBackend,
  directUpload: StorageBackend | null,
): StorageBackend {
  const backendFor = (key: string) => {
    if (isAttachmentDirectUploadStorageKey(key)) {
      if (!directUpload) throw new AttachmentDirectUploadStorageUnavailableError();
      return directUpload;
    }
    // Versioned attachment namespaces are storage routing contracts. A future
    // or malformed version must never drift into the legacy bucket.
    if (VERSIONED_ATTACHMENT_STORAGE_KEY_PATTERN.test(key)) {
      throw new UnknownAttachmentStorageRouteError();
    }
    return legacy;
  };
  const routed: StorageBackend = {
    put: (key, data, contentType) => backendFor(key).put(key, data, contentType),
    get: (key) => backendFor(key).get(key),
    delete: (key) => backendFor(key).delete(key),
  };

  if (legacy.putStream && (!directUpload || directUpload.putStream)) {
    routed.putStream = (key, data, contentType, contentLength) =>
      requireStorageOperation(backendFor(key), "putStream")(key, data, contentType, contentLength);
  }

  if (legacy.putConditional && (!directUpload || directUpload.putConditional)) {
    routed.putConditional = (key, data, contentType, condition) =>
      requireStorageOperation(backendFor(key), "putConditional")(key, data, contentType, condition);
  }
  if (legacy.getVersioned && (!directUpload || directUpload.getVersioned)) {
    routed.getVersioned = (key) => requireStorageOperation(backendFor(key), "getVersioned")(key);
  }
  if (legacy.getRange && (!directUpload || directUpload.getRange)) {
    routed.getRange = (key, start, end) => requireStorageOperation(backendFor(key), "getRange")(key, start, end);
  }
  if (legacy.head && (!directUpload || directUpload.head)) {
    routed.head = (key) => requireStorageOperation(backendFor(key), "head")(key);
  }
  if (legacy.getPresignedUrl && (!directUpload || directUpload.getPresignedUrl)) {
    routed.getPresignedUrl = (key, options) =>
      requireStorageOperation(backendFor(key), "getPresignedUrl")(key, options);
  }
  if (legacy.getPresignedPutUrl && (!directUpload || directUpload.getPresignedPutUrl)) {
    routed.getPresignedPutUrl = (key, options) =>
      requireStorageOperation(backendFor(key), "getPresignedPutUrl")(key, options);
  }

  return routed;
}

// --- Local disk storage ---

class LocalStorage implements StorageBackend {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private resolveSafe(key: string): string {
    const resolved = path.resolve(this.dir, key);
    if (!resolved.startsWith(this.dir + path.sep) && resolved !== this.dir) {
      throw new Error("Path traversal detected");
    }
    return resolved;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const filePath = this.resolveSafe(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  async putStream(
    key: string,
    data: Readable,
    _contentType: string,
    contentLength: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new Error("Storage stream content length is invalid");
    }
    const filePath = this.resolveSafe(key);
    const temporaryPath = `${filePath}.${randomUUID()}.part`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      await pipeline(data, fs.createWriteStream(temporaryPath, { flags: "wx" }));
      if (fs.statSync(temporaryPath).size !== contentLength) {
        throw new Error("Storage stream content length did not match its declaration");
      }
      fs.renameSync(temporaryPath, filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  async putConditional(
    key: string,
    data: Buffer,
    _contentType: string,
    condition: StorageWriteCondition,
  ): Promise<StorageWriteReceipt> {
    const filePath = this.resolveSafe(key);
    const exists = fs.existsSync(filePath);
    if ("ifNoneMatch" in condition) {
      if (exists) throw new StoragePreconditionFailedError(key, condition);
    } else {
      if (!exists) throw new StoragePreconditionFailedError(key, condition);
      const currentEtag = this.etag(fs.readFileSync(filePath));
      if (currentEtag !== condition.ifMatch) {
        throw new StoragePreconditionFailedError(key, condition);
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    return { etag: this.etag(data) };
  }

  async get(key: string): Promise<Readable> {
    const filePath = this.resolveSafe(key);
    if (!fs.existsSync(filePath)) {
      throw new Error("File not found on disk");
    }
    return fs.createReadStream(filePath);
  }

  async getVersioned(key: string): Promise<VersionedStorageObject> {
    const filePath = this.resolveSafe(key);
    if (!fs.existsSync(filePath)) {
      throw new Error("File not found on disk");
    }
    const data = fs.readFileSync(filePath);
    return {
      body: Readable.from(data),
      etag: this.etag(data),
    };
  }

  async getRange(key: string, start: number, end: number): Promise<Readable> {
    const filePath = this.resolveSafe(key);
    if (!fs.existsSync(filePath)) {
      throw new Error("File not found on disk");
    }
    return fs.createReadStream(filePath, { start, end });
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveSafe(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  async head(key: string): Promise<{ sizeBytes: number; contentType: string | null; etag: string | null } | null> {
    const filePath = this.resolveSafe(key);
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return { sizeBytes: stat.size, contentType: null, etag: null };
  }

  private etag(data: Buffer): string {
    return `"sha256:${createHash("sha256").update(data).digest("hex")}"`;
  }
}

// --- S3-compatible storage (R2, AWS S3, MinIO, etc.) ---

class S3Storage implements StorageBackend {
  private client: S3Client;
  private httpsAgent: HttpsAgent;
  private tracer: Tracer;
  private bucket: string;
  private endpointHost: string;
  private publicUrl: string | null;
  private requestTimeoutMs: number;
  private maxSockets: number;

  constructor(opts: {
    endpoint: string;
    region?: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl?: string;
    forcePathStyle?: boolean;
    requestTimeoutMs?: number;
    maxSockets?: number;
    tracer?: Tracer | null;
  }) {
    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_S3_REQUEST_TIMEOUT_MS;
    const maxSockets = opts.maxSockets ?? DEFAULT_S3_MAX_SOCKETS;
    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      maxSockets,
    });
    const bucket = opts.bucket;
    const endpoint_host = endpointHost(opts.endpoint);
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region || "auto",
      forcePathStyle: opts.forcePathStyle,
      // Direct-upload URLs are signed before the browser payload exists. The
      // SDK's WHEN_SUPPORTED default otherwise injects CRC32 for the empty
      // PutObjectCommand body, binding every presigned URL to an empty upload.
      requestChecksumCalculation: "WHEN_REQUIRED",
      requestHandler: new NodeHttpHandler({
        requestTimeout: requestTimeoutMs,
        throwOnRequestTimeout: true,
        httpsAgent: this.httpsAgent,
      }),
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      // Inject a custom logger so the SDK's own once-per-15s socket-pool
      // saturation warning becomes a Prometheus-counted incident signal.
      // Forwards normal logging to console unchanged.
      logger: buildSdkLoggerWithSaturationCounter({ bucket, endpoint_host }),
    });
    this.tracer = opts.tracer ?? noopTracer;
    this.bucket = bucket;
    this.endpointHost = endpoint_host;
    this.publicUrl = opts.publicUrl || null;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxSockets = maxSockets;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.putObject(key, data, contentType);
  }

  async putStream(
    key: string,
    data: Readable,
    contentType: string,
    contentLength: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new Error("Storage stream content length is invalid");
    }
    await this.putObject(key, data, contentType, undefined, contentLength);
  }

  async putConditional(
    key: string,
    data: Buffer,
    contentType: string,
    condition: StorageWriteCondition,
  ): Promise<StorageWriteReceipt> {
    return this.putObject(key, data, contentType, condition);
  }

  private async putObject(
    key: string,
    data: Buffer | Readable,
    contentType: string,
    condition?: StorageWriteCondition,
    declaredContentLength?: number,
  ): Promise<StorageWriteReceipt> {
    const sizeBytes = Buffer.isBuffer(data) ? data.byteLength : declaredContentLength;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("Storage object content length is invalid");
    }
    const start = Date.now();
    const span = this.tracer.startSpan("server.storage.s3.put", {
      parent: getCurrentTraceContext(),
      surface: "server",
      kind: "client",
      attrs: {
        storage_provider: "s3",
        endpoint_host: this.endpointHost,
        bucket: this.bucket,
        key,
        size_bytes: sizeBytes,
        content_type: contentType,
        request_timeout_ms: this.requestTimeoutMs,
        max_sockets: this.maxSockets,
        ...this.socketPoolAttrs("start"),
      },
    });
    const metricLabels = { bucket: this.bucket, endpoint_host: this.endpointHost };
    s3PutRequestsTotal.labels(metricLabels.bucket, metricLabels.endpoint_host, "started").inc();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.requestTimeoutMs);
    try {
      const response = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentLength: sizeBytes,
        ContentType: contentType,
        ...(!condition
          ? {}
          : "ifMatch" in condition
            ? { IfMatch: condition.ifMatch }
            : { IfNoneMatch: condition.ifNoneMatch }),
      }), { abortSignal: abortController.signal });
      const durationMs = Date.now() - start;
      s3PutRequestsTotal.labels(metricLabels.bucket, metricLabels.endpoint_host, "ok").inc();
      s3PutDuration.labels(metricLabels.bucket, metricLabels.endpoint_host, "ok").observe(durationMs / 1000);
      this.recordSocketPoolMetrics();
      span.addEvent("storage.s3.put.finished", {
        event_kind: "storage_s3_put",
        duration_ms: durationMs,
        outcome: "ok",
        reason: "put_completed",
        ...this.socketPoolAttrs("finish"),
      });
      span.end("ok", {
        attrs: {
          event_kind: "storage_s3_put",
          duration_ms: durationMs,
          outcome: "ok",
          reason: "put_completed",
          ...this.socketPoolAttrs("end"),
        },
      });
      return { etag: response.ETag ?? null };
    } catch (err) {
      const timedOut = abortController.signal.aborted;
      const durationMs = Date.now() - start;
      const httpStatusCode = typeof err === "object" && err !== null && "$metadata" in err
        ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (condition && (httpStatusCode === 409 || httpStatusCode === 412)) {
        const outcome = "precondition_failed";
        s3PutRequestsTotal.labels(metricLabels.bucket, metricLabels.endpoint_host, outcome).inc();
        s3PutDuration.labels(metricLabels.bucket, metricLabels.endpoint_host, outcome).observe(durationMs / 1000);
        this.recordSocketPoolMetrics();
        const traceAttrs: TraceAttributes = {
          event_kind: "storage_s3_put",
          duration_ms: durationMs,
          outcome,
          reason: "write_precondition_failed",
          http_status_code: httpStatusCode,
          error_class: err instanceof Error ? err.name : typeof err,
          ...this.socketPoolAttrs("conflict"),
        };
        span.addEvent("storage.s3.put.precondition_failed", traceAttrs);
        span.end("error", { attrs: traceAttrs });
        throw new StoragePreconditionFailedError(key, condition);
      }
      const outcome = timedOut ? "timeout" : "error";
      s3PutRequestsTotal.labels(metricLabels.bucket, metricLabels.endpoint_host, outcome).inc();
      s3PutDuration.labels(metricLabels.bucket, metricLabels.endpoint_host, outcome).observe(durationMs / 1000);
      this.recordSocketPoolMetrics();
      const traceAttrs: TraceAttributes = {
        event_kind: "storage_s3_put",
        duration_ms: durationMs,
        outcome,
        reason: timedOut ? "request_timeout" : "put_failed",
        timed_out: timedOut,
        error_class: err instanceof Error ? err.name : typeof err,
        ...this.socketPoolAttrs("error"),
      };
      span.addEvent("storage.s3.put.failed", traceAttrs);
      span.end("error", { attrs: traceAttrs });
      console.error("[Storage] S3 put failed", {
        bucket: this.bucket,
        endpointHost: this.endpointHost,
        key,
        sizeBytes,
        contentType,
        timedOut,
        timeoutMs: timedOut ? this.requestTimeoutMs : undefined,
        error: describeStorageError(err),
      });
      if (timedOut) {
        throw new StorageTimeoutError("put", this.requestTimeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private socketPoolAttrs(prefix: string): TraceAttributes {
    const stats = this.socketPoolStats();
    return {
      [`${prefix}_socket_pool_busy_sockets`]: stats.busySockets,
      [`${prefix}_socket_pool_queued_requests`]: stats.queuedRequests,
      [`${prefix}_socket_pool_free_sockets`]: stats.freeSockets,
      [`${prefix}_socket_pool_max_sockets`]: this.maxSockets,
    };
  }

  private socketPoolStats(): { busySockets: number; queuedRequests: number; freeSockets: number } {
    return {
      busySockets: countAgentEntries(this.httpsAgent.sockets),
      queuedRequests: countAgentEntries(this.httpsAgent.requests),
      freeSockets: countAgentEntries(this.httpsAgent.freeSockets),
    };
  }

  private recordSocketPoolMetrics(): void {
    const stats = this.socketPoolStats();
    s3SocketPoolSocketsInUse.labels(this.bucket, this.endpointHost).set(stats.busySockets);
    s3SocketPoolQueueLength.labels(this.bucket, this.endpointHost).set(stats.queuedRequests);
  }

  async get(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    if (!response.Body) throw new Error("Empty response from S3");
    return response.Body as Readable;
  }

  async getVersioned(key: string): Promise<VersionedStorageObject> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    if (!response.Body) throw new Error("Empty response from S3");
    if (!response.ETag) throw new Error("S3 response did not include an ETag");
    return {
      body: response.Body as Readable,
      etag: response.ETag,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async head(key: string): Promise<{ sizeBytes: number; contentType: string | null; etag: string | null } | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      if (response.ContentLength === undefined) {
        throw new Error("S3 HeadObject omitted ContentLength");
      }
      return {
        sizeBytes: response.ContentLength,
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
      const name = (err as { name?: string } | null)?.name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
      throw err;
    }
  }

  async getPresignedUrl(
    key: string,
    options?: {
      expiresIn?: number;
      responseContentDisposition?: string;
      responseContentType?: string;
    }
  ): Promise<string> {
    const expiresIn = options?.expiresIn ?? 3600;
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options?.responseContentDisposition,
      ResponseContentType: options?.responseContentType,
    }), { expiresIn });
  }

  async getPresignedPutUrl(
    key: string,
    options?: {
      expiresIn?: number;
      contentType?: string;
      ifNoneMatch?: "*";
    }
  ): Promise<string> {
    const expiresIn = options?.expiresIn ?? 3600;
    const signableHeaders = new Set<string>();
    if (options?.contentType) signableHeaders.add("content-type");
    if (options?.ifNoneMatch) signableHeaders.add("if-none-match");
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options?.contentType,
      IfNoneMatch: options?.ifNoneMatch,
    }), { expiresIn, signableHeaders });
  }

}

// --- Orphan cleanup ---

import { lt, isNull, and, eq } from "drizzle-orm";
import { getDb, type Database } from "../db/index.js";
import { attachments } from "../db/schema.js";

const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function cleanupLegacyOrphanAttachmentsWithDependencies(input: {
  db: Database;
  now: Date;
  beforeCandidateLock?: (projectionId: string) => Promise<void>;
  afterProjectionDeleteBeforeCommit?: (projectionId: string) => Promise<void>;
}): Promise<number> {
  const cutoff = new Date(input.now.getTime() - ORPHAN_MAX_AGE_MS);
  const candidates = await input.db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(
      isNull(attachments.messageId),
      isNull(attachments.objectId),
      lt(attachments.createdAt, cutoff),
    ));

  let cleaned = 0;
  for (const candidate of candidates) {
    await input.beforeCandidateLock?.(candidate.id);
    const deleted = await input.db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: attachments.id })
        .from(attachments)
        .where(and(
          eq(attachments.id, candidate.id),
          isNull(attachments.messageId),
          isNull(attachments.objectId),
          lt(attachments.createdAt, cutoff),
        ))
        .for("update", { of: attachments, skipLocked: true })
        .limit(1);
      if (!locked) return false;
      const rows = await tx.delete(attachments).where(and(
        eq(attachments.id, locked.id),
        isNull(attachments.messageId),
        isNull(attachments.objectId),
      )).returning({ id: attachments.id });
      if (rows.length !== 1) return false;
      await input.afterProjectionDeleteBeforeCommit?.(locked.id);
      return true;
    });
    if (deleted) cleaned += 1;
  }

  // Deliberately no storage/CDN capability exists in this legacy path. New
  // object-backed uploads are owned by reservation + tokenized object GC;
  // historical objectless rows may leak bytes until inventory migration, but
  // can no longer delete bytes underneath a concurrent send or key reuse.
  if (cleaned > 0) console.log(`[Storage] Cleaned up ${cleaned} legacy orphaned attachments`);
  return cleaned;
}

export async function cleanupOrphanAttachments(): Promise<number> {
  return cleanupLegacyOrphanAttachmentsWithDependencies({ db: getDb(), now: new Date() });
}

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // Run every 15 minutes
let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startOrphanCleanup(): void {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    cleanupOrphanAttachments().catch((err) =>
      console.error("[Storage] Orphan cleanup error:", err)
    );
  }, CLEANUP_INTERVAL_MS);
  // Run once immediately
  cleanupOrphanAttachments().catch((err) =>
    console.error("[Storage] Initial orphan cleanup error:", err)
  );
}

// --- Singletons ---

let _storage: StorageBackend | null = null;
let _storageResolved = false;
let _storageTracer: Tracer | null = null;
let _directUploadStorage: StorageBackend | null = null;
let _directUploadStorageResolved = false;

export function setStorageTracer(tracer: Tracer | null): void {
  _storageTracer = tracer;
}

/**
 * Returns the storage backend, or null if uploads are disabled.
 *
 * Resolution order:
 * 1. S3 env vars set → S3Storage
 * 2. UPLOADS_LOCAL !== "false" → LocalStorage (default: enabled)
 * 3. Otherwise → null (uploads disabled)
 */
export function getStorage(): StorageBackend | null {
  if (_storageResolved) return _storage;
  _storageResolved = true;

  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3Region = process.env.S3_REGION || "auto";
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_ATTACHMENTS_BUCKET;
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  if (s3Endpoint && s3AccessKey && s3SecretKey && s3Bucket) {
    console.log(`[Storage] Using S3: ${s3Endpoint} / ${s3Bucket}`);
    const legacyStorage = new S3Storage({
      endpoint: s3Endpoint,
      region: s3Region,
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      bucket: s3Bucket,
      publicUrl: process.env.S3_PUBLIC_URL,
      forcePathStyle: s3ForcePathStyle,
      requestTimeoutMs: parseS3RequestTimeoutMs(),
      maxSockets: parseS3MaxSockets(),
      tracer: _storageTracer,
    });
    _storage = createAttachmentStorageRouter(legacyStorage, getDirectUploadStorage());
  } else if (process.env.UPLOADS_LOCAL !== "false") {
    const dir = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads"));
    console.log(`[Storage] Using local disk: ${dir}`);
    const legacyStorage = new LocalStorage(dir);
    _storage = createAttachmentStorageRouter(legacyStorage, getDirectUploadStorage());
  } else {
    console.log(`[Storage] Uploads disabled (no S3 configured, UPLOADS_LOCAL=false)`);
    _storage = null;
  }

  return _storage;
}

/**
 * Dedicated S3-compatible backend for browser-direct attachment uploads.
 * Every setting is explicit: this path deliberately never inherits or falls
 * back to the legacy attachment bucket or its credentials.
 */
export function getDirectUploadStorage(): StorageBackend | null {
  if (_directUploadStorageResolved) return _directUploadStorage;
  _directUploadStorageResolved = true;

  const config = {
    endpoint: process.env.S3_DIRECT_UPLOAD_ENDPOINT,
    region: process.env.S3_DIRECT_UPLOAD_REGION || "auto",
    accessKeyId: process.env.S3_DIRECT_UPLOAD_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY,
    bucket: process.env.S3_DIRECT_UPLOAD_BUCKET,
    forcePathStyle: process.env.S3_DIRECT_UPLOAD_FORCE_PATH_STYLE === "true",
  };
  const required = [
    ["S3_DIRECT_UPLOAD_ENDPOINT", config.endpoint],
    ["S3_DIRECT_UPLOAD_ACCESS_KEY_ID", config.accessKeyId],
    ["S3_DIRECT_UPLOAD_SECRET_ACCESS_KEY", config.secretAccessKey],
    ["S3_DIRECT_UPLOAD_BUCKET", config.bucket],
  ] as const;
  const configuredCount = required.filter(([, value]) => Boolean(value)).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== required.length) {
    console.warn("[Storage] Direct-upload bucket configuration is incomplete; direct uploads are disabled", {
      missing: required.filter(([, value]) => !value).map(([name]) => name),
    });
    return null;
  }

  console.log(`[Storage] Direct-upload S3 bucket: ${config.endpoint} / ${config.bucket}`);
  _directUploadStorage = new S3Storage({
    endpoint: config.endpoint!,
    region: config.region,
    accessKeyId: config.accessKeyId!,
    secretAccessKey: config.secretAccessKey!,
    bucket: config.bucket!,
    forcePathStyle: config.forcePathStyle,
    requestTimeoutMs: parseS3RequestTimeoutMs(),
    maxSockets: parseS3MaxSockets(),
    tracer: _storageTracer,
  });
  return _directUploadStorage;
}

export function resetStorageForTests(): void {
  _storage = null;
  _storageResolved = false;
  _directUploadStorage = null;
  _directUploadStorageResolved = false;
  _cdnStorage = null;
  _cdnStorageResolved = false;
}

export function __setStorageForTests(storage: StorageBackend | null): void {
  _storage = storage;
  _storageResolved = true;
}

export function __setDirectUploadStorageForTests(storage: StorageBackend | null): void {
  _directUploadStorage = storage;
  _directUploadStorageResolved = true;
}

/** Test seam for the separate public thumbnail/avatar bucket. */
export function __setCdnStorageForTests(storage: StorageBackend | null): void {
  _cdnStorage = storage;
  _cdnStorageResolved = true;
}

let _cdnStorage: StorageBackend | null = null;
let _cdnStorageResolved = false;

/**
 * Returns the CDN storage backend for public thumbnails.
 * Uses S3_CDN_BUCKET (same credentials as main storage, different bucket).
 * Falls back to main storage if S3_CDN_BUCKET is not set.
 */
export function getCdnStorage(): StorageBackend | null {
  if (_cdnStorageResolved) return _cdnStorage;
  _cdnStorageResolved = true;

  const cdnBucket = process.env.S3_CDN_BUCKET;
  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3Region = process.env.S3_REGION || "auto";
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY;
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  if (cdnBucket && s3Endpoint && s3AccessKey && s3SecretKey) {
    console.log(`[Storage] CDN bucket: ${s3Endpoint} / ${cdnBucket}`);
    _cdnStorage = new S3Storage({
      endpoint: s3Endpoint,
      region: s3Region,
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      bucket: cdnBucket,
      forcePathStyle: s3ForcePathStyle,
      requestTimeoutMs: parseS3RequestTimeoutMs(),
      maxSockets: parseS3MaxSockets(),
      tracer: _storageTracer,
    });
  } else {
    // Fall back to main storage (thumbnails stored in same bucket)
    _cdnStorage = getStorage();
  }

  return _cdnStorage;
}
