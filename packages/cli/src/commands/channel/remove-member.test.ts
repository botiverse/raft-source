import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelRemoveMemberCommand,
  formatRemoveMemberResult,
} from "./remove-member.js";

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

const serverInfoData = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  channels: [{ id: "channel-1", name: "engineering", joined: true, type: "public" }],
  agents: [],
  humans: [],
};

test("remove-member output distinguishes removed and already absent", () => {
  assert.equal(
    formatRemoveMemberResult("#engineering", "alice", true),
    "Removed @alice from #engineering.",
  );
  assert.equal(
    formatRemoveMemberResult("#engineering", "alice", true, {
      wasMember: true,
      member: { type: "human", name: "alice" },
      attention: {
        ordinaryActivity: "Ordinary channel delivery for @alice in #engineering has stopped.",
        stillArrives: [
          "If #engineering is public, followed threads still notify @alice until they unfollow them.",
          "Personal @mentions can still notify when current visibility allows.",
        ],
        threadBoundary: "Removing a channel member does not unfollow existing thread follows.",
        manageCommand: `raft thread unfollow --target "#engineering:<thread-short-id>"`,
        manageApi: "POST /internal/agent-api/threads/unfollow",
      },
    }),
    [
      "Removed @alice from #engineering.",
      "Ordinary channel delivery for @alice in #engineering has stopped.",
      "Still arrives:",
      "- If #engineering is public, followed threads still notify @alice until they unfollow them.",
      "- Personal @mentions can still notify when current visibility allows.",
      "Removing a channel member does not unfollow existing thread follows.",
      `To stop a followed thread: raft thread unfollow --target "#engineering:<thread-short-id>"`,
      "Agent API: POST /internal/agent-api/threads/unfollow",
    ].join("\n"),
  );
  assert.equal(
    formatRemoveMemberResult("#engineering", "alice", false),
    "@alice was not in #engineering.",
  );
});

test("remove-member command sends DELETE body with normalized handle", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: serverInfoData,
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            ok: true,
            wasMember: true,
            member: { type: "human", name: "alice" },
            attention: {
              stillArrives: ["If #engineering is public, followed threads still notify @alice until they unfollow them."],
              threadBoundary: "Removing a channel member does not unfollow existing thread follows.",
            },
          },
        };
      },
    }) as any,
  });

  await channelRemoveMemberCommand.handler(ctx, {
    target: "#engineering",
    user: "@alice",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/server",
      body: undefined,
    },
    {
      method: "DELETE",
      path: "/internal/agent/agent-1/channels/channel-1/members",
      body: { user: "alice" },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Still arrives:\n- If #engineering is public, followed threads still notify @alice until they unfollow them\./);
  assert.match(stdout.join(""), /Removing a channel member does not unfollow existing thread follows\./);
});

test("remove-member command requires exactly one member selector", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelRemoveMemberCommand.handler(ctx, { target: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
  await assert.rejects(
    async () => { await channelRemoveMemberCommand.handler(ctx, { target: "#engineering", user: "@alice", agent: "@assistant" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
});
