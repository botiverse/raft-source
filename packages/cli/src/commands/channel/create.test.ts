import assert from "node:assert/strict";
import test from "node:test";

import { ApiClient, type ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelCreateCommand,
  formatCreateChannelResult,
} from "./create.js";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("create channel output reports created channel visibility", () => {
  assert.equal(
    formatCreateChannelResult({ id: "channel-1", name: "engineering", type: "channel" }),
    "Created #engineering (public). You are joined and can send messages there.",
  );
  assert.equal(
    formatCreateChannelResult({ id: "channel-1", name: "secret", type: "private" }),
    "Created #secret (private). You are joined and can send messages there.",
  );
});

test("create channel command posts normalized channel payload", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { id: "channel-1", name: "engineering", type: "private" },
        };
      },
    }) as any,
  });

  await channelCreateCommand.handler(ctx, {
    name: "#engineering",
    description: "Build work",
    private: true,
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent/agent-1/channels",
      body: {
        name: "engineering",
        description: "Build work",
        visibility: "private",
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "Created #engineering (private). You are joined and can send messages there.\n");
});

test("create channel command maps missing name into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelCreateCommand.handler(ctx, {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
});

test("create channel direct Agent API request preserves proxy diagnostics centrally", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({
      error: "failed to proxy local agent request",
      code: "agent_proxy_failed",
      proxy: {
        layer: "local_daemon_proxy",
        correlation_id: "0123456789abcdef",
        route_family: "channels",
        failure_class: "upstream_http_response",
        cause_code: "HTTP_502",
        upstream_layer: "http_status",
        upstream_status: 502,
        response_started: true,
        response_complete: true,
      },
    }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      serverUrl: "http://127.0.0.1:45678",
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
      token: "sap_1",
    }),
    createApiClient: (context) => new ApiClient(context),
  });

  try {
    await assert.rejects(
      async () => { await channelCreateCommand.handler(ctx, { name: "ops" }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "PROXY_5XX");
        assert.equal(err.layer, "local_daemon_proxy");
        assert.equal(err.correlationId, "0123456789abcdef");
        assert.equal(err.proxyFailureClass, "upstream_http_response");
        assert.equal(err.proxyCauseCode, "HTTP_502");
        assert.equal(err.proxyRouteFamily, "channels");
        assert.equal(err.proxyUpstreamLayer, "http_status");
        assert.equal(err.proxyUpstreamStatus, 502);
        assert.equal(err.proxyResponseStarted, true);
        assert.equal(err.proxyResponseComplete, true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).pathname, "/internal/agent-api/channels");
  assert.equal(requests[0]!.method, "POST");
});
