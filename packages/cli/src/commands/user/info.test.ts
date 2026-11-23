import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { userInfoCommand } from "./info";

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

type FakeApi = (method: string, path: string) => ApiResponse<unknown>;

function contextWith(api: FakeApi, io: CliIo, requests: Array<{ method: string; path: string }>) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return api(method, path);
      },
    }) as never,
  });
}

const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, error: null, data });

const SERVER_INFO = {
  runtimeContext: { agentId: "agent-1", serverId: "server-1" },
  channels: [
    { id: "c1", name: "proj-runtime", joined: true, type: "private" },
    { id: "c2", name: "private-rejected", joined: true, type: "private" },
    { id: "c3", name: "proj-web", joined: false, type: "public", activityMuted: true },
  ],
  agents: [{ name: "HaoHao", status: "active", role: "admin", description: "Runtime agent" }],
  humans: [{ name: "xxchan", role: "owner" }],
};

test("user info command shows visible agent facts and channel memberships", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = contextWith((_method, path) => {
    if (path === "/internal/agent-api/users/HaoHao/channels?offset=0&limit=50") {
      return ok({
        user: SERVER_INFO.agents[0],
        kind: "agent",
        // An older Server's rows: the caller's server.info rows, with the caller's
        // attention flags (a current Server sends the channel and the user's
        // membership only); the shared op never renders them as the user's.
        memberships: [SERVER_INFO.channels[0], SERVER_INFO.channels[2]],
        uncheckedCount: 1,
        page: { total: 3, offset: 0, limit: 50 },
      });
    }
    return { ok: false, status: 500, error: "unexpected", data: null };
  }, io, requests);

  await userInfoCommand.handler(ctx, "@HaoHao", {});

  assert.deepEqual(stderr, []);
  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/users/HaoHao/channels?offset=0&limit=50" }]);
  const output = stdout.join("");
  assert.match(output, /## User/);
  assert.match(output, /User: @HaoHao/);
  assert.match(output, /Kind: agent/);
  assert.match(output, /Status: active/);
  assert.match(output, /Role: admin/);
  assert.match(output, /^Description \(written by them, not by Raft\): Runtime agent$/m);
  assert.match(output, /#proj-runtime \[private, joined\]/);
  assert.match(output, /#proj-web \[public, joined\]/);
  assert.doesNotMatch(output, /#proj-web \[public, not joined/);
  assert.doesNotMatch(output, /#proj-web \[[^\]]*muted/);
  assert.match(output, /Skipped 1 visible channel roster checks/);
});

test("user info command supports bounded channel inspection", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = contextWith(() => ok({
    user: { name: "xxchan", role: "owner" },
    kind: "human",
    memberships: [{ id: "c2", name: "beta", joined: true, type: "public" }],
    uncheckedCount: 0,
    page: { total: 3, offset: 1, limit: 1 },
  }), io, requests);

  await userInfoCommand.handler(ctx, "xxchan", { offset: "1", limit: "1" });

  assert.deepEqual(requests.map((request) => request.path), ["/internal/agent-api/users/xxchan/channels?offset=1&limit=1"]);
  const output = stdout.join("");
  assert.match(output, /#beta \[public, joined\]/);
  assert.match(output, /Showing 2-2 of 3/);
  assert.match(output, /More: raft user info @xxchan --offset 2 --limit 1/);
});

test("user info maps missing users to typed error with next action", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = contextWith(() => ({
    ok: false,
    status: 404,
    error: "User not found or not visible",
    errorCode: "user_not_found",
    data: null,
  }), io, requests);

  await assert.rejects(
    async () => { await userInfoCommand.handler(ctx, "@missing", {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "User not found or not visible: @missing");
      assert.equal(err.suggestedNextAction, "Run `raft server info --agents --query <name>` or `raft server info --humans --query <name>` to inspect visible users.");
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test("user info without roster access looks the user up in server info and skips every inspected channel", async () => {
  for (const refusal of [
    { status: 403, error: "Agent credential is not authorized for this capability", errorCode: "capability_not_authorized" },
    { status: 403, error: "missing required scope", errorCode: "SCOPE_DENIED" },
  ]) {
    const { io, stdout } = memoryIo();
    const requests: Array<{ method: string; path: string }> = [];
    const ctx = contextWith((_method, path) => (
      path === "/internal/agent-api/server" ? ok(SERVER_INFO) : { ok: false, data: null, ...refusal }
    ), io, requests);

    await userInfoCommand.handler(ctx, "HaoHao", { limit: "2" });

    assert.deepEqual(requests.map((request) => request.path), [
      "/internal/agent-api/users/HaoHao/channels?offset=0&limit=2",
      "/internal/agent-api/server",
    ]);
    const output = stdout.join("");
    assert.match(output, /\(none found in inspected visible channels\)/);
    assert.match(output, /Skipped 2 visible channel roster checks/);
    assert.match(output, /More: raft user info @HaoHao --offset 2 --limit 2/);
  }
});

test("user info rejects --limit above 200 before sending anything", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = contextWith(() => ok({}), io, requests);
  await assert.rejects(
    async () => { await userInfoCommand.handler(ctx, "HaoHao", { limit: "201" }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && err.message === "--limit must be at most 200",
  );
  assert.deepEqual(requests, []);
});

test("user info keeps the server's message for a refused or failed request", async () => {
  for (const [response, code] of [
    [{ ok: false, status: 400, error: "Invalid agent-api userChannels query", errorCode: "agent_api_contract_invalid", data: null }, "INFO_FAILED"],
    [{ ok: false, status: 500, error: "Failed to get user channels", data: null }, "SERVER_5XX"],
  ] as const) {
    const { io } = memoryIo();
    const ctx = contextWith(() => response, io, []);
    await assert.rejects(
      async () => { await userInfoCommand.handler(ctx, "HaoHao", {}); },
      (err: unknown) => err instanceof CliError && err.code === code && err.message === response.error,
    );
  }
  const { io } = memoryIo();
  const proxy = contextWith(() => ({ ok: false, status: 502, error: "proxy failed", errorCode: "agent_proxy_failed", data: null }), io, []);
  await assert.rejects(
    async () => { await userInfoCommand.handler(proxy, "HaoHao", {}); },
    (err: unknown) => err instanceof CliError && err.code === "PROXY_5XX",
  );
});
