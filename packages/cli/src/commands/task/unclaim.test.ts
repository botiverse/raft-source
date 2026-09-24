import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskUnclaimCommand } from "./unclaim.js";

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

test("task unclaim command uses injected ApiClient and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        };
      },
    }) as any,
  });

  await taskUnclaimCommand.handler(ctx, { target: "  #proj-runtime  ", number: "7" });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks/unclaim",
      body: { channel: "#proj-runtime", task_number: 7 },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 unclaimed — now open.\n");
});

test("task unclaim command maps invalid numbers into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await taskUnclaimCommand.handler(ctx, { channel: "#engineering", number: "0" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--number must be a positive integer; got 0");
      return true;
    },
  );
});

test("task unclaim command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 409,
        data: null,
        error: "not claimed by you",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await taskUnclaimCommand.handler(ctx, { channel: "#engineering", number: "7" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "UNCLAIM_FAILED");
      assert.equal(err.message, "not claimed by you");
      return true;
    },
  );
});
