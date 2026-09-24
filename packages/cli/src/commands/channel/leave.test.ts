import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelLeaveCommand,
  formatAlreadyNotJoined,
  formatLeaveChannelResult,
  parseRegularChannelTarget,
} from "./leave.js";

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

test("parseRegularChannelTarget accepts only top-level channel targets", () => {
  assert.equal(parseRegularChannelTarget("#engineering"), "engineering");
  assert.equal(parseRegularChannelTarget("#engineering "), "engineering");
  assert.equal(parseRegularChannelTarget("engineering"), null);
  assert.equal(parseRegularChannelTarget("dm:@alice"), null);
  assert.equal(parseRegularChannelTarget("#engineering:abcd1234"), null);
  assert.equal(parseRegularChannelTarget("#"), null);
});

test("leave channel output explains post-leave access", () => {
  assert.equal(
    formatLeaveChannelResult("#engineering"),
    "Left #engineering. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.",
  );
  assert.equal(
    formatLeaveChannelResult("#engineering", {
      ok: true,
      attention: {
        ordinaryActivity: "Ordinary channel delivery for #engineering has stopped.",
        stillArrives: [
          "If #engineering is public, followed threads still notify until you unfollow them.",
          "Personal @mentions can still notify when current visibility allows.",
        ],
        threadBoundary: "Leaving a channel does not unfollow existing thread follows.",
        manageCommand: `raft thread unfollow --target "#engineering:<thread-short-id>"`,
        manageApi: "POST /internal/agent-api/threads/unfollow",
      },
    }),
    [
      "Left #engineering. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.",
      "Ordinary channel delivery for #engineering has stopped.",
      "Still arrives:",
      "- If #engineering is public, followed threads still notify until you unfollow them.",
      "- Personal @mentions can still notify when current visibility allows.",
      "Leaving a channel does not unfollow existing thread follows.",
      `To stop a followed thread: raft thread unfollow --target "#engineering:<thread-short-id>"`,
      "Agent API: POST /internal/agent-api/threads/unfollow",
    ].join("\n"),
  );
  assert.equal(formatAlreadyNotJoined("#engineering"), "Already not joined in #engineering.");
});

test("leave channel command uses injected ApiClient and writes leave result", async () => {
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
              channels: [{ id: "channel-1", name: "engineering", joined: true }],
              agents: [],
              humans: [],
            },
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            ok: true,
            attention: {
              stillArrives: ["If #engineering is public, followed threads still notify until you unfollow them."],
              threadBoundary: "Leaving a channel does not unfollow existing thread follows.",
            },
          },
        };
      },
    }) as any,
  });

  await channelLeaveCommand.handler(ctx, { target: "#engineering" });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "POST", path: "/internal/agent-api/channels/channel-1/leave" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Still arrives:\n- If #engineering is public, followed threads still notify until you unfollow them\./);
  assert.match(stdout.join(""), /Leaving a channel does not unfollow existing thread follows\./);
});

test("leave channel command maps invalid target into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelLeaveCommand.handler(ctx, { target: "engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});
