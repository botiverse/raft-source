import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { channelMembersCommand } from "./members.js";

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

test("channel members command uses injected ApiClient and encodes target", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            channel: { ref: "#proj-runtime", type: "public" },
            agents: [{ name: "HaoHao", status: "active" }],
            humans: [{ name: "xxchan", role: "owner" }],
          },
        };
      },
    }) as any,
  });

  await channelMembersCommand.handler(ctx, "#proj-runtime");

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/channel-members?channel=%23proj-runtime" },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /## Channel Members/);
  assert.match(output, /Channel: #proj-runtime \(public\)/);
  assert.match(output, /@HaoHao/);
  assert.match(output, /@xxchan/);
});

test("channel members command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "channel not found",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await channelMembersCommand.handler(ctx, "#missing"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "MEMBERS_FAILED");
      assert.equal(err.message, "channel not found");
      return true;
    },
  );
});

test("channel members command maps missing target into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelMembersCommand.handler(ctx, ""); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "target is required");
      return true;
    },
  );
});
