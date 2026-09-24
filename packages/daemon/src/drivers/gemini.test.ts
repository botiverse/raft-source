import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  GeminiDriver,
  buildGeminiArgs,
  buildGeminiManagedMcpSettings,
  buildGeminiSpawnEnv,
  resolveGeminiSpawn,
} from "./gemini.js";
import type { SpawnContext } from "./types.js";

// Mirrors Gemini CLI 0.40.1 atCommandProcessor parsing; revisit when upstream changes it.
const geminiAtCommandRegex = /(?<!\\)@(?:(?:"(?:[^"]*)")|(?:\\.|[^ \t\n\r,;!?()[\]{}.]|\.(?!$|[ \t\n\r])))+/g;

function makeSpawnContext(
  envVars: Record<string, string> | null = null,
  workingDirectory = "/tmp/gemini-agent",
): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing",
    prompt: "hello",
    workingDirectory,
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    launchId: "launch-1",
    config: {
      name: "Gemini Agent",
      displayName: null,
      description: null,
      runtime: "gemini",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: "gemini-2.5-pro",
      reasoningEffort: null,
      envVars,
      runtimeContext: null,
    },
  };
}

async function withTempDir(cb: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "slock-gemini-"));
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

test("buildGeminiSpawnEnv enables trusted workspace and Slock CLI transport", async () => {
  await withTempDir(async (dir) => {
    const spawnEnv = await buildGeminiSpawnEnv(makeSpawnContext(null, dir), "linux");
    const workspaceSlockDir = path.join(dir, ".slock");
    const transportDir = spawnEnv.PATH?.split(path.delimiter)[0];
    assert.ok(transportDir, "transport wrapper directory should be prepended to PATH");
    assert.ok(transportDir.startsWith(path.join(process.env.SLOCK_HOME!, "cli-transport", "agent-1", "launch-1")));
    assert.ok(!transportDir.startsWith(workspaceSlockDir), "transport files should not live in the model workspace");
    const tokenFile = path.join(transportDir, "agent-token");

    assert.equal(spawnEnv.GEMINI_CLI_TRUST_WORKSPACE, "true");
    assert.equal(spawnEnv.FORCE_COLOR, "0");
    assert.equal(spawnEnv.NO_COLOR, "1");
    assert.equal(spawnEnv.SLOCK_AGENT_ID, "agent-1");
    assert.equal(spawnEnv.SLOCK_SERVER_URL, "https://slock.example");
    assert.equal(spawnEnv.SLOCK_AGENT_TOKEN_FILE, undefined);
    assert.equal(spawnEnv.SLOCK_AGENT_TOKEN, undefined);
    assert.ok(spawnEnv.PATH?.startsWith(`${transportDir}${path.delimiter}`));
    assert.equal(readFileSync(tokenFile, "utf8"), "agent-token");
    assert.ok(existsSync(path.join(transportDir, "slock")));
  });
});

test("buildGeminiSpawnEnv lets explicit trust envVar override the managed default", async () => {
  await withTempDir(async (dir) => {
    const spawnEnv = await buildGeminiSpawnEnv(
      makeSpawnContext({ GEMINI_CLI_TRUST_WORKSPACE: "false", EXTRA_FLAG: "1" }, dir),
      "linux",
    );
    assert.equal(spawnEnv.GEMINI_CLI_TRUST_WORKSPACE, "false");
    assert.equal(spawnEnv.EXTRA_FLAG, "1");
    assert.equal(spawnEnv.SLOCK_AGENT_ID, "agent-1");
  });
});

test("buildGeminiSpawnEnv injects GEMINI_PTY_INFO=child_process on Windows", async () => {
  await withTempDir(async (dir) => {
    const spawnEnv = await buildGeminiSpawnEnv(makeSpawnContext(null, dir), "win32");
    assert.equal(spawnEnv.GEMINI_PTY_INFO, "child_process");
  });
});

test("buildGeminiSpawnEnv does not inject GEMINI_PTY_INFO on non-Windows", async () => {
  await withTempDir(async (dir) => {
    const spawnEnv = await buildGeminiSpawnEnv(makeSpawnContext(null, dir), "linux");
    assert.equal(spawnEnv.GEMINI_PTY_INFO, undefined);
  });
});

test("buildGeminiSpawnEnv lets explicit GEMINI_PTY_INFO envVar override the Windows default", async () => {
  await withTempDir(async (dir) => {
    const spawnEnv = await buildGeminiSpawnEnv(
      makeSpawnContext({ GEMINI_PTY_INFO: "native_pty" }, dir),
      "win32",
    );
    assert.equal(spawnEnv.GEMINI_PTY_INFO, "native_pty");
  });
});

test("gemini managed MCP launch settings use httpUrl and the system-defaults env seam", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "managed-settings.json");
    const spawnEnv = await buildGeminiSpawnEnv(makeSpawnContext(null, dir), "linux", settingsPath);
    assert.equal(spawnEnv.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, settingsPath);
    assert.deepEqual(buildGeminiManagedMcpSettings({
      name: "raftmanagedabc123",
      url: "http://127.0.0.1:1234/mcp/opaque",
    }), {
      mcpServers: {
        raftmanagedabc123: { httpUrl: "http://127.0.0.1:1234/mcp/opaque" },
      },
    });
  });
});

test("gemini driver does not expose a runtime-control MCP settings helper", () => {
  const driver = new GeminiDriver();

  assert.equal(driver.communication.runtimeControl, "none");
  assert.equal("buildRuntimeActionsMcpSettings" in driver, false);
});

test("gemini default model delegates to the CLI configured model", () => {
  const driver = new GeminiDriver();

  assert.deepEqual(driver.model.toLaunchSpec?.("default"), { args: [] });
  assert.deepEqual(driver.model.toLaunchSpec?.("gemini-2.5-flash"), {
    args: ["--model", "gemini-2.5-flash"],
  });
});

test("buildGeminiArgs keeps long wake prompts off argv", () => {
  const ctx = makeSpawnContext();
  const args = buildGeminiArgs({
    ...ctx.config,
    model: "gemini-2.5-flash",
    sessionId: "session-1",
  });

  assert.deepEqual(args, [
    "--output-format", "stream-json",
    "--yolo",
    "-p", "",
    "--model", "gemini-2.5-flash",
    "--resume", "session-1",
  ]);
  assert.ok(!args.some((arg) => arg === ctx.prompt));
});

test("resolveGeminiSpawn bypasses npm cmd shim on Windows", () => {
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;
  const calls: Array<{ command: string; args: string[] }> = [];
  const baseEnv: NodeJS.ProcessEnv = { BASE_ENV: "present" };

  const resolved = resolveGeminiSpawn(["--output-format", "stream-json"], {
    platform: "win32",
    env: baseEnv,
    execIsElectron: false,
    execFileSyncFn: ((command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "npm" && args.join(" ") === "root -g") return globalRoot;
      throw new Error("unexpected command");
    }) as any,
    existsSyncFn: (candidate) => candidate === entry,
  });

  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [entry, "--output-format", "stream-json"]);
  assert.equal(resolved.env, baseEnv);
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(calls, [{ command: "npm", args: ["root", "-g"] }]);
});

test("resolveGeminiSpawn enables Node mode for a packaged Electron host", () => {
  const electronExecutable = String.raw`C:\Program Files\Raft\Raft.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;

  const resolved = resolveGeminiSpawn(["--yolo"], {
    platform: "win32",
    env: { BASE_ENV: "present" },
    execPath: electronExecutable,
    execIsElectron: true,
    execFileSyncFn: ((command: string, args: string[]) => {
      if (command === "npm" && args.join(" ") === "root -g") return globalRoot;
      throw new Error("unexpected command");
    }) as any,
    existsSyncFn: (candidate) => candidate === entry,
  });

  assert.equal(resolved.command, electronExecutable);
  assert.deepEqual(resolved.args, [entry, "--yolo"]);
  assert.equal(resolved.env.BASE_ENV, "present");
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveGeminiSpawn falls back to where.exe on Windows", () => {
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\gemini.cmd`;
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;

  const resolved = resolveGeminiSpawn(["--yolo"], {
    platform: "win32",
    execFileSyncFn: ((command: string, args: string[]) => {
      if (command === "npm" && args.join(" ") === "root -g") return String.raw`C:\missing`;
      if (command === "where.exe" && args.join(" ") === "gemini") return `${shim}\r\n`;
      throw new Error("unexpected command");
    }) as any,
    existsSyncFn: (candidate) => candidate === entry,
  });

  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [entry, "--yolo"]);
});

test("parseLine: init event emits session_init", () => {
  const driver = new GeminiDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "init",
    timestamp: "2026-04-13T10:00:00.000Z",
    session_id: "defbd954-abc1-4321-beef-123456789abc",
    model: "gemini-3-flash-preview",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "session_init", sessionId: "defbd954-abc1-4321-beef-123456789abc" });
});

test("parseLine: assistant message delta emits text", () => {
  const driver = new GeminiDriver();
  // need init first to set sessionId
  driver.parseLine(JSON.stringify({ type: "init", session_id: "s1" }));

  const events = driver.parseLine(JSON.stringify({
    type: "message",
    timestamp: "2026-04-13T10:00:01.000Z",
    role: "assistant",
    content: "2 + 2",
    delta: true,
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "text", text: "2 + 2" });
});

test("parseLine: user message is ignored", () => {
  const driver = new GeminiDriver();
  driver.parseLine(JSON.stringify({ type: "init", session_id: "s1" }));

  const events = driver.parseLine(JSON.stringify({
    type: "message",
    role: "user",
    content: "Hello",
  }));
  assert.equal(events.length, 0);
});

test("parseLine: tool_use event emits tool_call", () => {
  const driver = new GeminiDriver();
  driver.parseLine(JSON.stringify({ type: "init", session_id: "s1" }));

  const events = driver.parseLine(JSON.stringify({
    type: "tool_use",
    timestamp: "2026-04-13T10:00:02.000Z",
    tool_name: "run_shell_command",
    tool_id: "run_shell_command_123_0",
    parameters: { command: "ls -la", description: "List files" },
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "tool_call",
    name: "run_shell_command",
    input: { command: "ls -la", description: "List files" },
  });
});

test("parseLine: result success emits turn_end", () => {
  const driver = new GeminiDriver();
  driver.parseLine(JSON.stringify({ type: "init", session_id: "sess-42" }));

  const events = driver.parseLine(JSON.stringify({
    type: "result",
    timestamp: "2026-04-13T10:00:05.000Z",
    status: "success",
    stats: { total_tokens: 1000 },
  }));
  // result stats carry token usage -> a token_usage telemetry event precedes turn_end.
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "telemetry",
    name: "token_usage",
    source: "gemini_result_stats",
    usageKind: "per_turn",
    sessionId: "sess-42",
    attrs: { total_tokens: 1000 },
  });
  assert.deepEqual(events[1], { kind: "turn_end", sessionId: "sess-42" });
});

test("parseLine: result with non-success status emits error then turn_end", () => {
  const driver = new GeminiDriver();
  driver.parseLine(JSON.stringify({ type: "init", session_id: "s1" }));

  const events = driver.parseLine(JSON.stringify({
    type: "result",
    status: "error",
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "error");
  assert.equal(events[1]!.kind, "turn_end");
});

test("parseLine: error event emits error", () => {
  const driver = new GeminiDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "error",
    severity: "warning",
    message: "Loop detected, stopping execution",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "error", message: "Loop detected, stopping execution" });
});

test("parseLine: invalid JSON returns empty", () => {
  const driver = new GeminiDriver();
  assert.deepEqual(driver.parseLine("not json"), []);
  assert.deepEqual(driver.parseLine(""), []);
});

test("encodeStdinMessage always returns null", () => {
  const driver = new GeminiDriver();
  assert.equal(driver.encodeStdinMessage("hello", "s1"), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "idle" }), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "busy" }), null);
});

test("driver properties are correct", () => {
  const driver = new GeminiDriver();
  assert.equal(driver.id, "gemini");
  assert.equal(driver.supportsStdinNotification, false);
  assert.equal(driver.busyDeliveryMode, "none");
  assert.equal(driver.communication.chat, "slock_cli");
});

test("parseLine: full turn lifecycle", () => {
  const driver = new GeminiDriver();
  const all: any[] = [];

  // init
  all.push(...driver.parseLine(JSON.stringify({
    type: "init", session_id: "full-test", model: "gemini-3-flash",
  })));

  // user message (ignored)
  all.push(...driver.parseLine(JSON.stringify({
    type: "message", role: "user", content: "What is 2+2?",
  })));

  // assistant delta 1
  all.push(...driver.parseLine(JSON.stringify({
    type: "message", role: "assistant", content: "2 + 2", delta: true,
  })));

  // assistant delta 2
  all.push(...driver.parseLine(JSON.stringify({
    type: "message", role: "assistant", content: " is 4.", delta: true,
  })));

  // tool use
  all.push(...driver.parseLine(JSON.stringify({
    type: "tool_use", tool_name: "send_message", parameters: { target: "#general", content: "hi" },
  })));

  // result
  all.push(...driver.parseLine(JSON.stringify({
    type: "result", status: "success", stats: {},
  })));

  assert.equal(all.length, 5);
  assert.equal(all[0]!.kind, "session_init");
  assert.equal(all[1]!.kind, "text");
  assert.equal(all[1]!.text, "2 + 2");
  assert.equal(all[2]!.kind, "text");
  assert.equal(all[2]!.text, " is 4.");
  assert.equal(all[3]!.kind, "tool_call");
  assert.equal(all[3]!.name, "send_message");
  assert.equal(all[4]!.kind, "turn_end");
  assert.equal(all[4]!.sessionId, "full-test");
});
