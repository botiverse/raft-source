import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  channelArchiveCommand,
  channelUnarchiveCommand,
  formatArchiveChannelResult,
  formatUnarchiveChannelResult,
} from "./lifecycle.js";

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

test("channel lifecycle output states the resulting write contract", () => {
  assert.equal(
    formatArchiveChannelResult({ id: "channel-1", name: "engineering" }),
    "Archived #engineering. The channel is read-only until unarchived.",
  );
  assert.equal(
    formatUnarchiveChannelResult({ id: "channel-1", name: "engineering" }),
    "Unarchived #engineering. Messages and other writes are enabled again.",
  );
});

for (const [label, command, endpoint, output] of [
  [
    "archive",
    channelArchiveCommand,
    "archive",
    "Archived #engineering. The channel is read-only until unarchived.\n",
  ],
  [
    "unarchive",
    channelUnarchiveCommand,
    "unarchive",
    "Unarchived #engineering. Messages and other writes are enabled again.\n",
  ],
] as const) {
  test(`${label} sends one contract-backed lifecycle request`, async () => {
    const { io, stdout, stderr } = memoryIo();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (method: string, path: string, body: unknown): Promise<ApiResponse<unknown>> => {
          requests.push({ method, path, body });
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              id: "channel-1",
              name: "engineering",
              type: "channel",
              archivedAt: endpoint === "archive" ? "2026-07-11T00:00:00Z" : null,
              archivedByUserId: null,
              archivedByAgentId: endpoint === "archive" ? "agent-1" : null,
            },
          };
        },
      }) as any,
    });

    await command.handler(ctx, { target: "#engineering" });

    assert.deepEqual(requests, [
      {
        method: "POST",
        path: `/internal/agent-api/channels/${endpoint}`,
        body: { target: "#engineering" },
      },
    ]);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.join(""), output);
  });
}

test("channel lifecycle rejects non-channel targets before loading credentials", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext });

  await assert.rejects(
    async () => channelArchiveCommand.handler(ctx, { target: "dm:@alice" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});
