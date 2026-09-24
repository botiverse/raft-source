import assert from "node:assert/strict";
import test from "node:test";

import type { AgentApiAppConfigResponse } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { appConfigCommand } from "./config.js";

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

const current: AgentApiAppConfigResponse = {
  appId: "system.cleaner",
  revision: 4,
  schema: {
    enabled: { type: "boolean" },
    interval_seconds: { type: "integer", minimum: 900, maximum: 604800 },
    threshold_bytes: { type: "integer", minimum: 4096, maximum: 1073741824 },
  },
  defaults: {
    enabled: true,
    interval_seconds: 3600,
    threshold_bytes: 65536,
  },
  overrides: { threshold_bytes: 131072 },
  effective: {
    enabled: true,
    interval_seconds: 3600,
    threshold_bytes: 131072,
  },
};

function memoryIo(): { io: CliIo; stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    },
  };
}

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, error: null, data };
}

function commandContext(responses: ApiResponse<unknown>[]) {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let responseIndex = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        const response = responses[responseIndex];
        responseIndex += 1;
        assert.ok(response, `unexpected request ${method} ${path}`);
        return response;
      },
    }) as any,
  });
  return { ctx, requests, stdout };
}

test("app config without mutation flags shows effective values and their sources", async () => {
  const { ctx, requests, stdout } = commandContext([ok(current)]);

  await appConfigCommand.handler(ctx, { app: "system.cleaner" });

  assert.deepEqual(requests, [{
    method: "GET",
    path: "/internal/agent-api/apps/system.cleaner/config",
    body: undefined,
  }]);
  assert.match(stdout.join(""), /Revision: 4/);
  assert.match(stdout.join(""), /threshold_bytes = 131072 \(override; default 65536\)/);
  assert.match(stdout.join(""), /enabled = true \(default; default true\)/);
  assert.match(stdout.join(""), /Next action: raft app config --app system\.cleaner/);
});

test("app config applies repeated set and unset flags in one revision-bound PATCH", async () => {
  const updated: AgentApiAppConfigResponse = {
    ...current,
    revision: 5,
    overrides: { enabled: false, threshold_bytes: 131072 },
    effective: { enabled: false, interval_seconds: 3600, threshold_bytes: 131072 },
  };
  const { ctx, requests, stdout } = commandContext([ok(current), ok(updated)]);

  await appConfigCommand.handler(ctx, {
    app: "system.cleaner",
    set: ["enabled=false", "threshold_bytes=131072"],
    unset: ["interval_seconds"],
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/apps/system.cleaner/config",
      body: undefined,
    },
    {
      method: "PATCH",
      path: "/internal/agent-api/apps/system.cleaner/config",
      body: {
        expectedRevision: 4,
        set: { enabled: false, threshold_bytes: 131072 },
        unset: ["interval_seconds"],
      },
    },
  ]);
  assert.match(stdout.join(""), /Revision: 5/);
  assert.doesNotMatch(stdout.join(""), /Timer:|Next fire:/);
});

test("documented Cleaner notification commands execute with exact generic CLI arguments", async () => {
  const thresholdUpdated: AgentApiAppConfigResponse = {
    ...current,
    revision: 5,
    overrides: { threshold_bytes: 131072 },
  };
  const threshold = commandContext([ok(current), ok(thresholdUpdated)]);
  await appConfigCommand.handler(threshold.ctx, {
    app: "system.cleaner",
    set: ["threshold_bytes=131072"],
  });
  assert.deepEqual(threshold.requests[1]?.body, {
    expectedRevision: 4,
    set: { threshold_bytes: 131072 },
    unset: [],
  });

  const disabled: AgentApiAppConfigResponse = {
    ...current,
    revision: 5,
    overrides: { enabled: false, threshold_bytes: 131072 },
    effective: { enabled: false, interval_seconds: 3600, threshold_bytes: 131072 },
  };
  const disable = commandContext([ok(current), ok(disabled)]);
  await appConfigCommand.handler(disable.ctx, {
    app: "system.cleaner",
    set: ["enabled=false"],
  });
  assert.deepEqual(disable.requests[1]?.body, {
    expectedRevision: 4,
    set: { enabled: false },
    unset: [],
  });
});

test("invalid or duplicate mutations fail before auth bootstrap or network access", async () => {
  const cases = [
    { opts: { app: "system.cleaner", set: ["enabled=yes"] }, message: /must be true, false, or an integer/ },
    { opts: { app: "system.cleaner", set: ["enabled=false", "enabled=true"] }, message: /appears more than once/ },
    { opts: { app: "system.cleaner", set: ["enabled=false"], unset: ["enabled"] }, message: /appears more than once/ },
    { opts: { app: "system.cleaner", set: ["missing-equals"] }, message: /must use key=value/ },
  ];

  for (const { opts, message } of cases) {
    let loadCalls = 0;
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => {
        loadCalls += 1;
        throw new Error("auth bootstrap must not run");
      },
    });
    await assert.rejects(
      async () => appConfigCommand.handler(ctx, opts),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INVALID_ARG");
        assert.match(error.message, message);
        return true;
      },
    );
    assert.equal(loadCalls, 0);
  }
});

test("revision conflicts preserve the typed server error and give a retry action", async () => {
  const conflict: ApiResponse<unknown> = {
    ok: false,
    status: 409,
    error: "Config revision changed",
    errorCode: "RAP_APP_CONFIG_REVISION_STALE",
    data: null,
  };
  const { ctx } = commandContext([ok(current), conflict]);

  await assert.rejects(
    async () => appConfigCommand.handler(ctx, { app: "system.cleaner", set: ["enabled=false"] }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "RAP_APP_CONFIG_REVISION_STALE");
      assert.equal(error.message, "Config revision changed");
      assert.match(error.suggestedNextAction ?? "", /Rerun the same command/);
      return true;
    },
  );
});
