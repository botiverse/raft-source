import assert from "node:assert/strict";
import { test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOpenCodeConfig, buildOpenCodeLaunchOptions, detectOpenCodeModelSource, detectOpenCodeModels, isSupportedOpenCodeVersion, MIN_SUPPORTED_OPENCODE_VERSION, OpenCodeDriver, parseOpenCodeModelsOutput, requiresAgentCliFlag, resolveOpenCodeSpawn, runOpenCodeModelsCommand, unsupportedOpenCodeVersionMessage } from "./opencode.js";
import type { SpawnContext } from "./types.js";

function withTempDir(cb: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slock-opencode-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(dir, "slock-home");
  try {
    cb(dir);
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(cb: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slock-opencode-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(dir, "slock-home");
  try {
    await cb(dir);
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeSpawnContext(
  root = "/tmp/opencode-agent",
  sessionId: string | null = null,
  envVars: Record<string, string> | null = null,
): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing",
    prompt: "hello",
    workingDirectory: root,
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    launchId: "launch-1",
    config: {
      name: "OpenCode Agent",
      displayName: null,
      description: null,
      runtime: "opencode",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId,
      model: "opencode/gpt-5-nano",
      reasoningEffort: null,
      envVars: envVars ?? {
        OPENAI_API_KEY: "test-openai-key",
        XDG_DATA_HOME: "/tmp/host-should-not-win",
      },
      runtimeContext: {
        agentId: "agent-1",
        serverId: "server-1",
        machineId: "machine-1",
        machineName: "Dev Machine",
        machineHostname: "host.local",
        machineOs: "darwin arm64",
        daemonVersion: "0.42.0",
        workspacePath: root,
      },
    },
  };
}

test("driver properties are correct", () => {
  const driver = new OpenCodeDriver();
  assert.equal(driver.id, "opencode");
  assert.equal(driver.supportsStdinNotification, false);
  assert.equal(driver.busyDeliveryMode, "none");
  assert.equal(driver.supportsNativeStandingPrompt, true);
  assert.equal(driver.terminateProcessOnTurnEnd, true);
  assert.equal(driver.deferSpawnUntilMessage, true);
});

test("driver defers system first-message onboarding wake", () => {
  const driver = new OpenCodeDriver();
  assert.equal(driver.shouldDeferWakeMessage({
    channel_id: "all-id",
    channel_name: "all",
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "human",
    content: "First message task (system-triggered):\nPlease post in #all now.",
    timestamp: "2026-05-01T00:00:00.000Z",
  }), true);
  assert.equal(driver.shouldDeferWakeMessage({
    channel_id: "dm-id",
    channel_name: "tygg",
    channel_type: "dm",
    sender_id: "human-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "please reply",
    timestamp: "2026-05-01T00:00:00.000Z",
    message_id: "msg-1",
  }), false);
});

test("version gate rejects OpenCode versions before the flush/exit fix", () => {
  assert.equal(MIN_SUPPORTED_OPENCODE_VERSION, "1.14.30");
  assert.equal(isSupportedOpenCodeVersion("1.14.20"), false);
  assert.equal(isSupportedOpenCodeVersion("opencode 1.14.29"), false);
  assert.equal(isSupportedOpenCodeVersion("1.14.30"), true);
  assert.equal(isSupportedOpenCodeVersion("1.14.31"), true);
  assert.equal(isSupportedOpenCodeVersion("2.0.0"), true);
  assert.equal(isSupportedOpenCodeVersion("unknown"), true);
  assert.equal(isSupportedOpenCodeVersion(null), true);
  assert.match(unsupportedOpenCodeVersionMessage("1.14.20") ?? "", /requires OpenCode >= 1\.14\.30/);
  assert.equal(unsupportedOpenCodeVersionMessage("1.14.30"), null);
});

test("requiresAgentCliFlag is true before 1.15.0 and false from 1.15.0 onward", () => {
  assert.equal(requiresAgentCliFlag("1.14.30"), true);
  assert.equal(requiresAgentCliFlag("1.14.31"), true);
  assert.equal(requiresAgentCliFlag("1.15.0"), false);
  assert.equal(requiresAgentCliFlag("1.15.1"), false);
  assert.equal(requiresAgentCliFlag("2.0.0"), false);
  assert.equal(requiresAgentCliFlag(null), true);
  assert.equal(requiresAgentCliFlag("unknown"), true);
});

test("resolveOpenCodeSpawn launches Windows native exe without shell", () => {
  const resolvedExe = "C:\\Users\\bot\\AppData\\Local\\OpenCode\\opencode.exe";
  const spec = resolveOpenCodeSpawn(["run", "--", "New message received:\nbody"], {
    platform: "win32",
    execFileSyncFn: ((command: string) => {
      assert.equal(command, "powershell.exe");
      return Buffer.from(`${resolvedExe}\r\n`);
    }) as any,
  });

  assert.deepEqual(spec, {
    command: resolvedExe,
    args: ["run", "--", "New message received:\nbody"],
    shell: false,
  });
});

test("resolveOpenCodeSpawn rejects a missing non-Windows binary", () => {
  assert.throws(
    () => resolveOpenCodeSpawn(["run"], {
      platform: "darwin",
      execFileSyncFn: (() => {
        throw new Error("not found");
      }) as any,
    }),
    /Cannot resolve OpenCode CLI on PATH/,
  );
});

test("probe marks a missing non-Windows binary unavailable", () => {
  const result = new OpenCodeDriver().probe({
    platform: "darwin",
    execFileSyncFn: (() => {
      throw new Error("not found");
    }) as any,
  });

  assert.deepEqual(result, { available: false });
});

test("resolveOpenCodeSpawn bypasses Windows npm cmd shim and launches package exe", () => {
  const npmBin = "C:\\Users\\bot\\AppData\\Roaming\\npm";
  const npmRoot = `${npmBin}\\node_modules`;
  const packageExe = `${npmRoot}\\opencode-ai\\bin\\opencode.exe`;
  const spec = resolveOpenCodeSpawn(["run", "--", "line 1\nline 2"], {
    platform: "win32",
    execFileSyncFn: ((command: string) => {
      if (command === "powershell.exe") return Buffer.from(`${npmBin}\\opencode.cmd\r\n`);
      if (command === "npm") return Buffer.from(`${npmRoot}\r\n`);
      throw new Error(`unexpected command ${command}`);
    }) as any,
    existsSyncFn: (candidate) => candidate === packageExe,
  });

  assert.deepEqual(spec, {
    command: packageExe,
    args: ["run", "--", "line 1\nline 2"],
    shell: false,
  });
});

test("resolveOpenCodeSpawn enables Node mode for a packaged Electron JS entry", () => {
  const electronExecutable = String.raw`C:\Program Files\Raft\Raft.exe`;
  const npmBin = String.raw`C:\Users\bot\AppData\Roaming\npm`;
  const npmRoot = `${npmBin}\\node_modules`;
  const packageJs = `${npmRoot}\\opencode-ai\\bin\\opencode.js`;
  const spec = resolveOpenCodeSpawn(["run", "--", "hello"], {
    platform: "win32",
    env: { BASE_ENV: "present" },
    execPath: electronExecutable,
    execIsElectron: true,
    execFileSyncFn: ((command: string) => {
      if (command === "powershell.exe") return Buffer.from(`${npmBin}\\opencode.cmd\r\n`);
      if (command === "npm") return Buffer.from(`${npmRoot}\r\n`);
      throw new Error(`unexpected command ${command}`);
    }) as any,
    existsSyncFn: (candidate) => candidate === packageJs,
    windowsEnvironmentReaderFn: () => ({}),
  });

  assert.equal(spec.command, electronExecutable);
  assert.deepEqual(spec.args, [packageJs, "run", "--", "hello"]);
  assert.equal(spec.shell, false);
  assert.equal(spec.env?.BASE_ENV, "present");
  assert.equal(spec.env?.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveOpenCodeSpawn parses Windows cmd shim target when npm root is unavailable", () => {
  const pnpmBin = "C:\\Users\\bot\\AppData\\Local\\pnpm";
  const packageExe = "C:\\Users\\bot\\AppData\\Local\\node_modules\\.pnpm\\opencode-ai@1.15.4\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const spec = resolveOpenCodeSpawn(["run"], {
    platform: "win32",
    execFileSyncFn: ((command: string) => {
      if (command === "powershell.exe") return Buffer.from(`${pnpmBin}\\opencode.cmd\r\n`);
      throw new Error("npm unavailable");
    }) as any,
    readFileSyncFn: ((candidate: string) => {
      assert.equal(candidate, `${pnpmBin}\\opencode.cmd`);
      return `"%~dp0\\..\\node_modules\\.pnpm\\opencode-ai@1.15.4\\node_modules\\opencode-ai\\bin\\opencode.exe" %*`;
    }) as any,
    existsSyncFn: (candidate) => candidate === packageExe,
  });

  assert.deepEqual(spec, {
    command: packageExe,
    args: ["run"],
    shell: false,
  });
});

test("spawn refuses unsupported OpenCode binaries before launch", async () => {
  await withTempDirAsync(async (root) => {
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const opencodeBin = path.join(binDir, "opencode");
    writeFileSync(opencodeBin, "#!/bin/sh\necho '1.14.20'\n", "utf8");
    chmodSync(opencodeBin, 0o755);

    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      await assert.rejects(
        new OpenCodeDriver().spawn(makeSpawnContext(root)),
        /OpenCode CLI 1\.14\.20 is unsupported; requires OpenCode >= 1\.14\.30/,
      );
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });
});

test("buildOpenCodeConfig does not inject a runtime-control MCP server", () => {
  withTempDir((home) => {
    const config = buildOpenCodeConfig(makeSpawnContext(), home) as any;
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.agent.slock.description, "Slock agent runtime");
    assert.equal(config.agent.slock.prompt, "standing");
    assert.deepEqual(config.mcp, {});
    assert.doesNotMatch(JSON.stringify(config), /chat-bridge|runtime-actions-only/);
  });
});

test("buildOpenCodeConfig preserves user MCP config without owning a chat server", () => {
  withTempDir((home) => {
    const config = buildOpenCodeConfig(makeSpawnContext(
      "/tmp/opencode-agent",
      null,
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { custom: { npm: "@ai-sdk/openai" } },
          agent: {
            helper: {
              prompt: "helper prompt",
            },
            slock: {
              tools: {
                edit: false,
              },
              prompt: "stale prompt",
            },
          },
          tools: { "some_tool": false },
          mcp: {
            other: {
              type: "local",
              command: ["node", "other.js"],
            },
            chat: {
              type: "local",
              command: ["node", "stale-chat.js"],
            },
          },
        }),
      },
    ), home) as any;

    assert.deepEqual(config.provider, { custom: { npm: "@ai-sdk/openai" } });
    assert.deepEqual(config.tools, { "some_tool": false });
    assert.deepEqual(config.agent.helper, { prompt: "helper prompt" });
    assert.equal(config.agent.slock.prompt, "standing");
    assert.deepEqual(config.agent.slock.tools, { edit: false });
    assert.deepEqual(config.mcp.other, { type: "local", command: ["node", "other.js"] });
    assert.deepEqual(config.mcp.chat, { type: "local", command: ["node", "stale-chat.js"] });
  });
});

test("buildOpenCodeConfig adds managed MCP without exposing upstream endpoint or headers", () => {
  withTempDir((home) => {
    const config = buildOpenCodeConfig(
      makeSpawnContext(),
      home,
      { name: "raft_managed", url: "http://127.0.0.1:43123/mcp/opaque" },
    ) as any;
    assert.deepEqual(config.mcp.raft_managed, {
      type: "remote",
      url: "http://127.0.0.1:43123/mcp/opaque",
      enabled: true,
    });
    assert.doesNotMatch(JSON.stringify(config), /Authorization|private\.example/);
  });
});

test("parseOpenCodeModelsOutput parses OpenCode CLI model output", () => {
  const detected = parseOpenCodeModelsOutput([
    "opencode/gpt-5-nano",
    "fusecode/opus[1m]",
    "openrouter/anthropic/claude-opus-4.5",
    "",
    "{",
    "  \"id\": \"ignored-verbose-json\"",
    "}",
  ].join("\n"));

  assert.ok(detected);
  assert.deepEqual(detected!.models, [
    { id: "opencode/gpt-5-nano", label: "GPT 5 Nano · OpenCode Zen", verified: "launchable" },
    { id: "fusecode/opus[1m]", label: "Opus 1M · FuseCode", verified: "launchable" },
    { id: "openrouter/anthropic/claude-opus-4.5", label: "Claude Opus 4.5 · Anthropic via OpenRouter", verified: "launchable" },
  ]);
});

test("parseOpenCodeModelsOutput formats provider-aware display labels", () => {
  const detected = parseOpenCodeModelsOutput([
    "opencode-go/deepseek-v4-pro",
    "openai/gpt-5.5",
    "unknown-provider/glm-5-air",
  ].join("\n"));

  assert.ok(detected);
  assert.deepEqual(detected!.models, [
    { id: "opencode-go/deepseek-v4-pro", label: "DeepSeek V4 Pro · OpenCode Go", verified: "launchable" },
    { id: "openai/gpt-5.5", label: "GPT 5.5 · OpenAI", verified: "launchable" },
    { id: "unknown-provider/glm-5-air", label: "GLM 5 Air · Unknown Provider", verified: "launchable" },
  ]);
});

test("detectOpenCodeModels uses opencode models output as source of truth", () => {
  withTempDir((home) => {
    const configDir = path.join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
      provider: {
        fusecode: {
          npm: "@ai-sdk/anthropic",
          name: "FuseCode Claude Code API",
          models: {
            "opus[1m]": {
              name: "FuseCode Opus 1M",
            },
          },
        },
      },
    }));

    const detected = detectOpenCodeModels(home, () => ({
      status: 0,
      stdout: [
        "opencode/gpt-5-nano",
        "fusecode/opus[1m]",
        "openrouter/anthropic/claude-opus-4.5",
      ].join("\n"),
    }));
    assert.ok(detected);
    assert.ok(detected.models.some((model) => (
      model.id === "opencode/gpt-5-nano" && model.verified === "launchable"
    )));
    assert.ok(detected.models.some((model) => (
      model.id === "fusecode/opus[1m]" && model.label === "Opus 1M · FuseCode" && model.verified === "launchable"
    )));
    assert.ok(detected.models.some((model) => (
      model.id === "openrouter/anthropic/claude-opus-4.5" && model.verified === "launchable"
    )));
  });
});

test("runOpenCodeModelsCommand uses shell on Windows for npm shim resolution", () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const result = runOpenCodeModelsCommand("/tmp/opencode-home", {
    platform: "win32",
    spawnSyncFn: ((command: string, args: readonly string[], options?: Record<string, unknown>) => {
      calls.push({ command, args: [...args], options: options ?? {} });
      return {
        status: 0,
        stdout: "mimo/mimo-v2.5-pro\n",
        stderr: "",
      } as ReturnType<typeof import("node:child_process").spawnSync>;
    }) as typeof import("node:child_process").spawnSync,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "opencode");
  assert.deepEqual(calls[0]?.args, ["models"]);
  assert.equal(calls[0]?.options.shell, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "mimo/mimo-v2.5-pro\n");
});

test("detectOpenCodeModels returns null when opencode models fails", () => {
  withTempDir((home) => {
    const configDir = path.join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), "{not-json");

    const detected = detectOpenCodeModels(home, () => ({
      status: 1,
      stdout: "",
      error: new Error("opencode models failed"),
    }));
    assert.equal(detected, null);
  });
});

test("detectOpenCodeModelSource keeps command failure and empty success distinct", () => {
  assert.deepEqual(detectOpenCodeModelSource("/tmp/opencode-home", () => ({
    status: 1,
    stdout: "",
    error: new Error("opencode models failed"),
  })), { kind: "error", retryable: true });

  assert.deepEqual(detectOpenCodeModelSource("/tmp/opencode-home", () => ({
    status: 0,
    stdout: "",
  })), { kind: "no_models" });
});

test("buildOpenCodeLaunchOptions carries local provider config used by launch", async () => {
  await withTempDirAsync(async (root) => {
    const home = path.join(root, "home");
    const configDir = path.join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
      provider: {
        fusecode: {
          npm: "@ai-sdk/anthropic",
          models: {
            "opus[1m]": { name: "FuseCode Opus 1M" },
          },
        },
      },
    }));

    const detected = detectOpenCodeModels(home, () => ({
      status: 0,
      stdout: [
        "opencode/gpt-5-nano",
        "fusecode/opus[1m]",
      ].join("\n"),
    }));
    assert.ok(detected?.models.some((model) => model.id === "fusecode/opus[1m]"));

    const ctx = makeSpawnContext(root, null, { OPENAI_API_KEY: "test-openai-key" });
    ctx.config.model = "fusecode/opus[1m]";
    const launch = await buildOpenCodeLaunchOptions(ctx, home);
    const envConfig = JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)) as any;

    assert.equal(envConfig.provider.fusecode.models["opus[1m]"].name, "FuseCode Opus 1M");
    assert.equal(envConfig.agent.slock.prompt, "standing");
    assert.deepEqual(envConfig.mcp, {});
    assert.deepEqual(launch.args.slice(0, 9), [
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--pure",
      "--dir",
      root,
      "--model",
      "fusecode/opus[1m]",
    ]);
  });
});

test("launchable OpenCode model spec is derived from the same provider config as spawn", async () => {
  await withTempDirAsync(async (root) => {
    const home = path.join(root, "home");
    const configDir = path.join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
      provider: {
        fusecode: {
          npm: "@ai-sdk/anthropic",
          models: {
            "opus[1m]": { name: "FuseCode Opus 1M" },
          },
        },
      },
    }));

    const detected = detectOpenCodeModels(home, () => ({
      status: 0,
      stdout: [
        "opencode/gpt-5-nano",
        "fusecode/opus[1m]",
      ].join("\n"),
    }));
    assert.ok(detected?.models.some((model) => (
      model.id === "fusecode/opus[1m]" && model.verified === "launchable"
    )));

    const ctx = makeSpawnContext(root, null, { OPENAI_API_KEY: "test-openai-key" });
    const launchCtx = {
      ...ctx,
      config: {
        ...ctx.config,
        model: "fusecode/opus[1m]",
      },
    };
    const version = "1.16.2";
    const expectedLaunch = await buildOpenCodeLaunchOptions(launchCtx, home, version);
    const spec = await new OpenCodeDriver().model.toLaunchSpec?.("fusecode/opus[1m]", ctx, {
      home,
      readVersion: () => version,
    });

    assert.ok(spec);
    assert.deepEqual(spec.args, expectedLaunch.args);
    assert.equal(spec.env?.OPENCODE_CONFIG_CONTENT, expectedLaunch.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(spec.config, expectedLaunch.config);
    assert.equal(ctx.config.model, "opencode/gpt-5-nano");

    const envConfig = JSON.parse(String(spec.env?.OPENCODE_CONFIG_CONTENT)) as any;
    assert.equal(envConfig.provider.fusecode.models["opus[1m]"].name, "FuseCode Opus 1M");
    assert.equal(envConfig.agent.slock.prompt, "standing");
    assert.deepEqual(envConfig.mcp, {});
  });
});

test("OpenCode model launch spec uses the injected CLI version instead of the host installation", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    const driver = new OpenCodeDriver();
    const versions = ["1.14.30", "1.16.2"];
    let reads = 0;

    const beforeCutoff = await driver.model.toLaunchSpec?.("fusecode/opus[1m]", ctx, {
      home: root,
      readVersion: () => {
        reads += 1;
        return versions[0];
      },
    });
    const afterCutoff = await driver.model.toLaunchSpec?.("fusecode/opus[1m]", ctx, {
      home: root,
      readVersion: () => {
        reads += 1;
        return versions[1];
      },
    });

    assert.ok(beforeCutoff?.args?.includes("--agent"));
    assert.equal(afterCutoff?.args?.includes("--agent"), false);
    assert.equal(reads, 2);
  });
});

test("buildOpenCodeLaunchOptions preserves host XDG state and injects env config", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root, "ses_existing", {
      OPENAI_API_KEY: "test-openai-key",
      XDG_CONFIG_HOME: "/host/xdg/config",
      XDG_DATA_HOME: "/host/xdg/data",
      XDG_CACHE_HOME: "/host/xdg/cache",
      XDG_STATE_HOME: "/host/xdg/state",
    });
    const launch = await buildOpenCodeLaunchOptions(ctx, root);

    assert.deepEqual(launch.args, [
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
      "--pure",
      "--dir",
      root,
      "--model",
      "opencode/gpt-5-nano",
      "--agent",
      "slock",
      "--session",
      "ses_existing",
      "--",
      "hello",
    ]);
    assert.equal(launch.env.OPENAI_API_KEY, "test-openai-key");
    assert.equal(launch.env.SLOCK_AGENT_ID, "agent-1");
    assert.equal(launch.env.SLOCK_SERVER_URL, "https://slock.example");
    assert.equal(launch.env.SLOCK_AGENT_TOKEN, undefined);
    const transportDir = String(launch.env.PATH || "").split(path.delimiter)[0];
    assert.ok(transportDir.startsWith(path.join(process.env.SLOCK_HOME!, "cli-transport", "agent-1", "launch-1")));
    assert.ok(!transportDir.startsWith(path.join(root, ".slock")), "transport files should not live in the model workspace");
    assert.equal(launch.env.XDG_CONFIG_HOME, "/host/xdg/config");
    assert.equal(launch.env.XDG_DATA_HOME, "/host/xdg/data");
    assert.equal(launch.env.XDG_CACHE_HOME, "/host/xdg/cache");
    assert.equal(launch.env.XDG_STATE_HOME, "/host/xdg/state");

    const envConfig = JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)) as any;
    assert.equal(envConfig.agent.slock.prompt, "standing");
    assert.deepEqual(envConfig.mcp, {});
    assert.deepEqual(envConfig, launch.config);
  });
});

test("buildOpenCodeLaunchOptions sends neutral startup input when standing prompt lives in config", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    ctx.prompt = ctx.standingPrompt;
    const launch = await buildOpenCodeLaunchOptions(ctx, root);

    assert.deepEqual(launch.args.slice(-2), ["--", "No new messages are pending. Stop now."]);
    assert.equal(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).agent.slock.prompt, "standing");
  });
});

test("buildOpenCodeLaunchOptions keeps native standing prompt separate from dynamic turn input", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    ctx.standingPrompt = "static raft CLI guide";
    ctx.prompt = "[Raft inbox notice:\nInbox update: 1 unread message total\n]";
    const launch = await buildOpenCodeLaunchOptions(ctx, root);

    assert.deepEqual(launch.args.slice(-2), ["--", ctx.prompt]);
    const config = JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)) as any;
    assert.equal(config.agent.slock.prompt, "static raft CLI guide");
    assert.doesNotMatch(launch.args.at(-1) ?? "", /static raft CLI guide/);
  });
});

test("buildOpenCodeLaunchOptions includes --agent for versions before 1.15.0", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "1.14.30");

    assert.ok(launch.args.includes("--agent"));
    assert.ok(launch.args.includes("slock"));
    assert.equal(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).agent.slock.prompt, "standing");
  });
});

test("buildOpenCodeLaunchOptions omits --agent for versions 1.15.0 and later", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "1.15.0");

    assert.equal(launch.args.includes("--agent"), false);
    assert.equal(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).agent.slock.prompt, "standing");
  });
});

test("buildOpenCodeLaunchOptions omits --agent for 1.15.1", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "1.15.1");

    assert.equal(launch.args.includes("--agent"), false);
    assert.equal(launch.args.includes("slock"), false);
    assert.equal(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).agent.slock.prompt, "standing");
  });
});

test("parseLine: step_start emits session_init once and thinking", () => {
  const driver = new OpenCodeDriver();
  const first = driver.parseLine(JSON.stringify({
    type: "step_start",
    timestamp: 1777612929268,
    sessionID: "ses_1",
    part: {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "step-start",
    },
  }));
  assert.deepEqual(first, [
    { kind: "session_init", sessionId: "ses_1" },
    { kind: "thinking", text: "" },
  ]);

  const second = driver.parseLine(JSON.stringify({
    type: "step_start",
    sessionID: "ses_1",
    part: { type: "step-start" },
  }));
  assert.deepEqual(second, [{ kind: "thinking", text: "" }]);
});

test("parseLine: text event emits assistant text", () => {
  const driver = new OpenCodeDriver();
  driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }));

  const events = driver.parseLine(JSON.stringify({
    type: "text",
    sessionID: "ses_1",
    part: { type: "text", text: "Hello" },
  }));
  assert.deepEqual(events, [{ kind: "text", text: "Hello" }]);
});

test("parseLine: tool_use event emits completed tool_call", () => {
  const driver = new OpenCodeDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "tool_use",
    sessionID: "ses_tool",
    part: {
      type: "tool",
      tool: "glob",
      callID: "call_1",
      state: {
        status: "completed",
        input: { pattern: "*", path: "." },
        output: "...",
      },
    },
  }));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "session_init", sessionId: "ses_tool" });
  assert.deepEqual(events[1], {
    kind: "tool_call",
    name: "glob",
    input: { pattern: "*", path: "." },
  });
});

test("parseLine: tool-calls step_finish is an internal boundary, final stop ends the turn", () => {
  const driver = new OpenCodeDriver();
  driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_turn", part: { type: "step-start" } }));

  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "step_finish",
    sessionID: "ses_turn",
    part: { type: "step-finish", reason: "tool-calls" },
  })), []);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "step_finish",
    sessionID: "ses_turn",
    part: { type: "step-finish", reason: "stop" },
  })), [{ kind: "turn_end", sessionId: "ses_turn" }]);
});

test("parseLine: error event has no part wrapper", () => {
  const driver = new OpenCodeDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "error",
    sessionID: "ses_err",
    error: {
      name: "UnknownError",
      data: { message: "Model not found: anthropic/claude-sonnet-4-5." },
    },
  }));
  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "ses_err" },
    { kind: "error", message: "Model not found: anthropic/claude-sonnet-4-5." },
    { kind: "turn_end", sessionId: "ses_err" },
  ]);
});

test("parseLine: invalid JSON returns empty", () => {
  const driver = new OpenCodeDriver();
  assert.deepEqual(driver.parseLine("Performing one time database migration"), []);
  assert.deepEqual(driver.parseLine(""), []);
});

test("encodeStdinMessage always returns null", () => {
  const driver = new OpenCodeDriver();
  assert.equal(driver.encodeStdinMessage("hello", "s1"), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "idle" }), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "busy" }), null);
});
