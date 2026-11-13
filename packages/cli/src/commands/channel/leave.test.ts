import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import {
  channelLeaveCommand,
  formatLeaveChannelResult,
  parseRegularChannelTarget,
} from "./leave";

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

test("leave: a private channel's last member is refused with the --delete-if-last command; with the flag it sends deleteIfLast and says the channel went", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET") {
          return { ok: true, status: 200, error: null, data: { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [{ id: "channel-1", name: "scratch", joined: true }], agents: [], humans: [] } };
        }
        if ((body as { deleteIfLast?: boolean }).deleteIfLast !== true) {
          return { ok: false, status: 409, data: null, error: "You are the last member of #scratch, …", errorCode: "last_member_deletes_channel", suggestedNextAction: "(the Server's)" };
        }
        return { ok: true, status: 200, error: null, data: { ok: true, channelDeleted: true } };
      },
    }) as any,
  });

  await assert.rejects(
    async () => { await channelLeaveCommand.handler(ctx, { target: "#scratch" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "LAST_MEMBER");
      assert.equal(err.message, "You are the last member of #scratch, a private channel: leaving would delete the channel and all its messages, and that can't be undone. Nothing changed.");
      assert.equal(err.suggestedNextAction, `Only if the channel and all its messages should go: raft channel leave --target "#scratch" --delete-if-last. Otherwise stay in it, or ask a person to add someone else first.`);
      return true;
    },
  );
  assert.deepEqual(requests.at(-1)?.body, {});

  await channelLeaveCommand.handler(ctx, { target: "#scratch", deleteIfLast: true });
  assert.deepEqual(requests.at(-1), { method: "POST", path: "/internal/agent-api/channels/channel-1/leave", body: { deleteIfLast: true } });
  assert.equal(stdout.join(""), "You were the last member of #scratch, a private channel, so it and all its messages were deleted. That can't be undone.\n");
});
