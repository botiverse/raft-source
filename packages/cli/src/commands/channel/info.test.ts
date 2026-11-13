import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { channelInfoCommand } from "./info";

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

test("channel info command returns narrow visible channel facts and member counts", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (path.startsWith("/internal/agent-api/channel-members")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              channel: { ref: "#proj-runtime", type: "private" },
              agents: [{ name: "HaoHao", status: "active" }],
              humans: [{ name: "xxchan" }, { name: "tygg" }],
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
            channels: [{
              id: "channel-1",
              name: "proj-runtime",
              joined: true,
              type: "private",
              description: "Runtime work",
              activityMuted: true,
            }],
            agents: [],
            humans: [],
          },
        };
      },
    }) as any,
  });

  await channelInfoCommand.handler(ctx, "proj-runtime");

  assert.deepEqual(stderr, []);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "GET", path: "/internal/agent-api/channel-members?channel=%23proj-runtime" },
  ]);
  const output = stdout.join("");
  assert.match(output, /## Channel/);
  assert.match(output, /Channel: #proj-runtime/);
  assert.match(output, /Visibility: private/);
  assert.match(output, /Joined: yes/);
  assert.match(output, /Muted: yes/);
  assert.match(output, /Description: Runtime work/);
  assert.match(output, /Members: 3 \(1 agents, 2 humans\)/);
  assert.match(output, /More: raft channel members "#proj-runtime"/);
});

test("channel info maps missing or inaccessible channels to typed error with next action", async () => {
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
    async () => { await channelInfoCommand.handler(ctx, "#secret"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "Channel not found or not visible: #secret");
      assert.match(err.suggestedNextAction ?? "", /server info --channels/);
      return true;
    },
  );
});

test("channel info rejects thread targets before auth bootstrap", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not bootstrap auth");
    },
  });

  await assert.rejects(
    async () => { await channelInfoCommand.handler(ctx, "#proj-runtime:abc12345"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});

test("channel info takes the target as --target too, as the card's agents tried after a hold", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => path.startsWith("/internal/agent-api/channel-members")
        ? { ok: true, status: 200, error: null, data: { channel: { ref: "#qa-a", type: "public" }, agents: [], humans: [] } }
        : { ok: true, status: 200, error: null, data: { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [{ id: "c1", name: "qa-a", joined: true, type: "channel", description: "Product questions" }], agents: [], humans: [] } },
    }) as any,
  });

  await channelInfoCommand.handler(ctx, undefined, { target: "#qa-a" });
  assert.match(stdout.join(""), /Channel: #qa-a/);
});

test("channel info answers for an archived channel (read-only) that server info counts but does not list", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.startsWith("/internal/agent-api/channel-members")) {
          return { ok: true, status: 200, error: null, data: { channel: { ref: "#proj-task", type: "channel" }, agents: [], humans: [{ name: "xxchan" }] } };
        }
        if (path.endsWith("/server?archived=include")) {
          return { ok: true, status: 200, error: null, data: { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [], archivedChannelCount: 1, archivedChannels: [{ id: "c9", name: "proj-task", joined: true, type: "channel", archived: true }], agents: [], humans: [] } };
        }
        return { ok: true, status: 200, error: null, data: { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [], archivedChannelCount: 1, agents: [], humans: [] } };
      },
    }) as any,
  });
  await channelInfoCommand.handler(ctx, "#proj-task");
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Archived: yes \(read-only: you can read its history, nothing new can be posted\)/);
});
