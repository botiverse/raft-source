import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContext } from "../auth/env.js";
import type { ApiResponse } from "../client.js";
import { createCommandContext } from "../core/context.js";
import { CliError } from "../core/errors.js";
import type { CliIo } from "../core/io.js";
import { parseLiveVersionInfo, versionCommand } from "./version.js";
import { readCliVersion } from "../version.js";

const CLI_VERSION = readCliVersion();

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const managedContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:12345",
  serverId: "server-1",
  token: "sap_proxy_secret",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-file",
  activeCapabilities: ["read"],
};

test("version asks the live daemon and ignores stale inherited process env", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const previousDaemon = process.env.SLOCK_CURRENT_DAEMON_VERSION;
  const previousComputer = process.env.RAFT_COMPUTER_VERSION;
  process.env.SLOCK_CURRENT_DAEMON_VERSION = "1.0.14-stale";
  process.env.RAFT_COMPUTER_VERSION = "1.0.14-stale";
  const ctx = createCommandContext({
    io,
    env: {
      SLOCK_AGENT_TOKEN: "must-not-be-printed",
    },
    loadAgentContext: () => managedContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            daemonVersion: "1.0.15",
            computerVersion: "1.0.16",
            observation: "live_daemon_process",
          },
        };
      },
    }) as any,
  });

  try {
    await versionCommand.handler(ctx, {});
  } finally {
    if (previousDaemon === undefined) delete process.env.SLOCK_CURRENT_DAEMON_VERSION;
    else process.env.SLOCK_CURRENT_DAEMON_VERSION = previousDaemon;
    if (previousComputer === undefined) delete process.env.RAFT_COMPUTER_VERSION;
    else process.env.RAFT_COMPUTER_VERSION = previousComputer;
  }

  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/runtime-version" }]);
  assert.equal(stdout.join(""), `Raft CLI: ${CLI_VERSION}\nRaft daemon (live): 1.0.15\nRaft Computer (live): 1.0.16\n`);
  assert.equal(stdout.join("").includes("1.0.14-stale"), false);
  assert.equal(stdout.join("").includes("must-not-be-printed"), false);
  assert.deepEqual(stderr, []);
});

test("version JSON labels the observation as live daemon process", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => managedContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          daemonVersion: "1.0.15",
          computerVersion: null,
          observation: "live_daemon_process",
        },
      }),
    }) as any,
  });

  await versionCommand.handler(ctx, { json: true });

  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    data: {
      cli: CLI_VERSION,
      daemon: "1.0.15",
      computer: null,
      observation: "live_daemon_process",
    },
  });
});

test("live observation marker is required by the production parser", () => {
  assert.equal(parseLiveVersionInfo(CLI_VERSION, {
    daemonVersion: "1.0.15",
    computerVersion: "1.0.16",
    observation: "cached_wrapper_value",
  }), null);
  assert.deepEqual(parseLiveVersionInfo(CLI_VERSION, {
    daemonVersion: "1.0.15",
    computerVersion: "1.0.16",
    observation: "live_daemon_process",
  }), {
    cli: CLI_VERSION,
    daemon: "1.0.15",
    computer: "1.0.16",
    observation: "live_daemon_process",
  });
});

test("version fails closed when the live daemon cannot answer", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { SLOCK_CURRENT_DAEMON_VERSION: "9.9.9-stale" },
    loadAgentContext: () => managedContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        error: "unavailable",
        data: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => versionCommand.handler(ctx, {}),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "VERSION_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(stdout.join(""), "");
});

for (const metadata of [
  { daemonVersion: "0.0.0", computerVersion: null },
  { daemonVersion: "1.0.15", computerVersion: "0.0.0-dev" },
]) {
  test(`version rejects placeholder live metadata ${JSON.stringify(metadata)}`, async () => {
    const { io, stdout } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => managedContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true,
          status: 200,
          error: null,
          data: {
            ...metadata,
            observation: "live_daemon_process",
          },
        }),
      }) as any,
    });

    await assert.rejects(
      async () => versionCommand.handler(ctx, {}),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "VERSION_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(stdout.join(""), "");
  });
}

test("invalid live daemon metadata never falls back to inherited daemon env", async () => {
  const previous = process.env.SLOCK_CURRENT_DAEMON_VERSION;
  process.env.SLOCK_CURRENT_DAEMON_VERSION = "9.9.9-stale";
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => managedContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          daemonVersion: "0.0.0",
          computerVersion: null,
          observation: "live_daemon_process",
        },
      }),
    }) as any,
  });

  try {
    await assert.rejects(
      async () => versionCommand.handler(ctx, {}),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "VERSION_UNAVAILABLE");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.SLOCK_CURRENT_DAEMON_VERSION;
    else process.env.SLOCK_CURRENT_DAEMON_VERSION = previous;
  }
  assert.equal(stdout.join(""), "");
});
