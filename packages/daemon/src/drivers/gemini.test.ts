import assert from "node:assert/strict";
import { ELECTRON_NODE_SCRIPT_EXEC_ARGV } from "./nodeHostLaunch";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GeminiDriver,
  buildGeminiArgs,
  buildGeminiManagedMcpSettings,
  buildGeminiSpawnEnv,
  resolveGeminiSpawn,
} from "./gemini";
import type { SpawnContext } from "./types";

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

    assert.equal(spawnEnv.GEMINI_CLI_TRUST_WORKSPACE, "true");
    assert.equal(spawnEnv.FORCE_COLOR, "0");
    assert.equal(spawnEnv.NO_COLOR, "1");
    assert.equal(spawnEnv.SLOCK_AGENT_ID, "agent-1");
    assert.equal(spawnEnv.SLOCK_SERVER_URL, "https://slock.example");
    assert.equal(spawnEnv.SLOCK_AGENT_TOKEN_FILE, undefined);
    assert.equal(spawnEnv.SLOCK_AGENT_TOKEN, undefined);
    assert.ok(spawnEnv.PATH?.startsWith(`${transportDir}${path.delimiter}`));
    assert.ok(!existsSync(path.join(transportDir, "agent-token")), "no token file without a runner credential");
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
  assert.deepEqual(resolved.args, [...ELECTRON_NODE_SCRIPT_EXEC_ARGV, entry, "--yolo"]);
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
    callId: "run_shell_command_123_0",
  });
});

// task #26: `tool_result` ends the call its `tool_id` names; the driver used to
// ignore it, so the daemon counted every Gemini call as still running.
test("parseLine: tool_result ends the matching tool_use", () => {
  const driver = new GeminiDriver();
  driver.parseLine(JSON.stringify({ type: "tool_use", tool_name: "run_shell_command", tool_id: "a", parameters: {} }));
  driver.parseLine(JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "b", parameters: {} }));
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "tool_result", tool_id: "b", status: "error", error: { type: "POLICY_VIOLATION", message: "no" } })), [
    { kind: "tool_output", name: "read_file", callId: "b", ok: false },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "tool_result", tool_id: "a", status: "success", output: "x" })), [
    { kind: "tool_output", name: "run_shell_command", callId: "a", ok: true },
  ]);
  assert.deepEqual(
    driver.parseLine(JSON.stringify({ type: "tool_result", tool_id: "a", status: "success" })),
    [],
    "a result for a call that is not open is dropped",
  );
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

// ── task #1277, B-group: the gemini launch resolves under the start attempt's cancel ──

import { chmodSync as chmodSyncT, mkdirSync as mkdirSyncT, mkdtempSync as mkdtempSyncT, rmSync as rmSyncT, writeFileSync as writeFileSyncT, existsSync as existsSyncT } from "node:fs";
import osT from "node:os";
import { GEMINI_WINDOWS_DISCOVERY_TIMEOUT_MS, resolveGeminiSpawnAsync } from "./gemini";
import { ProbeChildError, type runProbeChild } from "./probeChild";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";

/** Plays a sync execFileSync stand-in through the async probe-child seam, recording the budget each child got. */
function viaProbeChild(execFileSyncFn: (command: string, args: string[]) => string, budgets?: number[]): typeof runProbeChild {
  return async (command, args, options) => {
    budgets?.push(options.timeoutMs);
    return { stdout: String(execFileSyncFn(command, [...args]) ?? ""), stderr: "" };
  };
}

test("task #1277: resolveGeminiSpawnAsync resolves the Windows npm entry, the Electron Node mode and the where.exe fallback like the synchronous resolver, with a 5 s budget per child", async () => {
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\gemini.cmd`;
  const npmOk = (command: string, args: string[]) => {
    if (command === "npm" && args.join(" ") === "root -g") return globalRoot;
    throw new Error("unexpected command");
  };
  const budgets: number[] = [];
  const a = await resolveGeminiSpawnAsync(["--output-format", "stream-json"], { platform: "win32", env: { BASE_ENV: "present" }, execIsElectron: false, runProbeChildFn: viaProbeChild(npmOk, budgets), existsSyncFn: (c) => c === entry });
  assert.equal(a.command, process.execPath);
  assert.deepEqual(a.args, [entry, "--output-format", "stream-json"]);
  assert.deepEqual(budgets, [GEMINI_WINDOWS_DISCOVERY_TIMEOUT_MS]);
  const electron = String.raw`C:\Program Files\Raft\Raft.exe`;
  const b = await resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", env: { BASE_ENV: "present" }, execPath: electron, execIsElectron: true, runProbeChildFn: viaProbeChild(npmOk), existsSyncFn: (c) => c === entry });
  assert.equal(b.command, electron);
  assert.equal(b.env.ELECTRON_RUN_AS_NODE, "1");
  const viaWhere = (command: string, args: string[]) => {
    if (command === "npm" && args.join(" ") === "root -g") return String.raw`C:\missing`;
    if (command === "where.exe" && args.join(" ") === "gemini") return `${shim}\r\n`;
    throw new Error("unexpected command");
  };
  const c = await resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: viaProbeChild(viaWhere), existsSyncFn: (cand) => cand === entry });
  assert.equal(c.command, process.execPath);
  assert.deepEqual(c.args, [entry, "--yolo"]);
  // Equivalence with the synchronous resolver on the same stand-in.
  const sync = resolveGeminiSpawn(["--yolo"], { platform: "win32", execFileSyncFn: viaWhere as any, existsSyncFn: (cand) => cand === entry });
  assert.deepEqual({ command: c.command, args: c.args }, { command: sync.command, args: sync.args });
});

test("task #1277: a timed-out `npm root -g` (new 5 s budget, async path only) falls through to where.exe like any other discovery failure; an abort is rethrown", async () => {
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\gemini.cmd`;
  const timedOutNpm: typeof runProbeChild = async (command, args) => {
    if (command === "npm") throw new ProbeChildError("npm root -g timed out", { code: "ETIMEDOUT", cleanup: { childExited: true, waitedMs: 5001 } });
    if (command === "where.exe" && args[0] === "gemini") return { stdout: `${shim}\r\n`, stderr: "" };
    throw new Error("unexpected command");
  };
  const resolved = await resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: timedOutNpm, existsSyncFn: (c) => c === entry });
  assert.deepEqual(resolved.args, [entry, "--yolo"]);
  const controller = new AbortController();
  const aborting: typeof runProbeChild = async () => {
    controller.abort();
    throw new ProbeChildError("aborted", { code: "ABORT_ERR" });
  };
  await assert.rejects(
    resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", signal: controller.signal, runProbeChildFn: aborting, existsSyncFn: () => true }),
    (error: unknown) => error instanceof ProbeChildError && error.code === "ABORT_ERR",
    "a cancel is rethrown, never turned into 'not resolved'",
  );
});

test("task #1277 (launch): a gemini spawn with an already-cancelled launch signal creates no child; a cancel during a slow lookup does the same", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSyncT(path.join(osT.tmpdir(), "gemini-launch-cancel-"));
  const previousPath = process.env.PATH;
  try {
    const binDir = path.join(root, "bin");
    mkdirSyncT(binDir, { recursive: true });
    const argvFile = path.join(root, "argv.txt");
    writeFileSyncT(path.join(binDir, "gemini"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`);
    chmodSyncT(path.join(binDir, "gemini"), 0o755);
    writeFileSyncT(path.join(binDir, "which"), `#!/bin/sh\nsleep 0.4\nexec /usr/bin/which "$@"\n`);
    chmodSyncT(path.join(binDir, "which"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    const isAbort = (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR";
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(new GeminiDriver().spawn({ ...makeSpawnContext(null, root), launchSignal: pre.signal }), isAbort);
    assert.equal(existsSyncT(argvFile), false, "no gemini child was started");
    const mid = new AbortController();
    setTimeout(() => mid.abort(), 100);
    await assert.rejects(new GeminiDriver().spawn({ ...makeSpawnContext(null, root), launchSignal: mid.signal }), isAbort);
    assert.equal(existsSyncT(argvFile), false, "no gemini child was started after the cancel");
  } finally {
    process.env.PATH = previousPath;
    rmSyncT(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): when every Windows discovery child timed out, the 'not resolved' error carries probe_timeout (never a bare or not_installed verdict); a non-timeout failure carries probe_failed; two clean misses carry no reason", async () => {
  const timedOut: typeof runProbeChild = async () => { throw new ProbeChildError("timed out", { code: "ETIMEDOUT", cleanup: { childExited: true, waitedMs: 5001 } }); };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: timedOut, existsSyncFn: () => false }), (error: unknown) => {
    assert.ok(error instanceof RuntimeExecutableNotFoundError);
    assert.equal(error.reason, "probe_timeout");
    assert.doesNotMatch(error.message, /npm i -g/, "never suggests installing on an undecided lookup");
    return true;
  });
  const failedThenTimedOut: typeof runProbeChild = async (command) => {
    if (command === "npm") throw new ProbeChildError("npm missing", { code: "ENOENT" });
    throw new ProbeChildError("timed out", { code: "ETIMEDOUT", cleanup: { childExited: true, waitedMs: 5001 } });
  };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: failedThenTimedOut, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_timeout");
  const failedOnly: typeof runProbeChild = async () => { throw new ProbeChildError("cannot run", { code: "ENOENT" }); };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: failedOnly, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_failed");
  const cleanMiss: typeof runProbeChild = async (command) => ({ stdout: command === "npm" ? "C:\\missing\n" : "C:\\also-missing\\gemini.cmd\r\n", stderr: "" });
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: cleanMiss, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === undefined && /npm i -g/.test(error.message));
});

test("task #1277 (review 2): a discovery child that exited non-zero without a string code (runProbeChild's ordinary failure shape), was killed by a signal, or threw an unknown error is probe_failed — never a bare 'install it' verdict; where.exe's documented no-match exit (1) is a clean miss; timeout keeps priority", async () => {
  const npmStatusOnly: typeof runProbeChild = async (command) => {
    if (command === "npm") throw new ProbeChildError("npm root -g exited with status 1", { status: 1, signal: null, stderr: "npm ERR! code ELIFECYCLE" });
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: npmStatusOnly, existsSyncFn: () => false }), (error: unknown) => {
    assert.ok(error instanceof RuntimeExecutableNotFoundError);
    assert.equal(error.reason, "probe_failed", "a non-zero npm exit with no code is an execution failure, not a clean miss");
    assert.doesNotMatch(error.message, /npm i -g/);
    return true;
  });
  const whereStatusTwo: typeof runProbeChild = async (command) => {
    if (command === "npm") return { stdout: "C:\\missing\n", stderr: "" };
    throw new ProbeChildError("where.exe could not run", { status: 2, signal: null });
  };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: whereStatusTwo, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_failed");
  const signalled: typeof runProbeChild = async () => { throw new ProbeChildError("killed", { status: null, signal: "SIGKILL" }); };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: signalled, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_failed");
  const unknownShape: typeof runProbeChild = async () => { throw new Error("runner blew up"); };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: unknownShape, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_failed");
  // Control: npm answered cleanly (entry missing) and where.exe reported its documented no-match exit — nothing undecided.
  const cleanNoMatch: typeof runProbeChild = async (command) => {
    if (command === "npm") return { stdout: "C:\\missing\n", stderr: "" };
    throw new ProbeChildError("where.exe: no match", { status: 1, signal: null, stderr: "INFO: Could not find files for the given pattern(s)." });
  };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: cleanNoMatch, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === undefined && /npm i -g/.test(error.message));
  // Priority: a status-only npm failure followed by a where.exe timeout reads probe_timeout.
  const statusThenTimeout: typeof runProbeChild = async (command) => {
    if (command === "npm") throw new ProbeChildError("npm exited 1", { status: 1, signal: null });
    throw new ProbeChildError("timed out", { code: "ETIMEDOUT", cleanup: { childExited: true, waitedMs: 5001 } });
  };
  await assert.rejects(resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: statusThenTimeout, existsSyncFn: () => false }), (error: unknown) =>
    error instanceof RuntimeExecutableNotFoundError && error.reason === "probe_timeout");
  // A status-only npm failure with where.exe then succeeding still resolves (successful fallback preserved).
  const entry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@google\gemini-cli\bundle\gemini.js`;
  const statusThenFound: typeof runProbeChild = async (command) => {
    if (command === "npm") throw new ProbeChildError("npm exited 1", { status: 1, signal: null });
    return { stdout: String.raw`C:\Users\bot\AppData\Roaming\npm\gemini.cmd` + "\r\n", stderr: "" };
  };
  const resolved = await resolveGeminiSpawnAsync(["--yolo"], { platform: "win32", runProbeChildFn: statusThenFound, existsSyncFn: (c) => c === entry });
  assert.deepEqual(resolved.args, [entry, "--yolo"]);
});
