import assert from "node:assert/strict";
import { test } from "vitest";
import path from "node:path";
import {
  CursorDriver,
  buildCursorArgs,
  buildCursorManagedMcpConfig,
  buildCursorModelProbeEnv,
  buildCursorSpawnEnv,
  detectCursorModels,
  parseCursorModelsOutput,
} from "./cursor.js";
import type { SpawnContext } from "./types.js";

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

test("parseLine: assistant tool_use content emits tool_call", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        name: "mcp__chat__send_message",
        input: { target: "#general", content: "hi" },
      }],
    },
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "tool_call",
    name: "mcp__chat__send_message",
    input: { target: "#general", content: "hi" },
  });
});

test("parseLine: assistant with mixed content emits multiple events", () => {
  const driver = new CursorDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "planning" },
        { type: "text", text: "response" },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/f" } },
      ],
    },
  }));
  assert.equal(events.length, 3);
  assert.equal(events[0]!.kind, "thinking");
  assert.equal(events[1]!.kind, "text");
  assert.equal(events[2]!.kind, "tool_call");
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

test("detectCursorModels returns null when cursor-agent models fails", () => {
  assert.equal(detectCursorModels(() => ({
    status: 1,
    stdout: "",
    error: new Error("keychain locked"),
  })), null);
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

  // assistant tool use
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "mcp__chat__send_message", input: { target: "#general" } }],
    },
  })));

  // result
  all.push(...driver.parseLine(JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: "full-cursor-test",
  })));

  assert.equal(all.length, 4);
  assert.equal(all[0]!.kind, "session_init");
  assert.equal(all[0]!.sessionId, "full-cursor-test");
  assert.equal(all[1]!.kind, "text");
  assert.equal(all[2]!.kind, "tool_call");
  assert.equal(all[3]!.kind, "turn_end");
});
