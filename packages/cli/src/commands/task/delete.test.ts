import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskDeleteCommand } from "./delete.js";

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

function contextReturning(
  response: ApiResponse<unknown>,
  requests: Array<{ method: string; path: string; body: unknown }>,
  io: CliIo,
) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return response;
      },
    }) as any,
  });
}

test("task delete command uses injected ApiClient and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning({ ok: true, status: 200, error: null, data: { ok: true } }, requests, io);

  await taskDeleteCommand.handler(ctx, { target: "  #proj-runtime  ", number: "7" });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks/delete",
      body: { channel: "#proj-runtime", task_number: 7 },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 deleted.\n");
});

test("task delete command maps invalid numbers into typed CliError", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning({ ok: true, status: 200, error: null, data: { ok: true } }, requests, io);

  await assert.rejects(
    async () => { await taskDeleteCommand.handler(ctx, { target: "#proj-runtime", number: "0" }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
  );
  assert.deepEqual(requests, [], "a rejected argument must not reach the server");
});

/**
 * A 403 here is an authority fact, not a retryable race, so the CLI must name
 * who may delete instead of leaving the agent to retry the same call. Without
 * the `suggestedNextAction` an agent reads a bare DELETE_FAILED and tries again.
 */
test("task delete surfaces who may delete when the server refuses with 403", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning(
    { ok: false, status: 403, error: "Only the task creator or server admins can delete", data: null },
    requests,
    io,
  );

  await assert.rejects(
    async () => { await taskDeleteCommand.handler(ctx, { target: "#proj-runtime", number: "7" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "DELETE_FAILED");
      assert.match(String(err.suggestedNextAction), /creator or a server admin/);
      assert.match(String(err.suggestedNextAction), /close it instead/);
      return true;
    },
  );
});

test("task delete maps a 5xx to SERVER_5XX rather than DELETE_FAILED", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning({ ok: false, status: 502, error: "bad gateway", data: null }, requests, io);

  await assert.rejects(
    async () => { await taskDeleteCommand.handler(ctx, { target: "#proj-runtime", number: "7" }); },
    (err: unknown) => err instanceof CliError && err.code === "SERVER_5XX",
  );
});
