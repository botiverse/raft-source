// Browser trace batches: POST /api/web-traces → OTLP (+ optional V2 projection).
import type { TraceUploadWorkerEnv } from "../env";
import { verifyScopeAttestation, type ScopeAttestationClaims } from "../shared/auth";
import {
  HttpError,
  jsonResponse,
  readJsonObjectWithLimit,
  readOptionalJsonObject,
  readOptionalString,
  readString,
  resolveWebCorsOrigin,
  webCorsVaryHeader,
  type JsonObject,
} from "../shared/http";
import { TRACE_UPLOAD_AUDIENCE } from "./bundles";
import {
  compactAttributes,
  isLocalEventRecord,
  isLocalTraceRecord,
  normalizeOtlpTracesEndpoint,
  postOtlpLogBatch,
  toOtlpSpan,
  type LocalEventRecord,
  type LocalTraceRecord,
  type OtlpAnyValue,
} from "./otlp";
import { postOtlpJson } from "./otlpSink";
import { sanitizeWebAgentActivityJoinKeys } from "./webAgentActivityJoinKeys";
import {
  projectV2BestEffort,
  projectorDisabledByMissingCanonicalSink,
  webProjectionResource,
} from "./v2Projection";

const WEB_TRACE_UPLOAD_SCOPE = "web-trace-batch:create";

const WEB_TRACE_MAX_BYTES = 512 * 1024;

const WEB_TRACE_MAX_RECORDS = 1_000;

type WebTraceRecord = LocalTraceRecord & {
  surface: "web";
};

export async function ingestWebTraceBatch(request: Request, env: TraceUploadWorkerEnv): Promise<Response> {
  const body = await readJsonObjectWithLimit(request, getConfiguredWebTraceMaxBytes(env));
  const attestation = readString(body.attestation, "attestation", 16 * 1024);
  const claims = await verifyScopeAttestation(attestation, env);
  validateWebTraceClaims(claims);

  const batchId = readOptionalString(body.batchId, "batchId", 128) ?? crypto.randomUUID();
  const events = readWebEventRecords(body.events);
  const records = readWebTraceRecords(body.records, events.length > 0);
  const resourceAttrs = readOptionalJsonObject(body.resource, "resource") ?? {};
  const webMetadata = {
    batchId,
    serverId: claims.serverId,
    // Traces are kept indefinitely, so the user appears only as the random
    // trace_user_id the server put in the attestation, never as `sub`.
    traceUserId: typeof claims.traceUserId === "string" && claims.traceUserId ? claims.traceUserId : null,
    resourceAttrs,
  };

  if (env.TRACE_INGEST_OTLP_ENDPOINT) {
    if (records.length > 0) {
      await postWebTraceBatch(env, records, webMetadata);
    }
    if (events.length > 0) {
      const keyedEvents = events.map((record, index) => ({ record, eventKey: `${batchId}:${index}` }));
      await postOtlpLogBatch(env, webResourceAttributes(env, webMetadata), "@botiverse/raft-web", keyedEvents, "web_events");
    }
  }

  const v2Projection = env.TRACE_INGEST_OTLP_ENDPOINT
    ? await projectV2BestEffort(env, records, webProjectionResource(env, claims.serverId, resourceAttrs))
    : projectorDisabledByMissingCanonicalSink(env);

  return jsonResponse({
    ok: true,
    batchId,
    spansIngested: env.TRACE_INGEST_OTLP_ENDPOINT ? records.length : 0,
    ...(env.TRACE_INGEST_OTLP_ENDPOINT && events.length > 0 ? { eventsIngested: events.length } : {}),
    scopedbStatus: env.TRACE_INGEST_OTLP_ENDPOINT ? "success" : "skipped",
    v2ProjectorStatus: v2Projection.status,
    v2SpansProjected: v2Projection.spansProjected,
    v2RowsProjected: v2Projection.rowsProjected,
    v2SpansSkipped: v2Projection.spansSkipped,
    v2SkipReasonClasses: v2Projection.skipReasonClasses,
  }, 200, webTraceCorsHeaders(env, request));
}

async function postWebTraceBatch(
  env: TraceUploadWorkerEnv,
  records: readonly WebTraceRecord[],
  metadata: {
    batchId: string;
    serverId: string;
    traceUserId: string | null;
    resourceAttrs: JsonObject;
  },
): Promise<void> {
  const endpoint = normalizeOtlpTracesEndpoint(env.TRACE_INGEST_OTLP_ENDPOINT ?? "");
  await postOtlpJson(env, "web", endpoint, toWebOtlpPayload(env, records, metadata), records.length);
}

function webResourceAttributes(
  env: TraceUploadWorkerEnv,
  metadata: {
    batchId: string;
    serverId: string;
    traceUserId: string | null;
    resourceAttrs: JsonObject;
  },
): Array<{ key: string; value: OtlpAnyValue }> {
  return compactAttributes({
    ...metadata.resourceAttrs,
    "service.name": "slock-web",
    "service.revision": env.SLOCK_RELEASE_SHA,
    "deployment.environment": env.DEPLOYMENT_ENV,
    "telemetry.sdk.name": "slock-web-trace-upload",
    "slock.web_trace.batch_id": metadata.batchId,
    "slock.server_id": metadata.serverId,
    "slock.trace_user_id": metadata.traceUserId,
  });
}

function toWebOtlpPayload(
  env: TraceUploadWorkerEnv,
  records: readonly WebTraceRecord[],
  metadata: {
    batchId: string;
    serverId: string;
    traceUserId: string | null;
    resourceAttrs: JsonObject;
  },
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: webResourceAttributes(env, metadata),
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

function webTraceIngestSpanKey(metadata: { serverId: string; traceUserId: string | null; batchId: string }, record: LocalTraceRecord): string {
  return `${metadata.serverId}:${metadata.traceUserId ?? "-"}:${metadata.batchId}:${record.trace_id}:${record.span_id}`;
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

function readWebTraceRecords(value: unknown, allowEmpty: boolean): WebTraceRecord[] {
  if (allowEmpty && (value === undefined || value === null)) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "records is required");
  if (value.length === 0 && !allowEmpty) throw new HttpError(400, "records is empty");
  if (value.length > WEB_TRACE_MAX_RECORDS) throw new HttpError(400, "records exceeds maxRecords");
  return value.map((record, idx) => {
    if (!isLocalTraceRecord(record) || record.surface !== "web") {
      throw new HttpError(400, `Invalid web trace span record at index ${idx}`);
    }
    return record as WebTraceRecord;
  });
}

function readWebEventRecords(value: unknown): LocalEventRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "events must be an array");
  if (value.length > WEB_TRACE_MAX_RECORDS) throw new HttpError(400, "events exceeds maxRecords");
  return value.map((record, idx) => {
    if (!isLocalEventRecord(record) || record.surface !== "web") {
      throw new HttpError(400, `Invalid web trace event record at index ${idx}`);
    }
    return sanitizeWebAgentActivityJoinKeys(record);
  });
}

function getConfiguredWebTraceMaxBytes(env: TraceUploadWorkerEnv): number {
  if (!env.TRACE_WEB_MAX_BYTES) return WEB_TRACE_MAX_BYTES;
  const parsed = Number(env.TRACE_WEB_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WEB_TRACE_MAX_BYTES;
}

export function webTraceCorsResponse(env: TraceUploadWorkerEnv, request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: webTraceCorsHeaders(env, request),
  });
}

export function webTraceCorsHeaders(env: TraceUploadWorkerEnv, request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveWebCorsOrigin(env, request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Server-Id",
    "Access-Control-Max-Age": "86400",
    ...webCorsVaryHeader(env),
  };
}
