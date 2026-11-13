import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handleRequest, type TraceUploadWorkerEnv } from "./index";
import { createNodeExecutionContext, installUnhandledRejectionGuard } from "./nodeExecutionContext";
import { createNodeTraceUploadEnv } from "./nodeEnv";
import { applyServerTimeouts } from "./serverTimeouts";

const DEFAULT_PORT = 3000;

const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

const env: TraceUploadWorkerEnv = createNodeTraceUploadEnv();

const backgroundCtx = createNodeExecutionContext();
installUnhandledRejectionGuard();

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await toWebRequest(incoming);
    const response = await handleRequest(request, env, backgroundCtx);
    await writeWebResponse(outgoing, response);
  } catch (error) {
    console.error("Trace upload service request failed", { error_class: classifyError(error) });
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Internal server error" }));
  }
});
applyServerTimeouts(server);

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

  // Aborts when the client goes away before its whole request arrived, so
  // handleRequest can tell a failed body read from a failure of our own.
  // Registered before Readable.toWeb, so the signal is set before the body
  // read rejects.
  const clientGone = new AbortController();
  // Only while the request is incomplete: once it has fully arrived, a
  // disconnect must not relabel a failure of our own.
  const abortIfIncomplete = () => {
    if (!incoming.complete) clientGone.abort();
  };
  incoming.once("error", abortIfIncomplete);
  incoming.once("close", abortIfIncomplete);

  const body = incoming.method === "GET" || incoming.method === "HEAD"
    ? undefined
    : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
  return new Request(url, {
    method: incoming.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
    signal: clientGone.signal,
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
