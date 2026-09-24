import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { test } from "vitest";
import { gzipSync } from "node:zlib";
import {
  BasicTracer,
  formatTraceparent,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { ApiClient } from "../../cli/src/client.js";
import type { AgentContext } from "../../cli/src/auth/env.js";

import { setDaemonFetchImplForTests } from "./daemonFetch.js";
import {
  __agentCredentialProxyFetchOptionsForTest,
  __transportNormalizedErrorForErrorForTest,
  __resetAgentCredentialProxyForTest,
  __setAgentCredentialProxyServerFactoryForTest,
  registerAgentCredentialProxy,
  unregisterAgentCredentialProxyForLaunch,
} from "./agentCredentialProxy.js";
import { createAgentAppInboxStore } from "./agentAppInbox.js";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition.js";
import { buildApmFreshnessDecisionProducerFactId } from "./apmStateMachine.js";

const TEST_TRACE_ID = "1".repeat(32);
const TEST_PARENT_SPAN_ID = "2".repeat(16);
const TEST_PROXY_SPAN_ID = "3".repeat(16);

function installDaemonFetchMock(fn: typeof fetch): typeof fetch {
  const previous = globalThis.fetch;
  globalThis.fetch = fn;
  setDaemonFetchImplForTests(fn as never);
  return previous;
}

function restoreDaemonFetchMock(previous: typeof fetch): void {
  globalThis.fetch = previous;
  setDaemonFetchImplForTests(undefined);
}

test("agent credential proxy gives attachment uploads a dedicated longer headers deadline", () => {
  assert.deepEqual(
    __agentCredentialProxyFetchOptionsForTest("/internal/agent-api/server", {}),
    { isolationKey: "agent-credential-proxy" },
  );
  assert.deepEqual(
    __agentCredentialProxyFetchOptionsForTest("/internal/agent-api/upload", {}),
    {
      isolationKey: "agent-credential-proxy:attachment-upload",
      headersTimeoutMs: 300_000,
    },
  );
  assert.deepEqual(
    __agentCredentialProxyFetchOptionsForTest("/internal/agent-api/upload", {
      SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS: "90000",
    }),
    {
      isolationKey: "agent-credential-proxy:attachment-upload",
      headersTimeoutMs: 90_000,
    },
  );
});

function deterministicProxyTracer(sink: MemoryTraceSink): BasicTracer {
  let now = 1_000;
  return new BasicTracer({
    sink,
    clock: () => now++,
    traceIdGenerator: () => TEST_TRACE_ID,
    spanIdGenerator: () => TEST_PROXY_SPAN_ID,
  });
}

test("agent credential proxy reports versions from its live daemon process without upstream", async () => {
  let upstreamRequests = 0;
  await withUpstream((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(500).end();
  }, async (serverUrl) => {
    const launchId = "launch-runtime-version";
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-runtime-version",
      launchId,
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      daemonVersion: "1.0.15",
      computerVersion: "1.0.16",
    });
    try {
      const response = await fetch(`${handle.proxyUrl}/internal/agent-api/runtime-version`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        daemonVersion: "1.0.15",
        computerVersion: "1.0.16",
        observation: "live_daemon_process",
      });
      assert.equal(upstreamRequests, 0);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-runtime-version", launchId });
    }
  });
});

async function withUpstream(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

test("agent credential proxy rejects cross-origin request targets before disclosing credentials", async () => {
  const captured: string[] = [];
  await withUpstream((req, res) => {
    captured.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }, async (untrustedUrl) => {
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-origin-security", launchId: "launch-origin-security",
        serverUrl, apiKey: "sk_agent_origin_security_fixture", activeCapabilities: "read",
      });
      try {
        // Raw request targets matter: fetch would normalize these before sending.
        for (const target of [
          `${untrustedUrl}/internal/agent-api/server`,
          `//${new URL(untrustedUrl).host}/internal/agent-api/server`,
          `/\\${new URL(untrustedUrl).host}/internal/agent-api/server`,
        ]) {
          const status = await new Promise<number | undefined>((resolve, reject) => {
            const request = http.request(handle.proxyUrl, {
              path: target,
              headers: { Authorization: `Bearer ${handle.proxyToken}` },
            }, (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            });
            request.on("error", reject);
            request.end();
          });
          assert.deepEqual(captured, [], "no request or credential may reach another origin");
          assert.equal(status, 403, `must reject target ${target}`);
        }
        assert.deepEqual(captured, [], "no request or credential may reach another origin");
        const allowed = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
        });
        assert.equal(allowed.status, 200);
        await allowed.text();
      } finally {
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-origin-security", launchId: "launch-origin-security" });
      }
    });
  });
});

test("agent credential proxy does not disclose credentials on cross-origin redirects", async () => {
  const captured: string[] = [];
  await withUpstream((req, res) => {
    captured.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }, async (untrustedUrl) => {
    await withUpstream((req, res) => {
      assert.equal(req.headers.authorization, "Bearer sk_agent_redirect_security_fixture");
      res.writeHead(302, { location: `${untrustedUrl}/redirect-receiver` }).end();
    }, async (serverUrl) => {
      const identity = { agentId: "audit-redirect-agent", launchId: "audit-redirect-launch" };
      const handle = await registerAgentCredentialProxy({
        ...identity, serverUrl, apiKey: "sk_agent_redirect_security_fixture", activeCapabilities: "read",
      });
      try {
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
        });
        assert.ok([200, 302].includes(response.status)); await response.text();
        // Transport implementations may relay or follow the redirect. Either
        // outcome must keep both bearer credentials away from the receiver.
        assert.deepEqual(captured, response.status === 200 ? [""] : [],
          "redirect receiver must see no server or local bearer");
      } finally { unregisterAgentCredentialProxyForLaunch(identity); }
    });
  });
});

function shouldSkipProxyDiagnosticFixture(name: string): boolean {
  return process.env.RAFT_PROXY_DIAGNOSTIC_SKIP_FIXTURE === name;
}

function recordProxyDiagnosticFixtureWitness(name: string): void {
  const dir = process.env.RAFT_PROXY_DIAGNOSTIC_WITNESS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.witness`), "executed\n");
}

function recordProxyTimeoutDiscriminatorWitness(name: string): void {
  const dir = process.env.RAFT_PROXY_TIMEOUT_DISCRIMINATOR_WITNESS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.witness`), "executed\n");
}

async function withForwardProxy(
  fn: (proxyUrl: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      requests.push(req.url ?? "");
      const target = new URL(req.url ?? "");
      const upstream = http.request(target, {
        method: req.method,
        headers: req.headers,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on("error", (err) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(err.message);
      });
      req.pipe(upstream);
    })().catch((err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    requests.push(`CONNECT ${target}`);
    const [host, portText] = target.split(":");
    const port = Number(portText);
    if (!host || !Number.isFinite(port)) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const upstreamSocket = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

test("agent credential proxy continues caller trace with a daemon child carrier", async () => {
  let upstreamTraceparent = "";
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    upstreamTraceparent = String(req.headers.traceparent ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-traced",
      launchId: "launch-traced",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      tracer: deterministicProxyTracer(sink),
    });
    const callerTraceparent = formatTraceparent({
      traceId: TEST_TRACE_ID,
      spanId: TEST_PARENT_SPAN_ID,
      parentSpanId: null,
      traceFlags: "01",
    });

    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        traceparent: callerTraceparent,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(
      upstreamTraceparent,
      `00-${TEST_TRACE_ID}-${TEST_PROXY_SPAN_ID}-01`,
      "upstream must receive the daemon child rather than the caller span",
    );
    const [span] = sink.getAllSpans();
    assert.equal(span.name, "daemon.agent_proxy.request");
    assert.equal(span.surface, "daemon");
    assert.equal(span.kind, "client");
    assert.equal(span.status, "ok");
    assert.equal(span.context.traceId, TEST_TRACE_ID);
    assert.equal(span.context.parentSpanId, TEST_PARENT_SPAN_ID);
    assert.equal(span.attrs?.route_family, "server");
    assert.equal(span.attrs?.method, "GET");
    assert.equal(span.attrs?.trace_context_state, "continued");
    assert.equal(span.attrs?.proxy_launch_id_present, true);
    assert.equal(span.attrs?.outcome, "upstream_response");
    assert.equal(span.attrs?.http_status, 200);
  });
});

test("agent credential proxy relays attachment redirects without following them with the server credential", async () => {
  let objectRequests = 0;
  let objectAuthorization = "";
  let upstreamAuthorization = "";
  await withUpstream((req, res) => {
    objectRequests += 1;
    objectAuthorization = String(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from([1, 2, 3]));
  }, async (objectUrl) => {
    const signedUrl = `${objectUrl}/private/object?X-Amz-Signature=proxy-secret`;
    await withUpstream((req, res) => {
      upstreamAuthorization = String(req.headers.authorization ?? "");
      res.writeHead(302, {
        location: signedUrl,
        "cache-control": "private, no-store",
      });
      res.end();
    }, async (serverUrl) => {
      const launchId = "launch-attachment-redirect";
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-attachment-redirect",
        launchId,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
      });
      try {
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/attachments/att-1`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
          redirect: "manual",
        });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("location"), signedUrl);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(await response.text(), "");
      } finally {
        unregisterAgentCredentialProxyForLaunch({
          agentId: "agent-attachment-redirect",
          launchId,
        });
      }
    });
  });

  assert.equal(upstreamAuthorization, "Bearer sk_agent_server_side");
  assert.equal(objectRequests, 0, "the daemon must not consume the object redirect on behalf of the CLI");
  assert.equal(objectAuthorization, "", "the server credential must never reach the object origin");
});

test("agent credential proxy uses one child carrier for freshness preflight and forward", async () => {
  const observed: Array<{ path: string; traceparent: string }> = [];
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    observed.push({
      path: req.url ?? "",
      traceparent: String(req.headers.traceparent ?? ""),
    });
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [{
          id: "recent-without-seq",
          senderType: "human",
          senderName: "tygg",
          content: "context",
          createdAt: "2026-07-14T00:00:00.000Z",
        }],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 243, success: true }] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-traced",
      launchId: null,
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      tracer: deterministicProxyTracer(sink),
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });

    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-o11y", task_numbers: [243] }),
    });

    assert.equal(response.status, 200);
    assert.equal(observed.length, 2);
    assert.match(observed[0]!.path, /^\/internal\/agent-api\/history\?/);
    assert.equal(observed[1]!.path, "/internal/agent-api/tasks/claim");
    assert.equal(observed[0]!.traceparent, observed[1]!.traceparent);
    assert.equal(observed[0]!.traceparent, `00-${TEST_TRACE_ID}-${TEST_PROXY_SPAN_ID}-00`);
    const [span] = sink.getAllSpans();
    assert.equal(span.context.parentSpanId, null);
    assert.equal(span.attrs?.trace_context_state, "new_root");
    assert.equal(span.attrs?.proxy_launch_id_present, false);
    assert.equal(span.attrs?.route_family, "tasks/claim");
    assert.equal(span.attrs?.outcome, "upstream_response");
  });
});

test("agent credential proxy replaces malformed context and traces upstream 5xx", async () => {
  let upstreamTraceparent = "";
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    upstreamTraceparent = String(req.headers.traceparent ?? "");
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-traced",
      launchId: "launch-traced",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      tracer: deterministicProxyTracer(sink),
    });

    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        traceparent: "not-a-traceparent",
      },
    });

    assert.equal(response.status, 503);
    assert.equal(upstreamTraceparent, `00-${TEST_TRACE_ID}-${TEST_PROXY_SPAN_ID}-00`);
    const [span] = sink.getAllSpans();
    assert.equal(span.context.parentSpanId, null);
    assert.equal(span.status, "error");
    assert.equal(span.attrs?.trace_context_state, "malformed");
    assert.equal(span.attrs?.outcome, "upstream_5xx");
    assert.equal(span.attrs?.normalized_code, "server_5xx");
    assert.equal(span.attrs?.response_started, true);
    assert.equal(span.attrs?.response_complete, true);
    assert.equal(span.attrs?.failure_class, "upstream_http_response");
    assert.equal(span.attrs?.cause_code, "HTTP_503");
    assert.equal(span.attrs?.http_status, 503);
  });
});

test("agent credential proxy closes the same trace on a local freshness hold", async () => {
  const sink = new MemoryTraceSink();
  await withUpstream((_req, res) => {
    assert.fail("freshness hold must not reach upstream");
    res.end();
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-traced",
      launchId: "launch-traced",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      tracer: deterministicProxyTracer(sink),
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: (target) => target === "dm:@tygg"
          ? [{ seq: 9, id: "pending-9", senderType: "human", senderName: "tygg", content: "pending" }]
          : [],
        consumeVisibleMessages: () => {},
      },
    });

    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { state?: string }).state, "held");
    const [span] = sink.getAllSpans();
    assert.equal(span.status, "ok");
    assert.equal(span.attrs?.route_family, "agent-api/send");
    assert.equal(span.attrs?.outcome, "local_response");
    assert.equal(span.attrs?.local_response_kind, "freshness_hold");
    assert.equal(span.attrs?.http_status, 200);
  });
});

test("agent credential proxy overrides caller active capabilities and unregisters by launch", async () => {
  let observedAuth = "";
  let observedActiveCaps = "";
  let observedClientCaps = "";
  await withUpstream((req, res) => {
    observedAuth = req.headers.authorization ?? "";
    observedActiveCaps = String(req.headers["x-slock-agent-active-capabilities"] ?? "");
    observedClientCaps = String(req.headers["x-raft-client-capabilities"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
    });

    const first = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "X-Slock-Agent-Active-Capabilities": "read,send,tasks",
        "X-Raft-Client-Capabilities": "manual-context-v1",
      },
    });
    assert.equal(first.status, 200);
    assert.equal(observedAuth, "Bearer sk_agent_server_side");
    assert.equal(observedActiveCaps, "read");
    assert.equal(observedClientCaps, "manual-context-v1");

    assert.equal(unregisterAgentCredentialProxyForLaunch({
      agentId: "agent-1",
      launchId: "launch-1",
    }), 1);

    const afterUnregister = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(afterUnregister.status, 401);
    assert.equal((await afterUnregister.json() as { code?: string }).code, "invalid_agent_proxy_token");
  });
});

test("agent credential proxy strips upstream compression headers after decoded forwarding", async () => {
  await withUpstream((req, res) => {
    const body = JSON.stringify(req.url?.startsWith("/internal/agent-api/history")
      ? { messages: [{ seq: 1, id: "history-1", channel_type: "channel", channel_name: "general" }] }
      : { ok: true, channels: [{ name: "general" }] });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gzipSync(body).byteLength),
    });
    res.end(gzipSync(body));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-compressed",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });

    const server = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(server.status, 200);
    assert.equal(server.headers.get("content-encoding"), null);
    assert.equal(server.headers.get("content-length"), null);
    assert.equal((await server.json() as { channels?: unknown[] }).channels?.length, 1);

    const history = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23general`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(history.status, 200);
    assert.equal(history.headers.get("content-encoding"), null);
    assert.equal(history.headers.get("content-length"), null);
    assert.equal((await history.json() as { messages?: unknown[] }).messages?.length, 1);
  });
});

test("agent credential proxy still returns JSON when the CLI sends Accept-Encoding gzip", async () => {
  const upstreamAcceptEncoding: Array<string | undefined> = [];
  await withUpstream((req, res) => {
    upstreamAcceptEncoding.push(req.headers["accept-encoding"]);
    const body = JSON.stringify({ ok: true, channels: [{ name: "general" }] });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(gzipSync(body).byteLength),
    });
    res.end(gzipSync(body));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-cli-accept-encoding",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });

    // node:http does not auto-decode. On the old proxy this body is gzip
    // bytes with content-encoding stripped (Maria empty/INVALID_JSON).
    const raw = await new Promise<{ status: number; encoding: string | undefined; body: Buffer }>((resolve, reject) => {
      const url = new URL(`${handle.proxyUrl}/internal/agent-api/server`);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "Accept-Encoding": "gzip, deflate, br",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          encoding: res.headers["content-encoding"],
          body: Buffer.concat(chunks),
        }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(raw.status, 200);
    assert.equal(raw.encoding, undefined);
    assert.notEqual(raw.body[0], 0x1f);
    assert.notEqual(raw.body[1], 0x8b);
    assert.equal((JSON.parse(raw.body.toString("utf8")) as { channels?: unknown[] }).channels?.length, 1);
    assert.equal(upstreamAcceptEncoding.length, 1);
  });
});

test("agent credential proxy classifies message resolve failures", async () => {
  const transportEvents: unknown[] = [];
  await withUpstream((req, res) => {
    assert.equal(req.url, "/internal/agent-api/messages/deadbeef/resolve");
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "resolve exploded" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-message-resolve",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordTransportNormalizedError: (input) => transportEvents.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/messages/deadbeef/resolve`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(res.status, 500);
    const body = await res.json() as { error?: string; proxy?: { failure_class?: string; cause_code?: string } };
    assert.equal(body.error, "upstream HTTP response failed");
    assert.equal(body.proxy?.failure_class, "upstream_http_response");
    assert.equal(body.proxy?.cause_code, "HTTP_500");
    assert.deepEqual(transportEvents, [{
      normalizedCode: "server_5xx",
      routeFamily: "agent-api/messages/resolve",
      failureClass: "upstream_http_response",
      responseStarted: true,
      responseComplete: true,
      causeCode: "HTTP_500",
      upstreamLayer: "http_status",
      upstreamStatus: 500,
      launchId: "launch-message-resolve",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
  });
});

test("agent credential proxy freshness preflight and send honor daemon proxy env with sanitized requests", async () => {
  const previousEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  try {
    let upstreamSendCount = 0;
    let observedConnectionHeader: string | undefined;
    let observedProxyConnectionHeader: string | undefined;
    await withForwardProxy(async (proxyUrl, proxyRequests) => {
      process.env.HTTP_PROXY = proxyUrl;
      process.env.http_proxy = proxyUrl;
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      await withUpstream(async (req, res) => {
        if (req.url === "/internal/agent-api/send") {
          upstreamSendCount += 1;
          observedConnectionHeader = String(req.headers.connection ?? "");
          observedProxyConnectionHeader = String(req.headers["proxy-connection"] ?? "");
          let raw = "";
          req.setEncoding("utf8");
          for await (const chunk of req) raw += String(chunk);
          assert.deepEqual(JSON.parse(raw) as Record<string, unknown>, {
            target: "dm:@stdrc",
            content: "reply",
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
      }, async (serverUrl) => {
        const handle = await registerAgentCredentialProxy({
          agentId: "agent-1",
          launchId: "launch-ignore-proxy-env",
          serverUrl,
          apiKey: "sk_agent_server_side",
          activeCapabilities: "send,read",
          inboxCoordinator: {
            getBoundary: () => undefined,
            getPendingMessages: () => [],
            consumeVisibleMessages: () => {},
          },
        });

        const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
            "connection": "close",
            "proxy-connection": "keep-alive",
          },
          body: JSON.stringify({ target: "dm:@stdrc", content: "reply" }),
        });

        assert.equal(res.status, 200);
        assert.equal((await res.json() as { state?: string }).state, "sent");
        assert.equal(upstreamSendCount, 1);
      });
      assert.equal(proxyRequests.length, 2);
      assert.ok(proxyRequests.every((request) => request.startsWith("CONNECT 127.0.0.1:")));
      assert.notEqual(observedConnectionHeader, "close");
      assert.equal(observedProxyConnectionHeader, "");
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("agent credential proxy does not pass manual content-length to daemonFetch", async () => {
  const observed: Array<{ path: string; contentLength: string | null }> = [];
  const realFetch = installDaemonFetchMock((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    observed.push({
      path: url.pathname,
      contentLength: new Headers(init?.headers).get("content-length"),
    });
    return new Response(JSON.stringify({ state: "sent", messageId: "sent-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-no-content-length",
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
    });

    async function post(path: string, body: string): Promise<void> {
      const url = new URL(path, handle.proxyUrl);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end(body);
      });
    }

    await post("/internal/agent-api/profile", JSON.stringify({ name: "agent" }));
    await post("/internal/agent-api/send", JSON.stringify({ target: "dm:@stdrc", content: "reply" }));

    assert.deepEqual(observed, [
      { path: "/internal/agent-api/profile", contentLength: null },
      { path: "/internal/agent-api/send", contentLength: null },
    ]);
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy returns a typed attachment upload headers timeout", async () => {
  const failures: unknown[] = [];
  const realFetch = installDaemonFetchMock((async () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = cause;
    throw error;
  }) as typeof fetch);

  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-upload-timeout",
      launchId: "launch-upload-timeout",
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,attachment:upload",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordProxyFailure: (input) => failures.push(input),
      },
    });

    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(new URL("/internal/agent-api/upload", handle.proxyUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/octet-stream",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 502);
            assert.match(String(res.headers["x-raft-correlation-id"] ?? ""), /^[0-9a-f]{16}$/);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.end("fixture");
    });

    recordProxyTimeoutDiscriminatorWitness("headers_timeout");
    assert.equal(body.code, "ATTACHMENT_UPLOAD_TIMEOUT");
    assert.equal(body.error, "Attachment upload timed out before the server responded");
    assert.match(String(body.suggested_next_action), /may still have accepted.*retry once.*Correlation/i);
    assert.deepEqual(body.proxy, {
      layer: "local_daemon_proxy",
      correlation_id: (body.proxy as { correlation_id: string }).correlation_id,
      route_family: "attachments/upload",
      failure_class: "pre_response_transport",
      response_started: false,
      response_complete: false,
      cause_code: "UND_ERR_HEADERS_TIMEOUT",
      upstream_layer: "read_timeout",
      target_host_class: "api.slock.ai",
      launch_id: "launch-upload-timeout",
      downstream_caller: "cli",
      upstream: "server",
    });
    assert.equal((failures[0] as { responseCode?: string }).responseCode, "ATTACHMENT_UPLOAD_TIMEOUT");
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy returns a typed attachment upload body timeout", async () => {
  const realFetch = installDaemonFetchMock((async () => {
    const cause = Object.assign(new Error("Body Timeout Error"), {
      code: "UND_ERR_BODY_TIMEOUT",
    });
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = cause;
    throw error;
  }) as typeof fetch);

  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-upload-body-timeout",
      launchId: "launch-upload-body-timeout",
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,attachment:upload",
    });

    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(new URL("/internal/agent-api/upload", handle.proxyUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/octet-stream",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 502);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.end("fixture");
    });

    recordProxyTimeoutDiscriminatorWitness("body_timeout");
    assert.equal((body.proxy as Record<string, unknown> | undefined)?.cause_code, "UND_ERR_BODY_TIMEOUT");
    assert.equal((body.proxy as Record<string, unknown> | undefined)?.upstream_layer, "read_timeout");
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy does not classify bare ETIMEDOUT as a read timeout without phase evidence", async () => {
  const realFetch = installDaemonFetchMock((async () => {
    const cause = Object.assign(new Error("request timeout while waiting for upstream"), {
      code: "ETIMEDOUT",
    });
    const error = new TypeError("request timeout while waiting for upstream") as TypeError & { cause?: unknown };
    error.cause = cause;
    throw error;
  }) as typeof fetch);

  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-bare-timeout",
      launchId: "launch-bare-timeout",
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,attachment:upload",
    });

    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(new URL("/internal/agent-api/upload", handle.proxyUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/octet-stream",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 502);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.end("fixture");
    });

    assert.deepEqual(body.proxy, {
      layer: "local_daemon_proxy",
      correlation_id: (body.proxy as { correlation_id: string }).correlation_id,
      route_family: "attachments/upload",
      failure_class: "pre_response_transport",
      response_started: false,
      response_complete: false,
      cause_code: "ETIMEDOUT",
      upstream_layer: "unknown",
      target_host_class: "api.slock.ai",
      launch_id: "launch-bare-timeout",
      downstream_caller: "cli",
      upstream: "server",
    });
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy allows upload response headers past the ordinary short deadline", async () => {
  const previousDefault = process.env.SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS;
  const previousUpload = process.env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS;
  process.env.SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS = "100";
  process.env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS = "1000";

  try {
    await withUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        const timer = setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "attachment-slow", sizeBytes: 7 }));
        }, 300);
        timer.unref?.();
      });
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-slow-upload",
        launchId: "launch-slow-upload",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read,attachment:upload",
      });

      const startedAt = Date.now();
      const response = await fetch(`${handle.proxyUrl}/internal/agent-api/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/octet-stream",
        },
        body: "fixture",
      });
      const elapsed = Date.now() - startedAt;

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: "attachment-slow", sizeBytes: 7 });
      assert.ok(elapsed >= 250, `upstream response should actually cross the 100ms ordinary deadline, took ${elapsed}ms`);
    });
  } finally {
    if (previousDefault === undefined) delete process.env.SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS;
    else process.env.SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS = previousDefault;
    if (previousUpload === undefined) delete process.env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS;
    else process.env.SLOCK_DAEMON_ATTACHMENT_UPLOAD_HEADERS_TIMEOUT_MS = previousUpload;
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy records failure details when upstream forwarding throws", async () => {
  const failures: unknown[] = [];
  const transportEvents: unknown[] = [];
  await withUpstream((req) => {
    req.socket.destroy(new Error("simulated upstream disconnect"));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-proxy-failure",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordProxyFailure: (input) => failures.push(input),
        recordTransportNormalizedError: (input) => transportEvents.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks?channel=%23sec-audit&status=todo`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(res.status, 502);
    const body = await res.json() as {
      code?: string;
      detail?: string;
      proxy?: {
        correlation_id?: string;
        layer?: string;
        route_family?: string;
        failure_class?: string;
        upstream_layer?: string;
        response_started?: boolean;
        response_complete?: boolean;
        cause_code?: string;
        target_host_class?: string;
        launch_id?: string;
        upstream?: string;
      };
    };
    assert.equal(body.code, "agent_proxy_failed");
    assert.ok(body.detail, "proxy response should preserve sanitized failure detail");
    assert.match(body.proxy?.correlation_id ?? "", /^[0-9a-f]{16}$/);
    assert.equal(res.headers.get("x-raft-correlation-id"), body.proxy?.correlation_id);
    assert.deepEqual(body.proxy, {
      layer: "local_daemon_proxy",
      correlation_id: body.proxy?.correlation_id,
      route_family: "tasks",
      failure_class: "pre_response_transport",
      response_started: false,
      response_complete: false,
      cause_code: "UND_ERR_SOCKET",
      upstream_layer: "tcp",
      target_host_class: "custom_server",
      launch_id: "launch-proxy-failure",
      downstream_caller: "cli",
      upstream: "server",
    });
    assert.deepEqual(failures, [{
      method: "GET",
      pathname: "/internal/agent-api/tasks",
      queryKeys: ["channel", "status"],
      correlationId: body.proxy?.correlation_id,
      errorName: "TypeError",
      errorMessage: body.detail,
      errorCause: "UND_ERR_SOCKET other side closed",
      routeFamily: "tasks",
      failureClass: "pre_response_transport",
      responseStarted: false,
      responseComplete: false,
      causeCode: "UND_ERR_SOCKET",
      upstreamLayer: "tcp",
      launchId: "launch-proxy-failure",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
    assert.deepEqual(transportEvents, [{
      normalizedCode: "transport_failure",
      routeFamily: "tasks",
      failureClass: "pre_response_transport",
      responseStarted: false,
      responseComplete: false,
      causeCode: "UND_ERR_SOCKET",
      upstreamLayer: "tcp",
      originalMessage: body.detail,
      launchId: "launch-proxy-failure",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
  });
});

test("proxy diagnostics class fixture pre_response_transport", async () => {
  if (shouldSkipProxyDiagnosticFixture("pre_response_transport")) return;
  const realFetch = installDaemonFetchMock((async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = cause;
    throw error;
  }) as typeof fetch);
  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-pre-response",
      launchId: "launch-pre-response",
      serverUrl: "https://api.raft.build",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
    });
    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(new URL("/internal/agent-api/tasks/claim", handle.proxyUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 502);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify({ channel: "#proj-runtime", message_id: "abc12345" }));
    });
    const proxy = body.proxy as Record<string, unknown> | undefined;
    recordProxyDiagnosticFixtureWitness("pre_response_transport");
    recordProxyTimeoutDiscriminatorWitness("connect_timeout");
    assert.match(String(proxy?.correlation_id ?? ""), /^[0-9a-f]{16}$/);
    assert.equal(proxy?.failure_class, "pre_response_transport");
    assert.equal(proxy?.response_started, false);
    assert.equal(proxy?.response_complete, false);
    assert.equal(proxy?.cause_code, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(proxy?.upstream_layer, "unknown");
    assert.doesNotMatch(JSON.stringify(proxy), /sk_agent|proj-runtime|abc12345|\/internal\/agent-api/);
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy maps hostile transport error codes to a closed public cause code", async () => {
  const realFetch = installDaemonFetchMock((async () => {
    const cause = Object.assign(new Error("private customer sk_agent_secret failed"), {
      code: "CUSTOMER_SECRET_SHARD_7",
    });
    const error = new Error("fetch failed before headers") as Error & { cause?: unknown };
    error.name = "CUSTOMER_TOKEN_ERROR";
    error.cause = cause;
    throw error;
  }) as typeof fetch);
  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-hostile-cause",
      launchId: "launch-hostile-cause",
      serverUrl: "https://api.raft.build",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
    });
    const body = await new Promise<{ detail?: string; proxy?: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(new URL("/internal/agent-api/server?target=dm:@alice", handle.proxyUrl), {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 502);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { detail?: string; proxy?: Record<string, unknown> });
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body.proxy?.failure_class, "pre_response_transport");
    assert.equal(body.proxy?.cause_code, "UPSTREAM_TRANSPORT_FAILURE");
    assert.doesNotMatch(JSON.stringify(body), /CUSTOMER_SECRET_SHARD_7|CUSTOMER_TOKEN_ERROR|sk_agent_secret|dm:@alice/);
  } finally {
    restoreDaemonFetchMock(realFetch);
    await __resetAgentCredentialProxyForTest();
  }
});

test("proxy diagnostics class fixture mid_response_transport", async () => {
  if (shouldSkipProxyDiagnosticFixture("mid_response_transport")) return;
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{\"ok\":");
    setImmediate(() => res.destroy(new Error("simulated body truncation")));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-mid-response",
      launchId: "launch-mid-response",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });
    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23proj-runtime`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { proxy?: Record<string, unknown> };
    recordProxyDiagnosticFixtureWitness("mid_response_transport");
    assert.match(String(body.proxy?.correlation_id ?? ""), /^[0-9a-f]{16}$/);
    assert.equal(body.proxy?.failure_class, "mid_response_transport");
    assert.equal(body.proxy?.response_started, true);
    assert.equal(body.proxy?.response_complete, false);
    assert.equal(body.proxy?.cause_code, "UND_ERR_SOCKET");
    assert.doesNotMatch(JSON.stringify(body.proxy), /127\.0\.0\.1|proj-runtime|sk_agent|\/internal\/agent-api/);
  });
});

test("proxy diagnostics class fixture upstream_http_response", async () => {
  if (shouldSkipProxyDiagnosticFixture("upstream_http_response")) return;
  await withUpstream((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "private upstream exception body" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-http-response",
      launchId: "launch-http-response",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
    });
    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-runtime", message_id: "abc12345" }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error?: string; detail?: string; proxy?: Record<string, unknown> };
    recordProxyDiagnosticFixtureWitness("upstream_http_response");
    assert.equal(body.error, "upstream HTTP response failed");
    assert.equal(body.detail, "upstream returned HTTP 503");
    assert.match(String(body.proxy?.correlation_id ?? ""), /^[0-9a-f]{16}$/);
    assert.equal(body.proxy?.failure_class, "upstream_http_response");
    assert.equal(body.proxy?.response_started, true);
    assert.equal(body.proxy?.response_complete, true);
    assert.equal(body.proxy?.cause_code, "HTTP_503");
    assert.doesNotMatch(JSON.stringify(body), /private upstream exception body|proj-runtime|abc12345|sk_agent/);
  });
});

test("agent credential proxy reports local lifecycle invariant failures as typed non-5xx errors", async () => {
  const failures: unknown[] = [];
  const transportEvents: unknown[] = [];
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const invariantMessage = [
      "Agent no-process residency invariant violation after visible-consume:",
      "fingerprint fence without running process, idle retry config, or terminal failure",
      "for d2bf1e2c-3648-4590-a0e2-46c6998b2c38",
    ].join(" ");
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-local-invariant",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => [{
          seq: 101,
          id: "pending-101",
          channel_type: "channel",
          channel_name: "proj-o11y",
          sender_type: "human",
          sender_name: "tygg",
          content: "please check",
        }],
        consumeVisibleMessages: () => {
          throw new Error(invariantMessage);
        },
        recordProxyFailure: (input) => failures.push(input),
        recordTransportNormalizedError: (input) => transportEvents.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/events?since=latest&limit=1`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(res.status, 409);
    const body = await res.json() as {
      code?: string;
      error?: string;
      detail?: string;
      agent_id?: string;
      invariant_context?: string;
      proxy?: { correlation_id?: string };
    };
    assert.equal(body.code, "agent_lifecycle_state_invalid");
    assert.equal(body.error, "local daemon agent lifecycle state invalid");
    assert.equal(body.detail, invariantMessage);
    assert.equal(body.agent_id, "d2bf1e2c-3648-4590-a0e2-46c6998b2c38");
    assert.equal(body.invariant_context, "visible-consume");
    assert.match(body.proxy?.correlation_id ?? "", /^[0-9a-f]{16}$/);
    assert.deepEqual(failures, [{
      method: "GET",
      pathname: "/internal/agent-api/events",
      queryKeys: ["limit", "since"],
      correlationId: body.proxy?.correlation_id,
      errorName: "Error",
      errorMessage: invariantMessage,
      routeFamily: "agent-api/events",
      failureClass: "pre_response_transport",
      responseStarted: false,
      responseComplete: false,
      causeCode: "LOCAL_DAEMON_STATE_INVALID",
      upstreamLayer: "unknown",
      launchId: "launch-local-invariant",
      targetHostClass: "local_daemon",
      downstreamCaller: "cli",
      upstream: "local_daemon",
      responseStatusCode: 409,
      responseCode: "agent_lifecycle_state_invalid",
      responseError: "local daemon agent lifecycle state invalid",
      lifecycleInvalidAgentId: "d2bf1e2c-3648-4590-a0e2-46c6998b2c38",
      lifecycleInvalidContext: "visible-consume",
    }]);
    assert.deepEqual(transportEvents, [{
      normalizedCode: "local_daemon_state_invalid",
      routeFamily: "agent-api/events",
      failureClass: "pre_response_transport",
      responseStarted: false,
      responseComplete: false,
      causeCode: "LOCAL_DAEMON_STATE_INVALID",
      upstreamLayer: "unknown",
      originalMessage: invariantMessage,
      launchId: "launch-local-invariant",
      targetHostClass: "local_daemon",
      downstreamCaller: "cli",
      upstream: "local_daemon",
    }]);
  });
});

test("agent credential proxy does not write a JSON failure after streaming response headers", async () => {
  const failures: unknown[] = [];
  const transportEvents: unknown[] = [];
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.from("partial"));
    setImmediate(() => {
      res.destroy(new Error("simulated streaming disconnect"));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-stream-failure",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordProxyFailure: (input) => failures.push(input),
        recordTransportNormalizedError: (input) => transportEvents.push(input),
      },
    });

    const responseOrError = await fetch(`${handle.proxyUrl}/internal/agent-api/attachments/att-1`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    }).then(
      async (res) => {
        assert.equal(res.status, 200);
        assert.match(res.headers.get("x-raft-correlation-id") ?? "", /^[0-9a-f]{16}$/);
        assert.equal(res.headers.get("x-raft-proxy-stream-carrier"), "1");
        assert.equal(res.headers.get("x-raft-proxy-route-family"), "agent-api/attachments");
        assert.equal(res.headers.get("x-raft-proxy-target-host-class"), "custom_server");
        assert.equal(res.headers.get("x-raft-proxy-launch-id"), "launch-stream-failure");
        await assert.rejects(() => res.arrayBuffer());
        return "body-rejected";
      },
      (err: unknown) => err,
    );

    assert.ok(responseOrError, "client should observe a closed stream or rejected fetch");
    assert.deepEqual(failures, [{
      method: "GET",
      pathname: "/internal/agent-api/attachments/att-1",
      queryKeys: [],
      correlationId: (failures[0] as { correlationId?: string }).correlationId,
      errorName: "TypeError",
      errorMessage: "terminated",
      errorCause: "UND_ERR_SOCKET other side closed",
      routeFamily: "agent-api/attachments",
      failureClass: "mid_response_transport",
      responseStarted: true,
      responseComplete: false,
      causeCode: "UND_ERR_SOCKET",
      upstreamLayer: "tcp",
      launchId: "launch-stream-failure",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
    assert.deepEqual(transportEvents, [{
      normalizedCode: "transport_failure",
      routeFamily: "agent-api/attachments",
      failureClass: "mid_response_transport",
      responseStarted: true,
      responseComplete: false,
      causeCode: "UND_ERR_SOCKET",
      upstreamLayer: "tcp",
      originalMessage: "terminated",
      launchId: "launch-stream-failure",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
  });
});

test("agent credential proxy carries real streaming mid-response diagnostics to the CLI client", async () => {
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.from("partial"));
    setImmediate(() => {
      res.destroy(new Error("simulated streaming disconnect"));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-stream-cli",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
    });
    const clientContext: AgentContext = {
      agentId: "agent-1",
      serverId: "server-1",
      serverUrl: handle.proxyUrl,
      token: handle.proxyToken,
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      activeCapabilities: null,
    };
    const response = await new ApiClient(clientContext).requestBinary("GET", "/internal/agent-api/attachments/att-1");

    assert.equal(response.ok, false);
    assert.equal(response.status, 502);
    assert.equal(response.errorCode, "agent_proxy_failed");
    assert.equal(response.error, "failed to proxy local agent request");
    assert.equal(response.proxy?.layer, "local_daemon_proxy");
    assert.match(response.proxy?.correlationId ?? "", /^[0-9a-f]{16}$/);
    assert.equal(response.proxy?.failureClass, "mid_response_transport");
    assert.equal(response.proxy?.causeCode, "RESPONSE_BODY_STREAM_FAILED");
    assert.equal(response.proxy?.routeFamily, "agent-api/attachments");
    assert.equal(response.proxy?.upstreamLayer, "body_stream");
    assert.equal(response.proxy?.responseStarted, true);
    assert.equal(response.proxy?.responseComplete, false);
    assert.equal(response.proxy?.targetHostClass, "custom_server");
    assert.equal(response.proxy?.launchId, "launch-stream-cli");
    assert.doesNotMatch(JSON.stringify(response), /partial|simulated streaming disconnect|sk_agent|127\.0\.0\.1|att-1/);
  });
});

test("agent credential proxy classifies localhost upstream server failures as custom server", async () => {
  const transportEvents: unknown[] = [];
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const address = closed.address();
  assert.ok(address && typeof address === "object");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => closed.close((err) => err ? reject(err) : resolve()));

  const handle = await registerAgentCredentialProxy({
    agentId: "agent-1",
    launchId: "launch-local-server-failure",
    serverUrl,
    apiKey: "sk_agent_server_side",
    activeCapabilities: "read,tasks",
    inboxCoordinator: {
      getBoundary: () => undefined,
      getPendingMessages: () => [],
      consumeVisibleMessages: () => {},
      recordTransportNormalizedError: (input) => transportEvents.push(input),
    },
  });

  const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks?channel=%23sec-audit&status=todo`, {
    headers: { Authorization: `Bearer ${handle.proxyToken}` },
  });

  assert.equal(res.status, 502);
  assert.deepEqual(transportEvents, [{
    normalizedCode: "transport_failure",
    routeFamily: "tasks",
    failureClass: "pre_response_transport",
    responseStarted: false,
    responseComplete: false,
    causeCode: "ECONNREFUSED",
    upstreamLayer: "tcp",
    originalMessage: "fetch failed",
    launchId: "launch-local-server-failure",
    targetHostClass: "custom_server",
    downstreamCaller: "cli",
    upstream: "server",
  }]);
});

test("agent credential proxy records transport-normalized errors for upstream HTTP 5xx", async () => {
  const transportEvents: unknown[] = [];
  await withUpstream((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "service unavailable" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-http-status",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordTransportNormalizedError: (input) => transportEvents.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-daemon", message_id: "9976cc2c" }),
    });

    assert.equal(res.status, 503);
    assert.deepEqual(transportEvents, [{
      normalizedCode: "server_5xx",
      routeFamily: "tasks/claim",
      failureClass: "upstream_http_response",
      responseStarted: true,
      responseComplete: true,
      causeCode: "HTTP_503",
      upstreamLayer: "http_status",
      upstreamStatus: 503,
      launchId: "launch-http-status",
      targetHostClass: "custom_server",
      downstreamCaller: "cli",
      upstream: "server",
    }]);
  });
});

test("agent credential proxy classifies api.slock.ai proxy connect transport failures", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.slock.ai/internal/agent-api/send"),
    new Error("proxy CONNECT failed before upstream response"),
    "launch-proxy-connect",
  );

  assert.deepEqual(event, {
    normalizedCode: "transport_failure",
    routeFamily: "agent-api/send",
    failureClass: "pre_response_transport",
    responseStarted: false,
    responseComplete: false,
    causeCode: "UPSTREAM_TRANSPORT_FAILURE",
    upstreamLayer: "proxy_connect",
    originalMessage: "proxy CONNECT failed before upstream response",
    launchId: "launch-proxy-connect",
    targetHostClass: "api.slock.ai",
    downstreamCaller: "cli",
    upstream: "server",
  });
});

test("agent credential proxy classifies api.raft.build as the Raft API host", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.raft.build/internal/agent-api/send"),
    new Error("proxy CONNECT failed before upstream response"),
    "launch-proxy-connect",
  );

  assert.equal(event.targetHostClass, "api.raft.build");
  assert.equal(event.routeFamily, "agent-api/send");
  assert.equal(event.upstreamLayer, "proxy_connect");
});

test("agent credential proxy locally holds same-target pending before forwarding send", async () => {
  let upstreamSendCount = 0;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      upstreamSendCount += 1;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "unexpected-send" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: (target) => target === "dm:@tygg"
          ? Array.from({ length: 5 }, (_, idx) => {
              const seq = 40 + idx;
              return {
                seq,
                id: `pending-${seq}`,
                channel_type: "dm",
                channel_name: "tygg",
                sender_type: "human",
                sender_name: "tygg",
                content: `pending dm ${seq}`,
                createdAt: "2026-05-19T00:00:00.000Z",
              };
            })
          : [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });

    assert.equal(upstreamSendCount, 0, "pending same-target inbox should local-hold before upstream send");
    assert.equal(res.status, 200);
    const body = await res.json() as {
      state?: string;
      seenUpToSeq?: number;
      newMessageCount?: number;
      shownMessageCount?: number;
      omittedMessageCount?: number;
      outcome?: string;
      subtype?: string;
      reason?: string;
      producerFactId?: string;
      available_actions?: string[];
      heldMessages?: Array<{ seq?: number; message_id?: string; channel_type?: string; channel_name?: string; content?: string }>;
    };
    assert.equal(body.state, "held");
    assert.equal(body.outcome, "held");
    assert.equal(body.subtype, "freshness");
    assert.equal(body.reason, "newer_messages_available");
    assert.deepEqual(body.available_actions, ["check_messages", "send_draft", "send_anyway"]);
    assert.equal(body.seenUpToSeq, 44);
    assert.equal(body.newMessageCount, 5);
    assert.equal(body.shownMessageCount, 3);
    assert.equal(body.omittedMessageCount, 2);
    assert.deepEqual(body.heldMessages?.map((message) => message.seq), [42, 43, 44]);
    assert.equal(body.heldMessages?.[0]?.message_id, "pending-42");
    assert.equal(body.heldMessages?.[0]?.channel_type, "dm");
    assert.equal(body.heldMessages?.[0]?.channel_name, "tygg");
    assert.deepEqual(consumed, [{
      target: "dm:@tygg",
      source: "side_effect_preflight_context",
      boundarySeq: 44,
      seqs: [42, 43, 44],
    }]);
    const expectedDecision = {
      action: "send",
      decision: "local_hold",
      target: "dm:@tygg",
      inboxTrustState: "trusted",
      reason: "exact_target_pending",
      pendingCount: 5,
      pendingMaxSeq: 44,
      modelSeenSeq: undefined,
      heldMessageCount: 3,
      omittedMessageCount: 2,
    } as const;
    const expectedProducerFactId = buildApmFreshnessDecisionProducerFactId("agent-1", expectedDecision);
    assert.equal(body.producerFactId, expectedProducerFactId);
    assert.deepEqual(decisions, [{
      ...expectedDecision,
      producerFactId: expectedProducerFactId,
    }]);
  });
});

test("agent credential proxy reviewer isolation returns a body-free local hold without consuming", async () => {
  let upstreamSendCount = 0;
  const consumed: unknown[] = [];
  const secretBody = "paired reviewer says REQUEST CHANGES";
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "unexpected-send" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-reviewer-isolation",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 40,
        getPendingMessages: () => [{
          seq: 41,
          id: "pending-41",
          channel_type: "channel",
          channel_name: "reviews",
          sender_type: "agent",
          sender_name: "peer-reviewer",
          content: secretBody,
        }],
        consumeVisibleMessages: (input) => consumed.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "#reviews:blind",
        content: "my independent verdict",
        freshnessContextMode: "withheld",
      }),
    });
    const body = await res.json() as Record<string, unknown>;

    assert.equal(upstreamSendCount, 0);
    assert.equal(body.state, "held");
    assert.equal(body.freshnessContextMode, "withheld");
    assert.equal(body.withheldMessageCount, 1);
    assert.deepEqual(body, {
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 1,
    });
    assert.deepEqual(consumed, []);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secretBody));
  });
});

test("agent credential proxy locally holds task side effects on same-target pending even with stray continueAnyway", async () => {
  let upstreamClaimCount = 0;
  let upstreamUpdateCount = 0;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/tasks/claim") upstreamClaimCount += 1;
    if (req.url === "/internal/agent-api/tasks/update-status") upstreamUpdateCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 1, success: true }] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-hold",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read,tasks",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: (target) => target === "#proj-runtime"
          ? [{ seq: 8, id: "pending-8", channel_type: "channel", channel_name: "proj-runtime", content: "new task context" }]
          : [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const claim = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-runtime", task_numbers: [201], continueAnyway: true }),
    });
    const update = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/update-status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-runtime", task_number: 201, status: "in_review", continueAnyway: true }),
    });

    assert.equal(upstreamClaimCount, 0);
    assert.equal(upstreamUpdateCount, 0);
    const claimBody = await claim.json() as { state?: string; seenUpToSeq?: number; available_actions?: string[] };
    const updateBody = await update.json() as { state?: string; seenUpToSeq?: number; available_actions?: string[] };
    assert.equal(claimBody.state, "held");
    assert.deepEqual(claimBody.available_actions, ["check_messages", "retry_action"]);
    assert.equal(updateBody.seenUpToSeq, 8);
    assert.deepEqual(updateBody.available_actions, ["check_messages", "retry_action"]);
    assert.deepEqual(consumed, [
      { target: "#proj-runtime", source: "side_effect_preflight_context", boundarySeq: 8, seqs: [8] },
      { target: "#proj-runtime", source: "side_effect_preflight_context", boundarySeq: 8, seqs: [8] },
    ]);
    assert.deepEqual(decisions.map((decision) => (decision as { action?: string; decision?: string; reason?: string }).action), ["task_claim", "task_update"]);
    assert.ok(decisions.every((decision) => (decision as { decision?: string; reason?: string }).decision === "local_hold"));
    assert.ok(decisions.every((decision) => (decision as { decision?: string; reason?: string }).reason === "exact_target_pending"));
  });
});

test("agent credential proxy fail-closes task side effects on first-touch target", async () => {
  let upstreamClaimCount = 0;
  let upstreamUpdateCount = 0;
  let upstreamHistoryCount = 0;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 99,
            id: "recent-task-99",
            senderType: "human",
            senderName: "tygg",
            content: "new task context before claim",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/tasks/claim") upstreamClaimCount += 1;
    if (req.url === "/internal/agent-api/tasks/update-status") upstreamUpdateCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-first-touch",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const requests: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: "/internal/agent-api/tasks/claim", body: { channel: "#proj-runtime", task_numbers: [201] } },
      { path: "/internal/agent-api/tasks/update-status", body: { channel: "#proj-runtime", task_number: 201, status: "in_review" } },
    ];

    const responses = [];
    for (const request of requests) {
      const res = await fetch(`${handle.proxyUrl}${request.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
      });
      assert.equal(res.status, 200);
      responses.push(await res.json() as { state?: string; seenUpToSeq?: number; producerFactId?: string; available_actions?: string[]; heldMessages?: Array<{ seq?: number }> });
    }

    assert.equal(upstreamClaimCount, 0);
    assert.equal(upstreamUpdateCount, 0);
    assert.equal(upstreamHistoryCount, 2);
    assert.deepEqual(responses.map((body) => body.state), ["held", "held"]);
    assert.deepEqual(responses.map((body) => body.seenUpToSeq), [99, 99]);
    assert.ok(responses.every((body) => body.available_actions?.join(",") === "check_messages,retry_action"));
    assert.ok(responses.every((body) => body.heldMessages?.[0]?.seq === 99));
    assert.deepEqual(consumed, [
      { target: "#proj-runtime", source: "side_effect_preflight_context", boundarySeq: 99, seqs: [99] },
      { target: "#proj-runtime", source: "side_effect_preflight_context", boundarySeq: 99, seqs: [99] },
    ]);
    const expectedClaimDecision = {
      action: "task_claim",
      decision: "syncing_hold",
      target: "#proj-runtime",
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context",
      pendingCount: 0,
      pendingMaxSeq: 99,
      modelSeenSeq: 0,
      heldMessageCount: 1,
      omittedMessageCount: 0,
    } as const;
    const expectedUpdateDecision = {
      action: "task_update",
      decision: "syncing_hold",
      target: "#proj-runtime",
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context",
      pendingCount: 0,
      pendingMaxSeq: 99,
      modelSeenSeq: 0,
      heldMessageCount: 1,
      omittedMessageCount: 0,
    } as const;
    assert.deepEqual(decisions, [
      {
        ...expectedClaimDecision,
        producerFactId: buildApmFreshnessDecisionProducerFactId("agent-1", expectedClaimDecision),
      },
      {
        ...expectedUpdateDecision,
        producerFactId: buildApmFreshnessDecisionProducerFactId("agent-1", expectedUpdateDecision),
      },
    ]);
    assert.deepEqual(
      responses.map((body) => body.producerFactId),
      [
        buildApmFreshnessDecisionProducerFactId("agent-1", expectedClaimDecision),
        buildApmFreshnessDecisionProducerFactId("agent-1", expectedUpdateDecision),
      ],
    );
  });
});

test("agent credential proxy forwards first-touch target when recent context has no seq boundary", async () => {
  let upstreamClaimCount = 0;
  let upstreamHistoryCount = 0;
  const consumed: unknown[] = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            id: "recent-task-no-seq",
            senderType: "human",
            senderName: "tygg",
            content: "context without seq boundary",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/tasks/claim") upstreamClaimCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-first-touch-no-seq",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => consumed.push(input),
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "#proj-runtime", task_numbers: [201] }),
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json() as { ok?: boolean }).ok, true);
    assert.equal(upstreamHistoryCount, 1);
    assert.equal(upstreamClaimCount, 1);
    assert.deepEqual(consumed, []);
    assert.deepEqual(decisions, [{
      action: "task_claim",
      decision: "forward",
      target: "#proj-runtime",
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context_without_seq_boundary",
      pendingCount: 0,
      modelSeenSeq: 0,
    }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FH-001 Freshness-Hold Eligibility verifier
//
// Contract (Tao FH-001, frozen): a cold exact-target first-touch must HOLD only
// when the fetched recent rows contain messages outside the MODEL-SEEN boundary.
// Self-authored send commits must enter the exact consumed set without raising
// the contiguous boundary, so later self rows are seen without an author-id
// special case or boundary overshoot. Root-cause invariant:
// daemon-local-presence (cold-fetched into local cache) != model-seen. The
// strip-red pairs below pin boundary membership instead of merely testing that
// cold-fetched context exists.
// ─────────────────────────────────────────────────────────────────────────────

test("FH-001: boundary-inside exact-target forwards send (no syncing_hold, no --anyway needed)", async () => {
  let upstreamSendCount = 0;
  let upstreamHistoryCount = 0;
  const consumed: Array<{ target?: string; source?: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 51,
            id: "seen-51",
            message_id: "seen-51",
            sender_id: "agent-1",
            senderId: "agent-1",
            sender_type: "agent",
            senderType: "agent",
            sender_name: "ApplePI",
            senderName: "ApplePI",
            content: "boundary-inside earlier reply in this thread",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-boundary-inside-first-touch",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 51,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => consumed.push({
          target: input.target,
          source: input.source,
          boundarySeq: input.boundarySeq,
          seqs: input.messages.map((message) => Number(message.seq ?? 0)),
        }),
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "#contracts:97dbd451", content: "follow-up in my own thread" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { state?: string };
    // FH-001 MUST: boundary-inside first-touch forwards; the send reaches
    // upstream and is NOT held. `--send-draft --anyway` MUST NOT be required.
    assert.equal(body.state, "sent", "boundary-inside first-touch must forward, not hold");
    assert.equal(upstreamSendCount, 1, "send must reach upstream");
    assert.equal(upstreamHistoryCount, 0, "known boundary avoids cold history fallback");
    assert.deepEqual(
      decisions.map((d) => (d as { decision?: string }).decision),
      ["forward"],
      "decision must be forward, not syncing_hold, for boundary-inside context",
    );
    assert.deepEqual(consumed, [], "no local hold context is consumed on boundary forward");
  });
});

// Strip-red discrimination pair: the SAME first-touch shape with no known
// boundary and a recent row outside model-seen MUST hold. If this passes green
// while the boundary-inside test above forwards, it defends against vacuous
// "always forward" and "always hold" fixes.
test("FH-001: unseen cold first-touch holds send (strip-red boundary flip)", async () => {
  let upstreamSendCount = 0;
  let upstreamHistoryCount = 0;
  const consumed: Array<{ target?: string; source?: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 51,
            id: "unseen-51",
            message_id: "unseen-51",
            sender_id: "human-9",
            senderId: "human-9",
            sender_type: "human",
            senderType: "human",
            sender_name: "tygg",
            senderName: "tygg",
            content: "an unread reply from someone else",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-counterparty-first-touch",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => consumed.push({
          target: input.target,
          source: input.source,
          boundarySeq: input.boundarySeq,
          seqs: input.messages.map((message) => Number(message.seq ?? 0)),
        }),
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "#contracts:97dbd451", content: "reply that should wait for context" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { state?: string; newMessageCount?: number; seenUpToSeq?: number; producerFactId?: string; heldMessages?: Array<{ seq?: number }> };
    // FH-001: boundary-outside recent context -> held. Send is NOT forwarded;
    // `--anyway` is the legit override here.
    assert.equal(body.state, "held", "unseen first-touch context must hold");
    assert.equal(upstreamSendCount, 0, "send must NOT reach upstream while held");
    const expectedDecision = {
      action: "send",
      decision: "syncing_hold",
      target: "#contracts:97dbd451",
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context",
      pendingCount: 0,
      pendingMaxSeq: 51,
      modelSeenSeq: 0,
      heldMessageCount: 1,
      omittedMessageCount: 0,
    } as const;
    const expectedProducerFactId = buildApmFreshnessDecisionProducerFactId("agent-1", expectedDecision);
    assert.deepEqual(decisions, [{ ...expectedDecision, producerFactId: expectedProducerFactId }]);
    assert.equal(body.newMessageCount, 1);
    assert.equal(body.seenUpToSeq, 51);
    assert.equal(body.producerFactId, expectedProducerFactId);
    assert.equal(body.heldMessages?.[0]?.seq, 51, "held envelope carries the unseen row");
    assert.deepEqual(consumed, [{
      target: "#contracts:97dbd451",
      source: "side_effect_preflight_context",
      boundarySeq: 51,
      seqs: [51],
    }], "all fetched rows advance the exact-target boundary after the hold context is projected");
  });
});

// Model-seen axis (FH-001 amendment A, @Tao/@Adspectum) — the承重 anti-false-fix axis.
// The conjunction `(counterparty ∧ ¬model-seen)` requires a SECOND discrimination:
// the SAME unconsumed counterparty row must FORWARD when the model has provably
// seen it and HOLD when it has not. Without this axis, a fake fix using
// "daemon-local-presence == consumed" passes the already-injected->forward case
// while still mis-holding — the exact bug FH-001 roots out.
//
test("FH-001: model-seen counterparty cold first-touch forwards (strip-red model-seen flip)", async () => {
  let upstreamSendCount = 0;
  const decisions: unknown[] = [];
  const consumed: Array<{ target?: string; source?: string; boundarySeq?: number; seqs: number[] }> = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 40,
            id: "counterparty-40",
            message_id: "counterparty-40",
            sender_id: "human-9",
            senderId: "human-9",
            sender_type: "human",
            senderType: "human",
            sender_name: "tygg",
            senderName: "tygg",
            // The model already saw this row this turn through an exact-target
            // read/injection, but there is still no seq boundary for this cold
            // target. The coordinator predicate is the model-seen source of truth.
            content: "a counterparty row the model already saw this turn",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-model-seen-cold-dep",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined, // cold: no seq boundary
        getPendingMessages: () => [],
        isMessageModelSeen: ({ message }) => message.message_id === "counterparty-40",
        consumeVisibleMessages: (input) => consumed.push({
          target: input.target,
          source: input.source,
          boundarySeq: input.boundarySeq,
          seqs: input.messages.map((message) => Number(message.seq ?? 0)),
        }),
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "#contracts:97dbd451", content: "reply after seeing context this turn" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { state?: string };
    assert.equal(body.state, "sent", "model-seen counterparty cold first-touch must forward");
    assert.equal(upstreamSendCount, 1, "send must reach upstream once the only counterparty row is model-seen");
    assert.deepEqual(
      decisions.map((d) => (d as { decision?: string }).decision),
      ["forward"],
      "decision must be forward when the counterparty row is model-seen",
    );
    assert.deepEqual(consumed, [{
      target: "#contracts:97dbd451",
      source: "side_effect_preflight_context",
      boundarySeq: 40,
      seqs: [40],
    }]);
  });
});

test("FH-001: delivered-but-not-model-seen counterparty cold first-touch holds (model-seen anti-presence pin)", async () => {
  let upstreamSendCount = 0;
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 40,
            id: "counterparty-40",
            message_id: "counterparty-40",
            sender_id: "human-9",
            senderId: "human-9",
            sender_type: "human",
            senderType: "human",
            sender_name: "tygg",
            senderName: "tygg",
            content: "a counterparty row present in daemon local context but not model-seen",
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-model-seen-presence-guard",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        // Presence in the freshly fetched local context is not model-seen.
        isMessageModelSeen: () => false,
        consumeVisibleMessages: () => {},
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "#contracts:97dbd451", content: "reply after daemon-only context" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { state?: string; heldMessages?: Array<{ message_id?: string }> };
    assert.equal(body.state, "held", "delivered/local-presence counterparty row is not model-seen and must hold");
    assert.equal(upstreamSendCount, 0);
    assert.deepEqual(
      decisions.map((d) => (d as { decision?: string }).decision),
      ["syncing_hold"],
    );
    assert.equal(body.heldMessages?.[0]?.message_id, "counterparty-40");
  });
});

test("agent credential proxy does not consume pending messages for other targets", async () => {
  let observedBody: any = null;
  const consumed: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      observedBody = JSON.parse(raw);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: (target) => target === "dm:@tygg" ? 40 : undefined,
        getPendingMessages: (target) => target === "#other"
          ? [{ seq: 50, channel_type: "channel", channel_name: "other", content: "other pending" }]
          : [],
        consumeVisibleMessages: (input) => { consumed.push(input); },
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });

    assert.equal(res.status, 200);
    assert.equal(observedBody?.seenUpToSeq, 40);
    assert.deepEqual(consumed, []);
  });
});

test("agent credential proxy records successful self send by exact id without advancing boundary", async () => {
  let upstreamSendCount = 0;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[]; ids: Array<string | undefined> }> = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      upstreamSendCount += 1;
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { target?: string; content?: string; seenUpToSeq?: number };
      if (upstreamSendCount === 1) {
        assert.equal(body.seenUpToSeq, 40);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, state: "sent", messageId: "self-41", messageSeq: 41 }));
        return;
      }
      assert.equal(body.seenUpToSeq, 40);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: "sent", messageId: "self-42", messageSeq: 42 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    let boundary = 40;
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-self-send-boundary",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => boundary,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
            ids: input.messages.map((message) => message.message_id ?? message.id),
          });
          if (input.target === "dm:@tygg" && typeof input.boundarySeq === "number") {
            boundary = Math.max(boundary, input.boundarySeq);
          }
        },
      },
    });

    for (const content of ["first", "second"]) {
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: "dm:@tygg", content }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { state?: string }).state, "sent");
    }

    assert.equal(upstreamSendCount, 2);
    assert.deepEqual(consumed, [
      { target: "dm:@tygg", source: "agent_api_send_commit", boundarySeq: undefined, seqs: [0], ids: ["self-41"] },
      { target: "dm:@tygg", source: "agent_api_send_commit", boundarySeq: undefined, seqs: [0], ids: ["self-42"] },
    ]);
  });
});

test("agent credential proxy lets explicit send bypass forward despite pending inbox", async () => {
  let observedBody: any = null;
  const decisions: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      observedBody = JSON.parse(raw);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-anyway" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-anyway",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: (target) => target === "dm:@tygg"
          ? [{ seq: 8, channel_type: "dm", channel_name: "tygg", content: "newer pending" }]
          : [],
        consumeVisibleMessages: () => {},
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply", continueAnyway: true }),
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json() as { state?: string }).state, "sent");
    assert.equal(observedBody?.continueAnyway, true);
    assert.deepEqual(decisions, [{
      action: "send",
      decision: "bypass",
      target: "dm:@tygg",
      inboxTrustState: "trusted",
      reason: "continue_anyway",
    }]);
  });
});

test("agent credential proxy freshness preflight is exact-target scoped", async () => {
  const observedBodies: Array<Record<string, unknown>> = [];
  const consumed: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      observedBodies.push(JSON.parse(raw));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: `sent-${observedBodies.length}` }));
  }, async (serverUrl) => {
    const pendingByTarget = new Map<string, Array<{ seq: number; channel_type: string; channel_name: string; parent_channel_type?: string; parent_channel_name?: string; content: string }>>([
      ["#proj-runtime:sibling", [{ seq: 50, channel_type: "thread", channel_name: "sibling", parent_channel_type: "channel", parent_channel_name: "proj-runtime", content: "sibling thread pending" }]],
      ["#proj-runtime:child", [{ seq: 60, channel_type: "thread", channel_name: "child", parent_channel_type: "channel", parent_channel_name: "proj-runtime", content: "child thread pending" }]],
      ["#unrelated", [{ seq: 70, channel_type: "channel", channel_name: "unrelated", content: "unrelated channel pending" }]],
    ]);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-exact-target",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 12,
        getPendingMessages: (target) => pendingByTarget.get(target) ?? [],
        consumeVisibleMessages: (input) => { consumed.push(input); },
      },
    });

    for (const target of ["#proj-runtime:thread-a", "#proj-runtime", "dm:@tygg"]) {
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ target, content: "reply" }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { state?: string }).state, "sent");
    }

    assert.deepEqual(observedBodies.map((body) => body.target), ["#proj-runtime:thread-a", "#proj-runtime", "dm:@tygg"]);
    assert.ok(observedBodies.every((body) => body.seenUpToSeq === 12));
    assert.deepEqual(consumed, []);
  });
});

test("agent credential proxy consumes server held context after it is returned", async () => {
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      state: "held",
      seenUpToSeq: 8,
      heldMessages: [
        { seq: 8, id: "held-8", channel_type: "dm", channel_name: "tygg", content: "held" },
      ],
    }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { state?: string }).state, "held");
    assert.deepEqual(consumed, [{ target: "dm:@tygg", source: "server_held_context", boundarySeq: 8, seqs: [8] }]);
  });
});

test("reviewer-isolation request does not consume bodies from a legacy server held response", async () => {
  const consumed: unknown[] = [];
  const poison = {
    body: "legacy server accidentally returned peer verdict",
    sender: "legacy-peer-reviewer",
    id: "legacy-held-8",
    timestamp: "2042-02-03T04:05:06.000Z",
    reason: "legacy_peer_rejected",
    error: "legacy hold error copied peer verdict",
    lineage: "freshness_decision_fact:legacy-poison",
  };
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      state: "held",
      outcome: "held",
      subtype: "freshness",
      reason: poison.reason,
      decision: "syncing_hold",
      producerFactId: poison.lineage,
      available_actions: ["read_peer_verdict"],
      error: poison.error,
      newMessageCount: 1,
      shownMessageCount: 1,
      omittedMessageCount: 0,
      seenUpToSeq: 8,
      seenUpToMessageId: poison.id,
      mentionAnnotation: { formalMentionCount: 1 },
      heldMessages: [
        {
          seq: 8,
          id: poison.id,
          channel_type: "dm",
          channel_name: "tygg",
          sender_name: poison.sender,
          timestamp: poison.timestamp,
          content: poison.body,
        },
      ],
    }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-reviewer-isolation-legacy-server",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => consumed.push(input),
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "dm:@tygg",
        content: "reply",
        freshnessContextMode: "withheld",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 1,
    });
    const surface = JSON.stringify(body);
    for (const value of Object.values(poison)) {
      assert.doesNotMatch(surface, new RegExp(value));
    }
    assert.deepEqual(consumed, []);
  });
});

test("reviewer-isolation cold first-touch skips body-returning history and relies on the server count-only hold", async () => {
  let historyCalls = 0;
  let sendCalls = 0;
  const poisonBody = "cold history copied peer verdict";
  await withUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/internal/agent-api/history")) {
      historyCalls += 1;
      res.end(JSON.stringify({
        messages: [{ seq: 71, sender_name: "peer-reviewer", content: poisonBody }],
      }));
      return;
    }
    sendCalls += 1;
    res.end(JSON.stringify({
      state: "held",
      newMessageCount: 1,
      seenUpToSeq: 71,
      heldMessages: [{
        seq: 71,
        sender_name: "peer-reviewer",
        timestamp: "2042-10-11T12:13:14.000Z",
        content: poisonBody,
      }],
    }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-reviewer-isolation-cold",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {
          throw new Error("reviewer-isolation response must not be consumed");
        },
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "#reviews:blind",
        content: "my independent verdict",
        freshnessContextMode: "withheld",
      }),
    });

    assert.equal(historyCalls, 0);
    assert.equal(sendCalls, 1);
    assert.deepEqual(await res.json(), {
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 1,
    });
  });
});

test("reviewer-isolation reprojects legacy held task responses even without a local inbox coordinator", async () => {
  const poison = {
    body: "legacy task response copied another reviewer's verdict",
    sender: "legacy-task-reviewer",
    timestamp: "2042-09-10T11:12:13.000Z",
    reason: "legacy_task_peer_approved",
    error: "legacy task hold error with verdict",
    lineage: "freshness_decision_fact:legacy-task-poison",
  };
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      state: "held",
      producerFactId: poison.lineage,
      reason: poison.reason,
      error: poison.error,
      newMessageCount: 2,
      seenUpToSeq: 88,
      heldMessages: [{
        seq: 88,
        sender_name: poison.sender,
        timestamp: poison.timestamp,
        content: poison.body,
      }],
    }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-reviewer-isolation-task-legacy",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
    });

    const requests = [
      {
        path: "/internal/agent-api/tasks/claim",
        body: {
          channel: "#reviews",
          task_numbers: [7],
          freshnessContextMode: "withheld",
        },
      },
      {
        path: "/internal/agent-api/tasks/update-status",
        body: {
          channel: "#reviews",
          task_number: 7,
          status: "in_review",
          freshnessContextMode: "withheld",
        },
      },
    ];
    for (const request of requests) {
      const res = await fetch(`${handle.proxyUrl}${request.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
      });
      assert.equal(res.status, 200);
      const surface = await res.json() as Record<string, unknown>;
      assert.deepEqual(surface, {
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: 2,
      });
      const serialized = JSON.stringify(surface);
      for (const value of Object.values(poison)) {
        assert.doesNotMatch(serialized, new RegExp(value));
      }
    }
  });
});

test("reviewer-isolation replaces legacy upstream error detail with a static failure", async () => {
  const poison = "upstream error copied peer-reviewer identity and verdict";
  await withUpstream((_req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: poison,
      sender_name: "peer-reviewer",
      timestamp: "2042-11-12T13:14:15.000Z",
    }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-reviewer-isolation-error",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: "#reviews:blind",
        content: "my independent verdict",
        freshnessContextMode: "withheld",
      }),
    });

    assert.equal(res.status, 409);
    const surface = await res.json() as Record<string, unknown>;
    assert.deepEqual(surface, {
      error: "Reviewer-isolation request failed; upstream detail withheld.",
      code: "reviewer_isolation_request_failed",
    });
    assert.doesNotMatch(JSON.stringify(surface), /peer-reviewer|verdict|2042-11-12/);
  });
});

test("agent credential proxy consumes returned events and history as visible inbox materialization", async () => {
  const effectOrder: string[] = [];
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const drainOutcomes: unknown[] = [];
  await withUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/internal/agent-api/events")) {
      res.end(JSON.stringify({
        events: [
          {
            seq: 10,
            id: "event-10",
            channel_type: "dm",
            channel_name: "tygg",
            content: "event",
          },
        ],
      }));
      return;
    }
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.end(JSON.stringify({
        messages: [
          {
            seq: 12,
            id: "history-12",
            channel_type: "channel",
            channel_name: "general",
            content: "history",
          },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          effectOrder.push(`consumed:${input.messages.map((message) => message.seq).join(",")}`);
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordDrainOutcome: (input) => drainOutcomes.push(input),
      },
    });

    const events = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(events.status, 200);
    assert.equal((await events.json() as { events?: unknown[] }).events?.length, 1);
    effectOrder.push("exposed:10");

    const history = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23general`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { messages?: unknown[] }).messages?.length, 1);
    effectOrder.push("exposed:12");

    assert.deepEqual(consumed, [
      { target: undefined, source: "agent_api_events_server", boundarySeq: undefined, seqs: [10] },
      { target: "#general", source: "agent_api_history", boundarySeq: 12, seqs: [12] },
    ]);
    assert.deepEqual(drainOutcomes, [{
      source: "server_events",
      sinceCursorKind: null,
      notifiedCount: 0,
      drainedCount: 1,
      hasMore: false,
    }]);
    assert.deepEqual(effectOrder, [
      "consumed:10",
      "exposed:10",
      "consumed:12",
      "exposed:12",
    ]);
  });
});

test("agent credential proxy serves local pending inbox before forwarding agent-api events", async () => {
  let upstreamEventsCount = 0;
  const consumptionOrder: string[] = [];
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const drainOutcomes: unknown[] = [];
  await withUpstream((req, res) => {
    if (req.url?.startsWith("/internal/agent-api/events")) upstreamEventsCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-local-inbox-events",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => [
          {
            seq: 101,
            id: "pending-101",
            channel_type: "thread",
            channel_name: "thread-9dc24288-d7d3-4599-8e6a-fdc5c2666ac6",
            parent_channel_type: "channel",
            parent_channel_name: "sec-field-05200630",
            sender_type: "human",
            sender_name: "tygg",
            content: "please reply",
            createdAt: "2026-05-20T07:31:31.000Z",
          },
          {
            seq: 102,
            id: "pending-102",
            channel_type: "channel",
            channel_name: "proj-runtime",
            senderType: "agent",
            senderName: "Jianwei",
            content: "diagnostics",
            timestamp: "2026-05-20T07:31:32.000Z",
          },
          {
            seq: 103,
            id: "pending-103",
            channel_type: "dm",
            channel_name: "tygg",
            sender_type: "human",
            sender_name: "tygg",
            content: "third message",
          },
        ],
        consumeVisibleMessages: (input) => {
          consumptionOrder.push("consumed");
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordDrainOutcome: (input) => drainOutcomes.push(input),
      },
    });

    const events = await fetch(`${handle.proxyUrl}/internal/agent-api/events?since=latest&limit=2`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(upstreamEventsCount, 0, "Local Inbox must be served before remote /events");
    assert.equal(events.status, 200);
    const body = await events.json() as {
      events?: Array<{
        seq?: number;
        message_id?: string;
        timestamp?: string;
        sender_type?: string;
        sender_name?: string;
        parent_channel_name?: string;
      }>;
      last_seen_msgId?: string | null;
      last_seen_seq?: number | null;
      has_more?: boolean;
    };
    consumptionOrder.push("response_exposed");
    assert.deepEqual(body.events?.map((message) => message.seq), [101, 102]);
    assert.equal(body.events?.[0]?.message_id, "pending-101");
    assert.equal(body.events?.[0]?.timestamp, "2026-05-20T07:31:31.000Z");
    assert.equal(body.events?.[0]?.parent_channel_name, "sec-field-05200630");
    assert.equal(body.events?.[1]?.sender_type, "agent");
    assert.equal(body.events?.[1]?.sender_name, "Jianwei");
    assert.equal(body.last_seen_msgId, "pending-102");
    assert.equal(body.last_seen_seq, 102);
    assert.equal(body.has_more, true);
    assert.deepEqual(consumed, [{
      target: undefined,
      source: "agent_api_events_local",
      boundarySeq: undefined,
      seqs: [101, 102],
    }]);
    assert.deepEqual(drainOutcomes, [{
      source: "daemon_pending",
      sinceCursorKind: "latest",
      notifiedCount: 3,
      drainedCount: 2,
      hasMore: true,
    }]);
    assert.deepEqual(consumptionOrder, ["consumed", "response_exposed"]);
  });
});

test("agent credential proxy includes local seq-less stable-id messages under numeric since", async () => {
  let upstreamEventsCount = 0;
  const consumed: Array<{ source: string; ids: string[] }> = [];
  await withUpstream((req, res) => {
    if (req.url?.startsWith("/internal/agent-api/events")) upstreamEventsCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-local-third-party-events",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => [
          {
            message_id: "ordinary-message-without-seq",
            channel_type: "thread",
            channel_name: "9e992cb1",
            parent_channel_type: "channel",
            parent_channel_name: "proj-qa",
            sender_type: "agent",
            sender_name: "Hipp",
            content: "ordinary mirror delivery without seq",
          },
          {
            id: "39a60277-a586-49bc-9842-86fbc5d940cb",
            message_id: "39a60277-a586-49bc-9842-86fbc5d940cb",
            channel_type: "dm",
            channel_name: "third-party-agent-events:agent-1",
            sender_type: "third_party_app",
            sender_name: "task44-demo-third-party",
            content: "Third-party event: Task44 demo event",
            third_party_event: {
              id: "39a60277-a586-49bc-9842-86fbc5d940cb",
              kind: "event",
            },
          },
        ],
        consumeVisibleMessages: (input) => {
          consumed.push({
            source: input.source,
            ids: input.messages.map((message) => String(message.message_id ?? message.id ?? "")),
          });
        },
      },
    });

    const events = await fetch(`${handle.proxyUrl}/internal/agent-api/events?since=0&limit=50`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(upstreamEventsCount, 0, "Local stable-id messages must be served before remote /events");
    assert.equal(events.status, 200);
    const body = await events.json() as {
      events?: Array<{ message_id?: string; third_party_event?: { id?: string } }>;
      last_seen_msgId?: string | null;
    };
    assert.equal(body.events?.length, 2);
    assert.equal(body.events?.[0]?.message_id, "ordinary-message-without-seq");
    assert.equal(body.events?.[1]?.message_id, "39a60277-a586-49bc-9842-86fbc5d940cb");
    assert.equal(body.events?.[1]?.third_party_event?.id, "39a60277-a586-49bc-9842-86fbc5d940cb");
    assert.equal(body.last_seen_msgId, "39a60277-a586-49bc-9842-86fbc5d940cb");
    assert.deepEqual(consumed, [{
      source: "agent_api_events_local",
      ids: ["ordinary-message-without-seq", "39a60277-a586-49bc-9842-86fbc5d940cb"],
    }]);
  });
});

test("agent credential proxy serves inbox snapshot without consuming local pending messages", async () => {
  let upstreamInboxCount = 0;
  const consumed: unknown[] = [];
  const inboxSnapshots: unknown[] = [];
  await withUpstream((req, res) => {
    if (req.url?.startsWith("/internal/agent-api/inbox")) upstreamInboxCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rows: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-local-inbox-check",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => [
          {
            seq: 101,
            id: "pending-101",
            channel_type: "thread",
            channel_name: "thread-9dc24288-d7d3-4599-8e6a-fdc5c2666ac6",
            parent_channel_type: "channel",
            parent_channel_name: "sec-field-05200630",
            sender_type: "human",
            sender_name: "tygg",
            content: "must not appear in inbox snapshot",
          },
          {
            seq: 102,
            id: "pending-102",
            channel_type: "thread",
            channel_name: "thread-9dc24288-d7d3-4599-8e6a-fdc5c2666ac6",
            parent_channel_type: "channel",
            parent_channel_name: "sec-field-05200630",
            sender_type: "agent",
            sender_name: "Jianwei",
            content: "also hidden",
          },
        ],
        recordInboxSnapshot: (input) => inboxSnapshots.push(input),
        consumeVisibleMessages: (input) => consumed.push(input),
      },
    });

    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(upstreamInboxCount, 0, "local inbox snapshot must not forward to server");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      pending_targets?: number;
      pending_messages?: number;
      rows?: Array<{
        target?: string;
        pendingCount?: number;
        firstPendingMsgId?: string;
        latestMsgId?: string;
        flags?: string[];
        content?: string;
      }>;
    };
    assert.equal(body.pending_targets, 1);
    assert.equal(body.pending_messages, 2);
    assert.equal(body.rows?.[0]?.target, "#sec-field-05200630:9dc24288");
    assert.equal(body.rows?.[0]?.pendingCount, 2);
    assert.equal(body.rows?.[0]?.firstPendingMsgId, "pending-101");
    assert.equal(body.rows?.[0]?.latestMsgId, "pending-102");
    assert.deepEqual(body.rows?.[0]?.flags, ["thread"]);
    assert.equal(JSON.stringify(body).includes("must not appear"), false);
    assert.deepEqual(consumed, [], "inbox check is pure read and must not consume pending messages");
    assert.deepEqual(inboxSnapshots, [{
      source: "agent_api_inbox_check",
      pendingMessageCount: 2,
      rows: body.rows,
    }]);
  });
});

test("agent credential proxy inbox check preserves same-target freshness hold", async () => {
  let upstreamSendCount = 0;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
  const decisions: unknown[] = [];
  const pendingMessages = Array.from({ length: 2 }, (_, idx) => {
    const seq = 60 + idx;
    return {
      seq,
      id: `pending-${seq}`,
      channel_type: "dm",
      channel_name: "tygg",
      sender_type: "human",
      sender_name: "tygg",
      content: `hidden pending dm ${seq}`,
      createdAt: "2026-05-20T07:31:31.000Z",
    };
  });
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") upstreamSendCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "unexpected-send" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-inbox-check-freshness",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: (target) => target === "dm:@tygg" ? pendingMessages : [],
        getAllPendingMessages: () => pendingMessages,
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
        recordFreshnessDecision: (input) => decisions.push(input),
      },
    });

    const inbox = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(inbox.status, 200);
    assert.deepEqual(consumed, [], "inbox check must not consume before the later send preflight");
    assert.equal(JSON.stringify(await inbox.json()).includes("hidden pending dm"), false);

    const send = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply after checking inbox" }),
    });

    assert.equal(upstreamSendCount, 0, "inbox check must not make same-target send bypass freshness hold");
    assert.equal(send.status, 200);
    const body = await send.json() as { state?: string; outcome?: string; reason?: string };
    assert.equal(body.state, "held");
    assert.equal(body.outcome, "held");
    assert.equal(body.reason, "newer_messages_available");
    assert.deepEqual(consumed, [{
      target: "dm:@tygg",
      source: "side_effect_preflight_context",
      boundarySeq: 61,
      seqs: [60, 61],
    }]);
    assert.equal((decisions[0] as { decision?: string; reason?: string })?.decision, "local_hold");
    assert.equal((decisions[0] as { decision?: string; reason?: string })?.reason, "exact_target_pending");
  });
});

test("agent credential proxy materializes cold-target preflight before sending", async () => {
  let upstreamSendCount = 0;
  let upstreamHistoryCount = 0;
  let observedBody: any = null;
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; messages: unknown[]; seqs: number[] }> = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        messages: [
          {
            seq: 241,
            id: "recent-241",
            senderType: "user",
            senderName: "tygg",
            content: "recent context",
            createdAt: "2026-05-19T00:00:00.000Z",
          },
        ],
      }));
      return;
    }
    if (req.url === "/internal/agent-api/send") {
      upstreamSendCount += 1;
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      observedBody = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        state: "held",
        seenUpToSeq: 241,
        heldMessages: [
          {
            seq: 241,
            id: "recent-241",
            channel_type: "dm",
            channel_name: "tygg",
            content: "recent context",
          },
        ],
        newMessageCount: 1,
        shownMessageCount: 1,
        omittedMessageCount: 0,
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          consumed.push({
            target: input.target,
            source: input.source,
            boundarySeq: input.boundarySeq,
            messages: input.messages,
            seqs: input.messages.map((message) => Number(message.seq ?? 0)),
          });
        },
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });

    assert.equal(upstreamSendCount, 0);
    assert.equal(upstreamHistoryCount, 1);
    assert.equal(observedBody, null);
    const body = await res.json() as {
      state?: string;
      seenUpToSeq?: number;
      newMessageCount?: number;
      heldMessages?: Array<Record<string, unknown>>;
    };
    assert.equal(body.state, "held");
    assert.equal(body.seenUpToSeq, 241);
    assert.equal(body.newMessageCount, 1);
    assert.equal(body.heldMessages?.[0]?.message_id, "recent-241");
    assert.equal(body.heldMessages?.[0]?.timestamp, "2026-05-19T00:00:00.000Z");
    assert.equal(body.heldMessages?.[0]?.sender_type, "user");
    assert.equal(body.heldMessages?.[0]?.sender_name, "tygg");
    assert.equal(body.heldMessages?.[0]?.channel_type, "dm");
    assert.equal(body.heldMessages?.[0]?.channel_name, "tygg");
    assert.equal(body.heldMessages?.[0]?.content, "recent context");
    assert.deepEqual(consumed, [{
      target: "dm:@tygg",
      source: "side_effect_preflight_context",
      boundarySeq: 241,
      messages: body.heldMessages,
      seqs: [241],
    }]);
  });
});

test("agent credential proxy does not consume ordinary sent responses", async () => {
  const consumed: unknown[] = [];
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "sent", messageId: "sent-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => 9,
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => { consumed.push(input); },
      },
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "reply" }),
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json() as { state?: string }).state, "sent");
    assert.deepEqual(consumed, []);
  });
});

function serverWithListenFailure(handler: http.RequestListener, message: string): http.Server {
  const server = http.createServer(handler);
  server.listen = ((..._args: unknown[]) => {
    queueMicrotask(() => {
      server.emit("error", Object.assign(new Error(message), { code: "EACCES" }));
    });
    return server;
  }) as typeof server.listen;
  return server;
}

test("agent credential proxy retries loopback bind failure before exposing proxy URL", async () => {
  await __resetAgentCredentialProxyForTest();
  let attempts = 0;
  try {
    __setAgentCredentialProxyServerFactoryForTest((handler) => {
      attempts += 1;
      return attempts === 1
        ? serverWithListenFailure(handler, "listen EACCES: permission denied 127.0.0.1")
        : http.createServer(handler);
    });

    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-retry",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
      });

      assert.equal(attempts, 2);
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(res.status, 200);
    });
  } finally {
    await __resetAgentCredentialProxyForTest();
  }
});

test("agent credential proxy fails registration when loopback bind never succeeds", async () => {
  await __resetAgentCredentialProxyForTest();
  let attempts = 0;
  try {
    __setAgentCredentialProxyServerFactoryForTest((handler) => {
      attempts += 1;
      return serverWithListenFailure(handler, "listen EACCES: permission denied 127.0.0.1");
    });

    await assert.rejects(
      registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-fail",
        serverUrl: "https://slock.example",
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
      }),
      /Agent Credential Proxy local proxy failed to bind 127\.0\.0\.1 after 3 attempts: listen EACCES/,
    );
    assert.equal(attempts, 3);
  } finally {
    await __resetAgentCredentialProxyForTest();
  }
});


test("agent credential proxy serves typed app inbox items without msg fields; check pure read; ack removes", async () => {
  await withUpstream((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "should not forward" }));
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      idFactory: () => "app-item-1",
      registry: {
        "test.fixture": {
          over_threshold: {
            retention: "transient",
            primaryAction: { kind: "run_command", commandId: "fixture.review" },
            normalizeSourceRef: (raw) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                return { ok: false, message: "structured sourceRef required" };
              }
              const o = raw as { kind?: unknown; id?: unknown };
              if (o.kind !== "fixture-measure" || typeof o.id !== "string" || !o.id) {
                return { ok: false, message: "invalid measure ref" };
              }
              return { ok: true, ref: { kind: "fixture-measure", id: o.id } };
            },
            materializeActionCli: () => "raft fixture review",
          },
        },
      },
    });
    const mint = appInbox.mint({
      appId: "test.fixture",
      notificationClass: "over_threshold",
      sourceRef: { kind: "fixture-measure", id: "owner" },
      summary: "MEMORY.md over threshold",
    });
    assert.equal(mint.ok, true);

    const handle = await registerAgentCredentialProxy({
      agentId: "agent-app-inbox",
      launchId: "launch-app-inbox",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      appInbox,
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });

    const check1 = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(check1.status, 200);
    const body1 = await check1.json() as {
      rows?: unknown[];
      items?: Array<Record<string, unknown>>;
      pending_app_items?: number;
      pending_messages?: number;
    };
    assert.equal(body1.pending_messages, 0);
    assert.equal(body1.pending_app_items, 1);
    assert.equal(body1.rows?.length, 0);
    const app = body1.items?.find((i) => i.source === "app");
    assert.ok(app);
    assert.equal(app.itemId, "app-item-1");
    assert.equal(app.appId, "test.fixture");
    assert.deepEqual(app.primaryAction, { kind: "run_command", commandId: "fixture.review" });
    assert.equal(app.actionCli, "raft fixture review");
    assert.equal(app.retention, "transient");
    assert.equal("latestMsgId" in app, false);
    assert.equal("firstPendingMsgId" in app, false);
    assert.equal("latestSeq" in app, false);

    // pure read: second check still has the item
    const check2 = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    const body2 = await check2.json() as { pending_app_items?: number };
    assert.equal(body2.pending_app_items, 1);

    const ack = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ itemId: "app-item-1" }),
    });
    assert.equal(ack.status, 200);
    const check3 = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    const body3 = await check3.json() as { pending_app_items?: number; items?: unknown[] };
    assert.equal(body3.pending_app_items, 0);
    assert.equal((body3.items ?? []).filter((i: any) => i.source === "app").length, 0);

    unregisterAgentCredentialProxyForLaunch({ agentId: "agent-app-inbox", launchId: "launch-app-inbox" });
  });
});

test("agent credential proxy app-source ACK injects daemon attempt id and retires exact item after Server accepts", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  let upstreamBody: Record<string, unknown> | null = null;
  let beforeServerAckCalls = 0;
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      upstreamBody = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(upstreamBody.itemId, `reminder:${reminderId}:9`);
      assert.equal(upstreamBody.appId, "system.reminder");
      assert.equal(upstreamBody.notificationClass, "due");
      assert.deepEqual(upstreamBody.sourceRef, { kind: "reminder", id: reminderId, revision: "9" });
      assert.equal(typeof upstreamBody.ackAttemptId, "string");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        itemId: `reminder:${reminderId}:9`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
        sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
        ackAttemptId: upstreamBody.ackAttemptId,
        replayed: false,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => false,
      beforeServerAuthorizedAck: () => {
        beforeServerAckCalls += 1;
        return true;
      },
    });
    const mint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
    });
    assert.equal(mint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-ack",
      launchId: "launch-reminder-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      const response = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.remaining_app_items, 0);
      assert.equal(body.ackAttemptId, upstreamBody?.ackAttemptId);
      assert.equal(beforeServerAckCalls, 1);
      assert.equal(appInbox.list().length, 0);
      assert.equal(appInbox.listAcknowledgedSources().length, 1);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reminder-ack", launchId: "launch-reminder-ack" });
    }
  });
});

test("agent credential proxy app-source ACK preserves exact attempt after mismatched Server 2xx", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const attempts: string[] = [];
  let beforeServerAckCalls = 0;
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { ackAttemptId?: string };
      assert.ok(body.ackAttemptId);
      attempts.push(body.ackAttemptId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        itemId: `reminder:${reminderId}:9`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
        sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
        ackAttemptId: attempts.length === 1
          ? "cccccccc-0000-4000-8000-000000000003"
          : body.ackAttemptId,
        replayed: attempts.length > 1,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => false,
      beforeServerAuthorizedAck: () => {
        beforeServerAckCalls += 1;
        return true;
      },
    });
    const mint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
    });
    assert.equal(mint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-mismatched-ack",
      launchId: "launch-reminder-mismatched-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      const first = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(first.status, 502);
      const firstBody = await first.json() as Record<string, unknown>;
      assert.equal(firstBody.code, "invalid_app_source_ack_response");
      assert.equal(appInbox.list().length, 1);
      assert.equal(appInbox.listAcknowledgedSources().length, 0);
      assert.equal(beforeServerAckCalls, 0);

      const second = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(second.status, 200);
      assert.equal(appInbox.list().length, 0);
      assert.equal(appInbox.listAcknowledgedSources().length, 1);
      assert.equal(beforeServerAckCalls, 1);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({
        agentId: "agent-reminder-mismatched-ack",
        launchId: "launch-reminder-mismatched-ack",
      });
    }
  });
});

test("agent credential proxy app-source ACK preserves exact attempt after malformed Server 2xx", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const attempts: string[] = [];
  let beforeServerAckCalls = 0;
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { ackAttemptId?: string };
      assert.ok(body.ackAttemptId);
      attempts.push(body.ackAttemptId);
      res.writeHead(200, { "content-type": "application/json" });
      if (attempts.length === 1) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.end(JSON.stringify({
        ok: true,
        itemId: `reminder:${reminderId}:9`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
        sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
        ackAttemptId: body.ackAttemptId,
        replayed: true,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => false,
      beforeServerAuthorizedAck: () => {
        beforeServerAckCalls += 1;
        return true;
      },
    });
    const mint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
    });
    assert.equal(mint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-malformed-ack",
      launchId: "launch-reminder-malformed-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      const first = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(first.status, 502);
      const firstBody = await first.json() as Record<string, unknown>;
      assert.equal(firstBody.code, "invalid_app_source_ack_response");
      assert.equal(appInbox.list().length, 1);
      assert.equal(appInbox.listAcknowledgedSources().length, 0);
      assert.equal(beforeServerAckCalls, 0);

      const second = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(second.status, 200);
      assert.equal(appInbox.list().length, 0);
      assert.equal(appInbox.listAcknowledgedSources().length, 1);
      assert.equal(beforeServerAckCalls, 1);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({
        agentId: "agent-reminder-malformed-ack",
        launchId: "launch-reminder-malformed-ack",
      });
    }
  });
});

for (const mismatch of ["itemId", "appId", "notificationClass", "sourceRef"] as const) {
  test(`agent credential proxy app-source ACK fail-closes mismatched Server 2xx ${mismatch}`, async () => {
    const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
    let beforeServerAckCalls = 0;
    await withUpstream((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/internal/agent-api/app-sources/ack");
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw) as { ackAttemptId?: string };
        assert.ok(body.ackAttemptId);
        const accepted = {
          ok: true,
          itemId: `reminder:${reminderId}:9`,
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
          sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
          ackAttemptId: body.ackAttemptId,
          replayed: false,
        };
        if (mismatch === "itemId") accepted.itemId = `reminder:${reminderId}:10`;
        if (mismatch === "appId") accepted.appId = "system.other";
        if (mismatch === "notificationClass") accepted.notificationClass = "other";
        if (mismatch === "sourceRef") accepted.sourceRef = { kind: "reminder", id: reminderId, revision: "10" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(accepted));
      });
    }, async (serverUrl) => {
      const appInbox = createAgentAppInboxStore({
        registry: REMINDER_AGENT_INBOX_REGISTRY,
        beforeAck: () => false,
        beforeServerAuthorizedAck: () => {
          beforeServerAckCalls += 1;
          return true;
        },
      });
      const mint = appInbox.mint({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
      });
      assert.equal(mint.ok, true);
      const handle = await registerAgentCredentialProxy({
        agentId: `agent-reminder-mismatch-${mismatch}`,
        launchId: `launch-reminder-mismatch-${mismatch}`,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "tasks",
        appInbox,
      });
      try {
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
        });
        assert.equal(response.status, 502);
        const responseBody = await response.json() as Record<string, unknown>;
        assert.equal(responseBody.code, "invalid_app_source_ack_response");
        assert.equal(appInbox.list().length, 1);
        assert.equal(appInbox.listAcknowledgedSources().length, 0);
        assert.equal(beforeServerAckCalls, 0);
      } finally {
        unregisterAgentCredentialProxyForLaunch({
          agentId: `agent-reminder-mismatch-${mismatch}`,
          launchId: `launch-reminder-mismatch-${mismatch}`,
        });
      }
    });
  });
}

test("agent credential proxy app-source ACK preserves exact attempt after non-terminal upstream failure", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const attempts: string[] = [];
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { ackAttemptId?: string };
      assert.ok(body.ackAttemptId);
      attempts.push(body.ackAttemptId);
      if (attempts.length === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporary upstream failure", code: "server_unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        itemId: `reminder:${reminderId}:9`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
        sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
        ackAttemptId: body.ackAttemptId,
        replayed: true,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => false,
      beforeServerAuthorizedAck: () => true,
    });
    const mint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
    });
    assert.equal(mint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-transient-ack",
      launchId: "launch-reminder-transient-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      const first = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(first.status, 503);
      assert.equal(appInbox.list().length, 1);
      assert.equal(appInbox.listAcknowledgedSources().length, 0);

      const second = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(second.status, 200);
      assert.equal(appInbox.list().length, 0);
      assert.equal(appInbox.listAcknowledgedSources().length, 1);
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({
        agentId: "agent-reminder-transient-ack",
        launchId: "launch-reminder-transient-ack",
      });
    }
  });
});

for (const variant of ["malformed-409", "unknown-code-409"] as const) {
  test(`agent credential proxy app-source ACK preserves exact attempt after ${variant}`, async () => {
    const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
    const attempts: string[] = [];
    await withUpstream((req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/internal/agent-api/app-sources/ack");
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw) as { ackAttemptId?: string };
        assert.ok(body.ackAttemptId);
        attempts.push(body.ackAttemptId);
        if (attempts.length === 1) {
          if (variant === "malformed-409") {
            res.writeHead(409, { "content-type": "text/plain" });
            res.end("upstream edge rewrote the body");
            return;
          }
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not a registered terminal reject", code: "unknown_app_source_ack_code" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          itemId: `reminder:${reminderId}:9`,
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
          sourceEventId: "bbbbbbbb-0000-4000-8000-000000000002",
          ackAttemptId: body.ackAttemptId,
          replayed: true,
        }));
      });
    }, async (serverUrl) => {
      const appInbox = createAgentAppInboxStore({
        registry: REMINDER_AGENT_INBOX_REGISTRY,
        beforeAck: () => false,
        beforeServerAuthorizedAck: () => true,
      });
      const mint = appInbox.mint({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
      });
      assert.equal(mint.ok, true);
      const handle = await registerAgentCredentialProxy({
        agentId: `agent-reminder-${variant}`,
        launchId: `launch-reminder-${variant}`,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "tasks",
        appInbox,
      });
      try {
        const first = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
        });
        assert.equal(first.status, 409);
        assert.equal(appInbox.list().length, 1);
        assert.equal(appInbox.listAcknowledgedSources().length, 0);

        const second = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
        });
        assert.equal(second.status, 200);
        assert.equal(appInbox.list().length, 0);
        assert.equal(appInbox.listAcknowledgedSources().length, 1);
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0], attempts[1]);
      } finally {
        unregisterAgentCredentialProxyForLaunch({
          agentId: `agent-reminder-${variant}`,
          launchId: `launch-reminder-${variant}`,
        });
      }
    });
  });
}

test("agent credential proxy app-source ACK clears intent and preserves item after Server stale rejection", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const attempts: string[] = [];
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { ackAttemptId?: string; itemId?: string };
      assert.ok(body.ackAttemptId);
      assert.equal(body.itemId, `reminder:${reminderId}:9`);
      attempts.push(body.ackAttemptId);
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "Source revision is stale; refresh Inbox and retry",
        code: "stale_source_revision",
        latestFiredSourceVersion: 10,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => false,
      beforeServerAuthorizedAck: () => {
        throw new Error("should not locally retire after stale Server rejection");
      },
    });
    const mint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "9" },
    });
    assert.equal(mint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-stale",
      launchId: "launch-reminder-stale",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${handle.proxyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
        });
        assert.equal(response.status, 409);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.code, "stale_source_revision");
        assert.equal(appInbox.list().length, 1);
        assert.equal(appInbox.listAcknowledgedSources().length, 0);
      }
      assert.equal(attempts.length, 2);
      assert.notEqual(attempts[0], attempts[1]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reminder-stale", launchId: "launch-reminder-stale" });
    }
  });
});
