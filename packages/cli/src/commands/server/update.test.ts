import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApiClient, type ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  formatServerUpdateResult,
  serverUpdateCommand,
} from "./update.js";

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

test("server update output reports updated server name", () => {
  assert.equal(
    formatServerUpdateResult({ id: "server-1", name: "Runtime" }),
    "Updated server Runtime.",
  );
});

test("server update command patches normalized name", async () => {
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
          data: { id: "server-1", name: "Runtime" },
        };
      },
    }) as any,
  });

  await serverUpdateCommand.handler(ctx, {
    name: " Runtime ",
  });

  assert.deepEqual(requests, [
    {
      method: "PATCH",
      path: "/internal/agent-api/server",
      body: { name: "Runtime" },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "Updated server Runtime.\n");
});

test("server update command requires at least one update", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await serverUpdateCommand.handler(ctx, {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
});

test("server update avatar multipart direct route preserves proxy diagnostics centrally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "server-update-avatar-"));
  const avatarFile = join(dir, "avatar.png");
  writeFileSync(avatarFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const original = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; hasBody: boolean }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, hasBody: init?.body !== undefined });
    return new Response(JSON.stringify({
      error: "failed to proxy local agent request",
      code: "agent_proxy_failed",
      proxy: {
        layer: "local_daemon_proxy",
        correlation_id: "fedcba9876543210",
        route_family: "server",
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
      async () => { await serverUpdateCommand.handler(ctx, { avatarFile }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "PROXY_5XX");
        assert.equal(err.layer, "local_daemon_proxy");
        assert.equal(err.correlationId, "fedcba9876543210");
        assert.equal(err.proxyFailureClass, "upstream_http_response");
        assert.equal(err.proxyCauseCode, "HTTP_502");
        assert.equal(err.proxyRouteFamily, "server");
        assert.equal(err.proxyUpstreamLayer, "http_status");
        assert.equal(err.proxyUpstreamStatus, 502);
        assert.equal(err.proxyResponseStarted, true);
        assert.equal(err.proxyResponseComplete, true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).pathname, "/internal/agent-api/server/avatar");
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.hasBody, true);
});
