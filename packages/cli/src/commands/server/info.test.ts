import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { serverInfoCommand } from "./info.js";

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

test("server info command uses injected ApiClient and env workspace fallback", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    env: { SLOCK_CURRENT_WORKSPACE_PATH: "/workspace/from-env" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            runtimeContext: {
              agentId: "agent-1",
              serverId: "server-1",
            },
            channels: [{ id: "channel-1", name: "engineering", joined: true, type: "public", activityMuted: true }],
            agents: [{ name: "HaoHao", status: "active" }],
            humans: [{ name: "xxchan" }],
          },
        };
      },
    }) as any,
  });

  await serverInfoCommand.handler(ctx, { full: true });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /## Server/);
  assert.match(output, /- Workspace: \/workspace\/from-env/);
  assert.match(output, /#engineering \[public, joined, muted\]/);
});

test("server info command defaults to bounded summary and preserves full dump behind --full", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          runtimeContext: {
            agentId: "agent-1",
            serverId: "server-1",
          },
          channels: [{ id: "channel-1", name: "engineering", joined: true, type: "public" }],
          agents: [{ name: "HaoHao", status: "active" }],
          humans: [{ name: "xxchan" }],
        },
      }),
    }) as any,
  });

  await serverInfoCommand.handler(ctx, {});

  const output = stdout.join("");
  assert.match(output, /Channels: 1 visible \(1 joined\)/);
  assert.match(output, /Full dump: raft server info --full/);
  assert.doesNotMatch(output, /### Channels/);
});

test("server info --channels filters joined rows and prints paging command", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          runtimeContext: {
            agentId: "agent-1",
            serverId: "server-1",
          },
          channels: [
            { id: "c1", name: "alpha", joined: true, type: "public", activityMuted: true, description: "Alpha work" },
            { id: "c2", name: "beta", joined: true, type: "private", activityMuted: false },
            { id: "c3", name: "gamma", joined: false, type: "public" },
          ],
          agents: [],
          humans: [],
        },
      }),
    }) as any,
  });

  await serverInfoCommand.handler(ctx, { channels: true, joined: true, limit: "1" });

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /## Server Channels/);
  assert.match(output, /#alpha \[public, joined, muted\] — Alpha work/);
  assert.doesNotMatch(output, /#beta/);
  assert.match(output, /Showing 1-1 of 2/);
  assert.match(output, /More: raft server info --channels --offset 1 --limit 1 --joined/);
});

test("server info rejects --full combined with section filters before auth bootstrap", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not bootstrap auth");
    },
  });

  await assert.rejects(
    async () => { await serverInfoCommand.handler(ctx, { full: true, channels: true }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--full cannot be combined with --channels, --agents, or --humans");
      return true;
    },
  );
});

test("server info rejects list modifiers without a selected list section before auth bootstrap", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not bootstrap auth");
    },
  });

  for (const opts of [
    { joined: true },
    { query: "ops" },
    { limit: "10" },
    { offset: "10" },
    { full: true, joined: true },
  ]) {
    await assert.rejects(
      async () => { await serverInfoCommand.handler(ctx, opts); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_ARG");
        assert.equal(err.message, "--query, --limit, --offset, and --joined require --channels, --agents, or --humans");
        return true;
      },
    );
  }
});

test("server info command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        data: null,
        error: "upstream unavailable",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await serverInfoCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SERVER_5XX");
      assert.equal(err.message, "upstream unavailable");
      return true;
    },
  );
});

test("server info command preserves shared proxy diagnostics from the central Agent API seam", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 502,
        data: null,
        error: "failed to proxy local agent request",
        errorCode: "agent_proxy_failed",
        proxy: {
          layer: "local_daemon_proxy",
          correlationId: "0123456789abcdef",
          failureClass: "pre_response_transport",
          causeCode: "UPSTREAM_TRANSPORT_FAILURE",
          routeFamily: "server",
          upstreamLayer: "tcp",
          upstreamStatus: 502,
          responseStarted: false,
          responseComplete: false,
        },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await serverInfoCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "PROXY_5XX");
      assert.equal(err.message, "failed to proxy local agent request");
      assert.equal(err.layer, "local_daemon_proxy");
      assert.equal(err.correlationId, "0123456789abcdef");
      assert.equal(err.proxyFailureClass, "pre_response_transport");
      assert.equal(err.proxyCauseCode, "UPSTREAM_TRANSPORT_FAILURE");
      assert.equal(err.proxyRouteFamily, "server");
      assert.equal(err.proxyUpstreamLayer, "tcp");
      assert.equal(err.proxyUpstreamStatus, 502);
      assert.equal(err.proxyResponseStarted, false);
      assert.equal(err.proxyResponseComplete, false);
      return true;
    },
  );
});
