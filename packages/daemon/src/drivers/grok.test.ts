import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AgentConfig } from "@botiverse/raft-shared";
import {
  detectGrokModelsFromAcp,
  GrokDriver,
  grokLaunchAllowsPermissionAutoApproval,
  grokModelSetFromInitializeResult,
  probeGrok,
  resolveGrokCommand,
  resolveGrokHomeFromEnv,
  resolveGrokSpawn,
} from "./grok.js";
import type { ParsedEvent, SpawnContext } from "./types.js";
import { createChildProcessEventProbe, type EventProbe } from "../testing/drydock.js";

const grokConfig: AgentConfig = {
  name: "grok-agent",
  displayName: "Grok Agent",
  description: "test agent",
  model: "grok-4.5",
  runtime: "grok",
  reasoningEffort: "low",
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.raft.ai",
  authToken: "sk_machine_test",
};

function makeSpawnContext(
  workingDirectory: string,
  overrides: Partial<SpawnContext["config"]> = {},
): SpawnContext {
  return {
    agentId: "agent-1",
    config: { ...grokConfig, ...overrides },
    standingPrompt: "standing instructions",
    prompt: "initial prompt",
    workingDirectory,
    slockCliPath: process.execPath,
    daemonApiKey: "sk_machine_test",
    launchId: "launch-1",
  };
}

function installScriptedGrok(root: string): { binDir: string; logPath: string } {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "grok-acp.log");
  const scriptPath = path.join(binDir, "grok");
  writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("grok 0.2.101 (test)\\n");
  process.exit(0);
}
if (args.join(" ") === "agent stdio --help") {
  process.stdout.write("Usage: grok agent stdio\\n");
  process.exit(0);
}
if (args.join(" ") !== "agent --no-leader --always-approve stdio") {
  process.stderr.write("unexpected argv: " + JSON.stringify(args) + "\\n");
  process.exit(2);
}

const scenario = process.env.SCRIPTED_GROK_SCENARIO || "fresh";
const logPath = process.env.SCRIPTED_GROK_LOG;
function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
}
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function sendTurnCompletion(message) {
  send({
    method: "_x.ai/session_notification",
    params: {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 },
      },
    },
  });
  send({
    id: message.id,
    result: {
      stopReason: "end_turn",
      _meta: {
        sessionId: message.params.sessionId,
        promptId: "prompt-1",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 },
      },
    },
  });
}

let pendingPromptMessage = null;
let replaySent = false;
let permissionPromptCount = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    if (scenario === "permission_pre_session") {
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "future-session",
          toolCall: { toolCallId: "tool-call-1", title: "Run before session init" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
      });
    }
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        _meta: {
          modelState: {
            currentModelId: "grok-4.5",
            availableModels: [
              {
                modelId: "grok-4.5",
                name: "Grok 4.5",
                _meta: {
                  reasoningEffort: "high",
                  reasoningEfforts: [
                    { id: "high", value: "high", default: true },
                    { id: "medium", value: "medium", default: false },
                    { id: "low", value: "low", default: false },
                  ],
                },
              },
              { modelId: "grok-composer-2.5-fast", name: "Composer 2.5", _meta: {} },
            ],
          },
        },
      },
    });
    return;
  }
  if (message.method === "session/load") {
    if (scenario === "resume_missing") {
      send({ id: message.id, error: { code: -32603, message: "Path not found", data: { code: "FS_NOT_FOUND" } } });
    } else {
      send({ id: message.id, result: { _meta: { sessionId: message.params.sessionId } } });
    }
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "fresh-session-1" } });
    return;
  }
  if (message.method === "session/set_model") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    if (scenario === "prompt_auth_error") {
      send({ id: message.id, error: { code: -32000, message: "Login required: run grok login" } });
      return;
    }
    if (scenario === "permission_late") {
      sendTurnCompletion(message);
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: "tool-call-1", title: "Run after turn completion" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
      });
      return;
    }
    if (scenario.startsWith("permission_") && scenario !== "permission_pre_session") {
      permissionPromptCount += 1;
      pendingPromptMessage = message;
      send({
        method: "_x.ai/session_notification",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "pending_interaction",
            tool_call_id: "tool-call-1",
            kind: "permission",
          },
        },
      });
      const sessionId = scenario === "permission_wrong_session"
        ? "other-session"
        : message.params.sessionId;
      const options = scenario === "permission_no_allow_once"
        ? [
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ]
        : [
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          ];
      send({
        id: "permission-1",
        method: scenario === "permission_unknown_method"
          ? "session/unknown_permission"
          : "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-call-1", title: "Run a protected tool" },
          options,
        },
      });
      if (scenario === "permission_cross_turn_replay" && permissionPromptCount > 1) {
        send({
          id: "permission-barrier",
          method: "session/unknown_permission",
          params: { sessionId },
        });
      }
      return;
    }
    sendTurnCompletion(message);
    return;
  }
  if (message.id === "permission-1" && pendingPromptMessage) {
    if (
      message.result?.outcome?.outcome === "selected"
      && message.result?.outcome?.optionId === "allow-once"
    ) {
      if (scenario === "permission_cross_turn_replay" && permissionPromptCount > 1) return;
      send({
        method: "_x.ai/session_notification",
        params: {
          sessionId: pendingPromptMessage.params.sessionId,
          update: {
            sessionUpdate: "interaction_resolved",
            tool_call_id: "tool-call-1",
            kind: "permission",
          },
        },
      });
      if (scenario === "permission_duplicate" && !replaySent) {
        replaySent = true;
        send({
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId: pendingPromptMessage.params.sessionId,
            toolCall: { toolCallId: "tool-call-1", title: "Replayed permission" },
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        });
        setTimeout(() => sendTurnCompletion(pendingPromptMessage), 20);
      } else {
        sendTurnCompletion(pendingPromptMessage);
      }
    }
    return;
  }
  if (message.method === "_x.ai/interject") {
    send({ id: message.id, result: { status: "queued" } });
  }
});
`, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { binDir, logPath };
}

interface ScriptedGrokParser extends EventProbe<ParsedEvent> {
  dispose(): void;
  assertDisposed(): void;
}

function attachStdoutParser(
  driver: GrokDriver,
  proc: ChildProcess,
  options: { delayInitializeResult?: boolean } = {},
): ScriptedGrokParser {
  const probe = createChildProcessEventProbe<ParsedEvent>(proc, {
    processName: "Scripted Grok",
    timeoutMs: 15_000,
  });
  let buffer = "";
  let disposed = false;
  const pendingParses = new Set<ReturnType<typeof setTimeout>>();
  const recordLine = (line: string): void => {
    if (disposed) return;
    for (const event of driver.parseLine(line)) probe.record(event);
  };
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: unknown; result?: { protocolVersion?: unknown } };
      if (options.delayInitializeResult && message.id === 1 && message.result?.protocolVersion === 1) {
        // Keep the permission request and initialize response in separate parser
        // turns so teardown ownership is a deterministic contract, not a pipe-
        // chunking race. dispose() must cancel this pending parse before kill.
        const timer = setTimeout(() => {
          pendingParses.delete(timer);
          recordLine(line);
        }, 250);
        pendingParses.add(timer);
      } else {
        recordLine(line);
      }
    }
  };
  proc.stdout?.on("data", onData);
  return {
    ...probe,
    dispose() {
      disposed = true;
      proc.stdout?.off("data", onData);
      for (const timer of pendingParses) clearTimeout(timer);
      pendingParses.clear();
    },
    assertDisposed() {
      assert.equal(disposed, true, "scripted Grok parser must be disposed before child termination");
      assert.equal(pendingParses.size, 0, "scripted Grok parser must not retain a deferred parse at teardown");
    },
  };
}

interface ScriptedGrokCloseTracker {
  closed: Promise<void>;
  closeObserved: boolean;
  processError: Error | null;
}

function trackScriptedGrokClose(proc: ChildProcess): ScriptedGrokCloseTracker {
  const tracker: ScriptedGrokCloseTracker = {
    closed: Promise.resolve(),
    closeObserved: false,
    processError: null,
  };
  const onError = (error: Error): void => {
    tracker.processError = error;
  };
  proc.on("error", onError);
  tracker.closed = new Promise<void>((resolve) => {
    proc.once("close", () => {
      tracker.closeObserved = true;
      proc.off("error", onError);
      resolve();
    });
  });
  return tracker;
}

async function terminateScriptedGrok(proc: ChildProcess, tracker: ScriptedGrokCloseTracker): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
  await tracker.closed;
  assert.equal(tracker.closeObserved, true, "scripted Grok child close must settle before fixture removal");
  if (tracker.processError) throw tracker.processError;
}

function readMessages(logPath: string): any[] {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLoggedMessage(
  logPath: string,
  predicate: (message: any) => boolean,
  description: string,
): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readMessages(logPath).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function withScriptedGrok(
  scenario: string,
  fn: (ctx: {
    driver: GrokDriver;
    events: readonly ParsedEvent[];
    waitForEvent: EventProbe<ParsedEvent>["waitFor"];
    writeStdinLine: (line: string) => void;
    logPath: string;
    workDir: string;
  }) => Promise<void>,
  overrides: Partial<SpawnContext["config"]> = {},
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-scripted-acp-"));
  const workDir = path.join(root, "work");
  const grokHome = path.join(root, "grok-home");
  mkdirSync(workDir, { recursive: true });
  const { binDir, logPath } = installScriptedGrok(root);
  const previous = {
    PATH: process.env.PATH,
    SCRIPTED_GROK_SCENARIO: process.env.SCRIPTED_GROK_SCENARIO,
    SCRIPTED_GROK_LOG: process.env.SCRIPTED_GROK_LOG,
    GROK_HOME: process.env.GROK_HOME,
  };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.SCRIPTED_GROK_SCENARIO = scenario;
  process.env.SCRIPTED_GROK_LOG = logPath;
  process.env.GROK_HOME = grokHome;

  const driver = new GrokDriver();
  let proc: ChildProcess | null = null;
  let parser: ScriptedGrokParser | null = null;
  let closeTracker: ScriptedGrokCloseTracker | null = null;
  try {
    const result = await driver.spawn(makeSpawnContext(workDir, overrides));
    proc = result.process;
    closeTracker = trackScriptedGrokClose(proc);
    parser = attachStdoutParser(driver, proc, {
      delayInitializeResult: scenario === "permission_pre_session",
    });
    const { events, waitFor: waitForEvent } = parser;
    await fn({
      driver,
      events,
      waitForEvent,
      writeStdinLine: (line) => proc?.stdin?.write(`${line}\n`),
      logPath,
      workDir,
    });
  } finally {
    parser?.dispose();
    let cleanupError: unknown = null;
    try {
      parser?.assertDisposed();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (proc && closeTracker) await terminateScriptedGrok(proc, closeTracker);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!proc || closeTracker?.closeObserved) rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (cleanupError) throw cleanupError;
  }
}

test("grok ACP handshake starts a session, selects the model, and deduplicates completion", async () => {
  await withScriptedGrok("fresh", async ({ driver, events, waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok initial turn_end");

    assert.equal(driver.currentSessionId, "fresh-session-1");
    assert.deepEqual(events, [
      { kind: "session_init", sessionId: "fresh-session-1" },
      {
        kind: "telemetry",
        name: "token_usage",
        source: "grok_acp",
        usageKind: "per_turn",
        sessionId: "fresh-session-1",
        turnId: "prompt-1",
        attrs: { input_tokens: 3, output_tokens: 2, total_tokens: 5, model_calls: 1 },
      },
      { kind: "turn_end", sessionId: "fresh-session-1" },
    ]);

    const messages = readMessages(logPath);
    assert.deepEqual(messages.map((message) => message.method), [
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    assert.equal(messages[1].params._meta.systemPromptOverride, "standing instructions");
    assert.equal(messages[1].params._meta.yoloMode, true);
    assert.equal(messages[1].params._meta.modelId, "grok-4.5");
    assert.deepEqual(messages[2].params, {
      sessionId: "fresh-session-1",
      modelId: "grok-4.5",
      _meta: { reasoningEffort: "low" },
    });
    assert.deepEqual(messages[3].params.prompt, [{ type: "text", text: "initial prompt" }]);
  });
});

test("grok missing resume falls back to a fresh session with a visible recovery notice", async () => {
  await withScriptedGrok("resume_missing", async ({ events, waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok recovered turn_end");

    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.deepEqual(events.slice(0, 3), [
      {
        kind: "telemetry",
        name: "recovery",
        source: "grok_resume_missing_session",
        attrs: {
          resume_error_class: "missing_session",
          recovery_action: "fallback_fresh_thread",
        },
      },
      {
        kind: "runtime_recovery",
        source: "grok_resume_missing_session",
        resumeErrorClass: "missing_session",
        recoveryAction: "fallback_fresh_thread",
        message: "Grok Build could not resume its previous session; Raft started a fresh Grok session.",
        details: "Use Raft conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Grok session context is loaded.",
        requestedSessionId: "missing-session-1",
      },
      { kind: "session_init", sessionId: "fresh-session-1" },
    ]);

    const messages = readMessages(logPath);
    assert.deepEqual(messages.map((message) => message.method), [
      "initialize",
      "session/load",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    assert.equal(messages[1].params.sessionId, "missing-session-1");
    assert.match(messages[4].params.prompt[0].text, /^Grok Build could not resume its previous session/);
    assert.match(messages[4].params.prompt[0].text, /\n\ninitial prompt$/);
  }, { sessionId: "missing-session-1" });
});

test("grok prompt authentication failure is a startup error with an actionable login message", async () => {
  await withScriptedGrok("prompt_auth_error", async ({ events, waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "error", "grok auth startup error");

    assert.deepEqual(events, [
      { kind: "session_init", sessionId: "fresh-session-1" },
      {
        kind: "error",
        message: "Login required: run grok login",
        startupRequestMethod: "session/prompt",
      },
    ]);
    assert.deepEqual(readMessages(logPath).map((message) => message.method), [
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
  });
});

test("grok always-approve session selects the offered allow-once permission and continues the turn", async () => {
  await withScriptedGrok("permission_allow_once", async ({ events, waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok permission-approved turn_end");

    const responses = readMessages(logPath).filter((message) => message.id === "permission-1");
    assert.deepEqual(responses, [{
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }]);
    assert.equal(events.some((event) => event.kind === "error" || event.kind === "delivery_error"), false);
    assert.ok(events.some((event) => event.kind === "turn_end"));
  });
});

test("grok permission request-id reuse with different bytes fails closed without a second response", async () => {
  await withScriptedGrok("permission_duplicate", async ({ events, waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok replay-protected turn_end");

    const responses = readMessages(logPath).filter((message) => message.id === "permission-1");
    assert.deepEqual(responses, [{
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }]);
    assert.ok(events.some(
      (event) => event.kind === "error" && /reused a consumed JSON-RPC id/.test(event.message),
    ));
  });
});

test("grok permission replay across turns receives no second response for the same request", async () => {
  await withScriptedGrok(
    "permission_cross_turn_replay",
    async ({ driver, events, waitForEvent, writeStdinLine, logPath }) => {
      await waitForEvent((event) => event.kind === "turn_end", "first Grok permission-approved turn_end");

      const secondPrompt = driver.encodeStdinMessage("second prompt", driver.currentSessionId, { mode: "idle" });
      assert.ok(secondPrompt);
      writeStdinLine(secondPrompt);
      await waitForLoggedMessage(
        logPath,
        (message) => message.id === "permission-barrier" && message.error?.code === -32601,
        "post-replay Grok request barrier",
      );

      const responses = readMessages(logPath).filter((message) => message.id === "permission-1");
      assert.equal(responses.length, 1, "an exact replay in a later turn must not receive a second response");
      assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
    },
  );
});

test("grok permission auto-approval requires both launch and session yolo facts", () => {
  assert.equal(grokLaunchAllowsPermissionAutoApproval(
    ["agent", "--no-leader", "--always-approve", "stdio"],
    { yoloMode: true },
  ), true);
  assert.equal(grokLaunchAllowsPermissionAutoApproval(
    ["agent", "--no-leader", "stdio"],
    { yoloMode: true },
  ), false);
  assert.equal(grokLaunchAllowsPermissionAutoApproval(
    ["agent", "--no-leader", "--always-approve", "stdio"],
    { yoloMode: false },
  ), false);
});

for (const [scenario, expectedCode, expectedMessage] of [
  ["permission_pre_session", -32602, /outside an active always-approve turn/],
  ["permission_late", -32602, /outside an active always-approve turn/],
  ["permission_wrong_session", -32602, /does not match the active Grok session/],
  ["permission_no_allow_once", -32602, /does not offer an allow_once option/],
  ["permission_unknown_method", -32601, /is not supported/],
] as const) {
  test(`grok permission request fails closed: ${scenario}`, async () => {
    await withScriptedGrok(scenario, async ({ logPath }) => {
      const response = await waitForLoggedMessage(
        logPath,
        (message) => message.id === "permission-1",
        `${scenario} response`,
      );
      assert.equal(response.result, undefined);
      assert.equal(response.error?.code, expectedCode);
      assert.match(response.error?.message ?? "", expectedMessage);

      const permissionResponses = readMessages(logPath).filter((message) => message.id === "permission-1");
      assert.equal(permissionResponses.length, 1, "pending_interaction must not manufacture a second response");
    });
  });
}

test("grok driver distinguishes idle prompt from busy interjection", () => {
  const driver = new GrokDriver();
  const idle = driver.encodeStdinMessage("follow up", "session-1", { mode: "idle" });
  assert.ok(idle);
  assert.deepEqual(JSON.parse(idle), {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { sessionId: "session-1", prompt: [{ type: "text", text: "follow up" }] },
  });

  const busy = driver.encodeStdinMessage("steer now", "session-1", { mode: "busy" });
  assert.ok(busy);
  assert.deepEqual(JSON.parse(busy), {
    jsonrpc: "2.0",
    id: 2,
    method: "_x.ai/interject",
    params: {
      sessionId: "session-1",
      text: "steer now",
      interjectionId: "raft-2",
    },
  });
});

test("grok unsupported interjection becomes a delivery error and preserves the active turn", () => {
  const driver = new GrokDriver();
  assert.ok(driver.encodeStdinMessage("start", "session-1", { mode: "idle" }));
  const busy = driver.encodeStdinMessage("steer", "session-1", { mode: "busy" });
  assert.ok(busy);
  const busyRequest = JSON.parse(busy);

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: busyRequest.id,
    error: { code: -32601, message: "Method not found: _x.ai/interject" },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "delivery_error");
  if (events[0]?.kind !== "delivery_error") assert.fail("expected delivery error");
  assert.deepEqual({ ...events[0], payloadBytes: undefined }, {
    kind: "delivery_error",
    message: "Method not found: _x.ai/interject",
    requestMethod: "turn/steer",
    source: "grok_acp_response",
    payloadBytes: undefined,
  });
  assert.ok((events[0].payloadBytes ?? 0) > 0);
  assert.ok(driver.encodeStdinMessage("turn remains active", "session-1", { mode: "busy" }));
});

test("grok response-first completion ignores its late notification while the next prompt stays busy", () => {
  const driver = new GrokDriver();
  const firstPrompt = driver.encodeStdinMessage("first", "session-1", { mode: "idle" });
  assert.ok(firstPrompt);
  const firstRequest = JSON.parse(firstPrompt);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: firstRequest.id,
    result: {
      stopReason: "end_turn",
      _meta: { promptId: "prompt-1" },
    },
  })), [{ kind: "turn_end", sessionId: "session-1" }]);

  const secondPrompt = driver.encodeStdinMessage("second", "session-1", { mode: "idle" });
  assert.ok(secondPrompt);
  const secondRequest = JSON.parse(secondPrompt);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
      },
    },
  })), []);
  assert.ok(
    driver.encodeStdinMessage("still steerable", "session-1", { mode: "busy" }),
    "late prompt-1 completion must not clear prompt-2 busy steering",
  );

  assert.deepEqual(driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: secondRequest.id,
    result: {
      stopReason: "end_turn",
      _meta: { promptId: "prompt-2" },
    },
  })), [{ kind: "turn_end", sessionId: "session-1" }]);
  assert.equal(driver.encodeStdinMessage("done", "session-1", { mode: "busy" }), null);
});

test("grok model discovery reads the live initialize modelState shape", async () => {
  const initializeResult = {
    _meta: {
      modelState: {
        currentModelId: "grok-4.5",
        availableModels: [
          {
            modelId: "grok-4.5",
            name: "Grok 4.5",
            _meta: {
              reasoningEffort: "high",
              reasoningEfforts: [
                { id: "high", default: true },
                { id: "medium", default: false },
                { id: "low", default: false },
              ],
            },
          },
          { modelId: "grok-composer-2.5-fast", name: "Composer 2.5", _meta: {} },
        ],
      },
    },
  };
  assert.deepEqual(grokModelSetFromInitializeResult(initializeResult), {
    default: "grok-4.5",
    models: [
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        verified: "launchable",
        supportedReasoningEfforts: ["high", "medium", "low"],
        defaultReasoningEffort: "high",
      },
      { id: "grok-composer-2.5-fast", label: "Composer 2.5", verified: "launchable" },
    ],
  });

  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-models-"));
  try {
    const { binDir } = installScriptedGrok(root);
    const detected = await detectGrokModelsFromAcp({
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
      cwd: root,
    });
    assert.deepEqual(detected, grokModelSetFromInitializeResult(initializeResult));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok probe and home resolution use the installed CLI and explicit GROK_HOME", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-probe-"));
  try {
    const { binDir } = installScriptedGrok(root);
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const command = path.join(binDir, "grok");
    assert.equal(resolveGrokCommand({ env }), command);
    assert.deepEqual(resolveGrokSpawn(["agent", "stdio"], { env }), {
      command,
      args: ["agent", "stdio"],
      shell: false,
    });
    assert.deepEqual(probeGrok({ env }), { available: true, version: "grok 0.2.101 (test)" });
    assert.equal(
      resolveGrokHomeFromEnv({ GROK_HOME: "relative-grok" }, { cwd: root, homeDir: "/unused" }),
      path.join(root, "relative-grok"),
    );
    assert.equal(resolveGrokHomeFromEnv({}, { homeDir: root }), path.join(root, ".grok"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
