import assert from "node:assert/strict";
import { ELECTRON_NODE_SCRIPT_EXEC_ARGV } from "./nodeHostLaunch";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOpenCodeConfig, buildOpenCodeLaunchOptions, decideOpenCodeSessionResume, detectOpenCodeModelSource, detectOpenCodeModels, isOpenCodeV2Launch, isSupportedOpenCodeVersion, MIN_SUPPORTED_OPENCODE_VERSION, OPENCODE_V2_MIN_VERSION, openCodeMajor, openCodeSessionRecordPath, OpenCodeDriver, parseOpenCodeModelsOutput, readOpenCodeSessionRecord, requiresAgentCliFlag, resolveOpenCodeSpawn, runOpenCodeModelsCommand, unsupportedOpenCodeVersionMessage, writeOpenCodeSessionRecord } from "./opencode";
import { RuntimeExecutableNotFoundError, RuntimeSessionRuntimeMismatchError } from "../spawnFailureErrors";
import { classifySpawnFailure } from "../spawnFailureClassification";
import { NON_RETRYABLE_SPAWN_FAILURE_REASONS } from "@botiverse/raft-shared";
import { readCommandVersionAsync, readCommandVersionDetailedAsync } from "./probe";
import { ProbeChildError } from "./probeChild";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import type { ParsedEvent, SpawnContext } from "./types";

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

test("probe marks a missing non-Windows binary unavailable as not_installed", () => {
  const result = new OpenCodeDriver().probe({
    platform: "darwin",
    homeDir: "/nonexistent-home",
    existsSyncFn: () => false,
    execFileSyncFn: (() => {
      throw Object.assign(new Error("not found"), { status: 1 });
    }) as any,
  });

  assert.deepEqual(result, { available: false, unavailableReason: "not_installed" });
});

test("probe marks an installed but unsupported OpenCode as unsupported_version, not not_installed", () => {
  const result = new OpenCodeDriver().probe({
    platform: "darwin",
    execFileSyncFn: ((command: string) => {
      if (command === "which") return Buffer.from("/opt/opencode/bin/opencode\n");
      return Buffer.from("1.14.20\n");
    }) as any,
  });

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, "unsupported_version");
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
  assert.deepEqual(spec.args, [...ELECTRON_NODE_SCRIPT_EXEC_ARGV, packageJs, "run", "--", "hello"]);
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

test("runOpenCodeModelsCommand on Windows runs the resolved executable without a shell", () => {
  const resolvedExe = "C:\\Users\\tester\\AppData\\Local\\opencode\\bin\\opencode.exe";
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const result = runOpenCodeModelsCommand("/tmp/opencode-home", {
    platform: "win32",
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string) => {
      assert.equal(command, "powershell.exe");
      return Buffer.from(`${resolvedExe}\r\n`);
    }) as any,
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
  assert.equal(calls[0]?.command, resolvedExe);
  assert.deepEqual(calls[0]?.args, ["models"]);
  assert.equal(calls[0]?.options.shell, false);
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
    ctx.prompt = "[Raft inbox notice:\nInbox update: 1 message pending your read across all conversations\n]";
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
    assert.equal(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).default_agent, undefined, "older versions select the agent with --agent");
  });
});

test("buildOpenCodeLaunchOptions omits --agent for versions 1.15.0 and later", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root);
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "1.15.0");

    assert.equal(launch.args.includes("--agent"), false);
    const config = JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT));
    assert.equal(config.agent.slock.prompt, "standing");
    // Without --agent, opencode run picks default_agent; otherwise its own `build` agent and prompt.
    assert.equal(config.default_agent, "slock");
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
  // task #26: OpenCode prints a call only once it has finished, so the one
  // event is both its start and its end; it used to leave the call open.
  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "ses_tool" },
    { kind: "tool_call", name: "glob", input: { pattern: "*", path: "." }, callId: "call_1" },
    { kind: "tool_output", name: "glob", callId: "call_1", ok: true },
  ]);
});

test("parseLine: tool_use carries the exit code and duration, 1.x and 2.x shapes, once per call", () => {
  const driver = new OpenCodeDriver();
  const v1 = {
    type: "tool_use",
    part: {
      type: "tool", tool: "bash", callID: "call_1",
      state: { status: "completed", input: { command: "false" }, metadata: { exit: 1 }, time: { start: 1000, end: 1250 } },
    },
  };
  assert.deepEqual(driver.parseLine(JSON.stringify(v1)), [
    { kind: "tool_call", name: "bash", input: { command: "false" }, callId: "call_1" },
    { kind: "tool_output", name: "bash", callId: "call_1", ok: true, exitCode: 1, durationMs: 250 },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify(v1)), [], "the same call printed twice is reported once");

  // 2.x: the call id is `part.id` and the exit code sits one level deeper.
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool_use",
    part: {
      type: "tool", tool: "bash", id: "call_2", partID: "prt_2",
      state: { status: "completed", input: { command: "true" }, metadata: { metadata: { exit: 0 } }, time: { start: 5, end: 9 } },
    },
  })), [
    { kind: "tool_call", name: "bash", input: { command: "true" }, callId: "call_2" },
    { kind: "tool_output", name: "bash", callId: "call_2", ok: true, exitCode: 0, durationMs: 4 },
  ]);

  // An aborted or rejected call is printed with status "error".
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool_use",
    part: { type: "tool", tool: "edit", callID: "call_3", state: { status: "error", input: {}, error: "Tool execution aborted" } },
  })).at(-1), { kind: "tool_output", name: "edit", callId: "call_3", ok: false });
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

// ---------------------------------------------------------------------------
// task #1258 — OpenCode 2.x launch contract and cross-major session refusal
// ---------------------------------------------------------------------------

test("task #1258: 2.x is admitted only from the verified 2.0.27 up to (not including) 3.0", () => {
  assert.equal(OPENCODE_V2_MIN_VERSION, "2.0.27");
  assert.equal(openCodeMajor("2.0.27"), 2);
  assert.equal(openCodeMajor("1.18.35"), 1);
  assert.equal(openCodeMajor("v3.1.0"), 3);
  assert.equal(openCodeMajor(null), null);
  assert.equal(openCodeMajor("garbage"), null);

  assert.equal(isOpenCodeV2Launch("2.0.26"), false, "early beta below the verified build");
  assert.equal(isOpenCodeV2Launch("2.0.27"), true);
  assert.equal(isOpenCodeV2Launch("2.9.0"), true, "proposed range, admitted on the beta's word");
  assert.equal(isOpenCodeV2Launch("3.0.0"), false);
  assert.equal(isOpenCodeV2Launch("1.19.0"), false);
  assert.equal(isOpenCodeV2Launch(null), false);

  assert.match(unsupportedOpenCodeVersionMessage("3.0.0") ?? "", /3\.0\.0 is not supported yet/);
  assert.match(unsupportedOpenCodeVersionMessage("2.0.26") ?? "", /early 2\.0 beta below 2\.0\.27/);
  assert.equal(unsupportedOpenCodeVersionMessage("2.0.27"), null);
  assert.equal(unsupportedOpenCodeVersionMessage("1.19.0"), null);
  assert.match(unsupportedOpenCodeVersionMessage("1.14.20") ?? "", /requires OpenCode >= 1\.14\.30/);
  assert.equal(unsupportedOpenCodeVersionMessage(null), null, "an unreadable version keeps the 1.x path as before");
});

test("task #1258: buildOpenCodeLaunchOptions on 2.x uses the standalone contract and isolates config sources", async () => {
  await withTempDirAsync(async (root) => {
    // A user-level opencode.json with a plugin list and a provider: the
    // provider must reach 2.x through the injected document, the plugin
    // list must not (1.x `--pure` parity).
    const configDir = path.join(root, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
      plugin: ["/somewhere/user-plugin"],
      provider: { fusecode: { npm: "@ai-sdk/anthropic", models: { "opus[1m]": { name: "FuseCode Opus 1M" } } } },
    }));
    const ctx = makeSpawnContext(root, "ses_existing", { OPENAI_API_KEY: "test-openai-key" });
    ctx.slockHome = process.env.SLOCK_HOME!;
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "2.0.27");

    assert.deepEqual(launch.args, [
      "run",
      "--standalone",
      "--format",
      "json",
      "--auto",
      "--model",
      "opencode/gpt-5-nano",
      "--agent",
      "slock",
      "--session",
      "ses_existing",
      "--",
      "hello",
    ]);
    for (const removed of ["--dangerously-skip-permissions", "--pure", "--dir"]) {
      assert.equal(launch.args.includes(removed), false, `${removed} does not exist on 2.x`);
    }
    assert.equal(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
    const emptyDir = String(launch.env.OPENCODE_CONFIG_DIR);
    assert.equal(emptyDir, path.join(process.env.SLOCK_HOME!, "opencode-config-empty"));
    assert.deepEqual(readdirSync(emptyDir), [], "the config directory handed to 2.x exists and is empty");
    const config = JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT));
    assert.equal(config.agent.slock.prompt, "standing");
    assert.equal(config.default_agent, undefined, "2.x selects the agent with --agent");
    assert.equal(config.plugin, undefined, "no plugin list travels through the injected document on 2.x");
    assert.equal(config.provider.fusecode.models["opus[1m]"].name, "FuseCode Opus 1M", "the user's provider config still reaches 2.x");
    assert.deepEqual(config, launch.config);
  });
});

test("task #1258: the 1.x launch is untouched by the 2.x branch (regression control)", async () => {
  await withTempDirAsync(async (root) => {
    const ctx = makeSpawnContext(root, "ses_existing", { OPENAI_API_KEY: "test-openai-key" });
    const configDir = path.join(root, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ plugin: ["/somewhere/user-plugin"] }));
    const launch = await buildOpenCodeLaunchOptions(ctx, root, "1.18.35");
    assert.deepEqual(launch.args.slice(0, 7), ["run", "--format", "json", "--dangerously-skip-permissions", "--pure", "--dir", root]);
    assert.equal(launch.args.includes("--standalone"), false);
    assert.equal(launch.args.includes("--auto"), false);
    assert.equal(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
    assert.equal(launch.env.OPENCODE_CONFIG_DIR, undefined);
    assert.deepEqual(JSON.parse(String(launch.env.OPENCODE_CONFIG_CONTENT)).plugin, ["/somewhere/user-plugin"], "1.x document unchanged; --pure ignores it there");
  });
});

test("task #1258: decideOpenCodeSessionResume never carries a session across majors and never guesses", () => {
  const rec = (sessionId: string, major: number) => ({ kind: "record" as const, record: { version: 1 as const, sessionId, opencodeMajor: major, opencodeVersion: `${major}.0.0`, recordedAt: "" } });
  const missing = { kind: "missing" as const };
  const unreadable = { kind: "unreadable" as const, detail: "not JSON" };
  assert.deepEqual(decideOpenCodeSessionResume(null, missing, "2.0.27"), { kind: "fresh" });
  assert.deepEqual(decideOpenCodeSessionResume("", rec("", 1), "2.0.27"), { kind: "fresh" });
  // No record: a 1.x CLI resumes as it always did; a 2.x CLI refuses rather than assume.
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", missing, "1.19.0"), { kind: "resume" });
  // task #1365: an unknown installed version decides nothing (it used to be read as 1.x).
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", missing, null), { kind: "version_unknown" });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", missing, "garbage"), { kind: "version_unknown" });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 2), null), { kind: "version_unknown" }, "a recorded 2.x session is not a major mismatch when the version is unknown");
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 1), null), { kind: "version_unknown" });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", missing, "2.0.27"), { kind: "refuse", reason: "unrecorded", recordedMajor: null });
  // A record for another session id is no evidence for this one.
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_b", 2), "2.0.27"), { kind: "refuse", reason: "unrecorded", recordedMajor: null });
  // Recorded major decides in both directions.
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 1), "2.0.27"), { kind: "refuse", reason: "major_mismatch", recordedMajor: 1 });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 2), "1.19.0"), { kind: "refuse", reason: "major_mismatch", recordedMajor: 2 });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 2), "2.0.27"), { kind: "resume" });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", rec("ses_a", 1), "1.19.0"), { kind: "resume" });
  // An unreadable record proves nothing and is refused on every major (review finding: a
  // corrupt record must not turn a 2.x session back into a resumable "legacy 1.x" one).
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", unreadable, "1.19.0"), { kind: "refuse", reason: "record_unreadable", recordedMajor: null });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", unreadable, "2.0.27"), { kind: "refuse", reason: "record_unreadable", recordedMajor: null });
  assert.deepEqual(decideOpenCodeSessionResume("ses_a", unreadable, null), { kind: "refuse", reason: "record_unreadable", recordedMajor: null });
});

test("task #1258: the session record round-trips and rejects malformed files", () => {
  withTempDir((root) => {
    const file = openCodeSessionRecordPath(path.join(root, "home"), "agent/with:odd chars");
    assert.equal(path.basename(file), "agent_with_odd_chars.json");
    assert.equal(path.basename(path.dirname(file)), "opencode-sessions");
    assert.deepEqual(readOpenCodeSessionRecord(file), { kind: "missing" }, "missing file");
    writeOpenCodeSessionRecord(file, { version: 1, sessionId: "ses_a", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "2026-10-12T00:00:00.000Z" });
    assert.deepEqual(readOpenCodeSessionRecord(file), { kind: "record", record: { version: 1, sessionId: "ses_a", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "2026-10-12T00:00:00.000Z" } });
    writeFileSync(file, "{not json", "utf8");
    assert.equal(readOpenCodeSessionRecord(file).kind, "unreadable");
    writeFileSync(file, JSON.stringify({ version: 2, sessionId: "ses_a", opencodeMajor: 2 }), "utf8");
    assert.equal(readOpenCodeSessionRecord(file).kind, "unreadable", "unknown record version");
    writeFileSync(file, JSON.stringify({ version: 1, sessionId: "ses_a", opencodeMajor: "2" }), "utf8");
    assert.equal(readOpenCodeSessionRecord(file).kind, "unreadable", "major must be an integer");
    const readError = readOpenCodeSessionRecord(file, { readFileSyncFn: (() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }) as any });
    assert.equal(readError.kind, "unreadable", "a read error other than ENOENT is not a missing file");
    // A regular file where the record directory should be (ENOTDIR) is not an absence either.
    const blockedHome = path.join(root, "blocked-home");
    mkdirSync(blockedHome, { recursive: true });
    writeFileSync(path.join(blockedHome, "opencode-sessions"), "not a directory", "utf8");
    assert.equal(readOpenCodeSessionRecord(openCodeSessionRecordPath(blockedHome, "agent-1")).kind, "unreadable");
  });
});

function recordAt(file: string) {
  const read = readOpenCodeSessionRecord(file);
  return read.kind === "record" ? read.record : null;
}

function installFakeOpenCode(root: string, version: string, runScript = ""): { binDir: string; restore: () => void } {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\n${runScript}\nexit 0\n`, "utf8");
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  return {
    binDir,
    restore: () => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    },
  };
}

test("task #1258: spawn refuses to resume a 1.x session with a 2.x CLI and leaves session and record alone", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "2.0.27");
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_old", opencodeMajor: 1, opencodeVersion: "1.18.35", recordedAt: "2026-10-01T00:00:00.000Z" });
      const before = readFileSync(recordPath, "utf8");
      const ctx = makeSpawnContext(root, "ses_old");
      ctx.slockHome = slockHome;

      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => {
        assert.ok(error instanceof RuntimeSessionRuntimeMismatchError);
        assert.equal(error.code, "session_runtime_mismatch");
        assert.equal(error.reason, "major_mismatch");
        assert.equal(error.recordedMajor, 1);
        assert.equal(error.installedVersion, "2.0.27");
        assert.match(error.message, /created by OpenCode 1\.x and cannot be resumed with the installed OpenCode 2\.0\.27/);
        return true;
      });
      assert.equal(ctx.config.sessionId, "ses_old", "the server's session id is not touched");
      assert.equal(readFileSync(recordPath, "utf8"), before, "the record is not rewritten by a refusal");

      // No record at all (a session from before 2.x support): refused too, not assumed 2.x.
      rmSync(recordPath);
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => {
        assert.ok(error instanceof RuntimeSessionRuntimeMismatchError);
        assert.equal(error.reason, "unrecorded");
        assert.equal(error.recordedMajor, null);
        assert.match(error.message, /its major version was not recorded/);
        return true;
      });
      assert.equal(existsSync(recordPath), false);
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a launch whose session record cannot be persisted is refused before the CLI runs", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "argv.txt");
    const fake = installFakeOpenCode(root, "2.0.27", `printf '%s\\n' "$@" > '${argvFile}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      mkdirSync(slockHome, { recursive: true });
      writeFileSync(path.join(slockHome, "opencode-sessions"), "a file blocks the record directory", "utf8");
      const ctx = makeSpawnContext(root, null);
      ctx.slockHome = slockHome;
      await assert.rejects(new OpenCodeDriver().spawn(ctx), /Cannot persist the OpenCode session record under .*opencode-sessions/);
      assert.equal(existsSync(argvFile), false, "the CLI was never launched");
      // Same on 1.x: provenance must be recordable before any session can be made.
      fake.restore();
      const fake1 = installFakeOpenCode(root, "1.19.0", `printf '%s\\n' "$@" > '${argvFile}'`);
      try {
        await assert.rejects(new OpenCodeDriver().spawn(ctx), /Cannot persist the OpenCode session record/);
        assert.equal(existsSync(argvFile), false);
      } finally {
        fake1.restore();
      }
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a session whose record fails to persist after launch is a runtime failure and its id never reaches the daemon", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "2.0.27", `echo '{"type":"step_start","sessionID":"ses_unrecorded","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      const ctx = makeSpawnContext(root, null);
      ctx.slockHome = slockHome;
      const driver = new OpenCodeDriver();
      const { process: child } = await driver.spawn(ctx);
      await waitForExit(child);
      // The directory was writable at launch; it is replaced by a file before the CLI reports its session.
      rmSync(path.dirname(recordPath), { recursive: true, force: true });
      writeFileSync(path.dirname(recordPath), "now a file", "utf8");
      const warned: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
      const all: ParsedEvent[] = [];
      try {
        const withId = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, sessionID: "ses_unrecorded", ...extra });
        const first = driver.parseLine(withId("step_start", { part: { type: "step-start" } }));
        all.push(...first);
        // The failure is explicit: a runtime error ends the turn, with no id on it.
        assert.deepEqual(first.map((event) => event.kind), ["error", "turn_end", "thinking"]);
        assert.match((first[0] as Extract<ParsedEvent, { kind: "error" }>).message, /session record could not be persisted .*not resumable/);
        assert.equal((first[1] as Extract<ParsedEvent, { kind: "turn_end" }>).sessionId, undefined);
        // Every later event, including the CLI's own step_finish(stop) and error, stays id-free.
        all.push(...driver.parseLine(withId("text", { part: { type: "text", text: "hi" } })));
        all.push(...driver.parseLine(withId("step_finish", { part: { type: "step-finish", reason: "stop" } })));
        all.push(...driver.parseLine(withId("error", { error: { name: "X", data: { message: "boom" } } })));
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(all.some((event) => event.kind === "session_init"), false, "no session_init without a persisted record");
      for (const event of all) {
        assert.notEqual((event as { sessionId?: string }).sessionId, "ses_unrecorded", `event carries the unrecorded id: ${JSON.stringify(event)}`);
      }
      assert.equal(JSON.stringify(all).includes("ses_unrecorded"), false, "the id appears nowhere in emitted events");
      assert.equal(warned.filter((w) => w.includes("session record could not be persisted")).length, 1, "reported once, not per line");
      assert.equal(readOpenCodeSessionRecord(recordPath).kind, "unreadable");
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a permitted resume with a matching record needs no write and keeps prior provenance", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "2.0.27", `echo '{"type":"step_start","sessionID":"ses_kept","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_kept", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "2026-10-01T00:00:00.000Z" });
      const before = readFileSync(recordPath, "utf8");
      const ctx = makeSpawnContext(root, "ses_kept");
      ctx.slockHome = slockHome;
      const driver = new OpenCodeDriver();
      const { process: child } = await driver.spawn(ctx);
      await waitForExit(child);
      // Even if the directory became unwritable now, the prior record is valid and is what the daemon resumes.
      rmSync(path.dirname(recordPath), { recursive: true, force: true });
      writeFileSync(path.dirname(recordPath), "now a file", "utf8");
      const events = driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_kept", part: { type: "step-start" } }));
      assert.deepEqual(events[0], { kind: "session_init", sessionId: "ses_kept" });
      const end = driver.parseLine(JSON.stringify({ type: "step_finish", sessionID: "ses_kept", part: { type: "step-finish", reason: "stop" } }));
      assert.deepEqual(end, [{ kind: "turn_end", sessionId: "ses_kept" }]);
      rmSync(path.dirname(recordPath), { force: true });
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, before, "utf8");
      assert.equal(readFileSync(recordPath, "utf8"), before);
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a CLI that reports a different session id than the one resumed needs a record for that id before it is announced", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "2.0.27", `echo '{"type":"step_start","sessionID":"ses_other","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_kept", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "" });
      const ctx = makeSpawnContext(root, "ses_kept");
      ctx.slockHome = slockHome;

      // Writable: the new id gets its own record, then is announced; nothing is said about ses_other before that.
      const driver = new OpenCodeDriver();
      const { process: child } = await driver.spawn(ctx);
      await waitForExit(child);
      const events = driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_other", part: { type: "step-start" } }));
      assert.deepEqual(events[0], { kind: "session_init", sessionId: "ses_other" });
      assert.equal(recordAt(recordPath)?.sessionId, "ses_other");
      assert.deepEqual(driver.parseLine(JSON.stringify({ type: "step_finish", sessionID: "ses_other", part: { type: "step-finish", reason: "stop" } })), [{ kind: "turn_end", sessionId: "ses_other" }]);

      // Unwritable: the switched-to id is a persistence failure like any other; neither id is announced for it.
      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_kept", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "" });
      const driver2 = new OpenCodeDriver();
      const { process: child2 } = await driver2.spawn(ctx);
      await waitForExit(child2);
      rmSync(path.dirname(recordPath), { recursive: true, force: true });
      writeFileSync(path.dirname(recordPath), "now a file", "utf8");
      const originalWarn = console.warn;
      console.warn = () => {};
      let all: ParsedEvent[] = [];
      try {
        all = [
          ...driver2.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_other", part: { type: "step-start" } })),
          ...driver2.parseLine(JSON.stringify({ type: "step_finish", sessionID: "ses_other", part: { type: "step-finish", reason: "stop" } })),
        ];
      } finally {
        console.warn = originalWarn;
      }
      assert.deepEqual(all.map((event) => event.kind), ["error", "turn_end", "thinking", "turn_end"]);
      assert.equal(JSON.stringify(all).includes("ses_other"), false);
      assert.equal(all.some((event) => event.kind === "session_init"), false);
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a corrupt session record refuses the resume on a 1.x CLI too and is left for inspection", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "1.19.0", `echo '{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, "{\"version\":1,\"sessionId\":\"ses_x\",\"opencodeMajor\":2", "utf8"); // truncated 2.x record
      const ctx = makeSpawnContext(root, "ses_x");
      ctx.slockHome = slockHome;
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => {
        assert.ok(error instanceof RuntimeSessionRuntimeMismatchError);
        assert.equal(error.reason, "record_unreadable");
        assert.match(error.message, /session record is unreadable/);
        return true;
      });
      assert.equal(readFileSync(recordPath, "utf8").endsWith("\"opencodeMajor\":2"), true, "the corrupt record is not overwritten");
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: spawn refuses to resume a 2.x session with a 1.x CLI", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "1.19.0");
    try {
      const slockHome = process.env.SLOCK_HOME!;
      writeOpenCodeSessionRecord(openCodeSessionRecordPath(slockHome, "agent-1"), { version: 1, sessionId: "ses_two", opencodeMajor: 2, opencodeVersion: "2.0.27", recordedAt: "" });
      const ctx = makeSpawnContext(root, "ses_two");
      ctx.slockHome = slockHome;
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => {
        assert.ok(error instanceof RuntimeSessionRuntimeMismatchError);
        assert.equal(error.recordedMajor, 2);
        return true;
      });
    } finally {
      fake.restore();
    }
  });
});

async function waitForExit(proc: { once: (event: "exit", cb: () => void) => unknown; exitCode: number | null }): Promise<void> {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
}

test("task #1258: a 2.x launch passes the standalone arguments to the real child and records the session on session_init", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "argv.txt");
    const fake = installFakeOpenCode(root, "2.0.27", `printf '%s\\n' "$@" > '${argvFile}'\necho '{"type":"step_start","sessionID":"ses_fresh","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      const ctx = makeSpawnContext(root, null);
      ctx.slockHome = slockHome;
      const driver = new OpenCodeDriver();
      const { process: child } = await driver.spawn(ctx);
      await waitForExit(child);

      const argv = readFileSync(argvFile, "utf8").split("\n");
      assert.deepEqual(argv.slice(0, 5), ["run", "--standalone", "--format", "json", "--auto"]);
      assert.equal(argv.includes("--pure"), false);
      assert.equal(argv.includes("--session"), false, "fresh session: no --session");
      assert.equal(existsSync(recordPath), false, "nothing to record before the session id is known");

      const events = driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_fresh", part: { type: "step-start" } }));
      assert.deepEqual(events[0], { kind: "session_init", sessionId: "ses_fresh" });
      const record = recordAt(recordPath);
      assert.equal(record?.sessionId, "ses_fresh");
      assert.equal(record?.opencodeMajor, 2);
      assert.equal(record?.opencodeVersion, "2.0.27");

      // A permitted resume refreshes the record (and a 1.x session gains its major on the 1.x path).
      const resumeCtx = makeSpawnContext(root, "ses_fresh");
      resumeCtx.slockHome = slockHome;
      const resumeDriver = new OpenCodeDriver();
      const { process: resumed } = await resumeDriver.spawn(resumeCtx);
      await waitForExit(resumed);
      assert.ok(readFileSync(argvFile, "utf8").split("\n").includes("ses_fresh"));
      resumeDriver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_fresh", part: { type: "step-start" } }));
      assert.equal(recordAt(recordPath)?.sessionId, "ses_fresh");
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: a 1.x CLI records the major of a session it resumes without a record", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const fake = installFakeOpenCode(root, "1.18.35", `echo '{"type":"step_start","sessionID":"ses_legacy","part":{"type":"step-start"}}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      const ctx = makeSpawnContext(root, "ses_legacy");
      ctx.slockHome = slockHome;
      const driver = new OpenCodeDriver();
      const { process: child } = await driver.spawn(ctx);
      await waitForExit(child);
      assert.equal(existsSync(recordPath), false, "nothing is written before the CLI confirms the session");
      driver.parseLine(JSON.stringify({ type: "step_start", sessionID: "ses_legacy", part: { type: "step-start" } }));
      assert.deepEqual(recordAt(recordPath)?.opencodeMajor, 1);
      assert.equal(recordAt(recordPath)?.sessionId, "ses_legacy");
    } finally {
      fake.restore();
    }
  });
});

test("task #1258: runOpenCodeModelsCommand adds --standalone on 2.x and nothing on 1.x", () => {
  for (const [version, expected] of [["2.0.27", ["models", "--standalone"]], ["1.18.35", ["models"]], ["2.0.26", ["models"]]] as const) {
    let seen: readonly string[] | null = null;
    const result = runOpenCodeModelsCommand("/tmp/home", {
      platform: "darwin",
      execFileSyncFn: ((command: string) => {
        if (command === "which") return Buffer.from("/opt/opencode/bin/opencode\n");
        return Buffer.from(`${version}\n`);
      }) as any,
      spawnSyncFn: ((_command: string, args: readonly string[]) => {
        seen = args;
        return { status: 0, stdout: "opencode/gpt-5-nano\n", stderr: "", pid: 1, output: [], signal: null };
      }) as any,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(seen, expected, version);
  }
});

// ── task #1277, B-group: the opencode launch resolves under the start attempt's cancel ──

test("task #1277 (launch): an opencode spawn with an already-cancelled launch signal creates no child and rejects with the abort", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "argv.txt");
    const fake = installFakeOpenCode(root, "2.0.27", `printf '%s\\n' "$@" > '${argvFile}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      mkdirSync(slockHome, { recursive: true });
      const ctx = makeSpawnContext(root, null);
      ctx.slockHome = slockHome;
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        new OpenCodeDriver().spawn({ ...ctx, launchSignal: controller.signal }),
        (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
      );
      assert.equal(existsSync(argvFile), false, "the CLI was never launched");
    } finally {
      fake.restore();
    }
  });
});

test("task #1277 (launch): an opencode launch cancelled while the lookup runs creates no child", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "argv.txt");
    const fake = installFakeOpenCode(root, "2.0.27", `printf '%s\\n' "$@" > '${argvFile}'`);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      mkdirSync(slockHome, { recursive: true });
      // A slow `which` ahead of the real one stands in for a cold PATH scan.
      const slowBin = path.join(root, "slow-bin");
      mkdirSync(slowBin, { recursive: true });
      writeFileSync(path.join(slowBin, "which"), `#!/bin/sh\nsleep 0.5\nexec /usr/bin/which "$@"\n`);
      chmodSync(path.join(slowBin, "which"), 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${slowBin}${path.delimiter}${previousPath ?? ""}`;
      try {
        const ctx = makeSpawnContext(root, null);
        ctx.slockHome = slockHome;
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(
          new OpenCodeDriver().spawn({ ...ctx, launchSignal: controller.signal }),
          (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
        );
        assert.equal(existsSync(argvFile), false, "the CLI was never launched after the cancel");
      } finally {
        process.env.PATH = previousPath;
      }
    } finally {
      fake.restore();
    }
  });
});


// ── task #1365: an unknown OpenCode version is not a major mismatch ──

/** A fake `opencode` whose `--version` runs `versionScript`; any other call records its argv (the session process). */
function installScriptedOpenCode(root: string, versionScript: string, argvFile: string): { setVersionScript: (script: string) => void; restore: () => void } {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "opencode");
  const write = (script: string) => {
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n${script}\nfi\nprintf '%s\\n' "$@" > '${argvFile}'\nexit 0\n`, "utf8");
    chmodSync(bin, 0o755);
  };
  write(versionScript);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  return {
    setVersionScript: write,
    restore: () => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    },
  };
}

function assertVersionUnknownStartFailure(error: unknown, reason: string, cause: RegExp): true {
  assert.ok(error instanceof RuntimeExecutableNotFoundError, `expected the retryable version-unknown failure, got ${String(error)}`);
  assert.ok(!(error instanceof RuntimeSessionRuntimeMismatchError));
  assert.equal(error.reason, reason);
  assert.match(error.message, /could not confirm the installed OpenCode version/);
  assert.match(error.message, /cannot yet tell whether this agent's session can be resumed/);
  assert.match(error.message, cause);
  const classification = classifySpawnFailure(error);
  assert.equal(classification.reason, "runtime_not_found");
  assert.ok(!NON_RETRYABLE_SPAWN_FAILURE_REASONS.includes(classification.reason), "not a reason that stops automatic restarts");
  assert.equal(classification.userMessage, error.message);
  return true;
}

test("task #1365: a failed version read does not refuse a recorded 2.x session as a major mismatch; the next read resumes it", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "session-argv.txt");
    const fake = installScriptedOpenCode(root, "echo 'boom' >&2; exit 1", argvFile);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_x", opencodeMajor: 2, opencodeVersion: "2.1.3", recordedAt: "2026-11-01T00:00:00.000Z" });
      const before = readFileSync(recordPath, "utf8");
      const ctx = makeSpawnContext(root, "ses_x");
      ctx.slockHome = slockHome;

      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => {
        assertVersionUnknownStartFailure(error, "probe_failed", /exit status 1/);
        assert.doesNotMatch((error as Error).message, /boom/, "raw stderr is not carried into the message");
        return true;
      });
      assert.equal(existsSync(argvFile), false, "no session process was started");
      assert.equal(ctx.config.sessionId, "ses_x", "the server's session id is not touched");
      assert.equal(readFileSync(recordPath, "utf8"), before, "the record is not touched");

      // The version reads again on the next start: the original session resumes.
      fake.setVersionScript("echo '2.1.3'; exit 0");
      const { process: child } = await new OpenCodeDriver().spawn(ctx);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const argv = readFileSync(argvFile, "utf8").split("\n");
      assert.equal(argv[argv.indexOf("--session") + 1], "ses_x", "resumed the original session");
    } finally {
      fake.restore();
    }
  });
});

test("task #1365: unparseable version output stops the start, with or without a session, and never launches with 1.x arguments", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "session-argv.txt");
    const fake = installScriptedOpenCode(root, "echo 'opencode: not a version'; exit 0", argvFile);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      mkdirSync(slockHome, { recursive: true });
      for (const sessionId of ["ses_x", null]) {
        const ctx = makeSpawnContext(root, sessionId);
        ctx.slockHome = slockHome;
        await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) =>
          assertVersionUnknownStartFailure(error, "probe_failed", /printed no recognisable version number/));
        assert.equal(existsSync(argvFile), false, `no session process was started (session ${sessionId ?? "none"})`);
      }
      assert.equal(existsSync(openCodeSessionRecordPath(slockHome, "agent-1")), false, "no record is written");
    } finally {
      fake.restore();
    }
  });
});

test("task #1365: known versions keep every existing refusal (negative controls)", async () => {
  if (process.platform === "win32") return;
  await withTempDirAsync(async (root) => {
    const argvFile = path.join(root, "session-argv.txt");
    const fake = installScriptedOpenCode(root, "echo '2.1.3'; exit 0", argvFile);
    try {
      const slockHome = process.env.SLOCK_HOME!;
      const recordPath = openCodeSessionRecordPath(slockHome, "agent-1");
      const ctx = makeSpawnContext(root, "ses_x");
      ctx.slockHome = slockHome;

      writeOpenCodeSessionRecord(recordPath, { version: 1, sessionId: "ses_x", opencodeMajor: 1, opencodeVersion: "1.18.35", recordedAt: "2026-11-01T00:00:00.000Z" });
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) =>
        error instanceof RuntimeSessionRuntimeMismatchError && error.reason === "major_mismatch" && error.recordedMajor === 1);

      rmSync(recordPath);
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) =>
        error instanceof RuntimeSessionRuntimeMismatchError && error.reason === "unrecorded");

      writeFileSync(recordPath, "{not json", "utf8");
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) =>
        error instanceof RuntimeSessionRuntimeMismatchError && error.reason === "record_unreadable");

      // A corrupt record stays refused when the version is unknown too: the version gate does not open it.
      fake.setVersionScript("exit 1");
      await assert.rejects(new OpenCodeDriver().spawn(ctx), (error: unknown) => error instanceof RuntimeExecutableNotFoundError);
      assert.equal(readFileSync(recordPath, "utf8"), "{not json");
      assert.equal(existsSync(argvFile), false, "no session process was started by any refusal");
    } finally {
      fake.restore();
    }
  });
});

test("task #1365: the version read keeps its failure class and a structured cause; the generic read keeps its contract", async () => {
  const failWith = (fields: ConstructorParameters<typeof ProbeChildError>[1]) => async () => {
    throw new ProbeChildError("probe failed: /home/someone/secret path", fields);
  };
  const deps = (runProbeChildFn: unknown) => ({ runProbeChildFn: runProbeChildFn as any, platform: "linux" as const, env: {} });

  assert.deepEqual(await readCommandVersionDetailedAsync("opencode", [], deps(failWith({ code: "ETIMEDOUT" }))),
    { kind: "failed", reason: "probe_timeout", detail: "did not finish within 5000 ms" });
  assert.deepEqual(await readCommandVersionDetailedAsync("opencode", [], deps(failWith({ code: "EACCES" }))),
    { kind: "failed", reason: "permission_denied", detail: "error EACCES" });
  assert.deepEqual(await readCommandVersionDetailedAsync("opencode", [], deps(failWith({ status: 2, stderr: "/home/someone: boom" }))),
    { kind: "failed", reason: "probe_failed", detail: "exit status 2" });
  assert.deepEqual(await readCommandVersionDetailedAsync("opencode", [], deps(failWith({ signal: "SIGKILL" }))),
    { kind: "failed", reason: "probe_failed", detail: "signal SIGKILL" });
  assert.deepEqual(await readCommandVersionDetailedAsync("opencode", [], deps(async () => ({ stdout: "\n", stderr: "" }))),
    { kind: "failed", reason: "probe_failed", detail: "exited 0 without printing a version" });

  // The generic wrapper still returns any first line (other runtimes decide what a version is) and null on failure.
  assert.equal(await readCommandVersionAsync("x", [], deps(async () => ({ stdout: "not semver\n", stderr: "" }))), "not semver");
  assert.equal(await readCommandVersionAsync("x", [], deps(failWith({ status: 1 }))), null);

  // A cancel is still rethrown, never classified.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readCommandVersionDetailedAsync("opencode", [], { ...deps(failWith({ code: "ABORT_ERR" })), signal: controller.signal }),
    (error: unknown) => error instanceof ProbeChildError && error.code === "ABORT_ERR",
  );
});
