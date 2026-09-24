#!/usr/bin/env -S node --import tsx
/**
 * slockdev-latency-proxy — Phase 0 of #proj-dx task #19. A tiny HTTP proxy
 * that sits between the web dev server and the slockdev server and delays
 * each non-upgrade HTTP request by a configurable amount, then forwards it
 * unchanged. WebSocket / HTTP upgrades pass through immediately so socket.io
 * and daemon WS keep working without artificial delay (HTTP-only injection;
 * use Toxiproxy in phase 1 for jitter / loss / bandwidth shaping).
 *
 * Lives in the slockdev process tree only. packages/server has no knowledge
 * of it — slockdev decides whether to spawn this and rewires
 * SLOCK_SERVER_PORT in the web window's env accordingly. When latency is
 * disabled (the default), this binary is never invoked and slockdev's
 * behavior is byte-for-byte unchanged.
 *
 * Invocation:
 *   node --import tsx scripts/dev/raftdev-latency-proxy.ts \
 *     --port <listen> --target-port <slockdev-server> \
 *     --min-ms <n> --max-ms <n> [--label "<text>"]
 *
 * Delay model: uniform random in [minMs, maxMs] per request. If min == max,
 * the delay is fixed. Bounds are validated by the caller (raftdev.ts) via
 * parseLatencyProfile.
 */
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

const port = Number(readFlag("--port"));
const targetPort = Number(readFlag("--target-port"));
const minMs = Number(readFlag("--min-ms"));
const maxMs = Number(readFlag("--max-ms"));
const label = readFlag("--label") ?? `${minMs}-${maxMs}ms`;

if (
  !Number.isInteger(port) || port <= 0 || port > 65535 ||
  !Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535 ||
  !Number.isFinite(minMs) || !Number.isFinite(maxMs) ||
  minMs < 0 || maxMs < minMs
) {
  console.error(
    "[slockdev-latency-proxy] usage: --port N --target-port N --min-ms N --max-ms N [--label STR]",
  );
  process.exit(2);
}

function sampleDelayMs(): number {
  if (minMs === maxMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function forwardHttp(clientReq: IncomingMessage, clientRes: ServerResponse): void {
  const headers: IncomingHttpHeaders = { ...clientReq.headers, host: `localhost:${targetPort}` };
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: clientReq.method,
      path: clientReq.url,
      headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );
  upstream.on("error", (err) => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    clientRes.end(`slockdev-latency-proxy: upstream error: ${err.message}\n`);
  });
  clientReq.on("error", () => { upstream.destroy(); });
  clientReq.pipe(upstream);
}

const server = createServer((req, res) => {
  setTimeout(() => forwardHttp(req, res), sampleDelayMs());
});

// HTTP/1.1 upgrade (WebSocket): pass-through, no delay.
server.on("upgrade", (req, clientSocket: Socket, head) => {
  const upstream = connect(targetPort, "127.0.0.1");
  upstream.on("connect", () => {
    let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(req.headers)) {
      const lines = Array.isArray(v) ? v : [v ?? ""];
      for (const line of lines) preamble += `${k}: ${line}\r\n`;
    }
    preamble += "\r\n";
    upstream.write(preamble);
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[slockdev-latency-proxy] http://localhost:${port} -> http://localhost:${targetPort}  profile=${label}  (HTTP only; WebSocket upgrades pass through)`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
