import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRuntimeDeprecated } from "@botiverse/raft-shared";
import { getDriver } from "./index";
import {
  CopilotDriver,
  buildCopilotArgs,
  buildCopilotManagedMcpConfig,
  buildCopilotSpawnEnv,
} from "./copilot";
import type { SpawnContext } from "./types";

function makeSpawnContext(envVars: Record<string, string> | null = null): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing",
    prompt: "hello",
    workingDirectory: "/tmp/copilot-agent",
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: {
      name: "Copilot Agent",
      displayName: null,
      description: null,
      runtime: "copilot",
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

test("buildCopilotSpawnEnv normalizes SLOCK_HOME after agent env overrides", async () => {
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    process.env.SLOCK_HOME = "/tmp/slock-copilot/../slock-copilot";
    const spawnEnv = await buildCopilotSpawnEnv(makeSpawnContext({
      SLOCK_HOME: "/tmp/agent-overrides-slock-home",
      EXTRA_FLAG: "1",
    }));

    assert.equal(spawnEnv.SLOCK_HOME, path.resolve("/tmp/slock-copilot"));
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

test("copilot managed MCP config uses the additional-config HTTP schema and exposes all assigned tools", () => {
  assert.deepEqual(buildCopilotManagedMcpConfig({
    name: "raftmanagedabc123",
    url: "http://127.0.0.1:1234/mcp/opaque",
  }), {
    mcpServers: {
      raftmanagedabc123: {
        type: "http",
        url: "http://127.0.0.1:1234/mcp/opaque",
        tools: ["*"],
      },
    },
  });
  assert.ok(buildCopilotArgs(makeSpawnContext(), "/tmp/private/mcp.json").includes(
    "--additional-mcp-config=@/tmp/private/mcp.json",
  ));
});

test("parseLine: assistant.turn_start emits thinking", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.turn_start",
    data: { turnId: "0", interactionId: "int-1" },
    id: "evt-1",
    timestamp: "2026-04-13T10:00:00.000Z",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "thinking", text: "" });
});

test("parseLine: assistant.turn_start with sessionId in data emits session_init", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.turn_start",
    data: { turnId: "turn-1", sessionId: "copilot-sess-123", interactionId: "int-1" },
    id: "evt-1",
    timestamp: "2026-04-13T10:00:00.000Z",
  }));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "session_init", sessionId: "copilot-sess-123" });
  assert.deepEqual(events[1], { kind: "thinking", text: "" });
});

test("parseLine: assistant.message_delta emits text", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.message_delta",
    data: { messageId: "msg-1", deltaContent: "Hello, " },
    id: "evt-2",
    timestamp: "2026-04-13T10:00:01.000Z",
    ephemeral: true,
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "text", text: "Hello, " });
});

test("parseLine: assistant.reasoning emits thinking", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.reasoning",
    data: { content: "Let me think about this..." },
    id: "evt-3",
    timestamp: "2026-04-13T10:00:01.000Z",
    ephemeral: true,
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "thinking", text: "Let me think about this..." });
});

test("parseLine: assistant.message with toolRequests emits tool_calls", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.message",
    data: {
      messageId: "msg-1",
      content: "I'll search for that.",
      toolRequests: [
        { toolCallId: "call_1", name: "send_message", arguments: { target: "#general", content: "hi" } },
        { toolCallId: "call_2", name: "read_history", arguments: { target: "#dev" } },
      ],
      interactionId: "int-1",
      phase: "tool_use",
    },
    id: "evt-4",
    timestamp: "2026-04-13T10:00:02.000Z",
  }));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "tool_call",
    name: "send_message",
    input: { target: "#general", content: "hi" },
    callId: "call_1",
  });
  assert.deepEqual(events[1], {
    kind: "tool_call",
    name: "read_history",
    input: { target: "#dev" },
    callId: "call_2",
  });
});

// task #26: `tool.execution_complete` ends the request with the same
// `toolCallId`; the driver used to ignore it, so every call stayed open.
test("parseLine: tool.execution_complete ends the matching tool request", () => {
  const driver = new CopilotDriver();
  driver.parseLine(JSON.stringify({
    type: "assistant.message",
    data: { toolRequests: [{ toolCallId: "a", name: "bash", arguments: { command: "false" } }, { toolCallId: "b", name: "view", arguments: {} }] },
  }));
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "a", success: false, error: { message: "exit 2", code: "failure" }, shellExecution: { exitCode: 2 } },
  })), [{ kind: "tool_output", name: "bash", callId: "a", ok: true, exitCode: 2 }], "a command that ran is a finished call");
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "b", success: false, error: { message: "Permission denied", code: "denied" } },
  })), [{ kind: "tool_output", name: "view", callId: "b", ok: false }]);
  driver.parseLine(JSON.stringify({ type: "assistant.message", data: { toolRequests: [{ toolCallId: "t", name: "bash", arguments: {} }] } }));
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "t", success: false, error: { message: "timed out", code: "timeout" }, shellExecution: { exitCode: 137 } },
  })), [{ kind: "tool_output", name: "bash", callId: "t", ok: false, exitCode: 137 }], "a timed-out command did not run to its exit");
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "tool.execution_complete",
    data: { toolCallId: "advisor", success: true },
  })), [], "a completion without a request (Copilot's advisor path) is dropped");
});

test("parseLine: an abort closes the calls Copilot will not complete", () => {
  const driver = new CopilotDriver();
  driver.parseLine(JSON.stringify({ type: "assistant.message", data: { toolRequests: [{ toolCallId: "a", name: "bash", arguments: {} }] } }));
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "abort", data: { reason: "user" } })), [
    { kind: "tool_output", name: "bash", callId: "a" },
  ], "the outcome of an aborted call is unknown");
  assert.deepEqual(driver.parseLine(JSON.stringify({ type: "tool.execution_complete", data: { toolCallId: "a", success: true } })), []);
});

test("parseLine: assistant.message without toolRequests emits nothing", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "assistant.message",
    data: {
      messageId: "msg-1",
      content: "The answer is 4.",
      interactionId: "int-1",
      phase: "final_answer",
    },
    id: "evt-5",
  }));
  assert.equal(events.length, 0);
});

test("parseLine: assistant.turn_end emits turn_end", () => {
  const driver = new CopilotDriver();
  // Set session via turn_start first
  driver.parseLine(JSON.stringify({
    type: "assistant.turn_start",
    data: { turnId: "t1", sessionId: "sess-end-test" },
  }));

  const events = driver.parseLine(JSON.stringify({
    type: "assistant.turn_end",
    data: { turnId: "t1" },
    id: "evt-6",
  }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: "turn_end", sessionId: "sess-end-test" });
});

test("parseLine: result with top-level sessionId emits session_init + turn_end", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    timestamp: "2026-04-13T08:43:28.760Z",
    sessionId: "4c6a8310-0abf-435e-b8c6-353d61f4bca6",
    exitCode: 0,
    usage: { premiumRequests: 1 },
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "session_init");
  assert.equal((events[0] as any).sessionId, "4c6a8310-0abf-435e-b8c6-353d61f4bca6");
  assert.equal(events[1]!.kind, "turn_end");
});

test("parseLine: result with data.sessionId also works", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    data: { sessionId: "result-sess", exitCode: 0 },
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "session_init");
  assert.equal(events[1]!.kind, "turn_end");
});

test("parseLine: result with non-zero exitCode emits error", () => {
  const driver = new CopilotDriver();
  const events = driver.parseLine(JSON.stringify({
    type: "result",
    sessionId: "err-sess",
    exitCode: 1,
  }));
  assert.equal(events.length, 3);
  assert.equal(events[0]!.kind, "session_init");
  assert.equal(events[1]!.kind, "error");
  assert.ok((events[1] as any).message.includes("code 1"));
  assert.equal(events[2]!.kind, "turn_end");
});

test("parseLine: ephemeral session events are ignored", () => {
  const driver = new CopilotDriver();
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "session.mcp_server_status_changed",
    data: {},
    ephemeral: true,
  })), []);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "session.tools_updated",
    data: { model: "gpt-5.4" },
    ephemeral: true,
  })), []);
});

test("parseLine: invalid JSON returns empty", () => {
  const driver = new CopilotDriver();
  assert.deepEqual(driver.parseLine("not json"), []);
  assert.deepEqual(driver.parseLine(""), []);
});

test("encodeStdinMessage always returns null", () => {
  const driver = new CopilotDriver();
  assert.equal(driver.encodeStdinMessage("hello", "s1"), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "idle" }), null);
  assert.equal(driver.encodeStdinMessage("hello", null, { mode: "busy" }), null);
});

test("driver properties are correct", () => {
  const driver = new CopilotDriver();
  assert.equal(driver.id, "copilot");
  assert.equal(driver.supportsStdinNotification, false);
  assert.equal(driver.busyDeliveryMode, "none");
  assert.equal(driver.communication.chat, "slock_cli");
  assert.equal(driver.communication.runtimeControl, "none");
});

test("copilot driver does not expose a runtime-control MCP config helper", () => {
  const driver = new CopilotDriver();

  assert.equal("buildRuntimeActionsMcpConfig" in driver, false);
});

test("parseLine: full turn lifecycle (matches real copilot output)", () => {
  const driver = new CopilotDriver();
  const all: any[] = [];

  // turn_start (no sessionId — matches real copilot behavior)
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.turn_start",
    data: { turnId: "0", interactionId: "int-1" },
  })));

  // message delta (streamed)
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.message_delta",
    data: { deltaContent: "The answer" },
    ephemeral: true,
  })));

  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.message_delta",
    data: { deltaContent: " is 4." },
    ephemeral: true,
  })));

  // final message with tool
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.message",
    data: {
      content: "sending",
      toolRequests: [{ name: "send_message", arguments: { target: "#general" } }],
      phase: "tool_use",
    },
  })));

  // reasoning (opaque, often empty content)
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.reasoning",
    data: { content: "" },
    ephemeral: true,
  })));

  // turn end
  all.push(...driver.parseLine(JSON.stringify({
    type: "assistant.turn_end",
    data: { turnId: "0" },
  })));

  // result (sessionId at top level)
  all.push(...driver.parseLine(JSON.stringify({
    type: "result",
    sessionId: "full-copilot-test",
    exitCode: 0,
  })));

  assert.equal(all.length, 7);
  assert.equal(all[0]!.kind, "thinking"); // turn_start → thinking
  assert.equal(all[1]!.kind, "text");
  assert.equal(all[1]!.text, "The answer");
  assert.equal(all[2]!.kind, "text");
  assert.equal(all[2]!.text, " is 4.");
  assert.equal(all[3]!.kind, "tool_call");
  assert.equal(all[3]!.name, "send_message");
  // reasoning with empty content is not emitted
  assert.equal(all[4]!.kind, "turn_end"); // from turn_end event
  assert.equal(all[5]!.kind, "session_init"); // from result
  assert.equal(all[5]!.sessionId, "full-copilot-test");
  assert.equal(all[6]!.kind, "turn_end"); // from result
});

// Copilot CLI is deprecated in the shared runtime catalog: hidden from every new
// agent / setup / detection-display surface, but an EXISTING copilot agent must
// keep launching through this driver. Counter-example guard: if the deprecation
// ever turns into removal (driver unregistered, launch path changed), this goes red.
test("deprecated Copilot: an existing agent still launches through the copilot CLI", async () => {
  assert.equal(isRuntimeDeprecated("copilot"), true, "the catalog marks Copilot deprecated");
  const driver = getDriver("copilot");
  assert.ok(driver instanceof CopilotDriver);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "copilot-deprecated-launch-"));
  const binDir = path.join(tmp, "bin");
  const workDir = path.join(tmp, "work");
  const oldPath = process.env.PATH;
  const oldSlockHome = process.env.SLOCK_HOME;
  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    const fakeCopilot = path.join(binDir, "copilot");
    // Echo argv back, one arg per line, so the test sees exactly what was launched.
    await writeFile(fakeCopilot, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", "utf8");
    await chmod(fakeCopilot, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    process.env.SLOCK_HOME = path.join(tmp, "home");

    const ctx = makeSpawnContext({ EXTRA_FLAG: "1" });
    ctx.workingDirectory = workDir;
    ctx.config = {
      ...ctx.config,
      model: "gpt-5.4",
      reasoningEffort: "high",
      sessionId: "existing-session",
    };
    const { process: proc } = await driver.spawn(ctx);
    let stdout = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", resolve);
    });

    assert.equal(exitCode, 0);
    const argv = stdout.trim().split("\n");
    assert.deepEqual(argv, buildCopilotArgs(ctx, null));
    assert.ok(argv.includes("--resume=existing-session"), "existing session resumes");
    assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "gpt-5.4"]);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = oldSlockHome;
    await rm(tmp, { recursive: true, force: true });
  }
});
