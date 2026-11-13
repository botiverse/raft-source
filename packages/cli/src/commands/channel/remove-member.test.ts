import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import {
  channelRemoveMemberCommand,
  formatRemoveMemberResult,
} from "./remove-member";

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
            channelId: "channel-1",
            member: { type: "human", id: "user-1", name: "alice" },
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
      path: "/internal/agent-api/channels/channel-1/members",
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

test("remove-member: a private channel's last member is refused with the --delete-if-last command; with the flag it sends deleteIfLast and says the channel went", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET") return { ok: true, status: 200, error: null, data: serverInfoData };
        if ((body as { deleteIfLast?: boolean }).deleteIfLast !== true) {
          return { ok: false, status: 409, data: null, error: "…", errorCode: "last_member_deletes_channel", suggestedNextAction: "(the Server's)" };
        }
        return { ok: true, status: 200, error: null, data: { ok: true, wasMember: true, channelId: "channel-1", member: { type: "agent", id: "agent-1", name: "helper" }, channelDeleted: true } };
      },
    }) as any,
  });

  await assert.rejects(
    async () => { await channelRemoveMemberCommand.handler(ctx, { target: "#engineering", agent: "@helper" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "LAST_MEMBER");
      assert.equal(err.message, "@helper is the last member of #engineering, a private channel: removing them would delete the channel and all its messages, and that can't be undone. Nothing changed.");
      assert.equal(err.suggestedNextAction, `Only if the channel and all its messages should go: raft channel remove-member --target "#engineering" --agent @helper --delete-if-last. Otherwise leave them in it.`);
      return true;
    },
  );

  await channelRemoveMemberCommand.handler(ctx, { target: "#engineering", agent: "@helper", deleteIfLast: true });
  assert.deepEqual(requests.at(-1)?.body, { agent: "helper", deleteIfLast: true });
  assert.equal(stdout.join(""), "@helper was the last member of #engineering, a private channel, so it and all its messages were deleted. That can't be undone.\n");
});
