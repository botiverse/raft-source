import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { userInfoCommand } from "./info.js";

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

test("user info command shows visible agent facts and channel memberships", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (path.includes("channel=%23proj-runtime")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { channel: { ref: "#proj-runtime", type: "private" }, agents: [{ name: "HaoHao", status: "active" }], humans: [] },
          };
        }
        if (path.includes("channel=%23private-rejected")) {
          return { ok: false, status: 403, error: "forbidden", data: null };
        }
        if (path.includes("channel=%23proj-web")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              channel: { ref: "#proj-web", type: "public" },
              agents: [{ name: "HaoHao", status: "active" }],
              humans: [{ name: "xxchan" }],
            },
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            runtimeContext: {
              agentId: "agent-1",
              serverId: "server-1",
            },
            channels: [
              { id: "c1", name: "proj-runtime", joined: true, type: "private" },
              { id: "c2", name: "private-rejected", joined: true, type: "private" },
              { id: "c3", name: "proj-web", joined: false, type: "public", activityMuted: true },
            ],
            agents: [{ name: "HaoHao", status: "active", role: "admin", description: "Runtime agent" }],
            humans: [{ name: "xxchan", role: "owner" }],
          },
        };
      },
    }) as any,
  });

  await userInfoCommand.handler(ctx, "@HaoHao", {});

  assert.deepEqual(stderr, []);
  assert.deepEqual(requests.map((request) => request.path), [
    "/internal/agent-api/server",
    "/internal/agent-api/channel-members?channel=%23proj-runtime",
    "/internal/agent-api/channel-members?channel=%23private-rejected",
    "/internal/agent-api/channel-members?channel=%23proj-web",
  ]);
  const output = stdout.join("");
  assert.match(output, /## User/);
  assert.match(output, /User: @HaoHao/);
  assert.match(output, /Kind: agent/);
  assert.match(output, /Status: active/);
  assert.match(output, /Role: admin/);
  assert.match(output, /Description: Runtime agent/);
  assert.match(output, /#proj-runtime \[private, joined\]/);
  assert.match(output, /#proj-web \[public, joined\]/);
  assert.doesNotMatch(output, /#proj-web \[public, not joined/);
  assert.doesNotMatch(output, /#proj-web \[[^\]]*muted/);
  assert.match(output, /Skipped 1 visible channel roster checks/);
});

test("user info command supports bounded channel inspection", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.startsWith("/internal/agent-api/channel-members")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { channel: { ref: "#beta", type: "public" }, agents: [], humans: [{ name: "xxchan" }] },
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            runtimeContext: {
              agentId: "agent-1",
              serverId: "server-1",
            },
            channels: [
              { id: "c1", name: "alpha", joined: true, type: "public" },
              { id: "c2", name: "beta", joined: true, type: "public" },
              { id: "c3", name: "gamma", joined: true, type: "public" },
            ],
            agents: [],
            humans: [{ name: "xxchan", role: "owner" }],
          },
        };
      },
    }) as any,
  });

  await userInfoCommand.handler(ctx, "xxchan", { offset: "1", limit: "1" });

  const output = stdout.join("");
  assert.match(output, /#beta \[public, joined\]/);
  assert.match(output, /Showing 2-2 of 3/);
  assert.match(output, /More: raft user info @xxchan --offset 2 --limit 1/);
});

test("user info maps missing users to typed error with next action", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          runtimeContext: {
            agentId: "agent-1",
            serverId: "server-1",
          },
          channels: [],
          agents: [],
          humans: [],
        },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await userInfoCommand.handler(ctx, "@missing", {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "User not found or not visible: @missing");
      assert.match(err.suggestedNextAction ?? "", /server info --agents/);
      return true;
    },
  );
});
