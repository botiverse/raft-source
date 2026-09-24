import { timingSafeEqual } from "node:crypto";
import {
  isTraceEventRowV2CompatibleSchemaFingerprint,
  TRACE_EVENT_ROW_V2_TABLE,
} from "@botiverse/raft-shared";
import { EventBuffer, type EventBufferEnvelope, type EventBufferRow } from "./core.js";
import type { EventBufferRejectReason } from "./metrics.js";

export interface EventBufferHttpOptions {
  buffer: EventBuffer;
  authToken: string;
  maxRequestBytes: number;
  maxRequestRows: number;
}

const BATCH_PATH = "/internal/v1/batches";

export function createEventBufferRequestHandler(options: EventBufferHttpOptions) {
  if (!options.authToken) throw new Error("authToken is required");
  if (!Number.isFinite(options.maxRequestBytes) || options.maxRequestBytes <= 0) {
    throw new Error("maxRequestBytes must be positive");
  }
  if (!Number.isInteger(options.maxRequestRows) || options.maxRequestRows <= 0) {
    throw new Error("maxRequestRows must be a positive integer");
  }
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/healthz") {
      return json({ status: "ok" });
    }
    if (request.method === "GET" && path === "/metrics") {
      return new Response(options.buffer.renderPrometheusMetrics(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (request.method !== "POST" || path !== BATCH_PATH) {
      return typedError(404, "not_found");
    }
    if (!authorized(request.headers.get("authorization"), options.authToken)) {
      options.buffer.metrics.recordIngressAttempt();
      options.buffer.reject("unauthorized");
      return typedError(401, "unauthorized");
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxRequestBytes) {
      options.buffer.metrics.recordIngressAttempt();
      options.buffer.reject("request_too_large");
      return typedError(413, "request_too_large");
    }
    const body = await readBoundedBody(request, options.maxRequestBytes);
    if (body === null) {
      options.buffer.metrics.recordIngressAttempt();
      options.buffer.reject("request_too_large");
      return typedError(413, "request_too_large");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      options.buffer.metrics.recordIngressAttempt();
      options.buffer.reject("invalid_json");
      return typedError(400, "invalid_json");
    }
    const envelope = parseEnvelope(raw, options.maxRequestRows);
    if (typeof envelope === "string") {
      options.buffer.metrics.recordIngressAttempt();
      options.buffer.reject(envelope);
      return typedError(statusForReject(envelope), envelope);
    }

    const receipt = options.buffer.enqueue(envelope);
    if (receipt.state === "rejected") {
      return typedError(statusForReject(receipt.reason), receipt.reason);
    }
    return json({ receipt }, 202);
  };
}

function parseEnvelope(value: unknown, maxRows: number): EventBufferEnvelope | EventBufferRejectReason {
  if (!isObject(value)) return "invalid_envelope";
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "rows,schemaFingerprint,table") return "invalid_envelope";
  if (value.table !== TRACE_EVENT_ROW_V2_TABLE) return "table_not_allowed";
  if (
    typeof value.schemaFingerprint !== "string"
    || !isTraceEventRowV2CompatibleSchemaFingerprint(value.schemaFingerprint)
  ) return "schema_mismatch";
  if (
    !Array.isArray(value.rows)
    || value.rows.length === 0
    || value.rows.length > maxRows
    || !value.rows.every(isObject)
  ) {
    return value.rows instanceof Array && value.rows.length > maxRows
      ? "batch_too_large"
      : "invalid_envelope";
  }
  return {
    table: value.table,
    schemaFingerprint: value.schemaFingerprint,
    rows: value.rows as EventBufferRow[],
  };
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function authorized(header: string | null, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function statusForReject(reason: EventBufferRejectReason): number {
  switch (reason) {
    case "unauthorized": return 401;
    case "request_too_large":
    case "batch_too_large":
    case "row_too_large": return 413;
    case "queue_full":
    case "shutting_down": return 503;
    case "table_not_allowed":
    case "schema_mismatch": return 422;
    default: return 400;
  }
}

function typedError(status: number, code: string): Response {
  return json({ error: code }, status);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
