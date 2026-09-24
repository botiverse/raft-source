import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { AgentContext } from "./auth/env.js";
import { MANUAL_CONTEXT_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";
import { ApiClient } from "./client.js";
import { CliError } from "./core/errors.js";
import {
  __setCliTransportTraceSinkForTest,
  routeFamilyForPath,
  upstreamLayerForFetchError,
  type CliTransportNormalizedErrorAttrs,
} from "./transportTrace.js";

const ctx: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://localhost:9999",
  serverId: "server-1",
  token: "token-1",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("ApiClient marks requests as slock CLI traffic", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("POST", "/internal/agent-api/send", { content: "hi" });
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].headers);
  assert.equal(headers.get("X-Raft-Client"), "cli");
  assert.equal(headers.get(RAFT_CLIENT_CAPABILITIES_HEADER), MANUAL_CONTEXT_CAPABILITY);
  assert.equal(headers.get("X-Agent-Id"), "agent-1");
  assert.equal(headers.get("X-Server-Id"), "server-1");
});

test("ApiClient rewrites supported legacy paths when using sk_agent credential", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(JSON.stringify({ state: "sent", messageId: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_1",
    });
    const response = await client.request("POST", "/internal/agent/agent-1/send", { target: "#general", content: "hi" });
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(inputs.length, 1);
  assert.equal(new URL(inputs[0]).pathname, "/internal/agent-api/send");
});

test("ApiClient sends explicit agent-api paths through the local agent proxy without rewriting", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(JSON.stringify({ state: "sent", messageId: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      token: "sap_1",
    });
    const response = await client.request("POST", "/internal/agent-api/send", { target: "#general", content: "hi" });
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(inputs.length, 1);
  const url = new URL(inputs[0]);
  assert.equal(url.origin, "http://127.0.0.1:45678");
  assert.equal(url.pathname, "/internal/agent-api/send");
});

test("ApiClient exposes a binary request helper without choosing attachment routes", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_1",
    });
    const response = await client.requestBinary("GET", "/internal/agent-api/attachments/attachment-1");
    assert.equal(response.ok, true);
    assert.deepEqual([...response.body], [1, 2, 3]);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(inputs.length, 1);
  assert.equal(new URL(inputs[0]).pathname, "/internal/agent-api/attachments/attachment-1");
});

test("ApiClient follows one HTTPS attachment redirect without forwarding Raft credentials", async () => {
  const original = globalThis.fetch;
  const signedUrl = "https://objects.example.test/private/file?X-Amz-Signature=do-not-leak";
  const objectBytes = new Uint8Array([9, 8, 7, 6]);
  const calls: Array<{ input: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init: init ?? {} });
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: signedUrl },
      });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(objectBytes.slice(0, 2));
        controller.enqueue(objectBytes.slice(2));
        controller.close();
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_direct_download",
      activeCapabilities: ["read"],
    });
    const response = await client.requestBinary("GET", "/internal/agent-api/attachments/attachment-1");
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.body.byteLength, objectBytes.byteLength);
    assert.equal(
      createHash("sha256").update(response.body).digest("hex"),
      createHash("sha256").update(objectBytes).digest("hex"),
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!.input).pathname, "/internal/agent-api/attachments/attachment-1");
  assert.equal(calls[0]!.init.redirect, "manual");
  const firstHeaders = new Headers(calls[0]!.init.headers);
  assert.equal(firstHeaders.get("authorization"), "Bearer sk_agent_direct_download");
  assert.equal(firstHeaders.get("x-agent-id"), "agent-1");
  assert.equal(firstHeaders.get("x-server-id"), "server-1");
  assert.equal(firstHeaders.get("x-slock-agent-active-capabilities"), "read");

  assert.equal(calls[1]!.input, signedUrl);
  assert.equal(calls[1]!.init.redirect, "error");
  assert.equal(calls[1]!.init.credentials, "omit");
  const objectHeaders = new Headers(calls[1]!.init.headers);
  for (const credentialHeader of [
    "authorization",
    "cookie",
    "x-agent-id",
    "x-server-id",
    "x-raft-client",
    "x-slock-agent-active-capabilities",
  ]) {
    assert.equal(objectHeaders.has(credentialHeader), false, `${credentialHeader} must not reach object storage`);
  }
});

test("ApiClient fails closed on expired or unapproved attachment redirects without exposing the signed URL", async () => {
  const original = globalThis.fetch;
  const signedUrl = "https://objects.example.test/private/file?X-Amz-Signature=expired-secret";
  let mode: "expired" | "same-origin" = "expired";
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (calls.length === 1 || (mode === "same-origin" && calls.length === 3)) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: mode === "expired"
            ? signedUrl
            : "http://localhost:9999/internal/agent-api/attachments/other",
        },
      });
    }
    return new Response("<Error><Code>ExpiredToken</Code></Error>", { status: 403 });
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const expired = await client.requestBinary("GET", "/internal/agent-api/attachments/attachment-1");
    assert.equal(expired.ok, false);
    assert.equal(expired.status, 403);
    assert.equal(expired.error, "HTTP 403");
    assert.doesNotMatch(expired.error ?? "", /objects\.example|X-Amz|expired-secret/);

    mode = "same-origin";
    const unsafe = await client.requestBinary("GET", "/internal/agent-api/attachments/attachment-2");
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.status, 502);
    assert.match(unsafe.error ?? "", /redirect target was rejected/i);
    assert.doesNotMatch(unsafe.error ?? "", /internal\/agent-api|attachment-2/);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 3, "the rejected same-origin redirect must not receive a second request");
});

test("ApiClient scrubs a signed object URL from attachment transport traces and errors", async () => {
  const original = globalThis.fetch;
  const signedUrl = "https://objects.example.test/private/file?X-Amz-Signature=trace-secret";
  const traces: CliTransportNormalizedErrorAttrs[] = [];
  let calls = 0;
  __setCliTransportTraceSinkForTest((_name, attrs) => traces.push(attrs));
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, { status: 302, headers: { Location: signedUrl } });
    }
    throw new Error(`GET ${signedUrl} failed`);
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    await assert.rejects(
      () => client.requestBinary("GET", "/internal/agent-api/attachments/attachment-1"),
      (err: unknown) => {
        assert.doesNotMatch(err instanceof Error ? err.message : String(err), /objects\.example|X-Amz|trace-secret/);
        return true;
      },
    );
  } finally {
    __setCliTransportTraceSinkForTest(null);
    globalThis.fetch = original;
  }

  assert.equal(traces.length, 1);
  assert.equal(traces[0]!.route_family, "agent-api/attachments");
  assert.equal(traces[0]!.original_message, "GET [url] failed");
  assert.doesNotMatch(JSON.stringify(traces), /objects\.example|X-Amz|trace-secret/);
});

test("ApiClient rewrites server info and channel membership paths for sk_agent credential", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_1",
    });
    await client.request("GET", "/internal/agent/agent-1/server");
    await client.request("PATCH", "/internal/agent/agent-1/server", { name: "Runtime" });
    await client.requestMultipart("POST", "/internal/agent/agent-1/server/avatar", new FormData());
    await client.request("POST", "/internal/agent/agent-1/channels/channel-1/join");
    await client.request("POST", "/internal/agent/agent-1/channels/channel-1/leave");
    await client.request("POST", "/internal/agent/agent-1/channels/channel-1/mute");
    await client.request("POST", "/internal/agent/agent-1/channels/channel-1/unmute");
    await client.request("PATCH", "/internal/agent/agent-1/channels/channel-1", { name: "runtime" });
    await client.request("POST", "/internal/agent/agent-1/channels/channel-1/members", { user: "alice" });
    await client.request("DELETE", "/internal/agent/agent-1/channels/channel-1/members", { user: "alice" });
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(inputs.map((input) => new URL(input).pathname), [
    "/internal/agent-api/server",
    "/internal/agent-api/server",
    "/internal/agent-api/server/avatar",
    "/internal/agent-api/channels/channel-1/join",
    "/internal/agent-api/channels/channel-1/leave",
    "/internal/agent-api/channels/channel-1/mute",
    "/internal/agent-api/channels/channel-1/unmute",
    "/internal/agent-api/channels/channel-1",
    "/internal/agent-api/channels/channel-1/members",
    "/internal/agent-api/channels/channel-1/members",
  ]);
});

test("ApiClient rewrites mention action paths for sk_agent credential", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_1",
    });
    await client.request("GET", "/internal/agent/agent-1/mention-actions/pending");
    await client.request("POST", "/internal/agent/agent-1/mention-actions/execute", { action: "notify", resolutionIds: ["r-1"] });
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(inputs.map((input) => new URL(input).pathname), [
    "/internal/agent-api/mention-actions/pending",
    "/internal/agent-api/mention-actions/execute",
  ]);
});

test("ApiClient maps agent-api events response to legacy message check shape", async () => {
  const original = globalThis.fetch;
  const inputs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(String(input));
    return new Response(JSON.stringify({ events: [{ seq: 1, content: "hello" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_1",
    });
    const response = await client.request<{ messages?: unknown[] }>("GET", "/internal/agent/agent-1/receive");
    assert.equal(response.ok, true);
    assert.deepEqual(response.data?.messages, [{ seq: 1, content: "hello" }]);
  } finally {
    globalThis.fetch = original;
  }

  const url = new URL(inputs[0]);
  assert.equal(url.pathname, "/internal/agent-api/events");
  assert.equal(url.searchParams.get("since"), "latest");
});

test("ApiClient rewrites 403 scope deny with current human remediation", async () => {
  // Server middleware shape: { error, requiredScope, reason }. The CLI
  // surfaces the raw `error` everywhere via `fail(code, res.error ...)`,
  // so the agent only sees "missing required scope" without a rewrite.
  // The client must transform this into a self-explanatory message that
  // names the missing capability and an available human remediation path.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        error: "missing required scope",
        requiredScope: "message:send",
        reason: "missing_scope",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("POST", "/internal/agent-api/send", { content: "hi" });
    assert.equal(response.ok, false);
    assert.equal(response.status, 403);
    assert.equal(response.errorCode, "SCOPE_DENIED");
    assert.match(response.error ?? "", /Permission denied/);
    assert.match(response.error ?? "", /message:send/);
    assert.match(response.error ?? "", /human/i);
    assert.match(response.error ?? "", /authorized human/);
    assert.match(response.error ?? "", /scope grant through the API/);
    assert.doesNotMatch(response.error ?? "", /Permissions tab|toggle/);
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient leaves non-scope 403s untouched", async () => {
  // Other 403 paths (e.g. requireServer, channel membership) don't include
  // `requiredScope`. They should pass through as-is — only scope denies get
  // the rewrite treatment.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: "Not a member of this channel" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("POST", "/internal/agent-api/send", { content: "hi" });
    assert.equal(response.ok, false);
    assert.equal(response.status, 403);
    assert.equal(response.errorCode, null);
    assert.equal(response.error, "Not a member of this channel");
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient preserves server code and suggested next action from error bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "knowledge_not_found",
        error: "Manual topic not found. Run `raft manual get index --intent \"Learn available Raft workflows\" --reason \"Need the topic catalog after a missing Manual topic\"`.",
        suggested_next_action: "Run `raft manual get index --intent \"Learn available Raft workflows\" --reason \"Need the topic catalog after a missing Manual topic\"` to see all available topics.",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("GET", "/internal/agent-api/knowledge?topic=missing");
    assert.equal(response.ok, false);
    assert.equal(response.status, 404);
    assert.equal(response.errorCode, "knowledge_not_found");
    assert.match(response.error ?? "", /manual get index --intent/);
    assert.match(response.suggestedNextAction ?? "", /--reason/);
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient surfaces invalid JSON responses instead of returning null data", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("GET", "/internal/agent-api/server");
    assert.equal(response.ok, false);
    assert.equal(response.status, 200);
    assert.equal(response.errorCode, "INVALID_JSON_RESPONSE");
    assert.match(response.error ?? "", /Invalid JSON response/);
    assert.equal(response.data, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient traces HTTP 5xx before command-level SERVER_5XX normalization", async () => {
  const original = globalThis.fetch;
  const events: Array<{ name: string; attrs: CliTransportNormalizedErrorAttrs }> = [];
  __setCliTransportTraceSinkForTest((name, attrs) => events.push({ name, attrs }));
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "upstream failed" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    const response = await client.request("POST", "/internal/agent-api/tasks/claim?message_id=msg-private", {});
    assert.equal(response.ok, false);
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = original;
    __setCliTransportTraceSinkForTest(null);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].name, "cli.transport.normalized_error");
  assert.deepEqual(events[0].attrs, {
    producer: "cli",
    normalized_code: "server_5xx",
    route_family: "tasks/claim",
    response_started: true,
    upstream_layer: "http_status",
    upstream_status: 503,
    serverId: "server-1",
    agentId: "agent-1",
    target_host_class: "local_daemon",
  });
});

test("CLI transport traces keep bare ETIMEDOUT distinct from explicit read timeouts", () => {
  const upstreamUrl = new URL("https://api.raft.build/internal/agent-api/tasks");
  const bareTimeout = Object.assign(new Error("request timeout while waiting for upstream"), { code: "ETIMEDOUT" });
  assert.equal(upstreamLayerForFetchError(upstreamUrl, bareTimeout), "unknown");

  const headersTimeout = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  assert.equal(upstreamLayerForFetchError(upstreamUrl, headersTimeout), "read_timeout");

  const bodyTimeout = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" });
  assert.equal(upstreamLayerForFetchError(upstreamUrl, bodyTimeout), "read_timeout");
});

test("ApiClient centrally raises local daemon proxy diagnostics from 5xx envelopes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      error: "failed to proxy local agent request",
      code: "agent_proxy_failed",
      detail: "fetch failed",
      proxy: {
        layer: "local_daemon_proxy",
        correlation_id: "0123456789abcdef",
        route_family: "tasks/claim",
        failure_class: "pre_response_transport",
        cause_code: "UND_ERR_CONNECT_TIMEOUT",
        upstream_layer: "tcp",
        response_started: false,
        response_complete: false,
        target_host_class: "api.raft.build",
        launch_id: "launch-1",
        downstream_caller: "cli",
        upstream: "server",
      },
    }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient(ctx);
    await assert.rejects(
      () => client.request("POST", "/internal/agent-api/tasks/claim", {}),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "PROXY_5XX");
        assert.equal(err.message, "failed to proxy local agent request");
        assert.equal(err.layer, "local_daemon_proxy");
        assert.equal(err.correlationId, "0123456789abcdef");
        assert.equal(err.proxyRouteFamily, "tasks/claim");
        assert.equal(err.proxyFailureClass, "pre_response_transport");
        assert.equal(err.proxyCauseCode, "UND_ERR_CONNECT_TIMEOUT");
        assert.equal(err.proxyUpstreamLayer, "tcp");
        assert.equal(err.proxyResponseStarted, false);
        assert.equal(err.proxyResponseComplete, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient centrally raises marked streaming body failures as mid-response proxy diagnostics", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"events\":"));
        controller.error(new Error("socket closed after headers"));
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-raft-correlation-id": "fedcba9876543210",
        "x-raft-proxy-stream-carrier": "1",
        "x-raft-proxy-route-family": "agent-api/events",
        "x-raft-proxy-target-host-class": "api.raft.build",
        "x-raft-proxy-launch-id": "launch-stream-carrier",
      },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      token: "sap_1",
    });
    await assert.rejects(
      () => client.request("GET", "/internal/agent-api/history?channel=%23private"),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "PROXY_5XX");
        assert.equal(err.layer, "local_daemon_proxy");
        assert.equal(err.correlationId, "fedcba9876543210");
        assert.equal(err.proxyFailureClass, "mid_response_transport");
        assert.equal(err.proxyCauseCode, "RESPONSE_BODY_STREAM_FAILED");
        assert.equal(err.proxyRouteFamily, "agent-api/events");
        assert.equal(err.proxyUpstreamLayer, "body_stream");
        assert.equal(err.proxyResponseStarted, true);
        assert.equal(err.proxyResponseComplete, false);
        assert.doesNotMatch(JSON.stringify(err), /private|socket closed|127\.0\.0\.1/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient keeps complete malformed marked JSON as INVALID_JSON_RESPONSE", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("{ malformed json", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-raft-correlation-id": "fedcba9876543210",
        "x-raft-proxy-stream-carrier": "1",
        "x-raft-proxy-route-family": "agent-api/events",
      },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      token: "sap_1",
    });
    const response = await client.request("GET", "/internal/agent-api/history?channel=%23private");
    assert.equal(response.ok, false);
    assert.equal(response.status, 200);
    assert.equal(response.errorCode, "INVALID_JSON_RESPONSE");
    assert.equal(response.proxy, undefined);
    assert.match(response.error ?? "", /Invalid JSON response/);
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient preserves successful marked binary streams", async () => {
  const original = globalThis.fetch;
  const bytes = new Uint8Array([4, 5, 6]);
  globalThis.fetch = (async () => {
    return new Response(bytes, {
      status: 200,
      headers: {
        "x-raft-correlation-id": "fedcba9876543210",
        "x-raft-proxy-stream-carrier": "1",
        "x-raft-proxy-route-family": "agent-api/attachments",
      },
    });
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      token: "sap_1",
    });
    const response = await client.requestBinary("GET", "/internal/agent-api/attachments/attachment-1");
    assert.equal(response.ok, true);
    assert.equal(response.errorCode, undefined);
    assert.equal(response.proxy, undefined);
    assert.deepEqual([...response.body], [...bytes]);
  } finally {
    globalThis.fetch = original;
  }
});

test("ApiClient traces local daemon loopback failures without leaking raw URL", async () => {
  const original = globalThis.fetch;
  const events: Array<{ name: string; attrs: CliTransportNormalizedErrorAttrs }> = [];
  __setCliTransportTraceSinkForTest((name, attrs) => events.push({ name, attrs }));
  globalThis.fetch = (async () => {
    throw new Error("fetch failed for http://127.0.0.1:45678/internal/agent-api/send?target=dm:@alice sk_agent_secret");
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-file",
      token: "sap_1",
    });
    await assert.rejects(() => client.request("POST", "/internal/agent-api/send", { content: "hi" }));
  } finally {
    globalThis.fetch = original;
    __setCliTransportTraceSinkForTest(null);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].attrs.normalized_code, "transport_failure");
  assert.equal(events[0].attrs.producer, "cli");
  assert.equal(events[0].attrs.route_family, "agent-api/send");
  assert.equal(events[0].attrs.response_started, false);
  assert.equal(events[0].attrs.upstream_layer, "local_daemon_loopback");
  assert.equal(events[0].attrs.target_host_class, "local_daemon");
  assert.match(events[0].attrs.original_message ?? "", /\[url\]/);
  assert.doesNotMatch(events[0].attrs.original_message ?? "", /127\.0\.0\.1|target=|sk_agent_secret/);
});

test("ApiClient classifies api.slock.ai proxy connect failures as transport failures", async () => {
  const original = globalThis.fetch;
  const events: Array<{ name: string; attrs: CliTransportNormalizedErrorAttrs }> = [];
  __setCliTransportTraceSinkForTest((name, attrs) => events.push({ name, attrs }));
  globalThis.fetch = (async () => {
    throw new Error("proxy CONNECT failed before upstream response");
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "https://api.slock.ai",
    });
    await assert.rejects(() => client.request("POST", "/internal/agent-api/send", { content: "hi" }));
  } finally {
    globalThis.fetch = original;
    __setCliTransportTraceSinkForTest(null);
  }

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].attrs, {
    producer: "cli",
    normalized_code: "transport_failure",
    route_family: "agent-api/send",
    response_started: false,
    upstream_layer: "proxy_connect",
    original_message: "proxy CONNECT failed before upstream response",
    serverId: "server-1",
    agentId: "agent-1",
    target_host_class: "api.slock.ai",
  });
});

test("ApiClient classifies api.raft.build as the Raft API host", async () => {
  const original = globalThis.fetch;
  const events: Array<{ name: string; attrs: CliTransportNormalizedErrorAttrs }> = [];
  __setCliTransportTraceSinkForTest((name, attrs) => events.push({ name, attrs }));
  globalThis.fetch = (async () => {
    throw new Error("proxy CONNECT failed before upstream response");
  }) as typeof fetch;

  try {
    const client = new ApiClient({
      ...ctx,
      serverUrl: "https://api.raft.build",
    });
    await assert.rejects(() => client.request("POST", "/internal/agent-api/send", { content: "hi" }));
  } finally {
    globalThis.fetch = original;
    __setCliTransportTraceSinkForTest(null);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].attrs.target_host_class, "api.raft.build");
  assert.equal(events[0].attrs.route_family, "agent-api/send");
  assert.equal(events[0].attrs.upstream_layer, "proxy_connect");
});

test("transport route family classifier returns only closed route families", () => {
  assert.equal(routeFamilyForPath("/internal/agent-api/tasks/claim?message_id=msg-private"), "tasks/claim");
  assert.equal(routeFamilyForPath("/api/attachments/attachment-secret"), "attachments/download");
  assert.equal(routeFamilyForPath("/internal/agent-api/unclassified/sk_agent_secret?target=dm:@alice"), "unknown");
});
