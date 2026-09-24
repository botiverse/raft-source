import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelJoinCommand,
  formatAlreadyJoined,
  formatJoinChannelResult,
} from "./join.js";

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

test("join channel output explains post-join delivery", () => {
  assert.equal(
    formatJoinChannelResult("#engineering"),
    [
      "Joined #engineering. You can now send messages there and receive ordinary channel delivery.",
      "Still arrives:",
      "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
      "- Threads you started or follow stay followed even if you later mute this channel.",
    ].join("\n"),
  );
  assert.equal(formatAlreadyJoined("#engineering"), "Already joined #engineering.");
});

test("join channel command uses injected ApiClient and writes join result", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (method === "GET") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              runtimeContext: { agentId: "agent-1", serverId: "server-1" },
              channels: [{ id: "channel-1", name: "engineering", joined: false }],
              agents: [],
              humans: [],
            },
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        };
      },
    }) as any,
  });

  await channelJoinCommand.handler(ctx, { target: "#engineering" });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "POST", path: "/internal/agent-api/channels/channel-1/join" },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), `${formatJoinChannelResult("#engineering")}\n`);
});

test("join channel command maps invalid target into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelJoinCommand.handler(ctx, { target: "engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});

test("join channel command preserves already-joined and not-found semantics from the SDK", async () => {
  const joinedIo = memoryIo();
  const joinedCtx = createCommandContext({
    io: joinedIo.io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          runtimeContext: { agentId: "agent-1", serverId: "server-1" },
          channels: [{ id: "channel-1", name: "engineering", joined: true }],
          agents: [],
          humans: [],
        },
      }),
    }) as any,
  });

  await channelJoinCommand.handler(joinedCtx, { target: "#engineering" });
  assert.equal(joinedIo.stdout.join(""), "Already joined #engineering.\n");

  const missingCtx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          runtimeContext: { agentId: "agent-1", serverId: "server-1" },
          channels: [],
          agents: [],
          humans: [],
        },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await channelJoinCommand.handler(missingCtx, { target: "#engineering" }); },
    (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
  );
});

test("join channel command maps SDK transport stages to existing CLI error codes", async () => {
  const serverFailureCtx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        error: "unavailable",
        data: null,
      }),
    }) as any,
  });
  await assert.rejects(
    async () => { await channelJoinCommand.handler(serverFailureCtx, { target: "#engineering" }); },
    (err: unknown) => err instanceof CliError && err.code === "SERVER_5XX",
  );

  let requests = 0;
  const joinFailureCtx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string): Promise<ApiResponse<unknown>> => {
        requests += 1;
        if (method === "GET") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              runtimeContext: { agentId: "agent-1", serverId: "server-1" },
              channels: [{ id: "channel-1", name: "engineering", joined: false }],
              agents: [],
              humans: [],
            },
          };
        }
        return {
          ok: false,
          status: 403,
          error: "Server role cannot join public channels",
          data: null,
        };
      },
    }) as any,
  });
  await assert.rejects(
    async () => { await channelJoinCommand.handler(joinFailureCtx, { target: "#engineering" }); },
    (err: unknown) => err instanceof CliError && err.code === "JOIN_FAILED",
  );
  assert.equal(requests, 2);
});
