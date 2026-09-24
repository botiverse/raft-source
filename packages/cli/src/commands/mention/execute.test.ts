import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { buildMentionExecuteCommand } from "./execute.js";

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

test("mention notify exits nonzero when any requested recovery was not queued", async () => {
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
          data: {
            ok: true,
            action: "notify",
            results: [
              { resolutionId: "r-1", status: "queued", targetHandle: "@Noel" },
              { resolutionId: "r-2", status: "dropped", reason: "target_not_queued" },
            ],
          },
        };
      },
    }) as any,
  });

  await assert.rejects(
    async () => buildMentionExecuteCommand("notify").handler(ctx, ["r-1", "r-2"], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "MENTION_ACTION_FAILED");
      assert.match(err.message, /r-2/);
      assert.match(err.message, /target_not_queued/);
      return true;
    },
  );

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/mention-actions/execute",
    body: { action: "notify", resolutionIds: ["r-1", "r-2"] },
  }]);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, []);
});

test("mention notify succeeds only when every requested recovery is queued", async () => {
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
          ok: true,
          action: "notify",
          results: [
            { resolutionId: "r-1", status: "queued", targetHandle: "@Noel" },
            { resolutionId: "r-2", status: "queued", reason: "already_queued" },
          ],
        },
      }),
    }) as any,
  });

  await buildMentionExecuteCommand("notify").handler(ctx, ["r-1", "r-2"], {});

  assert.match(stdout.join(""), /r-1 @Noel: queued/);
  assert.match(stdout.join(""), /r-2: queued — already_queued/);
});

test("mention add --json exits nonzero when membership delivery is denied", async () => {
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
          ok: true,
          action: "add",
          results: [{
            resolutionId: "r-1",
            status: "no_permission",
            action: "add",
            messageId: "m-1",
            channelId: "c-1",
            targetType: "agent",
            targetId: "a-1",
            reason: "sender_lacks_channel_access",
            dedupedResolutionIds: ["r-1"],
          }],
        },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => buildMentionExecuteCommand("add").handler(ctx, ["r-1"], { json: true }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "MENTION_ACTION_FAILED");
      assert.match(err.message, /sender_lacks_channel_access/);
      return true;
    },
  );
  assert.deepEqual(stdout, []);
});

test("mention execute requires at least one resolution id", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => buildMentionExecuteCommand("notify").handler(ctx, [], {}),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /At least one resolution id/);
      return true;
    },
  );
});
