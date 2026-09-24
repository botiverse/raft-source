import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelAddMemberCommand,
  formatAddMemberResult,
} from "./add-member.js";

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

test("add-member output reports member type and idempotent membership", () => {
  assert.equal(
    formatAddMemberResult("#engineering", "user", "alice", false),
    "Added @alice to #engineering as a user.",
  );
  assert.equal(
    formatAddMemberResult("#engineering", "agent", "assistant", false),
    "Added @assistant to #engineering as an agent.",
  );
  assert.equal(
    formatAddMemberResult("#engineering", "user", "alice", true),
    "@alice is already in #engineering.",
  );
});

test("add-member command posts normalized user handle payload", async () => {
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
          data: { ok: true, alreadyMember: false, member: { type: "human", name: "alice" } },
        };
      },
    }) as any,
  });

  await channelAddMemberCommand.handler(ctx, {
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
      method: "POST",
      path: "/internal/agent/agent-1/channels/channel-1/members",
      body: { user: "alice" },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "Added @alice to #engineering as a user.\n");
});

test("add-member command posts normalized agent handle payload", async () => {
  const { io, stdout } = memoryIo();
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
          data: { ok: true, alreadyMember: true, member: { type: "agent", name: "assistant" } },
        };
      },
    }) as any,
  });

  await channelAddMemberCommand.handler(ctx, {
    target: "#engineering",
    agent: "@assistant",
  });

  assert.equal((requests[1]?.body as { agent?: string }).agent, "assistant");
  assert.equal(stdout.join(""), "@assistant is already in #engineering.\n");
});

test("add-member command requires exactly one member selector", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelAddMemberCommand.handler(ctx, { target: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
  await assert.rejects(
    async () => { await channelAddMemberCommand.handler(ctx, { target: "#engineering", user: "@alice", agent: "@assistant" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
});
