// A connection reset before any response (Clash in TUN mode) is retried once,
// only for a request the Server can safely see twice: a GET/HEAD, or a write
// whose route honours its body `idempotencyKey`.
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import {
  __resetAgentCredentialProxyForTest,
  __setProxyPreResponseRetryDelayMsForTest,
  registerAgentCredentialProxy,
} from "./agentCredentialProxy";

type UpstreamCall = { url: string; method: string; body: string | null };

function connectionReset(): TypeError {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
  return new TypeError("fetch failed", { cause });
}

async function bodyText(body: unknown): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  return String(body);
}

/** Upstream mock: each call takes the next outcome (a Response, or an error to throw). */
function mockUpstream(outcomes: Array<(() => Response) | Error>): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  setDaemonFetchImplForTests((async (input: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: await bodyText(init?.body) });
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  }) as never);
  return calls;
}

function json(status: number, body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function register(
  sink: MemoryTraceSink,
  serverUrl = "https://api.raft.build",
  extra: Partial<Parameters<typeof registerAgentCredentialProxy>[0]> = {},
) {
  return registerAgentCredentialProxy({
    agentId: "agent-retry",
    launchId: "launch-retry",
    serverUrl,
    apiKey: "sk_agent_server_side",
    activeCapabilities: "read,tasks,message:write",
    tracer: new BasicTracer({ sink }),
    ...extra,
  });
}

function proxySpan(sink: MemoryTraceSink) {
  const spans = sink.getAllSpans().filter((span) => span.name === "daemon.agent_proxy.request");
  assert.equal(spans.length, 1);
  return spans[0]!;
}

beforeEach(() => {
  __setProxyPreResponseRetryDelayMsForTest(5);
});

afterEach(async () => {
  setDaemonFetchImplForTests(undefined);
  __setProxyPreResponseRetryDelayMsForTest(undefined);
  await __resetAgentCredentialProxyForTest();
});

test("a GET reset before any response succeeds on its one retry", async () => {
  const calls = mockUpstream([connectionReset(), json(200, { ok: true })]);
  const sink = new MemoryTraceSink();
  const handle = await register(sink);

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
    headers: { Authorization: `Bearer ${handle.proxyToken}` },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 2);
  const span = proxySpan(sink);
  assert.equal(span.status, "ok");
  assert.equal(span.attrs?.outcome, "upstream_response");
  assert.equal(span.attrs?.retried, true);
  assert.equal(span.attrs?.retry_outcome, "ok");
  assert.equal(span.attrs?.retry_first_cause_code, "ECONNRESET");
});

test("a POST without an idempotency key is not retried and fails as before", async () => {
  const calls = mockUpstream([connectionReset(), json(200, { ok: true })]);
  const sink = new MemoryTraceSink();
  const handle = await register(sink);

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: "#proj-runtime", message_id: "abc12345" }),
  });

  assert.equal(res.status, 502);
  const body = await res.json() as { proxy?: Record<string, unknown> };
  assert.equal(body.proxy?.failure_class, "pre_response_transport");
  assert.equal(body.proxy?.cause_code, "ECONNRESET");
  assert.equal(calls.length, 1);
  const span = proxySpan(sink);
  assert.equal(span.attrs?.outcome, "proxy_failure");
  assert.equal(span.attrs?.retried, undefined);
});

test("a write carrying an idempotency key is retried with the same body", async () => {
  const calls = mockUpstream([connectionReset(), json(200, { ok: true, messageId: "msg-1", revision: 2 })]);
  const sink = new MemoryTraceSink();
  const handle = await register(sink);
  const requestBody = JSON.stringify({ card: { type: "note" }, idempotencyKey: "key-0001" });

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/messages/msg-1/card`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
    body: requestBody,
  });

  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body, requestBody);
  assert.equal(calls[1]!.body, requestBody);
  assert.equal(proxySpan(sink).attrs?.retry_outcome, "ok");
});

test("the same keyed route without a key is not retried", async () => {
  const calls = mockUpstream([connectionReset(), json(200, { ok: true })]);
  const handle = await register(new MemoryTraceSink());

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/messages/msg-1/card`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
    body: JSON.stringify({ card: { type: "note" } }),
  });

  assert.equal(res.status, 502);
  await res.text();
  assert.equal(calls.length, 1);
});

test("a server-draining GET (events) is not retried", async () => {
  const calls = mockUpstream([connectionReset(), json(200, { events: [] })]);
  const handle = await register(new MemoryTraceSink());

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
    headers: { Authorization: `Bearer ${handle.proxyToken}` },
  });

  assert.equal(res.status, 502);
  await res.text();
  assert.equal(calls.length, 1);
});

test("an unread read (a task's conversation, history) is not retried: it moves the read position", async () => {
  for (const pathAndQuery of [
    "/internal/agent-api/tasks/read?channel=%23proj&task_number=7&unread=true",
    "/internal/agent-api/history?channel=%23general&unread=true",
  ]) {
    const calls = mockUpstream([connectionReset(), json(200, { messages: [] })]);
    const handle = await register(new MemoryTraceSink());
    const res = await fetch(`${handle.proxyUrl}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(res.status, 502, pathAndQuery);
    await res.text();
    assert.equal(calls.length, 1, pathAndQuery);
  }
});

test("a failure after the response started is not retried", async () => {
  let upstreamRequests = 0;
  const server = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{\"ok\":");
    setImmediate(() => res.destroy(new Error("simulated body truncation")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const sink = new MemoryTraceSink();
    const handle = await register(sink, `http://127.0.0.1:${address.port}`, {
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });
    // A buffered JSON read: the truncation surfaces as the proxy's 502.
    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23proj-runtime`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { proxy?: Record<string, unknown> };
    assert.equal(body.proxy?.failure_class, "mid_response_transport");
    assert.equal(upstreamRequests, 1);
    assert.equal(proxySpan(sink).attrs?.retried, undefined);
  } finally {
    await __resetAgentCredentialProxyForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a read timeout after the request was sent is not retried", async () => {
  const headersTimeout = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  });
  const calls = mockUpstream([headersTimeout, json(200, { ok: true })]);
  const handle = await register(new MemoryTraceSink());

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
    headers: { Authorization: `Bearer ${handle.proxyToken}` },
  });

  assert.equal(res.status, 502);
  await res.text();
  assert.equal(calls.length, 1);
});

test("a second failure is reported as before, with the retry on the span", async () => {
  const calls = mockUpstream([connectionReset(), connectionReset()]);
  const sink = new MemoryTraceSink();
  const handle = await register(sink);

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
    headers: { Authorization: `Bearer ${handle.proxyToken}` },
  });

  assert.equal(res.status, 502);
  const body = await res.json() as { code?: string; proxy?: Record<string, unknown> };
  assert.equal(body.code, "agent_proxy_failed");
  assert.equal(body.proxy?.failure_class, "pre_response_transport");
  assert.equal(body.proxy?.cause_code, "ECONNRESET");
  assert.equal(body.proxy?.upstream_layer, "tcp");
  assert.equal(calls.length, 2);
  const span = proxySpan(sink);
  assert.equal(span.status, "error");
  assert.equal(span.attrs?.outcome, "proxy_failure");
  assert.equal(span.attrs?.cause_code, "ECONNRESET");
  assert.equal(span.attrs?.retried, true);
  assert.equal(span.attrs?.retry_outcome, "failed");
  assert.equal(span.attrs?.retry_first_cause_code, "ECONNRESET");
});
