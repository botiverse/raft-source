import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { buildRaftProgram } from "../../program";
import {
  channelUpdateCommand,
  formatUpdateChannelResult,
} from "./update";

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

test("update channel output reports channel visibility", () => {
  assert.equal(
    formatUpdateChannelResult({ id: "channel-1", name: "platform", type: "channel" }),
    "Updated #platform (public).",
  );
  assert.equal(
    formatUpdateChannelResult({ id: "channel-1", name: "platform", type: "private" }),
    "Updated #platform (private).",
  );
});

test("update channel command resolves target and patches normalized payload", async () => {
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
          data: { id: "channel-1", name: "platform", type: "private" },
        };
      },
    }) as any,
  });

  await channelUpdateCommand.handler(ctx, {
    target: "#engineering",
    name: "#platform",
    description: "Runtime work",
    private: true,
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/server",
      body: undefined,
    },
    {
      method: "PATCH",
      path: "/internal/agent-api/channels/channel-1",
      body: {
        name: "platform",
        description: "Runtime work",
        visibility: "private",
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "Updated #platform (private).\n");
});

test("update channel command rejects empty updates and conflicting visibility", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await channelUpdateCommand.handler(ctx, { target: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
  await assert.rejects(
    async () => { await channelUpdateCommand.handler(ctx, { target: "#engineering", public: true, private: true }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      return true;
    },
  );
});

// Channel announcements (channel_announcement_v0): --announcement <artifact> and --no-announcement.
const ID = "pt_0b3b0f4e-2f0c-4a53-9d8e-2a5b7c1d9e01";

function announcementCtx(reply: (body: unknown) => ApiResponse<unknown>) {
  const { io, stdout } = memoryIo();
  const patches: unknown[] = [];
  const createApiClient = () => ({
    request: async (method: string, _path: string, body: unknown): Promise<ApiResponse<unknown>> => {
      if (method === "GET") return { ok: true, status: 200, error: null, data: serverInfoData };
      patches.push(body);
      return reply(body);
    },
  }) as any;
  return { io, stdout, patches, createApiClient, ctx: createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient }) };
}

test("--announcement sends the Artifact's id (from an id or a link) and prints what the announcement is now", async () => {
  const announcement = { artifactId: ID, title: "Ops rules", version: 3, updatedAt: "2026-11-10T07:12:40.000Z" };
  const { ctx, stdout, patches } = announcementCtx(() => ({ ok: true, status: 200, error: null, data: { id: "channel-1", name: "engineering", type: "channel", announcement } }));
  await channelUpdateCommand.handler(ctx, { target: "#engineering", announcement: `https://app.raft.build/artifacts/${ID}` });
  assert.deepEqual(patches, [{ announcement: ID }]);
  assert.equal(stdout.join(""), `Updated #engineering (public).\nAnnouncement: "Ops rules" (${ID}, v3, updated 2026-11-10 07:12Z) — read: raft artifact read ${ID}\n`);
});

test("--no-announcement (through the parser) sends null and says the channel has none now", async () => {
  const { io, stdout, patches, createApiClient } = announcementCtx(() => ({ ok: true, status: 200, error: null, data: { id: "channel-1", name: "engineering", type: "channel", announcement: null } }));
  const program = buildRaftProgram({ io, env: {}, loadAgentContext: () => agentContext, createApiClient });
  await program.parseAsync(["channel", "update", "--target", "#engineering", "--no-announcement"], { from: "user" });
  assert.deepEqual(patches, [{ announcement: null }]);
  assert.equal(stdout.join(""), "Updated #engineering (public). It has no announcement now.\n");
});

test("--announcement refusals: a title, a DM or thread target (before any request), and the Server's reason with its next step", async () => {
  const { ctx, patches } = announcementCtx(() => ({
    ok: false, status: 403, data: null,
    error: "Only the owner of #engineering (one of its channel admins) or a server owner or admin can set or remove its announcement.",
    errorCode: "channel_announcement_forbidden",
    suggestedNextAction: "Ask one of them to set it, or post what you wanted to announce as a message in #engineering.",
  }));
  await assert.rejects(async () => { await channelUpdateCommand.handler(ctx, { target: "#engineering", announcement: "Ops rules" }); }, (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && /not a title/.test(err.message));
  await assert.rejects(async () => { await channelUpdateCommand.handler(ctx, { target: "dm:@alice", announcement: ID }); }, (err: unknown) => err instanceof CliError && err.code === "INVALID_TARGET" && /a DM or a thread has none/.test(err.message));
  await assert.rejects(async () => { await channelUpdateCommand.handler(ctx, { target: "#engineering:abc12345", announcement: false }); }, (err: unknown) => err instanceof CliError && err.code === "INVALID_TARGET");
  assert.deepEqual(patches, []);
  await assert.rejects(async () => { await channelUpdateCommand.handler(ctx, { target: "#engineering", announcement: ID }); }, (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "UPDATE_FAILED");
    assert.match(err.message, /^Only the owner of #engineering/);
    assert.equal(err.suggestedNextAction, "Ask one of them to set it, or post what you wanted to announce as a message in #engineering.");
    return true;
  });
});
