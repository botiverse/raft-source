// Request parsing, size-limited body reading, JSON responses and web CORS helpers.
import type { TraceUploadWorkerEnv } from "../env";

export type JsonObject = Record<string, unknown>;

export class HttpError extends Error {
  /** When set, the error response carries `Retry-After: <seconds>`. */
  readonly retryAfterSeconds?: number;

  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<ArrayBuffer> {
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

export async function readJsonObject(request: Request): Promise<JsonObject> {
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

export async function readJsonObjectWithLimit(request: Request, maxBytes: number): Promise<JsonObject> {
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

export function readString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${name} is required`);
  if (value.length > maxLength) throw new HttpError(400, `${name} is too long`);
  return value;
}

export function readOptionalString(value: unknown, name: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  return readString(value, name, maxLength);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function readOptionalUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw new HttpError(400, `${name} is invalid`);
  return value;
}

export function readOptionalJsonObject(value: unknown, name: string): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) throw new HttpError(400, `${name} must be a JSON object`);
  return value;
}

export function readSha256(value: unknown, name: string): string {
  const result = readString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new HttpError(400, `${name} is invalid`);
  return result;
}

export function readInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${name} is invalid`);
  }
  if (value > max) throw new HttpError(400, `${name} exceeds maxBytes`);
  return value;
}

export function sanitizeObjectPathSegment(value: string): string {
  return value
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-|-$/g, "")
    .slice(0, 180) || "feedback-bundle.bin";
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/**
 * Raft Desktop's page origin: it serves the web app from its own app://raft
 * scheme, and its feedback reports and web traces come from there. Allowed
 * wherever an allowlist is configured, exactly this one origin.
 */
export const RAFT_DESKTOP_APP_ORIGIN = "app://raft";

function configuredWebCorsOrigins(env: TraceUploadWorkerEnv): string[] {
  const origins = (env.TRACE_WEB_CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // No allowlist answers `*`, which already covers the desktop.
  if (origins.length === 0 || origins.includes(RAFT_DESKTOP_APP_ORIGIN)) return origins;
  return [...origins, RAFT_DESKTOP_APP_ORIGIN];
}

export function resolveWebCorsOrigin(env: TraceUploadWorkerEnv, request: Request): string {
  const configuredOrigins = configuredWebCorsOrigins(env);
  if (configuredOrigins.length === 0) return "*";
  const requestOrigin = request.headers.get("Origin")?.trim();
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) return requestOrigin;
  return configuredOrigins[0];
}

export function webCorsVaryHeader(env: TraceUploadWorkerEnv): Record<string, string> {
  return configuredWebCorsOrigins(env).length > 1 ? { Vary: "Origin" } : {};
}

export function maybeDecompressStream(body: ReadableStream, contentEncoding: string | undefined): ReadableStream {
  if (!contentEncoding) return body;
  if (contentEncoding.toLowerCase() !== "gzip") {
    throw new Error(`Unsupported trace bundle content encoding: ${contentEncoding}`);
  }
  return body.pipeThrough(new DecompressionStream("gzip"));
}

export async function readStreamWithLimit(stream: ReadableStream, maxBytes: number): Promise<ArrayBuffer> {
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

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
