import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  BasicTracer,
  MemoryTraceSink,
  createSpanAttrContractTracer,
} from "@botiverse/raft-shared";
import { buildCodexAppServerArgs, CodexDriver, clearCodexProbeCacheForTests, detectCodexModels, detectCodexModelsFromAppServer, probeCodex, compareCodexVersions, parseCodexVersion, resolveCodexCommand, resolveCodexSpawn } from "./codex.js";
import { resolveCodexHomeRootFromEnv } from "./codexHome.js";
import type { ParsedEvent, SpawnContext } from "./types.js";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core.js";

const codexConfig = {
  name: "codex-agent",
  displayName: "Codex Agent",
  description: "test agent",
  model: "gpt-5.3-codex",
  runtime: "codex",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: "sk_machine_test",
};

function sha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function codexToolingObservation(
  sessionRequestMethod: "thread/start" | "thread/resume",
  managedMcpStatus: Extract<ParsedEvent, { kind: "runtime_tooling" }>["managedMcpStatus"] = "not_configured",
): Extract<ParsedEvent, { kind: "runtime_tooling" }> {
  return {
    kind: "runtime_tooling",
    source: "codex_app_server",
    sessionRequestMethod,
    nativeToolInventoryObservation: "unreported_by_app_server",
    cliTransportConfigured: true,
    managedMcpConfigured: managedMcpStatus !== "not_configured",
    managedMcpStatus,
  };
}

test("codex app-server receives only the launch-scoped managed MCP loopback URL", () => {
  assert.deepEqual(buildCodexAppServerArgs({
    name: "raft_managed",
    url: "http://127.0.0.1:43123/mcp/opaque",
  }), [
    "app-server",
    "-c",
    'mcp_servers.raft_managed.url="http://127.0.0.1:43123/mcp/opaque"',
    "--listen",
    "stdio://",
  ]);
  assert.doesNotMatch(JSON.stringify(buildCodexAppServerArgs({
    name: "raft_managed",
    url: "http://127.0.0.1:43123/mcp/opaque",
  })), /Authorization|private\.example/);
});

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function makeSpawnContext(
  workingDirectory: string,
  overrides: Partial<SpawnContext["config"]> = {},
): SpawnContext {
  return {
    agentId: "agent-1",
    config: {
      ...codexConfig,
      ...overrides,
    },
    standingPrompt: "stand still",
    prompt: "initial prompt",
    workingDirectory,
    slockCliPath: process.execPath,
    daemonApiKey: "sk_machine_test",
    launchId: "launch-1",
  };
}

function installScriptedCodexAppServer(root: string): { binDir: string; logPath: string } {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "codex-app-server.log");
  const scriptPath = path.join(binDir, "codex");
  writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const scenario = process.env.SCRIPTED_CODEX_SCENARIO || "fresh";
const logPath = process.env.SCRIPTED_CODEX_LOG;

function log(message) {
  if (!logPath) return;
  const entry = { ...message };
  if (message.method === "thread/start" || message.method === "thread/resume") {
    entry.codexHomeEnv = process.env.CODEX_HOME || null;
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function writeTrustConfig(cwd) {
  const root = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(path.join(root, "config.toml"), "[projects." + JSON.stringify(cwd) + "]\\ntrust_level = \\"trusted\\"\\n");
}

if (process.argv[2] === "app-server" && process.argv[3] === "--help") {
  process.stdout.write("Usage: codex app-server\\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server" || process.argv[3] !== "--listen" || process.argv[4] !== "stdio://") {
  console.error("unexpected argv: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "scripted-codex/1.0.0 (Mac OS 26.4.1; arm64) Kaku/0.11.0 (scripted-codex; 1.0.0)" } });
    return;
  }

  if (message.method === "thread/resume") {
    if (scenario === "resume_pending") {
      return;
    }
    if (scenario === "resume_missing_rollout") {
      send({ id: message.id, error: { message: "No rollout found for thread " + message.params.threadId } });
      return;
    }
    if (scenario === "resume_thread_writer_busy") {
      send({ id: message.id, error: { message: "Thread " + message.params.threadId + " already has an active writer" } });
      return;
    }
    if (scenario === "resume_permission_denied") {
      send({ id: message.id, error: { message: "No permission to access thread " + message.params.threadId } });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "trust_write_after_log_delay") {
      setTimeout(() => {
        writeTrustConfig(message.params.cwd);
        send({ id: message.id, result: { thread: { id: "fresh-thread-1" } } });
      }, 25);
      return;
    }
    if (scenario === "trust_write") {
      writeTrustConfig(message.params.cwd);
    }
    send({ id: message.id, result: { thread: { id: "fresh-thread-1" } } });
    return;
  }

  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "quick" },
              { reasoningEffort: "medium", description: "balanced" },
            ],
            defaultReasoningEffort: "medium",
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "hidden-model",
            displayName: "Hidden",
            hidden: true,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { binDir, logPath };
}

function attachCodexStdoutParser(driver: CodexDriver, proc: ChildProcess, events: ParsedEvent[]): void {
  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(...driver.parseLine(line));
    }
  });
}

function readScriptedCodexMessages(logPath: string): any[] {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Snapshot wire methods and payloads, excluding transport IDs and harness metadata.
function readScriptedCodexRequests(logPath: string, workDir: string) {
  return readScriptedCodexMessages(logPath).map(({ method, params }) => ({
    method,
    params: params?.cwd === workDir ? { ...params, cwd: "<workDir>" } : params,
  }));
}

function fileIncludes(filePath: string, expected: string): boolean {
  try {
    return readFileSync(filePath, "utf8").includes(expected);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function terminateScriptedCodexAppServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  proc.kill("SIGTERM");

  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (terminated) return;

  proc.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

function captureCodexStdin(driver: CodexDriver): string[] {
  const writes: string[] = [];
  (driver as any).process = {
    stdin: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    },
  };
  return writes;
}

function parseOnlyJsonRpcWrite(writes: string[]): any {
  assert.equal(writes.length, 1);
  return JSON.parse(writes[0]!.trim());
}

function sessionIdForScenario(scenario: string): string | null {
  switch (scenario) {
    case "resume_missing_rollout":
      return "missing-thread-1";
    case "resume_thread_writer_busy":
      return "busy-thread-1";
    case "resume_permission_denied":
      return "forbidden-thread-1";
    case "resume_success":
    case "resume_pending":
      return "existing-thread-1";
    default:
      return null;
  }
}

async function withScriptedCodexAppServer(
  scenario: string,
  fn: (ctx: { driver: CodexDriver; events: ParsedEvent[]; logPath: string; workDir: string; proc: ChildProcess; slockHome: string }) => Promise<void>,
  spawnContextOverrides: Partial<SpawnContext> = {},
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-scripted-app-server-"));
  const workDir = path.join(root, "work");
  const slockHome = path.join(root, "slock-home");
  mkdirSync(workDir, { recursive: true });
  const { binDir, logPath } = installScriptedCodexAppServer(root);
  const originalPath = process.env.PATH;
  const originalScenario = process.env.SCRIPTED_CODEX_SCENARIO;
  const originalLog = process.env.SCRIPTED_CODEX_LOG;
  const originalSlockHome = process.env.SLOCK_HOME;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.SCRIPTED_CODEX_SCENARIO = scenario;
  process.env.SCRIPTED_CODEX_LOG = logPath;
  process.env.SLOCK_HOME = slockHome;

  const driver = new CodexDriver();
  let proc: ChildProcess | null = null;
  try {
    const baseContext = makeSpawnContext(workDir, {
      sessionId: sessionIdForScenario(scenario),
    });
    const result = await driver.spawn({
      ...baseContext,
      ...spawnContextOverrides,
      config: {
        ...baseContext.config,
        ...spawnContextOverrides.config,
      },
    });
    proc = result.process;
    const events: ParsedEvent[] = [];
    attachCodexStdoutParser(driver, proc, events);
    await fn({ driver, events, logPath, workDir, proc, slockHome });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalScenario === undefined) {
      delete process.env.SCRIPTED_CODEX_SCENARIO;
    } else {
      process.env.SCRIPTED_CODEX_SCENARIO = originalScenario;
    }
    if (originalLog === undefined) {
      delete process.env.SCRIPTED_CODEX_LOG;
    } else {
      process.env.SCRIPTED_CODEX_LOG = originalLog;
    }
    if (originalSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = originalSlockHome;
    }
    if (proc) await terminateScriptedCodexAppServer(proc);
    rmSync(root, { recursive: true, force: true });
  }
}

test("codex launch trace records only derived host facts and launch generation", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withScriptedCodexAppServer("fresh", async () => {
    const spans = sink.getAllSpans().filter((span) => span.name === "daemon.runtime.node_host_launch");
    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0]?.attrs, {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "codex",
      candidate_source: "path",
      host_kind: "node",
      electron_run_as_node: false,
    });
    assert.doesNotMatch(JSON.stringify(spans[0]?.attrs), /(?:\\|\/)codex|token|credential/i);
  }, { tracer });
});

test("codex instruction-shape trace covers actual fresh and resume thread requests", async () => {
  for (const scenario of ["fresh", "resume_success"] as const) {
    const sink = new MemoryTraceSink();
    const tracer = createSpanAttrContractTracer(
      new BasicTracer({ sink }),
      DAEMON_CORE_TRACE_ATTR_CONTRACTS,
    );

    await withScriptedCodexAppServer(scenario, async ({ logPath }) => {
      const expectedMethod = scenario === "fresh" ? "thread/start" : "thread/resume";
      await waitFor(
        () => {
          const messages = readScriptedCodexMessages(logPath);
          return messages.some((message) => message.method === expectedMethod)
            && messages.some((message) => message.method === "turn/start");
        },
        `scripted codex ${expectedMethod} and initial turn/start`,
      );

      const spans = sink.getAllSpans().filter(
        (span) => span.name === "daemon.codex.request_instruction_shape",
      );
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attrs?.observation_phase, "thread_request_sent");
      assert.equal(spans[0]!.attrs?.session_request_method, expectedMethod);
      assert.equal(spans[0]!.attrs?.standing_instructions_state, "string");
      assert.equal(spans[0]!.attrs?.developer_instructions_state, "string");
      assert.equal(spans[0]!.attrs?.developer_instructions_match_standing, true);
      assert.equal(spans[0]!.attrs?.base_instructions_state, "absent");
      assert.equal(spans[0]!.attrs?.codex_app_server_version, "1.0.0");
      assert.equal(spans[0]!.attrs?.session_id_present, scenario === "resume_success");
    }, { tracer });
  }
});

test("codex resume fallback recomputes instruction shape from the second request params", () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );
  const driver = new CodexDriver();
  const writes = captureCodexStdin(driver);
  const internals = driver as any;
  const standing = "standing source";
  const resumeDeveloper = "resume developer";
  const fallbackDeveloper = "fallback developer α";
  const fallbackBase = "fallback base";
  internals.instructionShapeTracer = tracer;
  internals.instructionShapeIdentityAttrs = { agent_id: "agent-1", launch_id: "launch-1" };
  internals.instructionShapeConfiguredSessionId = "missing-thread-1";
  internals.instructionShapeStandingInstructions = standing;

  const resumeId = internals.sendThreadRequest("thread/resume", {
    threadId: "missing-thread-1",
    developerInstructions: resumeDeveloper,
  }, "task54-protocol-preflight/0.145.0 (Mac OS 26.4.1; arm64) Kaku/0.11.0");
  assert.equal(internals.instructionShapeStandingInstructions, undefined);
  assert.doesNotMatch(JSON.stringify(internals.instructionShapeStaticAttrs), new RegExp(standing));
  internals.pendingResumeFallbackParams = {
    developerInstructions: fallbackDeveloper,
    baseInstructions: fallbackBase,
  };

  driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: resumeId,
    error: { message: "No rollout found for thread missing-thread-1" },
  }));

  const requests = writes.map((write) => JSON.parse(write.trim()));
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "thread/start"]);
  assert.equal(requests[1].params.developerInstructions, fallbackDeveloper);
  assert.equal(requests[1].params.baseInstructions, fallbackBase);

  const spans = sink.getAllSpans().filter(
    (span) => span.name === "daemon.codex.request_instruction_shape",
  );
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.attrs?.session_request_method, "thread/resume");
  assert.equal(spans[0]!.attrs?.developer_instructions_sha256, sha256(resumeDeveloper));
  assert.equal(spans[0]!.attrs?.base_instructions_state, "absent");
  assert.equal(spans[1]!.attrs?.session_request_method, "thread/start");
  assert.equal(spans[1]!.attrs?.developer_instructions_utf8_bytes, Buffer.byteLength(fallbackDeveloper, "utf8"));
  assert.equal(spans[1]!.attrs?.developer_instructions_sha256, sha256(fallbackDeveloper));
  assert.equal(spans[1]!.attrs?.base_instructions_utf8_bytes, Buffer.byteLength(fallbackBase, "utf8"));
  assert.equal(spans[1]!.attrs?.base_instructions_sha256, sha256(fallbackBase));
  assert.equal(spans[1]!.attrs?.standing_instructions_sha256, sha256(standing));
  assert.equal(spans[1]!.attrs?.codex_app_server_version, "0.145.0");
  assert.equal(spans[1]!.attrs?.developer_instructions_match_standing, false);
});

test("codex instruction-shape trace covers compaction and its first subsequent request", async () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );

  await withScriptedCodexAppServer("fresh", async ({ driver, logPath }) => {
    await waitFor(
      () => {
        const messages = readScriptedCodexMessages(logPath);
        return messages.some((message) => message.method === "thread/start")
          && messages.some((message) => message.method === "turn/start");
      },
      "scripted codex thread/start and initial turn/start",
    );
    driver.parseLine(JSON.stringify({
      method: "item/started",
      params: {
        threadId: "fresh-thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "item-compact-1" },
      },
    }));
    driver.parseLine(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "fresh-thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "item-compact-1" },
      },
    }));

    const encoded = driver.encodeStdinMessage("after compaction", driver.currentSessionId, { mode: "idle" });
    assert.ok(encoded);

    const spans = sink.getAllSpans().filter(
      (span) => span.name === "daemon.codex.request_instruction_shape",
    );
    assert.deepEqual(spans.map((span) => span.attrs?.observation_phase), [
      "thread_request_sent",
      "compaction_started",
      "compaction_finished",
      "post_compaction_first_request",
    ]);
    assert.deepEqual(spans.slice(1).map((span) => [
      span.attrs?.compaction_starts_count,
      span.attrs?.compaction_finishes_count,
    ]), [[1, 0], [1, 1], [1, 1]]);
    assert.equal(spans[3]!.attrs?.session_id, "fresh-thread-1");

    driver.encodeStdinMessage("second request", driver.currentSessionId, { mode: "idle" });
    assert.equal(sink.getAllSpans().filter(
      (span) => span.name === "daemon.codex.request_instruction_shape",
    ).length, 4);
  }, { tracer });
});

test("codex CODEX_HOME resolution preserves explicit user configuration", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-home-explicit-"));
  try {
    const explicitCodexHome = path.join(root, "user-codex-home");
    const env = {
      CODEX_HOME: explicitCodexHome,
      SLOCK_HOME: path.join(root, "slock-home"),
    } as NodeJS.ProcessEnv;

    const codexHome = resolveCodexHomeRootFromEnv(env, { defaultHomeDir: root });

    assert.equal(codexHome, explicitCodexHome);
    assert.equal(env.CODEX_HOME, explicitCodexHome);
    assert.equal(existsSync(path.join(root, "slock-home", "codex-home", "agent-1")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex app-server keeps default CODEX_HOME unset when absent", async () => {
  const userHome = mkdtempSync(path.join(os.tmpdir(), "codex-user-home-"));
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = userHome;
    delete process.env.CODEX_HOME;

    await withScriptedCodexAppServer("trust_write_after_log_delay", async ({ events, logPath, workDir, slockHome }) => {
      await waitFor(
        () => readScriptedCodexMessages(logPath).some((message) => message.method === "thread/start"),
        "scripted codex thread/start",
      );

      const threadStart = readScriptedCodexMessages(logPath).find((message) => message.method === "thread/start");
      assert.equal(threadStart?.codexHomeEnv, null);
      assert.equal(existsSync(path.join(slockHome, "codex-home", "agent-1")), false);
      const trustConfigPath = path.join(userHome, ".codex", "config.toml");
      await waitFor(
        () =>
          fileIncludes(trustConfigPath, JSON.stringify(workDir)) &&
          events.some((event) => event.kind === "turn_end" && event.sessionId === "fresh-thread-1"),
        "scripted codex trust config and initial turn completion",
      );
      assert.equal(readFileSync(trustConfigPath, "utf8").includes(JSON.stringify(workDir)), true);
      assert.deepEqual(
        readScriptedCodexMessages(logPath).map((message) => message.method),
        ["initialize", "initialized", "thread/start", "turn/start"],
      );
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("codex scripted app-server harness starts a fresh thread and initial turn", async () => {
  await withScriptedCodexAppServer("fresh", async ({ events, logPath, workDir }) => {
    await waitFor(
      () => events.some((event) => event.kind === "turn_end" && event.sessionId === "fresh-thread-1"),
      "fresh codex turn_end",
    );

    assert.deepEqual(events, [
      codexToolingObservation("thread/start"),
      { kind: "session_init", sessionId: "fresh-thread-1" },
      { kind: "turn_end", sessionId: "fresh-thread-1" },
    ]);
    // Review the fresh-thread instructions/sandbox settings and initial input sent to its thread ID.
    expect(readScriptedCodexRequests(logPath, workDir)).toMatchInlineSnapshot(`
      [
        {
          "method": "initialize",
          "params": {
            "capabilities": {
              "experimentalApi": true,
            },
            "clientInfo": {
              "name": "slock-daemon",
              "version": "1.0.0",
            },
          },
        },
        {
          "method": "initialized",
          "params": {},
        },
        {
          "method": "thread/start",
          "params": {
            "approvalPolicy": "never",
            "cwd": "<workDir>",
            "developerInstructions": "stand still",
            "experimentalRawEvents": true,
            "model": "gpt-5.3-codex",
            "sandbox": "danger-full-access",
            "sandbox_mode": "danger-full-access",
          },
        },
        {
          "method": "turn/start",
          "params": {
            "input": [
              {
                "text": "initial prompt",
                "type": "text",
              },
            ],
            "threadId": "fresh-thread-1",
          },
        },
      ]
    `);
    assert.equal(existsSync(path.join(workDir, ".git")), false);
  });
});

test("codex resume success starts the initial turn on the resumed thread", async () => {
  await withScriptedCodexAppServer("resume_success", async ({ events, logPath, workDir }) => {
    await waitFor(
      () => events.some((event) => event.kind === "turn_end" && event.sessionId === "existing-thread-1"),
      "codex resumed turn_end",
    );

    assert.deepEqual(events, [
      codexToolingObservation("thread/resume"),
      { kind: "session_init", sessionId: "existing-thread-1" },
      { kind: "turn_end", sessionId: "existing-thread-1" },
    ]);

    // Review that resume targets the saved thread, excludes returned history, and starts input on that same thread.
    expect(readScriptedCodexRequests(logPath, workDir)).toMatchInlineSnapshot(`
      [
        {
          "method": "initialize",
          "params": {
            "capabilities": {
              "experimentalApi": true,
            },
            "clientInfo": {
              "name": "slock-daemon",
              "version": "1.0.0",
            },
          },
        },
        {
          "method": "initialized",
          "params": {},
        },
        {
          "method": "thread/resume",
          "params": {
            "approvalPolicy": "never",
            "cwd": "<workDir>",
            "developerInstructions": "stand still",
            "excludeTurns": true,
            "experimentalRawEvents": true,
            "model": "gpt-5.3-codex",
            "sandbox": "danger-full-access",
            "sandbox_mode": "danger-full-access",
            "threadId": "existing-thread-1",
          },
        },
        {
          "method": "turn/start",
          "params": {
            "input": [
              {
                "text": "initial prompt",
                "type": "text",
              },
            ],
            "threadId": "existing-thread-1",
          },
        },
      ]
    `);
  });
});

test("codex resume target is not deliverable before thread ready", async () => {
  await withScriptedCodexAppServer("resume_pending", async ({ driver, logPath }) => {
    await waitFor(
      () => readScriptedCodexMessages(logPath).some((message) => message.method === "thread/resume"),
      "codex pending thread/resume request",
    );

    assert.equal(driver.currentSessionId, null);
    assert.equal(driver.encodeStdinMessage("queued before resume", "existing-thread-1", { mode: "idle" }), null);
    assert.equal(driver.currentSessionId, null);
  });
});

test("codex resume missing rollout falls back to fresh thread/start", async () => {
  await withScriptedCodexAppServer("resume_missing_rollout", async ({ events, logPath, workDir }) => {
    await waitFor(
      () => events.some((event) => event.kind === "turn_end" && event.sessionId === "fresh-thread-1"),
      "codex resume fallback turn_end",
    );

    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.deepEqual(events, [
      {
        kind: "telemetry",
        name: "recovery",
        source: "codex_resume_missing_rollout",
        attrs: {
          resume_error_class: "missing_rollout",
          recovery_action: "fallback_fresh_thread",
        },
      },
      {
        kind: "runtime_recovery",
        source: "codex_resume_missing_rollout",
        resumeErrorClass: "missing_rollout",
        recoveryAction: "fallback_fresh_thread",
        message: "Codex could not resume its previous thread; Slock started a fresh Codex thread.",
        details: "Use Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
        requestedSessionId: "missing-thread-1",
      },
      codexToolingObservation("thread/start"),
      { kind: "session_init", sessionId: "fresh-thread-1" },
      { kind: "turn_end", sessionId: "fresh-thread-1" },
    ]);

    // Review that fallback drops resume-only fields and sends the recovery notice plus original input to the new thread.
    expect(readScriptedCodexRequests(logPath, workDir)).toMatchInlineSnapshot(`
      [
        {
          "method": "initialize",
          "params": {
            "capabilities": {
              "experimentalApi": true,
            },
            "clientInfo": {
              "name": "slock-daemon",
              "version": "1.0.0",
            },
          },
        },
        {
          "method": "initialized",
          "params": {},
        },
        {
          "method": "thread/resume",
          "params": {
            "approvalPolicy": "never",
            "cwd": "<workDir>",
            "developerInstructions": "stand still",
            "excludeTurns": true,
            "experimentalRawEvents": true,
            "model": "gpt-5.3-codex",
            "sandbox": "danger-full-access",
            "sandbox_mode": "danger-full-access",
            "threadId": "missing-thread-1",
          },
        },
        {
          "method": "thread/start",
          "params": {
            "approvalPolicy": "never",
            "cwd": "<workDir>",
            "developerInstructions": "stand still",
            "experimentalRawEvents": true,
            "model": "gpt-5.3-codex",
            "sandbox": "danger-full-access",
            "sandbox_mode": "danger-full-access",
          },
        },
        {
          "method": "turn/start",
          "params": {
            "input": [
              {
                "text": "Codex could not resume its previous thread; Slock started a fresh Codex thread.

      Use Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.

      initial prompt",
                "type": "text",
              },
            ],
            "threadId": "fresh-thread-1",
          },
        },
      ]
    `);
  });
});

test("codex resume active writer falls back to fresh thread/start", async () => {
  await withScriptedCodexAppServer("resume_thread_writer_busy", async ({ events, logPath }) => {
    await waitFor(
      () => events.some((event) => event.kind === "turn_end" && event.sessionId === "fresh-thread-1"),
      "codex active-writer resume fallback turn_end",
    );

    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.deepEqual(events, [
      {
        kind: "telemetry",
        name: "recovery",
        source: "codex_resume_thread_writer_busy",
        attrs: {
          resume_error_class: "thread_writer_busy",
          recovery_action: "fallback_fresh_thread",
        },
      },
      {
        kind: "runtime_recovery",
        source: "codex_resume_thread_writer_busy",
        resumeErrorClass: "thread_writer_busy",
        recoveryAction: "fallback_fresh_thread",
        message: "Codex could not resume its previous thread because another writer is active; Slock started a fresh Codex thread.",
        details: "Use Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
        requestedSessionId: "busy-thread-1",
      },
      codexToolingObservation("thread/start"),
      { kind: "session_init", sessionId: "fresh-thread-1" },
      { kind: "turn_end", sessionId: "fresh-thread-1" },
    ]);

    const messages = readScriptedCodexMessages(logPath);
    assert.deepEqual(
      messages.map((message) => message.method),
      ["initialize", "initialized", "thread/resume", "thread/start", "turn/start"],
    );
    assert.equal(messages[2].params.threadId, "busy-thread-1");
    assert.equal(Object.prototype.hasOwnProperty.call(messages[3].params, "threadId"), false);
    assert.equal(messages[3].params.cwd, messages[2].params.cwd);
    assert.equal(messages[3].params.developerInstructions, messages[2].params.developerInstructions);
    assert.match(
      messages[4].params.input[0].text,
      /^Codex could not resume its previous thread because another writer is active; Slock started a fresh Codex thread\./,
    );
    assert.match(messages[4].params.input[0].text, /Use Slock conversation history and local MEMORY\.md\/notes as the recovery point/);
    assert.match(messages[4].params.input[0].text, /\n\ninitial prompt$/);
  });
});

test("codex resume permission error does not fall back to a fresh thread", async () => {
  await withScriptedCodexAppServer("resume_permission_denied", async ({ events, logPath }) => {
    await waitFor(
      () => events.some((event) => event.kind === "error"),
      "codex resume permission error",
    );

    assert.deepEqual(events, [
      {
        kind: "error",
        message: "No permission to access thread forbidden-thread-1",
        startupRequestMethod: "thread/resume",
      },
    ]);
    assert.equal(events.some((event) => event.kind === "telemetry" && event.name === "recovery"), false);
    assert.deepEqual(
      readScriptedCodexMessages(logPath).map((message) => message.method),
      ["initialize", "initialized", "thread/resume"],
    );
  });
});

test("codex initialize request errors are marked as startup failures", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  internals.initializeRequestId = "initialize-1";
  internals.pendingThreadRequest = { method: "thread/start", params: {} };

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "initialize-1",
    error: { code: -32000, message: "initialize failed" },
  }));

  assert.deepEqual(events, [{
    kind: "error",
    message: "initialize failed",
    startupRequestMethod: "initialize",
  }]);
  assert.equal(internals.initializeRequestId, null);
  assert.equal(internals.pendingThreadRequest, null);
});

test("codex initialize response records app-server codexHome root", () => {
  withTempHome((home) => {
    const workDir = path.join(home, "work");
    mkdirSync(workDir, { recursive: true });
    const driver = new CodexDriver();
    const internals = driver as any;
    internals.initializeRequestId = "initialize-1";
    internals.pendingThreadRequest = null;
    internals.spawnWorkingDirectory = workDir;

    const events = driver.parseLine(JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-1",
      result: { userAgent: "codex-test/1.0.0", codexHome: "codex-home" },
    }));

    assert.deepEqual(events, []);
    assert.equal(driver.currentRuntimeHomeDir, path.join(workDir, "codex-home"));
    assert.equal(internals.initializeRequestId, null);
  });
});

test("codex initialize response without compatible handshake fails startup closed", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  internals.initializeRequestId = "initialize-1";
  internals.pendingThreadRequest = { method: "thread/start", params: {} };

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "initialize-1",
    result: {},
  }));

  assert.deepEqual(events, [{
    kind: "error",
    message: "Codex app-server initialize response is missing the expected userAgent handshake field; upgrade Codex CLI to a compatible app-server build.",
    startupRequestMethod: "initialize",
  }]);
  assert.equal(internals.initializeRequestId, null);
  assert.equal(internals.pendingThreadRequest, null);
});

test("codex thread start request errors are marked as startup failures", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  internals.pendingThreadRequestId = "thread-start-1";
  internals.pendingThreadRequestMethod = "thread/start";

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "thread-start-1",
    error: { code: -32000, message: "thread start failed" },
  }));

  assert.deepEqual(events, [{
    kind: "error",
    message: "thread start failed",
    startupRequestMethod: "thread/start",
  }]);
  assert.equal(internals.pendingThreadRequestId, null);
  assert.equal(internals.pendingThreadRequestMethod, null);
});

test("codex initial turn request errors are marked as startup failures without consuming the prompt", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  internals.pendingInitialPrompt = "launch prompt";
  internals.pendingInitialTurnRequestId = "turn-start-1";
  internals.initialTurnStarted = true;

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "turn-start-1",
    error: { code: -32000, message: "turn start failed" },
  }));

  assert.deepEqual(events, [{
    kind: "error",
    message: "turn start failed",
    startupRequestMethod: "turn/start",
  }]);
  assert.equal(internals.pendingInitialTurnRequestId, null);
  assert.equal(internals.pendingInitialPrompt, "launch prompt");
});

test("codex waits for its managed MCP server before starting the initial turn", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  const writes = captureCodexStdin(driver);
  internals.pendingInitialPrompt = "use managed MCP";
  internals.managedMcpServerName = "rmtest";
  internals.managedMcpReady = false;
  internals.managedMcpStatus = "pending";
  internals.lastThreadRequestMethod = "thread/resume";

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-managed" } },
  })), [{ kind: "session_init", sessionId: "thread-managed" }]);
  assert.deepEqual(writes, []);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "mcpServer/startupStatus/updated",
    params: { threadId: "thread-managed", name: "rmtest", status: "ready", error: null },
  })), [codexToolingObservation("thread/resume", "ready")]);
  assert.deepEqual(parseOnlyJsonRpcWrite(writes), {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread-managed",
      input: [{ type: "text", text: "use managed MCP" }],
    },
  });
});

test("codex degrades to a normal no-tools turn when its MCP server startup fails", () => {
  const driver = new CodexDriver();
  const internals = driver as any;
  const writes = captureCodexStdin(driver);
  internals.pendingInitialPrompt = "use managed MCP";
  internals.managedMcpServerName = "rmtest";
  internals.managedMcpReady = false;
  internals.managedMcpStatus = "pending";
  internals.lastThreadRequestMethod = "thread/resume";
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-managed" } },
  }));

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "mcpServer/startupStatus/updated",
    params: { threadId: "thread-managed", name: "rmtest", status: "failed", error: "connection refused" },
  })), [
    codexToolingObservation("thread/resume", "failed"),
  ]);
  assert.deepEqual(parseOnlyJsonRpcWrite(writes), {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread-managed",
      input: [{ type: "text", text: "use managed MCP" }],
    },
  });

  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: 1,
    result: { turn: { id: "turn-1" } },
  })), []);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-managed",
      turn: { id: "turn-1" },
    },
  })), [{ kind: "thinking", text: "" }]);
  assert.equal(driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-managed",
      turnId: "turn-1",
      tokenUsage: { total: { totalTokens: 1 } },
    },
  }))[0]?.kind, "telemetry");
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-managed",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  })), [{ kind: "turn_end", sessionId: "thread-managed" }]);
});

test("codex driver rejects unsupported app-server JSON-RPC requests", () => {
  const driver = new CodexDriver();
  const writes = captureCodexStdin(driver);

  const events = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "server-request-1",
    method: "item/tool/requestUserInput",
    params: {
      prompt: "Need input",
    },
  }));

  assert.deepEqual(events, []);
  const response = parseOnlyJsonRpcWrite(writes);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, "server-request-1");
  assert.equal(response.method, undefined);
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /item\/tool\/requestUserInput/);
});

test("codex driver does not treat colliding app-server request ids as client responses", () => {
  const driver = new CodexDriver();
  const writes = captureCodexStdin(driver);
  const internals = driver as any;
  internals.pendingThreadRequestId = "colliding-id";
  internals.pendingThreadRequestMethod = "thread/start";

  const requestEvents = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "colliding-id",
    method: "item/permissions/requestApproval",
    params: {
      reason: "approval required",
    },
  }));

  assert.deepEqual(requestEvents, []);
  assert.equal(internals.pendingThreadRequestId, "colliding-id");
  assert.equal(parseOnlyJsonRpcWrite(writes).id, "colliding-id");

  const responseEvents = driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "colliding-id",
    result: {
      thread: { id: "thread-1" },
    },
  }));

  assert.equal(internals.pendingThreadRequestId, null);
  assert.equal(internals.pendingThreadRequestMethod, null);
  assert.deepEqual(responseEvents, [
    codexToolingObservation("thread/start"),
    { kind: "session_init", sessionId: "thread-1" },
  ]);
});

test("codex driver encodes idle follow-up as turn/start", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("hello", "thread-1", { mode: "idle" });
  assert.ok(encoded);

  const parsed = JSON.parse(encoded!);
  assert.equal(parsed.method, "turn/start");
  assert.equal(parsed.params.threadId, "thread-1");
  assert.deepEqual(parsed.params.input, [{ type: "text", text: "hello" }]);
});

test("codex driver encodes busy follow-up as turn/steer with expected turn id", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("steer", "thread-1", { mode: "busy" });
  assert.ok(encoded);

  const parsed = JSON.parse(encoded!);
  assert.equal(parsed.method, "turn/steer");
  assert.equal(parsed.params.threadId, "thread-1");
  assert.equal(parsed.params.expectedTurnId, "turn-1");
  assert.deepEqual(parsed.params.input, [{ type: "text", text: "steer" }]);
});

test("codex driver keeps turn/start response ids non-steerable until turn/started", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 101,
    result: {
      turn: { id: "turn-accepted" },
    },
  }));

  assert.equal(driver.encodeStdinMessage("too early", "thread-1", { mode: "busy" }), null);

  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-accepted" },
    },
  }));

  const encoded = driver.encodeStdinMessage("steer", "thread-1", { mode: "busy" });
  assert.ok(encoded);

  const parsed = JSON.parse(encoded!);
  assert.equal(parsed.method, "turn/steer");
  assert.equal(parsed.params.threadId, "thread-1");
  assert.equal(parsed.params.expectedTurnId, "turn-accepted");
  assert.deepEqual(parsed.params.input, [{ type: "text", text: "steer" }]);
});

test("codex driver keeps turn/steer response ids non-steerable over an active turn", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const firstSteer = driver.encodeStdinMessage("first steer", "thread-1", { mode: "busy" });
  assert.ok(firstSteer);
  assert.equal(JSON.parse(firstSteer!).params.expectedTurnId, "turn-1");

  driver.parseLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 101,
    result: {
      turn: { id: "turn-2" },
    },
  }));

  assert.equal(driver.encodeStdinMessage("second steer too early", "thread-1", { mode: "busy" }), null);

  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2" },
    },
  }));

  const nextSteer = driver.encodeStdinMessage("second steer", "thread-1", { mode: "busy" });
  assert.ok(nextSteer);
  assert.equal(JSON.parse(nextSteer!).params.expectedTurnId, "turn-2");
});

test("codex driver does not duplicate completed agent text after deltas", () => {
  const driver = new CodexDriver();

  const deltaEvents = driver.parseLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "HELLO",
    },
  }));

  const completedEvents = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        text: "HELLO",
      },
    },
  }));

  assert.deepEqual(deltaEvents, [{ kind: "text", text: "HELLO" }]);
  assert.deepEqual(completedEvents, []);
});

test("codex driver does not surface commentary-phase agent text as user-visible text", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        phase: "commentary",
      },
    },
  })), []);

  const deltaEvents = driver.parseLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "assistant to=functions.exec_command {...}",
    },
  }));

  assert.equal(deltaEvents.length, 1);
  assert.equal(deltaEvents[0]?.kind, "internal_progress");
  assert.equal(deltaEvents[0]?.itemType, "agent_message_non_final_delta");

  const completedEvents = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        phase: "commentary",
        text: "assistant to=functions.exec_command {...}",
      },
    },
  }));

  assert.deepEqual(completedEvents, []);
});

test("codex driver uses cached final_answer phase for generated-shape deltas", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        phase: "final_answer",
      },
    },
  })), []);

  const deltaEvents = driver.parseLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "Final",
    },
  }));

  assert.deepEqual(deltaEvents, [{ kind: "text", text: "Final" }]);
});

test("codex driver surfaces final_answer-phase completed agent text", () => {
  const driver = new CodexDriver();

  const events = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-1",
        phase: "final_answer",
        text: "Final answer",
      },
    },
  }));

  assert.deepEqual(events, [{ kind: "text", text: "Final answer" }]);
});

test("codex driver surfaces no-output successful turn completion as runtime error", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const nullUsage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: null,
    },
  }));
  const events = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.deepEqual(nullUsage, []);
  assert.equal(events.length, 3);
  assert.equal(events[0]?.kind, "runtime_diagnostic");
  if (events[0]?.kind === "runtime_diagnostic") {
    assert.equal(events[0].itemType, "codex_zero_evidence_turn_completed");
    assert.equal(events[0].message, "Codex runtime completed an empty turn with no output, progress, or token usage");
    assert.match(events[0].details ?? "", /no assistant text, reasoning text, tool activity/);
    assert.equal(typeof events[0].payloadBytes, "number");
    assert.equal(events[0].sessionId, "thread-1");
    assert.equal(events[0].inputEvidence, "unknown");
  }
  assert.deepEqual(events.slice(1), [
    {
      kind: "error",
      message: "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)",
    },
    { kind: "turn_end", sessionId: "thread-1" },
  ]);
});

test("codex driver blames runtime empty response only after accepted non-empty input", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("non-empty prompt", "thread-1", { mode: "idle" });
  assert.ok(encoded);
  const request = JSON.parse(encoded);
  assert.equal(request.method, "turn/start");

  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: request.id,
    result: { turn: { id: "turn-1" } },
  })), []);
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const events = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.equal(events.length, 3);
  assert.equal(events[0]?.kind, "runtime_diagnostic");
  if (events[0]?.kind === "runtime_diagnostic") {
    assert.equal(events[0].itemType, "codex_zero_evidence_turn_completed");
    assert.equal(events[0].inputEvidence, "nonempty");
  }
  assert.deepEqual(events.slice(1), [
    {
      kind: "error",
      message: "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
    },
    { kind: "turn_end", sessionId: "thread-1" },
  ]);
});

test("codex driver associates non-empty input when turn starts before acceptance response", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("non-empty prompt", "thread-1", { mode: "idle" });
  assert.ok(encoded);
  const request = JSON.parse(encoded);
  assert.equal(request.method, "turn/start");

  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));
  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: request.id,
    result: { turn: { id: "turn-1" } },
  })), []);

  const events = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.equal(events[0]?.kind, "runtime_diagnostic");
  if (events[0]?.kind === "runtime_diagnostic") {
    assert.equal(events[0].inputEvidence, "nonempty");
  }
  assert.equal(
    events.find((event) => event.kind === "error")?.message,
    "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
  );
});

test("codex driver does not let late acceptance response contaminate the next turn", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("non-empty prompt", "thread-1", { mode: "idle" });
  assert.ok(encoded);
  const request = JSON.parse(encoded);
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));
  const firstCompleted = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));
  assert.equal(firstCompleted[0]?.kind, "runtime_diagnostic");
  if (firstCompleted[0]?.kind === "runtime_diagnostic") {
    assert.equal(firstCompleted[0].inputEvidence, "unknown");
  }

  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: request.id,
    result: { turn: { id: "turn-1" } },
  })), []);
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2" },
    },
  }));
  const secondCompleted = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", error: null },
    },
  }));

  assert.equal(secondCompleted[0]?.kind, "runtime_diagnostic");
  if (secondCompleted[0]?.kind === "runtime_diagnostic") {
    assert.equal(secondCompleted[0].inputEvidence, "unknown");
  }
  assert.equal(
    secondCompleted.find((event) => event.kind === "error")?.message,
    "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)",
  );
});

test("codex driver does not create input evidence from failed delivery response", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));

  const encoded = driver.encodeStdinMessage("non-empty prompt", "thread-1", { mode: "idle" });
  assert.ok(encoded);
  const request = JSON.parse(encoded);
  const failed = driver.parseLine(JSON.stringify({
    id: request.id,
    error: { message: "turn rejected" },
  }));
  assert.equal(failed[0]?.kind, "delivery_error");

  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));
  const completed = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.equal(completed[0]?.kind, "runtime_diagnostic");
  if (completed[0]?.kind === "runtime_diagnostic") {
    assert.equal(completed[0].inputEvidence, "unknown");
  }
  assert.equal(
    completed.find((event) => event.kind === "error")?.message,
    "Codex runtime completed without a response. Please retry. (codex_zero_evidence_turn_completed)",
  );
});

test("codex driver treats token usage telemetry as evidence for quiet successful turns", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const usage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 1,
        },
      },
    },
  }));
  const completed = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.equal(usage[0]?.kind, "telemetry");
  assert.deepEqual(completed, [{ kind: "turn_end", sessionId: "thread-1" }]);
});

test("codex driver treats raw response item progress as evidence for quiet successful turns", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: {
      thread: { id: "thread-1" },
    },
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  }));

  const progress = driver.parseLine(JSON.stringify({
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "function_call_output",
      },
    },
  }));
  const completed = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  }));

  assert.equal(progress[0]?.kind, "internal_progress");
  assert.deepEqual(completed, [{ kind: "turn_end", sessionId: "thread-1" }]);
});

test("codex driver emits compaction lifecycle events for contextCompaction items", () => {
  const driver = new CodexDriver();

  const started = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "contextCompaction",
        id: "item-compact-1",
      },
    },
  }));

  const completed = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "contextCompaction",
        id: "item-compact-1",
      },
    },
  }));

  assert.deepEqual(started, [{ kind: "compaction_started" }]);
  assert.deepEqual(completed, [{ kind: "compaction_finished" }]);
});

test("codex driver emits review lifecycle events for review mode items", () => {
  const driver = new CodexDriver();

  const started = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "enteredReviewMode",
        id: "item-review-start-1",
      },
    },
  }));

  const completed = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "exitedReviewMode",
        id: "item-review-finish-1",
      },
    },
  }));

  assert.deepEqual(started, [{ kind: "review_started" }]);
  assert.deepEqual(completed, [{ kind: "review_finished" }]);
});

test("codex driver: steering gate prevents unsafe stdin writes (regression #238)", () => {
  const driver = new CodexDriver();

  // 1. Thread and turn starts
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-1" } }
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } }
  }));

  // 2. Tool starts and completes
  // Invariants check: tool_output must emit IMMEDIATELY for APM visibility
  driver.parseLine(JSON.stringify({
    method: "item/started",
    params: { item: { id: "tool-1", type: "commandExecution", command: "ls" } }
  }));
  const events = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: { item: { id: "tool-1", type: "commandExecution", command: "ls" } }
  }));
  assert.deepEqual(events, [{ kind: "tool_output", name: "shell" }], "tool_output must be immediate");

  // 3. Busy-mode delivery attempt during the vulnerable window
  // Invariants check: must return null to prevent crash-inducing turn/steer
  const busyResult = driver.encodeStdinMessage("notification", "thread-1", { mode: "busy" });
  assert.equal(busyResult, null, "Must gate busy steering during vulnerable window");

  // 4. Progress arrives (e.g. reasoning delta or text)
  // Should open the gate
  driver.parseLine(JSON.stringify({
    method: "item/reasoning/textDelta",
    params: { itemId: "reason-1", delta: "thinking..." }
  }));
  const unblockedResult = driver.encodeStdinMessage("urgent", "thread-1", { mode: "busy" });
  assert.ok(unblockedResult, "Progress should unblock steering gate");
  assert.match(unblockedResult!, /turn\/steer/);

  // 5. Turn completes
  // Should definitely be open for next idle start
  driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  }));
  const idleResult = driver.encodeStdinMessage("new task", "thread-1", { mode: "idle" });
  assert.ok(idleResult);
  assert.match(idleResult!, /turn\/start/);
});

test("codex driver: steering gate unblocks on fallback completed progress", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-1" } }
  }));
  driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } }
  }));

  // 1. Tool completes -> Gated
  driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: { item: { id: "tool-1", type: "commandExecution", command: "ls" } }
  }));
  assert.equal(driver.encodeStdinMessage("msg", "thread-1", { mode: "busy" }), null);

  // 2. agentMessage completes without prior delta (fallback progress) -> Unblocked
  driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: { id: "item-1", type: "agentMessage", text: "Fallback text" }
    }
  }));
  const result = driver.encodeStdinMessage("steer", "thread-1", { mode: "busy" });
  assert.ok(result, "Fallback completed progress should unblock steering gate");
  assert.match(result!, /turn\/steer/);
});

test("codex driver emits tool output events for completed tool items", () => {
  const driver = new CodexDriver();

  const commandCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "item-command-1",
        command: "ls",
      },
    },
  }));

  const mcpCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "mcpToolCall",
        id: "item-mcp-1",
        server: "github",
        tool: "search_issues",
      },
    },
  }));

  assert.deepEqual(commandCompleted, [{ kind: "tool_output", name: "shell" }]);
  assert.deepEqual(mcpCompleted, [{ kind: "tool_output", name: "mcp_github_search_issues" }]);
});

test("codex driver emits matching outputs for tool-like item completions", () => {
  const driver = new CodexDriver();

  const fileChangeStarted = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      item: {
        type: "fileChange",
        id: "item-file-1",
        changes: [
          { path: "a.ts", kind: "modify" },
          { path: "b.ts", kind: "create" },
        ],
      },
    },
  }));
  const fileChangeCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "item-file-1",
        changes: [
          { path: "a.ts", kind: "modify" },
          { path: "b.ts", kind: "create" },
        ],
      },
    },
  }));
  const fileChangeOmittedCompletionStarted = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      item: {
        type: "fileChange",
        id: "item-file-2",
        changes: [
          { path: "c.ts", kind: "modify" },
          { path: "d.ts", kind: "delete" },
        ],
      },
    },
  }));
  const fileChangeOmittedCompletionCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "item-file-2",
      },
    },
  }));
  const fileChangeCompletionOnly = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "item-file-3",
        changes: [
          { path: "e.ts", kind: "modify" },
        ],
      },
    },
  }));

  const collabStarted = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      item: {
        type: "collabAgentToolCall",
        id: "item-collab-1",
        tool: "delegate",
        prompt: "inspect this",
      },
    },
  }));
  const collabCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "collabAgentToolCall",
        id: "item-collab-1",
        tool: "delegate",
        prompt: "inspect this",
      },
    },
  }));

  const webSearchStarted = driver.parseLine(JSON.stringify({
    method: "item/started",
    params: {
      item: {
        type: "webSearch",
        id: "item-web-1",
        query: "Codex app-server",
      },
    },
  }));
  const webSearchCompleted = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "webSearch",
        id: "item-web-1",
        query: "Codex app-server",
      },
    },
  }));

  assert.deepEqual(fileChangeStarted, [
    { kind: "tool_call", name: "file_change", input: { path: "a.ts", kind: "modify" } },
    { kind: "tool_call", name: "file_change", input: { path: "b.ts", kind: "create" } },
  ]);
  assert.deepEqual(fileChangeCompleted, [
    { kind: "tool_output", name: "file_change" },
    { kind: "tool_output", name: "file_change" },
  ]);
  assert.deepEqual(fileChangeOmittedCompletionStarted, [
    { kind: "tool_call", name: "file_change", input: { path: "c.ts", kind: "modify" } },
    { kind: "tool_call", name: "file_change", input: { path: "d.ts", kind: "delete" } },
  ]);
  assert.deepEqual(fileChangeOmittedCompletionCompleted, [
    { kind: "tool_output", name: "file_change" },
    { kind: "tool_output", name: "file_change" },
  ]);
  assert.deepEqual(fileChangeCompletionOnly, [
    { kind: "tool_output", name: "file_change" },
  ]);
  assert.deepEqual(collabStarted, [{
    kind: "tool_call",
    name: "collab_tool_call",
    input: { tool: "delegate", prompt: "inspect this" },
  }]);
  assert.deepEqual(collabCompleted, [{ kind: "tool_output", name: "collab_tool_call" }]);
  assert.deepEqual(webSearchStarted, [{
    kind: "tool_call",
    name: "web_search",
    input: { query: "Codex app-server" },
  }]);
  assert.deepEqual(webSearchCompleted, [{ kind: "tool_output", name: "web_search" }]);
});

test("codex driver emits token usage telemetry without lifecycle progress events", () => {
  const driver = new CodexDriver();

  const events = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: {
          totalTokens: 1000,
          inputTokens: 800,
          cachedInputTokens: 200,
          outputTokens: 150,
          reasoningOutputTokens: 50,
        },
        modelContextWindow: 2000,
      },
    },
  }));

  assert.deepEqual(events, [{
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    attrs: {
      totalTokens: 1000,
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 150,
      reasoningOutputTokens: 50,
      modelContextWindow: 2000,
      cachedInputRatio: 0.25,
      contextUtilization: 0.5,
    },
  }]);
});

test("codex driver adopts telemetry event thread id as session identity", () => {
  const driver = new CodexDriver();

  const firstUsage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-from-telemetry",
      turnId: "turn-from-telemetry",
      tokenUsage: {
        total: { totalTokens: 1000 },
      },
    },
  }));

  assert.deepEqual(firstUsage, [{
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    sessionId: "thread-from-telemetry",
    turnId: "turn-from-telemetry",
    attrs: {
      totalTokens: 1000,
    },
  }]);
  assert.equal(driver.currentSessionId, "thread-from-telemetry");

  const nextUsage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: { totalTokens: 2000 },
      },
    },
  }));

  assert.deepEqual(nextUsage, [{
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    sessionId: "thread-from-telemetry",
    attrs: {
      totalTokens: 2000,
    },
  }]);
});

test("codex driver annotates telemetry with the current thread and turn identity", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-1" } },
  })), [{ kind: "session_init", sessionId: "thread-1" }]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  })), [{ kind: "thinking", text: "" }]);

  const firstUsage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: { totalTokens: 1000 },
      },
    },
  }));

  assert.deepEqual(firstUsage, [{
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    sessionId: "thread-1",
    turnId: "turn-1",
    attrs: {
      totalTokens: 1000,
    },
  }]);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-2" } },
  })), []);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-2", turn: { id: "turn-2" } },
  })), []);

  const secondUsage = driver.parseLine(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: { totalTokens: 2000 },
      },
    },
  }));

  assert.deepEqual(secondUsage, [{
    kind: "telemetry",
    name: "token_usage",
    source: "codex_thread_token_usage_updated",
    usageKind: "cumulative_session",
    sessionId: "thread-1",
    turnId: "turn-1",
    attrs: {
      totalTokens: 2000,
    },
  }]);
});

test("codex driver keeps delivery pinned to the main thread when a secondary thread starts", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-secondary", parentThreadId: "thread-main" } },
  })), []);

  const encoded = driver.encodeStdinMessage("follow-up", "thread-main", { mode: "idle" });
  assert.ok(encoded);
  const parsed = JSON.parse(encoded!);
  assert.equal(parsed.method, "turn/start");
  assert.equal(parsed.params.threadId, "thread-main");
});

test("codex driver attributes rejected idle follow-up responses as delivery errors", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);

  const encoded = driver.encodeStdinMessage("idle follow-up", "thread-main", { mode: "idle" });
  assert.ok(encoded);
  const request = JSON.parse(encoded!);
  assert.equal(request.method, "turn/start");

  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: request.id,
    error: { message: "turn rejected by app-server" },
  })), [{
    kind: "delivery_error",
    message: "turn rejected by app-server",
    requestMethod: "turn/start",
    source: "codex_app_server_response",
    payloadBytes: Buffer.byteLength(JSON.stringify({ message: "turn rejected by app-server" }), "utf8"),
  }]);
});

test("codex driver attributes rejected busy follow-up responses as delivery errors", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-main", turn: { id: "turn-main" } },
  })), [{ kind: "thinking", text: "" }]);

  const encoded = driver.encodeStdinMessage("busy follow-up", "thread-main", { mode: "busy" });
  assert.ok(encoded);
  const request = JSON.parse(encoded!);
  assert.equal(request.method, "turn/steer");

  assert.deepEqual(driver.parseLine(JSON.stringify({
    id: request.id,
    error: { message: "steer rejected by app-server" },
  })), [{
    kind: "delivery_error",
    message: "steer rejected by app-server",
    requestMethod: "turn/steer",
    source: "codex_app_server_response",
    payloadBytes: Buffer.byteLength(JSON.stringify({ message: "steer rejected by app-server" }), "utf8"),
  }]);
});

test("codex driver ignores secondary-thread lifecycle and text notifications", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-main", turn: { id: "turn-main" } },
  })), [{ kind: "thinking", text: "" }]);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-secondary", turn: { id: "turn-secondary" } },
  })), []);
  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-secondary",
      turnId: "turn-secondary",
      itemId: "item-secondary",
      delta: "wrong thread text",
    },
  })), []);

  const encoded = driver.encodeStdinMessage("busy follow-up", "thread-main", { mode: "busy" });
  assert.ok(encoded);
  assert.equal(JSON.parse(encoded!).params.expectedTurnId, "turn-main");
});

test("codex driver maps thread/status/changed systemError to runtime error", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/status/changed",
    params: {
      threadId: "thread-main",
      status: {
        type: "systemError",
        error: { message: "turn is not steerable" },
      },
    },
  })), [{
    kind: "error",
    message: "turn is not steerable",
    nativeReasonPresent: true,
    reasonProvenance: "codex_native_reason",
  }]);
});

test("codex driver emits a typed diagnostic when systemError omits its reason", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);

  const events = driver.parseLine(JSON.stringify({
    method: "thread/status/changed",
    params: {
      threadId: "thread-main",
      status: { type: "systemError" },
    },
  }));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "runtime_diagnostic",
    severity: "warning",
    source: "codex_app_server_notification",
    itemType: "codex_thread_system_error_without_reason",
    message: "Codex thread entered system error state without a reason",
    payloadBytes: Buffer.byteLength(JSON.stringify({
      threadId: "thread-main",
      status: { type: "systemError" },
    })),
    reasonPresent: false,
    sessionId: "thread-main",
  });
  assert.deepEqual(events[1], {
    kind: "error",
    message: "Codex thread entered system error state",
    nativeReasonPresent: false,
    reasonProvenance: "daemon_fallback",
  });
});

test("codex driver maps thread/status/changed waiting flags to visible diagnostics", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);

  const approval = driver.parseLine(JSON.stringify({
    method: "thread/status/changed",
    params: {
      threadId: "thread-main",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    },
  }));
  assert.equal(approval.length, 1);
  assert.equal(approval[0]?.kind, "runtime_diagnostic");
  if (approval[0]?.kind === "runtime_diagnostic") {
    assert.equal(approval[0].severity, "warning");
    assert.equal(approval[0].source, "codex_app_server_notification");
    assert.equal(approval[0].itemType, "thread/status/changed");
    assert.equal(approval[0].message, "Codex thread is waiting on approval");
    assert.equal(approval[0].details, "Active flags: waitingOnApproval");
    assert.equal(approval[0].sessionId, "thread-main");
    assert.ok((approval[0].payloadBytes ?? 0) > 0);
  }

  const userInput = driver.parseLine(JSON.stringify({
    method: "thread/status/changed",
    params: {
      threadId: "thread-main",
      status: {
        type: "active",
        activeFlags: ["waitingOnUserInput"],
      },
    },
  }));
  assert.equal(userInput[0]?.kind, "runtime_diagnostic");
  if (userInput[0]?.kind === "runtime_diagnostic") {
    assert.equal(userInput[0].message, "Codex thread is waiting on user input");
    assert.equal(userInput[0].details, "Active flags: waitingOnUserInput");
  }
});

test("codex driver ignores secondary thread/status/changed notifications", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-main" } },
  })), [{ kind: "session_init", sessionId: "thread-main" }]);

  assert.deepEqual(driver.parseLine(JSON.stringify({
    method: "thread/status/changed",
    params: {
      threadId: "thread-secondary",
      status: {
        type: "systemError",
        error: { message: "secondary failure must not contaminate primary" },
      },
    },
  })), []);
});

test("codex driver emits rate limit telemetry without lifecycle progress events", () => {
  const driver = new CodexDriver();

  const events = driver.parseLine(JSON.stringify({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "primary",
        planType: "team",
        primary: {
          usedPercent: 12.5,
          windowDurationMins: 300,
          resetsAt: 1770000000,
        },
      },
    },
  }));

  assert.deepEqual(events, [{
    kind: "telemetry",
    name: "rate_limits",
    source: "codex_account_rate_limits_updated",
    attrs: {
      limitId: "primary",
      planType: "team",
      usedPercent: 12.5,
      windowDurationMins: 300,
      resetsAt: 1770000000,
    },
  }]);
});

test("codex driver emits raw response items as payload-free internal progress", () => {
  const driver = new CodexDriver();
  const rawItem = {
    type: "function_call_output",
    call_id: "call-1",
    output: "secret-ish tool payload that must not be copied into ParsedEvent",
  };

  const events = driver.parseLine(JSON.stringify({
    method: "rawResponseItem/completed",
    params: rawItem,
  }));

  assert.deepEqual(events, [{
    kind: "internal_progress",
    source: "codex_raw_response_item",
    itemType: "function_call_output",
    payloadBytes: Buffer.byteLength(JSON.stringify(rawItem), "utf8"),
  }]);
});

test("codex driver treats retryable app-server errors as non-terminal liveness", () => {
  const driver = new CodexDriver();
  const events = driver.parseLine(JSON.stringify({
    method: "error",
    params: {
      message: "provider stream interrupted; retrying",
      willRetry: true,
    },
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "internal_progress");
  assert.equal(events[0]?.source, "codex_app_server_notification");
  assert.equal(events[0]?.itemType, "retryable_error");
});

test("codex driver surfaces raw CLI capacity error JSON lines as runtime errors", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "error",
    message: "Selected model is at capacity. Please try a different model.",
  })), [{
    kind: "error",
    message: "Selected model is at capacity. Please try a different model.",
  }]);
});

test("codex driver surfaces raw CLI turn.failed capacity JSON lines as runtime errors", () => {
  const driver = new CodexDriver();

  assert.deepEqual(driver.parseLine(JSON.stringify({
    type: "turn.failed",
    error: { message: "Selected model is at capacity. Please try a different model." },
  })), [{
    kind: "error",
    message: "Selected model is at capacity. Please try a different model.",
  }]);
});

test("codex driver surfaces warning notifications as non-terminal runtime diagnostics", () => {
  const driver = new CodexDriver();

  const cases = [
    {
      method: "configWarning",
      params: {
        summary: "Ignored option",
        details: "Old option is deprecated",
        path: "/tmp/codex/config.toml",
        range: { start: { line: 3, column: 1 } },
      },
      expectedMessage: "Ignored option",
      expectedDetails: "Old option is deprecated",
      expectedPath: "/tmp/codex/config.toml",
    },
    {
      method: "warning",
      params: {
        threadId: "thread-1",
        message: "Profile setting was ignored",
      },
      expectedMessage: "Profile setting was ignored",
      expectedSessionId: "thread-1",
    },
    {
      method: "guardianWarning",
      params: {
        threadId: "thread-1",
        message: "Guardian policy adjusted the request",
      },
      expectedMessage: "Guardian policy adjusted the request",
      expectedSessionId: "thread-1",
    },
    {
      method: "deprecationNotice",
      params: {
        summary: "Deprecated config",
        details: "Use the new config key",
      },
      expectedMessage: "Deprecated config",
      expectedDetails: "Use the new config key",
    },
  ];

  for (const entry of cases) {
    const events = driver.parseLine(JSON.stringify({
      method: entry.method,
      params: entry.params,
    }));
    assert.equal(events.length, 1, entry.method);
    const event = events[0];
    assert.equal(event?.kind, "runtime_diagnostic", entry.method);
    if (event?.kind !== "runtime_diagnostic") continue;
    assert.equal(event.severity, "warning");
    assert.equal(event.source, "codex_app_server_notification");
    assert.equal(event.itemType, entry.method);
    assert.equal(event.message, entry.expectedMessage);
    assert.equal(event.details, entry.expectedDetails);
    assert.equal(event.path, entry.expectedPath);
    assert.equal(event.sessionId, entry.expectedSessionId);
    assert.ok((event.payloadBytes ?? 0) > 0);
  }
});

test("codex driver preserves progress notifications as payload-free liveness", () => {
  const driver = new CodexDriver();

  const outputDelta = driver.parseLine(JSON.stringify({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command-1",
      delta: "secret command output that must not be copied",
    },
  }));

  assert.equal(outputDelta.length, 1);
  assert.equal(outputDelta[0]?.kind, "internal_progress");
  assert.equal(outputDelta[0]?.source, "codex_app_server_notification");
  assert.equal(outputDelta[0]?.itemType, "item/commandExecution/outputDelta");
  assert.ok((outputDelta[0]?.payloadBytes ?? 0) > 0);
});

test("codex driver hides raw reasoning text and only surfaces summaries", () => {
  const driver = new CodexDriver();

  const rawDelta = driver.parseLine(JSON.stringify({
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: "raw hidden chain of thought",
    },
  }));
  const completed = driver.parseLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["safe summary"],
        content: ["raw hidden fallback content"],
      },
    },
  }));

  assert.equal(rawDelta.length, 1);
  assert.equal(rawDelta[0]?.kind, "internal_progress");
  assert.equal(rawDelta[0]?.source, "codex_app_server_notification");
  assert.equal(rawDelta[0]?.itemType, "reasoning_text_delta");
  assert.deepEqual(completed, [{ kind: "thinking", text: "safe summary" }]);
});

test("codex driver treats interrupted turns as non-success terminal outcomes", () => {
  const driver = new CodexDriver();
  driver.parseLine(JSON.stringify({
    method: "thread/started",
    params: { thread: { id: "thread-1" } },
  }));

  const events = driver.parseLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "interrupted",
        error: { message: "user aborted" },
      },
    },
  }));

  assert.deepEqual(events, [
    { kind: "error", message: "Codex turn interrupted: user aborted" },
    { kind: "turn_end", sessionId: "thread-1" },
  ]);
});

test("codex thread request passes model, reasoning effort, and fast service tier", () => {
  const driver = new CodexDriver();
  const request = driver.buildThreadRequest({
    agentId: "agent-1",
    config: {
      ...codexConfig,
      runtimeConfig: {
        version: 1,
        runtime: "codex",
        model: { kind: "preset", id: "gpt-5.5" },
        mode: { kind: "fast" },
        reasoningEffort: "low",
      },
    } as any,
    standingPrompt: "SP1",
    prompt: "dynamic",
    workingDirectory: "/tmp/agent",
    slockCliPath: "/tmp/cli.js",
    daemonApiKey: "token",
  });

  assert.equal(request.params.model, "gpt-5.5");
  assert.deepEqual(request.params.config, { model_reasoning_effort: "low" });
  assert.equal(request.params.serviceTier, "fast");
});

test("codex driver reads nested error.message from app-server error notifications", () => {
  const driver = new CodexDriver();
  const events = driver.parseLine(JSON.stringify({
    method: "error",
    params: {
      error: {
        message: "Provider failed",
      },
    },
  }));

  assert.deepEqual(events, [{ kind: "error", message: "Provider failed" }]);
});

function withTempHome(cb: (home: string) => void) {
  const home = mkdtempSync(path.join(os.tmpdir(), "slock-codex-"));
  try { cb(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("detectCodexModelsFromAppServer reads auth-filtered model/list metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-model-list-test-"));
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    const result = await detectCodexModelsFromAppServer({
      cwd: workDir,
      timeoutMs: 2000,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SCRIPTED_CODEX_LOG: logPath,
      },
    });

    assert.deepEqual(result, {
      models: [{
        id: "gpt-5.5",
        label: "GPT-5.5",
        verified: "launchable",
        supportedReasoningEfforts: ["low", "medium"],
        defaultReasoningEffort: "medium",
        serviceTiers: ["fast"],
      }],
      default: "gpt-5.5",
    });
    assert.deepEqual(
      readScriptedCodexMessages(logPath).map((message) => message.method),
      ["initialize", "initialized", "model/list"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectCodexModels returns null when cache missing", () => {
  withTempHome((home) => {
    assert.equal(detectCodexModels(home), null);
  });
});

test("detectCodexModels extracts visible API-supported models and reads default from config.toml", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "public" },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "gpt-5.4-codex", display_name: "GPT-5.4 Codex" },
        { slug: "hidden-picker-model", visibility: "hide" },
        { slug: "internal-preview", visibility: "internal" },
        { slug: "no-api", supported_in_api: false },
        { slug: "bare-slug" },
      ],
    }));
    writeFileSync(path.join(home, ".codex", "config.toml"), `model = "gpt-5.4-codex"\n`);

    const result = detectCodexModels(home);
    assert.ok(result);
    assert.deepEqual(result!.models.map((m) => m.id).sort(), ["bare-slug", "gpt-5.4", "gpt-5.4-codex", "gpt-5.5"]);
    const gpt54 = result!.models.find((m) => m.id === "gpt-5.4");
    assert.equal(gpt54?.label, "GPT-5.4");
    const gpt55 = result!.models.find((m) => m.id === "gpt-5.5");
    assert.equal(gpt55?.label, "GPT-5.5");
    const bare = result!.models.find((m) => m.id === "bare-slug");
    assert.equal(bare?.label, "bare-slug");
    assert.equal(result!.default, "gpt-5.4-codex");
  });
});

test("detectCodexModels reads CODEX_HOME root-shaped cache and config", () => {
  withTempHome((home) => {
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5-codex", display_name: "GPT-5.5 Codex", visibility: "public" }],
    }));
    writeFileSync(path.join(home, "config.toml"), `model = "gpt-5.5-codex"\n`);

    const result = detectCodexModels(home);
    assert.ok(result);
    assert.deepEqual(result!.models, [{
      id: "gpt-5.5-codex",
      label: "GPT-5.5 Codex",
      verified: "launchable",
    }]);
    assert.equal(result!.default, "gpt-5.5-codex");
  });
});

test("detectCodexModels tolerates missing config.toml", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-5.4", visibility: "public" }],
    }));
    const result = detectCodexModels(home);
    assert.ok(result);
    assert.equal(result!.default, undefined);
  });
});

test("resolveCodexCommand falls back to ChatGPT.app bundled CLI on macOS", () => {
  const resolved = resolveCodexCommand({
    platform: "darwin",
    execFileSyncFn: () => {
      throw new Error("not on path");
    },
    existsSyncFn: (candidate) => candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
  });

  assert.equal(resolved, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("probeCodex reports version from ChatGPT.app bundled CLI fallback", () => {
  const result = probeCodex({
    platform: "darwin",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object, maybeOptions?: object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") throw new Error("not on path");
      assert.equal(command, "/Applications/ChatGPT.app/Contents/Resources/codex");
      if (args[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\n");
      }
      assert.deepEqual(args, ["--version"]);
      return Buffer.from("codex-cli 0.116.0-alpha.10\n");
    }) as typeof import("node:child_process").execFileSync,
    existsSyncFn: (candidate) => candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
    statSyncFn: () => {
      throw new Error("disable host-file cache for the injected probe");
    },
  });

  assert.deepEqual(result, { available: true, version: "codex-cli 0.116.0-alpha.10" });
});

test("probeCodex falls through ordered candidates when the first lacks app-server", () => {
  const pathCodex = "/tmp/old-codex";
  const appCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = probeCodex({
    platform: "darwin",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") return Buffer.from(`${pathCodex}\n`);
      if (command === pathCodex && args[0] === "app-server") {
        const error = new Error("unknown command") as Error & { status: number };
        error.status = 2;
        throw error;
      }
      if (command === appCodex && args[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\n");
      }
      if (command === appCodex && args[0] === "--version") {
        return Buffer.from("codex-cli 0.130.0\n");
      }
      throw new Error(`unexpected exec ${command} ${args.join(" ")}`);
    }) as typeof import("node:child_process").execFileSync,
    existsSyncFn: (candidate) => candidate === appCodex,
    statSyncFn: () => {
      throw new Error("disable host-file cache for the injected probe");
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.version, "codex-cli 0.130.0");
  assert.match(result.diagnostic ?? "", /old-codex rejected: app-server probe exit status 2/);
});

test("probeCodex does not advertise version-only installs without app-server", () => {
  const result = probeCodex({
    platform: "linux",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") return Buffer.from("/tmp/codex\n");
      if (args[0] === "app-server") {
        const error = new Error("unknown command") as Error & { status: number };
        error.status = 2;
        throw error;
      }
      if (args[0] === "--version") return Buffer.from("codex-cli 0.115.0\n");
      throw new Error(`unexpected exec ${command} ${args.join(" ")}`);
    }) as typeof import("node:child_process").execFileSync,
  });

  assert.equal(result.available, false);
  assert.match(result.diagnostic ?? "", /\/tmp\/codex rejected: app-server probe exit status 2/);
});

test("resolveCodexCommand ignores Windows sandbox runner fallback", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const resolved = resolveCodexCommand({
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    });

    assert.equal(resolved, null);
  });
});

test("probeCodex does not treat Windows sandbox runner as available", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    });

    assert.equal(result.available, false);
  });
});

test("resolveCodexSpawn returns Codex Desktop exe on Windows when npm install not found", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "win32",
      homeDir: home,
      execFileSyncFn: ((command: string, args?: readonly string[]) => {
        if (command === "npm") throw new Error("npm install not found");
        if (command === desktopCodex && args?.[0] === "app-server") {
          assert.deepEqual(args, ["app-server", "--help"]);
          return Buffer.from("Usage: codex app-server\r\n");
        }
        assert.equal(command, "powershell.exe");
        assert.deepEqual(args?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
        return Buffer.from(`${desktopCodex}\r\n`);
      }) as any,
    });

    assert.equal(result.command, desktopCodex);
    assert.deepEqual(result.args, ["app-server", "--listen", "stdio://"]);
    assert.equal(result.shell, false);
  });
});

test("resolveCodexSpawn runs the Windows npm entry through packaged Electron's Node mode", () => {
  const electronExecutable = String.raw`C:\Program Files\Raft\Raft.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const baseEnv = { BASE_ENV: "present" };

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: baseEnv,
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === electronExecutable) {
        assert.deepEqual(args, [npmEntry, "app-server", "--help"]);
        assert.equal(options?.env?.BASE_ENV, "present");
        assert.equal(options?.env?.ELECTRON_RUN_AS_NODE, "1");
        return Buffer.from("Usage: codex app-server\r\n");
      }
      throw new Error(`unexpected command ${command}`);
    }) as any,
    existsSyncFn: (candidate: string) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execPath: electronExecutable,
    execIsElectron: true,
  } as any);

  assert.equal(result.command, electronExecutable);
  assert.deepEqual(result.args, [npmEntry, "app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
  assert.equal(result.env?.BASE_ENV, "present");
  assert.equal(result.env?.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveCodexSpawn runs the Windows npm entry through a genuine Node host", () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { BASE_ENV: "present" },
    execPath: nodeExecutable,
    execIsElectron: false,
    execIsSea: false,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === nodeExecutable) {
        assert.equal(options?.env?.BASE_ENV, "present");
        assert.equal(options?.env?.ELECTRON_RUN_AS_NODE, undefined);
        if (args?.includes("--version")) return Buffer.from("codex-cli 0.149.0\r\n");
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.equal(result.command, nodeExecutable);
  assert.deepEqual(result.args, [npmEntry, "app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
  assert.equal(result.env?.ELECTRON_RUN_AS_NODE, undefined);
});

test("resolveCodexSpawn skips an npm JS entry in a Windows SEA and selects the PATH cmd shim", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Program Files\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const invoked: string[] = [];

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { PATH: String.raw`C:\Users\bot\AppData\Roaming\npm` },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry || candidate === shim,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      invoked.push(command);
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") return Buffer.from(`${shim}\r\n`);
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      if (command === shim && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === shim && args?.[0] === "--version") return Buffer.from("codex-cli 0.149.0\r\n");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.deepEqual(result, {
    command: shim,
    args: ["app-server", "--listen", "stdio://"],
    shell: true,
    source: "path",
  });
  assert.ok(!invoked.includes(seaExecutable));
  clearCodexProbeCacheForTests();
});

test("resolveCodexSpawn skips an npm JS entry in a Windows SEA and selects the native install", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Program Files\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const nativeCodex = String.raw`C:\Users\bot\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`;

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: {
      PATH: String.raw`C:\Windows\System32`,
      LOCALAPPDATA: String.raw`C:\Users\bot\AppData\Local`,
    },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry || candidate === nativeCodex,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      if (command === nativeCodex && args?.[0] === "app-server") return Buffer.from("Usage: codex app-server\r\n");
      if (command === nativeCodex && args?.[0] === "--version") return Buffer.from("codex-cli 0.149.0\r\n");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.deepEqual(result, {
    command: nativeCodex,
    args: ["app-server", "--listen", "stdio://"],
    shell: false,
    source: "desktop_install",
  });
  clearCodexProbeCacheForTests();
});

test("probeCodex reports a bounded missing-node-host rejection when a Windows SEA has no executable fallback", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Private User\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Private User\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Private User\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const privatePath = String.raw`C:\Private User\private-bin`;
  const deps = {
    platform: "win32" as const,
    env: { PATH: privatePath },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate: string) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  };

  const probe = probeCodex(deps);
  assert.equal(probe.available, false);
  assert.match(probe.diagnostic ?? "", /npm_global JavaScript entry rejected: node_host_unavailable \(host_kind=sea\)/);
  assert.doesNotMatch(probe.diagnostic ?? "", /Private User|private-bin|codex\.js/);
  assert.throws(() => resolveCodexSpawn(["app-server"], deps), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /npm_global JavaScript entry rejected: node_host_unavailable \(host_kind=sea\)/);
    assert.doesNotMatch(error.message, /Private User|private-bin|codex\.js/);
    return true;
  });
  clearCodexProbeCacheForTests();
});

test("resolveCodexSpawn uses shell:true on Windows when PATH resolves to a .cmd shim", () => {
  const shim = "C:\\Users\\test\\AppData\\Local\\npm\\codex.cmd";
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === "npm") throw new Error("npm install not found");
      if (command === shim && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === "powershell.exe") {
        assert.deepEqual(args?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
        return Buffer.from(`${shim}\r\n`);
      }
      return Buffer.from("");
    }) as any,
  });

  assert.equal(result.command, shim);
  assert.deepEqual(result.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, true);
});

test("resolveCodexSpawn falls back to standard Codex Desktop install path on Windows", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    homeDir: "C:\\Users\\user",
    env: { USERPROFILE: "C:\\Users\\user" },
    existsSyncFn: (candidate) => candidate === desktopCodex,
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === desktopCodex && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      throw new Error("not on path");
    }) as any,
  });

  assert.equal(result.command, desktopCodex);
  assert.deepEqual(result.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
});

test("Codex inventory and spawn fall back to the native Windows install when the PATH probe times out", () => {
  const nativeCodex = "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  let pathProbeCount = 0;

  const deps = {
    platform: "win32" as const,
    env: {
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
      USERPROFILE: "C:\\Users\\user",
    },
    existsSyncFn: (candidate: string) => candidate === nativeCodex,
    windowsEnvironmentReaderFn: () => null,
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { timeout?: number }) => {
      if (command === "npm") throw new Error("npm install not found");
      if (command === "powershell.exe") {
        pathProbeCount += 1;
        assert.equal(options?.timeout, 1000);
        const error = new Error("PATH probe timed out") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        throw error;
      }
      if (command === nativeCodex && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === nativeCodex && args?.[0] === "--version") {
        return Buffer.from("codex-cli 0.145.0\r\n");
      }
      throw new Error(`unexpected exec ${command}`);
    }) as any,
  };

  assert.deepEqual(probeCodex(deps), {
    available: true,
    version: "codex-cli 0.145.0",
  });
  assert.deepEqual(
    resolveCodexSpawn(["app-server", "--listen", "stdio://"], deps),
    {
      command: nativeCodex,
      args: ["app-server", "--listen", "stdio://"],
      shell: false,
      source: "desktop_install",
    },
  );
  assert.equal(pathProbeCount, 4);
});

test("resolveCodexSpawn rejects Windows sandbox runner when no real Codex CLI is found", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.129.0-alpha.1.exe"), "");
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    assert.throws(() => resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    }), /sandbox helper/);
  });
});

test("compareCodexVersions orders dotted triples and real alpha builds", () => {
  assert.equal(compareCodexVersions("codex-cli 0.147.0", "0.143.0"), 1);
  assert.equal(compareCodexVersions("0.143.0", "0.147.0-alpha.1"), -1);
  assert.equal(compareCodexVersions("not-a-version", "0.1.0"), null);
  // Same core: release ranks above prerelease.
  assert.equal(compareCodexVersions("0.147.0", "0.147.0-alpha.6.5"), 1);
  // Real install family from parent thread: later alpha trail wins.
  assert.equal(compareCodexVersions("codex-cli 0.147.0-alpha.6.5", "0.147.0-alpha.1"), 1);
  assert.equal(compareCodexVersions("0.147.0-alpha.1", "0.147.0-alpha.6.5"), -1);
  assert.equal(compareCodexVersions("0.147.0-alpha.6.5", "0.147.0-alpha.6.5"), 0);
  assert.equal(compareCodexVersions("0.147.0-alpha.6.5", "0.147.0-alpha.6"), 1);
  assert.ok(parseCodexVersion("codex-cli 0.147.0-alpha.6.5")?.pre?.join(".") === "6.5");
});

test("resolveCodexSpawn CODEX_BIN is authoritative over a higher-version PATH candidate", () => {
  const override = "/opt/override/codex";
  const pathBin = "/opt/path/codex";
  const probed: string[] = [];
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "darwin",
    env: { PATH: "/opt/path", CODEX_BIN: override },
    existsSyncFn: (p) => {
      const s = String(p);
      return s === override || s === pathBin || s.endsWith(`${path.sep}codex`);
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      if (c === "which" || c.endsWith("/which")) {
        // PATH would surface the higher version; override must still win without probing it.
        return Buffer.from(`${pathBin}\n`);
      }
      probed.push(c);
      if (args.includes("--version")) {
        if (c === override) return Buffer.from("0.143.0\n");
        if (c === pathBin) return Buffer.from("0.147.0-alpha.6.5\n");
      }
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, override);
  assert.equal(result.source, "explicit_bin");
  assert.ok(probed.includes(override));
  assert.ok(!probed.includes(pathBin), "PATH candidate must not be version-arbitrated against CODEX_BIN");
});

test("resolveCodexSpawn CODEX_BIN is authoritative on Windows", () => {
  const override = "C:\\override\\codex.exe";
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32", CODEX_BIN: override, LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    existsSyncFn: (p) => String(p) === override,
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      // npm root / where must not be required for an absolute override.
      if (c === "npm" || c === "where" || c === "where.exe") {
        throw new Error("should not need discovery when CODEX_BIN is set");
      }
      if (c === override && args.includes("--version")) return Buffer.from("0.147.0-alpha.6.5\n");
      if (c === override) return Buffer.from("");
      throw new Error(`unexpected exec: ${c}`);
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, override);
  assert.equal(result.source, "explicit_bin");
});

test("resolveCodexSpawn fails closed when CODEX_BIN is set but unusable", () => {
  assert.throws(
    () => resolveCodexSpawn(["app-server"], {
      platform: "darwin",
      env: { PATH: "/opt/path", CODEX_BIN: "/missing/override/codex" },
      existsSyncFn: (p) => String(p) === "/opt/path/codex",
      execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        if (String(cmd) === "which" || String(cmd).endsWith("/which")) {
          return Buffer.from("/opt/path/codex\n");
        }
        if (args.includes("--version")) return Buffer.from("0.147.0\n");
        return Buffer.from("");
      }) as typeof import("node:child_process").execFileSync,
    }),
    /CODEX_BIN is set but does not resolve|path does not exist/,
  );
});

test("resolveCodexSpawn fails closed when CODEX_BIN probe fails even if PATH has a candidate", () => {
  const override = "/opt/override/codex";
  assert.throws(
    () => resolveCodexSpawn(["app-server"], {
      platform: "darwin",
      env: { PATH: "/opt/path", CODEX_BIN: override },
      existsSyncFn: (p) => {
        const s = String(p);
        return s === override || s === "/opt/path/codex";
      },
      execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        if (String(cmd) === "which" || String(cmd).endsWith("/which")) {
          return Buffer.from("/opt/path/codex\n");
        }
        if (String(cmd) === override) {
          const err = new Error("override broken") as NodeJS.ErrnoException & { status?: number };
          err.status = 127;
          throw err;
        }
        if (args.includes("--version")) return Buffer.from("0.147.0\n");
        return Buffer.from("");
      }) as typeof import("node:child_process").execFileSync,
    }),
    /CODEX_BIN is set but does not resolve|app-server probe/,
  );
});

test("resolveCodexSpawn uses ChatGPT.app desktop bundle when PATH misses codex", () => {
  const chatgpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const exists = new Set([chatgpt]);
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "darwin",
    env: { PATH: "/empty" },
    existsSyncFn: (p) => exists.has(String(p)),
    execFileSyncFn: ((_cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (args.includes("--version")) return Buffer.from("0.147.0\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, chatgpt);
  assert.equal(result.source, "desktop_bundle");
});

test("resolveCodexSpawn does not revive deprecated Codex.app-only fallback", () => {
  const legacy = "/Applications/Codex.app/Contents/Resources/codex";
  const exists = new Set([legacy]);
  assert.throws(
    () => resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "darwin",
      env: { PATH: "/empty" },
      existsSyncFn: (p) => exists.has(String(p)),
      execFileSyncFn: ((() => Buffer.from("")) as unknown as typeof import("node:child_process").execFileSync),
    }),
    /Cannot resolve a compatible Codex CLI/,
  );
});

test("resolveCodexSpawn selects higher version among PATH and desktop candidates", () => {
  const pathBin = "/opt/old/codex";
  const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = resolveCodexSpawn(["app-server"], {
    platform: "darwin",
    env: { PATH: "/opt/old", HOME: "/Users/tester" },
    existsSyncFn: (p) => {
      const s = String(p);
      return s === pathBin || s === desktop;
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      if (c === "which" || c.endsWith("/which")) {
        return Buffer.from(`${pathBin}\n`);
      }
      if (args.includes("--version")) {
        if (c === pathBin) return Buffer.from("codex-cli 0.143.0\n");
        if (c === desktop) return Buffer.from("codex-cli 0.147.0-alpha.6.5\n");
      }
      // app-server --help succeeds for both
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, desktop);
  assert.equal(result.source, "desktop_bundle");
});

test("resolveCodexSpawn error mentions PATH and daemon restart", () => {
  assert.throws(
    () => resolveCodexSpawn(["app-server"], {
      platform: "darwin",
      env: { PATH: "/no/codex/here" },
      existsSyncFn: () => false,
      execFileSyncFn: ((() => {
        throw new Error("should not run");
      }) as typeof import("node:child_process").execFileSync),
    }),
    /PATH=.*Restart the Raft daemon/s,
  );
});

test("codex probe cache reuses exec on same path mtime/size and re-probes on change", () => {
  clearCodexProbeCacheForTests();
  const bin = "/tmp/haohao-codex-cache-bin";
  let mtimeMs = 1000;
  let size = 100;
  let execCount = 0;

  const deps = {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: bin },
    existsSyncFn: (p: string) => String(p) === bin,
    statSyncFn: (p: string) => {
      assert.equal(String(p), bin);
      return { mtimeMs, size };
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      execCount += 1;
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (String(cmd) !== bin) throw new Error(`unexpected ${cmd}`);
      if (args.includes("--version")) return Buffer.from("0.147.0-alpha.6.5\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  };

  const first = resolveCodexSpawn(["app-server"], deps);
  assert.equal(first.command, bin);
  const afterFirst = execCount;
  assert.ok(afterFirst >= 2, "first resolve must probe app-server and version");

  const second = resolveCodexSpawn(["app-server"], deps);
  assert.equal(second.command, bin);
  assert.equal(execCount, afterFirst, "second resolve must reuse probe cache (zero extra exec)");

  mtimeMs = 2000; // invalidate
  const third = resolveCodexSpawn(["app-server"], deps);
  assert.equal(third.command, bin);
  assert.ok(execCount > afterFirst, "mtime change must re-probe");

  clearCodexProbeCacheForTests();
});

test("codex probe cache re-probes after a cached failure recovers", () => {
  clearCodexProbeCacheForTests();
  const bin = "/tmp/haohao-codex-cache-fail-bin";
  let mtimeMs = 50;
  let fail = true;
  let execCount = 0;

  const deps = {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: bin },
    existsSyncFn: (p: string) => String(p) === bin,
    statSyncFn: () => ({ mtimeMs, size: 10 }),
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      execCount += 1;
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (fail) {
        const err = new Error("boom") as NodeJS.ErrnoException & { status?: number };
        err.status = 1;
        throw err;
      }
      if (args.includes("--version")) return Buffer.from("0.147.0\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  };

  assert.throws(() => resolveCodexSpawn(["app-server"], deps), /CODEX_BIN is set/);
  const afterFail = execCount;
  assert.ok(afterFail >= 1);

  // Same mtime: failure is cached — still fail without needing a different mtime,
  // but we invalidate via mtime change (binary "fixed").
  mtimeMs = 51;
  fail = false;
  const ok = resolveCodexSpawn(["app-server"], deps);
  assert.equal(ok.command, bin);
  assert.ok(execCount > afterFail, "recovered binary after mtime change must re-probe");

  clearCodexProbeCacheForTests();
});
