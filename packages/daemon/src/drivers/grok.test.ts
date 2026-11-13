import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, execFileSync } from "node:child_process";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { classifySpawnFailure, startFailureActivity } from "../spawnFailureClassification";
import type { AgentConfig } from "@botiverse/raft-shared";
import {
  detectGrokModelsFromAcp,
  GrokDriver,
  grokLaunchAllowsPermissionAutoApproval,
  grokModelSetFromInitializeResult,
  prepareGrokLaunch,
  probeGrok,
  resolveGrokCommand,
  resolveGrokHomeFromEnv,
  resolveGrokSpawn,
} from "./grok";
import type { ParsedEvent, SpawnContext } from "./types";
import { createChildProcessEventProbe, type EventProbe } from "../testing/drydock";
import type { runProbeChild } from "./probeChild";

/** task #1277: plays a sync execFileSync stand-in through the async probe-child seam (same error objects, same verdicts). */
function viaProbeChild(execFileSyncFn: typeof execFileSync): typeof runProbeChild {
  return async (command, args) => ({ stdout: String(execFileSyncFn(command, [...args]) ?? ""), stderr: "" });
}

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
  if (scenario === "detect_slow" && message.id === 1) {
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"), 5500);
    return;
  }
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
    if (scenario === "detect_auth") {
      send({ id: message.id, error: { code: -32000, message: "arbitrary localized text" } });
      return;
    }
    if (scenario === "detect_unknown") {
      send({ id: message.id, error: { code: -32603, message: "You are not authenticated." } });
      return;
    }
    if (scenario === "detect_timeout") return;
    if (scenario === "detect_no_models") {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "grok.com" }], _meta: {} } });
      return;
    }
    if (scenario === "detect_unsupported") {
      send({ id: message.id, error: { code: -32601, message: "arbitrary text" } });
      return;
    }
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

test("grok on its default model with an effort selects that default model so the effort reaches Grok", async () => {
  // The effort only travels with session/set_model. Before, an agent on Grok's
  // default model never sent set_model, so its chosen effort was dropped.
  await withScriptedGrok("fresh", async ({ waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok default-model turn_end");
    const messages = readMessages(logPath);
    assert.deepEqual(messages.map((message) => message.method), [
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
    ]);
    assert.equal(messages[1].params._meta.modelId, undefined, "the session still starts on Grok's default");
    assert.deepEqual(messages[2].params, {
      sessionId: "fresh-session-1",
      modelId: "grok-4.5",
      _meta: { reasoningEffort: "medium" },
    });
  }, { model: "default", reasoningEffort: "medium" });
});

test("the launch plan carries the effort on Grok's default model too (the OAR host applies it on its own)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-grok-plan-"));
  try {
    const { binDir } = installScriptedGrok(root);
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const onDefault = await prepareGrokLaunch(makeSpawnContext(root, { model: "default", reasoningEffort: "high" }), { env });
    assert.equal(onDefault.model, undefined, "still Grok's default model");
    assert.equal(onDefault.reasoningEffort, "high");
    const none = await prepareGrokLaunch(makeSpawnContext(root, { model: "default", reasoningEffort: null }), { env });
    assert.equal(none.reasoningEffort, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok on its default model without an effort sends no model selection", async () => {
  await withScriptedGrok("fresh", async ({ waitForEvent, logPath }) => {
    await waitForEvent((event) => event.kind === "turn_end", "grok default-model turn_end");
    assert.deepEqual(readMessages(logPath).map((message) => message.method), [
      "initialize",
      "session/new",
      "session/prompt",
    ]);
  }, { model: "default", reasoningEffort: null });
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
    assert.deepEqual(detected, { kind: "live", value: grokModelSetFromInitializeResult(initializeResult) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok detection preserves auth, unknown and timeout reasons without matching error prose", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-failure-"));
  try {
    const { binDir } = installScriptedGrok(root);
    for (const [scenario, code] of [
      ["detect_auth", "runtime_not_authenticated"],
      ["detect_unknown", "detect_failed"],
      ["detect_timeout", "detect_timeout"],
      ["detect_unsupported", "protocol_unsupported"],
    ]) {
      const outcome = await detectGrokModelsFromAcp({
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_GROK_SCENARIO: scenario },
        cwd: root,
        timeoutMs: scenario === "detect_timeout" ? 500 : 5000,
      });
      assert.deepEqual(outcome, { kind: "error", retryable: true, code }, scenario);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Grok auth capabilities without a catalog are not proof of missing authentication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-empty-"));
  try {
    const { binDir } = installScriptedGrok(root);
    assert.deepEqual(await detectGrokModelsFromAcp({
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_GROK_SCENARIO: "detect_no_models" },
      cwd: root,
    }), { kind: "no_models" });
    // task #1242: the locator's own "not found" (which exits 1) is the confirmed-missing
    // verdict, carried on the outcome. A PATH without any locator is a failed lookup instead.
    const whichNotFound = (() => { throw Object.assign(new Error("which exited 1"), { status: 1 }); }) as unknown as typeof execFileSync;
    assert.deepEqual(await detectGrokModelsFromAcp({
      env: { PATH: path.join(root, "missing-bin") }, cwd: root,
      deps: { platform: "linux", runProbeChildFn: viaProbeChild(whichNotFound), homeDir: path.join(root, "no-home") },
    }), { kind: "error", retryable: true, code: "runtime_not_found", reason: "not_installed" });
    assert.deepEqual(await detectGrokModelsFromAcp({
      env: { PATH: path.join(root, "missing-bin") }, cwd: root, deps: { platform: "linux", homeDir: path.join(root, "no-home") },
    }), { kind: "error", retryable: true, code: "runtime_not_found", reason: "probe_failed" }, "no `which` on PATH: the lookup failed, grok is not proven missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok model discovery tolerates initialize arriving after the old five second deadline", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-slow-"));
  try {
    const { binDir } = installScriptedGrok(root);
    const outcome = await detectGrokModelsFromAcp({
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_GROK_SCENARIO: "detect_slow" },
      cwd: root,
    });
    assert.equal(outcome.kind, "live");
    if (outcome.kind === "live") assert.ok(outcome.value.models.some((m) => m.id === "grok-4.5"));
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

test("probeGrok reports not_installed only when the CLI is absent; installed-but-failing probes keep a failure reason", () => {
  const missing = probeGrok({
    platform: "linux",
    homeDir: "/nonexistent-home",
    existsSyncFn: () => false,
    execFileSyncFn: (() => {
      throw Object.assign(new Error("which: no grok"), { status: 1 });
    }) as unknown as typeof import("node:child_process").execFileSync,
  });
  assert.equal(missing.available, false);
  assert.equal(missing.unavailableReason, "not_installed");
  assert.equal(missing.diagnostic, "No Grok Build CLI was found on PATH.");

  const probeWith = (failure: Error) => probeGrok({
    platform: "linux",
    execFileSyncFn: ((command: string) => {
      if (command === "which") return Buffer.from("/opt/grok/bin/grok\n");
      throw failure;
    }) as unknown as typeof import("node:child_process").execFileSync,
  });
  const cases: Array<[Error, string]> = [
    [Object.assign(new Error("exit 1"), { status: 1 }), "probe_failed"],
    [Object.assign(new Error("spawnSync /opt/grok/bin/grok ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" }), "probe_timeout"],
    [Object.assign(new Error("spawnSync /opt/grok/bin/grok EACCES"), { code: "EACCES" }), "permission_denied"],
    // A resolved command whose exec reports ENOENT (e.g. a missing shebang
    // interpreter) is a broken install, not a missing one.
    [Object.assign(new Error("spawnSync /opt/grok/bin/grok ENOENT"), { code: "ENOENT" }), "probe_failed"],
  ];
  for (const [failure, reason] of cases) {
    const result = probeWith(failure);
    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, reason, failure.message);
  }

  // A PATH lookup that cannot decide (Windows Get-Command timeout) is not a miss.
  const lookupTimeout = probeGrok({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    windowsEnvironmentReaderFn: () => null,
    execFileSyncFn: (() => {
      throw Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" });
    }) as unknown as typeof import("node:child_process").execFileSync,
  });
  assert.equal(lookupTimeout.available, false);
  assert.equal(lookupTimeout.unavailableReason, "probe_timeout");
});

test("only the locator's own not-found status counts as not_installed; a failed or empty lookup does not", () => {
  type Exec = typeof import("node:child_process").execFileSync;
  const posix = (impl: () => unknown) => probeGrok({ platform: "linux", homeDir: "/nonexistent-home", existsSyncFn: () => false, execFileSyncFn: impl as unknown as Exec });
  const windows = (impl: () => unknown) => probeGrok({ platform: "win32", env: { PATH: "C:\\Windows\\System32" }, windowsEnvironmentReaderFn: () => null, existsSyncFn: () => false, execFileSyncFn: impl as unknown as Exec });
  const fail = (status: number) => () => { throw Object.assign(new Error(`exit ${status}`), { status }); };
  // POSIX `which`: 1 = not found; anything else is the locator failing.
  assert.equal(posix(fail(1)).unavailableReason, "not_installed");
  assert.equal(posix(fail(2)).unavailableReason, "probe_failed");
  assert.equal(posix(fail(127)).unavailableReason, "probe_failed");
  assert.equal(posix(() => Buffer.from("")).unavailableReason, "probe_failed");
  // Windows: only the script's reserved CommandNotFound exit (3) is a miss.
  assert.equal(windows(fail(3)).unavailableReason, "not_installed");
  assert.equal(windows(fail(1)).unavailableReason, "probe_failed");
  assert.equal(windows(() => Buffer.from("\r\n")).unavailableReason, "probe_failed");
});

test("task #1242: a runtime_not_found detection carries the verdict of the lookup that failed, from that one lookup only", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-lookup-reason-"));
  try {
    const cases: Array<{ failure: NodeJS.ErrnoException | { status: number }; reason: string; message: RegExp }> = [
      { failure: Object.assign(new Error("spawnSync which ETIMEDOUT"), { code: "ETIMEDOUT" }), reason: "probe_timeout", message: /did not finish within its budget/ },
      { failure: Object.assign(new Error("spawnSync which EACCES"), { code: "EACCES" }), reason: "permission_denied", message: /denied permission/ },
      { failure: Object.assign(new Error("which exited 2"), { status: 2 }), reason: "probe_failed", message: /did not produce a usable result/ },
    ];
    for (const { failure, reason, message } of cases) {
      let lookups = 0;
      const execFileSyncFn = ((): Buffer => {
        lookups += 1;
        // The first lookup fails as described; any later lookup would find grok.
        // The outcome must carry the first verdict, so a later lookup must never run.
        if (lookups === 1) throw failure;
        return Buffer.from(path.join(root, "later", "grok") + "\n");
      }) as unknown as typeof execFileSync;
      const outcome = await detectGrokModelsFromAcp({
        env: { PATH: path.join(root, "missing-bin") }, cwd: root,
        deps: { platform: "linux", runProbeChildFn: viaProbeChild(execFileSyncFn), homeDir: path.join(root, "no-home") },
      });
      assert.deepEqual(outcome, { kind: "error", retryable: true, code: "runtime_not_found", reason }, reason);
      assert.equal(lookups, 1, `${reason}: exactly one lookup decided this detection`);
      // The same lookup verdict decides the resolver's message: never "install it" for an undecided lookup.
      assert.throws(() => resolveGrokSpawn(["agent", "stdio"], { platform: "linux", env: { PATH: path.join(root, "missing-bin") }, execFileSyncFn: (() => { throw failure; }) as unknown as typeof execFileSync, homeDir: path.join(root, "no-home") }), (error: unknown) => {
        assert.ok(error instanceof RuntimeExecutableNotFoundError);
        assert.equal(error.reason, reason);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /Install/);
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1242: a Grok launch whose PATH lookup timed out reaches the start carrier as lookup_timed_out with the resolver's own detail", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-launch-lookup-reason-"));
  try {
    const timedOut = (() => { throw Object.assign(new Error("spawnSync which ETIMEDOUT"), { code: "ETIMEDOUT" }); }) as unknown as typeof execFileSync;
    let thrown: unknown;
    try {
      resolveGrokSpawn(["agent", "stdio"], { platform: "linux", env: { PATH: path.join(root, "missing-bin") }, execFileSyncFn: timedOut, homeDir: path.join(root, "no-home") });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof RuntimeExecutableNotFoundError);
    // The real start path wraps the resolver error; the classifier reads the cause.
    const wrapped = Object.assign(new Error(`Runtime session failed to start: runtime_error (${thrown.message})`), { code: "runtime_not_found", cause: thrown });
    const activity = startFailureActivity(classifySpawnFailure(wrapped), "grok-4");
    assert.deepEqual(activity.spawnFailure, { reason: "runtime_not_found", lookupReason: "lookup_timed_out" });
    assert.equal(activity.detail, thrown.message);
    assert.doesNotMatch(activity.detail, /Install/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277: grok form detection no longer blocks the daemon's event loop on the PATH lookup", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-nonblocking-"));
  try {
    const { binDir } = installScriptedGrok(root);
    // A `which` that answers slowly stands in for a cold PATH scan; the
    // synchronous lookup held the whole daemon for its duration.
    const slowWhich = path.join(binDir, "which");
    writeFileSync(slowWhich, `#!/bin/sh\nsleep 0.4\necho ${path.join(binDir, "grok")}\n`);
    chmodSync(slowWhich, 0o755);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    try {
      const outcome = await detectGrokModelsFromAcp({
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        cwd: root,
        deps: { platform: "linux", homeDir: path.join(root, "no-home") },
      });
      assert.equal(outcome.kind, "live", JSON.stringify(outcome));
      assert.ok(ticks >= 5, `the event loop ran ${ticks} ticks during the 400 ms lookup; a blocking lookup would run none`);
    } finally {
      clearInterval(ticker);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancelled grok form detection does not fall back to a home binary and never starts the ACP child", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-abort-"));
  try {
    const { binDir, logPath } = installScriptedGrok(root);
    // The scripted grok lives in the user-local fallback directory, so an
    // aborted lookup that still consulted the fallback would find it.
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".local", "bin", "grok"), readFileSync(path.join(binDir, "grok")));
    chmodSync(path.join(home, ".local", "bin", "grok"), 0o755);
    const controller = new AbortController();
    await assert.rejects(
      detectGrokModelsFromAcp({
        env: { ...process.env, PATH: path.join(root, "missing-bin") },
        cwd: root,
        deps: {
          platform: "linux",
          homeDir: home,
          signal: controller.signal,
          runProbeChildFn: async () => {
            controller.abort();
            throw Object.assign(new Error("which aborted"), { code: "ABORT_ERR" });
          },
        },
      }),
      (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
      "a cancelled detection rejects with the abort, not with a verdict",
    );
    assert.equal(existsSync(logPath), false, "the ACP child must not have been started after the cancel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancel that lands between the lookup and the ACP spawn stops the detection before the child starts", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-abort-gap-"));
  try {
    const { binDir, logPath } = installScriptedGrok(root);
    const controller = new AbortController();
    await assert.rejects(
      detectGrokModelsFromAcp({
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        cwd: root,
        deps: {
          platform: "linux",
          homeDir: path.join(root, "no-home"),
          signal: controller.signal,
          // The lookup succeeds; the cancel arrives as it returns.
          runProbeChildFn: async () => {
            controller.abort();
            return { stdout: `${path.join(binDir, "grok")}\n`, stderr: "" };
          },
        },
      }),
      (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
    );
    assert.equal(existsSync(logPath), false, "the ACP child must not start after a cancel that arrived before the spawn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancel while the ACP child is active kills it and rejects with the abort, well before the deadline", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-abort-active-"));
  try {
    const { binDir } = installScriptedGrok(root);
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      detectGrokModelsFromAcp({
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_GROK_SCENARIO: "detect_slow" },
        cwd: root,
        timeoutMs: 10_000,
        deps: { platform: "linux", homeDir: path.join(root, "no-home"), signal: controller.signal },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR");
        const cleanup = (error as { cleanup?: { childExited: boolean; waitedMs: number } }).cleanup;
        assert.ok(cleanup, "a cancel that killed the ACP child reports its cleanup");
        assert.equal(cleanup.childExited, true, "the ACP child's exit was observed, not assumed");
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5000, "the cancel ended the detection, not the 10 s deadline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewer counterexample (Huaihuai, #9791): cancelled Grok form detection never launches ACP through a home fallback", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "review-abort-grok-"));
  const marker = path.join(root, "started");
  const bin = path.join(root, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "grok"), "#!" + process.execPath + "\n" + `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`, { mode: 0o755 });
  const controller = new AbortController();
  controller.abort();
  try {
    await detectGrokModelsFromAcp({ env: { ...process.env, HOME: root }, timeoutMs: 2000, deps: { platform: "linux", homeDir: root, signal: controller.signal } }).catch(() => undefined);
    assert.equal(existsSync(marker), false, "an already cancelled operation launched ACP");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewer counterexample (Huaihuai, #9791): an active-cancel against a Grok that ignores SIGTERM still ends the process, and the rejection says so", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-detect-abort-sigterm-"));
  try {
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const pidFile = path.join(root, "grok.pid");
    // A grok that ignores SIGTERM, records its pid and never answers: only a
    // SIGKILL to its process group ends it.
    writeFileSync(path.join(binDir, "grok"), `#!${process.execPath}
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const controller = new AbortController();
    const startedAt = Date.now();
    let pid = 0;
    const abortOnceStarted = setInterval(() => {
      if (!existsSync(pidFile)) return;
      pid = Number(readFileSync(pidFile, "utf8"));
      clearInterval(abortOnceStarted);
      controller.abort();
    }, 20);
    try {
      await assert.rejects(
        detectGrokModelsFromAcp({
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
          cwd: root,
          timeoutMs: 10_000,
          deps: { platform: "linux", homeDir: path.join(root, "no-home"), signal: controller.signal },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR");
          const cleanup = (error as { cleanup?: { childExited: boolean; waitedMs: number } }).cleanup;
          assert.deepEqual(cleanup && { childExited: cleanup.childExited }, { childExited: true }, "the exit was observed");
          return true;
        },
      );
    } finally {
      clearInterval(abortOnceStarted);
    }
    assert.ok(pid > 0, "the scripted grok started");
    assert.throws(() => process.kill(pid, 0), "the Grok process is gone after the rejection, SIGTERM-immune or not");
    assert.ok(Date.now() - startedAt < 8000, "the cancel ended the detection, not the deadline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (launch): a grok spawn with an already-cancelled launch signal creates no child and rejects with the abort", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-launch-cancel-"));
  try {
    const { binDir, logPath } = installScriptedGrok(root);
    const controller = new AbortController();
    controller.abort();
    const driver = new GrokDriver();
    const previous = { PATH: process.env.PATH, SCRIPTED_GROK_LOG: process.env.SCRIPTED_GROK_LOG };
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
    process.env.SCRIPTED_GROK_LOG = logPath;
    try {
      await assert.rejects(
        driver.spawn({ ...makeSpawnContext(root), launchSignal: controller.signal }),
        (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
      );
    } finally {
      process.env.PATH = previous.PATH;
      if (previous.SCRIPTED_GROK_LOG === undefined) delete process.env.SCRIPTED_GROK_LOG; else process.env.SCRIPTED_GROK_LOG = previous.SCRIPTED_GROK_LOG;
    }
    assert.equal(existsSync(logPath), false, "no grok child was started");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (launch): a launch cancelled while the PATH lookup is running creates no child", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "grok-launch-cancel-mid-"));
  try {
    const { binDir, logPath } = installScriptedGrok(root);
    const slowWhich = path.join(binDir, "which");
    writeFileSync(slowWhich, `#!/bin/sh\nsleep 0.5\necho ${path.join(binDir, "grok")}\n`);
    chmodSync(slowWhich, 0o755);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const driver = new GrokDriver();
    const previous = { PATH: process.env.PATH, SCRIPTED_GROK_LOG: process.env.SCRIPTED_GROK_LOG };
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
    process.env.SCRIPTED_GROK_LOG = logPath;
    try {
      await assert.rejects(
        driver.spawn({ ...makeSpawnContext(root), launchSignal: controller.signal }),
        (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
      );
    } finally {
      process.env.PATH = previous.PATH;
      if (previous.SCRIPTED_GROK_LOG === undefined) delete process.env.SCRIPTED_GROK_LOG; else process.env.SCRIPTED_GROK_LOG = previous.SCRIPTED_GROK_LOG;
    }
    assert.equal(existsSync(logPath), false, "no grok child was started after the cancel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
