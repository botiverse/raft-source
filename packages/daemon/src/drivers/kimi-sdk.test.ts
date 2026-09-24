import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync as fsMkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  KimiSdkDriver,
  KimiSdkRuntimeSession,
  KIMI_CODE_HOST_VERSION,
  KIMI_CODE_PLATFORM,
  buildKimiSessionDir,
  composeStandingRoleAdditional,
  createKimiAgentSessionForContext,
  createKimiSdkEventMappingState,
  detectKimiSdkModels,
  mapKimiSdkEventToParsedEvents,
  type KimiSessionFactory,
} from "./kimi-sdk.js";
import { prepareCliTransport } from "./cliTransport.js";
import {
  LocalKaos,
  createKimiHarness,
  type Event as KimiSdkEvent,
  type GoalSnapshot,
  type KimiHarness,
  type Session as KimiSession,
} from "@botiverse/kimi-code-sdk";
import type { ParsedEvent, SpawnContext } from "./types.js";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { __resetManagedMcpRuntimeProxyForTest } from "../managedMcpRuntimeProxy.js";

function makeSpawnContext(overrides: Partial<SpawnContext["config"]> = {}): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing instructions",
    prompt: "wake prompt",
    workingDirectory: "/tmp/kimi-agent",
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: {
      name: "Kimi Agent",
      displayName: null,
      description: null,
      runtime: "kimi-sdk",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: "default",
      reasoningEffort: null,
      envVars: null,
      runtimeContext: null,
      ...overrides,
    },
  };
}

function eventBase(): { agentId: string; sessionId: string } {
  return { agentId: "main", sessionId: "kimi-session-1" };
}

function activeGoalSnapshot(): GoalSnapshot {
  return {
    goalId: "goal-1",
    objective: "finish the task",
    status: "active",
    turnsUsed: 1,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

test("Kimi host identity version stays in lockstep with the pinned SDK package", () => {
  const daemonPackagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const daemonPackage = JSON.parse(readFileSync(daemonPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    KIMI_CODE_HOST_VERSION,
    daemonPackage.dependencies?.["@botiverse/kimi-code-sdk"],
  );
});

test("Kimi host identity platform is the underscore X-Msh-Platform value, distinct from the hyphenated UA product", () => {
  // SDK 0.33.0 docblock: X-Msh-Platform examples use underscores
  // (kimi_code_cli / kimi_code_desktop). Reusing the hyphenated UA product
  // would couple two distinct wire surfaces and send an undocumented format.
  assert.equal(KIMI_CODE_PLATFORM, "kimi_code_cli");
  assert.ok(!KIMI_CODE_PLATFORM.includes("-"));
  assert.notEqual(KIMI_CODE_PLATFORM, "kimi-code-cli");
});

test("buildKimiSessionDir lives under the agent's working directory", () => {
  assert.equal(
    buildKimiSessionDir("/tmp/kimi-agent"),
    path.join("/tmp/kimi-agent", ".kimi-sessions"),
  );
});

test("createKimiSdkEventMappingState seeds with the session id and announces only once", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  assert.deepEqual(state, { sessionId: "kimi-session-1", sessionAnnounced: false });

  // First emit — session_init prepended.
  const first = mapKimiSdkEventToParsedEvents(
    { ...eventBase(), type: "assistant.delta", turnId: 1, delta: "hi" },
    state,
  );
  assert.deepEqual(first, [
    { kind: "session_init", sessionId: "kimi-session-1" },
    { kind: "text", text: "hi" },
  ]);
  assert.equal(state.sessionAnnounced, true);

  // Subsequent emits — no second session_init.
  const second = mapKimiSdkEventToParsedEvents(
    { ...eventBase(), type: "assistant.delta", turnId: 1, delta: " there" },
    state,
  );
  assert.deepEqual(second, [{ kind: "text", text: " there" }]);
});

test("mapKimiSdkEventToParsedEvents — content-streaming events map to the right ParsedEvent kinds", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;

  const cases: Array<{ event: KimiSdkEvent & Record<string, unknown>; expected: ParsedEvent[] }> = [
    {
      event: { ...eventBase(), type: "thinking.delta", turnId: 1, delta: "thinking…" },
      expected: [{ kind: "thinking", text: "thinking…" }],
    },
    {
      event: { ...eventBase(), type: "assistant.delta", turnId: 1, delta: "answer" },
      expected: [{ kind: "text", text: "answer" }],
    },
    {
      event: {
        ...eventBase(),
        type: "tool.call.started",
        turnId: 1,
        toolCallId: "t1",
        name: "shell",
        args: { command: "ls" },
      },
      expected: [{ kind: "tool_call", name: "shell", input: { command: "ls" } }],
    },
    {
      event: {
        ...eventBase(),
        type: "tool.result",
        turnId: 1,
        toolCallId: "t1",
        output: "ok",
      },
      expected: [{ kind: "tool_output", name: "" }],
    },
    {
      event: { ...eventBase(), type: "compaction.started", trigger: "auto" },
      expected: [{ kind: "compaction_started" }],
    },
    {
      event: {
        ...eventBase(),
        type: "compaction.completed",
        result: {
          summary: "summary",
          compactedCount: 1,
          tokensBefore: 100,
          tokensAfter: 20,
        },
      },
      expected: [{ kind: "compaction_finished" }],
    },
  ];

  for (const { event, expected } of cases) {
    const out = mapKimiSdkEventToParsedEvents(event, state);
    assert.deepEqual(out, expected, `mapping for ${event.type} should produce ${JSON.stringify(expected)}`);
  }
});

test("RS-004 invariant — turn.ended is the SOLE turn-triggering source class (daemon idle proxy)", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;

  // turn.ended → kind:"turn_end".
  const endOut = mapKimiSdkEventToParsedEvents(
    { ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" },
    state,
  );
  assert.deepEqual(endOut, [{ kind: "turn_end", sessionId: "kimi-session-1" }]);

  // No other event class produces kind:"turn_end". Sample candidates that one
  // might naively map: turn.started, turn.step.completed, etc.
  const tempting: Array<KimiSdkEvent & Record<string, unknown>> = [
    { ...eventBase(), type: "turn.started", turnId: 1, origin: "user" as never },
    { ...eventBase(), type: "turn.step.started", turnId: 1, step: 0 },
    { ...eventBase(), type: "turn.step.completed", turnId: 1, step: 0 },
    { ...eventBase(), type: "turn.step.interrupted", turnId: 1, step: 0, reason: "abort" },
  ];
  for (const event of tempting) {
    const out = mapKimiSdkEventToParsedEvents(event, state);
    assert.equal(
      out.some((p) => p.kind === "turn_end"),
      false,
      `event ${event.type} must NOT produce kind:"turn_end" — only turn.ended is the daemon-idle source`,
    );
  }
});

test("RS-004 invariant — explicit drops (state-only / out-of-band) emit no ParsedEvents", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;

  const dropped: Array<KimiSdkEvent & Record<string, unknown>> = [
    { ...eventBase(), type: "turn.started", turnId: 1, origin: "user" as never },
    { ...eventBase(), type: "turn.step.started", turnId: 1, step: 0 },
    { ...eventBase(), type: "turn.step.completed", turnId: 1, step: 0 },
    { ...eventBase(), type: "turn.step.retrying", turnId: 1, step: 0, failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 100, errorName: "X", errorMessage: "y" },
    { ...eventBase(), type: "turn.step.interrupted", turnId: 1, step: 0, reason: "abort" },
    { ...eventBase(), type: "tool.call.delta", turnId: 1, toolCallId: "t1" },
    { ...eventBase(), type: "tool.progress", turnId: 1, toolCallId: "t1", update: {} as never },
    { ...eventBase(), type: "hook.result", turnId: 1, hookEvent: "PreToolUse", content: "ok" },
    { ...eventBase(), type: "agent.status.updated" },
    { ...eventBase(), type: "session.meta.updated" },
    { ...eventBase(), type: "event.session.created", session: {} as never },
    { ...eventBase(), type: "event.workspace.created", workspace: {} as never },
    { ...eventBase(), type: "event.workspace.updated", workspace: {} as never },
    { ...eventBase(), type: "event.workspace.deleted", workspace_id: "w", root: "/tmp/w" },
    { ...eventBase(), type: "event.session.work_changed", busy: false, main_turn_active: false },
    { ...eventBase(), type: "event.session.status_changed", status: "idle", previous_status: "running" },
    { ...eventBase(), type: "event.config.changed", changedFields: ["model"], config: {} as never },
    { ...eventBase(), type: "event.model_catalog.changed", changed: [], unchanged: [], failed: [] },
    { ...eventBase(), type: "goal.updated", snapshot: null },
    { ...eventBase(), type: "skill.activated", activationId: "a", skillName: "s", trigger: "user-slash" },
    { ...eventBase(), type: "plugin_command.activated", activationId: "a", pluginId: "p", commandName: "c", trigger: "user-slash" },
    { ...eventBase(), type: "shell.output", commandId: "c", update: {} as never },
    { ...eventBase(), type: "shell.started", commandId: "c", taskId: "t" },
    { ...eventBase(), type: "shell.completed", commandId: "c", taskId: "t", isError: false },
    { ...eventBase(), type: "tool.list.updated", reason: "mcp.connected", serverName: "m" },
    { ...eventBase(), type: "mcp.server.status", server: { name: "m", transport: "stdio", status: "connected", toolCount: 0 } },
    { ...eventBase(), type: "subagent.spawned", subagentId: "sa", subagentName: "sa", parentToolCallId: "t1", runInBackground: false },
    { ...eventBase(), type: "subagent.started", subagentId: "sa" },
    { ...eventBase(), type: "subagent.suspended", subagentId: "sa", reason: "x" },
    { ...eventBase(), type: "subagent.completed", subagentId: "sa", resultSummary: "done" },
    { ...eventBase(), type: "subagent.failed", subagentId: "sa", error: "oh" },
    { ...eventBase(), type: "compaction.blocked" },
    { ...eventBase(), type: "compaction.cancelled" },
    { ...eventBase(), type: "task.started", info: {} as never },
    { ...eventBase(), type: "task.terminated", info: {} as never },
    { ...eventBase(), type: "background.task.started", info: {} as never },
    { ...eventBase(), type: "background.task.terminated", info: {} as never },
    { ...eventBase(), type: "cron.fired", origin: {} as never, prompt: "hi" },
    { ...eventBase(), type: "prompt.submitted", promptId: "p", userMessageId: "m", status: "running", content: [], createdAt: "2026-07-17T00:00:00Z" },
    { ...eventBase(), type: "prompt.completed", promptId: "p", finishedAt: "2026-07-17T00:00:01Z", reason: "completed" },
    { ...eventBase(), type: "prompt.aborted", promptId: "p", abortedAt: "2026-07-17T00:00:01Z" },
    { ...eventBase(), type: "prompt.steered", activePromptId: "p", promptIds: ["p2"], content: [], steeredAt: "2026-07-17T00:00:01Z" },
    // Per Hao review on PR #2974: SDK `warning` is non-fatal but APM treats
    // ParsedEvent.kind="error" as terminal (latches `lastRuntimeError`), so
    // mapping warning→error would brick the agent on any non-fatal SDK
    // warning. Drop here; the SDK's own log records the warning.
    { ...eventBase(), type: "warning", message: "suspicious config" },
  ];

  for (const event of dropped) {
    const out = mapKimiSdkEventToParsedEvents(event, state);
    assert.deepEqual(out, [], `event ${event.type} must produce zero ParsedEvents (explicit drop)`);
  }
});

test("RS-011 invariant — KimiSdkDriver.parseLine is a no-op (adapter does not derive ParsedEvents from lines independently of SDK events)", () => {
  const driver = new KimiSdkDriver();
  // Pump a variety of strings; no derivation should happen.
  const samples = [
    "{\"type\":\"agent.status.updated\"}",
    "random stdout chatter",
    "",
  ];
  for (const line of samples) {
    assert.deepEqual(driver.parseLine(line), [], `parseLine(${JSON.stringify(line)}) must return [] — RS-011 adapter must not derive ParsedEvents independent of SDK events`);
  }
});

test("source guard — KimiSdkDriver refuses child-process spawn (in-process only)", async () => {
  const driver = new KimiSdkDriver();
  await assert.rejects(
    () => Promise.resolve(driver.spawn(makeSpawnContext())),
    /native RuntimeSession; child-process spawn is unsupported/,
    "KimiSdkDriver must throw on spawn() — RuntimeSessionDescriptor.transport='sdk' forbids child_process transport",
  );
});

test("source guard — descriptor pins transport=sdk + busyDelivery=direct + lifecycle=sdk_session", () => {
  const driver = new KimiSdkDriver();
  const session = driver.createSession(makeSpawnContext());
  assert.equal(session.descriptor.transport, "sdk");
  assert.equal(session.descriptor.lifecycle, "sdk_session");
  assert.equal(session.descriptor.busyDelivery, "direct");
  assert.equal(session.descriptor.turnBoundary, "sdk_event");
  assert.equal(session.descriptor.startPolicy, "immediate");
});

test("source guard — kimi-sdk.ts must NOT contain wildcard mapping (every Kimi event class needs an explicit map or drop)", () => {
  const sourcePath = fileURLToPath(new URL("./kimi-sdk.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  // The exhaustive-never default is the closed-mapping pin. If a wildcard
  // ever sneaks in (default falling through silently to []), this RED-greens.
  assert.match(
    source,
    /const _exhaustive: never = event;/,
    "mapKimiSdkEventToParsedEvents must end its switch with `const _exhaustive: never = event;` — RS-004 closed-mapping",
  );
  // No silent default — a `default:\s*return` would route any new event class
  // to a no-op without the type-error. Reject it.
  assert.doesNotMatch(
    source,
    /default:\s*return\s*\[\]/,
    "kimi-sdk.ts must not have `default: return []` — that hides unmapped event classes",
  );
  assert.doesNotMatch(
    source,
    /(?:export\s+)?type KimiSdkEvent\s*=/,
    "kimi-sdk.ts must use the SDK Event type directly, not maintain a local mirror",
  );
  assert.match(
    source,
    /type Event as KimiSdkEvent/,
    "kimi-sdk.ts must import the SDK Event type as the closed-mapping input",
  );
});

test("KimiSdkDriver registers with id 'kimi-sdk' and is distinct from the legacy 'kimi' driver", () => {
  const driver = new KimiSdkDriver();
  assert.equal(driver.id, "kimi-sdk", "driver id must be 'kimi-sdk' (the legacy CLI driver keeps id 'kimi')");
  assert.deepEqual(driver.probe(), { available: true, version: KIMI_CODE_HOST_VERSION });
  assert.equal(driver.busyDeliveryMode, "direct");
  assert.equal(driver.supportsStdinNotification, true);
});

test("detectKimiSdkModels reads <kimiHome>/config.toml and surfaces every [models.<id>] entry the user provisioned", () => {
  // Simulates a config.toml after `kimi login` populates K2.6 + K2.7 from
  // Moonshot's /models endpoint. Same shape `provisionManagedKimiCodeConfig`
  // writes upstream (`packages/oauth/src/managed-kimi-code.ts`).
  const home = path.join(os.tmpdir(), `kimi-detect-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  fsWriteFileSync(
    path.join(home, "config.toml"),
    `default_model = "kimi-code/kimi-for-coding"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "Kimi-k2.6"

[models."kimi-code/kimi-for-coding-next"]
provider = "managed:kimi-code"
model = "kimi-for-coding-next"
display_name = "Kimi-k2.7"
`,
    "utf8",
  );

  const outcome = detectKimiSdkModels(home);
  assert.equal(outcome.kind, "live");
  if (outcome.kind !== "live") assert.fail("must return live when config.toml has models");
  const set = outcome.value;
  assert.equal(set.default, "kimi-code/kimi-for-coding");
  assert.equal(set.models.length, 2);
  const k26 = set.models.find((m) => m.id === "kimi-code/kimi-for-coding");
  const k27 = set.models.find((m) => m.id === "kimi-code/kimi-for-coding-next");
  assert.ok(k26 && k27, "must surface both [models.*] entries the user has provisioned");
  // display_name from the toml must be preserved as the picker label.
  assert.equal(k26!.label, "Kimi-k2.6");
  assert.equal(k27!.label, "Kimi-k2.7");
  // All toml-provisioned models are launchable — they're a kimi-login fact.
  for (const model of set.models) {
    assert.equal(model.verified, "launchable");
  }
});

test("detectKimiSdkModels keeps effort metadata model-scoped and omits missing metadata", () => {
  const home = path.join(os.tmpdir(), `kimi-detect-efforts-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  fsWriteFileSync(
    path.join(home, "config.toml"),
    `default_model = "kimi-code/k3"

[models."kimi-code/k3"]
display_name = "Kimi K3"
support_efforts = ["max", "ultra"]
default_effort = "max"

[models."kimi-code/no-effort-metadata"]
display_name = "Kimi without metadata"
`,
    "utf8",
  );

  const outcome = detectKimiSdkModels(home);
  assert.equal(outcome.kind, "live");
  if (outcome.kind !== "live") assert.fail("expected live model source");
  assert.deepEqual(outcome.value.models, [
    {
      id: "kimi-code/k3",
      label: "Kimi K3",
      verified: "launchable",
      supportedReasoningEfforts: ["max", "ultra"],
      defaultReasoningEffort: "max",
    },
    {
      id: "kimi-code/no-effort-metadata",
      label: "Kimi without metadata",
      verified: "launchable",
    },
  ]);
});

test("detectKimiSdkModels returns missing_config when <kimiHome>/config.toml is missing", () => {
  const home = path.join(os.tmpdir(), `kimi-detect-empty-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  // No config.toml written.
  assert.deepEqual(detectKimiSdkModels(home), { kind: "missing_config", recovery: "kimi_login" });
});

// ── tracing — production-observability of why detection landed where it did ──
//
// Per Hao's review on PR #3004 and tygg's "记得加好tracing" directive
// (#proj-runtime:0b291474 msg=5eb62c49). The four `outcome` values must let
// an oncall disambiguate "user didn't `kimi login`" / "config corrupt /
// upstream schema change" / "host fs misconfigured" / "models surfaced
// fine" without re-reading user config bytes. Pin both happy & sad paths.

function detectWithRecording(
  home: string,
): { events: { name: string; attrs?: Record<string, unknown> }[]; result: ReturnType<typeof detectKimiSdkModels> } {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("daemon.runtime_models.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: { runtime: "kimi-sdk" },
  });
  const result = detectKimiSdkModels(home, { tracer, span });
  span.end("ok", {});
  // Pull the events recorded on our parent span.
  const completed = sink.getAllSpans().find((s) => s.name === "daemon.runtime_models.detect");
  return {
    events: (completed?.events ?? []).map((e) => ({ name: e.name, attrs: e.attrs })),
    result,
  };
}

test("detectKimiSdkModels emits a single daemon.kimi_sdk.models.config event with outcome=models_returned + low-cardinality counts", () => {
  const home = path.join(os.tmpdir(), `kimi-trace-ok-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  fsWriteFileSync(
    path.join(home, "config.toml"),
    `default_model = "kimi-code/kimi-for-coding"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
display_name = "Kimi-k2.6"

[models."kimi-code/kimi-for-coding-next"]
provider = "managed:kimi-code"
`,
    "utf8",
  );

  const { events, result } = detectWithRecording(home);
  assert.ok(result, "models must surface");

  const detect = events.filter((e) => e.name === "daemon.kimi_sdk.models.config");
  assert.equal(detect.length, 1, "exactly one terminal detect event must be emitted");
  const attrs = detect[0].attrs ?? {};
  assert.equal(attrs.outcome, "models_returned");
  assert.equal(attrs.models_count, 2);
  assert.equal(attrs.display_name_present_count, 1);
  assert.equal(attrs.default_model_present, true);
  // Privacy contract: never leak ids/labels/default value/raw config.
  for (const key of ["model_id", "model_ids", "default_model", "config_path", "config_raw", "label", "display_name"]) {
    assert.equal(key in attrs, false, `attr "${key}" must not be present (low-cardinality + no user content)`);
  }
});

test("detectKimiSdkModels emits outcome=missing_config with errno_code=ENOENT when host hasn't run `kimi login` yet", () => {
  const home = path.join(os.tmpdir(), `kimi-trace-missing-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  // No config.toml.

  const { events, result } = detectWithRecording(home);
  assert.deepEqual(result, { kind: "missing_config", recovery: "kimi_login" });
  const detect = events.filter((e) => e.name === "daemon.kimi_sdk.models.config");
  assert.equal(detect.length, 1);
  assert.equal(detect[0].attrs?.outcome, "missing_config");
  assert.equal(detect[0].attrs?.errno_code, "ENOENT");
});

test("detectKimiSdkModels emits outcome=read_error when <kimiHome>/config.toml exists but is unreadable (e.g. is a directory, EISDIR)", () => {
  // Cheapest reliable cross-platform `readFileSync` failure that isn't
  // ENOENT: make `config.toml` a directory. macOS / Linux / Windows all
  // surface EISDIR (or equivalent) here, distinct from "missing_config".
  const home = path.join(os.tmpdir(), `kimi-trace-readerr-${randomUUID()}`);
  fsMkdirSync(path.join(home, "config.toml"), { recursive: true });

  const { events, result } = detectWithRecording(home);
  assert.deepEqual(result, { kind: "error", retryable: true });
  const detect = events.filter((e) => e.name === "daemon.kimi_sdk.models.config");
  assert.equal(detect.length, 1);
  assert.equal(detect[0].attrs?.outcome, "read_error");
  // errno_code must be present and non-ENOENT (else the implementation has
  // collapsed read_error back into missing_config).
  assert.ok(detect[0].attrs?.errno_code, "errno_code must be set on read_error");
  assert.notEqual(detect[0].attrs?.errno_code, "ENOENT");
});

test("detectKimiSdkModels emits outcome=no_models when config exists but has zero [models.*] entries (login completed without grant)", () => {
  const home = path.join(os.tmpdir(), `kimi-trace-empty-${randomUUID()}`);
  fsMkdirSync(home, { recursive: true });
  fsWriteFileSync(
    path.join(home, "config.toml"),
    `default_model = ""

[providers."managed:kimi-code"]
type = "kimi"
`,
    "utf8",
  );

  const { events, result } = detectWithRecording(home);
  assert.deepEqual(result, { kind: "no_models", recovery: "kimi_login" });
  const detect = events.filter((e) => e.name === "daemon.kimi_sdk.models.config");
  assert.equal(detect.length, 1);
  assert.equal(detect[0].attrs?.outcome, "no_models");
});

test("KimiSdkDriver.encodeStdinMessage returns null (SDK doesn't deliver via stdin encoding)", () => {
  const driver = new KimiSdkDriver();
  assert.equal(driver.encodeStdinMessage("hello", null), null);
  assert.equal(driver.encodeStdinMessage("hello", "session-1", { mode: "idle" }), null);
});

// ── standing prompt delivered via native roleAdditional (survives compaction) ──
//
// Regression pin for the compaction bug: the Raft standing prompt + wrapper CLI
// note MUST ride the Kimi SDK's `roleAdditional` session option (rendered into
// the base system prompt every request, outside compressible history) instead
// of being prepended to the first user turn (condensed away by compaction).

const WRAPPER_PATH = "/tmp/kimi-wrappers/agent-1/raft";

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeTempCtx(overrides: Partial<SpawnContext["config"]> = {}): {
  ctx: SpawnContext;
  home: string;
} {
  const base = makeSpawnContext(overrides);
  const root = path.join(os.tmpdir(), `kimi-role-${randomUUID()}`);
  const home = path.join(root, "home");
  fsMkdirSync(home, { recursive: true });
  return { ctx: { ...base, workingDirectory: path.join(root, "work") }, home };
}

function makeCapturingHarness(): {
  harness: KimiHarness;
  createCalls: Array<Record<string, unknown>>;
  resumeCalls: Array<Record<string, unknown>>;
} {
  const createCalls: Array<Record<string, unknown>> = [];
  const resumeCalls: Array<Record<string, unknown>> = [];
  const fakeSession = { id: "kimi-session-x" } as unknown as KimiSession;
  const harness = {
    createSession: async (fields: Record<string, unknown>) => {
      createCalls.push(fields);
      return fakeSession;
    },
    resumeSession: async (fields: Record<string, unknown>) => {
      resumeCalls.push(fields);
      return fakeSession;
    },
  } as unknown as KimiHarness;
  return { harness, createCalls, resumeCalls };
}

function makeFakeLocalKaos(): {
  localKaos: LocalKaos;
  toolKaos: LocalKaos;
  capturedEnv: Record<string, string>;
} {
  const capturedEnv: Record<string, string> = {};
  const toolKaos = {
    name: "fake-tool-kaos",
    osEnv: { platform: process.platform, shell: "/bin/bash" },
    pathClass: () => (process.platform === "win32" ? "win32" : "posix"),
    normpath: (p: string) => p,
    gethome: () => "/tmp/fake-home",
    getcwd: () => "/tmp/fake-cwd",
    chdir: async () => {},
    withCwd: () => toolKaos,
    withEnv: (env: Record<string, string>) => {
      Object.assign(capturedEnv, env);
      return toolKaos;
    },
    stat: async () => { throw new Error("not implemented"); },
    iterdir: async function* () {},
    glob: async function* () {},
    readBytes: async () => Buffer.alloc(0),
    readText: async () => "",
    readLines: async function* () {},
    writeBytes: async () => 0,
    writeText: async () => 0,
    mkdir: async () => {},
    exec: async () => { throw new Error("not implemented"); },
    execWithEnv: async () => { throw new Error("not implemented"); },
  } as unknown as LocalKaos;
  const localKaos = {
    name: "fake-local-kaos",
    osEnv: { platform: process.platform, shell: "/bin/bash" },
    pathClass: () => (process.platform === "win32" ? "win32" : "posix"),
    normpath: (p: string) => p,
    gethome: () => "/tmp/fake-home",
    getcwd: () => "/tmp/fake-cwd",
    chdir: async () => {},
    withCwd: () => localKaos,
    withEnv: (env: Record<string, string>) => {
      Object.assign(capturedEnv, env);
      return toolKaos;
    },
    stat: async () => { throw new Error("not implemented"); },
    iterdir: async function* () {},
    glob: async function* () {},
    readBytes: async () => Buffer.alloc(0),
    readText: async () => "",
    readLines: async function* () {},
    writeBytes: async () => 0,
    writeText: async () => 0,
    mkdir: async () => {},
    exec: async () => { throw new Error("not implemented"); },
    execWithEnv: async () => { throw new Error("not implemented"); },
  } as unknown as LocalKaos;
  return { localKaos, toolKaos, capturedEnv };
}

function makeFakeDeps(
  home: string,
  harness: KimiHarness,
  createHarnessCalls: Array<Record<string, unknown>> = [],
  slockDir: string = "/tmp/kimi-wrappers/agent-1",
  slockHome: string = "/tmp/kimi-slock-home",
) {
  const { localKaos, toolKaos, capturedEnv } = makeFakeLocalKaos();
  return {
    createHarness: ((options: Record<string, unknown>) => {
      createHarnessCalls.push(options);
      return harness;
    }) as never,
    prepareTransport: (async () => ({
      spawnEnv: { KIMI_CODE_HOME: home, NO_COLOR: "1" },
      wrapperPath: WRAPPER_PATH,
      slockDir,
      slockHome,
    })) as never,
    createLocalKaos: async () => localKaos,
    _fakeToolKaos: toolKaos,
    _capturedEnv: capturedEnv,
  };
}

test("composeStandingRoleAdditional carries only the standing prompt; wrapper path note is removed", () => {
  const combined = composeStandingRoleAdditional("standing instructions", WRAPPER_PATH);
  assert.equal(combined, "standing instructions");
  assert.ok(!combined.includes(WRAPPER_PATH), "must NOT surface the wrapper absolute path in roleAdditional");
  assert.ok(!combined.includes("CLI invocation note"), "must NOT contain the wrapper CLI note");

  assert.equal(composeStandingRoleAdditional(undefined, null), "");
  assert.equal(composeStandingRoleAdditional("only standing", null), "only standing");
});

test("createKimiAgentSessionForContext passes standing prompt + per-session tool Kaos on CREATE path", async () => {
  const { ctx, home } = makeTempCtx({ sessionId: null });
  const { harness, createCalls, resumeCalls } = makeCapturingHarness();
  const slockDir = "/tmp/kimi-wrappers/agent-1/w2-launch";
  const slockHome = "/tmp/kimi-slock-home";
  const deps = makeFakeDeps(home, harness, [], slockDir, slockHome);

  await createKimiAgentSessionForContext(ctx, "sess-create", deps);

  assert.equal(resumeCalls.length, 0, "no prior sessionId → must not resume");
  assert.equal(createCalls.length, 1, "must create exactly one session");
  const fields = createCalls[0];
  assert.equal(typeof fields.roleAdditional, "string", "roleAdditional must be passed as a session option");
  const roleAdditional = fields.roleAdditional as string;
  assert.ok(roleAdditional.includes(ctx.standingPrompt), "roleAdditional must carry the standing prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "roleAdditional must NOT carry the wrapper CLI note");
  assert.equal(fields.workDir, ctx.workingDirectory);

  // The SDK bash tool must receive a dedicated tool Kaos with per-session env,
  // while file/session persistence stays on a plain LocalKaos.
  assert.equal(fields.kaos, deps._fakeToolKaos, "createSession must receive the per-session tool Kaos");
  assert.ok(fields.persistenceKaos, "createSession must receive a persistence Kaos");
  assert.notEqual(fields.kaos, fields.persistenceKaos, "tool Kaos and persistence Kaos must be distinct");
  assert.equal(deps._capturedEnv.NO_COLOR, "1");
  assert.equal(deps._capturedEnv.SLOCK_HOME, slockHome);
  assert.equal(deps._capturedEnv.SLOCK_AGENT_LAUNCH_DIR, path.basename(slockDir));
  assert.ok(deps._capturedEnv.PATH?.startsWith(slockDir), "tool Kaos PATH must be prepended with slockDir");
  assert.deepEqual(
    Object.keys(deps._capturedEnv).sort(),
    ["NO_COLOR", "PATH", "SLOCK_AGENT_LAUNCH_DIR", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME"].sort(),
    "tool Kaos env must contain only the allowed per-session keys",
  );
});

test("createKimiAgentSessionForContext passes standing prompt + per-session tool Kaos on RESUME path", async () => {
  const { ctx, home } = makeTempCtx({ sessionId: "resume-me" });
  const { harness, createCalls, resumeCalls } = makeCapturingHarness();
  const slockDir = "/tmp/kimi-wrappers/agent-1/w2-launch";
  const slockHome = "/tmp/kimi-slock-home";
  const deps = makeFakeDeps(home, harness, [], slockDir, slockHome);

  await createKimiAgentSessionForContext(ctx, "resume-me", deps);

  assert.equal(createCalls.length, 0, "prior sessionId → resume, not create");
  assert.equal(resumeCalls.length, 1, "must resume exactly one session");
  const fields = resumeCalls[0];
  assert.equal(fields.id, "resume-me", "resume must target the persisted session id");
  assert.equal(typeof fields.roleAdditional, "string", "roleAdditional must be re-applied on resume");
  const roleAdditional = fields.roleAdditional as string;
  assert.ok(roleAdditional.includes(ctx.standingPrompt), "resume roleAdditional must carry the standing prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "resume roleAdditional must NOT carry the wrapper CLI note");

  assert.equal(fields.kaos, deps._fakeToolKaos, "resumeSession must receive the per-session tool Kaos");
  assert.ok(fields.persistenceKaos, "resumeSession must receive a persistence Kaos");
  assert.notEqual(fields.kaos, fields.persistenceKaos, "tool Kaos and persistence Kaos must be distinct");
  assert.equal(deps._capturedEnv.SLOCK_AGENT_LAUNCH_DIR, path.basename(slockDir));
  assert.deepEqual(
    Object.keys(deps._capturedEnv).sort(),
    ["NO_COLOR", "PATH", "SLOCK_AGENT_LAUNCH_DIR", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME"].sort(),
    "tool Kaos env must contain only the allowed per-session keys on resume",
  );
});

test("createKimiAgentSessionForContext applies schema-selected effort on fresh create and persisted resume", async () => {
  const fresh = makeTempCtx({ sessionId: null, reasoningEffort: "max" });
  const freshHarness = makeCapturingHarness();
  await createKimiAgentSessionForContext(
    fresh.ctx,
    "fresh-effort",
    makeFakeDeps(fresh.home, freshHarness.harness),
  );
  assert.equal(freshHarness.createCalls[0]?.thinking, "max");

  const resumed = makeTempCtx({ sessionId: "resume-effort", reasoningEffort: "ultra" });
  const resumeCalls: Array<Record<string, unknown>> = [];
  const setThinkingCalls: string[] = [];
  const resumedSession = {
    id: "resume-effort",
    setThinking: async (effort: string) => { setThinkingCalls.push(effort); },
  } as unknown as KimiSession;
  const harness = {
    createSession: async () => { throw new Error("must not create"); },
    resumeSession: async (fields: Record<string, unknown>) => {
      resumeCalls.push(fields);
      return resumedSession;
    },
  } as unknown as KimiHarness;
  await createKimiAgentSessionForContext(
    resumed.ctx,
    "resume-effort",
    makeFakeDeps(resumed.home, harness),
  );
  assert.equal("thinking" in resumeCalls[0]!, false, "resume options do not own persisted thinking");
  assert.deepEqual(setThinkingCalls, ["ultra"], "resume must apply effort before returning the session");
});

test("createKimiAgentSessionForContext applies the current model before the first turn of a resumed session", async () => {
  const resumed = makeTempCtx({
    sessionId: "resume-old-model",
    model: "kimi-code/k3",
  });
  let activeModel = "kimi-code/kimi-for-coding-highspeed";
  const lifecycle: string[] = [];
  const resumeCalls: Array<Record<string, unknown>> = [];
  let releaseSwitch!: () => void;
  const switchReady = new Promise<void>((resolve) => { releaseSwitch = resolve; });
  const resumedSession = {
    id: "resume-old-model",
    setModel: async (model: string) => {
      await switchReady;
      activeModel = model;
      lifecycle.push(`setModel:${model}`);
    },
    prompt: async () => {
      lifecycle.push(`prompt:${activeModel}`);
    },
  } as unknown as KimiSession;
  const harness = {
    createSession: async () => { throw new Error("must not create"); },
    // The real SDK's ResumeSessionInput does not own `model`; emulate that
    // contract by returning the persisted session with its old model intact.
    resumeSession: async (fields: Record<string, unknown>) => {
      resumeCalls.push(fields);
      return resumedSession;
    },
  } as unknown as KimiHarness;

  let returned = false;
  const pending = createKimiAgentSessionForContext(
    resumed.ctx,
    "resume-old-model",
    makeFakeDeps(resumed.home, harness),
  ).then((result) => { returned = true; return result; });
  try {
    await flushImmediate();
    assert.equal(returned, false, "factory must not expose the session before asynchronous model switching finishes");
  } finally {
    releaseSwitch();
  }
  const result = await pending;
  await result.session.prompt("first turn after profile model change");

  assert.equal("model" in resumeCalls[0]!, false, "resume input must not carry an unsupported model field");
  assert.deepEqual(
    lifecycle,
    ["setModel:kimi-code/k3", "prompt:kimi-code/k3"],
    "the resumed session must apply the current profile model before its first request",
  );
});

test("resumed Kimi session sends the current profile model through the real SDK HTTP transport", async () => {
  const fixture = makeTempCtx({ model: "kimi-code/k3" });
  const requests: Array<{ model: string; messages: Array<{ content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  fsWriteFileSync(path.join(fixture.home, "config.toml"), `
default_model = "kimi-code/kimi-for-coding-highspeed"
[providers.local]
type = "kimi"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-test-only"
[models."kimi-code/kimi-for-coding-highspeed"]
provider = "local"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
[models."kimi-code/k3"]
provider = "local"
model = "k3"
max_context_size = 1048576
`);
  fsMkdirSync(fixture.ctx.workingDirectory, { recursive: true });
  const seed = createKimiHarness({ homeDir: fixture.home });
  let resumedHarness: KimiHarness | undefined;
  try {
    const old = await seed.createSession({
      workDir: fixture.ctx.workingDirectory,
      model: "kimi-code/kimi-for-coding-highspeed",
    });
    const promptAndFinish = async (session: KimiSession, text: string) => {
      const finished = new Promise<void>((resolve, reject) => {
        const unsubscribe = session.onEvent((event) => {
          if (event.type === "turn.ended") { unsubscribe(); resolve(); }
          if (event.type === "error") { unsubscribe(); reject(new Error(JSON.stringify(event))); }
        });
      });
      await session.prompt(text);
      await finished;
    };
    await promptAndFinish(old, "remember the old session marker");
    assert.equal(requests[0]?.model, "kimi-for-coding-highspeed");
    const sessionId = old.id;
    fixture.ctx.config.sessionId = sessionId;
    await seed.close();

    // Only the Raft CLI-wrapper preparation is stubbed. Harness, persistence,
    // resume, model switching, prompt construction and HTTP serialization are real.
    const result = await createKimiAgentSessionForContext(fixture.ctx, sessionId, {
      prepareTransport: makeFakeDeps(fixture.home, seed).prepareTransport,
    });
    resumedHarness = result.harness;
    assert.equal(result.session.id, sessionId, "must preserve the old session, not silently create a new one");
    await promptAndFinish(result.session, "first turn after profile model change");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.model, "k3", "first real resumed HTTP request must use the current profile model");
    assert.ok(JSON.stringify(requests[1]?.messages).includes("remember the old session marker"), "resumed request must retain old conversation context");
  } finally {
    await resumedHarness?.close();
    await seed.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(path.dirname(fixture.home), { recursive: true, force: true });
  }
}, 15000);

// Product tooth for persisted-session roleAdditional refresh: after a daemon
// Stop→Start, the resumed Kimi SDK session must receive the *fresh* standing
// roleAdditional (W2) before its first turn, and the first turn text must
// remain only the user's message.
test("KimiSdkRuntimeSession resumes with the fresh roleAdditional after Stop→Start, keeping the first turn text clean", async () => {
  const sessionId = "sess-resume-roleadditional-refresh";
  const workingDirectory = path.join(os.tmpdir(), `kimi-resume-${randomUUID()}`);
  fsMkdirSync(workingDirectory, { recursive: true });
  const home = path.join(workingDirectory, "home");
  fsMkdirSync(home, { recursive: true });

  function makeCtx(standingPrompt: string): SpawnContext {
    return {
      ...makeSpawnContext({ sessionId }),
      workingDirectory,
      standingPrompt,
    };
  }

  function makeRuntime(standingPrompt: string, slockDir: string) {
    const { harness, createCalls, resumeCalls } = makeCapturingHarness();
    const promptCalls: string[] = [];
    const fakeSession = {
      id: sessionId,
      setApprovalHandler() {},
      onEvent() {
        return () => {};
      },
      prompt(text: string) {
        promptCalls.push(text);
        return Promise.resolve();
      },
      steer() {
        return Promise.resolve();
      },
      cancel() {
        return Promise.resolve();
      },
    } as unknown as KimiSession;
    const harnessWithSession = {
      ...harness,
      createSession: async (fields: Record<string, unknown>) => {
        createCalls.push(fields);
        return fakeSession;
      },
      resumeSession: async (fields: Record<string, unknown>) => {
        resumeCalls.push(fields);
        return fakeSession;
      },
    } as unknown as KimiHarness;
    const factory: KimiSessionFactory = async (ctx, sid) => {
      const result = await createKimiAgentSessionForContext(
        ctx,
        sid,
        makeFakeDeps(home, harnessWithSession, [], slockDir, path.dirname(path.dirname(path.dirname(slockDir)))),
      );
      return { harness: result.harness, session: fakeSession, wrapperPath: result.wrapperPath };
    };
    return { factory, createCalls, resumeCalls, promptCalls };
  }

  // First launch: standing prompt W1.
  const w1SlockDir = path.join(workingDirectory, "cli-transport", "agent", "w1-launch");
  const ctx1 = makeCtx("standing prompt W1");
  const { factory: factory1 } = makeRuntime("standing prompt W1", w1SlockDir);
  const runtime1 = new KimiSdkRuntimeSession(ctx1, () => {}, factory1);
  const start1 = await runtime1.start({ text: "first turn" });
  assert.equal(start1.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime1.stop();

  // Daemon restart: standing prompt changed to W2 with a fresh launch dir.
  const w2SlockDir = path.join(workingDirectory, "cli-transport", "agent", "w2-launch");
  const ctx2 = makeCtx("standing prompt W2");
  const { factory: factory2, createCalls: createCalls2, resumeCalls: resumeCalls2, promptCalls: promptCalls2 } = makeRuntime("standing prompt W2", w2SlockDir);
  const runtime2 = new KimiSdkRuntimeSession(ctx2, () => {}, factory2);
  const start2 = await runtime2.start({ text: "second turn" });
  assert.equal(start2.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime2.dispose();

  // The second launch must resume the persisted session, not create a new one.
  assert.equal(createCalls2.length, 0, "Stop→Start must resume the persisted session");
  assert.equal(resumeCalls2.length, 1, "must call resumeSession exactly once after restart");
  const resumedFields = resumeCalls2[0];
  assert.equal(resumedFields.id, sessionId, "resume must target the same session id");
  const roleAdditional = resumedFields.roleAdditional as string;
  assert.ok(roleAdditional.includes("standing prompt W2"), "resumed roleAdditional must carry the fresh standing prompt W2");
  assert.ok(!roleAdditional.includes("standing prompt W1"), "resumed roleAdditional must not carry the stale W1 prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "resumed roleAdditional must NOT carry the wrapper CLI note");

  // Resume must receive the W2 tool Kaos so the model's first CLI call resolves
  // to the current launch's wrapper, not a stale W1 absolute path.
  assert.equal((resumedFields.kaos as { name: string }).name, "fake-tool-kaos");

  // The first turn after resume must contain only the user's text.
  assert.equal(promptCalls2.length, 1, "first resumed turn must issue exactly one prompt");
  assert.equal(promptCalls2[0], "second turn", "first resumed turn must be only the user's text");
  assert.ok(!promptCalls2[0].includes("standing prompt"), "first resumed turn must NOT contain the standing prompt");
});

test("createKimiAgentSessionForContext passes the launch-scoped remote MCP server on create and resume", async () => {
  const mcpServerId = "22222222-2222-4222-8222-222222222222";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    catalogVersion: 1,
    tools: [{
      mcpServerId,
      serverName: "Private Docs",
      toolName: "search",
      runtimeName: "mcp_private_search",
      description: "Search private docs",
      inputSchema: { type: "object" },
      configVersion: 1,
      assignmentVersion: 1,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const configureManagedMcp = (ctx: SpawnContext) => {
    ctx.launchId = "launch-managed";
    ctx.config.agentCredentialKey = "sk_agent_test";
  };

  try {
    const createFixture = makeTempCtx({ sessionId: null });
    configureManagedMcp(createFixture.ctx);
    const createHarness = makeCapturingHarness();
    await createKimiAgentSessionForContext(
      createFixture.ctx,
      "managed-create",
      makeFakeDeps(createFixture.home, createHarness.harness),
    );
    const createServers = createHarness.createCalls[0]?.mcpServers as Record<string, {
      transport: string;
      url: string;
    }>;
    const [createName] = Object.keys(createServers);
    assert.match(createName!, /^rm[a-zA-Z0-9]{6}$/);
    assert.equal(createServers[createName!]!.transport, "http");
    assert.match(createServers[createName!]!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(JSON.stringify(createServers), /private\.example\.test/);

    const resumeFixture = makeTempCtx({ sessionId: "resume-managed" });
    configureManagedMcp(resumeFixture.ctx);
    const resumeHarness = makeCapturingHarness();
    await createKimiAgentSessionForContext(
      resumeFixture.ctx,
      "resume-managed",
      makeFakeDeps(resumeFixture.home, resumeHarness.harness),
    );
    const resumeServers = resumeHarness.resumeCalls[0]?.mcpServers as Record<string, {
      transport: string;
      url: string;
    }>;
    const [resumeName] = Object.keys(resumeServers);
    assert.equal(resumeServers[resumeName!]!.transport, "http");
    assert.match(resumeServers[resumeName!]!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
  } finally {
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("createKimiAgentSessionForContext launches K3 from the same KIMI_CODE_HOME used for model detection", async () => {
  const { ctx, home } = makeTempCtx({ model: "kimi-code/k3" });
  fsWriteFileSync(
    path.join(home, "config.toml"),
    `default_model = "kimi-code/k3"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "Kimi K3"
max_context_size = 1048576
support_efforts = ["max"]
default_effort = "max"
protocol = "anthropic"
`,
    "utf8",
  );
  const detected = detectKimiSdkModels(home);
  assert.equal(detected.kind, "live");
  if (detected.kind !== "live") assert.fail("expected live K3 model source");
  assert.equal(detected.value.default, "kimi-code/k3");
  assert.deepEqual(detected.value.models, [
    {
      id: "kimi-code/k3",
      label: "Kimi K3",
      verified: "launchable",
      supportedReasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
    },
  ]);

  const { harness, createCalls } = makeCapturingHarness();
  const createHarnessCalls: Array<Record<string, unknown>> = [];
  await createKimiAgentSessionForContext(
    ctx,
    "sess-k3",
    makeFakeDeps(home, harness, createHarnessCalls),
  );

  assert.equal(createHarnessCalls.length, 1);
  assert.equal(createHarnessCalls[0]?.homeDir, home);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0]?.model, "kimi-code/k3");
});

test("KimiSdkRuntimeSession.start no longer injects the standing prompt / wrapper note into the first-turn text", async () => {
  const promptCalls: string[] = [];
  const fakeSession = {
    id: "kimi-session-firstturn",
    setApprovalHandler() {},
    onEvent() {
      return () => {};
    },
    prompt(text: string) {
      promptCalls.push(text);
      return Promise.resolve();
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const ctx = makeSpawnContext();
  const factory = async () => ({
    harness: {} as unknown as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  });
  const runtime = new KimiSdkRuntimeSession(ctx, () => {}, factory);

  const result = await runtime.start({ text: "please do the thing" });
  assert.equal(result.ok, true);
  // Flush the setImmediate-deferred session.prompt call.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promptCalls.length, 1, "first turn must issue exactly one prompt");
  assert.equal(promptCalls[0], "please do the thing", "first-turn text must be ONLY the user's text");
  assert.ok(
    !promptCalls[0].includes(ctx.standingPrompt),
    "first-turn text must NOT contain the standing prompt (delivered via roleAdditional instead)",
  );
  assert.ok(
    !promptCalls[0].includes("CLI invocation note"),
    "first-turn text must NOT contain the wrapper CLI note (delivered via roleAdditional instead)",
  );

  await runtime.dispose();
});

test("KimiSdkRuntimeSession defers SDK logical turn.ended until active goal continuation clears", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const promptCalls: string[] = [];
  const steerCalls: string[] = [];
  const fakeSession = {
    id: "kimi-session-active",
    getGoal() {
      return Promise.resolve({ goal: null });
    },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt(text: string) {
      promptCalls.push(text);
      return Promise.resolve();
    },
    steer(text: string) {
      steerCalls.push(text);
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  const result = await runtime.start({ text: "start" });
  assert.equal(result.ok, true);
  await flushImmediate();
  assert.equal(promptCalls.length, 1);
  assert.ok(eventListener, "runtime must register the SDK event callback");
  const emitSdkEvent = eventListener as unknown as (event: KimiSdkEvent) => void;
  runtimeEvents.length = 0;

  emitSdkEvent({
    ...eventBase(),
    type: "goal.updated",
    snapshot: activeGoalSnapshot(),
  });
  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" });
  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 2, reason: "completed" });
  assert.deepEqual(
    runtimeEvents,
    [],
    "logical SDK turn.ended alone must not prove daemon prompt-idle while the SDK goal driver remains active",
  );

  const duringActiveGoal = runtime.send({ mode: "idle", text: "queued during active goal" });
  assert.deepEqual(duringActiveGoal, { ok: true, acceptedAs: "steer" });
  await flushImmediate();
  assert.deepEqual(promptCalls, ["start"], "active goal continuation must not receive a second prompt");
  assert.deepEqual(steerCalls, ["queued during active goal"]);

  emitSdkEvent({ ...eventBase(), type: "goal.updated", snapshot: null });
  assert.deepEqual(
    runtimeEvents,
    [{ kind: "turn_end", sessionId: "kimi-session-active" }],
    "multiple logical turn.ended events during one active goal run coalesce into one daemon turn_end after goal clear",
  );

  const followUp = runtime.send({ mode: "idle", text: "queued after native idle" });
  assert.deepEqual(followUp, { ok: true, acceptedAs: "prompt" });
  await flushImmediate();
  assert.deepEqual(
    promptCalls,
    ["start", "queued after native idle"],
    "queued work becomes exactly one prompt after the goal-idle boundary",
  );
  await flushImmediate();

  await runtime.dispose();
});

test("KimiSdkRuntimeSession steers an idle delivery after prompt RPC resolves while goal remains active", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const promptCalls: string[] = [];
  const steerCalls: string[] = [];
  const fakeSession = {
    id: "kimi-session-steer-fallback",
    getGoal() {
      return Promise.resolve({ goal: null });
    },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt(text: string) {
      promptCalls.push(text);
      return Promise.resolve();
    },
    steer(text: string) {
      steerCalls.push(text);
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));

  const start = await runtime.start({ text: "start" });
  assert.equal(start.ok, true);
  await flushImmediate();
  assert.equal(promptCalls.length, 1);
  assert.ok(eventListener, "runtime must register the SDK event callback");
  const emitSdkEvent = eventListener as unknown as (event: KimiSdkEvent) => void;

  emitSdkEvent({
    ...eventBase(),
    type: "goal.updated",
    snapshot: activeGoalSnapshot(),
  });

  const delivery = runtime.send({ mode: "idle", text: "queued while active" });
  assert.deepEqual(delivery, { ok: true, acceptedAs: "steer" });
  await flushImmediate();

  assert.deepEqual(promptCalls, ["start"], "active goal run must not receive a second prompt");
  assert.deepEqual(steerCalls, ["queued while active"], "active goal run receives the follow-up as steer");

  await runtime.dispose();
});

test("KimiSdkRuntimeSession keeps pending goal idle closed until the final continuation turn ends", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const promptCalls: string[] = [];
  const steerCalls: string[] = [];
  const fakeSession = {
    id: "kimi-session-final-continuation",
    getGoal() {
      return Promise.resolve({ goal: null });
    },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt(text: string) {
      promptCalls.push(text);
      return Promise.resolve();
    },
    steer(text: string) {
      steerCalls.push(text);
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  const start = await runtime.start({ text: "start" });
  assert.equal(start.ok, true);
  await flushImmediate();
  assert.ok(eventListener, "runtime must register the SDK event callback");
  const emitSdkEvent = eventListener as unknown as (event: KimiSdkEvent) => void;
  runtimeEvents.length = 0;

  emitSdkEvent({ ...eventBase(), type: "goal.updated", snapshot: activeGoalSnapshot() });
  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" });
  assert.deepEqual(runtimeEvents, [], "active goal turn_end must remain pending while goal continuation is live");

  emitSdkEvent({ ...eventBase(), type: "turn.started", turnId: 2, origin: "user" as never });
  emitSdkEvent({ ...eventBase(), type: "goal.updated", snapshot: null });
  assert.deepEqual(
    runtimeEvents,
    [],
    "goal clear before final logical turn_end must not reopen daemon prompt-idle",
  );

  const duringFinalTurn = runtime.send({ mode: "idle", text: "queued before final turn_end" });
  assert.deepEqual(duringFinalTurn, { ok: true, acceptedAs: "steer" });
  await flushImmediate();
  assert.deepEqual(promptCalls, ["start"]);
  assert.deepEqual(steerCalls, ["queued before final turn_end"]);

  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 2, reason: "completed" });
  assert.deepEqual(runtimeEvents, [{ kind: "turn_end", sessionId: "kimi-session-final-continuation" }]);

  const followUp = runtime.send({ mode: "idle", text: "queued after final turn_end" });
  assert.deepEqual(followUp, { ok: true, acceptedAs: "prompt" });
  await flushImmediate();
  assert.deepEqual(promptCalls, ["start", "queued after final turn_end"]);

  await runtime.dispose();
});

test("KimiSdkRuntimeSession maps real SDK turn.agent_busy error event to delivery_error", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const promptCalls: string[] = [];
  const fakeSession = {
    id: "kimi-session-delivery-error",
    getGoal() {
      return Promise.resolve({ goal: null });
    },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt(text: string) {
      promptCalls.push(text);
      if (text !== "start") {
        eventListener?.({
          ...eventBase(),
          type: "error",
          code: "turn.agent_busy",
          message: "Cannot launch a new turn while another turn (ID 257) is active",
          retryable: false,
        });
      }
      return Promise.resolve();
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  const start = await runtime.start({ text: "start" });
  assert.equal(start.ok, true);
  await flushImmediate();
  await flushImmediate();
  assert.ok(eventListener, "runtime must register the SDK event callback");
  const emitSdkEvent = eventListener as unknown as (event: KimiSdkEvent) => void;
  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" });
  runtimeEvents.length = 0;

  const delivery = runtime.send({ mode: "idle", text: "follow-up after daemon thought idle" });
  assert.deepEqual(delivery, { ok: true, acceptedAs: "prompt" });
  await flushImmediate();
  await flushImmediate();

  assert.equal(promptCalls.length, 2);
  assert.deepEqual(runtimeEvents, [{
    kind: "delivery_error",
    message: "Cannot launch a new turn while another turn (ID 257) is active",
    requestMethod: "turn/start",
    source: "kimi_sdk_response",
    code: "turn.agent_busy",
    payloadBytes: Buffer.byteLength("follow-up after daemon thought idle", "utf8"),
  }]);

  await runtime.dispose();
});

test("KimiSdkRuntimeSession does not misattribute stale SDK busy errors after turn.started", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const fakeSession = {
    id: "kimi-session-started-error",
    getGoal() {
      return Promise.resolve({ goal: null });
    },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      return Promise.resolve();
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  const start = await runtime.start({ text: "start" });
  assert.equal(start.ok, true);
  await flushImmediate();
  await flushImmediate();
  assert.ok(eventListener, "runtime must register the SDK event callback");
  const emitSdkEvent = eventListener as unknown as (event: KimiSdkEvent) => void;
  emitSdkEvent({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" });
  runtimeEvents.length = 0;

  const delivery = runtime.send({ mode: "idle", text: "follow-up that starts successfully" });
  assert.deepEqual(delivery, { ok: true, acceptedAs: "prompt" });
  await flushImmediate();
  emitSdkEvent({ ...eventBase(), type: "turn.started", turnId: 2, origin: "user" as never });
  emitSdkEvent({
    ...eventBase(),
    type: "error",
    code: "turn.agent_busy",
    message: "Cannot launch a new turn while another turn (ID 258) is active",
    retryable: false,
  });

  assert.equal(
    runtimeEvents.some((event) => event.kind === "delivery_error"),
    false,
    "turn.started clears the delivery-attempt attribution before later SDK error events",
  );
  assert.deepEqual(runtimeEvents, [{
    kind: "error",
    message: "Cannot launch a new turn while another turn (ID 258) is active",
  }]);

  await runtime.dispose();
});

test("KimiSdkRuntimeSession callback safely drops new 0.26 prompt lifecycle events", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const fakeSession = {
    id: "kimi-session-events",
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      return Promise.resolve();
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      return Promise.resolve();
    },
  } as unknown as KimiSession;

  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({
    harness: {} as KimiHarness,
    session: fakeSession,
    wrapperPath: WRAPPER_PATH,
  }));
  const runtimeEvents: ParsedEvent[] = [];
  const stderr: string[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));
  runtime.on("stderr", (line) => stderr.push(line));

  await runtime.start({ text: "start" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(eventListener, "runtime must register the SDK event callback");
  runtimeEvents.length = 0;

  assert.doesNotThrow(() => {
    eventListener!({
      ...eventBase(),
      type: "prompt.completed",
      promptId: "prompt-1",
      finishedAt: "2026-07-17T00:00:01Z",
      reason: "completed",
    });
    eventListener!({
      ...eventBase(),
      type: "prompt.steered",
      activePromptId: "prompt-1",
      promptIds: ["prompt-2"],
      content: [],
      steeredAt: "2026-07-17T00:00:02Z",
    });
  });
  assert.deepEqual(runtimeEvents, [], "prompt lifecycle events are explicit drops, not ParsedEvents");

  assert.doesNotThrow(() => {
    (eventListener as unknown as (event: unknown) => void)({
      ...eventBase(),
      type: "future.sdk.event",
    });
  });
  assert.deepEqual(runtimeEvents, [], "unknown future events must not escape as a fake iterable");
  assert.deepEqual(stderr, []);

  await runtime.dispose();
});

// ── LocalKaos per-session PATH tooth ───────────────────────────────────────
//
// The Kimi SDK bash tool receives a dedicated tool Kaos whose PATH is prepended
// with the current launch's wrapper directory. This test proves that a real
// LocalKaos process resolves the bare `raft` command to that wrapper, so the
// model never needs an absolute wrapper path in its prompt.

test("LocalKaos per-session PATH resolves bare `raft` to the current launch wrapper", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kimi-kaos-path-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(tmp, "home");
  try {
    const ctx = makeSpawnContext();
    ctx.workingDirectory = tmp;
    const { slockDir } = await prepareCliTransport(ctx, { NO_COLOR: "1" });

    const localKaos = await LocalKaos.create();
    const toolKaos = localKaos.withEnv({
      PATH: `${slockDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    const proc = await toolKaos.exec("sh", "-c", "command -v raft");
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    const out = Buffer.concat(chunks).toString("utf8").trim();
    await proc.wait();
    await proc.dispose();

    assert.equal(out, path.join(slockDir, "raft"), "command -v raft must resolve to the current launch's raft wrapper");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
