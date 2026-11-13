import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import {
  type AgentMessage,
  BasicTracer,
  formatTraceparent,
  MemoryTraceSink,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
} from "@botiverse/raft-shared";
import { ApiClient } from "../../cli/src/client";
import type { AgentContext } from "../../cli/src/auth/env";
import { normalizeVersion, readCliVersion } from "../../cli/src/version";

import { setDaemonFetchImplForTests } from "./daemonFetch";
import {
  __agentApiBooksHistoryWindowForTest,
  __agentApiSideEffectActionForTest,
  __agentCredentialProxyFetchOptionsForTest,
  __transportNormalizedErrorForErrorForTest,
  __resetAgentCredentialProxyForTest,
  __setAgentCredentialProxyServerFactoryForTest,
  __setThirdPartyEventDeliveryReportRetryBaseMsForTest,
  __setThirdPartyEventLeaseMsForTest,
  bodySizeBucket,
  INBOX_READ_PATH,
  registerAgentCredentialProxy,
  reportThirdPartyEventsDelivered,
  setAgentProxyServerChecksTaskWriteLanding,
  unregisterAgentCredentialProxyForLaunch,
  type AgentProxyVisibleMessage,
} from "./agentCredentialProxy";
import { AgentVisibleDeliveryLedger, type AgentVisibleFreshnessView } from "./agentVisibleDeliveryLedger";
import { formatInboxUpdateRuntimeInput, threadJoinContextReceipts } from "./agentRuntimeInput";
import { formatInboxCheck } from "../../cli/src/commands/inbox/_format";
import { AGENT_API_ROUTE_MANIFEST } from "../../shared/src/generated/agentApiRoutes";
import { agentApiContract, agentApiHistoryResponseSchema } from "../../shared/src/agentApiContract";
import { createAgentAppInboxStore } from "./agentAppInbox";
import { REMINDER_SERVER_ACK_CAPABILITY } from "./reminderServerAck";
import { createCommandContext } from "../../cli/src/core/context";
import { CliError } from "../../cli/src/core/errors";
import { formatErrorEnvelope } from "../../cli/src/core/renderer";
import { reminderAckCommand } from "../../cli/src/apps/reminder/ack";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { createScopedAppStorageFactory } from "./scopedAppStorage";
import { buildApmFreshnessDecisionProducerFactId } from "./apmStateMachine";

// The connected Server checks task writes by landing unless a test says it is older.
beforeEach(() => {
  setAgentProxyServerChecksTaskWriteLanding(true);
});

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

for (const phase of ["waiting for the response", "reading a streamed response"] as const) {
  test(`agent credential proxy cancels the upstream request once the CLI stops ${phase}`, async () => {
    const streamed = phase === "reading a streamed response";
    const sink = new MemoryTraceSink();
    const failuresRecorded: string[] = [];
    let upstreamSeen!: () => void;
    const upstreamReached = new Promise<void>((resolve) => { upstreamSeen = resolve; });
    let upstreamClosed!: () => void;
    const upstreamGone = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    await withUpstream((req, res) => {
      // Never finishes: the CLI gives up first.
      req.socket.once("close", () => upstreamClosed());
      if (streamed) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      }
      upstreamSeen();
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-gives-up",
        launchId: "launch-gives-up",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
        tracer: deterministicProxyTracer(sink),
        inboxCoordinator: {
          getBoundary: () => undefined,
          getPendingMessages: () => [],
          consumeVisibleMessages: () => {},
          recordProxyFailure: () => { failuresRecorded.push("proxy_failure"); },
          recordTransportNormalizedError: () => { failuresRecorded.push("transport_error"); },
        },
      });
      try {
        const cli = new AbortController();
        const response = fetch(`${handle.proxyUrl}/internal/agent-api/integrations`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
          signal: cli.signal,
        });
        await upstreamReached;
        if (streamed) {
          const reader = (await response).body!.getReader();
          await reader.read();
        }
        cli.abort();
        if (!streamed) await assert.rejects(response);
        await withinMs(upstreamGone, 5_000, "the upstream request was not cancelled");
        await waitForSpan(sink, "daemon.agent_proxy.request");
      } finally {
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-gives-up", launchId: "launch-gives-up" });
      }
    });
    const [span] = sink.getAllSpans().filter((entry) => entry.name === "daemon.agent_proxy.request");
    assert.equal(span?.attrs?.agentId, "agent-gives-up");
    assert.equal(span?.attrs?.route_family, "integrations");
    assert.equal(span?.attrs?.outcome, "client_closed");
    assert.equal(span?.attrs?.response_started, streamed);
    assert.equal(span?.status, streamed ? "ok" : "error");
    assert.deepEqual(failuresRecorded, [], "a CLI that left is not a transport failure");
  });
}

test("agent credential proxy tags uploads with a coarse body size bucket only", async () => {
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-upload-size",
      launchId: "launch-upload-size",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "write",
      tracer: deterministicProxyTracer(sink),
    });
    try {
      const upload = await fetch(`${handle.proxyUrl}/internal/agent-api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/octet-stream" },
        body: new Uint8Array(2 * 1024 * 1024),
      });
      assert.equal(upload.status, 200);
      const other = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(other.status, 200);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-upload-size", launchId: "launch-upload-size" });
    }
  });
  const spans = sink.getAllSpans().filter((span) => span.name === "daemon.agent_proxy.request");
  const uploadSpan = spans.find((span) => span.attrs?.route_family === "attachments/upload");
  const otherSpan = spans.find((span) => span.attrs?.route_family === "server");
  assert.equal(uploadSpan?.attrs?.body_size_bucket, "1-10MiB");
  assert.equal(otherSpan?.attrs?.body_size_bucket, undefined);
});

test("upload body size buckets split at 1, 10 and 50 MiB", () => {
  const mib = 1024 * 1024;
  assert.equal(bodySizeBucket(0), "<1MiB");
  assert.equal(bodySizeBucket(mib - 1), "<1MiB");
  assert.equal(bodySizeBucket(mib), "1-10MiB");
  assert.equal(bodySizeBucket(10 * mib - 1), "1-10MiB");
  assert.equal(bodySizeBucket(10 * mib), "10-50MiB");
  assert.equal(bodySizeBucket(24 * mib), "10-50MiB");
  assert.equal(bodySizeBucket(50 * mib), "10-50MiB");
  assert.equal(bodySizeBucket(50 * mib + 1), ">50MiB");
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
    res.end(JSON.stringify({ ok: true, state: "sent", messageId: "sent-1" }));
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

    // A send preflights a target the model has not read (task writes leave
    // that to the Server), so it makes the history read the carrier spans.
    const response = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "#proj-o11y", content: "traced" }),
    });

    assert.equal(response.status, 200);
    assert.equal(observed.length, 2);
    assert.match(observed[0]!.path, /^\/internal\/agent-api\/history\?/);
    assert.equal(observed[1]!.path, "/internal/agent-api/send");
    assert.equal(observed[0]!.traceparent, observed[1]!.traceparent);
    assert.equal(observed[0]!.traceparent, `00-${TEST_TRACE_ID}-${TEST_PROXY_SPAN_ID}-00`);
    const [span] = sink.getAllSpans();
    assert.equal(span.context.parentSpanId, null);
    assert.equal(span.attrs?.trace_context_state, "new_root");
    assert.equal(span.attrs?.proxy_launch_id_present, false);
    assert.equal(span.attrs?.route_family, "agent-api/send");
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
    // The daemon adds its own token to the CLI's, whatever the inbox items flag (here off).
    assert.equal(observedClientCaps, `manual-context-v1,${REMINDER_SERVER_ACK_CAPABILITY}`);

    const withoutCallerCaps = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(withoutCallerCaps.status, 200);
    assert.equal(observedClientCaps, REMINDER_SERVER_ACK_CAPABILITY);

    const alreadyDeclared = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "X-Raft-Client-Capabilities": `${REMINDER_SERVER_ACK_CAPABILITY}, inbox-items@1`,
      },
    });
    assert.equal(alreadyDeclared.status, 200);
    assert.equal(observedClientCaps, `${REMINDER_SERVER_ACK_CAPABILITY},inbox-items@1`);

    assert.equal(unregisterAgentCredentialProxyForLaunch({
      agentId: "agent-1",
      launchId: "launch-1",
    }), 1);

    const afterUnregister = await fetch(`${handle.proxyUrl}/internal/agent-api/server`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    // The token is dead; the proxy says the agent has no running session (#proj-raft-computer:#58).
    assert.equal(afterUnregister.status, 410);
    assert.equal((await afterUnregister.json() as { code?: string }).code, "agent_not_running");
  });
});

test("agent credential proxy names the agent's Computer, daemon and runtime, and passes the CLI's own version through", async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  await withUpstream((req, res) => {
    const header = (name: string) => req.headers[name] as string | undefined;
    seen.push({
      client: header("x-raft-client"),
      clientVersion: header("x-raft-client-version"),
      computerVersion: header("x-raft-computer-version"),
      daemonVersion: header("x-raft-daemon-version"),
      runtime: header("x-raft-runtime"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-origin",
      launchId: "launch-origin",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      daemonVersion: "1.0.53",
      computerVersion: "1.0.54",
      runtime: "codex",
    });
    const unversioned = await registerAgentCredentialProxy({
      agentId: "agent-origin",
      launchId: "launch-origin-unversioned",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
    });
    try {
      const cli = new ApiClient({
        agentId: "agent-origin",
        serverId: "server-1",
        serverUrl: handle.proxyUrl,
        token: handle.proxyToken,
        clientMode: "managed-runner",
        secretSource: "agent-proxy-token-env",
        activeCapabilities: null,
      });
      assert.equal((await cli.request("GET", "/internal/agent-api/server")).ok, true);
      // The daemon is the authority on what the agent runs on: a caller's
      // own values are replaced, or removed when the daemon knows none.
      const forged = { "X-Raft-Computer-Version": "9.9.9", "X-Raft-Daemon-Version": "9.9.9", "X-Raft-Runtime": "forged" };
      for (const proxy of [handle, unversioned]) {
        const response = await fetch(`${proxy.proxyUrl}/internal/agent-api/server`, {
          headers: { Authorization: `Bearer ${proxy.proxyToken}`, ...forged },
        });
        assert.equal(response.status, 200);
      }
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-origin", launchId: "launch-origin" });
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-origin", launchId: "launch-origin-unversioned" });
    }
  });
  const cliVersion = normalizeVersion(readCliVersion());
  assert.ok(cliVersion, "the source-run CLI reads its package version");
  assert.deepEqual(seen, [
    { client: "cli", clientVersion: cliVersion, computerVersion: "1.0.54", daemonVersion: "1.0.53", runtime: "codex" },
    { client: "cli", clientVersion: undefined, computerVersion: "1.0.54", daemonVersion: "1.0.53", runtime: "codex" },
    { client: "cli", clientVersion: undefined, computerVersion: undefined, daemonVersion: undefined, runtime: undefined },
  ]);
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
      viaHttpProxy: false,
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

test("proxy diagnostics class fixture post_response_local", async () => {
  if (shouldSkipProxyDiagnosticFixture("post_response_local")) return;
  // Task #369: the upstream answers in full, then the local visible-delivery
  // ledger throws (gzj, daemon 1.0.37: "AgentVisibleDeliveryLedger target
  // mismatch"). That is a local daemon fault, not upstream transport.
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: [{ id: "m1", seq: 7, content: "hi" }] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-post-response",
      launchId: "launch-post-response",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {
          throw new Error("AgentVisibleDeliveryLedger target mismatch");
        },
      },
    });
    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23proj-runtime`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(res.status, 502);
    const body = await res.json() as { proxy?: Record<string, unknown> };
    recordProxyDiagnosticFixtureWitness("post_response_local");
    assert.match(String(body.proxy?.correlation_id ?? ""), /^[0-9a-f]{16}$/);
    assert.equal(body.proxy?.failure_class, "post_response_local");
    assert.equal(body.proxy?.response_started, true);
    assert.equal(body.proxy?.response_complete, true);
    assert.equal(body.proxy?.cause_code, "LOCAL_POST_RESPONSE_FAILURE");
    assert.equal(body.proxy?.upstream, "local_daemon");
    assert.equal(body.proxy?.layer, "local_daemon");
    assert.equal(body.proxy?.target_host_class, "local_daemon");
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
      viaHttpProxy: false,
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
    viaHttpProxy: false,
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

test("agent credential proxy relays a 5xx the Server answered on purpose, and still records it", async () => {
  const transportEvents: Array<{ causeCode?: string }> = [];
  const answer = { error: "artifact storage (r2) is not configured", code: "ARTIFACTS_STORAGE_UNAVAILABLE" };
  await withUpstream((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-deliberate-5xx",
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

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/artifacts/uploads/${"a".repeat(64)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/octet-stream" },
      body: "x",
    });

    assert.equal(res.status, 503);
    assert.match(res.headers.get("x-raft-correlation-id") ?? "", /^[0-9a-f]{16}$/);
    assert.deepEqual(await res.json(), answer);
    assert.deepEqual(transportEvents.map((event) => event.causeCode), ["HTTP_503"]);
  });
});

test("agent credential proxy keeps its envelope for the Server's unexpected-error answer", async () => {
  await withUpstream((_req, res) => {
    res.writeHead(500, { "content-type": "application/json", "x-slock-error-id": "trace-1" });
    res.end(JSON.stringify({ error: "Internal server error", code: "internal_server_error", correlationId: "trace-1" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-unexpected-5xx",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
    });

    const res = await fetch(`${handle.proxyUrl}/internal/agent-api/messages/deadbeef/resolve`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });

    assert.equal(res.status, 500);
    const body = await res.json() as { code?: string; proxy?: { failure_class?: string } };
    assert.equal(body.code, "agent_proxy_failed");
    assert.equal(body.proxy?.failure_class, "upstream_http_response");
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
    viaHttpProxy: false,
    downstreamCaller: "cli",
    upstream: "server",
  });
});

test("agent credential proxy classifies a throw after a complete upstream response as a local fault (task #369)", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.raft.build/internal/agent-api/events"),
    new Error("AgentVisibleDeliveryLedger target mismatch"),
    "launch-post-response",
    { responseStarted: true, responseComplete: true },
  );

  assert.deepEqual(event, {
    normalizedCode: "local_post_response_failure",
    routeFamily: "agent-api/events",
    failureClass: "post_response_local",
    responseStarted: true,
    responseComplete: true,
    causeCode: "LOCAL_POST_RESPONSE_FAILURE",
    upstreamLayer: "unknown",
    originalMessage: "AgentVisibleDeliveryLedger target mismatch",
    launchId: "launch-post-response",
    targetHostClass: "local_daemon",
    downstreamCaller: "cli",
    upstream: "local_daemon",
  });
});

test("agent credential proxy keeps a truncated body as mid_response_transport (task #369 boundary)", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.raft.build/internal/agent-api/events"),
    Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    "launch-mid-response",
    { responseStarted: true, responseComplete: false },
  );

  assert.equal(event.failureClass, "mid_response_transport");
  assert.equal(event.normalizedCode, "transport_failure");
  assert.equal(event.upstream, "server");
});

test("agent credential proxy keeps lifecycle-invalid ahead of post-response classification (task #369)", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.raft.build/internal/agent-api/history"),
    new Error([
      "Agent no-process residency invariant violation after visible-consume:",
      "fingerprint fence without running process, idle retry config, or terminal failure",
      "for d2bf1e2c-3648-4590-a0e2-46c6998b2c38",
    ].join(" ")),
    "launch-local-invariant",
    { responseStarted: true, responseComplete: true },
  );

  assert.equal(event.failureClass, "post_response_local");
  assert.equal(event.normalizedCode, "local_daemon_state_invalid");
  assert.equal(event.causeCode, "LOCAL_DAEMON_STATE_INVALID");
  assert.equal(event.upstream, "local_daemon");
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

test("agent credential proxy classifies v2 message send failures as send", () => {
  const event = __transportNormalizedErrorForErrorForTest(
    new URL("https://api.raft.build/internal/agent-api/v2/send"),
    new Error("proxy CONNECT failed before upstream response"),
    "launch-v2-send",
  );

  assert.equal(event.routeFamily, "agent-api/send");
  assert.equal(event.failureClass, "pre_response_transport");
  assert.equal(event.responseStarted, false);
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

// A new Computer on an older Server (no SERVER_CAPABILITY_TASK_WRITE_LANDING_V1):
// that Server would compare a task-conversation boundary with the board and hold
// nearly every write, so a task write attests nothing and is not checked there.
test("agent credential proxy attests no task write to a Server that does not check by landing", async () => {
  setAgentProxyServerChecksTaskWriteLanding(false);
  const forwarded: Array<Record<string, unknown>> = [];
  await withUpstream(async (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      forwarded.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-old-server",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read,tasks",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });
    // A client that attests by landing itself (the SDK does) sends these too.
    const attested = { seenFor: "task_conversation", seenUpToSeq: 12, seenExactSeqs: [14] };
    for (const [path, body] of [
      ["/internal/agent-api/tasks/claim", { channel: "#proj-runtime", task_numbers: [201] }],
      ["/internal/agent-api/tasks/update-status", { channel: "#proj-runtime", task_number: 201, status: "in_review", ...attested }],
      ["/internal/agent-api/tasks", { channel: "#proj-runtime", tasks: [{ title: "t", source_message_id: "abcdef12" }], ...attested }],
      ["/internal/agent-api/tasks", { channel: "#proj-runtime", tasks: [{ title: "no source" }], ...attested }],
    ] as const) {
      const res = await fetch(`${handle.proxyUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, path);
    }
  });
  for (const body of forwarded) {
    for (const field of ["seenUpToSeq", "seenExactSeqs", "seenFor"]) {
      assert.equal(Object.hasOwn(body, field), false, `${field} reached an older Server: ${JSON.stringify(body)}`);
    }
  }
  assert.equal(forwarded.length, 4);
});

// A task write is never held here, even with messages delivered to the
// daemon that the model has not taken in yet: it carries the model-seen
// boundary of its landing and the Server decides (agentWriteLanding.ts).
test("agent credential proxy never holds a task write locally, even with pending messages in its conversation", async () => {
  const forwarded: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const consumed: unknown[] = [];
  await withUpstream(async (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      forwarded.push({ url: req.url, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-pending",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read,tasks",
      inboxCoordinator: {
        getBoundary: () => 7,
        getPendingMessages: (target) => target === "#proj-runtime:#201"
          ? [{ seq: 8, id: "pending-8", channel_type: "channel", channel_name: "proj-runtime", content: "new task context" }]
          : [],
        consumeVisibleMessages: (input) => consumed.push(input),
      },
    });
    for (const [path, body] of [
      ["/internal/agent-api/tasks/claim", { channel: "#proj-runtime", task_numbers: [201] }],
      ["/internal/agent-api/tasks/update-status", { channel: "#proj-runtime", task_number: 201, status: "in_review" }],
    ] as const) {
      const res = await fetch(`${handle.proxyUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.notEqual((await res.json() as { state?: string }).state, "held", path);
    }
  });
  assert.deepEqual(forwarded.map((entry) => [entry.url, entry.body.seenUpToSeq, entry.body.seenFor]), [
    ["/internal/agent-api/tasks/claim", 7, "task_conversation"],
    ["/internal/agent-api/tasks/update-status", 7, "task_conversation"],
  ]);
  assert.deepEqual(consumed, [], "the pending message stays pending: the model has not seen it");
});

// A task write never preflights a conversation the model has not read: the
// Computer cannot tell the agent's own lifecycle lines from others' (history
// rows carry no causal actor), so it attests 0 for the landing and the Server
// decides with its self-caused exemptions.
test("agent credential proxy leaves a task write's first touch of its conversation to the Server", async () => {
  let upstreamHistoryCount = 0;
  const forwarded: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const consumed: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      upstreamHistoryCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [{ seq: 99, id: "own-took-99", senderType: "system", content: "📌 agent-1 took #201" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      forwarded.push({ url: req.url, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
    });
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
        consumeVisibleMessages: (input) => consumed.push(input),
      },
    });

    for (const [path, body] of [
      ["/internal/agent-api/tasks/claim", { channel: "#proj-runtime", task_numbers: [201] }],
      ["/internal/agent-api/tasks/update-status", { channel: "#proj-runtime", task_number: 201, status: "in_review" }],
    ] as const) {
      const res = await fetch(`${handle.proxyUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      assert.notEqual((await res.json() as { state?: string }).state, "held", `${path} is not held locally`);
    }

    assert.equal(upstreamHistoryCount, 0, "no first-touch history read for a task write");
    assert.deepEqual(forwarded.map((entry) => [entry.url, entry.body.seenUpToSeq, entry.body.seenFor]), [
      ["/internal/agent-api/tasks/claim", 0, "task_conversation"],
      ["/internal/agent-api/tasks/update-status", 0, "task_conversation"],
    ]);
    assert.deepEqual(consumed, []);
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
  const sendOutcomes: unknown[] = [];
  await withUpstream(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      upstreamSendCount += 1;
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as { target?: string; content?: string; seenUpToSeq?: number };
      if (upstreamSendCount === 3) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "held", freshnessContextMode: "withheld", withheldMessageCount: 1 }));
        return;
      }
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
        // Task #17: the turn summary counts sent replies and held sends.
        recordSendOutcome: (outcome) => sendOutcomes.push(outcome),
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

    const held = await fetch(`${handle.proxyUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.proxyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "dm:@tygg", content: "third" }),
    });
    assert.equal((await held.json() as { state?: string }).state, "held");

    assert.equal(upstreamSendCount, 3);
    assert.deepEqual(consumed, [
      { target: "dm:@tygg", source: "agent_api_send_commit", boundarySeq: undefined, seqs: [0], ids: ["self-41"] },
      { target: "dm:@tygg", source: "agent_api_send_commit", boundarySeq: undefined, seqs: [0], ids: ["self-42"] },
    ]);
    assert.deepEqual(sendOutcomes, [
      { state: "sent", messageId: "self-41" },
      { state: "sent", messageId: "self-42" },
      { state: "held" },
    ]);
  });
});

test("agent credential proxy reports each message the Server accepted on a send or task reply (View Context index)", async () => {
  const committed: unknown[] = [];
  const answers = [
    { path: "/internal/agent-api/send", status: 200, body: { ok: true, state: "sent", messageId: "m-sent" } },
    { path: "/internal/agent-api/v2/send", status: 200, body: { ok: true, state: "committed", messageId: "m-reconciled" } },
    { path: "/internal/agent-api/send", status: 200, body: { ok: true, state: "held", heldMessages: [] } },
    { path: "/internal/agent-api/tasks/reply", status: 200, body: { ok: true, state: "sent", messageId: "m-reply" } },
    { path: "/internal/agent-api/tasks/reply", status: 409, body: { state: "sent", messageId: "m-refused" } },
  ];
  let next = 0;
  await withUpstream(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [] }));
      return;
    }
    const answer = answers[next++]!;
    assert.equal(req.url, answer.path);
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-context-view-commit",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
        recordMessageCommitted: (input) => {
          committed.push(input);
          // A failing recorder never changes the agent's answer.
          if (input.messageId === "m-reply") throw new Error("index write failed");
        },
      },
    });
    for (const answer of answers) {
      const res = await fetch(`${handle.proxyUrl}${answer.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ target: "#general", content: "hi", channel: "#general", task_number: 1 }),
      });
      assert.equal(res.status, answer.status);
      assert.deepEqual(await res.json(), answer.body);
    }
  });
  assert.deepEqual(committed, [
    { messageId: "m-sent", route: "send" },
    { messageId: "m-reconciled", route: "send" },
    { messageId: "m-reply", route: "task_reply" },
  ]);
});

test("agent credential proxy reports a committed send of a launch with no inbox coordinator (the OAR host)", async () => {
  const committed: unknown[] = [];
  const sendOutcomes: unknown[] = [];
  await withUpstream(async (req, res) => {
    for await (const _chunk of req) { /* drained */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/internal/agent-api/tasks/reply"
      ? { state: "sent", messageId: "m-reply" }
      : req.url === "/internal/agent-api/v2/send"
        ? { state: "sent", messageId: "m-sent" }
        : req.url === "/internal/agent-api/send"
          ? { state: "held", messageId: "m-held" }
          : { state: "sent", messageId: "m-not-a-send" }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-oar-commit",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      recordMessageCommitted: (input) => committed.push(input),
      recordSendOutcome: (input) => sendOutcomes.push(input),
    });
    for (const [route, messageId] of [
      ["/internal/agent-api/v2/send", "m-sent"],
      ["/internal/agent-api/send", "m-held"],
      ["/internal/agent-api/tasks/reply", "m-reply"],
      ["/internal/agent-api/tasks/claim", "m-not-a-send"],
    ] as const) {
      const res = await fetch(`${handle.proxyUrl}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ target: "#general", content: "hi", channel: "#general", task_number: 1 }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { messageId?: string }).messageId, messageId);
    }
  });
  assert.deepEqual(committed, [
    { messageId: "m-sent", route: "send" },
    { messageId: "m-reply", route: "task_reply" },
  ]);
  // The send outcomes the OAR host's turn span counts, as a coordinator hears them: sends only.
  assert.deepEqual(sendOutcomes, [{ state: "sent", messageId: "m-sent" }, { state: "held" }]);
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

// A task write carries the daemon's model-seen boundary for the conversation
// its result lands in (shared agentWriteLanding.ts), named in `seenFor`, and
// the Server's held context is booked under that landing like a send's, so
// the identical rerun attests it and passes.
test("agent credential proxy forwards the landing's boundary on task writes and consumes a server-held task response", async () => {
  for (const [path, body, landing, seenFor] of [
    ["/internal/agent-api/tasks/claim", { channel: "#board", task_numbers: [7] }, "#board:#7", "task_conversation"],
    ["/internal/agent-api/tasks/unclaim", { channel: "#board", task_number: 7 }, "#board:#7", "task_conversation"],
    ["/internal/agent-api/tasks/assign", { channel: "#board", task_number: 7, assignee: "@richard" }, "#board:#7", "task_conversation"],
    ["/internal/agent-api/tasks/update-status", { channel: "#board", task_number: 7, status: "in_review" }, "#board:#7", "task_conversation"],
    ["/internal/agent-api/tasks/amend", { channel: "#board", task_number: 7, title: "renamed" }, "#board:#7", "task_conversation"],
    ["/internal/agent-api/tasks", { channel: "#board", tasks: [{ title: "t", source_message_id: "abcdef12-3456" }] }, "#board:abcdef12", "source_thread"],
  ] as const) {
    const boundaries: Array<string | undefined> = [];
    const forwarded: Array<Record<string, unknown>> = [];
    const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
    await withUpstream((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        forwarded.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          state: "held",
          seenUpToSeq: 9,
          heldMessages: [{ seq: 9, id: "held-9", channel_type: "channel", channel_name: "board", content: "scope changed" }],
        }));
      });
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-1",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "send,read,tasks",
        inboxCoordinator: {
          getBoundary: (target) => {
            boundaries.push(target);
            return 7;
          },
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
      const res = await fetch(`${handle.proxyUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, path);
      assert.equal((await res.json() as { state?: string }).state, "held", path);
    });
    assert.equal(forwarded.length, 1, `${path} reached the Server`);
    assert.equal(forwarded[0]!.seenUpToSeq, 7, `${path} carries the daemon's boundary`);
    assert.equal(forwarded[0]!.seenFor, seenFor, `${path} names the landing its boundary is for`);
    assert.ok(boundaries.every((target) => target === landing), `${path} reads the boundary of ${landing}: ${boundaries.join(",")}`);
    assert.deepEqual(
      consumed.filter((entry) => entry.source === "server_held_context"),
      [{ target: landing, source: "server_held_context", boundarySeq: 9, seqs: [9] }],
      path,
    );
  }
});

// An applied task write's attached context (agentWriteLanding.ts `attach`)
// reaches the model with the response: it is booked under the write's landing,
// and the boundary moves only when every counted message was attached.
test("agent credential proxy books the unseen messages attached to an applied task write", async () => {
  for (const [omitted, boundary] of [[0, 12], [3, undefined]] as const) {
    const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
    await withUpstream((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          unseen: {
            target: "#board:#7",
            messages: [{ seq: 12, id: "unseen-12", content: "one more thing" }],
            newMessageCount: 1 + omitted,
            omittedMessageCount: omitted,
            seenUpToSeq: 12,
          },
        }));
      });
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-attach",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read,tasks",
        inboxCoordinator: {
          getBoundary: () => 10,
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
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/update-status`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: "#board", task_number: 7, status: "in_review" }),
      });
      assert.equal(res.status, 200);
    });
    assert.deepEqual(consumed, [{ target: "#board:#7", source: "server_held_context", boundarySeq: boundary, seqs: [12] }], `omitted=${omitted}`);
  }
});

// Glimpse input duplication: the server groups the bodies it returns by launch and model context.
test("agent credential proxy tells the server which launch and model context a request belongs to", async () => {
  const seen: Array<[string | undefined, string | undefined]> = [];
  await withUpstream((req, res) => {
    seen.push([req.headers["x-agent-launch-id"] as string | undefined, req.headers["x-agent-context-id"] as string | undefined]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: [] }));
  }, async (serverUrl) => {
    let contextId: string | null = "context-1111-aaaa";
    const coordinator = {
      getBoundary: () => undefined,
      getPendingMessages: () => [],
      consumeVisibleMessages: () => {},
      getContextId: () => contextId,
    };
    for (const [launchId, inboxCoordinator] of [["launch-1234-abcd", coordinator], [null, undefined]] as const) {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "send,read",
        ...(inboxCoordinator ? { inboxCoordinator } : {}),
      });
      const history = () => fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23board`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal((await history()).status, 200);
      if (inboxCoordinator) {
        contextId = "context-2222-bbbb"; // a compaction: same launch, new context
        assert.equal((await history()).status, 200);
        contextId = null; // none published
        assert.equal((await history()).status, 200);
      }
    }
  });
  assert.deepEqual(seen, [
    ["launch-1234-abcd", "context-1111-aaaa"],
    ["launch-1234-abcd", "context-2222-bbbb"],
    ["launch-1234-abcd", undefined],
    [undefined, undefined],
  ]);
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
  const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[]; responseBytes?: number }> = [];
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
            ...(input.responseBytes !== undefined && { responseBytes: input.responseBytes }),
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
      {
        target: "#general",
        source: "agent_api_history",
        boundarySeq: 12,
        seqs: [12],
        // History reads report the upstream body size for re-read telemetry.
        responseBytes: Buffer.byteLength(JSON.stringify({ messages: [{ seq: 12, id: "history-12", channel_type: "channel", channel_name: "general", content: "history" }] }), "utf8"),
      },
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

// `raft task read` is a history window on a task's own conversation. Task v2
// added its route without booking it, so a task read never counted as seen: a
// task assign was held on messages the agent had read, and the inbox kept them
// pending. Message envelopes carry no channel fields, so the key comes from
// the task ref the request asked for and the Server's answer names.
test("agent credential proxy books a task read under the task ref it asked for, and nowhere else", async () => {
  const taskMessages = [
    { seq: 21, id: "task-21", senderType: "human", senderName: "tygg", content: "first", createdAt: "2026-11-04T00:00:00.000Z" },
    { seq: 23, id: "task-23", senderType: "agent", senderName: "Kirby", content: "second", createdAt: "2026-11-04T00:00:01.000Z" },
  ];
  for (const [query, answerTarget, expected] of [
    ["channel=%23board&task_number=7", "#board:#7", "#board:#7"],
    ["channel=dm%3A%40tygg&task_number=3", "dm:@tygg:#3", "dm:@tygg:#3"],
    ["channel=%23board&task_number=7&before=30&limit=2", "#board:#7", "#board:#7"],
    ["channel=%23board&task_number=7", "#board", undefined],
    ["channel=%23board&task_number=7", undefined, undefined],
    ["channel=%23board&task_number=7", "#board:#8", undefined],
    ["channel=%23board&task_number=7&consume=false", "#board:#7", undefined],
  ] as const) {
    const consumed: Array<{ target?: string; source: string; boundarySeq?: number; seqs: number[] }> = [];
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...(answerTarget && { target: answerTarget }), messages: taskMessages }));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-task-read",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
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
        },
      });
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/read?${query}`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { messages?: unknown[] }).messages?.length, 2, "the read itself reaches the agent unchanged");
    });
    // `agent_api_history` books exact seqs only and never moves a boundary, so
    // a --before/--after page marks nothing it didn't return.
    assert.deepEqual(
      consumed,
      expected ? [{ target: expected, source: "agent_api_history", boundarySeq: 23, seqs: [21, 23] }] : [],
      `${query} answered for ${answerTarget ?? "no target"}`,
    );
  }
});

test("a task read counts as seen: the next task assign carries the read seqs for the task conversation, not the board", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const forwarded: Array<Record<string, unknown>> = [];
  await withUpstream((req, res) => {
    if (req.url?.startsWith("/internal/agent-api/tasks/read")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        target: "#proj-assistant:#19",
        messages: [
          { seq: 41, id: "task-41", senderType: "agent", senderName: "Kirby", content: "approved", createdAt: "2026-11-04T19:20:08.000Z" },
          { seq: 44, id: "task-44", senderType: "agent", senderName: "Grace", content: "thanks", createdAt: "2026-11-04T19:20:21.000Z" },
        ],
      }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      forwarded.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-read-assign",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: (target) => ledger.getBoundary("agent-1", target),
        getExactSeenSeqs: (target) => ledger.getExactSeenSeqs("agent-1", target),
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => { ledger.recordConsumed("agent-1", input); },
      },
    });
    const read = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/read?channel=%23proj-assistant&task_number=19&unread=true`, {
      headers: { Authorization: `Bearer ${handle.proxyToken}` },
    });
    assert.equal(read.status, 200);
    await read.json();
    const assign = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/assign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "#proj-assistant", task_number: 19, assignee: "@Grace" }),
    });
    assert.equal(assign.status, 200);
  });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0]!.seenExactSeqs, [41, 44], "the messages the read returned are attested as seen");
  assert.equal(forwarded[0]!.seenFor, "task_conversation");
  assert.equal(ledger.isModelSeen("agent-1", "#proj-assistant:#19", { seq: 44, message_id: "task-44" }), true);
  assert.deepEqual(ledger.getExactSeenSeqs("agent-1", "#proj-assistant"), [], "nothing is booked for the board");
});

/**
 * A coordinator on the real ledger, scoped to one model context as under
 * passive AX: what a task write's rerun attests is what the ledger kept.
 */
function ledgerCoordinator(
  ledger: AgentVisibleDeliveryLedger,
  agentId: string,
  context: { contextId: string },
  options: { pending?: AgentProxyVisibleMessage[]; consumed?: Array<{ source: string; seqs: number[] }> } = {},
) {
  const view = () => ledger.freshnessView(agentId, context);
  return {
    getBoundary: (target: string) => view().getBoundary(target),
    getExactSeenSeqs: (target: string) => view().getExactSeenSeqs(target),
    isMessageModelSeen: ({ target, message }: { target: string; message: AgentProxyVisibleMessage }) => view().isModelSeen(target, message),
    getPendingMessages: () => options.pending ?? [],
    consumeVisibleMessages: (input: Parameters<AgentVisibleDeliveryLedger["recordConsumed"]>[1]) => {
      options.consumed?.push({ source: input.source, seqs: input.messages.map((message) => Number(message.seq ?? 0)) });
      ledger.recordConsumed(agentId, { ...input, contextId: context.contextId });
    },
    recordHeldWriteSpan: (input: { target: string; writeKey: string; seenUpToSeq: number }) => {
      ledger.recordHeldWriteSpan(agentId, { ...input, contextId: context.contextId });
    },
    getHeldWriteSpan: ({ target, writeKey }: { target: string; writeKey: string }) =>
      ledger.getHeldWriteSpan(agentId, context, target, writeKey),
    getThreadTargetOfMessage: ({ parentTarget, messageId }: { parentTarget: string; messageId: string }) =>
      ledger.threadTargetOfMessage(agentId, parentTarget, messageId),
  };
}

/**
 * A Server that holds a gated task write until it attests `latestSeq`, as
 * gateTaskWriteFreshness does when the rerun's boundary covers its last hold;
 * the hold shows only the newest few messages (the rest are omitted).
 */
function holdingTaskWriteServer(latestSeq: number, heldMessages: AgentProxyVisibleMessage[], forwarded: Array<Record<string, unknown>>): http.RequestListener {
  return (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      forwarded.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      const seen = typeof body.seenUpToSeq === "number" ? body.seenUpToSeq : 0;
      res.end(JSON.stringify(seen >= latestSeq
        ? { ok: true }
        : {
          ok: true,
          state: "held",
          decision: "syncing_hold",
          newMessageCount: latestSeq - seen,
          omittedMessageCount: latestSeq - seen - heldMessages.length,
          seenUpToSeq: latestSeq,
          heldMessages,
        }));
    });
  };
}

async function postTaskWrite(handle: { proxyUrl: string; proxyToken: string }, path: string, body: Record<string, unknown>): Promise<{ state?: string }> {
  const res = await fetch(`${handle.proxyUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return await res.json() as { state?: string };
}

// #proj-o11y:#35: a task conversation the agent had handled in an earlier
// context held its assignment on 134 messages; the hold showed 3, and each
// identical rerun attested only those 3, so it was held 42 times. The hold's
// whole span is booked for freshness (not delivery): the rerun goes through.
test("a held task write's rerun attests the hold's whole span, not only the messages it showed", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const context = { contextId: "context-after-compaction" };
  const forwarded: Array<Record<string, unknown>> = [];
  const taskMessage = (seq: number): AgentProxyVisibleMessage => ({
    seq,
    id: `task-${seq}`,
    channel_type: "thread",
    channel_name: "#35",
    parent_channel_name: "proj-o11y",
    parent_channel_type: "channel",
    task_conversation_number: 35,
    sender_name: "richard",
    sender_type: "human",
    content: `update ${seq}`,
  });
  const assignBody = { channel: "#proj-o11y", task_number: 35, assignee: "@Grace" };
  await withUpstream(holdingTaskWriteServer(140, [taskMessage(138), taskMessage(139), taskMessage(140)], forwarded), async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-hold-span",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: ledgerCoordinator(ledger, "agent-1", context),
    });
    assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks/assign", assignBody)).state, "held");
    // The hold vouches only for its own rerun (the Server's write key):
    // another write to the same task saw 3 of 134 and is checked as such.
    assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks/claim", { channel: "#proj-o11y", task_numbers: [35] })).state, "held");
    assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks/assign", { ...assignBody, assignee: "@Kirby" })).state, "held");
    assert.notEqual((await postTaskWrite(handle, "/internal/agent-api/tasks/assign", assignBody)).state, "held", "the identical rerun goes through");
    // A new model context has seen none of it: evidence stays context-scoped.
    context.contextId = "context-next";
    assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks/assign", assignBody)).state, "held");
  });
  assert.equal(forwarded.length, 5);
  assert.equal(forwarded[0]!.seenUpToSeq, 0);
  assert.notEqual(forwarded[1]!.seenUpToSeq, 140, "a claim does not attest the assignment's hold");
  assert.notEqual(forwarded[2]!.seenUpToSeq, 140, "an assignment to someone else does not attest it");
  assert.equal(forwarded[3]!.seenUpToSeq, 140, "the rerun attests the hold's seenUpToSeq");
  assert.equal(forwarded[3]!.seenFor, "task_conversation");
  assert.equal(forwarded[4]!.seenUpToSeq, 0, "a new context attests nothing it has not seen");
  assert.equal(ledger.getBoundary("agent-1", "#proj-o11y:#35"), undefined, "never a delivery boundary: omitted rows stay deliverable");
});

// The held span must not reach the send planner: a message send to the same
// conversation would call the rows the hold left out seen, consume them as
// preflight context and drop them from the pending inbox undelivered.
test("a held task write's span leaves the rows its hold omitted pending for a message send to that conversation", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const context = { contextId: "context-1" };
  const taskMessage = (seq: number): AgentProxyVisibleMessage => ({
    seq,
    id: `task-${seq}`,
    message_id: `task-${seq}`,
    channel_id: "task-35-conversation",
    channel_type: "thread",
    channel_name: "#35",
    parent_channel_name: "proj-o11y",
    parent_channel_type: "channel",
    task_conversation_number: 35,
    sender_name: "richard",
    sender_type: "human",
    content: `update ${seq}`,
  });
  // Delivered to the daemon but never shown: the hold showed only 138-140.
  const pending = [10, 11, 12, 136, 137].map(taskMessage);
  const consumed: Array<{ source: string; seqs: number[] }> = [];
  const forwarded: Array<Record<string, unknown>> = [];
  await withUpstream(holdingTaskWriteServer(140, [taskMessage(138), taskMessage(139), taskMessage(140)], forwarded), async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-task-hold-then-send",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read,tasks",
      inboxCoordinator: ledgerCoordinator(ledger, "agent-1", context, { pending, consumed }),
    });
    assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks/assign", { channel: "#proj-o11y", task_number: 35, assignee: "@Grace" })).state, "held");
    const sent = await postTaskWrite(handle, "/internal/agent-api/send", { target: "#proj-o11y:#35", content: "on it" });
    assert.equal(sent.state, "held", "the send is held on the pending rows the model has not seen");
  });
  assert.equal(forwarded.length, 1, "the send was not forwarded past the pending rows");
  const preflightSeqs = consumed.filter((entry) => entry.source === "side_effect_preflight_context").flatMap((entry) => entry.seqs);
  assert.ok(!preflightSeqs.includes(10) && !preflightSeqs.includes(11), `rows the send's hold did not show stay pending: ${preflightSeqs.join(",")}`);
  for (const seq of [10, 11]) {
    assert.equal(ledger.isModelSeen("agent-1", "#proj-o11y:#35", { seq, message_id: `task-${seq}` }), false, `seq ${seq} is not suppressed`);
  }
});

// A task create from a reply inside a thread lands in that thread (the Server
// hangs the task under its root), but was attested for `#ch:<reply short>`, a
// thread that does not exist: the model's view of the real thread was never
// sent, and the hold's context was booked under the real thread, so the
// rerun attested nothing again and was held on reruns forever.
test("a task create from a reply in a thread attests that thread, and its rerun passes", async () => {
  const root = "aaaaaaaa-1111-4111-8111-111111111111";
  const reply = "bbbbbbbb-2222-4222-8222-222222222222";
  const threadMessage = (seq: number): AgentProxyVisibleMessage => ({
    seq,
    id: `thread-${seq}`,
    channel_type: "thread",
    channel_name: `thread-${root.slice(0, 8)}`,
    parent_channel_name: "proj",
    parent_channel_type: "channel",
    sender_name: "richard",
    sender_type: "human",
    content: `reply ${seq}`,
  });
  const createBody = { channel: "#proj", tasks: [{ title: "write the note", source_message_id: reply.slice(0, 8) }] };
  // Saw the thread before; never saw it; never saw it, and the hold shows the
  // reply itself (the rerun then attests the real thread, where the span
  // must be booked too).
  for (const [sawThread, holdShowsReply] of [[true, false], [false, false], [false, true]] as const) {
    const ledger = new AgentVisibleDeliveryLedger();
    const context = { contextId: "context-1" };
    if (sawThread) {
      // The model read the thread up to seq 94, the reply among it.
      ledger.recordConsumed("agent-1", {
        target: "#proj:aaaaaaaa",
        messages: [{ seq: 50, id: reply }, { seq: 94, id: "thread-94" }],
        boundarySeq: 94,
        source: "verified_contiguous_content_consumption",
        contextId: context.contextId,
      });
    }
    const forwarded: Array<Record<string, unknown>> = [];
    const held = [threadMessage(95), threadMessage(96), holdShowsReply ? { ...threadMessage(97), id: reply } : threadMessage(97)];
    await withUpstream(holdingTaskWriteServer(97, held, forwarded), async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: `launch-task-create-reply-${sawThread}-${holdShowsReply}`,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read,tasks",
        inboxCoordinator: ledgerCoordinator(ledger, "agent-1", context),
      });
      assert.equal((await postTaskWrite(handle, "/internal/agent-api/tasks", createBody)).state, "held");
      assert.notEqual((await postTaskWrite(handle, "/internal/agent-api/tasks", createBody)).state, "held", `rerun goes through (saw thread: ${sawThread}, hold shows reply: ${holdShowsReply})`);
    });
    assert.equal(forwarded.length, 2, "exactly one hold, then applied");
    assert.equal(forwarded[0]!.seenFor, "source_thread");
    assert.equal(forwarded[0]!.seenUpToSeq, sawThread ? 94 : 0, "attests what the model saw of the reply's thread");
    assert.equal(forwarded[1]!.seenUpToSeq, 97);
  }
});

// Guard: task v2 added `/tasks/read` and the proxy never booked it, while
// both sides' unit tests stayed green. Every route that answers with a history
// window is one the proxy books as seen.
test("every route that answers with a history window is booked as seen by the proxy", () => {
  const windowRoutes = Object.values(agentApiContract)
    .filter((route) => (route as { response?: { body?: unknown } }).response?.body === agentApiHistoryResponseSchema);
  assert.ok(windowRoutes.some((route) => route.key === "taskRead"), "fixture: task read answers with a history window");
  for (const route of windowRoutes) {
    assert.equal(__agentApiBooksHistoryWindowForTest(route.fullPath), true, `${route.key} (${route.fullPath}) is read by agents but never booked as seen`);
  }
});

// RFC 081 D1 / §7: `raft inbox read` drops what its page printed from the
// daemon-local queue, by id and seq, as a `message read` page does.
function inboxReadQueued(id: string, seq: number, overrides: Partial<AgentProxyVisibleMessage> = {}): AgentProxyVisibleMessage {
  return { id, message_id: id, seq, channel_id: "ch-general", channel_type: "channel", channel_name: "general", sender_name: "richard", sender_type: "human", content: id, ...overrides };
}

test("[D1] an inbox read page drops the messages it printed from the local queue; one it did not print stays", async () => {
  assert.equal(INBOX_READ_PATH, agentApiContract.inboxRead.fullPath, "the proxy watches the contract's route");
  const ledger = new AgentVisibleDeliveryLedger();
  // The daemon-local queue, as APM keeps it; consumeVisibleMessages filters it as APM does.
  let queue = [
    inboxReadQueued("m-41", 41),
    inboxReadQueued("m-42", 42),
    inboxReadQueued("m-43", 43),
    inboxReadQueued("t-50", 50, { channel_type: "thread", channel_name: "thread-3ae9bd99", parent_channel_name: "general", parent_channel_type: "channel" }),
  ];
  const sources: string[] = [];
  const requests: Array<{ method?: string; url?: string; body: string }> = [];
  await withUpstream((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        target: "#general",
        kind: "conversation",
        // The page printed 41 and 42 (oldest first); 43 is left for the next read.
        entries: [
          { seq: 41, id: "m-41", channel_type: "channel", channel_name: "general", senderType: "human", senderName: "richard", content: "m-41", createdAt: "2026-11-09T10:00:00.000Z" },
          { seq: 42, id: "m-42", channel_type: "channel", channel_name: "general", senderType: "human", senderName: "richard", content: "m-42", createdAt: "2026-11-09T10:01:00.000Z" },
        ],
        unreadBefore: 3,
        remaining: 1,
        remainingCapped: false,
        consumed: false,
        nextCursor: null,
      }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-inbox-read-drop",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: (target) => ledger.getBoundary("agent-1", target),
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          sources.push(input.source);
          const consumed = ledger.recordConsumed("agent-1", input);
          if (consumed) queue = queue.filter((message) => !consumed.shouldSuppress(message as never));
        },
      },
    });
    // Typed under another spelling than the Server's canonical target: the
    // entries' own metadata decides where they are booked.
    const res = await fetch(`${handle.proxyUrl}${INBOX_READ_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "#GENERAL" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { entries: unknown[] }).entries.length, 2, "the page reaches the agent unchanged");
  });
  assert.equal(requests.length, 1, "a destructive read is forwarded once, never retried");
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.url, INBOX_READ_PATH);
  assert.deepEqual(sources, ["agent_api_inbox_read"]);
  assert.deepEqual(queue.map((message) => message.id), ["m-43", "t-50"], "printed messages leave the queue; the rest stay");
  // Not pushed again: a re-delivery of a printed message is already model-seen.
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 42, message_id: "m-42" }), true);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 43, message_id: "m-43" }), false);
  // Exact ids and seqs only: a page never moves the boundary past what it did not print.
  assert.equal(ledger.getBoundary("agent-1", "#general"), undefined);
});

// RFC 081 D13 (Tenny #wg-ax:#19): reading a reminder consumes nothing (only
// its ack does), and its entries carry the firing event's id, so a reminder
// read must not drop the queued notice with that id.
test("[D13] an inbox read of a reminder leaves the local queue as it was", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  let queue = [inboxReadQueued("evt-7", 70)];
  const sources: string[] = [];
  await withUpstream((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        target: "app:system.reminder/rem-1",
        kind: "reminder",
        entries: [{ seq: 70, id: "evt-7", message_id: "evt-7", channel_type: "channel", channel_name: "general", content: "reminder fired", createdAt: "2026-11-09T10:00:00.000Z" }],
        unreadBefore: 1,
        remaining: 1,
        remainingCapped: false,
        consumed: false,
        nextCursor: null,
      }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-inbox-read-reminder",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: (target) => ledger.getBoundary("agent-1", target),
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => {
          sources.push(input.source);
          const consumed = ledger.recordConsumed("agent-1", input);
          if (consumed) queue = queue.filter((message) => !consumed.shouldSuppress(message as never));
        },
      },
    });
    const res = await fetch(`${handle.proxyUrl}${INBOX_READ_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "app:system.reminder/rem-1" }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(sources, [], "a reminder read books nothing");
  assert.deepEqual(queue.map((message) => message.id), ["evt-7"], "the queued notice stays until the reminder is acked");
});

test("[D1] an inbox read whose local bookkeeping fails still answers the agent once, without a retry", async () => {
  let upstreamCalls = 0;
  await withUpstream((req, res) => {
    upstreamCalls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ target: "#general", kind: "conversation", entries: [{ seq: 41, id: "m-41", channel_type: "channel", channel_name: "general", content: "m-41" }], unreadBefore: 1, remaining: 0, remainingCapped: false, consumed: true, nextCursor: null }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-inbox-read-ledger-fail",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => { throw new Error("ledger down"); },
      },
    });
    const res = await fetch(`${handle.proxyUrl}${INBOX_READ_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: "#general" }),
    });
    assert.equal(res.status, 200, "the consumed page is not lost to a local failure");
    assert.equal((await res.json() as { consumed: boolean }).consumed, true);
  });
  assert.equal(upstreamCalls, 1);
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

// Task #175: the Local Inbox answer to `/events` never reaches the server, so
// the server-side ack that marks third-party events delivered never ran and
// the server re-delivered them. After the response is written, the proxy
// reports exactly the third-party event ids that response carried.
function thirdPartyPendingMessage(id: string) {
  return {
    id,
    message_id: id,
    channel_id: "third-party-agent-events:agent-1",
    channel_type: "dm",
    channel_name: "third-party-agent-events:agent-1",
    sender_type: "third_party_app",
    sender_name: "stamp",
    content: `Third-party event: ${id}`,
    third_party_event: { id, kind: "event" },
  };
}

function mutableLocalInboxCoordinator(initial: Array<Record<string, unknown>>) {
  let pending = [...initial];
  return {
    getBoundary: () => undefined,
    getPendingMessages: () => [],
    getAllPendingMessages: () => pending,
    consumeVisibleMessages: (input: { messages: Array<{ message_id?: string; id?: string }> }) => {
      const consumed = new Set(input.messages.map((message) => message.message_id ?? message.id));
      pending = pending.filter((message) => !consumed.has(String(message.message_id)));
    },
  };
}

async function waitForCondition(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("agent credential proxy reports only the third-party events a Local Inbox /events response carried", async () => {
  const eventA = "aaaaaaaa-0000-4000-8000-000000000175";
  const eventB = "bbbbbbbb-0000-4000-8000-000000000175";
  const reports: Array<{ authorization?: string; eventIds: string[] }> = [];
  let upstreamEventsCount = 0;
  await withUpstream((req, res) => {
    if (req.url?.startsWith("/internal/agent-api/events")) upstreamEventsCount += 1;
    if (req.method === "POST" && req.url === "/internal/agent-api/third-party-events/delivered") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventIds: string[] };
        reports.push({ authorization: req.headers.authorization, eventIds: body.eventIds });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: body.eventIds.length }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-tp-report",
      launchId: "launch-third-party-report",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: mutableLocalInboxCoordinator([
        {
          id: "ordinary-101",
          message_id: "ordinary-101",
          channel_type: "channel",
          channel_name: "general",
          sender_type: "human",
          sender_name: "alice",
          content: "ordinary message",
        },
        thirdPartyPendingMessage(eventA),
        thirdPartyPendingMessage(eventB),
      ]),
    });
    try {
      // limit=2: event B is not in this response (has_more), so it must not be reported.
      const first = await fetch(`${handle.proxyUrl}/internal/agent-api/events?limit=2`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json() as { events: Array<{ message_id?: string }>; has_more: boolean };
      assert.equal(firstBody.has_more, true);
      const firstServed = firstBody.events.map((event) => event.message_id);
      assert.deepEqual(firstServed, ["ordinary-101", eventA]);
      await waitForCondition(() => reports.length >= 1, "first third-party delivery report");
      assert.deepEqual(reports, [{ authorization: "Bearer sk_agent_server_side", eventIds: [eventA] }]);

      const second = await fetch(`${handle.proxyUrl}/internal/agent-api/events?limit=2`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      const secondBody = await second.json() as { events: Array<{ message_id?: string }>; has_more: boolean };
      const secondServed = secondBody.events.map((event) => event.message_id);
      assert.deepEqual(secondServed, [eventB]);
      await waitForCondition(() => reports.length >= 2, "second third-party delivery report");
      assert.deepEqual(reports[1]?.eventIds, [eventB]);
      assert.equal(upstreamEventsCount, 0, "Local Inbox /events must not be forwarded");
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-report", launchId: "launch-third-party-report" });
    }
  });
});

test("agent credential proxy retries a failed third-party delivery report until the server accepts it", async () => {
  const eventA = "cccccccc-0000-4000-8000-000000000175";
  const statuses = [503, 200];
  const reports: string[][] = [];
  __setThirdPartyEventDeliveryReportRetryBaseMsForTest(10);
  try {
    await withUpstream((req, res) => {
      if (req.method === "POST" && req.url === "/internal/agent-api/third-party-events/delivered") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          reports.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventIds: string[] }).eventIds);
          const status = statuses.shift() ?? 200;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(status === 200 ? { ok: true, delivered: 1 } : { error: "unavailable" }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [] }));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-tp-report-retry",
        launchId: "launch-third-party-report-retry",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
        inboxCoordinator: mutableLocalInboxCoordinator([thirdPartyPendingMessage(eventA)]),
      });
      try {
        const events = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
        });
        assert.equal(events.status, 200);
        await waitForCondition(() => reports.length >= 2, "retried third-party delivery report");
        assert.deepEqual(reports, [[eventA], [eventA]]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(reports.length, 2, "an accepted report is not sent again");
      } finally {
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-report-retry", launchId: "launch-third-party-report-retry" });
      }
    });
  } finally {
    __setThirdPartyEventDeliveryReportRetryBaseMsForTest(undefined);
  }
});

test("agent credential proxy reports third-party events only after the response has been written, not before", async () => {
  // Ordering only: `finish` means the body was handed to the OS. It does not
  // prove the client read it (on some Linux hosts `finish` still fires after
  // the client destroyed its socket), so "no report on disconnect" is not a
  // property this code has. Closing that window needs an application-level
  // ack from the CLI (task #178).
  const eventA = "dddddddd-0000-4000-8000-000000000175";
  const reports: string[][] = [];
  await withUpstream((req, res) => {
    if (req.method === "POST" && req.url === "/internal/agent-api/third-party-events/delivered") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        reports.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventIds: string[] }).eventIds);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: 1 }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    // Far larger than the socket buffers: while the client does not read, the
    // proxy cannot finish writing it.
    const largeEvent = { ...thirdPartyPendingMessage(eventA), content: "x".repeat(32 * 1024 * 1024) };
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-tp-report-backpressure",
      launchId: "launch-third-party-report-backpressure",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: mutableLocalInboxCoordinator([largeEvent]),
    });
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(`${handle.proxyUrl}/internal/agent-api/events`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
        }, (res) => {
          res.pause();
          resolve(res);
        });
        req.on("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(reports, [], "no report while the response is still being written");

      let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      await new Promise<void>((resolve, reject) => {
        response.on("end", resolve);
        response.on("error", reject);
        response.resume();
      });
      assert.ok(bytes > 32 * 1024 * 1024, "the client read the whole body");
      await waitForCondition(() => reports.length >= 1, "third-party delivery report after the write");
      assert.deepEqual(reports, [[eventA]]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-report-backpressure", launchId: "launch-third-party-report-backpressure" });
    }
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

for (const inboxItemsFlag of [true, false]) test(`inbox items ${inboxItemsFlag ? "on" : "off"}: a locally fired reminder is acked only through the Server, listed once, and the daemon declares reminder-server-ack@1; other app items still ack locally`, async () => {
  const reminderId = "cccccccc-0000-4000-8000-000000000003";
  const reminderItemId = `reminder:${reminderId}:1`;
  const fixtureRegistry = {
    "test.fixture": {
      over_threshold: {
        retention: "transient" as const,
        primaryAction: { kind: "run_command" as const, commandId: "fixture.review" },
        normalizeSourceRef: (raw: unknown) => {
          const o = raw as { kind?: unknown; id?: unknown };
          return o?.kind === "fixture-measure" && typeof o.id === "string"
            ? { ok: true as const, ref: { kind: "fixture-measure", id: o.id } }
            : { ok: false as const, message: "invalid measure ref" };
        },
        materializeActionCli: () => "raft fixture review",
      },
    },
  };
  let ackMode: "refuse" | "unavailable" | "accept" = "refuse";
  let serverAcked = false;
  const upstreamAckCaps: string[] = [];
  const listCaps: string[] = [];
  let beforeAckCalls = 0;
  let beforeServerAckCalls = 0;
  await withUpstream((req, res) => {
    const caps = String(req.headers["x-raft-client-capabilities"] ?? "");
    if (req.method === "GET" && req.url?.startsWith("/internal/agent-api/inbox/conversations")) {
      listCaps.push(caps);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        view: "unread",
        items: [],
        hasMore: false,
        nextBeforeSeq: null,
        totals: { conversations: 0, dms: 0, mentions: 0 },
        preLaunch: null,
        omitted: null,
        rows: serverAcked ? [] : [{
          target: `reminder:${reminderId}`,
          kind: "reminder",
          app: { key: "system.reminder", name: "Reminder" },
          ack: [{ app: "system.reminder", id: reminderId, revision: "1" }],
          unread: 1,
          latestSender: null,
          preview: "check the deploy",
          previewTruncated: false,
          firstUnreadAt: null,
          latestAt: null,
          preLaunch: false,
        }],
      }));
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    upstreamAckCaps.push(caps);
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (ackMode === "refuse") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Source revision was not fired", code: "target_not_fired" }));
        return;
      }
      if (ackMode === "unavailable") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Service unavailable" }));
        return;
      }
      serverAcked = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        itemId: body.itemId,
        appId: body.appId,
        notificationClass: body.notificationClass,
        sourceRef: body.sourceRef,
        sourceEventId: "dddddddd-0000-4000-8000-000000000004",
        ackAttemptId: body.ackAttemptId,
        replayed: false,
      }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      idFactory: () => "fixture-item-1",
      registry: { ...REMINDER_AGENT_INBOX_REGISTRY, ...fixtureRegistry },
      // The reminder fired on this machine: the local cache would ack it.
      beforeAck: () => {
        beforeAckCalls += 1;
        return true;
      },
      beforeServerAuthorizedAck: () => {
        beforeServerAckCalls += 1;
        return true;
      },
    });
    assert.equal(appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "1" },
    }).ok, true);
    assert.equal(appInbox.mint({
      appId: "test.fixture",
      notificationClass: "over_threshold",
      sourceRef: { kind: "fixture-measure", id: "owner" },
    }).ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-server-ack",
      launchId: "launch-reminder-server-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      appInbox,
      inboxItems: () => inboxItemsFlag,
    });
    const authorization = { Authorization: `Bearer ${handle.proxyToken}` };
    const ack = (itemId: string) => fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "X-Raft-Client-Capabilities": "inbox-items@1" },
      body: JSON.stringify({ itemId }),
    });
    // `raft inbox check`: the Server's list and the daemon snapshot, merged by the CLI.
    const inboxCheck = async () => {
      const [list, daemon] = await Promise.all([
        fetch(`${handle.proxyUrl}/internal/agent-api/inbox/conversations?items=true`, {
          headers: { ...authorization, "X-Raft-Client-Capabilities": "manual-context-v1,inbox-items@1" },
        }),
        fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, { headers: authorization }),
      ]);
      assert.equal(list.status, 200);
      assert.equal(daemon.status, 200);
      const daemonBody = await daemon.json() as { items: Array<Record<string, unknown>> };
      const appItems = daemonBody.items.filter((item) => item.source === "app");
      return {
        appItems,
        text: formatInboxCheck({ view: "unread", nowMs: 0, list: await list.json() as never, appItems: appItems as never }),
      };
    };
    try {
      const before = await inboxCheck();
      assert.equal(listCaps.at(-1), `manual-context-v1,inbox-items@1,${REMINDER_SERVER_ACK_CAPABILITY}`);
      // The daemon still holds the item (`raft reminder ack` resolves it there); the merge shows it once.
      assert.equal(before.appItems.filter((item) => item.appId === "system.reminder").length, 1);
      assert.equal(before.text.match(/raft reminder ack/g)?.length, 1, before.text);
      assert.equal(before.text.match(new RegExp(`^reminder:${reminderId} · 1 fired, not acked`, "gm"))?.length, 1, before.text);
      assert.doesNotMatch(before.text, /action=raft reminder ack/, "the daemon copy is not listed beside the Server row");

      // A Server refusal is the caller's error; the local item stays and nothing acked locally.
      const refused = await ack(reminderItemId);
      assert.equal(refused.status, 404);
      assert.equal((await refused.json() as { code: string }).code, "target_not_fired");
      assert.equal(beforeAckCalls, 0, "the local cache never acks a reminder on its own");
      assert.equal(beforeServerAckCalls, 0);
      assert.ok(appInbox.list().some((item) => item.itemId === reminderItemId));

      // An unavailable Server is not faked into success either.
      ackMode = "unavailable";
      const unavailable = await ack(reminderItemId);
      assert.equal(unavailable.status, 503);
      assert.equal(beforeAckCalls, 0);
      assert.ok(appInbox.list().some((item) => item.itemId === reminderItemId));

      ackMode = "accept";
      const accepted = await ack(reminderItemId);
      assert.equal(accepted.status, 200);
      assert.equal(beforeAckCalls, 0);
      assert.equal(beforeServerAckCalls, 1, "the local cache converges only after the Server accepts");
      assert.equal(appInbox.list().some((item) => item.itemId === reminderItemId), false);
      assert.equal(upstreamAckCaps.length, 3);
      for (const caps of upstreamAckCaps) assert.equal(caps, `inbox-items@1,${REMINDER_SERVER_ACK_CAPABILITY}`);

      const after = await inboxCheck();
      assert.equal(after.appItems.filter((item) => item.appId === "system.reminder").length, 0);
      assert.doesNotMatch(after.text, /reminder:|raft reminder ack/);

      // A non-reminder app item keeps its local ack: no Server call.
      const fixture = await ack("fixture-item-1");
      assert.equal(fixture.status, 200);
      assert.equal(beforeAckCalls, 1);
      assert.equal(upstreamAckCaps.length, 3);
      assert.equal(appInbox.list().length, 0);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reminder-server-ack", launchId: "launch-reminder-server-ack" });
    }
  });
});

test("raft reminder ack says the reminder is still not acked: refused, where its current ack lines are; 5xx or unreachable, retry the same ack", async () => {
  const reminderId = "cccccccc-0000-4000-8000-000000000003";
  const json = (status: number, body: unknown): http.RequestListener => (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const stillNotAcked = `reminder ${reminderId} revision 1 is still not acknowledged.`;
  const sameAck = `it is safe to run the same ack again: raft reminder ack --id ${reminderId} --revision 1`;
  const cases: Array<{ upstream: http.RequestListener | "unreachable"; text: string }> = [
    {
      upstream: json(403, { error: "Permission denied", code: "FORBIDDEN" }),
      text: [
        `Error: The Server refused the ack (Permission denied); ${stillNotAcked}`,
        "Code: ACK_FAILED",
        "Next action: Nothing was acknowledged. raft inbox check lists this reminder's current ack: lines; ack those.",
      ].join("\n") + "\n",
    },
    {
      upstream: json(404, { error: "Source revision was not fired", code: "target_not_fired" }),
      text: [
        `Error: The Server refused the ack (Source revision was not fired); ${stillNotAcked}`,
        "Code: ACK_FAILED",
        "Next action: Nothing was acknowledged. raft inbox check lists this reminder's current ack: lines; ack those.",
      ].join("\n") + "\n",
    },
    {
      upstream: json(503, { error: "Service unavailable" }),
      text: [
        `Error: The Server could not take the ack (Service unavailable); ${stillNotAcked}`,
        "Code: SERVER_5XX",
        `Next action: Retry in a few seconds; ${sameAck}`,
      ].join("\n") + "\n",
    },
    {
      upstream: "unreachable",
      text: [
        `Error: The Server could not be reached; ${stillNotAcked}`,
        "Code: ACK_UNREACHABLE",
        `Next action: Retry in a few seconds; ${sameAck}`,
      ].join("\n") + "\n",
    },
  ];
  for (const [index, { upstream, text }] of cases.entries()) {
    const server = http.createServer(upstream === "unreachable" ? () => {} : upstream);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    if (upstream === "unreachable") await new Promise<void>((resolve) => server.close(() => resolve()));
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: () => true,
      beforeServerAuthorizedAck: () => true,
    });
    assert.equal(appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "1" },
    }).ok, true);
    const launchId = `launch-reminder-ack-text-${index}`;
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-ack-text",
      launchId,
      serverUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      appInbox,
    });
    const agentContext: AgentContext = {
      agentId: "agent-reminder-ack-text",
      serverId: "server-1",
      serverUrl: handle.proxyUrl,
      token: handle.proxyToken,
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      activeCapabilities: null,
    };
    const ctx = createCommandContext({
      io: { stdout: { write: () => true }, stderr: { write: () => true } },
      loadAgentContext: () => agentContext,
      createApiClient: () => new ApiClient(agentContext),
    });
    try {
      const error = await Promise.resolve(reminderAckCommand.handler(ctx, { id: "cccccccc", revision: "1" })).then(
        () => assert.fail("the ack must fail"),
        (err: unknown) => err,
      );
      assert.ok(error instanceof CliError, String(error));
      assert.equal(formatErrorEnvelope(error), text);
      assert.equal(appInbox.list().length, 1, "the local item stays");
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reminder-ack-text", launchId });
      if (upstream !== "unreachable") await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("sealed reminder items block receipt and server ACK paths before side effects; unsealed controls remain normal", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const controlReminderId = "bbbbbbbb-0000-4000-8000-000000000002";
  let upstreamAckCount = 0;
  let beforeAckCalls = 0;
  await withUpstream((req, res) => {
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    upstreamAckCount += 1;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...body, ok: true }));
    });
  }, async (serverUrl) => {
    const appInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      beforeAck: (item) => {
        beforeAckCalls += 1;
        return item.sourceRef.revision === "3";
      },
      beforeServerAuthorizedAck: () => true,
    });
    for (const revision of ["1", "2", "3", "4"]) {
      assert.equal(appInbox.mint({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: Number(revision) <= 2 ? reminderId : controlReminderId, revision },
      }).ok, true);
    }
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-sealed-reminders",
      launchId: "launch-sealed-reminders",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    const post = (path: string, body: unknown) => fetch(`${handle.proxyUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      const seal = await post("/internal/agent-api/inbox/seal", {
        sources: ["1", "2"].map((revision) => ({
          appId: "system.reminder",
          notificationClass: "due",
          sourceRef: { kind: "reminder", id: reminderId, revision },
        })),
        owner: "@Stone",
        until: "production contains fix",
      });
      assert.equal(seal.status, 200);
      assert.equal((await seal.json() as { affected: number }).affected, 2);

      for (const revision of ["1", "2"]) {
        const blocked = await post("/internal/agent-api/inbox/ack", { itemId: `reminder:${reminderId}:${revision}` });
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json() as { code: string }).code, "item_sealed");
      }
      assert.equal(beforeAckCalls, 0, "neither the receipt-present nor receipt-missing source callback ran");
      assert.equal(upstreamAckCount, 0, "sealed receipt-missing item never reached the Server");
      assert.deepEqual(
        appInbox.list().map((item) => [item.sourceRef.revision, item.seal?.owner ?? null]).sort(),
        [["1", "@Stone"], ["2", "@Stone"], ["3", null], ["4", null]],
      );

      // reminder-server-ack@1: an unsealed reminder is acked through the Server
      // whether or not the local cache holds its receipt.
      const receiptPresentControl = await post("/internal/agent-api/inbox/ack", { itemId: `reminder:${controlReminderId}:3` });
      assert.equal(receiptPresentControl.status, 200);
      assert.equal(beforeAckCalls, 0);
      assert.equal(upstreamAckCount, 1, "receipt-present unsealed control uses the Server path");

      const receiptMissingControl = await post("/internal/agent-api/inbox/ack", { itemId: `reminder:${controlReminderId}:4` });
      assert.equal(receiptMissingControl.status, 200);
      assert.equal(beforeAckCalls, 0);
      assert.equal(upstreamAckCount, 2, "receipt-missing unsealed control uses the Server path");
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-sealed-reminders", launchId: "launch-sealed-reminders" });
    }
  });
});

test("agent credential proxy app-source ACK retires only each Server-accepted exact historical item", async () => {
  const reminderId = "aaaaaaaa-0000-4000-8000-000000000001";
  const upstreamBodies: Record<string, unknown>[] = [];
  let beforeServerAckCalls = 0;
  await withUpstream((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const upstreamBody = JSON.parse(raw) as Record<string, unknown>;
      upstreamBodies.push(upstreamBody);
      const sourceRef = upstreamBody.sourceRef as { kind: string; id: string; revision: string };
      assert.equal(upstreamBody.itemId, `reminder:${reminderId}:${sourceRef.revision}`);
      assert.equal(upstreamBody.appId, "system.reminder");
      assert.equal(upstreamBody.notificationClass, "due");
      assert.deepEqual(sourceRef, { kind: "reminder", id: reminderId, revision: sourceRef.revision });
      assert.equal(typeof upstreamBody.ackAttemptId, "string");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        itemId: `reminder:${reminderId}:${sourceRef.revision}`,
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef,
        sourceEventId: sourceRef.revision === "9"
          ? "bbbbbbbb-0000-4000-8000-000000000002"
          : "bbbbbbbb-0000-4000-8000-000000000003",
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
    const newerMint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "10" },
    });
    assert.equal(newerMint.ok, true);
    const unacceptedMint = appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "11" },
    });
    assert.equal(unacceptedMint.ok, true);
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reminder-ack",
      launchId: "launch-reminder-ack",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "tasks",
      appInbox,
    });
    try {
      const firstResponse = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:9` }),
      });
      assert.equal(firstResponse.status, 200);
      const firstBody = await firstResponse.json() as Record<string, unknown>;
      assert.equal(firstBody.ok, true);
      assert.equal(firstBody.remaining_app_items, 2);
      assert.equal(firstBody.ackAttemptId, upstreamBodies[0]?.ackAttemptId);
      assert.deepEqual(
        appInbox.list().map((item) => item.sourceRef.revision).sort(),
        ["10", "11"],
      );

      const secondResponse = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemId: `reminder:${reminderId}:10` }),
      });
      assert.equal(secondResponse.status, 200);
      const secondBody = await secondResponse.json() as Record<string, unknown>;
      assert.equal(secondBody.ok, true);
      assert.equal(secondBody.remaining_app_items, 1);
      assert.equal(secondBody.ackAttemptId, upstreamBodies[1]?.ackAttemptId);
      assert.equal(beforeServerAckCalls, 2);
      assert.deepEqual(appInbox.list().map((item) => item.sourceRef.revision), ["11"]);
      assert.equal(appInbox.listAcknowledgedSources().length, 2);
      assert.deepEqual(
        appInbox.listAcknowledgedSources().map((item) => item.sourceRef.revision).sort(),
        ["10", "9"],
      );
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


for (const eventRef of ["abcdef12", "abcdef12-0000-4000-8000-000000000000", "ABCDEF12-0000-4000-8000-000000000000"]) {
  test(`agent credential proxy returns third-party event history for ${eventRef}`, async () => {
    const ledger = new AgentVisibleDeliveryLedger();
    const message = {
      id: "abcdef12-0000-4000-8000-000000000000", seq: 42,
      channel_type: "dm", channel_name: "third-party-agent-events:agent-1",
      third_party_event: { id: "abcdef12-0000-4000-8000-000000000000" },
    };
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [message] }));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1", launchId: "event-history", serverUrl,
        apiKey: "sk_agent_server_side", activeCapabilities: "read",
        inboxCoordinator: {
          getBoundary: (target) => ledger.getBoundary("agent-1", target),
          getPendingMessages: () => [],
          consumeVisibleMessages: (input) => { ledger.recordConsumed("agent-1", input); },
        },
      });
      const response = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=agent-event:${eventRef}`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { messages: [message] });
      assert.equal(ledger.isModelSeen("agent-1", "agent-event:abcdef12", message), true);
      assert.equal(ledger.isModelSeen("agent-1", `agent-event:${eventRef}`, message), true);
      assert.equal(ledger.getBoundary("agent-1", "agent-event:abcdef12"), undefined);
    });
  });
}

// `raft message read --target agent-event:<id8>` hands the event body to the
// runtime like a Local Inbox `/events` serve does, so it reports the event
// delivered once the response has been written. A read that fails (absent,
// ambiguous, expired) or does not consume carries no body to the model.
function withAgentEventHistoryUpstream(
  historyResponse: { status: number; body: unknown },
  fn: (serverUrl: string, reports: string[][]) => Promise<void>,
): Promise<void> {
  const reports: string[][] = [];
  return withUpstream((req, res) => {
    if (req.method === "POST" && req.url === "/internal/agent-api/third-party-events/delivered") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        reports.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventIds: string[] }).eventIds);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: 1 }));
      });
      return;
    }
    res.writeHead(historyResponse.status, { "content-type": "application/json" });
    res.end(JSON.stringify(historyResponse.body));
  }, (serverUrl) => fn(serverUrl, reports));
}

test("agent credential proxy reports a third-party event delivered after an agent-event re-read returns its body", async () => {
  const eventId = "abcdef12-0000-4000-8000-000000000257";
  const message = {
    id: eventId, message_id: eventId,
    channel_type: "dm", channel_name: "third-party-agent-events:agent-reread",
    third_party_event: { id: eventId },
  };
  const ledger = new AgentVisibleDeliveryLedger();
  await withAgentEventHistoryUpstream({ status: 200, body: { messages: [message] } }, async (serverUrl, reports) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-reread", launchId: "launch-reread", serverUrl,
      apiKey: "sk_agent_server_side", activeCapabilities: "read",
      inboxCoordinator: {
        getBoundary: (target) => ledger.getBoundary("agent-reread", target),
        getPendingMessages: () => [],
        consumeVisibleMessages: (input) => { ledger.recordConsumed("agent-reread", input); },
      },
    });
    try {
      const response = await fetch(`${handle.proxyUrl}/internal/agent-api/history?channel=agent-event:abcdef12`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { messages: [message] });
      await waitForCondition(() => reports.length >= 1, "re-read delivery report");
      assert.deepEqual(reports, [[eventId]]);
      assert.equal(ledger.isModelSeen("agent-reread", "agent-event:abcdef12", message), true);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reread", launchId: "launch-reread" });
    }
  });
});

test("a start-prompt delivered report is attempted only for an agent with a proxy registration", async () => {
  const eventId = "abcdef14-0000-4000-8000-000000000257";
  await withAgentEventHistoryUpstream({ status: 200, body: { events: [] } }, async (serverUrl, reports) => {
    assert.equal(reportThirdPartyEventsDelivered("agent-start-report", [eventId]), false, "no registration: nothing attempted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(reports, []);

    await registerAgentCredentialProxy({
      agentId: "agent-start-report", launchId: "launch-start-report", serverUrl,
      apiKey: "sk_agent_server_side", activeCapabilities: "read",
    });
    try {
      assert.equal(reportThirdPartyEventsDelivered("agent-start-report", [eventId]), true);
      await waitForCondition(() => reports.length >= 1, "start-prompt delivery report");
      assert.deepEqual(reports, [[eventId]]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-start-report", launchId: "launch-start-report" });
    }
  });
});

for (const [label, historyResponse, query] of [
  ["absent (404)", { status: 404, body: { error: "Channel not found" } }, "channel=agent-event:abcdef13"],
  ["ambiguous (409)", { status: 409, body: { error: "ambiguous", errorCode: "AMBIGUOUS_ID" } }, "channel=agent-event:abcdef13"],
  ["expired (410)", { status: 410, body: { error: "expired", errorCode: "EXPIRED" } }, "channel=agent-event:abcdef13"],
  ["a 2xx response with no messages", { status: 200, body: { messages: [] } }, "channel=agent-event:abcdef13"],
  ["an error status whose body still carries a message", {
    status: 404,
    body: { messages: [{ id: "abcdef13-0000-4000-8000-000000000257", third_party_event: { id: "abcdef13-0000-4000-8000-000000000257" } }] },
  }, "channel=agent-event:abcdef13"],
  ["consume=false", {
    status: 200,
    body: { messages: [{ id: "abcdef13-0000-4000-8000-000000000257", third_party_event: { id: "abcdef13-0000-4000-8000-000000000257" } }] },
  }, "channel=agent-event:abcdef13&consume=false"],
] as const) {
  test(`agent credential proxy does not report an agent-event re-read that is ${label}`, async () => {
    await withAgentEventHistoryUpstream(historyResponse, async (serverUrl, reports) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-reread-none", launchId: "launch-reread-none", serverUrl,
        apiKey: "sk_agent_server_side", activeCapabilities: "read",
        inboxCoordinator: { getBoundary: () => undefined, getPendingMessages: () => [], consumeVisibleMessages: () => undefined },
      });
      try {
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/history?${query}`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}` },
        });
        assert.equal(response.status, historyResponse.status);
        await response.arrayBuffer();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(reports, []);
      } finally {
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reread-none", launchId: "launch-reread-none" });
      }
    });
  });
}
test("history consumption scope survives HTTP and normalizes returned channel identity", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const channelId = "22222222-2222-4222-8222-222222222222";
  const scope = {
    agent_id: agentId,
    channel_id: channelId,
    channel_type: "dm",
    target: "dm:@peer",
  };
  const consumed: any[] = [];
  let returnedScope: any = scope;
  await withUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          messages: [{ id: "shown", channelId, seq: 7 }],
          consumption_scope: returnedScope,
        }),
      );
    },
    async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId,
        launchId: "launch-1",
        serverUrl,
        apiKey: "synthetic",
        activeCapabilities: "read",
        inboxCoordinator: {
          getBoundary: () => undefined,
          getPendingMessages: () => [],
          consumeVisibleMessages: (input) => {
            consumed.push(input);
          },
        },
      });
      for (const candidate of [
        scope,
        undefined,
        { ...scope, agent_id: "33333333-3333-4333-8333-333333333333" },
        { ...scope, channel_id: "invalid" },
      ]) {
        returnedScope = candidate;
        const res = await fetch(
          `${handle.proxyUrl}/internal/agent-api/history?channel=dm%3A%40peer`,
          { headers: { Authorization: `Bearer ${handle.proxyToken}` } },
        );
        assert.equal(res.status, 200);
        await res.text();
      }
      assert.deepEqual(consumed[0].historyScope, scope);
      assert.equal(consumed[0].messages[0].channel_id, channelId);
      assert.equal(consumed[0].messages[0].message_id, "shown");
      assert.equal(consumed[0].messages[0].channel_name, "peer");
      assert.deepEqual(
        consumed.slice(1).map((x) => x.historyScope),
        [undefined, undefined, undefined],
      );
    },
  );
});

// Undici is supposed to decode compressed upstream bodies, but on some Node
// builds it hands back the raw encoded bytes while the proxy strips
// content-encoding (the 2026-09-10 INVALID_JSON / empty-body incident). These
// drive the proxy with a fetch that returns exactly those shapes.
async function withRegisteredProxy(
  launchId: string,
  upstream: (url: string) => Response,
  fn: (handle: { proxyUrl: string; proxyToken: string }, clientFetch: typeof fetch) => Promise<void>,
  tracer?: BasicTracer,
): Promise<void> {
  const realFetch = installDaemonFetchMock((async (input: RequestInfo | URL) => upstream(String(input))) as typeof fetch);
  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-decode",
      launchId,
      serverUrl: "http://upstream.test",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      ...(tracer ? { tracer } : {}),
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        consumeVisibleMessages: () => {},
      },
    });
    try {
      // The helper also replaces globalThis.fetch, so the test talks to the
      // proxy through the real fetch it saved.
      await fn(handle, realFetch);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-decode", launchId });
    }
  } finally {
    restoreDaemonFetchMock(realFetch);
  }
}

const decodeHistoryBody = JSON.stringify({ messages: [{ seq: 1, id: "h-1", channel_type: "channel", channel_name: "general" }] });
const decodeServerBody = JSON.stringify({ ok: true, channels: [{ name: "general" }] });

test("agent credential proxy decodes an upstream body that is still gzip bytes, on the buffered and streaming paths", async () => {
  await withRegisteredProxy("launch-undecoded-gzip", (url) => {
    const body = url.includes("/history") ? decodeHistoryBody : decodeServerBody;
    return new Response(gzipSync(body), { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
  }, async (handle, clientFetch) => {
    const history = await clientFetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23general`, { headers: { Authorization: `Bearer ${handle.proxyToken}` } });
    assert.equal(history.headers.get("content-encoding"), null);
    assert.equal((await history.json() as { messages?: unknown[] }).messages?.length, 1, "buffered path");
    const server = await clientFetch(`${handle.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${handle.proxyToken}` } });
    assert.equal(server.headers.get("content-encoding"), null);
    assert.equal((await server.json() as { channels?: unknown[] }).channels?.length, 1, "streaming path");
  });
});

test("agent credential proxy does not decode twice when undici already decoded but the header survived, and counts deflate/br decode failures", async () => {
  for (const encoding of ["gzip", "deflate", "br"] as const) {
    const sink = new MemoryTraceSink();
    await withRegisteredProxy(`launch-decoded-${encoding}-header`, (url) => {
      const body = url.includes("/history") ? decodeHistoryBody : decodeServerBody;
      return new Response(body, { status: 200, headers: { "content-type": "application/json", "content-encoding": encoding } });
    }, async (handle, clientFetch) => {
      const history = await clientFetch(`${handle.proxyUrl}/internal/agent-api/history?channel=%23general`, { headers: { Authorization: `Bearer ${handle.proxyToken}` } });
      assert.equal(await history.text(), decodeHistoryBody, `${encoding}: buffered path passes the plain body through`);
      const server = await clientFetch(`${handle.proxyUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${handle.proxyToken}` } });
      assert.equal(await server.text(), decodeServerBody, `${encoding}: streaming path passes the plain body through`);
    }, deterministicProxyTracer(sink));
    const failures = sink.getAllSpans()
      .flatMap((span) => span.events)
      .filter((event) => event.name === "daemon.agent_proxy.upstream_decode_failed");
    // gzip is only decoded when its magic bytes are present, so a plain body
    // never reaches the decoder; deflate/br have no magic check and rely on the
    // decoder throwing, which is recorded.
    assert.equal(failures.length, encoding === "gzip" ? 0 : 2, `${encoding}: decode failures recorded per request`);
    for (const failure of failures) assert.equal(failure.attrs?.encoding, encoding);
  }
});

test("agent credential proxy streams an unencoded attachment byte-for-byte and asks upstream for identity", async () => {
  const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x10, 0x20, 0x30]); // gzip-looking, but not declared encoded
  const seenAcceptEncoding: Array<string | null> = [];
  const realFetch = installDaemonFetchMock((async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenAcceptEncoding.push(new Headers(init?.headers).get("accept-encoding"));
    return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
  }) as typeof fetch);
  try {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-decode",
      launchId: "launch-attachment-stream",
      serverUrl: "http://upstream.test",
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
    });
    try {
      const response = await realFetch(`${handle.proxyUrl}/internal/agent-api/attachments/att-1`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "Accept-Encoding": "gzip, br" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, "no sniffing on an undeclared encoding");
      assert.deepEqual(seenAcceptEncoding, ["identity"], "the caller's accept-encoding is replaced");
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-decode", launchId: "launch-attachment-stream" });
    }
  } finally {
    restoreDaemonFetchMock(realFetch);
  }
});
// Task #178 — application-layer ack. With `X-Raft-Events-Ack: lease` the
// daemon only leases the third-party events a Local Inbox /events response
// carries: nothing is consumed or reported until the CLI acks the batch.
const LEASE_HEADER = { "x-raft-events-ack": "lease" };

function thirdPartyReportCollector() {
  const reports: string[][] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method === "POST" && req.url === "/internal/agent-api/third-party-events/delivered") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        reports.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { eventIds: string[] }).eventIds);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, delivered: 1 }));
      });
      return true;
    }
    return false;
  };
  return { reports, handler };
}

async function ackThirdParty(handle: { proxyUrl: string; proxyToken: string }, batchId: string, eventIds: string[]) {
  return fetch(`${handle.proxyUrl}/internal/agent-api/third-party-events/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
    body: JSON.stringify({ batchId, eventIds }),
  });
}

test("task #178: a leased third-party event is neither consumed nor reported until the CLI acks the live batch, then exactly once", async () => {
  const eventA = "aaaaaaaa-0000-4000-8000-000000000178";
  const { reports, handler } = thirdPartyReportCollector();
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-tp-lease",
      launchId: "launch-tp-lease",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: mutableLocalInboxCoordinator([
        { id: "ordinary-1", message_id: "ordinary-1", channel_type: "channel", channel_name: "general", sender_type: "human", sender_name: "alice", content: "hi" },
        thirdPartyPendingMessage(eventA),
      ]),
      tracer: deterministicProxyTracer(sink),
    });
    try {
      const served = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}`, ...LEASE_HEADER },
      });
      assert.equal(served.status, 200);
      const body = await served.json() as { events: Array<{ message_id?: string }>; third_party_lease?: { batch_id: string; event_ids: string[]; expires_at: string } };
      assert.deepEqual(body.events.map((event) => event.message_id), ["ordinary-1", eventA]);
      assert.ok(body.third_party_lease, "lease mode returns a lease for the third-party events");
      assert.deepEqual(body.third_party_lease.event_ids, [eventA]);
      assert.match(body.third_party_lease.batch_id, /^[0-9a-f-]{36}$/);

      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(reports, [], "serving under lease must not report delivered");
      const eventsSpan = sink.getAllSpans().find((span) => span.attrs?.local_response_kind === "events");
      assert.equal(eventsSpan?.attrs?.third_party_ack_mode, "lease");

      // The ordinary message was consumed; the leased event is still pending
      // and is re-served under a new batch, which voids the first one.
      const again = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}`, ...LEASE_HEADER },
      });
      const againBody = await again.json() as { events: Array<{ message_id?: string }>; third_party_lease?: { batch_id: string } };
      assert.deepEqual(againBody.events.map((event) => event.message_id), [eventA]);
      assert.ok(againBody.third_party_lease);
      assert.notEqual(againBody.third_party_lease.batch_id, body.third_party_lease.batch_id, "a re-serve issues a new batch");

      const stale = await ackThirdParty(handle, body.third_party_lease.batch_id, [eventA]);
      assert.equal(stale.status, 409);
      assert.equal(((await stale.json()) as { code?: string }).code, "lease_not_live");
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(reports, [], "an ack for a voided batch must not report");

      const ack = await ackThirdParty(handle, againBody.third_party_lease.batch_id, [eventA.toUpperCase()]);
      assert.equal(ack.status, 200);
      assert.deepEqual(await ack.json(), { ok: true, batchId: againBody.third_party_lease.batch_id, acked: [eventA] });
      await waitForCondition(() => reports.length >= 1, "delivered report after ack");
      assert.deepEqual(reports, [[eventA]]);

      // Local Inbox is empty now: the request falls through to upstream and
      // nothing more is reported.
      const drained = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}`, ...LEASE_HEADER },
      });
      assert.deepEqual(((await drained.json()) as { events: unknown[] }).events, []);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(reports, [[eventA]], "reported exactly once");
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-lease", launchId: "launch-tp-lease" });
    }
  });
});

test("task #178: an expired lease rejects the ack without reporting, and the next check serves the event again", async () => {
  const eventA = "bbbbbbbb-0000-4000-8000-000000000178";
  const { reports, handler } = thirdPartyReportCollector();
  __setThirdPartyEventLeaseMsForTest(30);
  try {
    await withUpstream((req, res) => {
      if (handler(req, res)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [] }));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-tp-lease-expiry",
        launchId: "launch-tp-lease-expiry",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
        inboxCoordinator: mutableLocalInboxCoordinator([thirdPartyPendingMessage(eventA)]),
      });
      try {
        const served = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}`, ...LEASE_HEADER },
        });
        const body = await served.json() as { third_party_lease?: { batch_id: string } };
        assert.ok(body.third_party_lease);
        await new Promise((resolve) => setTimeout(resolve, 80));

        const late = await ackThirdParty(handle, body.third_party_lease.batch_id, [eventA]);
        assert.equal(late.status, 409);
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.deepEqual(reports, [], "a late ack must not report");

        const again = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
          headers: { Authorization: `Bearer ${handle.proxyToken}`, ...LEASE_HEADER },
        });
        const againBody = await again.json() as { events: Array<{ message_id?: string }>; third_party_lease?: { batch_id: string } };
        assert.deepEqual(againBody.events.map((event) => event.message_id), [eventA], "the event is served again after the lease expired");
        assert.ok(againBody.third_party_lease);
      } finally {
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-lease-expiry", launchId: "launch-tp-lease-expiry" });
      }
    });
  } finally {
    __setThirdPartyEventLeaseMsForTest(undefined);
  }
});

test("task #178: a CLI without the ack header keeps the task #175 finish semantics, marked as fallback in the trace", async () => {
  const eventA = "cccccccc-0000-4000-8000-000000000178";
  const { reports, handler } = thirdPartyReportCollector();
  const sink = new MemoryTraceSink();
  await withUpstream((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-tp-fallback",
      launchId: "launch-tp-fallback",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: mutableLocalInboxCoordinator([thirdPartyPendingMessage(eventA)]),
      tracer: deterministicProxyTracer(sink),
    });
    try {
      const served = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      const body = await served.json() as { events: Array<{ message_id?: string }>; third_party_lease?: unknown };
      assert.deepEqual(body.events.map((event) => event.message_id), [eventA]);
      assert.equal(body.third_party_lease, undefined, "no lease without the header");
      await waitForCondition(() => reports.length >= 1, "finish-fallback report");
      assert.deepEqual(reports, [[eventA]]);
      const eventsSpan = sink.getAllSpans().find((span) => span.attrs?.local_response_kind === "events");
      assert.equal(eventsSpan?.attrs?.third_party_ack_mode, "finish_fallback");
      assert.equal(eventsSpan?.attrs?.third_party_served_count, 1);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-fallback", launchId: "launch-tp-fallback" });
    }
  });
});

// Task #179 (follow-up to #176) — the reporter consumes the shared id contract:
// the ids it reports are exactly the served ids that `isThirdPartyEventId`
// accepts, in `normalizeThirdPartyEventId` form. A local copy of the pattern or
// the normalization would drift from this expectation, computed here from the
// shared exports themselves (the shared test keeps a source-level guard too).
test("task #179: the delivered report contains exactly the served ids the shared contract accepts, normalized", async () => {
  const upper = "EEEEEEEE-0000-4000-8000-000000000179";
  const lower = "ffffffff-0000-4000-8000-000000000179";
  const invalid = "not-a-third-party-event-id";
  const served = [upper, lower, invalid];
  const expected = served.filter(isThirdPartyEventId).map(normalizeThirdPartyEventId);
  assert.deepEqual(expected, [upper.toLowerCase(), lower], "precondition: the shared contract accepts two of three");
  const { reports, handler } = thirdPartyReportCollector();
  await withUpstream((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-tp-contract",
      launchId: "launch-tp-contract",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      inboxCoordinator: mutableLocalInboxCoordinator(served.map((id) => thirdPartyPendingMessage(id))),
    });
    try {
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/events`, {
        headers: { Authorization: `Bearer ${handle.proxyToken}` },
      });
      assert.equal(res.status, 200);
      await waitForCondition(() => reports.length >= 1, "finish-fallback report");
      assert.deepEqual(reports, [expected]);
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-tp-contract", launchId: "launch-tp-contract" });
    }
  });
});

// task #360: an idle stdin delivery of a thread reply with its join package
// records the package tail as the thread boundary and the reply itself by
// exact id. The send preflight must hand the Server those exact seqs above the
// boundary, or it counts the already-delivered reply as unread and holds.
function threadReplyWithJoinContext(input: { triggerSeq: number; recentSeqs: number[]; historyTruncated?: boolean }): AgentMessage {
  const threadTarget = "#proj-raft-computer:459ad9a0";
  return {
    channel_id: "thread-channel",
    channel_name: "459ad9a0-1111-4111-8111-111111111111",
    channel_type: "thread",
    parent_channel_name: "proj-raft-computer",
    parent_channel_type: "channel",
    sender_id: "user-tygg",
    sender_name: "tygg",
    sender_type: "human",
    content: "@archer 再发一个 staging",
    timestamp: "2026-10-01T04:41:46.000Z",
    message_id: `trigger-${input.triggerSeq}`,
    seq: input.triggerSeq,
    thread_join_context: {
      reason: "mentioned",
      parent_target: "#proj-raft-computer",
      thread_target: threadTarget,
      suggested_read_history_target: threadTarget,
      parent_message: { message_id: "parent-1000", sender_name: "tygg", sender_description: null, sender_type: "human", content: "parent", timestamp: "2026-10-01T02:51:00.000Z", seq: 1000 },
      recent_messages: input.recentSeqs.map((seq) => ({ message_id: `recent-${seq}`, sender_name: "archer", sender_description: null, sender_type: "agent", content: `reply ${seq}`, timestamp: "2026-10-01T03:00:00.000Z", seq })),
      history_truncated: input.historyTruncated ?? false,
    },
  } as AgentMessage;
}

async function sendThroughLedgerBackedProxy(
  ledger: AgentVisibleDeliveryLedger,
  requestBody: Record<string, unknown>,
  options: { path?: string; pending?: AgentProxyVisibleMessage[]; upstreamResponse?: Record<string, unknown>; freshness?: () => AgentVisibleFreshnessView } = {},
): Promise<Record<string, unknown>> {
  const path = options.path ?? "/internal/agent-api/send";
  // Defaults to the process-wide facts (no context signal); `freshness` wires a scoped view.
  const freshness = options.freshness ?? (() => ledger.freshnessView("agent-1", undefined));
  let forwarded: Record<string, unknown> | undefined;
  await withUpstream((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === path) forwarded = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.upstreamResponse ?? { state: "sent", messageId: "sent-1" }));
    });
  }, async (serverUrl) => {
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-1",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: (target) => freshness().getBoundary(target),
        getPendingMessages: () => options.pending ?? [],
        isMessageModelSeen: ({ target, message }) => freshness().isModelSeen(target, message),
        getExactSeenSeqs: (target) => freshness().getExactSeenSeqs(target),
        consumeVisibleMessages: (input) => { ledger.recordConsumed("agent-1", input); },
      },
    });
    const res = await fetch(`${handle.proxyUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(res.status, 200);
  });
  assert.ok(forwarded, "the send reaches the Server");
  return forwarded;
}

function deliverIdleWithJoinContext(ledger: AgentVisibleDeliveryLedger, message: AgentMessage, contextId?: string): void {
  // Mirrors the idle stdin delivery: the rendered package, then the reply itself.
  for (const receipt of threadJoinContextReceipts([message])) {
    ledger.recordConsumed("agent-1", { ...receipt, contextId });
  }
  ledger.recordConsumed("agent-1", { messages: [message], source: "stdin_idle_delivery", contextId });
}

test("task #360 sample 1: a thread reply delivered in full is forwarded as an exact seen seq above the boundary", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1030, recentSeqs: [1010, 1020] }));
  assert.equal(ledger.getBoundary("agent-1", "#proj-raft-computer:459ad9a0"), 1020, "precondition: the package tail is the boundary");

  const forwarded = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply" });
  assert.equal(forwarded.seenUpToSeq, 1020);
  assert.deepEqual(forwarded.seenExactSeqs, [1030], "the delivered reply must not be counted as unread");
});

test("a truncated thread-join package records its replies as exact seqs and leaves older replies below them unseen", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1030, recentSeqs: [1010, 1020], historyTruncated: true }));
  assert.equal(ledger.getBoundary("agent-1", "#proj-raft-computer:459ad9a0"), undefined, "the replies cut from the package (below 1010) must not count as seen");
  assert.equal(ledger.getBoundary("agent-1", "#proj-raft-computer"), undefined, "the parent channel never advances");

  const forwarded = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply" });
  assert.equal(forwarded.seenUpToSeq, undefined);
  assert.deepEqual(forwarded.seenExactSeqs, [1010, 1020, 1030], "the rendered replies and the trigger are still seen, exactly");
});

test("task #360 sample 2: daemon exact seqs are unioned with the CLI's own, never replacing them", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1050, recentSeqs: [1040] }));

  const forwarded = await sendThroughLedgerBackedProxy(ledger, {
    target: "#proj-raft-computer:459ad9a0",
    content: "reply",
    seenUpToSeq: 1000,
    seenExactSeqs: [1025],
  });
  assert.equal(forwarded.seenUpToSeq, 1040);
  assert.deepEqual(forwarded.seenExactSeqs, [1025, 1050]);
});

// task #360 follow-up: the CLI has sent through /internal/agent-api/v2/send
// since #7035, which the side-effect preflight never matched. These pin the
// real route: forward-only enrichment, never a local hold.
const SEND_V2 = "/internal/agent-api/v2/send";

test("task #360 v2: a thread reply delivered in full reaches the Server as an exact seen seq on the real CLI route", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1030, recentSeqs: [1010, 1020] }));

  const forwarded = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply" }, { path: SEND_V2 });
  assert.equal(forwarded.seenUpToSeq, 1020);
  assert.deepEqual(forwarded.seenExactSeqs, [1030]);
});

test("task #360 v2: daemon facts lift and union with the CLI's own on the real route", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1050, recentSeqs: [1040] }));

  const forwarded = await sendThroughLedgerBackedProxy(ledger, {
    target: "#proj-raft-computer:459ad9a0",
    content: "reply",
    seenUpToSeq: 1000,
    seenExactSeqs: [1025],
  }, { path: SEND_V2 });
  assert.equal(forwarded.seenUpToSeq, 1040);
  assert.deepEqual(forwarded.seenExactSeqs, [1025, 1050]);
});

test("task #360 v2: an unseen pending message never turns a v2 send into a local hold, and its context is not consumed", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const pending: AgentProxyVisibleMessage[] = [{
    seq: 2001,
    id: "pending-2001",
    channel_type: "channel",
    channel_name: "general",
    sender_type: "human",
    sender_name: "tygg",
    content: "unseen",
    createdAt: "2026-10-01T12:00:00.000Z",
  }];
  const forwarded = await sendThroughLedgerBackedProxy(ledger, { target: "#general", content: "reply", seenUpToSeq: 1990 }, { path: SEND_V2, pending });
  assert.equal(forwarded.seenUpToSeq, 1990, "the Server decides the hold from the CLI's own boundary");
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 2001, message_id: "pending-2001" }), false, "a hold the agent never saw consumes nothing");
});

// glimpse G0: under passive AX the daemon's facts are scoped like the CLI's.
// A thread package pushed in this context counts for a v2 send (it used to be
// withheld entirely); one pushed before a compaction does not.
test("glimpse G0: a v2 send carries daemon facts from the current context only", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  let contextId = "ctx-1";
  const freshness = () => ledger.freshnessView("agent-1", { contextId });
  deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1030, recentSeqs: [1010, 1020] }), contextId);

  const sameContext = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply" }, { path: SEND_V2, freshness });
  assert.equal(sameContext.seenUpToSeq, 1020, "within the context the package is evidence, as before");
  assert.deepEqual(sameContext.seenExactSeqs, [1030]);

  contextId = "ctx-2";
  const afterCompaction = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply" }, { path: SEND_V2, freshness });
  assert.equal(afterCompaction.seenUpToSeq, undefined, "the Server decides from the CLI's own (empty) evidence and holds");
  assert.equal(afterCompaction.seenExactSeqs, undefined);
  assert.equal(ledger.getBoundary("agent-1", "#proj-raft-computer:459ad9a0"), 1020, "delivery facts themselves are kept");
  assert.equal(ledger.isModelSeen("agent-1", "#proj-raft-computer:459ad9a0", { message_id: "trigger-1030" }), true);
});

// glimpse G0: the claim preflight reads the same context-scoped view. A target
// read in this context forwards; after a compaction the same claim is held
// until the model sees the target's latest messages again.
test("glimpse G0: a task claim after a compaction attests only what the model still has", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  let contextId = "ctx-1";
  ledger.recordConsumed("agent-1", {
    target: "#proj-runtime:#201",
    messages: [{ seq: 99, id: "recent-task-99" }],
    boundarySeq: 99,
    source: "verified_contiguous_content_consumption",
    contextId,
  });
  let upstreamClaimCount = 0;
  const forwardedSeen: Array<number | undefined> = [];
  await withUpstream(async (req, res) => {
    if (req.url?.startsWith("/internal/agent-api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [{ seq: 99, id: "recent-task-99", senderType: "human", senderName: "tygg", content: "task context", createdAt: "2026-05-20T00:00:00.000Z" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/internal/agent-api/tasks/claim") {
        upstreamClaimCount += 1;
        forwardedSeen.push((JSON.parse(raw) as { seenUpToSeq?: number }).seenUpToSeq);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results: [{ taskNumber: 201, success: true }] }));
    });
  }, async (serverUrl) => {
    const view = () => ledger.freshnessView("agent-1", { contextId });
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-glimpse-claim",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read,tasks",
      inboxCoordinator: {
        getBoundary: (target) => view().getBoundary(target),
        getPendingMessages: () => [],
        isMessageModelSeen: ({ target, message }) => view().isModelSeen(target, message),
        consumeVisibleMessages: (input) => { ledger.recordConsumed("agent-1", { ...input, contextId }); },
      },
    });
    const claim = async () => {
      const res = await fetch(`${handle.proxyUrl}/internal/agent-api/tasks/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: "#proj-runtime", task_numbers: [201] }),
      });
      return await res.json() as { state?: string; heldMessages?: Array<{ seq?: number }> };
    };

    assert.notEqual((await claim()).state, "held", "read in this context: forwarded");
    contextId = "ctx-2";
    assert.notEqual((await claim()).state, "held", "the Server decides a first touch");
    assert.equal(upstreamClaimCount, 2);
    assert.deepEqual(forwardedSeen, [99, 0], "after the compaction the claim no longer attests what the model lost");
  });
});

// Guard: the CLI changed its send route once and the proxy never followed,
// while both sides' unit tests stayed green. Every side-effect route the CLI
// can call must be classified by the proxy, including any future send version.
test("every CLI side-effect route, including every message send version, is classified by the proxy", () => {
  const sideEffectKeys = new Set(["taskCreate", "taskClaim", "taskUnclaim", "taskAssign", "taskUpdateStatus", "taskAmend"]);
  const routes = AGENT_API_ROUTE_MANIFEST.filter((route) => route.key.startsWith("messageSend") || sideEffectKeys.has(route.key));
  assert.ok(routes.some((route) => route.key === "messageSendV2"), "fixture: the v2 send route is in the manifest");
  for (const route of routes) {
    assert.notEqual(
      __agentApiSideEffectActionForTest(route.fullPath),
      undefined,
      `${route.key} (${route.fullPath}) reaches the daemon proxy unclassified`,
    );
  }
});

test("task #360 v2: v1 and v2 sends forward the same freshness body", async () => {
  const bodies: Record<string, unknown>[] = [];
  for (const path of ["/internal/agent-api/send", SEND_V2]) {
    const ledger = new AgentVisibleDeliveryLedger();
    deliverIdleWithJoinContext(ledger, threadReplyWithJoinContext({ triggerSeq: 1050, recentSeqs: [1040] }));
    const forwarded = await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:459ad9a0", content: "reply", seenExactSeqs: [1025] }, { path });
    bodies.push({ seenUpToSeq: forwarded.seenUpToSeq, seenExactSeqs: forwarded.seenExactSeqs });
  }
  assert.deepEqual(bodies[1], bodies[0]);
});

test("task #360 v2: a v2 send's own commit and the Server's held context feed the ledger like v1", async () => {
  const committed = new AgentVisibleDeliveryLedger();
  await sendThroughLedgerBackedProxy(committed, { target: "#general", content: "reply" }, {
    path: SEND_V2,
    upstreamResponse: { state: "sent", messageId: "own-3001", messageSeq: 3001 },
  });
  assert.equal(committed.isModelSeen("agent-1", "#general", { message_id: "own-3001" }), true, "the agent's own v2 message is seen");

  const held = new AgentVisibleDeliveryLedger();
  await sendThroughLedgerBackedProxy(held, { target: "#general", content: "reply" }, {
    path: SEND_V2,
    upstreamResponse: {
      state: "held",
      seenUpToSeq: 3100,
      heldMessages: [{ id: "held-3100", seq: 3100, channel_type: "channel", channel_name: "general", sender_type: "human", sender_name: "tygg", content: "new", createdAt: "2026-10-01T12:00:00.000Z" }],
    },
  });
  assert.equal(held.isModelSeen("agent-1", "#general", { seq: 3100, message_id: "held-3100" }), true, "the v2 hold's shown context is seen");
});

// 2026-10-14 (Tenny, armbian-jojo): a send addressed the thread by its
// `threadId` (`:46a146e8`); the Server resolved it and held the send with the
// thread's unread replies, which name the canonical target (`:3ae9bd99`, the
// root message). The ledger refused the mismatch, the proxy turned the held
// reply into PROXY_5XX, and the agent never saw the hold.
const heldThreadReply = (id: string, seq: number): Record<string, unknown> => ({
  id,
  seq,
  channel_type: "thread",
  channel_name: "thread-3ae9bd99",
  parent_channel_name: "proj-raft-computer",
  parent_channel_type: "channel",
  sender_type: "human",
  sender_name: "xxchan",
  content: "unread reply",
  createdAt: "2026-10-14T03:40:00.000Z",
});

test("a held send to a thread's alias reaches the agent and records the context under the thread the Server resolved", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:46a146e8", content: "reply" }, {
    path: SEND_V2,
    upstreamResponse: { state: "held", seenUpToSeq: 4101, heldMessages: [heldThreadReply("held-4100", 4100), heldThreadReply("held-4101", 4101)] },
  });
  assert.equal(ledger.isModelSeen("agent-1", "#proj-raft-computer:3ae9bd99", { seq: 4101, message_id: "held-4101" }), true);
  assert.equal(ledger.getBoundary("agent-1", "#proj-raft-computer:46a146e8"), undefined, "nothing is recorded under the alias");
});

test("a send's reply reaches the agent even when the ledger update throws; a read still reports post_response_local", async () => {
  for (const upstreamResponse of [
    { state: "sent", messageId: "own-5001", messageSeq: 5001 },
    { state: "held", heldMessages: [{ id: "held-5002", seq: 5002, channel_type: "channel", channel_name: "general", content: "new" }] },
  ]) {
    await withUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(upstreamResponse));
    }, async (serverUrl) => {
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-1",
        launchId: "launch-ledger-throws",
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "send,read",
        inboxCoordinator: {
          getBoundary: () => undefined,
          getPendingMessages: () => [],
          consumeVisibleMessages: () => {
            throw new Error("AgentVisibleDeliveryLedger target mismatch");
          },
        },
      });
      const res = await fetch(`${handle.proxyUrl}${SEND_V2}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
        body: JSON.stringify({ target: "#general", content: "reply" }),
      });
      assert.equal(res.status, 200, `${upstreamResponse.state}: the Server's reply is forwarded`);
      assert.equal((await res.json() as { state?: string }).state, upstreamResponse.state);
    });
  }
  // The read side keeps its typed failure (pinned by "proxy diagnostics class fixture post_response_local").
});

test("held context from another channel's thread still refuses to enter the ledger, but the reply is forwarded", async () => {
  const ledger = new AgentVisibleDeliveryLedger();
  const otherChannel = { ...heldThreadReply("held-4200", 4200), parent_channel_name: "general" };
  await sendThroughLedgerBackedProxy(ledger, { target: "#proj-raft-computer:46a146e8", content: "reply" }, {
    path: SEND_V2,
    upstreamResponse: { state: "held", heldMessages: [otherChannel] },
  });
  assert.equal(ledger.isModelSeen("agent-1", "#general:3ae9bd99", { seq: 4200, message_id: "held-4200" }), false, "parent/thread isolation holds");
  assert.equal(ledger.isModelSeen("agent-1", "#proj-raft-computer:46a146e8", { seq: 4200, message_id: "held-4200" }), false);
});

async function waitForSpan(sink: MemoryTraceSink, name: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (sink.getAllSpans().some((span) => span.name === name)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for span ${name}`);
}

async function withinMs<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("#47: a connect timeout records how many addresses Node tried and timed out, and whether an HTTP proxy was in the way, never the addresses", () => {
  const timedOut = (address: string) => Object.assign(new Error(`connect ETIMEDOUT ${address}:443`), { code: "ETIMEDOUT" });
  const unreachable = (address: string) => Object.assign(new Error(`connect ENETUNREACH ${address}:443`), { code: "ENETUNREACH" });
  // The shape undici 8 builds from Node's autoSelectFamily failure on api.raft.build
  // (4 A timing out, 8 AAAA failing at once): fetch failed → ConnectTimeoutError → AggregateError.
  const attempts = [
    timedOut("3.164.92.71"), unreachable("2600:9000:2843:1600:18:3109:5b40:93a1"),
    timedOut("3.164.92.102"), unreachable("2600:9000:2843:a600:18:3109:5b40:93a1"),
    timedOut("3.164.92.80"), unreachable("2600:9000:2843:dc00:18:3109:5b40:93a1"),
    timedOut("3.164.92.64"), unreachable("2600:9000:2843:1c00:18:3109:5b40:93a1"),
  ];
  const aggregate = Object.assign(new AggregateError(attempts), { code: "ETIMEDOUT" });
  const connectTimeout = Object.assign(
    new Error("Connect Timeout Error (attempted addresses: 3.164.92.71:443, 2600:9000:2843:1600:18:3109:5b40:93a1:443, timeout: 30000ms)", { cause: aggregate }),
    { code: "UND_ERR_CONNECT_TIMEOUT" },
  );
  const fetchFailed = new TypeError("fetch failed", { cause: connectTimeout });
  const target = new URL("https://api.raft.build/internal/agent-api/events");

  const proxyKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  try {
    const direct = __transportNormalizedErrorForErrorForTest(target, fetchFailed, "launch-1");
    assert.equal(direct.causeCode, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(direct.connectAttemptedAddresses, 8);
    assert.equal(direct.connectTimedOutAddresses, 4);
    assert.equal(direct.viaHttpProxy, false);
    assert.doesNotMatch(JSON.stringify({ ...direct, originalMessage: undefined }), /3\.164|2600:/, "only counts, never addresses");

    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    assert.equal(__transportNormalizedErrorForErrorForTest(target, fetchFailed, "launch-1").viaHttpProxy, true);
  } finally {
    for (const key of proxyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }

  // A transport error that is not a per-address connect failure carries no counts.
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  const plain = __transportNormalizedErrorForErrorForTest(target, reset, "launch-1");
  assert.equal(plain.connectAttemptedAddresses, undefined);
  assert.equal(plain.connectTimedOutAddresses, undefined);
});

// RFC 081, inbox items on: the Server lists the third-party events it marks
// with `inbox_item_target` as `app:` items, so the daemon's `inbox check`
// snapshot (whose grouped row the CLI prints as "N not in this list") leaves
// them out, as the wake-up notice does.
function inboxItemEvent(seq: number, inboxItemTarget?: unknown): AgentProxyVisibleMessage {
  return {
    seq,
    message_id: `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    channel_id: "third-party-agent-events:agent-items",
    channel_type: "dm",
    channel_name: "third-party-agent-events:agent-items",
    sender_type: "third_party_app",
    sender_name: "stamp",
    content: "Third-party notification: checks failed",
    third_party_event: {
      id: `ffffffff-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      kind: "notification",
      client_id: "stamp",
      client_name: "Stamp",
      ...(inboxItemTarget === undefined ? {} : { inbox_item_target: inboxItemTarget }),
    },
  } as unknown as AgentProxyVisibleMessage;
}

/** 5 events the Server lists (3 items), 1 it does not, 1 conversation message. */
const inboxItemsPending: AgentProxyVisibleMessage[] = [
  inboxItemEvent(201, "app:stamp/pr-1"),
  inboxItemEvent(202, "app:stamp/pr-1"),
  inboxItemEvent(203, "app:stamp/pr-1"),
  inboxItemEvent(204, "app:stamp/pr-2"),
  inboxItemEvent(205, "app:stamp"),
  inboxItemEvent(206),
  { seq: 100, id: "conv-100", channel_type: "channel", channel_name: "general", sender_type: "human", sender_name: "richard", content: "hi" },
];

async function localInboxCheck(inboxItems: (() => boolean) | undefined, pending: AgentProxyVisibleMessage[], between?: () => void) {
  const snapshots: Array<{ pendingMessageCount: number; rows: unknown[] }> = [];
  let text = "";
  const texts: string[] = [];
  await withUpstream((_req, res) => {
    res.writeHead(500);
    res.end();
  }, async (serverUrl) => {
    const launchId = `launch-inbox-items-${Math.random().toString(16).slice(2)}`;
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-items",
      launchId,
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "read",
      ...(inboxItems ? { inboxItems } : {}),
      inboxCoordinator: {
        getBoundary: () => undefined,
        getPendingMessages: () => [],
        getAllPendingMessages: () => pending,
        recordInboxSnapshot: (input) => snapshots.push(input as never),
        consumeVisibleMessages: () => assert.fail("inbox check consumes nothing"),
      },
    });
    try {
      for (const step of between ? [0, 1] : [0]) {
        if (step === 1) between!();
        const response = await fetch(`${handle.proxyUrl}/internal/agent-api/inbox`, { headers: { Authorization: `Bearer ${handle.proxyToken}` } });
        assert.equal(response.status, 200);
        texts.push(await response.text());
      }
      text = texts[0]!;
    } finally {
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-items", launchId });
    }
  });
  return { text, texts, body: JSON.parse(text) as { rows: Array<{ target: string; pendingCount: number }>; items: Array<{ source: string; row?: { target: string } }>; pending_targets: number; pending_messages: number }, snapshots };
}

const GROUPED = "dm:@third-party-agent-events:agent-items";

test("RFC 081: with inbox items on, the inbox check snapshot leaves out the events the Server lists as app items", async () => {
  const off = await localInboxCheck(undefined, inboxItemsPending);
  assert.deepEqual(off.body.rows.map((row) => [row.target, row.pendingCount]), [[GROUPED, 6], ["#general", 1]]);
  assert.equal(off.body.pending_messages, 7);
  // Off (getter false, or none): byte for byte the response without the getter.
  assert.equal((await localInboxCheck(() => false, inboxItemsPending)).text, off.text);

  const on = await localInboxCheck(() => true, inboxItemsPending);
  assert.deepEqual(on.body.rows.map((row) => [row.target, row.pendingCount]), [[GROUPED, 1], ["#general", 1]], "no app: rows; the grouped row counts the one unlisted event");
  assert.deepEqual(on.body.items.map((item) => [item.source, item.row?.target]), [["message_target", GROUPED], ["message_target", "#general"]]);
  assert.deepEqual([on.body.pending_targets, on.body.pending_messages], [2, 2]);
  assert.deepEqual(on.snapshots.map((snapshot) => snapshot.pendingMessageCount), [2]);
  // The conversation row is the same row either way.
  assert.deepEqual(on.body.rows[1], off.body.rows[1]);
  // The same batch's grouped count in the wake-up notice (same shared split).
  const wake = formatInboxUpdateRuntimeInput(inboxItemsPending as unknown as AgentMessage[], {} as never, inboxItemsPending.length, { inboxItems: true });
  const wakeGrouped = /^Third-party app events · (\d+) /m.exec(wake)?.[1];
  assert.equal(Number(wakeGrouped), on.body.rows.find((row) => row.target === GROUPED)?.pendingCount);

  // What `raft inbox check` prints with the Server listing the 3 app items.
  const appRow = (target: string, unread: number, objectRef?: string) => ({
    target, kind: objectRef ? "app" as const : "app_fallback" as const, ...(objectRef ? { objectRef } : {}), app: { key: "stamp", name: "Stamp" }, related: null,
    unread, latestSender: null, preview: null, previewTruncated: false, firstUnreadAt: null, latestAt: null, preLaunch: false,
  });
  const list = {
    view: "unread" as const, items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 },
    rows: [appRow("app:stamp/pr-1", 3, "pr-1"), appRow("app:stamp/pr-2", 1, "pr-2"), appRow("app:stamp", 1)],
  };
  const cli = (rows: unknown[]) => formatInboxCheck({ view: "unread", nowMs: 0, list: list as never, pendingRows: rows as never });
  assert.match(cli(off.body.rows), /^Third-party app events · 6 not in this list · /m, "before: the 5 listed events counted again");
  const after = cli(on.body.rows);
  assert.match(after, /^Third-party app events · 1 not in this list · /m);
  assert.match(after, /^app:stamp\/pr-1 · 3 unread · from Stamp$/m);
});

test("RFC 081: a flag turned off after launch gives the inbox check snapshot from before", async () => {
  let flag = true;
  const checks = await localInboxCheck(() => flag, inboxItemsPending, () => { flag = false; });
  assert.equal((JSON.parse(checks.texts[0]!) as { pending_messages: number }).pending_messages, 2);
  assert.equal(checks.texts[1], (await localInboxCheck(undefined, inboxItemsPending)).text, "the same launch, the flag read again");
});

test("RFC 081: with inbox items on, an invalid inbox_item_target stays in the grouped row", async () => {
  const invalid = ["", "app:", "app:stamp/", "#general", "app:stamp/pr 1", "app:stamp/pr\"x", 42, null].map((value, index) => inboxItemEvent(300 + index, value));
  const on = await localInboxCheck(() => true, invalid);
  assert.equal(on.text, (await localInboxCheck(undefined, invalid)).text);
  assert.deepEqual(on.body.rows.map((row) => [row.target, row.pendingCount]), [[GROUPED, invalid.length]]);
});

// #wg-ax:#17: reminders a daemon before reminder-server-ack@1 acked only locally.

type AppSourceAckRequest = { caps: string; client: string; body: Record<string, unknown> };

/** Answers `/app-sources/ack` with `answer(body)` (an exact acceptance by default) and records each request. */
function appSourceAckServer(
  requests: AppSourceAckRequest[],
  answer: (body: Record<string, unknown>) => { status: number; body: unknown } | null = () => null,
): http.RequestListener {
  return (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/internal/agent-api/app-sources/ack");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({
        caps: String(req.headers["x-raft-client-capabilities"] ?? ""),
        client: String(req.headers["x-raft-client"] ?? ""),
        body,
      });
      const answered = answer(body) ?? {
        status: 200,
        body: {
          ok: true,
          itemId: body.itemId,
          appId: body.appId,
          notificationClass: body.notificationClass,
          sourceRef: body.sourceRef,
          sourceEventId: "dddddddd-0000-4000-8000-000000000004",
          ackAttemptId: body.ackAttemptId,
          replayed: false,
        },
      };
      res.writeHead(answered.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answered.body));
    });
  };
}

/** A reminder fired and acked only in the store, as a daemon before the token did. */
function ackLocallyOnly(store: ReturnType<typeof createAgentAppInboxStore>, id: string, revision: string): void {
  const minted = store.mint({ appId: "system.reminder", notificationClass: "due", sourceRef: { kind: "reminder", id, revision } });
  assert.equal(minted.ok, true);
  assert.equal(store.ack(`reminder:${id}:${revision}`), true);
}

test("the server-ack backfill sends each locally-only acked reminder once, retries failures on the next start, and is done only when none is left", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "reminder-ack-backfill-"));
  const storage = createScopedAppStorageFactory({
    slockHome: dir,
    owner: { machineId: "machine-test", serverId: "server-test" },
  }).open({ appId: "system.agent-inbox", agentId: "agent-backfill" });
  const traces: Array<{ name: string; attrs: Record<string, unknown>; status?: string }> = [];
  const openStore = () => createAgentAppInboxStore({
    registry: REMINDER_AGENT_INBOX_REGISTRY,
    storage,
    ownerAgentId: "agent-backfill",
    beforeAck: () => true,
    beforeServerAuthorizedAck: () => true,
    trace: (name, attrs, status) => { traces.push({ name, attrs, ...(status ? { status } : {}) }); },
  });
  const transient = "aaaaaaaa-0000-4000-8000-00000000000a";
  const accepted = "bbbbbbbb-0000-4000-8000-00000000000b";
  const notFired = "cccccccc-0000-4000-8000-00000000000c";
  const alreadyOnServer = "eeeeeeee-0000-4000-8000-00000000000e";
  const requests: AppSourceAckRequest[] = [];
  let transientUp = false;
  const backfillTraces = () => traces.filter((trace) => trace.name === "daemon.app_inbox.server_ack_backfill");
  const sentIds = () => requests.map((request) => (request.body.sourceRef as { id: string }).id).sort();
  try {
    await withUpstream(appSourceAckServer(requests, (body) => {
      const id = (body.sourceRef as { id: string }).id;
      if (id === transient && !transientUp) return { status: 503, body: { error: "Service unavailable" } };
      if (id === notFired) return { status: 404, body: { error: "Source revision was not fired", code: "target_not_fired" } };
      return null;
    }), async (serverUrl) => {
      const first = openStore();
      ackLocallyOnly(first, transient, "1");
      ackLocallyOnly(first, accepted, "2");
      ackLocallyOnly(first, notFired, "3");
      // A reminder still live is the normal ack path's, not the backfill's.
      assert.equal(first.mint({ appId: "system.reminder", notificationClass: "due", sourceRef: { kind: "reminder", id: alreadyOnServer, revision: "1" } }).ok, true);
      assert.equal(first.serverAckBackfillDone(), null);

      const register = async (store: ReturnType<typeof createAgentAppInboxStore>, launchId: string) => {
        const handle = await registerAgentCredentialProxy({
          agentId: "agent-backfill",
          launchId,
          serverUrl,
          apiKey: "sk_agent_server_side",
          activeCapabilities: "read",
          appInbox: store,
        });
        await handle.serverAckBackfill;
        unregisterAgentCredentialProxyForLaunch({ agentId: "agent-backfill", launchId });
      };

      await register(first, "launch-backfill-1");
      assert.deepEqual(sentIds(), [transient, accepted, notFired].sort());
      for (const request of requests) {
        assert.equal(request.caps, REMINDER_SERVER_ACK_CAPABILITY);
        assert.equal(request.client, "daemon");
        assert.equal(request.body.appId, "system.reminder");
        assert.equal(request.body.notificationClass, "due");
      }
      assert.deepEqual(backfillTraces().map((trace) => [trace.attrs, trace.status]), [[{
        owner_agent_id: "agent-backfill", attempted: 3, accepted: 1, refused: 1, failed: 1, remaining: 1, done: false,
      }, "error"]]);
      assert.equal(first.serverAckBackfillDone(), null, "not done while one is left");

      // Next start: a fresh store from the same durable state sends only the one that failed.
      requests.length = 0;
      transientUp = true;
      const second = openStore();
      await register(second, "launch-backfill-2");
      assert.deepEqual(sentIds(), [transient]);
      assert.deepEqual(backfillTraces().at(-1)?.attrs, {
        owner_agent_id: "agent-backfill", attempted: 1, accepted: 1, refused: 0, failed: 0, remaining: 0, done: true,
      });

      // Done is durable: a later start sends nothing and traces nothing.
      requests.length = 0;
      const third = openStore();
      assert.equal(third.serverAckBackfillDone(), REMINDER_SERVER_ACK_CAPABILITY);
      await register(third, "launch-backfill-3");
      assert.deepEqual(requests, []);
      assert.equal(backfillTraces().length, 2);
      assert.deepEqual(
        third.listAcknowledgedSources().map((source) => [source.sourceRef.id, source.serverAck]).sort(),
        [[accepted, "accepted"], [notFired, "refused"], [transient, "accepted"]].sort(),
      );
      assert.equal(third.list().length, 1, "the live reminder is untouched");
    });
  } finally {
    await __resetAgentCredentialProxyForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// #proj-raft-computer:27e207f5 (Remy): an hourly reminder at revision 349
// left more local-only acks than one batch (100), and the rest stayed listed
// for several starts after the upgrade. One run now sends batch after batch
// until none is left. RED proof: stop after the first batch and 105 remain.
test("the server-ack backfill drains a backlog larger than one batch in a single start", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "reminder-ack-backfill-many-"));
  const storage = createScopedAppStorageFactory({
    slockHome: dir,
    owner: { machineId: "machine-test", serverId: "server-test" },
  }).open({ appId: "system.agent-inbox", agentId: "agent-backfill-many" });
  const traces: Array<{ name: string; attrs: Record<string, unknown>; status?: string }> = [];
  const store = createAgentAppInboxStore({
    registry: REMINDER_AGENT_INBOX_REGISTRY,
    storage,
    ownerAgentId: "agent-backfill-many",
    beforeAck: () => true,
    beforeServerAuthorizedAck: () => true,
    trace: (name, attrs, status) => { traces.push({ name, attrs, ...(status ? { status } : {}) }); },
  });
  const requests: AppSourceAckRequest[] = [];
  const reminderId = "ffffffff-0000-4000-8000-00000000000f";
  try {
    await withUpstream(appSourceAckServer(requests, () => null), async (serverUrl) => {
      for (let revision = 1; revision <= 205; revision += 1) ackLocallyOnly(store, reminderId, String(revision));
      const launchId = "launch-backfill-many";
      const handle = await registerAgentCredentialProxy({
        agentId: "agent-backfill-many",
        launchId,
        serverUrl,
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
        appInbox: store,
      });
      await handle.serverAckBackfill;
      unregisterAgentCredentialProxyForLaunch({ agentId: "agent-backfill-many", launchId });
      assert.equal(requests.length, 205, "every local-only ack is sent in this one start");
      assert.equal(store.serverAckBackfillDone(), REMINDER_SERVER_ACK_CAPABILITY);
      assert.deepEqual(traces.filter((trace) => trace.name === "daemon.app_inbox.server_ack_backfill").map((trace) => trace.attrs), [{
        owner_agent_id: "agent-backfill-many", attempted: 205, accepted: 205, refused: 0, failed: 0, remaining: 0, done: true,
      }]);
    });
  } finally {
    await __resetAgentCredentialProxyForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `raft reminder ack` (the CLI command, through the proxy) against `store` and the upstream. */
async function runReminderAckThroughProxy(
  serverUrl: string,
  store: ReturnType<typeof createAgentAppInboxStore>,
  options: { id: string; revision: string },
): Promise<{ stdout: string; error: unknown }> {
  // The backfill has its own test: here the store is past it.
  store.markServerAckBackfillDone(REMINDER_SERVER_ACK_CAPABILITY);
  const launchId = `launch-reminder-ack-${randomLaunchSuffix()}`;
  const handle = await registerAgentCredentialProxy({
    agentId: "agent-reminder-ack",
    launchId,
    serverUrl,
    apiKey: "sk_agent_server_side",
    activeCapabilities: "read",
    appInbox: store,
  });
  await handle.serverAckBackfill;
  const agentContext: AgentContext = {
    agentId: "agent-reminder-ack",
    serverId: "server-1",
    serverUrl: handle.proxyUrl,
    token: handle.proxyToken,
    clientMode: "managed-runner",
    secretSource: "agent-proxy-token-env",
    activeCapabilities: null,
  };
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: { stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } }, stderr: { write: () => true } },
    loadAgentContext: () => agentContext,
    createApiClient: () => new ApiClient(agentContext),
  });
  try {
    let error: unknown = null;
    await Promise.resolve(reminderAckCommand.handler(ctx, options)).catch((err: unknown) => { error = err; });
    return { stdout: stdout.join(""), error };
  } finally {
    unregisterAgentCredentialProxyForLaunch({ agentId: "agent-reminder-ack", launchId });
  }
}

let launchSuffix = 0;
function randomLaunchSuffix(): number {
  launchSuffix += 1;
  return launchSuffix;
}

test("raft reminder ack of a reminder acked only locally sends the Server the ack; its \"already acknowledged\" is a success", async () => {
  const reminderId = "aaaaaaaa-1111-4222-8333-444455556666";
  const requests: AppSourceAckRequest[] = [];
  await withUpstream(appSourceAckServer(requests, (body) => ({
    status: 200,
    body: {
      ok: true,
      itemId: body.itemId,
      appId: body.appId,
      notificationClass: body.notificationClass,
      sourceRef: body.sourceRef,
      sourceEventId: "dddddddd-0000-4000-8000-000000000004",
      ackAttemptId: body.ackAttemptId,
      replayed: true,
    },
  })), async (serverUrl) => {
    const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY, beforeAck: () => true, beforeServerAuthorizedAck: () => true });
    ackLocallyOnly(store, reminderId, "4");
    const { stdout, error } = await runReminderAckThroughProxy(serverUrl, store, { id: reminderId.slice(0, 8), revision: "4" });
    assert.equal(error, null);
    assert.equal(stdout, `Reminder ${reminderId} revision 4 was already acknowledged for this fired item.\n`);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body.sourceRef, { kind: "reminder", id: reminderId, revision: "4" });
    assert.equal(requests[0]!.body.itemId, `reminder:${reminderId}:4`);
    assert.ok(requests[0]!.caps.split(",").includes(REMINDER_SERVER_ACK_CAPABILITY), requests[0]!.caps);
    assert.deepEqual(store.listAcknowledgedSources().map((source) => source.serverAck), ["accepted"]);
  });
  await __resetAgentCredentialProxyForTest();
});

test("raft reminder ack with an empty local store acks the full reminder id on the Server; a refusal keeps the refusal text", async () => {
  const reminderId = "bbbbbbbb-1111-4222-8333-444455556666";
  const requests: AppSourceAckRequest[] = [];
  let refuse = false;
  await withUpstream(appSourceAckServer(requests, () => refuse
    ? { status: 404, body: { error: "Source revision was not fired", code: "target_not_fired" } }
    : null), async (serverUrl) => {
    const emptyStore = () => createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY, beforeAck: () => true, beforeServerAuthorizedAck: () => true });

    const acked = await runReminderAckThroughProxy(serverUrl, emptyStore(), { id: reminderId, revision: "2" });
    assert.equal(acked.error, null);
    assert.equal(acked.stdout, `Reminder ${reminderId} revision 2 fired item acknowledged.\n`);
    assert.deepEqual(requests.map((request) => [request.body.itemId, request.body.sourceRef]), [
      [`reminder:${reminderId}:2`, { kind: "reminder", id: reminderId, revision: "2" }],
    ]);

    refuse = true;
    const refused = await runReminderAckThroughProxy(serverUrl, emptyStore(), { id: reminderId, revision: "3" });
    assert.ok(refused.error instanceof CliError, String(refused.error));
    assert.equal(formatErrorEnvelope(refused.error), [
      `Error: The Server refused the ack (Source revision was not fired); reminder ${reminderId} revision 3 is still not acknowledged.`,
      "Code: ACK_FAILED",
      "Next action: Nothing was acknowledged. raft inbox check lists this reminder's current ack: lines; ack those.",
    ].join("\n") + "\n");

    // A short id nothing local matches is not guessed: the CLI asks for the full id and posts nothing.
    const before = requests.length;
    const short = await runReminderAckThroughProxy(serverUrl, emptyStore(), { id: reminderId.slice(0, 8), revision: "2" });
    assert.ok(short.error instanceof CliError, String(short.error));
    assert.equal(formatErrorEnvelope(short.error), [
      "Error: No reminder Inbox item on this Computer matches bbbbbbbb revision 2, so the short id cannot be resolved",
      "Code: ACK_FAILED",
      "Next action: Run the ack with the full reminder id from its ack: line in raft inbox check.",
    ].join("\n") + "\n");
    assert.equal(requests.length, before);
  });
  await __resetAgentCredentialProxyForTest();
});
