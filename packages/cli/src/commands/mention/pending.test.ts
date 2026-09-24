import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { mentionPendingCommand } from "./pending.js";

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

test("mention pending calls pending endpoint and renders actions", async () => {
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
            pendingMentionActions: [{
              resolutionId: "r-1",
              messageId: "m-1",
              targetType: "agent",
              targetHandle: "@Noel",
              reason: "not in channel",
              availableActions: ["notify"],
            }],
          },
        };
      },
    }) as any,
  });

  await mentionPendingCommand.handler(ctx, {});

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/mention-actions/pending" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Pending mention actions/);
  assert.match(stdout.join(""), /raft mention notify r-1/);
  assert.doesNotMatch(stdout.join(""), /raft mention add r-1/);
});

test("mention pending --json emits normalized action payload", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { pendingMentionActions: [{ resolutionId: "r-1", targetHandle: "@Noel" }] },
      }),
    }) as any,
  });

  await mentionPendingCommand.handler(ctx, { json: true });

  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    pendingMentionActions: [{
      resolutionId: "r-1",
      messageId: "",
      targetType: "unknown",
      targetHandle: "@Noel",
      reason: "Mention target was not notified at send time.",
      availableActions: [],
      expiresAt: null,
    }],
  });
});
