import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  formatUnfollowThreadResult,
  parseThreadTarget,
  threadUnfollowCommand,
} from "./unfollow.js";

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

test("parseThreadTarget accepts explicit thread targets and UUIDs", () => {
  assert.equal(parseThreadTarget("#engineering:abcd1234"), "#engineering:abcd1234");
  assert.equal(parseThreadTarget("dm:@alice:abcd1234"), "dm:@alice:abcd1234");
  assert.equal(parseThreadTarget("DM:@alice:abcd1234"), "DM:@alice:abcd1234");
  assert.equal(
    parseThreadTarget("11111111-2222-4333-8444-555555555555"),
    "11111111-2222-4333-8444-555555555555",
  );
});

test("parseThreadTarget rejects non-thread targets", () => {
  assert.equal(parseThreadTarget("#engineering"), null);
  assert.equal(parseThreadTarget("dm:@alice"), null);
  assert.equal(parseThreadTarget("#engineering:abc"), null);
  assert.equal(parseThreadTarget("engineering:abcd1234"), null);
  assert.equal(parseThreadTarget(""), null);
});

test("unfollow thread output explains delivery semantics", () => {
  assert.equal(
    formatUnfollowThreadResult("#engineering:abcd1234"),
    [
      "Unfollowed #engineering:abcd1234. Ordinary delivery for this thread has stopped.",
      "A later personal @mention arrives and re-follows you; that delivery reminds you to run: raft thread unfollow --target \"#engineering:abcd1234\"",
      "Posting in this thread re-follows you automatically.",
    ].join("\n"),
  );
});

test("unfollow thread command uses injected ApiClient and writes result", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        };
      },
    }) as any,
  });

  await threadUnfollowCommand.handler(ctx, { target: "#engineering:abcd1234" });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/threads/unfollow",
      body: { thread: "#engineering:abcd1234", reason: "no longer following" },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), `${formatUnfollowThreadResult("#engineering:abcd1234")}\n`);
});

test("unfollow thread command maps invalid target into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await threadUnfollowCommand.handler(ctx, { target: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    },
  );
});
