import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handleRequest, type TraceUploadRuntimeEnv, type TraceUploadWorkerEnv } from "./index.js";
import { S3TraceStorage } from "./nodeStorage.js";

const DEFAULT_PORT = 3000;

const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

const env: TraceUploadWorkerEnv = {
  SCOPE_ATTESTATION_SECRET: requiredEnv("SCOPE_ATTESTATION_SECRET"),
  TRACE_UPLOAD_WORKER_SECRET: process.env.TRACE_UPLOAD_WORKER_SECRET,
  TRACE_UPLOAD_MAX_BYTES: process.env.TRACE_UPLOAD_MAX_BYTES,
  TRACE_INGEST_OTLP_ENDPOINT: process.env.TRACE_INGEST_OTLP_ENDPOINT,
  TRACE_INGEST_OTLP_AUTHORIZATION: process.env.TRACE_INGEST_OTLP_AUTHORIZATION,
  TRACE_INGEST_SERVICE_NAME: process.env.TRACE_INGEST_SERVICE_NAME,
  TRACE_INGEST_BATCH_SIZE: process.env.TRACE_INGEST_BATCH_SIZE,
  TRACE_INGEST_MAX_DECOMPRESSED_BYTES: process.env.TRACE_INGEST_MAX_DECOMPRESSED_BYTES,
  RAFT_TRACE_SCOPEDB_PROJECTOR: process.env.RAFT_TRACE_SCOPEDB_PROJECTOR,
  SCOPEDB_TRACE_EVENTS_ENDPOINT: process.env.SCOPEDB_TRACE_EVENTS_ENDPOINT,
  SCOPEDB_TRACE_EVENTS_WRITE_KEY: process.env.SCOPEDB_TRACE_EVENTS_WRITE_KEY,
  DEPLOYMENT_ENV: process.env.DEPLOYMENT_ENV,
  SLOCK_RELEASE_SHA: process.env.SLOCK_RELEASE_SHA,
  TRACE_WEB_CORS_ORIGIN: process.env.TRACE_WEB_CORS_ORIGIN,
  FEEDBACK_REPORT_MAX_BYTES: process.env.FEEDBACK_REPORT_MAX_BYTES,
  FEEDBACK_REPORT_HOURLY_LIMIT: process.env.FEEDBACK_REPORT_HOURLY_LIMIT,
  FEEDBACK_ADMIN_WEBHOOK_URL: process.env.FEEDBACK_ADMIN_WEBHOOK_URL,
  FEEDBACK_ADMIN_WEBHOOK_SECRET: process.env.FEEDBACK_ADMIN_WEBHOOK_SECRET,
  TRACE_BUNDLES: new S3TraceStorage({
    endpoint: requiredEnv("R2_ENDPOINT"),
    bucket: requiredEnv("R2_BUCKET"),
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    region: process.env.R2_REGION,
  }),
} satisfies TraceUploadRuntimeEnv & TraceUploadWorkerEnv;

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await toWebRequest(incoming);
    const response = await handleRequest(request, env);
    await writeWebResponse(outgoing, response);
  } catch (error) {
    console.error("Trace upload service request failed", { error_class: classifyError(error) });
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, () => {
  console.log(`Trace upload service listening on :${port}`);
});

async function toWebRequest(incoming: import("node:http").IncomingMessage): Promise<Request> {
  const host = forwardedHost(incoming.headers);
  const proto = forwardedProto(incoming.headers);
  const url = new URL(incoming.url ?? "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const body = incoming.method === "GET" || incoming.method === "HEAD"
    ? undefined
    : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  return new Request(url, {
    method: incoming.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit);
}

async function writeWebResponse(outgoing: import("node:http").ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  outgoing.writeHead(response.status, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function forwardedProto(headers: import("node:http").IncomingHttpHeaders): "http" | "https" {
  const raw = headers["fly-forwarded-proto"] ?? headers["x-forwarded-proto"];
  // X-Forwarded-Proto can be a comma-separated list when a proxy hop (AWS ALB)
  // appends its own scheme to an existing header. RFC 7239 / convention: the
  // leftmost token is the original public client scheme, later tokens reflect
  // each inner hop. We trust the leftmost token so an `https, http` chain still
  // resolves to HTTPS for signed URL construction.
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value = first?.split(",")[0]?.trim();
  return value === "https" ? "https" : "http";
}

function forwardedHost(headers: import("node:http").IncomingHttpHeaders): string {
  const raw = headers["x-forwarded-host"] ?? headers.host;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value || "localhost";
}

function classifyError(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}
