import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelMuteCommand,
  channelUnmuteCommand,
  formatChannelMuteResult,
} from "./mute.js";

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

test("channel mute output carries self-explaining attention details", () => {
  const output = formatChannelMuteResult("#engineering", {
    activityMuted: true,
    muteFromSeq: 42,
    attention: {
      ordinaryActivity: "Ordinary activity for #engineering is muted from sequence 42.",
      unmuteCommand: "raft channel unmute #engineering",
      unmuteApi: "POST /internal/agent-api/channels/channel-1/unmute",
      stillArrives: [
        "Channel mute does not mute personal @mentions; they still notify this agent.",
      ],
      threadBoundary: "Channel mute suppresses ordinary Activity from this channel only. Threads you follow keep delivering independently until you unfollow them.",
      catchUp: "Messages remain in #engineering history.",
    },
  });

  assert.match(output, /^Muted #engineering\./);
  assert.match(output, /Activity muted: yes/);
  assert.match(output, /Mute from seq: 42/);
  assert.match(output, /personal @mentions/);
  assert.match(output, /suppresses ordinary Activity from this channel only/);
  assert.match(output, /Threads you follow keep delivering independently until you unfollow them/);
  assert.doesNotMatch(output, /channel and its threads|all its threads/i);
  assert.match(output, /To unmute: raft channel unmute #engineering/);
});

test("channel mute command resolves channel and calls agent mute endpoint", async () => {
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
            activityMuted: true,
            muteFromSeq: 42,
            attention: {
              state: "muted",
              unmuteCommand: "raft channel unmute #engineering",
            },
          },
        };
      },
    }) as any,
  });

  await channelMuteCommand.handler(ctx, "#engineering");

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "POST", path: "/internal/agent-api/channels/channel-1/mute" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Muted #engineering/);
  assert.match(stdout.join(""), /To unmute: raft channel unmute #engineering/);
});

test("channel mute command accepts canonical --target option", async () => {
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
          data: { activityMuted: true, muteFromSeq: 42 },
        };
      },
    }) as any,
  });

  await channelMuteCommand.handler(ctx, undefined, { target: "#engineering" });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "POST", path: "/internal/agent-api/channels/channel-1/mute" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Muted #engineering/);
});

test("channel unmute command resolves channel and calls agent unmute endpoint", async () => {
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
            activityMuted: false,
            muteFromSeq: null,
            attention: {
              state: "unmuted",
              muteCommand: "raft channel mute #engineering",
            },
          },
        };
      },
    }) as any,
  });

  await channelUnmuteCommand.handler(ctx, "#engineering");

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/server" },
    { method: "POST", path: "/internal/agent-api/channels/channel-1/unmute" },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Unmuted #engineering/);
  assert.match(stdout.join(""), /To mute: raft channel mute #engineering/);
});

test("channel mute command maps invalid target into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelMuteCommand.handler(ctx, "engineering"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});

test("channel mute command rejects conflicting positional and --target values", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelMuteCommand.handler(ctx, "#engineering", { target: "#ops" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "Positional target and --target must refer to the same channel when both are provided");
      return true;
    },
  );
});
