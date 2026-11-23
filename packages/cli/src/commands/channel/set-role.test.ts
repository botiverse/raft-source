import assert from "node:assert/strict";

import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { channelSetRoleCommand } from "./set-role";

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

function contextAnswering(response: ApiResponse<unknown>) {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return response;
      },
    }) as never,
  });
  return { ctx, stdout, stderr, requests };
}

test("set-role sends one request by handle and prints the result", async () => {
  const { ctx, stdout, stderr, requests } = contextAnswering({
    ok: true,
    status: 200,
    error: null,
    data: { ok: true, changed: true, channelId: "channel-1", member: { type: "human", id: "user-1", name: "alice" }, channelRole: "admin" },
  });

  await channelSetRoleCommand.handler(ctx, { target: "#engineering", user: "@alice", role: "admin" });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/channels/member-role",
    body: { target: "#engineering", user: "alice", role: "admin" },
  }]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "Made @alice a channel admin of #engineering.\n");
});

test("set-role keeps the Server's capability refusal and points to the channel's members for who can change the role", async () => {
  const { ctx } = contextAnswering({
    ok: false,
    status: 403,
    data: null,
    error: "You do not have permission to change channel member roles",
    errorCode: "channel_capability_required",
    suggestedNextAction: "Ask a channel admin of #engineering, or a server owner or admin, to change it.",
  });

  await assert.rejects(
    async () => channelSetRoleCommand.handler(ctx, { target: "#engineering", agent: "@bot", role: "member" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "channel_capability_required");
      assert.equal(err.message, "You do not have permission to change channel member roles");
      assert.equal(
        err.suggestedNextAction,
        'Ask a channel admin of #engineering, or a server owner or admin, to change it. `raft channel members "#engineering"` shows who they are: `channel role=admin` marks a channel admin, `(owner)` and `(admin)` a server owner or admin.',
      );
      return true;
    },
  );
});

test("set-role names a non-member and the other flag, keeping the Server's code and next step", async () => {
  for (const [opts, message] of [
    [{ user: "@scout" }, "No person @scout is a member of #engineering (if @scout is an agent, use --agent @scout)."],
    [{ agent: "@ada" }, "No agent @ada is a member of #engineering (if @ada is a person, use --user @ada)."],
  ] as const) {
    const { ctx } = contextAnswering({
      ok: false,
      status: 409,
      data: null,
      error: "Target must already be a channel member",
      errorCode: "channel_member_required",
      suggestedNextAction: 'raft channel members "#engineering"',
    });
    await assert.rejects(
      async () => channelSetRoleCommand.handler(ctx, { target: "#engineering", role: "admin", ...opts }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "channel_member_required");
        assert.equal(err.message, message);
        assert.equal(err.suggestedNextAction, 'raft channel members "#engineering"');
        return true;
      },
    );
  }
});

test("set-role refuses bad arguments before any request, each with a next step", async () => {
  for (const [opts, code] of [
    [{ target: "dm:@alice", user: "alice", role: "admin" }, "INVALID_TARGET"],
    [{ target: "#engineering", role: "admin" }, "INVALID_ARG"],
    [{ target: "#engineering", user: "alice", agent: "bot", role: "admin" }, "INVALID_ARG"],
    [{ target: "#engineering", user: "alice", role: "owner" }, "INVALID_ARG"],
  ] as const) {
    const { ctx, requests } = contextAnswering({ ok: true, status: 200, error: null, data: null });
    await assert.rejects(
      async () => channelSetRoleCommand.handler(ctx, opts),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, code);
        assert.match(err.suggestedNextAction ?? "", /raft channel (set-role|members)/);
        return true;
      },
    );
    assert.deepEqual(requests, []);
  }
});
