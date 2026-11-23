import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";
import { CONTINUATION_ANSWER_TOOL_NAME, RAFT_CONTINUATION_TOOL_ENV } from "@botiverse/raft-shared/src/continuations/index";
import { CLAUDE_CODE_ENTRYPOINT, CLAUDE_DISALLOWED_TOOLS, type SpawnContext } from "../drivers/index";
import { loadOarSessionRuntime, oarInstalledSessionCapabilities } from "../oarLoader";
import { buildOarClaudeProviderIsolationEnv, prepareClaudeOarLaunch, type PrepareClaudeOarLaunchDeps } from "./oarClaudeLaunch";
import { OarLaunchDeclined } from "./oarLaunch";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "ClaudeTest",
    displayName: null,
    description: null,
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://raft.example.com",
    authToken: "",
    agentCredentialKey: "agent-key-1",
    ...overrides,
  };
}

function makeSpawnContext(workingDirectory: string, configOverrides: Partial<AgentConfig> = {}, prompt = "hello from raft"): SpawnContext {
  return {
    agentId: "agent-claude-1",
    config: makeConfig(configOverrides),
    workingDirectory,
    prompt,
    standingPrompt: "You are a Raft agent.",
    slockCliPath: "/usr/local/bin/raft",
    daemonApiKey: "daemon-key-1",
    launchId: "launch-claude-1",
  };
}

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "raft-oar-claude-"));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function fakeTransport(
  inherited: NodeJS.ProcessEnv,
): NonNullable<PrepareClaudeOarLaunchDeps["prepareTransport"]> {
  return async (ctx, extraEnv) => {
    const spawnEnv: Record<string, string | undefined> = { ...inherited };
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete spawnEnv[k];
      else spawnEnv[k] = v;
    }
    // Mirror real prepareCliTransport: materialize envVars from hydrated runtimeConfig.
    const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
    for (const [k, v] of Object.entries(launchFields.envVars ?? {})) {
      spawnEnv[k] = v;
    }
    return { slockDir: path.join(ctx.workingDirectory, ".slock"), spawnEnv };
  };
}

test("prepareClaudeOarLaunch builds a default OAR Claude launch matching legacy invariants and accepted by real claudeRuntime", async () => {
  await withTempDir(async (cwd) => {
    const claudeRuntime = await loadOarSessionRuntime("claude");
    const inherited: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_TOKEN: "parent-msg-token",
      ANTHROPIC_API_KEY: "host-key-kept-for-default-provider",
    };
    const launch = await prepareClaudeOarLaunch(makeSpawnContext(cwd), {
      loadRuntime: async () => claudeRuntime,
      resolveCommand: async () => "/usr/local/bin/claude",
      prepareTransport: fakeTransport(inherited),
      prepareManagedMcp: async () => ({
        endpoint: { name: "raft_managed_mcp", url: "http://127.0.0.1:4321/mcp", endpointUrl: "http://127.0.0.1:4321/mcp", token: "tok-1" },
        hasContinuationRunner: true,
      }),
      inheritedEnv: inherited,
      platform: "linux",
    });

    assert.equal(launch.runtimeId, "claude");
    assert.equal(launch.busyDelivery, "now");
    assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: "/usr/local/bin/claude" });
    assert.equal(launch.options.cwd, cwd);
    assert.equal(launch.options.model, "sonnet");
    assert.equal(launch.options.appendSystemPrompt, "You are a Raft agent.");
    assert.equal(launch.options.systemPrompt, undefined);
    assert.equal(launch.options.serviceTier, undefined);
    assert.equal(launch.options.userConfiguration, undefined);
    assert.deepEqual(launch.options.disallowedTools, CLAUDE_DISALLOWED_TOOLS.split(","));
    assert.equal(launch.options.env?.CLAUDECODE, null, "strips inherited CLAUDECODE");
    assert.equal(launch.options.env?.CLAUDE_CODE_CHILD_SESSION, null, "strips inherited Claude parent-session markers");
    assert.equal(launch.options.env?.CLAUDE_CODE_MESSAGING_TOKEN, null, "strips inherited parent messaging token");
    assert.equal(launch.options.env?.CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_ENTRYPOINT);
    assert.equal(launch.options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(launch.options.env?.[RAFT_CONTINUATION_TOOL_ENV], CONTINUATION_ANSWER_TOOL_NAME);
    assert.equal(launch.options.env?.ANTHROPIC_API_KEY, "host-key-kept-for-default-provider", "default provider preserves inherited host auth");
    assert.deepEqual(launch.options.mcpServers, [{
      name: "raft_managed_mcp",
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer tok-1" },
    }]);

    // Every option we set must be accepted by OAR 0.123+'s real claudeRuntime.
    const refused = oarInstalledSessionCapabilities(claudeRuntime, launch.installation).refusedSessionOptions ?? {};
    for (const key of Object.keys(launch.options) as Array<keyof typeof refused>) {
      assert.equal(refused[key], undefined, `option ${String(key)} must not be refused by claudeRuntime`);
    }
    assert.equal(refused.mcpServerCredentials, undefined);
  });
});

test("prepareClaudeOarLaunch maps fast mode, effort, model, and resume onto OAR SessionOptions", async () => {
  await withTempDir(async (cwd) => {
    const claudeRuntime = await loadOarSessionRuntime("claude");
    const launch = await prepareClaudeOarLaunch(makeSpawnContext(cwd, {
      sessionId: "sess-claude-42",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        model: { kind: "preset", id: "opus" },
        reasoningEffort: "high",
        mode: { kind: "fast" },
      },
    }), {
      loadRuntime: async () => claudeRuntime,
      resolveCommand: async () => "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude",
      prepareTransport: fakeTransport({ PATH: "/usr/bin" }),
      prepareManagedMcp: async () => ({ endpoint: null, hasContinuationRunner: false }),
      inheritedEnv: { PATH: "/usr/bin" },
      platform: "darwin",
    });

    assert.equal(launch.options.model, "opus");
    assert.equal(launch.options.effort, "high");
    assert.equal(launch.options.serviceTier, "fast");
    assert.equal(launch.options.resume, "sess-claude-42");
    assert.equal(launch.options.mcpServers, undefined);
    assert.equal(launch.options.env?.[RAFT_CONTINUATION_TOOL_ENV], undefined);
  });
});

test("prepareClaudeOarLaunch isolates custom providers (auth_token + api_key, envVars=null) without stripping ambient cloud CLI env", async () => {
  await withTempDir(async (cwd) => {
    const claudeRuntime = await loadOarSessionRuntime("claude");
    const inherited: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "host-api-key",
      ANTHROPIC_AUTH_TOKEN: "host-auth-token",
      ANTHROPIC_CUSTOM_HEADERS: "X-Host: secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "host-bedrock-token",
      CLAUDE_CODE_USE_CCR_V2: "1",
      AWS_ACCESS_KEY_ID: "AKIA_AMBIENT_TOOL_KEY",
      GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp/creds.json",
    };

    // Case 1: auth_token + custom model + fast mode, with ctx.config.envVars = null
    const authTokenCtx = makeSpawnContext(cwd, {
      envVars: null,
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        model: { kind: "custom", name: "deepseek-v4" },
        mode: { kind: "fast" },
        provider: {
          kind: "custom",
          apiUrl: "https://custom.example.com/anthropic",
          authType: "auth_token",
          apiKey: "custom-provider-token",
        },
      },
    });

    const isolation = buildOarClaudeProviderIsolationEnv(authTokenCtx, claudeRuntime);
    assert.equal("ANTHROPIC_API_KEY" in isolation, true);
    assert.equal(isolation.ANTHROPIC_API_KEY, undefined);
    assert.equal("ANTHROPIC_CUSTOM_HEADERS" in isolation, true);
    assert.equal("AWS_BEARER_TOKEN_BEDROCK" in isolation, true);
    assert.equal("CLAUDE_CODE_USE_CCR_V2" in isolation, true);
    assert.equal("ANTHROPIC_AUTH_TOKEN" in isolation, false, "explicit provider auth token is kept");
    assert.equal("ANTHROPIC_BASE_URL" in isolation, false, "explicit provider base url is kept");
    assert.equal("AWS_ACCESS_KEY_ID" in isolation, false, "ambient AWS CLI env is not stripped for bash tools");
    assert.equal("GOOGLE_APPLICATION_CREDENTIALS" in isolation, false, "ambient GCP CLI env is not stripped for bash tools");

    const authTokenLaunch = await prepareClaudeOarLaunch(authTokenCtx, {
      loadRuntime: async () => claudeRuntime,
      resolveCommand: async () => "/usr/local/bin/claude",
      prepareTransport: fakeTransport(inherited),
      prepareManagedMcp: async () => ({ endpoint: null, hasContinuationRunner: false }),
      inheritedEnv: inherited,
      platform: "linux",
    });

    assert.deepEqual(authTokenLaunch.options.userConfiguration, { exclude: ["settings"] });
    assert.equal(authTokenLaunch.options.serviceTier, "fast");
    assert.equal(authTokenLaunch.options.model, "deepseek-v4");
    assert.equal(authTokenLaunch.options.env?.ANTHROPIC_AUTH_TOKEN, "custom-provider-token");
    assert.equal(authTokenLaunch.options.env?.ANTHROPIC_BASE_URL, "https://custom.example.com/anthropic");
    assert.equal(authTokenLaunch.options.env?.ANTHROPIC_API_KEY, null);
    assert.equal(authTokenLaunch.options.env?.ANTHROPIC_CUSTOM_HEADERS, null);
    assert.equal(authTokenLaunch.options.env?.CLAUDE_CODE_USE_BEDROCK, null);
    assert.equal(authTokenLaunch.options.env?.AWS_BEARER_TOKEN_BEDROCK, null);
    assert.equal(authTokenLaunch.options.env?.CLAUDE_CODE_USE_CCR_V2, null);
    assert.equal(authTokenLaunch.options.env?.AWS_ACCESS_KEY_ID, "AKIA_AMBIENT_TOOL_KEY");
    assert.equal(authTokenLaunch.options.env?.GOOGLE_APPLICATION_CREDENTIALS, "/etc/gcp/creds.json");

    // Case 2: api_key custom provider with envVars = null
    const apiKeyCtx = makeSpawnContext(cwd, {
      envVars: null,
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        provider: {
          kind: "custom",
          apiUrl: "https://api-key-provider.example.com",
          authType: "api_key",
          apiKey: "sk-custom-api-key",
        },
      },
    });
    const apiKeyLaunch = await prepareClaudeOarLaunch(apiKeyCtx, {
      loadRuntime: async () => claudeRuntime,
      resolveCommand: async () => "/usr/local/bin/claude",
      prepareTransport: fakeTransport(inherited),
      prepareManagedMcp: async () => ({ endpoint: null, hasContinuationRunner: false }),
      inheritedEnv: inherited,
      platform: "linux",
    });
    assert.equal(apiKeyLaunch.options.env?.ANTHROPIC_API_KEY, "sk-custom-api-key");
    assert.equal(apiKeyLaunch.options.env?.ANTHROPIC_BASE_URL, "https://api-key-provider.example.com");
    assert.equal(apiKeyLaunch.options.env?.ANTHROPIC_AUTH_TOKEN, null);
  });
});

test("prepareClaudeOarLaunch enforces startup payload budget and declines cleanly on mismatch or missing CLI", async () => {
  await withTempDir(async (cwd) => {
    const claudeRuntime = await loadOarSessionRuntime("claude");
    await assert.rejects(
      prepareClaudeOarLaunch(makeSpawnContext(cwd, { runtime: "codex" }), {
        loadRuntime: async () => claudeRuntime,
        resolveCommand: async () => "/usr/local/bin/claude",
      }),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "claude_runtime_mismatch",
    );
    await assert.rejects(
      prepareClaudeOarLaunch(makeSpawnContext(cwd), {
        loadRuntime: async () => claudeRuntime,
        resolveCommand: async () => null,
      }),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "claude_not_found",
    );
    await assert.rejects(
      prepareClaudeOarLaunch(makeSpawnContext(cwd, {}, "x".repeat(900_000)), {
        loadRuntime: async () => claudeRuntime,
        resolveCommand: async () => "/usr/local/bin/claude",
      }),
      /startup/i,
    );
  });
});
