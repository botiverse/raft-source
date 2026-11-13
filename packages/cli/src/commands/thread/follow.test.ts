import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { formatFollowThreadResult, threadFollowCommand } from "./follow";

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

function harness(respond: () => ApiResponse<unknown>) {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return respond();
      },
    }) as any,
  });
  return { ctx, requests, stdout, stderr };
}

test("follow thread output names the unfollow command", () => {
  assert.equal(
    formatFollowThreadResult("#engineering:abcd1234", true),
    [
      "Following #engineering:abcd1234. New replies in this thread wake you; earlier replies are not unread.",
      "To stop: raft thread unfollow --target \"#engineering:abcd1234\"",
    ].join("\n"),
  );
  assert.match(formatFollowThreadResult("#engineering:abcd1234", false), /^Already following #engineering:abcd1234\. Nothing changed\./);
});

test("follow thread command POSTs /threads/follow and writes the receipt", async () => {
  const h = harness(() => ({ ok: true, status: 200, error: null, data: { ok: true, following: true, changed: true } }));
  await threadFollowCommand.handler(h.ctx, { target: "#engineering:abcd1234" });
  assert.deepEqual(h.requests, [
    { method: "POST", path: "/internal/agent-api/threads/follow", body: { thread: "#engineering:abcd1234" } },
  ]);
  assert.deepEqual(h.stderr, []);
  assert.equal(h.stdout.join(""), `${formatFollowThreadResult("#engineering:abcd1234", true)}\n`);
});

test("follow thread command refuses a non-thread target (a task ref names raft task follow) without a request", async () => {
  for (const target of ["#engineering", "#engineering:#7"]) {
    const h = harness(() => ({ ok: true, status: 200, error: null, data: {} }));
    await assert.rejects(
      async () => { await threadFollowCommand.handler(h.ctx, { target }); },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_TARGET");
        assert.match(err.message, /raft task follow "#channel:#7"/);
        return true;
      },
    );
    assert.equal(h.requests.length, 0);
  }
});

test("follow thread command surfaces a server refusal", async () => {
  const h = harness(() => ({ ok: false, status: 404, error: "Thread not found", data: null }));
  await assert.rejects(
    async () => { await threadFollowCommand.handler(h.ctx, { target: "dm:@alice:abcd1234" }); },
    (err: unknown) => err instanceof CliError && err.code === "NOT_FOUND",
  );
});
