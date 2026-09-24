import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelUpdateCommand,
  formatUpdateChannelResult,
} from "./update.js";

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
      path: "/internal/agent/agent-1/channels/channel-1",
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
