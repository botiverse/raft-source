import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { profileShowCommand } from "./show.js";

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

const humanProfile = {
  kind: "human",
  id: "user-1",
  isSelf: false,
  name: "xxchan",
  displayName: "xxchan",
  description: "Builder",
  avatarUrl: null,
  membershipStatus: "active",
  role: "owner",
  joinedAt: "2026-05-01T00:00:00.000Z",
  email: null,
  createdAgents: [],
};

test("profile show command uses injected ApiClient and writes canonical text", async () => {
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
          data: humanProfile,
        };
      },
    }) as any,
  });

  await profileShowCommand.handler(ctx, "@xxchan", {});

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/profile?target=%40xxchan" },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /## Profile/);
  assert.match(output, /- Type: human/);
  assert.match(output, /- Handle: @xxchan/);
});

test("profile show command preserves legacy JSON output", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: humanProfile,
      }),
    }) as any,
  });

  await profileShowCommand.handler(ctx, undefined, { json: true });

  assert.deepEqual(stderr, []);
  assert.deepEqual(JSON.parse(stdout.join("")), { ok: true, data: humanProfile });
});

test("profile show command maps invalid targets into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await profileShowCommand.handler(ctx, "xxchan", {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "profile target must start with @");
      return true;
    },
  );
});

test("profile show command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "profile not found",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await profileShowCommand.handler(ctx, "@missing", {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "PROFILE_SHOW_FAILED");
      assert.equal(err.message, "profile not found");
      return true;
    },
  );
});
