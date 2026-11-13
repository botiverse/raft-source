import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { resolveCursorLaunch } from "./cursor";
import { readFileSync, rmSync } from "node:fs";
import {
  CursorDriver,
  buildCursorArgs,
  buildCursorLaunchInput,
  buildCursorManagedMcpConfig,
  buildCursorModelProbeEnv,
  buildCursorSpawnEnv,
  CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES,
  CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS,
  cursorPromptViaStdin,
  detectCursorModelSource,
  killCursorProbeTree,
  parseCursorModelsOutput,
  runCursorModelsCommandAsync,
} from "./cursor";
import { CURSOR_MODEL_DETECTION_TIMEOUT_MS, runtimeModelDetectionRequestTimeoutMs } from "@botiverse/raft-shared";
import type { SpawnContext } from "./types";

function makeSpawnContext(envVars: Record<string, string> | null = null): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing",
    prompt: "hello",
    workingDirectory: "/tmp/cursor-agent",
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: {
      name: "Cursor Agent",
      displayName: null,
      description: null,
      runtime: "cursor",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: "default",
      reasoningEffort: null,
      envVars,
      runtimeContext: null,
    },
  };
}

test("buildCursorSpawnEnv normalizes SLOCK_HOME after agent env overrides", async () => {
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = "/tmp/slock-cursor/../slock-cursor";
    const spawnEnv = await buildCursorSpawnEnv(makeSpawnContext({
      SLOCK_HOME: "/tmp/agent-overrides-slock-home",
      EXTRA_FLAG: "1",
    }));

    assert.equal(spawnEnv.SLOCK_HOME, path.resolve("/tmp/slock-cursor"));
    assert.equal(spawnEnv.EXTRA_FLAG, "1");
    assert.equal(spawnEnv.FORCE_COLOR, "0");
    assert.equal(spawnEnv.NO_COLOR, "1");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
  }
});

test("buildCursorSpawnEnv merges Windows User PATH after preparing CLI transport", async () => {
  const spawnEnv = await buildCursorSpawnEnv(makeSpawnContext({
    Path: "C:\\ExplicitBin",
    SHARED_VALUE: "base",
  }), {
    platform: "win32",
    windowsEnvironmentReaderFn: () => ({
      machine: {
        Path: "C:\\MachineBin",
        MACHINE_ONLY: "machine",
        SHARED_VALUE: "machine",
      },
      user: {
        Path: "C:\\Users\\test\\AppData\\Local\\cursor-agent",
        USER_ONLY: "user",
        SHARED_VALUE: "user",
      },
    }),
  });

  assert.equal(spawnEnv.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\Users\\test\\AppData\\Local\\cursor-agent");
  assert.equal(spawnEnv.MACHINE_ONLY, "machine");
  assert.equal(spawnEnv.USER_ONLY, "user");
  assert.equal(spawnEnv.SHARED_VALUE, "base");
  assert.equal(spawnEnv.FORCE_COLOR, "0");
  assert.equal(spawnEnv.NO_COLOR, "1");
});

test("buildCursorModelProbeEnv merges Windows User PATH for model detection", () => {
  const env = buildCursorModelProbeEnv({
    platform: "win32",
    env: {
      Path: "C:\\ExplicitBin",
      FORCE_COLOR: "1",
    },
    windowsEnvironmentReaderFn: () => ({
      machine: { Path: "C:\\MachineBin" },
      user: { Path: "C:\\Users\\test\\AppData\\Local\\cursor-agent" },
    }),
  });

  assert.equal(env.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\Users\\test\\AppData\\Local\\cursor-agent");
  assert.equal(env.FORCE_COLOR, "0");
  assert.equal(env.NO_COLOR, "1");
});

test("cursor managed MCP overlay preserves user servers and uses the upstream remote schema", () => {
  assert.deepEqual(buildCursorManagedMcpConfig({
    mcpServers: { user: { command: "user-mcp" } },
  }, {
    name: "raftmanagedabc123",
    url: "http://127.0.0.1:1234/mcp/opaque",
  }), {
    mcpServers: {
      user: { command: "user-mcp" },
      raftmanagedabc123: { url: "http://127.0.0.1:1234/mcp/opaque" },
    },
  });
  assert.deepEqual(buildCursorArgs(makeSpawnContext()), [
    "--print",
    "--output-format", "stream-json",
    "--force",
    "hello",
  ]);
});

test("cursor sends a prompt too long for the Windows command line on stdin, not argv (#triage:#309)", () => {
  const longPrompt = "x".repeat(CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS + 1);
  const atLimit = "x".repeat(CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS);
  assert.equal(cursorPromptViaStdin(longPrompt, "win32"), true);
  assert.equal(cursorPromptViaStdin(atLimit, "win32"), false);
  assert.deepEqual(buildCursorArgs({ ...makeSpawnContext(), prompt: longPrompt }, "win32"), [
    "--print",
    "--output-format", "stream-json",
    "--force",
  ]);
  assert.equal(buildCursorArgs({ ...makeSpawnContext(), prompt: atLimit }, "win32").at(-1), atLimit);
  // The same prompt still fits one argv entry on Linux/macOS.
  assert.equal(buildCursorArgs({ ...makeSpawnContext(), prompt: longPrompt }, "linux").at(-1), longPrompt);
});

test("a Cursor turn carries its prompt in exactly one of argv and stdin", () => {
  const longPrompt = "x".repeat(CURSOR_ARGV_PROMPT_LIMIT_WIN32_CHARS + 1);
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const prompt of ["hello", longPrompt, "中".repeat(CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES)]) {
      const { args, stdinPrompt } = buildCursorLaunchInput({ ...makeSpawnContext(), prompt }, platform);
      const inArgv = args.at(-1) === prompt;
      assert.equal(inArgv !== (stdinPrompt === prompt), true, `${platform} ${prompt.length}`);
      assert.equal(stdinPrompt === null || stdinPrompt === prompt, true);
    }
  }
});

test("cursor keeps --resume and sends a prompt over the POSIX per-argument cap on stdin", () => {
  // Counted in UTF-8 bytes: 3 bytes per character here.
  const prompt = "中".repeat(Math.floor(CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES / 3) + 1);
  assert.equal(prompt.length < CURSOR_ARGV_PROMPT_LIMIT_POSIX_BYTES, true);
  assert.equal(cursorPromptViaStdin(prompt, "linux"), true);
  const ctx = makeSpawnContext();
  const args = buildCursorArgs({ ...ctx, prompt, config: { ...ctx.config, sessionId: "chat-1" } }, "darwin");
  assert.deepEqual(args.slice(-2), ["--resume", "chat-1"]);
});

test("parseLine: system init emits session_init", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/tmp/test",
    session_id: "cursor-session-123",
    model: "Composer 2 Fast",
    permissionMode: "default",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "session_init", sessionId: "cursor-session-123" });
});

test("parseLine: compacting status emits compaction_started", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "system",
    subtype: "status",
    status: "compacting",
  }));
  assert.deepEqual(events, [{ kind: "compaction_started" }]);
});

test("parseLine: compact_boundary emits compaction_finished", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
  }));
  assert.deepEqual(events, [{ kind: "compaction_finished" }]);
});

test("parseLine: assistant text content emits text", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello, world!" }],
    },
    session_id: "s1",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "text", text: "Hello, world!" });
});

test("parseLine: assistant thinking content emits thinking", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Let me think..." }],
    },
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "thinking", text: "Let me think..." });
});

// task #26: Cursor reports tools as their own `tool_call` events, `started`
// then `completed` with the same `call_id` (shapes from Cursor's headless docs
// and captured output); assistant content carries only text. The driver used
// to look for Claude-style `tool_use` blocks, so no Cursor tool was reported.
const cursorShellStarted = {
  type: "tool_call", subtype: "started", call_id: "call-0",
  tool_call: { shellToolCall: { args: { command: "raft message send --target \"#general\"" } } },
  session_id: "s1",
};
const cursorShellCompleted = (result: unknown) => ({
  type: "tool_call", subtype: "completed", call_id: "call-0",
  tool_call: { shellToolCall: { args: { command: "raft message send --target \"#general\"" }, result } },
  session_id: "s1",
});

test("parseLine: tool_call started/completed pair by call_id", () => {
  const driver = new CursorDriver();
  assert.deepEqual(driver.parseLine(JSON.stringify(cursorShellStarted)), [{
    kind: "tool_call",
    name: "Shell",
    input: { command: "raft message send --target \"#general\"" },
    callId: "call-0",
  }]);
  assert.deepEqual(
    driver.parseLine(JSON.stringify(cursorShellCompleted({ failure: { exitCode: 1, stderr: "no", stdout: "" } }))),
    [{ kind: "tool_output", name: "Shell", callId: "call-0", ok: true, exitCode: 1 }],
    "a command that ran and exited non-zero is a finished call with its exit code",
  );
  assert.deepEqual(
    driver.parseLine(JSON.stringify(cursorShellCompleted({ success: {} }))),
    [],
    "a completion for a call already ended (or never started) is dropped",
  );
});

test("parseLine: tool_call outcomes for success, omitted zero exit, rejection and MCP errors", () => {
  const driver = new CursorDriver();
  driver.parseLine(JSON.stringify(cursorShellStarted));
  assert.deepEqual(driver.parseLine(JSON.stringify(cursorShellCompleted({ success: { stdout: "ok" } }))), [
    { kind: "tool_output", name: "Shell", callId: "call-0", ok: true, exitCode: 0 },
  ]);

  const read = { readToolCall: { args: { path: "README.md" } } };
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "r1", tool_call: read })), [
    { kind: "tool_call", name: "Read", input: { path: "README.md" }, callId: "r1" },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool_call", subtype: "completed", call_id: "r1",
    tool_call: { readToolCall: { args: { path: "README.md" }, result: { rejected: { reason: "user" } } } },
  })), [{ kind: "tool_output", name: "Read", callId: "r1", ok: false }]);

  const mcp = { mcpToolCall: { args: { toolName: "lookup", args: { q: "x" } } } };
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "tool_call", subtype: "started", call_id: "m1", tool_call: mcp })), [
    { kind: "tool_call", name: "lookup", input: { q: "x" }, callId: "m1" },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool_call", subtype: "completed", call_id: "m1",
    tool_call: { mcpToolCall: { ...mcp.mcpToolCall, result: { success: { content: [], isError: true } } } },
  })), [{ kind: "tool_output", name: "lookup", callId: "m1", ok: false }]);
});

test("parseLine: a shell command killed or aborted is a failed call", () => {
  const driver = new CursorDriver();
  driver.parseLine(JSON.stringify(cursorShellStarted));
  assert.deepEqual(driver.parseLine(JSON.stringify(cursorShellCompleted({ failure: { exitCode: 137, signal: "SIGKILL", oomKill: true } }))), [
    { kind: "tool_output", name: "Shell", callId: "call-0", ok: false, exitCode: 137 },
  ]);
  driver.parseLine(JSON.stringify({ ...cursorShellStarted, call_id: "call-1" }));
  assert.deepEqual(driver.parseLine(JSON.stringify({ ...cursorShellCompleted({ failure: { aborted: true, abortReason: "user" } }), call_id: "call-1" })), [
    { kind: "tool_output", name: "Shell", callId: "call-1", ok: false },
  ]);
  driver.parseLine(JSON.stringify({ ...cursorShellStarted, call_id: "call-2" }));
  assert.deepEqual(driver.parseLine(JSON.stringify({ ...cursorShellCompleted({ failure: { stderr: "?" } }), call_id: "call-2" })), [
    { kind: "tool_output", name: "Shell", callId: "call-2" },
  ], "a failure with no exit code and no kill is left unknown");
});

test("parseLine: a repeated started event does not reopen a finished call", () => {
  const driver = new CursorDriver();
  driver.parseLine(JSON.stringify(cursorShellStarted));
  driver.parseLine(JSON.stringify(cursorShellCompleted({ success: {} })));
  assert.deepEqual(driver.parseLine(JSON.stringify(cursorShellStarted)), []);
});

test("parseLine: a reconnect closes the calls whose completion Cursor will not send", () => {
  const driver = new CursorDriver();
  driver.parseLine(JSON.stringify(cursorShellStarted));
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "connection", subtype: "reconnecting" })), [
    { kind: "tool_output", name: "Shell", callId: "call-0" },
  ]);
  assert.deepEqual(driver.parseLine(JSON.stringify(cursorShellCompleted({ success: {} }))), []);
});

test("parseLine: assistant text and thinking content emit in order", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "response" },
      ],
    },
  }));
  assert.deepEqual(events.map((e) => e.kind), ["thinking", "text"]);
});

test("parseLine: result success emits turn_end", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    session_id: "cursor-sess-42",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "turn_end", sessionId: "cursor-sess-42" });
});

test("parseLine: result with is_error emits error then turn_end", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Something went wrong",
    session_id: "s1",
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "error");
  assert.ok((events[0] as any).message.includes("Something went wrong"));
  assert.equal(events[1]!.kind, "turn_end");
});

test("parseLine: result error_during_execution emits error then turn_end", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    errors: ["API rate limit exceeded"],
    session_id: "s1",
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "error");
  assert.ok((events[0] as any).message.includes("API rate limit"));
  assert.equal(events[1]!.kind, "turn_end");
});

test("parseLine: invalid JSON returns empty", () => {
  const driver = new CursorDriver();
  assert.deepEqual(driver.parseLine("not json"), []);
  assert.deepEqual(driver.parseLine(""), []);
});

test("encodeStdinMessage always returns null", () => {
  const driver = new CursorDriver();
  assert.equal(driver.encodeStdinMessage("hello", "s1"), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "idle" }), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "busy" }), null);
});

test("driver properties are correct", () => {
  const driver = new CursorDriver();
  assert.equal(driver.id, "cursor");
  assert.equal(driver.supportsStdinNotification, false);
  assert.equal(driver.busyDeliveryMode, "none");
  assert.equal(driver.communication.chat, "slock_cli");
  assert.equal(driver.communication.runtimeControl, "none");
});

test("cursor driver does not expose a runtime-control MCP config helper", () => {
  const driver = new CursorDriver();

  assert.equal("buildRuntimeActionsMcpConfig" in driver, false);
});

test("parseCursorModelsOutput parses cursor-agent models output", () => {
  const result = parseCursorModelsOutput([
    "\u001b[2mAvailable models\u001b[22m",
    "",
    "\u001b[36mcomposer-2-fast\u001b[39m \u001b[2m- Composer 2 Fast\u001b[22m (current, default)",
    "\u001b[36mcomposer-2\u001b[39m \u001b[2m- Composer 2\u001b[22m",
    "\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m",
    "",
    "\u001b[2mTip: use \u001b[36m--model <id>\u001b[39m to switch.\u001b[22m",
  ].join("\n"));

  assert.ok(result);
  assert.deepEqual(result!.models, [
    { id: "composer-2-fast", label: "Composer 2 Fast", verified: "launchable" },
    { id: "composer-2", label: "Composer 2", verified: "launchable" },
    { id: "auto", label: "Auto", verified: "launchable" },
  ]);
  assert.equal(result!.default, "composer-2-fast");
});

test("driver exposes dynamic cursor model detection", async () => {
  const driver = new CursorDriver();
  assert.equal(typeof driver.detectModels, "function");
});

test("parseLine: full turn lifecycle", () => {
  const driver = new CursorDriver();
  const all: any[] = [];

  // system init
  all.push(...driver.parseLine(JSON.stringify({
    type: "system", subtype: "init", session_id: "full-cursor-test", model: "Composer 2 Fast",
  })));

  // assistant text
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "2 + 2 = 4" }] },
  })));

  // a tool call, started then completed
  all.push(...driver.parseLine(JSON.stringify(cursorShellStarted)));
  all.push(...driver.parseLine(JSON.stringify(cursorShellCompleted({ success: { exitCode: 0 } }))));

  // result
  all.push(...driver.parseLine(JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: "full-cursor-test",
  })));

  assert.deepEqual(all.map((e) => e.kind), ["session_init", "text", "tool_call", "tool_output", "turn_end"]);
  assert.equal(all[0]!.sessionId, "full-cursor-test");
});

// artin 2026-09-27 (task #1209): switching a Cursor agent's model always
// reported a detection timeout. The daemon probe and the server request both
// allowed exactly 5s, so a slow `cursor-agent models` lost the race every time.
test("the server waits longer for Cursor model detection than the daemon probe runs", () => {
  assert.ok(
    runtimeModelDetectionRequestTimeoutMs("cursor") > CURSOR_MODEL_DETECTION_TIMEOUT_MS,
    "the daemon must be able to report its own timeout before the server gives up",
  );
  for (const runtime of ["claude", "codex", "grok", "cursor", "opencode"]) {
    assert.equal(runtimeModelDetectionRequestTimeoutMs(runtime), 20_000, runtime);
  }
});

test("a Cursor probe killed at its deadline reports detect_timeout, not a generic failure", async () => {
  assert.deepEqual(
    await detectCursorModelSource(async () => ({ status: null, stdout: "", timedOut: true })),
    { kind: "error", retryable: true, code: "detect_timeout" },
  );
  assert.deepEqual(
    await detectCursorModelSource(async () => ({ status: 1, stdout: "" })),
    { kind: "error", retryable: true },
  );
});

test("the async Cursor probe returns a slow command's live list and kills a hung one at the deadline", { skip: process.platform === "win32" }, async () => {
  const listing = "printf 'composer-2 - Composer 2 (current, default)\\nauto - Auto\\n'";
  // The daemon must keep running while the probe waits (artin: spawnSync froze it).
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 20);
  const ok = await runCursorModelsCommandAsync({ timeoutMs: 5_000, command: "sh", args: ["-c", `sleep 0.3; ${listing}`] });
  clearInterval(ticker);
  assert.ok(ticks >= 5, `the event loop must keep turning during the probe (ticks=${ticks})`);
  assert.equal(ok.timedOut, undefined);
  assert.equal(ok.status, 0);
  assert.deepEqual(
    await detectCursorModelSource(async () => ok),
    { kind: "live", value: { models: [
      { id: "composer-2", label: "Composer 2", verified: "launchable" },
      { id: "auto", label: "Auto", verified: "launchable" },
    ], default: "composer-2" } },
  );

  // A wrapper whose child keeps stdout open must not outlive the deadline, and
  // the deadline must take the wrapper's children with it (no orphan probes).
  const pidFile = path.join(os.tmpdir(), `cursor-probe-child-${process.pid}-${Date.now()}`);
  const started = Date.now();
  const hung = await runCursorModelsCommandAsync({ timeoutMs: 500, command: "sh", args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`] });
  assert.equal(hung.timedOut, true);
  assert.ok(Date.now() - started < 3_000, `probe must settle at its deadline, took ${Date.now() - started}ms`);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), "the wrapper's child must be killed with it");
});

test("the Cursor probe caps its output and kills the probe tree when the cap is exceeded", { skip: process.platform === "win32" }, async () => {
  const killed: number[] = [];
  const result = await runCursorModelsCommandAsync({
    timeoutMs: 5_000,
    command: "sh",
    args: ["-c", "yes cursor-model-line; sleep 30"],
    maxOutputBytes: 4_096,
    killTree: (pid, platform) => { killed.push(pid); killCursorProbeTree(pid, platform); },
  });
  assert.equal(result.timedOut, undefined);
  assert.match(String(result.error?.message), /exceeded 4096 bytes/);
  assert.equal(killed.length, 1, "exceeding the cap must kill the probe tree");
  assert.deepEqual(await detectCursorModelSource(async () => result), { kind: "error", retryable: true });
});

test("on Windows the deadline kills the whole probe tree through the tree killer", async () => {
  // Windows has no process groups; the probe must hand the pid to the tree
  // killer (taskkill /T) instead of killing only the parent.
  const calls: Array<{ pid: number; platform: string }> = [];
  const result = await runCursorModelsCommandAsync({
    timeoutMs: 200,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000)"],
    platform: "win32",
    killTree: (pid, platform) => {
      calls.push({ pid, platform });
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].platform, "win32");
});

test("Cursor on Windows runs the newest installed version's node.exe + index.js, not the cmd/PowerShell wrapper", () => {
  const root = "C:\\Users\\tester\\AppData\\Local\\cursor-agent";
  const shim = `${root}\\cursor-agent.cmd`;
  const older = `${root}\\versions\\2026.9.30-abc1234`;
  const newer = `${root}\\versions\\2026.10.01-e373342`;
  const files = new Set([shim, `${older}\\node.exe`, `${older}\\index.js`, `${newer}\\node.exe`, `${newer}\\index.js`]);
  const prompt = "New message:\r\nhi & a | b > c ^ \"q\" %PATH%";
  const env = { Path: "C:\\Windows\\System32", NO_COLOR: "1" };

  const launch = resolveCursorLaunch(["--print", prompt], {
    platform: "win32",
    env,
    windowsEnvironmentReaderFn: () => ({}),
    existsSyncFn: (file) => files.has(file),
    readdirSyncFn: (dir) => {
      assert.equal(dir, `${root}\\versions`);
      return ["2026.9.30-abc1234", "not-a-version", "2026.10.01-e373342"];
    },
    execFileSyncFn: ((command: string) => {
      assert.equal(command, "powershell.exe");
      return Buffer.from(`${shim}\r\n`);
    }) as any,
  });

  assert.deepEqual(launch, {
    command: `${newer}\\node.exe`,
    args: [`${newer}\\index.js`, "--print", prompt],
    env: { ...env, CURSOR_INVOKED_AS: "cursor-agent.cmd" },
    shell: false,
  });
});

test("Cursor on Windows rejects a wrapper with no usable installed version instead of using cmd.exe", () => {
  const shim = "C:\\Users\\tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
  assert.throws(() => resolveCursorLaunch(["--print", "hi"], {
    platform: "win32",
    windowsEnvironmentReaderFn: () => ({}),
    existsSyncFn: (file) => file === shim,
    readdirSyncFn: () => [],
    readFileSyncFn: () => "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -File \"%SCRIPT_DIR%\\cursor-agent.ps1\" %*\r\n",
    execFileSyncFn: (() => Buffer.from(`${shim}\r\n`)) as any,
  }), (error: unknown) => (error as { reason?: string }).reason === "batch_target_unresolved");
});
