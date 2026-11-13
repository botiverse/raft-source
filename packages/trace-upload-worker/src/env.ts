// Runtime environment and the minimal R2-shaped storage interface the handlers use.
import type { ScopeDbTraceEventProjectorClient } from "./traces/traceEventProjector";

type R2PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream;

interface R2PutOptions {
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

interface R2PutResult {
  etag?: string;
}

interface R2ObjectLike {
  body: ReadableStream | null;
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

interface R2BucketLike {
  put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2PutResult | null | undefined>;
  get?(key: string): Promise<R2ObjectLike | null>;
}

export interface TraceUploadRuntimeEnv {
  SCOPE_ATTESTATION_SECRET: string;
  TRACE_UPLOAD_WORKER_SECRET?: string;
  TRACE_UPLOAD_MAX_BYTES?: string;
  TRACE_INGEST_OTLP_ENDPOINT?: string;
  TRACE_INGEST_OTLP_AUTHORIZATION?: string;
  TRACE_INGEST_SERVICE_NAME?: string;
  TRACE_INGEST_BATCH_SIZE?: string;
  TRACE_INGEST_MAX_DECOMPRESSED_BYTES?: string;
  /** Max spans per (span name, UTC minute) forwarded from one trace bundle (default 500; `0` disables). */
  TRACE_INGEST_PER_MINUTE_CAP?: string;
  /** Same cap for standalone events (default 0 = off). */
  TRACE_INGEST_EVENT_PER_MINUTE_CAP?: string;
  /** Per-request timeout for OTLP sink posts, ms (default 10000, clamped 1000-55000 to stay under the ALB 60s idle timeout). */
  TRACE_INGEST_OTLP_TIMEOUT_MS?: string;
  /** Timeout for background bundle OTLP posts, ms (default 55000, clamped 1000-120000; not ALB-bound, no automatic replay). */
  TRACE_INGEST_BUNDLE_OTLP_TIMEOUT_MS?: string;
  TRACE_INGEST_FETCH?: typeof fetch;
  RAFT_TRACE_SCOPEDB_PROJECTOR?: string;
  SCOPEDB_TRACE_EVENTS_ENDPOINT?: string;
  SCOPEDB_TRACE_EVENTS_WRITE_KEY?: string;
  /** Test-only structural injection; production constructs the SDK client. */
  SCOPEDB_TRACE_EVENTS_CLIENT?: ScopeDbTraceEventProjectorClient;
  TRACE_WEB_MAX_BYTES?: string;
  TRACE_WEB_CORS_ORIGIN?: string;
  FEEDBACK_REPORT_MAX_BYTES?: string;
  FEEDBACK_REPORT_HOURLY_LIMIT?: string;
  TRACE_UPLOAD_HOURLY_LIMIT?: string;
  TRACE_UPLOAD_HOURLY_BYTES_LIMIT?: string;
  /** `observe` (default) logs uploads over the hourly budget; `enforce` answers 429. */
  TRACE_UPLOAD_RATE_LIMIT_MODE?: string;
  /** Bearer token for POST /api/external/github-refresh (antiproton). Unset = endpoint off (404). */
  EXTERNAL_GITHUB_REFRESH_TOKEN?: string;
  /** Bearer token for POST /api/external/antiproton-trace (antiproton agent trace rows). Unset = endpoint off (404). */
  EXTERNAL_ANTIPROTON_TRACE_TOKEN?: string;
  DEPLOYMENT_ENV?: string;
  SLOCK_RELEASE_SHA?: string;
}

export interface TraceUploadWorkerEnv extends TraceUploadRuntimeEnv {
  TRACE_BUNDLES: R2BucketLike;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
