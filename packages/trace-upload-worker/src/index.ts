import {
  ScopeDbTraceEventProjector,
  TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
  type ProjectableTraceRecord,
  type ScopeDbTraceEventProjectorClient,
  type TraceProjectionResource,
  type TraceProjectionSkipReasonClass,
} from "./traceEventProjector.js";

const TRACE_UPLOAD_SCOPE = "daemon-trace-bundle:create";
const TRACE_UPLOAD_AUDIENCE = "trace-ingest-worker";
const SESSION_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const FEEDBACK_REPORT_SCOPE = "feedback-report:create";
const FEEDBACK_REPORT_AUDIENCE = "feedback-worker";
const FEEDBACK_REPORT_MAX_BYTES = 250 * 1024 * 1024;
const FEEDBACK_REPORT_HOURLY_LIMIT = 100;
const WEB_TRACE_UPLOAD_SCOPE = "web-trace-batch:create";
const WEB_TRACE_MAX_BYTES = 512 * 1024;
const WEB_TRACE_MAX_RECORDS = 1_000;
const FEEDBACK_REPORT_CORS_METHODS = "POST, PUT, OPTIONS";
const DEFAULT_INGEST_BATCH_SIZE = 128;
const DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
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
  DEPLOYMENT_ENV?: string;
  SLOCK_RELEASE_SHA?: string;
  // slock-feedback-admin webhook (best-effort fan-out from R2 + ledger writes
  // to a Botiverse-internal management UI's D1 projection). Both unset = no-op.
  // See README in botiverse/slock-feedback-admin for the receiver contract.
  FEEDBACK_ADMIN_WEBHOOK_URL?: string;
  FEEDBACK_ADMIN_WEBHOOK_SECRET?: string;
}

export interface TraceUploadWorkerEnv extends TraceUploadRuntimeEnv {
  TRACE_BUNDLES: R2BucketLike;
}

interface ScopeAttestationClaims {
  v: 1;
  typ: "scope-attestation";
  scope: string;
  sub: string;
  actorType?: "user" | "machine";
  machineId?: string | null;
  serverId: string;
  aud?: string | null;
  resource?: string | null;
  exp: number;
  metadata?: JsonObject;
}

interface TraceUploadSessionClaims {
  v: 1;
  typ: "trace-upload-session";
  uploadId: string;
  objectKey: string;
  bundleId: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  maxBytes: number;
  contentType: string;
  contentEncoding?: string;
  serverId: string;
  machineId: string;
  deploymentEnvironment?: string;
  feedbackReportId?: string;
  agentId?: string;
  exp: number;
}

interface FeedbackReportUploadSessionClaims {
  v: 1;
  typ: "feedback-report-upload-session";
  reportId: string;
  artifactId: string;
  objectKey: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  maxBytes: number;
  contentType: string;
  serverId: string;
  actorType: "user" | "machine";
  subjectId: string;
  machineId?: string;
  agentId?: string;
  source: string;
  // TOOTH-2 transport fields (F1–F4): propagate daemon-computed transcript
  // window coverage through the upload session so downstream surfaces
  // (R2 customMetadata / ledger / webhook / detail) can read it verbatim.
  // anchor_source is a closed enum; createdAt is NOT an allowed value.
  transcriptCoverage?: string;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
  transcriptTruncated?: "true" | "false";
  transcriptTruncationDirection?: "head" | "tail" | "window";
  transcriptAnchorSource?: string;
  exp: number;
}

interface FeedbackReportCompleteSessionClaims {
  v: 1;
  typ: "feedback-report-complete-session";
  reportId: string;
  artifactId: string;
  objectKey: string;
  serverId: string;
  exp: number;
}

type TraceBundleMetadata = {
  uploadId: string;
  bundleId: string;
  objectKey: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  serverId: string;
  machineId: string;
  deploymentEnvironment?: string;
  feedbackReportId?: string;
  agentId?: string;
  transcriptCoverage?: string;
  transcriptFirstEventAt?: string;
  transcriptLastEventAt?: string;
  transcriptTruncated?: "true" | "false";
  transcriptTruncationDirection?: "head" | "tail" | "window";
  transcriptAnchorSource?: string;
};

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface LocalTraceRecord extends ProjectableTraceRecord {
  type: "span";
  schema_version: number;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  surface: string;
  kind: string;
  status: string;
  start_time: string;
  end_time: string;
  duration_ms?: number;
  attrs?: JsonObject;
  events?: Array<{
    name: string;
    time: string;
    attrs?: JsonObject;
  }>;
}

type WebTraceRecord = LocalTraceRecord & {
  surface: "web";
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export default {
  fetch(request: Request, env: TraceUploadWorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request: Request, env: TraceUploadWorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/trace-bundles") {
      return await createTraceBundleUpload(request, env);
    }
    if (isFeedbackReportPath(url.pathname)) {
      if (request.method === "OPTIONS") {
        return feedbackReportCorsResponse(env, request);
      }
      if (request.method === "POST" && (url.pathname === "/api/feedback-reports" || url.pathname === "/api/reports")) {
        return await createFeedbackReportUpload(request, env);
      }
    }
    if (url.pathname === "/api/web-traces") {
      if (request.method === "OPTIONS") {
        return webTraceCorsResponse(env, request);
      }
      if (request.method === "POST") {
        return await ingestWebTraceBatch(request, env);
      }
    }
    const objectMatch = url.pathname.match(/^\/api\/trace-bundles\/([^/]+)\/object$/);
    if (request.method === "PUT" && objectMatch) {
      return await putTraceBundleObject(request, env, decodeURIComponent(objectMatch[1]), ctx);
    }
    const feedbackObjectMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/object$/);
    if (request.method === "PUT" && feedbackObjectMatch) {
      return await putFeedbackReportObject(request, env, decodeURIComponent(feedbackObjectMatch[1]));
    }
    const feedbackCompleteMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/complete$/);
    if (request.method === "POST" && feedbackCompleteMatch) {
      return await completeFeedbackReport(request, env, decodeURIComponent(feedbackCompleteMatch[1]), ctx);
    }
    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const headers = url.pathname === "/api/web-traces"
      ? webTraceCorsHeaders(env, request)
      : isFeedbackReportPath(url.pathname)
        ? feedbackReportCorsHeaders(env, request)
        : {};
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status, headers);
    }
    return jsonResponse({ error: "Internal server error" }, 500, headers);
  }
}

async function createFeedbackReportUpload(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObject(request);
  const attestation = readString(body.attestation, "attestation", 16 * 1024);
  const claims = await verifyScopeAttestation(attestation, env);
  validateFeedbackReportClaims(claims);

  const maxBytes = getConfiguredFeedbackReportMaxBytes(env);
  const bundleSha256 = readSha256(body.bundleSha256, "bundleSha256");
  const bundleSizeBytes = readInteger(body.bundleSizeBytes, "bundleSizeBytes", maxBytes);
  const contentType = readOptionalString(body.bundleContentType, "bundleContentType", 128) ?? "application/octet-stream";
  const filename = sanitizeObjectPathSegment(
    readOptionalString(body.bundleFilename, "bundleFilename", 256) ?? "feedback-bundle.bin",
  );
  const source = readOptionalString(body.source, "source", 64) ?? "unknown";
  const agentId = readOptionalString(body.agentId, "agentId", 128) ?? undefined;
  const subjectId = claims.actorType === "machine" ? claims.machineId ?? claims.sub : claims.sub;
  await enforceFeedbackReportRateLimit(env, {
    serverId: claims.serverId,
    actorType: claims.actorType === "machine" ? "machine" : "user",
    subjectId,
  });

  const reportId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const objectKey = `feedback-reports/${claims.serverId}/${reportId}/${artifactId}/${filename}`;

  const uploadSession: FeedbackReportUploadSessionClaims = {
    v: 1,
    typ: "feedback-report-upload-session",
    reportId,
    artifactId,
    objectKey,
    bundleSha256,
    bundleSizeBytes,
    maxBytes,
    contentType,
    serverId: claims.serverId,
    actorType: claims.actorType === "machine" ? "machine" : "user",
    subjectId,
    ...(claims.machineId ? { machineId: claims.machineId } : {}),
    ...(agentId ? { agentId } : {}),
    source,
    ...readWindowCoverageClaims(body.metadata),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const completeSession: FeedbackReportCompleteSessionClaims = {
    v: 1,
    typ: "feedback-report-complete-session",
    reportId,
    artifactId,
    objectKey,
    serverId: claims.serverId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const uploadToken = await signToken(uploadSession, getUploadSessionSecret(env));
  const completeToken = await signToken(completeSession, getUploadSessionSecret(env));
  const uploadUrl = new URL(`/api/feedback-reports/${encodeURIComponent(reportId)}/object`, request.url);
  uploadUrl.searchParams.set("token", uploadToken);

  await writeFeedbackReportLedger(env, uploadSession, {
    status: "pending",
    metadata: readOptionalJsonObject(body.metadata, "metadata") ?? undefined,
    title: readOptionalString(body.title, "title", 256) ?? undefined,
    descriptionPresent: typeof body.description === "string" && body.description.trim().length > 0,
  });

  return jsonResponse({
    id: reportId,
    artifactId,
    upload: {
      method: "PUT",
      url: uploadUrl.toString(),
      headers: {
        "Content-Type": contentType,
      },
    },
    completeToken,
    expiresAt: new Date(Math.min(uploadSession.exp, completeSession.exp) * 1000).toISOString(),
  }, 200, feedbackReportCorsHeaders(env, request));
}

async function putFeedbackReportObject(
  request: Request,
  env: TraceUploadWorkerEnv,
  reportId: string,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new HttpError(401, "Missing upload token");
  const claims = await verifyToken<FeedbackReportUploadSessionClaims>(token, getUploadSessionSecret(env));
  if (claims.typ !== "feedback-report-upload-session" || claims.reportId !== reportId) {
    throw new HttpError(401, "Invalid upload token");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isInteger(parsedContentLength) || parsedContentLength < 0) {
      throw new HttpError(400, "Invalid Content-Length");
    }
    if (parsedContentLength > claims.maxBytes) throw new HttpError(413, "Bundle exceeds maxBytes");
    if (parsedContentLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  }

  const body = await readRequestBodyWithLimit(request, claims.maxBytes);
  if (body.byteLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== claims.bundleSha256) throw new HttpError(400, "bundleSha256 mismatch");

  const result = await env.TRACE_BUNDLES.put(claims.objectKey, body, {
    httpMetadata: {
      contentType: claims.contentType,
    },
    customMetadata: {
      reportId: claims.reportId,
      artifactId: claims.artifactId,
      bundleSha256: claims.bundleSha256,
      bundleSizeBytes: String(claims.bundleSizeBytes),
      serverId: claims.serverId,
      actorType: claims.actorType,
      subjectId: claims.subjectId,
      source: claims.source,
      ...(claims.machineId ? { machineId: claims.machineId } : {}),
      ...(claims.agentId ? { agentId: claims.agentId } : {}),
      ...(claims.transcriptCoverage ? { transcriptCoverage: claims.transcriptCoverage } : {}),
      ...(claims.transcriptFirstEventAt ? { transcriptFirstEventAt: claims.transcriptFirstEventAt } : {}),
      ...(claims.transcriptLastEventAt ? { transcriptLastEventAt: claims.transcriptLastEventAt } : {}),
      ...(claims.transcriptTruncated ? { transcriptTruncated: claims.transcriptTruncated } : {}),
      ...(claims.transcriptTruncationDirection
        ? { transcriptTruncationDirection: claims.transcriptTruncationDirection }
        : {}),
      ...(claims.transcriptAnchorSource ? { transcriptAnchorSource: claims.transcriptAnchorSource } : {}),
    },
  });
  await writeFeedbackReportLedger(env, claims, { status: "uploaded" });

  return new Response(null, {
    status: 200,
    headers: {
      ...feedbackReportCorsHeaders(env, request),
      ...(result?.etag ? { etag: result.etag } : {}),
    },
  });
}

async function completeFeedbackReport(
  request: Request,
  env: TraceUploadWorkerEnv,
  reportId: string,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const body = await readJsonObject(request);
  const completeToken = readString(body.completeToken, "completeToken", 16 * 1024);
  const claims = await verifyToken<FeedbackReportCompleteSessionClaims>(completeToken, getUploadSessionSecret(env));
  if (claims.typ !== "feedback-report-complete-session" || claims.reportId !== reportId) {
    throw new HttpError(401, "Invalid complete token");
  }
  if (!env.TRACE_BUNDLES.get) throw new HttpError(409, "Feedback report upload has not completed");
  const uploadedLedger = await env.TRACE_BUNDLES.get(feedbackReportLedgerKey({
    serverId: claims.serverId,
    reportId: claims.reportId,
    artifactId: claims.artifactId,
  }));
  if (!uploadedLedger?.body) throw new HttpError(409, "Feedback report upload has not completed");
  const text = await new Response(uploadedLedger.body).text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(409, "Feedback report upload has not completed");
  }
  if (!isJsonObject(parsed)
    || parsed.status !== "uploaded"
    || parsed.object_key !== claims.objectKey
    || parsed.report_id !== claims.reportId
    || parsed.artifact_id !== claims.artifactId) {
    throw new HttpError(409, "Feedback report upload has not completed");
  }
  await writeFeedbackReportCompleteLedger(env, claims);

  // Best-effort fan-out to slock-feedback-admin (Botiverse-internal management
  // UI). Failure is logged, never propagated — the user-facing feedback PUT
  // succeeded the moment R2 + ledgers landed; the admin projection is a
  // downstream convenience. Source-of-truth is R2 customMetadata + ledger.
  emitFeedbackAdminWebhook(env, ctx, "feedback-report:created", {
    serverId: claims.serverId,
    reportId: claims.reportId,
    artifactId: claims.artifactId,
    agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : undefined,
    machineId: typeof parsed.machine_id === "string" ? parsed.machine_id : undefined,
    subjectId: typeof parsed.subject_id === "string" ? parsed.subject_id : undefined,
    actorType: typeof parsed.actor_type === "string" ? parsed.actor_type : undefined,
    source: typeof parsed.source === "string" ? parsed.source : undefined,
    transcriptCoverage: typeof parsed.transcript_coverage === "string" ? parsed.transcript_coverage : undefined,
    transcriptFirstEventAt:
      typeof parsed.transcript_first_event_at === "string" ? parsed.transcript_first_event_at : undefined,
    transcriptLastEventAt:
      typeof parsed.transcript_last_event_at === "string" ? parsed.transcript_last_event_at : undefined,
    transcriptTruncated:
      typeof parsed.transcript_truncated === "string" ? parsed.transcript_truncated : undefined,
    transcriptTruncationDirection:
      typeof parsed.transcript_truncation_direction === "string"
        ? parsed.transcript_truncation_direction
        : undefined,
    transcriptAnchorSource:
      typeof parsed.transcript_anchor_source === "string" ? parsed.transcript_anchor_source : undefined,
    bundleSha256: typeof parsed.bundle_sha256 === "string" ? parsed.bundle_sha256 : undefined,
    bundleSizeBytes: typeof parsed.bundle_size_bytes === "number" ? parsed.bundle_size_bytes : undefined,
    objectKey: claims.objectKey,
    deploymentEnvironment: env.DEPLOYMENT_ENV,
    // Webhook fires immediately after R2 PUT + ledger writes succeed, so
    // `now()` is within ~milliseconds of the real R2 LastModified. Lets the
    // mini-app populate its `r2_last_modified` column without an extra R2
    // head-object round-trip from the receiver side.
    r2LastModified: new Date().toISOString(),
  });

  return jsonResponse(
    { ok: true, id: claims.reportId, artifactId: claims.artifactId },
    200,
    feedbackReportCorsHeaders(env, request),
  );
}

// Best-effort outbound webhook to slock-feedback-admin's
// /internal/r2-write-event endpoint. No-op if either env var is unset (so
// dev / self-host / pre-rollout deploys don't emit). Failure path is
// console.warn only — never throws into the caller. ctx?.waitUntil keeps the
// fetch alive across the response edge for CF Workers; on Node/Fly we just
// fire-and-forget the promise.
function emitFeedbackAdminWebhook(
  env: TraceUploadWorkerEnv,
  ctx: ExecutionContextLike | undefined,
  event: "feedback-report:created" | "trace-bundle:created",
  payload: Record<string, unknown>,
): void {
  const url = env.FEEDBACK_ADMIN_WEBHOOK_URL;
  const secret = env.FEEDBACK_ADMIN_WEBHOOK_SECRET;
  if (!url || !secret) return;

  const body = JSON.stringify({ event, ...payload });
  const promise = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body,
  })
    .then((res) => {
      if (!res.ok) {
        console.warn(
          `[TraceUploadWorker] feedback-admin webhook ${event} returned ${res.status}`,
        );
      }
      // Drain body so the underlying connection can be reused / closed.
      return res.body ? res.body.cancel().catch(() => undefined) : undefined;
    })
    .catch((err) => {
      console.warn(
        `[TraceUploadWorker] feedback-admin webhook ${event} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(promise);
  } else {
    void promise;
  }
}

async function ingestWebTraceBatch(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObjectWithLimit(request, getConfiguredWebTraceMaxBytes(env));
  const attestation = readString(body.attestation, "attestation", 16 * 1024);
  const claims = await verifyScopeAttestation(attestation, env);
  validateWebTraceClaims(claims);

  const batchId = readOptionalString(body.batchId, "batchId", 128) ?? crypto.randomUUID();
  const records = readWebTraceRecords(body.records);
  const resourceAttrs = readOptionalJsonObject(body.resource, "resource") ?? {};

  if (env.TRACE_INGEST_OTLP_ENDPOINT) {
    await postWebTraceBatch(env, records, {
      batchId,
      serverId: claims.serverId,
      userId: claims.sub,
      resourceAttrs,
    });
  }

  const v2Projection = env.TRACE_INGEST_OTLP_ENDPOINT
    ? await projectV2BestEffort(env, records, webProjectionResource(env, claims.serverId, resourceAttrs))
    : projectorDisabledByMissingCanonicalSink(env);

  return jsonResponse({
    ok: true,
    batchId,
    spansIngested: env.TRACE_INGEST_OTLP_ENDPOINT ? records.length : 0,
    scopedbStatus: env.TRACE_INGEST_OTLP_ENDPOINT ? "success" : "skipped",
    v2ProjectorStatus: v2Projection.status,
    v2SpansProjected: v2Projection.spansProjected,
    v2RowsProjected: v2Projection.rowsProjected,
    v2SpansSkipped: v2Projection.spansSkipped,
    v2SkipReasonClasses: v2Projection.skipReasonClasses,
  }, 200, webTraceCorsHeaders(env, request));
}

async function createTraceBundleUpload(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObject(request);
  const attestation = readString(body.attestation, "attestation", 16 * 1024);
  const claims = await verifyScopeAttestation(attestation, env);
  validateTraceUploadClaims(claims);

  const metadata = claims.metadata ?? {};
  const uploadId = readString(metadata.uploadId, "attestation.metadata.uploadId", 128);
  const objectKey = readString(metadata.objectKey, "attestation.metadata.objectKey", 1024);
  const maxBytes = readInteger(metadata.maxBytes, "attestation.metadata.maxBytes", getConfiguredMaxBytes(env));
  const bundleId = readString(metadata.bundleId, "attestation.metadata.bundleId", 128);
  const bundleSha256 = readSha256(metadata.bundleSha256, "attestation.metadata.bundleSha256");
  const bundleSizeBytes = readInteger(metadata.bundleSizeBytes, "attestation.metadata.bundleSizeBytes", maxBytes);
  const contentType = readOptionalString(metadata.bundleContentType, "attestation.metadata.bundleContentType", 128) ?? "application/x-ndjson";
  const contentEncoding = readOptionalString(metadata.bundleContentEncoding, "attestation.metadata.bundleContentEncoding", 64) ?? undefined;
  const deploymentEnvironment = readOptionalString(
    metadata.deploymentEnvironment,
    "attestation.metadata.deploymentEnvironment",
    64,
  ) ?? undefined;
  const feedbackReportId = readOptionalString(metadata.feedbackReportId, "attestation.metadata.feedbackReportId", 128) ?? undefined;
  const agentId = readOptionalString(metadata.agentId, "attestation.metadata.agentId", 128) ?? undefined;

  if (readSha256(body.bundleSha256, "bundleSha256") !== bundleSha256) {
    throw new HttpError(400, "bundleSha256 does not match signed metadata");
  }
  if (readInteger(body.bundleSizeBytes, "bundleSizeBytes", maxBytes) !== bundleSizeBytes) {
    throw new HttpError(400, "bundleSizeBytes does not match signed metadata");
  }

  const session: TraceUploadSessionClaims = {
    v: 1,
    typ: "trace-upload-session",
    uploadId,
    objectKey,
    bundleId,
    bundleSha256,
    bundleSizeBytes,
    maxBytes,
    contentType,
    ...(contentEncoding ? { contentEncoding } : {}),
    serverId: claims.serverId,
    machineId: claims.machineId ?? "",
    ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
    ...(feedbackReportId ? { feedbackReportId } : {}),
    ...(agentId ? { agentId } : {}),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signToken(session, getUploadSessionSecret(env));
  const uploadUrl = new URL(`/api/trace-bundles/${encodeURIComponent(uploadId)}/object`, request.url);
  uploadUrl.searchParams.set("token", token);

  return jsonResponse({
    id: uploadId,
    upload: {
      method: "PUT",
      url: uploadUrl.toString(),
      headers: {
        "Content-Type": contentType,
        ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
      },
    },
  });
}

async function putTraceBundleObject(
  request: Request,
  env: TraceUploadWorkerEnv,
  uploadId: string,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new HttpError(401, "Missing upload token");
  const claims = await verifyToken<TraceUploadSessionClaims>(token, getUploadSessionSecret(env));
  if (claims.typ !== "trace-upload-session" || claims.uploadId !== uploadId) {
    throw new HttpError(401, "Invalid upload token");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isInteger(parsedContentLength) || parsedContentLength < 0) {
      throw new HttpError(400, "Invalid Content-Length");
    }
    if (parsedContentLength > claims.maxBytes) throw new HttpError(413, "Bundle exceeds maxBytes");
    if (parsedContentLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  }

  const body = await readRequestBodyWithLimit(request, claims.maxBytes);
  if (body.byteLength !== claims.bundleSizeBytes) throw new HttpError(400, "bundleSizeBytes mismatch");
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== claims.bundleSha256) throw new HttpError(400, "bundleSha256 mismatch");

  const result = await env.TRACE_BUNDLES.put(claims.objectKey, body, {
    httpMetadata: {
      contentType: claims.contentType,
      ...(claims.contentEncoding ? { contentEncoding: claims.contentEncoding } : {}),
    },
    customMetadata: {
      uploadId: claims.uploadId,
      bundleId: claims.bundleId,
      bundleSha256: claims.bundleSha256,
      bundleSizeBytes: String(claims.bundleSizeBytes),
      serverId: claims.serverId,
      machineId: claims.machineId,
      ...(claims.deploymentEnvironment ? { deploymentEnvironment: claims.deploymentEnvironment } : {}),
      ...(claims.feedbackReportId ? { feedbackReportId: claims.feedbackReportId } : {}),
      ...(claims.agentId ? { agentId: claims.agentId } : {}),
    },
  });
  await writeTraceUploadLedger(env, claims, {
    r2_status: "success",
    scopedb_status: env.TRACE_INGEST_OTLP_ENDPOINT ? "pending" : "skipped",
    v2_projector_status: initialV2ProjectorStatus(env),
  });
  await scheduleTraceBundleIngest(env, claims, ctx);

  // Only fan out to slock-feedback-admin when this trace-bundle is bound to a
  // feedback-report (i.e. the daemon collected it as part of a feedback flow).
  // Plain agent trace-bundles have no feedbackReportId and are not feedback
  // surface — skip them entirely so the admin D1 stays scoped to feedback.
  if (claims.feedbackReportId) {
    emitFeedbackAdminWebhook(env, ctx, "trace-bundle:created", {
      serverId: claims.serverId,
      feedbackReportId: claims.feedbackReportId,
      uploadId: claims.uploadId,
      machineId: claims.machineId,
      bundleId: claims.bundleId,
      agentId: claims.agentId,
      bundleSha256: claims.bundleSha256,
      bundleSizeBytes: claims.bundleSizeBytes,
      objectKey: claims.objectKey,
      deploymentEnvironment: claims.deploymentEnvironment ?? env.DEPLOYMENT_ENV,
      // Webhook fires after R2 PUT + ledger writes succeed; `now()` is within
      // ms of the real R2 LastModified for this trace-bundle.
      r2LastModified: new Date().toISOString(),
    });
  }

  return new Response(null, {
    status: 200,
    headers: {
      ...(result?.etag ? { etag: result.etag } : {}),
    },
  });
}

async function scheduleTraceBundleIngest(
  env: TraceUploadWorkerEnv,
  claims: TraceUploadSessionClaims,
  ctx?: ExecutionContextLike,
): Promise<void> {
  if (!env.TRACE_INGEST_OTLP_ENDPOINT) return;

  const metadata = {
    uploadId: claims.uploadId,
    bundleId: claims.bundleId,
    objectKey: claims.objectKey,
    bundleSha256: claims.bundleSha256,
    bundleSizeBytes: claims.bundleSizeBytes,
    serverId: claims.serverId,
    machineId: claims.machineId,
    deploymentEnvironment: claims.deploymentEnvironment,
    feedbackReportId: claims.feedbackReportId,
    agentId: claims.agentId,
  };
  const promise = ingestTraceBundleObject(env, metadata)
    .then(async (result) => {
      await writeTraceUploadLedger(env, metadata, {
        r2_status: "success",
        scopedb_status: "success",
        spans_ingested: result.spans_ingested,
        batches_sent: result.batches_sent,
        v2_projector_status: result.v2_projector_status,
        v2_spans_projected: result.v2_spans_projected,
        v2_rows_projected: result.v2_rows_projected,
        v2_spans_skipped: result.v2_spans_skipped,
        v2_skip_reason_classes: result.v2_skip_reason_classes,
        ...(result.v2_error_class ? { v2_error_class: result.v2_error_class } : {}),
      });
    })
    .catch(async (err) => {
      await writeTraceUploadLedger(env, metadata, {
        r2_status: "success",
        scopedb_status: "failed",
        v2_projector_status: "skipped",
        error_class: err instanceof Error ? err.name : "Error",
        error_message_present: err instanceof Error && Boolean(err.message),
      });
      console.warn("[TraceUploadWorker] trace bundle ingest failed:", err instanceof Error ? err.message : String(err));
    });
  ctx?.waitUntil(promise);
}

export async function ingestTraceBundleObject(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
): Promise<{
  spans_ingested: number;
  batches_sent: number;
  v2_projector_status: V2ProjectorStatus;
  v2_spans_projected: number;
  v2_rows_projected: number;
  v2_spans_skipped: number;
  v2_skip_reason_classes: readonly TraceProjectionSkipReasonClass[];
  v2_error_class?: string;
}> {
  if (!env.TRACE_INGEST_OTLP_ENDPOINT) {
    const v2 = projectorDisabledByMissingCanonicalSink(env);
    return {
      spans_ingested: 0,
      batches_sent: 0,
      v2_projector_status: v2.status,
      v2_spans_projected: 0,
      v2_rows_projected: 0,
      v2_spans_skipped: v2.spansSkipped,
      v2_skip_reason_classes: v2.skipReasonClasses,
      ...(v2.errorClass ? { v2_error_class: v2.errorClass } : {}),
    };
  }
  if (!env.TRACE_BUNDLES.get) throw new Error("TRACE_BUNDLES.get is required for ingest");

  const object = await env.TRACE_BUNDLES.get(metadata.objectKey);
  if (!object?.body) throw new Error("Trace bundle object not found");

  const contentEncoding = object.httpMetadata?.contentEncoding
    ?? object.customMetadata?.bundleContentEncoding
    ?? undefined;
  const rawBody = await readStreamWithLimit(object.body, metadata.bundleSizeBytes);
  if (rawBody.byteLength !== metadata.bundleSizeBytes) {
    throw new Error("Trace bundle size does not match ledger metadata");
  }
  const actualSha256 = await sha256Hex(rawBody);
  if (actualSha256 !== metadata.bundleSha256) {
    throw new Error("Trace bundle hash does not match ledger metadata");
  }
  const bytes = await readStreamWithLimit(
    maybeDecompressStream(new Response(rawBody).body!, contentEncoding),
    getConfiguredIngestMaxDecompressedBytes(env),
  );
  const records = parseTraceBundleRecords(new TextDecoder().decode(bytes));
  const batchSize = getConfiguredIngestBatchSize(env);
  let batchesSent = 0;
  let v2Status: V2ProjectorStatus = projectorConfigured(env) ? "success" : "skipped";
  let v2SpansProjected = 0;
  let v2RowsProjected = 0;
  let v2SpansSkipped = 0;
  const v2SkipReasonClasses = new Set<TraceProjectionSkipReasonClass>();
  let v2ErrorClass: string | undefined;

  for (let idx = 0; idx < records.length; idx += batchSize) {
    const batch = records.slice(idx, idx + batchSize);
    await postOtlpTraceBatch(env, batch, metadata);
    batchesSent += 1;
    const projection = await projectV2BestEffort(env, batch, daemonProjectionResource(env, metadata, records));
    v2SpansProjected += projection.spansProjected;
    v2RowsProjected += projection.rowsProjected;
    v2SpansSkipped += projection.spansSkipped;
    projection.skipReasonClasses.forEach((reason) => v2SkipReasonClasses.add(reason));
    if (projection.status === "failed") {
      v2Status = "failed";
      v2ErrorClass ??= projection.errorClass;
    } else if (projection.status === "skipped" && v2Status !== "failed") {
      v2Status = "skipped";
    }
  }

  return {
    spans_ingested: records.length,
    batches_sent: batchesSent,
    v2_projector_status: v2Status,
    v2_spans_projected: v2SpansProjected,
    v2_rows_projected: v2RowsProjected,
    v2_spans_skipped: v2SpansSkipped,
    v2_skip_reason_classes: [...v2SkipReasonClasses].sort(),
    ...(v2ErrorClass ? { v2_error_class: v2ErrorClass } : {}),
  };
}

async function writeTraceUploadLedger(
  env: TraceUploadWorkerEnv,
  metadata: TraceBundleMetadata,
  status: {
    r2_status: "success";
    scopedb_status: "pending" | "success" | "failed" | "skipped";
    v2_projector_status?: "pending" | V2ProjectorStatus;
    spans_ingested?: number;
    batches_sent?: number;
    v2_spans_projected?: number;
    v2_rows_projected?: number;
    v2_spans_skipped?: number;
    v2_skip_reason_classes?: readonly TraceProjectionSkipReasonClass[];
    v2_error_class?: string;
    error_class?: string;
    error_message_present?: boolean;
  },
): Promise<void> {
  const record = {
    type: "daemon_trace_upload",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    upload_id: metadata.uploadId,
    bundle_id: metadata.bundleId,
    object_key: metadata.objectKey,
    ledger_key: traceUploadLedgerKey(metadata),
    bundle_sha256: metadata.bundleSha256,
    bundle_size_bytes: metadata.bundleSizeBytes,
    server_id: metadata.serverId,
    machine_id: metadata.machineId,
    ...(metadata.deploymentEnvironment ? { deployment_environment: metadata.deploymentEnvironment } : {}),
    ...(metadata.feedbackReportId ? { feedback_report_id: metadata.feedbackReportId } : {}),
    ...(metadata.agentId ? { agent_id: metadata.agentId } : {}),
    span_key_identity: "serverId:machineId:bundleSha256:trace_id:span_id",
    ...status,
  };
  await env.TRACE_BUNDLES.put(traceUploadLedgerKey(metadata), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      uploadId: metadata.uploadId,
      bundleId: metadata.bundleId,
      bundleSha256: metadata.bundleSha256,
      serverId: metadata.serverId,
      machineId: metadata.machineId,
      ledgerType: "daemon-trace-upload",
      ...(metadata.feedbackReportId ? { feedbackReportId: metadata.feedbackReportId } : {}),
      ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
    },
  });
}

function traceUploadLedgerKey(metadata: { serverId: string; machineId: string; uploadId: string }): string {
  return `trace-ledgers/${metadata.serverId}/${metadata.machineId}/${metadata.uploadId}.json`;
}

async function postOtlpTraceBatch(
  env: TraceUploadWorkerEnv,
  records: readonly LocalTraceRecord[],
  metadata: TraceBundleMetadata,
): Promise<void> {
  const endpoint = normalizeOtlpTracesEndpoint(env.TRACE_INGEST_OTLP_ENDPOINT ?? "");
  const fetchImpl = env.TRACE_INGEST_FETCH ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(env.TRACE_INGEST_OTLP_AUTHORIZATION ? { Authorization: env.TRACE_INGEST_OTLP_AUTHORIZATION } : {}),
  };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(toOtlpPayload(env, records, metadata)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OTLP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

async function postWebTraceBatch(
  env: TraceUploadWorkerEnv,
  records: readonly WebTraceRecord[],
  metadata: {
    batchId: string;
    serverId: string;
    userId: string;
    resourceAttrs: JsonObject;
  },
): Promise<void> {
  const endpoint = normalizeOtlpTracesEndpoint(env.TRACE_INGEST_OTLP_ENDPOINT ?? "");
  const fetchImpl = env.TRACE_INGEST_FETCH ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(env.TRACE_INGEST_OTLP_AUTHORIZATION ? { Authorization: env.TRACE_INGEST_OTLP_AUTHORIZATION } : {}),
  };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(toWebOtlpPayload(env, records, metadata)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OTLP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

function toOtlpPayload(
  env: TraceUploadWorkerEnv,
  records: readonly LocalTraceRecord[],
  metadata: {
    uploadId: string;
    bundleId: string;
    bundleSha256: string;
    bundleSizeBytes: number;
    serverId: string;
    machineId: string;
    deploymentEnvironment?: string;
  },
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: compactAttributes({
            "service.name": env.TRACE_INGEST_SERVICE_NAME || "slock-daemon",
            "service.version": inferDaemonServiceVersion(records),
            "service.revision": env.SLOCK_RELEASE_SHA,
            "deployment.environment": metadata.deploymentEnvironment ?? env.DEPLOYMENT_ENV,
            "telemetry.sdk.name": "slock-daemon-local-trace-ingest",
            "slock.trace_upload.upload_id": metadata.uploadId,
            "slock.trace_upload.bundle_id": metadata.bundleId,
            "slock.trace_upload.bundle_sha256": metadata.bundleSha256,
            "slock.trace_upload.bundle_size_bytes": metadata.bundleSizeBytes,
            "slock.server_id": metadata.serverId,
            "slock.machine_id": metadata.machineId,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "@slock-ai/daemon" },
            spans: records.map((record) => toOtlpSpan(record, traceIngestSpanKey(metadata, record))),
          },
        ],
      },
    ],
  };
}

function inferDaemonServiceVersion(records: readonly LocalTraceRecord[]): string | undefined {
  for (const record of records) {
    const attrs = record.attrs ?? {};
    const version = stringAttr(attrs.daemon_version) ?? stringAttr(attrs.daemonVersion);
    if (version) return version;
  }
  return undefined;
}

type V2ProjectorStatus = "success" | "failed" | "skipped";

interface V2ProjectionResult {
  status: V2ProjectorStatus;
  spansProjected: number;
  rowsProjected: number;
  spansSkipped: number;
  skipReasonClasses: readonly TraceProjectionSkipReasonClass[];
  errorClass?: string;
}

function projectorConfigured(env: TraceUploadRuntimeEnv): boolean {
  return env.RAFT_TRACE_SCOPEDB_PROJECTOR === "on";
}

function projectorFlagInvalid(env: TraceUploadRuntimeEnv): boolean {
  const value = env.RAFT_TRACE_SCOPEDB_PROJECTOR;
  return value !== undefined && value !== "" && value !== "off" && value !== "on";
}

function initialV2ProjectorStatus(env: TraceUploadRuntimeEnv): "pending" | "failed" | "skipped" {
  if (projectorFlagInvalid(env)) return "failed";
  if (!projectorConfigured(env)) return "skipped";
  return env.TRACE_INGEST_OTLP_ENDPOINT ? "pending" : "failed";
}

function projectorDisabledByMissingCanonicalSink(env: TraceUploadRuntimeEnv): V2ProjectionResult {
  if (projectorFlagInvalid(env)) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorFlagInvalidError",
    };
  }
  if (!projectorConfigured(env)) {
    return { status: "skipped", spansProjected: 0, rowsProjected: 0, spansSkipped: 0, skipReasonClasses: [] };
  }
  return {
    status: "failed",
    spansProjected: 0,
    rowsProjected: 0,
    spansSkipped: 0,
    skipReasonClasses: [],
    errorClass: "CanonicalSinkUnconfiguredError",
  };
}

async function projectV2BestEffort(
  env: TraceUploadRuntimeEnv,
  records: readonly ProjectableTraceRecord[],
  resource: TraceProjectionResource,
): Promise<V2ProjectionResult> {
  if (projectorFlagInvalid(env)) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorFlagInvalidError",
    };
  }
  if (!projectorConfigured(env)) {
    return { status: "skipped", spansProjected: 0, rowsProjected: 0, spansSkipped: 0, skipReasonClasses: [] };
  }
  const endpoint = env.SCOPEDB_TRACE_EVENTS_ENDPOINT;
  const token = env.SCOPEDB_TRACE_EVENTS_WRITE_KEY;
  if (!endpoint || !token) {
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass: "ProjectorConfigurationError",
    };
  }
  try {
    const projector = new ScopeDbTraceEventProjector({
      endpoint,
      token,
      client: env.SCOPEDB_TRACE_EVENTS_CLIENT,
    });
    const result = await projector.project(records, resource);
    if (result.spansSkipped > 0) {
      console.warn("[TraceUploadWorker] V2 trace projection skipped invalid records", {
        error_class: TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
        spans_skipped: result.spansSkipped,
      });
      return {
        status: "failed",
        ...result,
        errorClass: TRACE_PROJECTION_RECORD_VALIDATION_ERROR,
      };
    }
    return { status: "success", ...result };
  } catch (error) {
    const errorClass = error instanceof Error && error.name ? error.name : "Error";
    console.warn("[TraceUploadWorker] V2 trace projection failed", { error_class: errorClass });
    return {
      status: "failed",
      spansProjected: 0,
      rowsProjected: 0,
      spansSkipped: 0,
      skipReasonClasses: [],
      errorClass,
    };
  }
}

function webProjectionResource(
  env: TraceUploadRuntimeEnv,
  serverId: string,
  resourceAttrs: JsonObject,
): TraceProjectionResource {
  return {
    serviceName: "slock-web",
    deploymentEnvironment: env.DEPLOYMENT_ENV,
    serviceVersion: versionAttr(resourceAttrs["service.version"]),
    serviceRevision: env.SLOCK_RELEASE_SHA,
    serverId,
  };
}

function daemonProjectionResource(
  env: TraceUploadRuntimeEnv,
  metadata: TraceBundleMetadata,
  records: readonly LocalTraceRecord[],
): TraceProjectionResource {
  return {
    serviceName: env.TRACE_INGEST_SERVICE_NAME || "slock-daemon",
    deploymentEnvironment: metadata.deploymentEnvironment ?? env.DEPLOYMENT_ENV,
    serviceVersion: versionAttr(inferDaemonServiceVersion(records)),
    serviceRevision: env.SLOCK_RELEASE_SHA,
    serverId: metadata.serverId,
    machineId: metadata.machineId,
    agentId: metadata.agentId,
  };
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function versionAttr(value: unknown): string | undefined {
  const version = stringAttr(value);
  if (!version || version.length > 64 || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) return undefined;
  return version;
}

function toWebOtlpPayload(
  env: TraceUploadWorkerEnv,
  records: readonly WebTraceRecord[],
  metadata: {
    batchId: string;
    serverId: string;
    userId: string;
    resourceAttrs: JsonObject;
  },
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: compactAttributes({
            ...metadata.resourceAttrs,
            "service.name": "slock-web",
            "service.revision": env.SLOCK_RELEASE_SHA,
            "deployment.environment": env.DEPLOYMENT_ENV,
            "telemetry.sdk.name": "slock-web-trace-upload",
            "slock.web_trace.batch_id": metadata.batchId,
            "slock.server_id": metadata.serverId,
            "slock.user_id": metadata.userId,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "@botiverse/raft-web" },
            spans: records.map((record) => toOtlpSpan(record, webTraceIngestSpanKey(metadata, record))),
          },
        ],
      },
    ],
  };
}

function toOtlpSpan(record: LocalTraceRecord, ingestSpanKey: string): JsonObject {
  const attrs = compactAttributes({
    ...(record.attrs ?? {}),
    "slock.surface": record.surface,
    "slock.duration_ms": record.duration_ms,
    "slock.schema_version": record.schema_version,
    "slock.trace_ingest.span_key": ingestSpanKey,
  });
  const events = (record.events ?? []).map((event) => {
    const eventAttrs = compactAttributes(event.attrs ?? {});
    return {
      timeUnixNano: isoToUnixNano(event.time),
      name: event.name,
      ...(eventAttrs.length > 0 ? { attributes: eventAttrs } : {}),
    };
  });

  return {
    traceId: record.trace_id,
    spanId: record.span_id,
    ...(record.parent_span_id ? { parentSpanId: record.parent_span_id } : {}),
    name: record.name,
    kind: toOtlpSpanKind(record.kind),
    startTimeUnixNano: isoToUnixNano(record.start_time),
    endTimeUnixNano: isoToUnixNano(record.end_time),
    ...(attrs.length > 0 ? { attributes: attrs } : {}),
    ...(events.length > 0 ? { events } : {}),
    status: toOtlpStatus(record.status),
  };
}

function traceIngestSpanKey(metadata: { serverId: string; machineId: string; bundleSha256: string }, record: LocalTraceRecord): string {
  return `${metadata.serverId}:${metadata.machineId}:${metadata.bundleSha256}:${record.trace_id}:${record.span_id}`;
}

function webTraceIngestSpanKey(metadata: { serverId: string; userId: string; batchId: string }, record: LocalTraceRecord): string {
  return `${metadata.serverId}:${metadata.userId}:${metadata.batchId}:${record.trace_id}:${record.span_id}`;
}

function parseTraceBundleRecords(text: string): LocalTraceRecord[] {
  const records: LocalTraceRecord[] = [];
  for (const [lineIdx, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid JSONL trace record at line ${lineIdx + 1}`);
    }
    if (!isLocalTraceRecord(parsed)) {
      throw new Error(`Invalid trace span record at line ${lineIdx + 1}`);
    }
    records.push(parsed);
  }
  return records;
}

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "Bundle exceeds maxBytes");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

async function verifyScopeAttestation(token: string, env: TraceUploadWorkerEnv): Promise<ScopeAttestationClaims> {
  return await verifyToken<ScopeAttestationClaims>(token, env.SCOPE_ATTESTATION_SECRET);
}

function validateTraceUploadClaims(claims: ScopeAttestationClaims): void {
  if (claims.typ !== "scope-attestation") throw new HttpError(401, "Invalid attestation type");
  if (claims.scope !== TRACE_UPLOAD_SCOPE) throw new HttpError(403, "Invalid attestation scope");
  if (claims.aud !== TRACE_UPLOAD_AUDIENCE) throw new HttpError(403, "Invalid attestation audience");
  if (!claims.serverId || !claims.machineId) throw new HttpError(403, "Missing trace upload identity");
  const expectedResource = `servers/${claims.serverId}/machines/${claims.machineId}/trace-bundles`;
  if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
}

function validateWebTraceClaims(claims: ScopeAttestationClaims): void {
  if (claims.typ !== "scope-attestation") throw new HttpError(401, "Invalid attestation type");
  if (claims.scope !== WEB_TRACE_UPLOAD_SCOPE) throw new HttpError(403, "Invalid attestation scope");
  if (claims.aud !== TRACE_UPLOAD_AUDIENCE) throw new HttpError(403, "Invalid attestation audience");
  if (claims.actorType !== "user") throw new HttpError(403, "Invalid attestation actor");
  if (!claims.serverId || !claims.sub) throw new HttpError(403, "Missing web trace identity");
  const expectedResource = `servers/${claims.serverId}/web-traces`;
  if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
}

function validateFeedbackReportClaims(claims: ScopeAttestationClaims): void {
  if (claims.typ !== "scope-attestation") throw new HttpError(401, "Invalid attestation type");
  if (claims.scope !== FEEDBACK_REPORT_SCOPE) throw new HttpError(403, "Invalid attestation scope");
  if (claims.aud !== FEEDBACK_REPORT_AUDIENCE) throw new HttpError(403, "Invalid attestation audience");
  if (!claims.serverId) throw new HttpError(403, "Missing feedback report identity");

  if (claims.actorType === "machine") {
    if (!claims.machineId) throw new HttpError(403, "Missing feedback report machine identity");
    const expectedResource = `servers/${claims.serverId}/machines/${claims.machineId}/feedback-reports`;
    if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
    return;
  }

  if (claims.actorType !== "user") throw new HttpError(403, "Invalid attestation actor");
  const expectedResource = `servers/${claims.serverId}/feedback-reports`;
  if (claims.resource !== expectedResource) throw new HttpError(403, "Invalid attestation resource");
}

async function writeFeedbackReportLedger(
  env: TraceUploadWorkerEnv,
  metadata: FeedbackReportUploadSessionClaims,
  status: {
    status: "pending" | "uploaded";
    metadata?: JsonObject;
    title?: string;
    descriptionPresent?: boolean;
  },
): Promise<void> {
  const record = {
    type: "feedback_report_artifact",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    report_id: metadata.reportId,
    artifact_id: metadata.artifactId,
    object_key: metadata.objectKey,
    ledger_key: feedbackReportLedgerKey(metadata),
    bundle_sha256: metadata.bundleSha256,
    bundle_size_bytes: metadata.bundleSizeBytes,
    server_id: metadata.serverId,
    actor_type: metadata.actorType,
    subject_id: metadata.subjectId,
    source: metadata.source,
    ...(metadata.machineId ? { machine_id: metadata.machineId } : {}),
    ...(metadata.agentId ? { agent_id: metadata.agentId } : {}),
    ...(metadata.transcriptCoverage ? { transcript_coverage: metadata.transcriptCoverage } : {}),
    ...(metadata.transcriptFirstEventAt
      ? { transcript_first_event_at: metadata.transcriptFirstEventAt }
      : {}),
    ...(metadata.transcriptLastEventAt
      ? { transcript_last_event_at: metadata.transcriptLastEventAt }
      : {}),
    ...(metadata.transcriptTruncated ? { transcript_truncated: metadata.transcriptTruncated } : {}),
    ...(metadata.transcriptTruncationDirection
      ? { transcript_truncation_direction: metadata.transcriptTruncationDirection }
      : {}),
    ...(metadata.transcriptAnchorSource ? { transcript_anchor_source: metadata.transcriptAnchorSource } : {}),
    ...status,
  };
  await env.TRACE_BUNDLES.put(feedbackReportLedgerKey(metadata), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      reportId: metadata.reportId,
      artifactId: metadata.artifactId,
      bundleSha256: metadata.bundleSha256,
      serverId: metadata.serverId,
      ledgerType: "feedback-report-artifact",
    },
  });
}

async function writeFeedbackReportCompleteLedger(
  env: TraceUploadWorkerEnv,
  metadata: FeedbackReportCompleteSessionClaims,
): Promise<void> {
  const record = {
    type: "feedback_report_complete",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    report_id: metadata.reportId,
    artifact_id: metadata.artifactId,
    object_key: metadata.objectKey,
    server_id: metadata.serverId,
  };
  await env.TRACE_BUNDLES.put(feedbackReportCompleteLedgerKey(metadata), JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      reportId: metadata.reportId,
      artifactId: metadata.artifactId,
      serverId: metadata.serverId,
      ledgerType: "feedback-report-complete",
    },
  });
}

function feedbackReportLedgerKey(metadata: { serverId: string; reportId: string; artifactId: string }): string {
  return `feedback-report-ledgers/${metadata.serverId}/${metadata.reportId}/${metadata.artifactId}.json`;
}

function feedbackReportCompleteLedgerKey(metadata: { serverId: string; reportId: string; artifactId: string }): string {
  return `feedback-report-ledgers/${metadata.serverId}/${metadata.reportId}/${metadata.artifactId}.complete.json`;
}

function isFeedbackReportPath(pathname: string): boolean {
  return pathname === "/api/feedback-reports"
    || pathname === "/api/reports"
    || /^\/api\/(?:feedback-reports|reports)\/[^/]+\/(?:object|complete)$/.test(pathname);
}

async function enforceFeedbackReportRateLimit(
  env: TraceUploadWorkerEnv,
  input: { serverId: string; actorType: "user" | "machine"; subjectId: string },
): Promise<void> {
  const limit = getConfiguredFeedbackReportHourlyLimit(env);
  if (limit <= 0 || !env.TRACE_BUNDLES.get) return;

  const key = feedbackReportRateLimitKey(input, new Date());
  const existing = await env.TRACE_BUNDLES.get(key);
  let count = 0;
  if (existing?.body) {
    const text = await new Response(existing.body).text().catch(() => "");
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.count === "number" && Number.isFinite(parsed.count) && parsed.count > 0) {
        count = Math.floor(parsed.count);
      }
    } catch {
      count = 0;
    }
  }

  if (count >= limit) {
    throw new HttpError(429, "Feedback report rate limit exceeded");
  }

  await env.TRACE_BUNDLES.put(key, JSON.stringify({
    type: "feedback_report_rate_limit",
    schema_version: 1,
    updated_at: new Date().toISOString(),
    server_id: input.serverId,
    actor_type: input.actorType,
    subject_id: input.subjectId,
    count: count + 1,
    limit,
  }, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      ledgerType: "feedback-report-rate-limit",
      serverId: input.serverId,
      actorType: input.actorType,
      subjectId: input.subjectId,
    },
  });
}

function feedbackReportRateLimitKey(
  input: { serverId: string; actorType: "user" | "machine"; subjectId: string },
  date: Date,
): string {
  const hour = date.toISOString().slice(0, 13).replace(/[-:]/g, "");
  return [
    "feedback-report-rate-limits",
    sanitizeObjectPathSegment(input.serverId),
    input.actorType,
    sanitizeObjectPathSegment(input.subjectId),
    `${hour}.json`,
  ].join("/");
}

async function verifyToken<T extends { exp?: number }>(token: string, secret: string): Promise<T> {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) throw new HttpError(401, "Invalid token");
  const payload = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);
  const expected = await hmacSha256Base64Url(secret, payload);
  if (!constantTimeEqual(signature, expected)) throw new HttpError(401, "Invalid token signature");

  let claims: T;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as T;
  } catch {
    throw new HttpError(401, "Invalid token payload");
  }
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) {
    throw new HttpError(401, "Token expired");
  }
  return claims;
}

async function signToken(payload: object, secret: string): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256Base64Url(secret, encoded);
  return `${encoded}.${signature}`;
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJsonObject(request: Request): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed as JsonObject;
}

async function readJsonObjectWithLimit(request: Request, maxBytes: number): Promise<JsonObject> {
  const bytes = await readRequestBodyWithLimit(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed as JsonObject;
}

function readString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${name} is required`);
  if (value.length > maxLength) throw new HttpError(400, `${name} is too long`);
  return value;
}

function readOptionalString(value: unknown, name: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return readString(value, name, maxLength);
}

// TOOTH-2: extract transcript window-coverage fields (F1–F4) from the daemon's
// upload metadata. anchor_source is a CLOSED enum {model_read_at | reported_at};
// createdAt is deliberately NOT in it. Any out-of-enum source is rejected (fails
// closed) rather than defaulting to covered — R1's fail-loud, R4's never-default.
function readWindowCoverageClaims(metadataValue: unknown): Partial<
  Pick<
    FeedbackReportUploadSessionClaims,
    | "transcriptCoverage"
    | "transcriptFirstEventAt"
    | "transcriptLastEventAt"
    | "transcriptTruncated"
    | "transcriptTruncationDirection"
    | "transcriptAnchorSource"
  >
> {
  const meta = readOptionalJsonObject(metadataValue, "metadata");
  if (!meta) return {};
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const coverage = str(meta.feedbackTranscriptWindowCoverage) ?? str(meta.feedbackTranscriptCoverage);
  const anchorSource = str(meta.feedbackReportTimeSource) ?? str(meta.feedbackTranscriptAnchorSource);
  // R4: the predicate must never default to covered; an out-of-enum anchor is
  // rejected (we simply do not claim coverage). Closed enum enforcement:
  if (anchorSource !== undefined && anchorSource !== "model_read_at" && anchorSource !== "reported_at") {
    // Out-of-enum source → do not propagate a coverage claim; consumers must fail
    // loud on absence / contradictory F1–F4 (see fullCoveragePredicate).
    return {};
  }
  const claims: Partial<
    Pick<FeedbackReportUploadSessionClaims, "transcriptAnchorSource" | "transcriptFirstEventAt" | "transcriptLastEventAt" | "transcriptCoverage" | "transcriptTruncated" | "transcriptTruncationDirection">
  > = {};
  claims.transcriptCoverage = coverage;
  claims.transcriptFirstEventAt = str(meta.feedbackTranscriptFirstEventAt);
  claims.transcriptLastEventAt = str(meta.feedbackTranscriptLastEventAt);
  const truncatedRaw = str(meta.feedbackTranscriptTruncated);
  claims.transcriptTruncated =
    truncatedRaw === "true" ? "true" : truncatedRaw === "false" ? "false" : undefined;
  const dirRaw = str(meta.feedbackTranscriptTruncationDirection);
  claims.transcriptTruncationDirection =
    dirRaw === "head" || dirRaw === "tail" || dirRaw === "window" ? dirRaw : undefined;
  if (anchorSource !== undefined) claims.transcriptAnchorSource = anchorSource;
  return claims;
}

function readOptionalJsonObject(value: unknown, name: string): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) throw new HttpError(400, `${name} must be a JSON object`);
  return value;
}

function readWebTraceRecords(value: unknown): WebTraceRecord[] {
  if (!Array.isArray(value)) throw new HttpError(400, "records is required");
  if (value.length === 0) throw new HttpError(400, "records is empty");
  if (value.length > WEB_TRACE_MAX_RECORDS) throw new HttpError(400, "records exceeds maxRecords");
  return value.map((record, idx) => {
    if (!isLocalTraceRecord(record) || record.surface !== "web") {
      throw new HttpError(400, `Invalid web trace span record at index ${idx}`);
    }
    return record as WebTraceRecord;
  });
}

function readSha256(value: unknown, name: string): string {
  const result = readString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new HttpError(400, `${name} is invalid`);
  return result;
}

function readInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${name} is invalid`);
  }
  if (value > max) throw new HttpError(400, `${name} exceeds maxBytes`);
  return value;
}

function getConfiguredMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_UPLOAD_MAX_BYTES) return DEFAULT_MAX_BYTES;
  const parsed = Number(env.TRACE_UPLOAD_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function getConfiguredFeedbackReportMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.FEEDBACK_REPORT_MAX_BYTES) return FEEDBACK_REPORT_MAX_BYTES;
  const parsed = Number(env.FEEDBACK_REPORT_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : FEEDBACK_REPORT_MAX_BYTES;
}

function getConfiguredFeedbackReportHourlyLimit(env: TraceUploadWorkerEnv): number {
  if (!env.FEEDBACK_REPORT_HOURLY_LIMIT) return FEEDBACK_REPORT_HOURLY_LIMIT;
  const parsed = Number(env.FEEDBACK_REPORT_HOURLY_LIMIT);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : FEEDBACK_REPORT_HOURLY_LIMIT;
}

function getConfiguredIngestBatchSize(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_INGEST_BATCH_SIZE) return DEFAULT_INGEST_BATCH_SIZE;
  const parsed = Number(env.TRACE_INGEST_BATCH_SIZE);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_BATCH_SIZE;
}

function getConfiguredIngestMaxDecompressedBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_INGEST_MAX_DECOMPRESSED_BYTES) return DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES;
  const parsed = Number(env.TRACE_INGEST_MAX_DECOMPRESSED_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_MAX_DECOMPRESSED_BYTES;
}

function getConfiguredWebTraceMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_WEB_MAX_BYTES) return WEB_TRACE_MAX_BYTES;
  const parsed = Number(env.TRACE_WEB_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WEB_TRACE_MAX_BYTES;
}

function getUploadSessionSecret(env: TraceUploadWorkerEnv): string {
  return env.TRACE_UPLOAD_WORKER_SECRET || env.SCOPE_ATTESTATION_SECRET;
}

function sanitizeObjectPathSegment(value: string): string {
  return value
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-|-$/g, "")
    .slice(0, 180) || "feedback-bundle.bin";
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function webTraceCorsResponse(env: TraceUploadWorkerEnv, request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: webTraceCorsHeaders(env, request),
  });
}

function feedbackReportCorsResponse(env: TraceUploadWorkerEnv, request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: feedbackReportCorsHeaders(env, request),
  });
}

function configuredWebCorsOrigins(env: TraceUploadWorkerEnv): string[] {
  return (env.TRACE_WEB_CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function resolveWebCorsOrigin(env: TraceUploadWorkerEnv, request: Request): string {
  const configuredOrigins = configuredWebCorsOrigins(env);
  if (configuredOrigins.length === 0) return "*";
  const requestOrigin = request.headers.get("Origin")?.trim();
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) return requestOrigin;
  return configuredOrigins[0];
}

function webCorsVaryHeader(env: TraceUploadWorkerEnv): Record<string, string> {
  return configuredWebCorsOrigins(env).length > 1 ? { Vary: "Origin" } : {};
}

function webTraceCorsHeaders(env: TraceUploadWorkerEnv, request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveWebCorsOrigin(env, request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Server-Id",
    "Access-Control-Max-Age": "86400",
    ...webCorsVaryHeader(env),
  };
}

function feedbackReportCorsHeaders(env: TraceUploadWorkerEnv, request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveWebCorsOrigin(env, request),
    "Access-Control-Allow-Methods": FEEDBACK_REPORT_CORS_METHODS,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Server-Id",
    "Access-Control-Max-Age": "86400",
    ...webCorsVaryHeader(env),
  };
}

function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, "");
  if (withoutTrailingSlash.endsWith("/v1/traces")) {
    return withoutTrailingSlash;
  }
  return `${withoutTrailingSlash}/v1/traces`;
}

function maybeDecompressStream(body: ReadableStream, contentEncoding: string | undefined): ReadableStream {
  if (!contentEncoding) return body;
  if (contentEncoding.toLowerCase() !== "gzip") {
    throw new Error(`Unsupported trace bundle content encoding: ${contentEncoding}`);
  }
  return body.pipeThrough(new DecompressionStream("gzip"));
}

async function readStreamWithLimit(stream: ReadableStream, maxBytes: number): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Trace bundle exceeds ingest decompressed byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

// Exported for the cross-package daemon-bundle smoke test
// (daemonBundle.smoke.test.ts), which must validate REAL daemon-produced
// records against the same gate the ingest path uses.
export function isLocalTraceRecord(value: unknown): value is LocalTraceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "span"
    && record.schema_version === 1
    && typeof record.trace_id === "string"
    && typeof record.span_id === "string"
    && (typeof record.parent_span_id === "string" || record.parent_span_id === null || record.parent_span_id === undefined)
    && typeof record.name === "string"
    && typeof record.surface === "string"
    && typeof record.kind === "string"
    && typeof record.status === "string"
    && typeof record.start_time === "string"
    && typeof record.end_time === "string"
    && (record.attrs === undefined || isJsonObject(record.attrs))
    && (record.events === undefined || isTraceEvents(record.events));
}

function isTraceEvents(value: unknown): value is LocalTraceRecord["events"] {
  return Array.isArray(value) && value.every((event) => (
    !!event
    && typeof event === "object"
    && !Array.isArray(event)
    && typeof (event as Record<string, unknown>).name === "string"
    && typeof (event as Record<string, unknown>).time === "string"
    && (
      (event as Record<string, unknown>).attrs === undefined
      || isJsonObject((event as Record<string, unknown>).attrs)
    )
  ));
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toOtlpSpanKind(kind: string): number {
  switch (kind) {
    case "server":
      return 2;
    case "client":
      return 3;
    case "producer":
      return 4;
    case "consumer":
      return 5;
    case "internal":
    default:
      return 1;
  }
}

function toOtlpStatus(status: string): JsonObject {
  if (status === "unset") return { code: 0 };
  if (status === "ok") return { code: 1 };
  return { code: 2, message: status };
}

function compactAttributes(attrs: Record<string, unknown>): Array<{ key: string; value: OtlpAnyValue }> {
  return Object.entries(attrs)
    .map(([key, value]) => {
      const converted = toOtlpAnyValue(value);
      return converted ? { key, value: converted } : null;
    })
    .filter((attr): attr is { key: string; value: OtlpAnyValue } => attr !== null);
}

function toOtlpAnyValue(value: unknown): OtlpAnyValue | null {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (value === null) return { stringValue: "null" };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function isoToUnixNano(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid trace timestamp: ${value}`);
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}
