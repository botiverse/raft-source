import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { execFileSync } from "node:child_process";
import { mkdirSync as fsMkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { kimiToolResultOutcome } from "./kimiToolResult";
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
  loadKimiSdk,
  kimiEventIsShownForMainAgent,
  kimiToolBaseEnv,
  mapKimiSdkEventToParsedEvents,
  mapKimiSubagentEvent,
  resolveKimiHome,
  setKimiSdkEventMappingSession,
  typedKimiStartError,
  type KimiSessionFactory,
} from "./kimi-sdk";
import { classifySpawnFailure } from "../spawnFailureClassification";
import { prepareCliTransport } from "./cliTransport";
import { resolveKimiSdkHomeFromConfig } from "./runtimeArtifacts";
import {
  KimiError,
  createKimiHarness,
  resolveKimiHome as sdkResolveKimiHome,
  type Event as KimiSdkEvent,
  type GoalSnapshot,
  type KimiHarness,
  type Session as KimiSession,
} from "@botiverse/kimi-code-sdk";
import type { ParsedEvent, SpawnContext } from "./types";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { __resetManagedMcpRuntimeProxyForTest } from "../managedMcpRuntimeProxy";
import {
  KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV,
  KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV,
} from "./kimiRequestDiagnostics";

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
  assert.deepEqual(state, {
    sessionId: "kimi-session-1",
    sessionAnnounced: false,
    seenUsageSteps: new Set(),
    usageIdentityOmissionObserved: false,
  });

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

test("turn.step.completed maps SDK per-generation usage without conflating missing fields with zero", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;

  const present = mapKimiSdkEventToParsedEvents({
    ...eventBase(),
    type: "turn.step.completed",
    turnId: 7,
    step: 2,
    stepId: "step-7-2",
    usage: {
      inputOther: 120,
      output: 0,
      inputCacheRead: 30,
      inputCacheCreation: 4,
    },
  }, state);
  assert.deepEqual(present, [{
    kind: "telemetry",
    name: "token_usage",
    source: "kimi_turn_step_completed_usage",
    usageKind: "per_generation",
    sessionId: "kimi-session-1",
    turnId: "7",
    runtimeResultId: "kimi-session-1:step:step-7-2",
    attrs: {
      input_tokens: 120,
      output_tokens: 0,
      cached_read_tokens: 30,
      cache_write_tokens: 4,
      total_tokens: 154,
    },
  }]);

  const missing = mapKimiSdkEventToParsedEvents({
    ...eventBase(),
    type: "turn.step.completed",
    turnId: 7,
    step: 3,
    stepId: "step-7-3",
  }, state);
  assert.deepEqual(missing, [], "absent usage must not become a zero-valued report");

  const partial = mapKimiSdkEventToParsedEvents({
    ...eventBase(),
    type: "turn.step.completed",
    turnId: 7,
    step: 4,
    stepId: "step-7-4",
    usage: { output: 5 } as never,
  }, state);
  assert.deepEqual(partial, [{
    kind: "telemetry",
    name: "token_usage",
    source: "kimi_turn_step_completed_usage",
    usageKind: "per_generation",
    sessionId: "kimi-session-1",
    turnId: "7",
    runtimeResultId: "kimi-session-1:step:step-7-4",
    attrs: { output_tokens: 5 },
  }], "a missing counter must remain absent and must not be folded into total_tokens");
});

test("Kimi usage de-duplicates repeated completions, ignores retry metadata, and scopes identities to the session", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;
  const completion = {
    ...eventBase(),
    type: "turn.step.completed" as const,
    turnId: 9,
    step: 1,
    stepId: "stable-step-id",
    usage: {
      inputOther: 10,
      output: 2,
      inputCacheRead: 1,
      inputCacheCreation: 0,
    },
  };

  const firstStep = mapKimiSdkEventToParsedEvents(completion, state);
  assert.equal(firstStep.filter((event) => event.kind === "telemetry").length, 1);
  assert.deepEqual(mapKimiSdkEventToParsedEvents(completion, state), [], "the same completed step must report once");
  const secondStep = mapKimiSdkEventToParsedEvents({
    ...completion,
    step: 2,
    stepId: "stable-step-id-2",
    usage: {
      inputOther: 8,
      output: 3,
      inputCacheRead: 2,
      inputCacheCreation: 0,
    },
  }, state);
  assert.equal(secondStep.length, 1, "a second generation in the same logical turn must remain a distinct delta");
  const firstTotal = firstStep[0]?.kind === "telemetry" ? firstStep[0].attrs.total_tokens : undefined;
  const secondTotal = secondStep[0]?.kind === "telemetry" ? secondStep[0].attrs.total_tokens : undefined;
  assert.equal(
    Number(firstTotal) + Number(secondTotal),
    26,
    "two step deltas can be summed without cumulative double counting",
  );
  assert.deepEqual(mapKimiSdkEventToParsedEvents({
    ...eventBase(),
    type: "turn.step.retrying",
    turnId: 9,
    step: 1,
    stepId: "stable-step-id",
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 3,
    delayMs: 100,
    errorName: "RetryableError",
    errorMessage: "redacted from telemetry",
  }, state), [], "retry lifecycle metadata must not create token usage");

  setKimiSdkEventMappingSession(state, "kimi-session-2");
  const nextSession = mapKimiSdkEventToParsedEvents({ ...completion, sessionId: "kimi-session-2" }, state);
  assert.deepEqual(nextSession.map((event) => event.kind), ["session_init", "telemetry"]);
  const telemetry = nextSession.find((event) => event.kind === "telemetry");
  assert.equal(telemetry?.sessionId, "kimi-session-2");
  assert.equal(telemetry?.runtimeResultId, "kimi-session-2:step:stable-step-id");
});

test("Kimi usage fallback de-duplicates by turn+step and fails closed without a complete identity", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;
  const withoutStepId = {
    ...eventBase(),
    type: "turn.step.completed" as const,
    turnId: 11,
    step: 4,
    usage: {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    },
  };
  assert.equal(mapKimiSdkEventToParsedEvents(withoutStepId, state).filter((event) => event.kind === "telemetry").length, 1);
  assert.deepEqual(mapKimiSdkEventToParsedEvents(withoutStepId, state), []);
  assert.equal(
    mapKimiSdkEventToParsedEvents({ ...withoutStepId, step: 5 }, state).filter((event) => event.kind === "telemetry").length,
    1,
    "different fallback steps must not collapse into one identity",
  );

  assert.deepEqual(mapKimiSdkEventToParsedEvents({
    ...withoutStepId,
    turnId: undefined,
  } as unknown as KimiSdkEvent, state), [{
    kind: "telemetry",
    name: "usage_omission",
    source: "kimi_turn_step_completed_usage",
    sessionId: "kimi-session-1",
    attrs: {
      omission_reason: "missing_usage_identity",
      event_type: "turn.step.completed",
    },
  }], "missing turnId must be observable without emitting a zero usage record");
  assert.deepEqual(mapKimiSdkEventToParsedEvents({
    ...withoutStepId,
    step: undefined,
  } as unknown as KimiSdkEvent, state), [], "repeated malformed identities coalesce within the session");
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
      expected: [{ kind: "tool_call", name: "shell", input: { command: "ls" }, callId: "t1" }],
    },
    {
      event: {
        ...eventBase(),
        type: "tool.result",
        turnId: 1,
        toolCallId: "t1",
        output: "ok",
      },
      expected: [{ kind: "tool_output", name: "", callId: "t1" }],
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
    // #proj-runtime:#41: spawned / completed / failed / cancelled are mapped (see the subagent test).
    { ...eventBase(), type: "subagent.started", subagentId: "sa" },
    { ...eventBase(), type: "subagent.suspended", subagentId: "sa", reason: "x" },
    { ...eventBase(), type: "subagent.completed", subagentId: "never-spawned", resultSummary: "done" },
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

test("resolveKimiHome matches the SDK's resolver without loading the SDK", () => {
  const saved = process.env.KIMI_CODE_HOME;
  try {
    delete process.env.KIMI_CODE_HOME;
    assert.equal(resolveKimiHome(), sdkResolveKimiHome());
    assert.equal(resolveKimiHome({ KIMI_CODE_HOME: "/explicit/home" }), sdkResolveKimiHome("/explicit/home"));
    process.env.KIMI_CODE_HOME = "/env/kimi-home";
    assert.equal(resolveKimiHome(), sdkResolveKimiHome());
    assert.equal(resolveKimiHome(), "/env/kimi-home");
  } finally {
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
  }
});

// #12938 review: the home a session launches in is the home the transcript resolver reads,
// for whatever KIMI_CODE_HOME the agent and the daemon set (the spawn env merges them the same way).
test("the launch home and the transcript resolver's home agree for every KIMI_CODE_HOME", () => {
  const saved = process.env.KIMI_CODE_HOME;
  try {
    for (const daemonValue of [undefined, "/daemon/kimi"]) {
      // The daemon's own env is process.env: a launch must not fall back to it when the agent set a value.
      if (daemonValue === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = daemonValue;
      const daemonEnv = daemonValue === undefined ? {} : { KIMI_CODE_HOME: daemonValue };
      for (const agentValue of [undefined, "", "rel/kimi", "/agent/kimi"]) {
        const envVars = agentValue === undefined ? null : { KIMI_CODE_HOME: agentValue };
        const spawnEnv = { ...daemonEnv, ...(envVars ?? {}) };
        const config = { ...makeSpawnContext({ envVars }).config };
        assert.equal(
          resolveKimiHome(spawnEnv),
          resolveKimiSdkHomeFromConfig(config, os.homedir(), daemonEnv),
          `daemon ${JSON.stringify(daemonValue)}, agent ${JSON.stringify(agentValue)}`,
        );
      }
    }
    // An agent's empty value is unset: the default home, never the daemon's.
    process.env.KIMI_CODE_HOME = "/daemon/kimi";
    assert.equal(resolveKimiHome({ KIMI_CODE_HOME: "" }), path.join(os.homedir(), ".kimi-code"));
    assert.equal(resolveKimiHome({ KIMI_CODE_HOME: "rel/kimi" }), path.resolve("rel/kimi"));
  } finally {
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
  }
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
  mcpServerCalls: Array<Record<string, unknown>>;
} {
  const createCalls: Array<Record<string, unknown>> = [];
  const resumeCalls: Array<Record<string, unknown>> = [];
  const mcpServerCalls: Array<Record<string, unknown>> = [];
  // setModel: a fresh session resolves its model at start (task #1221).
  const fakeSession = {
    id: "kimi-session-x",
    setModel: async () => {},
    addMcpServer: async (server: Record<string, unknown>) => {
      mcpServerCalls.push(server);
      return server;
    },
    reloadSession: async () => ({}),
  } as unknown as KimiSession;
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
  return { harness, createCalls, resumeCalls, mcpServerCalls };
}

function makeFakeDeps(
  home: string,
  harness: KimiHarness,
  createHarnessCalls: Array<Record<string, unknown>> = [],
  slockDir: string = "/tmp/kimi-wrappers/agent-1",
  slockHome: string = "/tmp/kimi-slock-home",
  spawnEnvExtra: Record<string, string> = {},
) {
  return {
    createHarness: ((options: Record<string, unknown>) => {
      createHarnessCalls.push(options);
      return harness;
    }) as never,
    prepareTransport: (async () => ({
      spawnEnv: { KIMI_CODE_HOME: home, NO_COLOR: "1", ...spawnEnvExtra },
      wrapperPath: WRAPPER_PATH,
      slockDir,
      slockHome,
    })) as never,
    _harnessOptions: createHarnessCalls,
    /** The tool base env the harness was created with (last launch). */
    get _capturedEnv(): Record<string, string> {
      return (createHarnessCalls.at(-1)?.baseEnv ?? {}) as Record<string, string>;
    },
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

test("kimi tool base env keeps the transport's PATH (wrapper dir + agent-configured PATH), not a fresh daemon PATH (#8610)", async () => {
  const { ctx, home } = makeTempCtx({ sessionId: null });
  const { harness } = makeCapturingHarness();
  const slockDir = "/tmp/kimi-wrappers/agent-1/w3-launch";
  const transportPath = `${slockDir}${path.delimiter}/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin`;
  const deps = makeFakeDeps(home, harness, [], slockDir, "/tmp/kimi-slock-home", { PATH: transportPath });

  await createKimiAgentSessionForContext(ctx, "sess-path", deps);

  assert.equal(deps._capturedEnv.PATH, transportPath, "the bash tool sees exactly the runtime PATH");
});

test("kimi tool base env carries the managed-launch agent env, not only the daemon's process env", async () => {
  const { ctx, home } = makeTempCtx({ sessionId: null });
  const { harness } = makeCapturingHarness();
  const agentEnv = {
    SLOCK_AGENT_ID: "agent-1",
    SLOCK_AGENT_LAUNCH_ID: "launch-1",
    SLOCK_SERVER_URL: "https://api.raft.test",
    SLOCK_CURRENT_AGENT_ID: "agent-1",
    SLOCK_CURRENT_SERVER_ID: "server-1",
    SLOCK_CURRENT_DAEMON_VERSION: "0.0.0-kimi-tool-env-test",
    SLOCK_CURRENT_WORKSPACE_PATH: "/tmp/ws",
    RAFT_CURRENT_COMPUTER_ID: "computer-1",
    RAFT_CURRENT_COMPUTER_NAME: "box",
    RAFT_CURRENT_COMPUTER_HOSTNAME: "box.local",
    RAFT_CURRENT_COMPUTER_OS: "linux",
    AGENT_CONFIGURED_VAR: "from-agent-config",
  };
  const deps = makeFakeDeps(home, harness, [], "/tmp/kimi-wrappers/agent-1/w4-launch", "/tmp/kimi-slock-home", agentEnv);

  await createKimiAgentSessionForContext(ctx, "sess-agent-env", deps);

  for (const [key, value] of Object.entries(agentEnv)) {
    assert.equal(deps._capturedEnv[key], value, `bash tool env must carry ${key}`);
  }
});

test("kimi tool base env leaves out daemon env keys the transport removed (credentials, profile selectors)", async () => {
  const leaked = {
    SLOCK_AGENT_TOKEN_FILE: "/tmp/daemon-token",
    SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:1/daemon",
    RAFT_PROFILE: "daemon-login-profile",
  };
  const saved = Object.fromEntries(Object.keys(leaked).map((key) => [key, process.env[key]]));
  Object.assign(process.env, leaked);
  try {
    const { ctx, home } = makeTempCtx({ sessionId: null });
    const { harness } = makeCapturingHarness();
    // Fake transport env mirrors prepareCliTransport: these keys deleted.
    const deps = makeFakeDeps(home, harness, [], "/tmp/kimi-wrappers/agent-1/w5-launch", "/tmp/kimi-slock-home", { SLOCK_AGENT_ID: "agent-1" });

    await createKimiAgentSessionForContext(ctx, "sess-unset", deps);

    // The base env replaces the daemon's process.env, so a removed key is
    // simply absent: nothing the daemon carries reaches the tools.
    for (const key of Object.keys(leaked)) {
      assert.equal(key in deps._capturedEnv, false, `tool env must not carry ${key}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("kimiToolBaseEnv as a process env: the tool sees spawnEnv values and not removed daemon keys", async () => {
  const saved = process.env.KIMI_TOOL_ENV_TEST_REMOVED;
  process.env.KIMI_TOOL_ENV_TEST_REMOVED = "daemon-value";
  try {
    const spawnEnv = { ...process.env, KIMI_TOOL_ENV_TEST_AGENT: "agent-value" } as NodeJS.ProcessEnv;
    delete spawnEnv.KIMI_TOOL_ENV_TEST_REMOVED;
    // The engine spawns tool processes with exactly this env (its baseEnv
    // replaces process.env; the shell tool only adds its own overrides).
    const env = kimiToolBaseEnv({ spawnEnv, slockDir: "/tmp/kimi-wrappers/agent-1/launch", slockHome: "/tmp/kimi-slock-home" });
    const out = execFileSync(
      "sh",
      ["-c", 'printf "%s|%s" "${KIMI_TOOL_ENV_TEST_AGENT-unset}" "${KIMI_TOOL_ENV_TEST_REMOVED-unset}"'],
      { env, encoding: "utf8" },
    );
    assert.equal(out, "agent-value|unset");
  } finally {
    if (saved === undefined) delete process.env.KIMI_TOOL_ENV_TEST_REMOVED;
    else process.env.KIMI_TOOL_ENV_TEST_REMOVED = saved;
  }
});

test("createKimiAgentSessionForContext gives the harness the standing prompt + tool base env on the CREATE path", async () => {
  const { ctx, home } = makeTempCtx({ sessionId: null });
  const { harness, createCalls, resumeCalls } = makeCapturingHarness();
  const slockDir = "/tmp/kimi-wrappers/agent-1/w2-launch";
  const slockHome = "/tmp/kimi-slock-home";
  const deps = makeFakeDeps(home, harness, [], slockDir, slockHome);

  await createKimiAgentSessionForContext(ctx, "sess-create", deps);

  assert.equal(resumeCalls.length, 0, "no prior sessionId → must not resume");
  assert.equal(createCalls.length, 1, "must create exactly one session");
  const fields = createCalls[0];
  assert.equal(fields.workDir, ctx.workingDirectory);
  // kimi-code 2.x silently ignores these on createSession: they ride the harness.
  for (const key of ["roleAdditional", "kaos", "persistenceKaos", "mcpServers"]) {
    assert.equal(key in fields, false, `createSession must not carry ${key}`);
  }
  const options = deps._harnessOptions.at(-1)!;
  assert.equal(typeof options.roleAdditional, "string", "roleAdditional must be a harness option");
  const roleAdditional = options.roleAdditional as string;
  assert.ok(roleAdditional.includes(ctx.standingPrompt), "roleAdditional must carry the standing prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "roleAdditional must NOT carry the wrapper CLI note");
  assert.equal(deps._capturedEnv.NO_COLOR, "1");
  assert.equal(deps._capturedEnv.SLOCK_HOME, slockHome);
  assert.equal(deps._capturedEnv.SLOCK_AGENT_LAUNCH_DIR, path.basename(slockDir));
  assert.ok(deps._capturedEnv.PATH?.startsWith(slockDir), "tool base env PATH must be prepended with slockDir");
  for (const key of ["KIMI_CODE_HOME", "NO_COLOR", "PATH", "SLOCK_AGENT_LAUNCH_DIR", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME"]) {
    assert.equal(typeof deps._capturedEnv[key], "string", `tool base env must set ${key}`);
  }
});

test("createKimiAgentSessionForContext gives the harness the standing prompt + tool base env on the RESUME path", async () => {
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
  for (const key of ["roleAdditional", "kaos", "persistenceKaos", "mcpServers"]) {
    assert.equal(key in fields, false, `resumeSession must not carry ${key}`);
  }
  // The harness re-renders a resumed session's prompt with this value.
  const roleAdditional = deps._harnessOptions.at(-1)!.roleAdditional as string;
  assert.ok(roleAdditional.includes(ctx.standingPrompt), "resume roleAdditional must carry the standing prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "resume roleAdditional must NOT carry the wrapper CLI note");
  assert.equal(deps._capturedEnv.SLOCK_AGENT_LAUNCH_DIR, path.basename(slockDir));
  for (const key of ["KIMI_CODE_HOME", "NO_COLOR", "PATH", "SLOCK_AGENT_LAUNCH_DIR", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME"]) {
    assert.equal(typeof deps._capturedEnv[key], "string", `tool base env must set ${key} on resume`);
  }
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
  const seed = createKimiHarness({ homeDir: fixture.home, identity: { productName: "kimi-code-cli", version: KIMI_CODE_HOST_VERSION, platform: KIMI_CODE_PLATFORM } });
  let resumedHarness: KimiHarness | undefined;
  // kimi-code 2.x's harness close is not idempotent.
  let seedClosed = false;
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
    seedClosed = true;

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
    // The seed session was bound without a standing prompt; the resuming
    // harness carries one, and the real request's system prompt has it.
    const system = (requests[1]?.messages ?? []).find((message) => (message as { role?: string }).role === "system");
    assert.ok(JSON.stringify(system?.content ?? "").includes(fixture.ctx.standingPrompt!), "the resumed request's system prompt must carry the standing prompt");
    assert.ok(!JSON.stringify(requests[0]?.messages).includes(fixture.ctx.standingPrompt!), "the seed request had no standing prompt (control)");
  } finally {
    await resumedHarness?.close();
    if (!seedClosed) await seed.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(path.dirname(fixture.home), { recursive: true, force: true });
  }
}, 15000);

test("Kimi's Bash tool runs with the agent's tool env, not the daemon's, through the real SDK engine", async () => {
  const fixture = makeTempCtx({ sessionId: null, model: "kimi-code/k3" });
  const requests: Array<{ messages: Array<{ role?: string; content: unknown }> }> = [];
  const command = 'printf "%s|%s" "${KIMI_ENV_PROBE_AGENT-unset}" "${KIMI_ENV_PROBE_DAEMON-unset}"';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (requests.length === 1) {
      res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_env", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      return;
    }
    res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  fsWriteFileSync(path.join(fixture.home, "config.toml"), `
default_model = "kimi-code/k3"
[providers.local]
type = "kimi"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-test-only"
[models."kimi-code/k3"]
provider = "local"
model = "k3"
max_context_size = 262144
`);
  fsMkdirSync(fixture.ctx.workingDirectory, { recursive: true });
  const savedDaemon = process.env.KIMI_ENV_PROBE_DAEMON;
  process.env.KIMI_ENV_PROBE_DAEMON = "daemon-only";
  let harness: KimiHarness | undefined;
  try {
    const result = await createKimiAgentSessionForContext(fixture.ctx, "sess-env-probe", {
      prepareTransport: makeFakeDeps(fixture.home, {} as KimiHarness, [], "/tmp/kimi-wrappers/agent-1/env-launch", "/tmp/kimi-slock-home", {
        PATH: process.env.PATH ?? "",
        KIMI_ENV_PROBE_AGENT: "agent-value",
      }).prepareTransport,
    });
    harness = result.harness;
    const session = result.session;
    session.setApprovalHandler(() => ({ decision: "approved", scope: "session" }));
    const finished = new Promise<void>((resolve, reject) => {
      const unsubscribe = session.onEvent((event) => {
        if (event.type === "turn.ended" && (event as { agentId?: string }).agentId !== "agent-sub") { unsubscribe(); resolve(); }
        if (event.type === "error") { unsubscribe(); reject(new Error(JSON.stringify(event))); }
      });
    });
    await session.prompt("probe the env");
    await finished;
    assert.equal(requests.length, 2, "the tool result goes back to the model");
    const toolResult = JSON.stringify(requests[1]!.messages.filter((message) => message.role === "tool"));
    assert.ok(toolResult.includes("agent-value|unset"), `Bash must see the agent env and not the daemon's: ${toolResult}`);
  } finally {
    if (savedDaemon === undefined) delete process.env.KIMI_ENV_PROBE_DAEMON;
    else process.env.KIMI_ENV_PROBE_DAEMON = savedDaemon;
    await harness?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(path.dirname(fixture.home), { recursive: true, force: true });
  }
}, 20000);

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
    const harnessOptions: Array<Record<string, unknown>> = [];
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
        makeFakeDeps(home, harnessWithSession, harnessOptions, slockDir, path.dirname(path.dirname(path.dirname(slockDir)))),
      );
      return { harness: result.harness, session: fakeSession, wrapperPath: result.wrapperPath };
    };
    return { factory, createCalls, resumeCalls, promptCalls, harnessOptions };
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
  const { factory: factory2, createCalls: createCalls2, resumeCalls: resumeCalls2, promptCalls: promptCalls2, harnessOptions: harnessOptions2 } = makeRuntime("standing prompt W2", w2SlockDir);
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
  // The resuming harness carries the fresh W2 standing prompt (the SDK
  // re-renders the resumed main agent's prompt with it).
  const roleAdditional = harnessOptions2.at(-1)!.roleAdditional as string;
  assert.ok(roleAdditional.includes("standing prompt W2"), "resumed roleAdditional must carry the fresh standing prompt W2");
  assert.ok(!roleAdditional.includes("standing prompt W1"), "resumed roleAdditional must not carry the stale W1 prompt");
  assert.ok(!roleAdditional.includes(WRAPPER_PATH), "resumed roleAdditional must NOT carry the wrapper CLI note");

  // The W2 launch's tool env, so the model's first CLI call resolves to the
  // current launch's wrapper, not a stale W1 absolute path.
  const baseEnv = harnessOptions2.at(-1)!.baseEnv as Record<string, string>;
  assert.ok(baseEnv.PATH?.startsWith(w2SlockDir), "resumed tool env PATH must lead with the W2 launch dir");

  // The first turn after resume must contain only the user's text.
  assert.equal(promptCalls2.length, 1, "first resumed turn must issue exactly one prompt");
  assert.equal(promptCalls2[0], "second turn", "first resumed turn must be only the user's text");
  assert.ok(!promptCalls2[0].includes("standing prompt"), "first resumed turn must NOT contain the standing prompt");
});

test("createKimiAgentSessionForContext attaches the launch-scoped remote MCP server to the session on create and resume", async () => {
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
    // kimi-code 2.x takes no MCP servers on create/resume: they are attached
    // to the live session.
    assert.equal("mcpServers" in createHarness.createCalls[0]!, false);
    const [createServer] = createHarness.mcpServerCalls as Array<{ name: string; transport: string; url: string }>;
    assert.equal(createHarness.mcpServerCalls.length, 1);
    assert.match(createServer!.name, /^rm[a-zA-Z0-9]{6}$/);
    assert.equal(createServer!.transport, "http");
    assert.match(createServer!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(JSON.stringify(createServer), /private\.example\.test/);

    const resumeFixture = makeTempCtx({ sessionId: "resume-managed" });
    configureManagedMcp(resumeFixture.ctx);
    const resumeHarness = makeCapturingHarness();
    await createKimiAgentSessionForContext(
      resumeFixture.ctx,
      "resume-managed",
      makeFakeDeps(resumeFixture.home, resumeHarness.harness),
    );
    assert.equal("mcpServers" in resumeHarness.resumeCalls[0]!, false);
    const [resumeServer] = resumeHarness.mcpServerCalls as Array<{ name: string; transport: string; url: string }>;
    assert.equal(resumeHarness.mcpServerCalls.length, 1);
    assert.equal(resumeServer!.transport, "http");
    assert.match(resumeServer!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/);
  } finally {
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

// Tenny (10-19): kimi-code 2.x ignores `mcpServers` on create and resume without
// an error, so prove the managed server reaches the real engine, not only that
// addMcpServer was called: the model request lists the server's tool, on a
// created and on a resumed session, and does not without the server (control).
test("the managed MCP server's tools reach the real Kimi engine's model request on create and resume", async () => {
  const fixture = makeTempCtx({ sessionId: null, model: "kimi-code/k3" });
  const requests: Array<{ model?: string; tools?: unknown }> = [];
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
default_model = "kimi-code/other"
[providers.local]
type = "kimi"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-test-only"
[models."kimi-code/other"]
provider = "local"
model = "other"
max_context_size = 262144
[models."kimi-code/k3"]
provider = "local"
model = "k3"
max_context_size = 1048576
`);
  fsMkdirSync(fixture.ctx.workingDirectory, { recursive: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/internal/agent-api/mcp/tools")) return originalFetch(input, init);
    return new Response(JSON.stringify({
      catalogVersion: 1,
      tools: [{
        mcpServerId: "22222222-2222-4222-8222-222222222222",
        serverName: "Private Docs",
        toolName: "search",
        runtimeName: "mcp_private_search",
        description: "Search private docs",
        inputSchema: { type: "object" },
        configVersion: 1,
        assignmentVersion: 1,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const deps = { prepareTransport: makeFakeDeps(fixture.home, {} as KimiHarness).prepareTransport };
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
  // The proxy publishes the tool as r<sha8(runtimeName)>_<toolName>, which the engine qualifies as mcp__<server>__<tool>.
  const listsManagedTool = (request: { tools?: unknown } | undefined) => ((request?.tools ?? []) as Array<{ function?: { name?: string } }>).some((tool) => /^mcp__rm[a-zA-Z0-9]{6}__r[0-9a-f]{8}_search$/.test(tool.function?.name ?? ""));
  const harnesses: KimiHarness[] = [];
  try {
    // Control: no agent credential, so no managed server.
    const control = await createKimiAgentSessionForContext({ ...fixture.ctx, config: { ...fixture.ctx.config, agentCredentialKey: undefined } }, "mcp-control", deps);
    harnesses.push(control.harness);
    await promptAndFinish(control.session, "control turn");
    assert.equal(listsManagedTool(requests.at(-1)), false, "control: no managed server, no managed tool");

    fixture.ctx.launchId = "launch-managed";
    fixture.ctx.config.agentCredentialKey = "sk_agent_test";
    const created = await createKimiAgentSessionForContext(fixture.ctx, "mcp-real", deps);
    harnesses.push(created.harness);
    await promptAndFinish(created.session, "first turn");
    assert.ok(listsManagedTool(requests.at(-1)), "a created session's first request lists the managed tool");
    // The reload that brings the server in must not undo the profile model
    // (the config default is another model).
    assert.equal(requests.at(-1)?.model, "k3");
    const sessionId = created.session.id;
    await created.harness.close();
    harnesses.pop();

    fixture.ctx.config.sessionId = sessionId;
    fixture.ctx.launchId = "launch-managed-2";
    const resumed = await createKimiAgentSessionForContext(fixture.ctx, sessionId, deps);
    harnesses.push(resumed.harness);
    assert.equal(resumed.session.id, sessionId, "resumed, not created");
    await promptAndFinish(resumed.session, "first turn after resume");
    assert.ok(listsManagedTool(requests.at(-1)), "a resumed session's first request lists the managed tool");
    assert.ok(JSON.stringify(requests.at(-1)).includes(fixture.ctx.standingPrompt!), "the reload keeps the standing prompt");
    assert.equal(requests.at(-1)?.model, "k3");
  } finally {
    globalThis.fetch = originalFetch;
    for (const harness of harnesses) await harness.close();
    await __resetManagedMcpRuntimeProxyForTest();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(path.dirname(fixture.home), { recursive: true, force: true });
  }
}, 20000);

// Tenny: an app server that cannot be attached must not stop the Kimi agent
// from starting (0.34 opened the session even when the server was down). The
// real engine is used; only the failing call is replaced.
test.each(["addMcpServer", "reloadSession"] as const)("a failing %s leaves the managed MCP out and the agent still starts and answers", async (failing) => {
  const fixture = makeTempCtx({ sessionId: null, model: "kimi-code/k3" });
  const requests: Array<{ tools?: unknown }> = [];
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
default_model = "kimi-code/k3"
[providers.local]
type = "kimi"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "local-test-only"
[models."kimi-code/k3"]
provider = "local"
model = "k3"
max_context_size = 1048576
`);
  fsMkdirSync(fixture.ctx.workingDirectory, { recursive: true });
  fixture.ctx.launchId = "launch-managed";
  fixture.ctx.config.agentCredentialKey = "sk_agent_test";
  const traced: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  fixture.ctx.tracer = { emitEvent: (name: string, options: { attrs?: Record<string, unknown> }) => traced.push({ name, attrs: options.attrs ?? {} }) } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/internal/agent-api/mcp/tools")) return originalFetch(input, init);
    return new Response(JSON.stringify({
      catalogVersion: 1,
      tools: [{
        mcpServerId: "22222222-2222-4222-8222-222222222222",
        serverName: "Private Docs",
        toolName: "search",
        runtimeName: "mcp_private_search",
        description: "Search private docs",
        inputSchema: { type: "object" },
        configVersion: 1,
        assignmentVersion: 1,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // The real harness, with the one session call made to fail.
  const realHarness = createKimiHarness;
  const createHarness = ((options: Parameters<typeof createKimiHarness>[0]) => {
    const harness = realHarness(options);
    const createSession = harness.createSession.bind(harness);
    harness.createSession = async (input) => {
      const session = await createSession(input);
      session[failing] = async () => { throw new Error(`${failing} refused`); };
      return session;
    };
    return harness;
  }) as typeof createKimiHarness;
  let harness: KimiHarness | undefined;
  try {
    const started = await createKimiAgentSessionForContext(fixture.ctx, "mcp-down", {
      createHarness,
      prepareTransport: makeFakeDeps(fixture.home, {} as KimiHarness).prepareTransport,
    });
    harness = started.harness;
    const finished = new Promise<void>((resolve, reject) => {
      const unsubscribe = started.session.onEvent((event) => {
        if (event.type === "turn.ended") { unsubscribe(); resolve(); }
        if (event.type === "error") { unsubscribe(); reject(new Error(JSON.stringify(event))); }
      });
    });
    await started.session.prompt("hello");
    await finished;
    assert.equal(requests.length, 1, "the agent answered");
    assert.ok(!JSON.stringify(requests[0]?.tools ?? []).includes("_search"), "no managed tool after a failed attach");
    assert.deepEqual(traced.map((event) => [event.name, event.attrs.step_kind]), [
      ["daemon.runtime.managed_mcp.attach_failed", failing === "addMcpServer" ? "add" : "reload"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await harness?.close();
    await __resetManagedMcpRuntimeProxyForTest();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(path.dirname(fixture.home), { recursive: true, force: true });
  }
}, 20000);

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

test("KimiSdkRuntimeSession emits request diagnostics only for the exact configured native session", async () => {
  const sessionId = "kimi-session-diagnostic";
  const originalAgentSelector = process.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV];
  const originalSessionSelector = process.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV];
  process.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV] = "agent-1";
  process.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV] = sessionId;

  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const fakeSession = {
    id: sessionId,
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      assert.ok(eventListener);
      eventListener({ ...eventBase(), sessionId, type: "turn.step.started", turnId: 4, step: 3 });
      const request = {
        method: "POST",
        path: "/v1/chat/completions?private=query",
        headers: { authorization: "Bearer private-token" },
        body: "private-prompt",
      };
      channel("undici:request:create").publish({ request });
      channel("undici:request:headers").publish({ request, response: { statusCode: 200 } });
      channel("undici:request:trailers").publish({ request });
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

  try {
    assert.deepEqual(await runtime.start({ text: "start" }), { ok: true, acceptedAs: "prompt" });
    await flushImmediate();
    const diagnostic = runtimeEvents.find(
      (event): event is Extract<ParsedEvent, { kind: "telemetry" }> =>
        event.kind === "telemetry" && event.name === "request_diagnostic",
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.source, "kimi_request_diagnostic");
    assert.equal(diagnostic.sessionId, sessionId);
    assert.equal(diagnostic.turnId, "4");
    const {
      duration_ms: durationMs,
      started_at_ms: startedAtMs,
      finished_at_ms: finishedAtMs,
      ...stableAttrs
    } = diagnostic.attrs;
    assert.equal(typeof durationMs, "number");
    assert.equal(typeof startedAtMs, "number");
    assert.equal(typeof finishedAtMs, "number");
    assert.deepEqual(stableAttrs, {
      diagnostic_kind: "kimi_request",
      correlation_id: `${sessionId}:4.3:1.1`,
      step: 3,
      outer_attempt: 1,
      inner_attempt: 1,
      outcome: "success",
      status_code: 200,
    });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of ["query", "private-token", "private-prompt"]) {
      assert.ok(!serialized.includes(secret));
    }
  } finally {
    await runtime.dispose();
    if (originalAgentSelector === undefined) delete process.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV];
    else process.env[KIMI_REQUEST_DIAGNOSTIC_AGENT_ID_ENV] = originalAgentSelector;
    if (originalSessionSelector === undefined) delete process.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV];
    else process.env[KIMI_REQUEST_DIAGNOSTIC_SESSION_ID_ENV] = originalSessionSelector;
  }
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

// ── Per-launch PATH tooth ─────────────────────────────────────────────────
//
// The Kimi engine spawns its tool processes from the harness's base env, whose
// PATH is prepended with the current launch's wrapper directory. This test
// proves a real process with that env resolves the bare `raft` command to that
// wrapper, so the model never needs an absolute wrapper path in its prompt.

test("the tool base env resolves bare `raft` to the current launch wrapper", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "kimi-tool-path-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = path.join(tmp, "home");
  try {
    const ctx = makeSpawnContext();
    ctx.workingDirectory = tmp;
    const transport = await prepareCliTransport(ctx, { NO_COLOR: "1" });
    const env = kimiToolBaseEnv({ spawnEnv: transport.spawnEnv, slockDir: transport.slockDir, slockHome: transport.slockHome });

    const out = execFileSync("sh", ["-c", "command -v raft"], { env, encoding: "utf8" }).trim();

    assert.equal(out, path.join(transport.slockDir, "raft"), "command -v raft must resolve to the current launch's raft wrapper");
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("only a subagent's usage reaches the main agent's event stream", () => {
  const subagent = (type: string) => ({ type, agentId: "agent-2", sessionId: "s" }) as never;
  assert.equal(kimiEventIsShownForMainAgent({ type: "turn.ended", agentId: "main", sessionId: "s" } as never), true);
  assert.equal(kimiEventIsShownForMainAgent({ type: "turn.ended" } as never), true, "an event without agentId is the main agent's");
  // Tool calls stay out until they carry subagent lineage: a background
  // subagent's calls arrive after the main turn ended.
  for (const type of ["turn.started", "turn.ended", "assistant.delta", "thinking.delta", "error", "compaction.started", "goal.updated", "tool.call.started", "tool.result"]) {
    assert.equal(kimiEventIsShownForMainAgent(subagent(type)), false, `a subagent's ${type} is not the main agent's`);
  }
  assert.equal(kimiEventIsShownForMainAgent(subagent("turn.step.completed")), true, "a subagent's usage is counted");
});


test("Kimi start failures map to typed reasons instead of the generic runtime_spawn_failed (task #1221)", async () => {
  // A KimiError can only reach the daemon after a launch loaded the SDK; this
  // test builds them directly, so load it the way a launch does.
  await loadKimiSdk();
  const notConfigured = new KimiError(
    "config.invalid",
    'Model "devin/swe-2" is not configured in config.toml. Add a [models."devin/swe-2"] entry with max_context_size.',
    { details: { model: "devin/swe-2" } },
  );
  const fresh = makeTempCtx({ sessionId: null, model: "devin/swe-2" });
  const harness = {
    createSession: async () => ({
      id: "fresh",
      setModel: async () => { throw notConfigured; },
    }),
    resumeSession: async () => { throw new Error("no resume on the fresh path"); },
  } as unknown as KimiHarness;
  const modelError = await createKimiAgentSessionForContext(fresh.ctx, "fresh", makeFakeDeps(fresh.home, harness)).then(
    () => assert.fail("a model missing from the local config must fail the start"),
    (error: unknown) => error,
  );
  assert.equal(classifySpawnFailure(modelError).reason, "model_not_configured");
  assert.match(classifySpawnFailure(modelError).userMessage, /devin\/swe-2/);

  const loginRequired = new KimiError("auth.login_required", 'OAuth provider "kimi-code" requires login before it can be used.');
  assert.equal(classifySpawnFailure(typedKimiStartError(loginRequired, null)).reason, "runtime_login_required");
  const badConfig = new KimiError("config.invalid", "Provider \"x\" is not configured.");
  assert.equal(classifySpawnFailure(typedKimiStartError(badConfig, null)).reason, "runtime_config_invalid");
  const plain = new Error("socket hang up");
  assert.equal(typedKimiStartError(plain, null), plain, "non-Kimi errors pass through unchanged");
});

test("a resume failure that is not a session problem surfaces instead of silently starting fresh", async () => {
  const resumed = makeTempCtx({ sessionId: "resume-auth", model: "kimi-code/k3" });
  let created = 0;
  const harness = {
    createSession: async () => { created += 1; return { id: "fresh", setModel: async () => {} }; },
    resumeSession: async () => { throw new KimiError("auth.login_required", "requires login"); },
  } as unknown as KimiHarness;
  const error = await createKimiAgentSessionForContext(resumed.ctx, "resume-auth", makeFakeDeps(resumed.home, harness)).then(
    () => assert.fail("login required must fail the start"),
    (caught: unknown) => caught,
  );
  assert.equal(classifySpawnFailure(error).reason, "runtime_login_required");
  assert.equal(created, 0, "no fresh session when the failure would repeat");

  // A missing session file still falls back to a fresh session.
  const missing = makeTempCtx({ sessionId: "resume-missing", model: "kimi-code/k3" });
  const setModelCalls: string[] = [];
  const fallbackHarness = {
    createSession: async () => ({ id: "fresh", setModel: async (model: string) => { setModelCalls.push(model); } }),
    resumeSession: async () => { throw new KimiError("session.not_found", 'Session "resume-missing" was not found'); },
  } as unknown as KimiHarness;
  await createKimiAgentSessionForContext(missing.ctx, "resume-missing", makeFakeDeps(missing.home, fallbackHarness));
  assert.deepEqual(setModelCalls, ["kimi-code/k3"], "the fresh fallback resolves the model at start too");

  // An ordinary (non-Kimi) error, e.g. I/O, is surfaced as-is: no silent fresh session.
  const io = makeTempCtx({ sessionId: "resume-io", model: "kimi-code/k3" });
  let ioCreated = 0;
  const ioHarness = {
    createSession: async () => { ioCreated += 1; return { id: "fresh", setModel: async () => {} }; },
    resumeSession: async () => { throw new Error("EIO: i/o error, read"); },
  } as unknown as KimiHarness;
  const ioError = await createKimiAgentSessionForContext(io.ctx, "resume-io", makeFakeDeps(io.home, ioHarness)).then(
    () => assert.fail("an unknown resume error must fail the start"),
    (caught: unknown) => caught,
  );
  assert.match((ioError as Error).message, /EIO/);
  assert.equal(ioCreated, 0, "no fresh session for an unknown resume error");
});

test("task #365: a launch that turns stale while the kimi factory prepares never resumes or creates an SDK session", async () => {
  for (const sessionId of [null, "existing-session"]) {
    const { ctx: base, home } = makeTempCtx({ sessionId });
    const { harness, createCalls, resumeCalls } = makeCapturingHarness();
    const deps = makeFakeDeps(home, harness);
    const prepare = deps.prepareTransport as unknown as (...args: unknown[]) => Promise<unknown>;
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => { release = resolve; });
    deps.prepareTransport = (async (...args: unknown[]) => {
      await preparing;
      return prepare(...args);
    }) as never;
    let stale = false;
    const refused = new Error("launch claimed against an earlier connection");
    const ctx: SpawnContext = { ...base, assertLaunchCurrent: () => { if (stale) throw refused; } };

    const pending = createKimiAgentSessionForContext(ctx, "sess-stale", deps);
    stale = true; // the connection changes while the factory prepares
    release();
    await assert.rejects(pending, (err) => err === refused, `sessionId=${sessionId}: the typed stale error reaches the caller`);
    assert.deepEqual([createCalls.length, resumeCalls.length], [0, 0], `sessionId=${sessionId}: no SDK session`);

    // Positive control: the same factory creates or resumes while the launch is current.
    stale = false;
    const ok = await createKimiAgentSessionForContext({ ...base, assertLaunchCurrent: () => {} }, "sess-ok", makeFakeDeps(home, harness));
    assert.ok(ok.session);
    assert.equal(createCalls.length + resumeCalls.length, 1, `sessionId=${sessionId}: control reached the SDK`);
  }
});

test("task #365: a launch that turns stale during a failed kimi resume does not fall through to a fresh SDK session", async () => {
  for (const turnsStale of [true, false]) {
    const { ctx: base, home } = makeTempCtx({ sessionId: "resume-missing" });
    let stale = false;
    let created = 0;
    const refused = new Error("launch claimed against an earlier connection");
    const harness = {
      createSession: async () => { created += 1; return { id: "fresh", setModel: async () => {} }; },
      resumeSession: async () => {
        // The connection changes while the resume is in flight; the resume then fails as recoverable.
        if (turnsStale) stale = true;
        throw new KimiError("session.not_found", 'Session "resume-missing" was not found');
      },
    } as unknown as KimiHarness;
    const ctx: SpawnContext = { ...base, assertLaunchCurrent: () => { if (stale) throw refused; } };
    const result = createKimiAgentSessionForContext(ctx, "resume-missing", makeFakeDeps(home, harness));
    if (turnsStale) {
      await assert.rejects(result, (err) => err === refused, "the typed stale error, not a Kimi start error");
      assert.equal(created, 0, "no fresh session after the launch turned stale");
    } else {
      await result;
      assert.equal(created, 1, "control: a current launch falls back to a fresh session");
    }
  }
});

test("task #17: a Kimi tool result reports ok, and a non-zero Bash exit is an ok call with the exit code", () => {
  assert.deepEqual(kimiToolResultOutcome({ isError: false, output: "done" }), { ok: true });
  assert.deepEqual(kimiToolResultOutcome({ output: "done" }), {}, "isError absent: unknown, not success");
  assert.deepEqual(kimiToolResultOutcome({ isError: true, output: "Command failed with exit code: 3." }), { ok: true, exitCode: 3 });
  assert.deepEqual(kimiToolResultOutcome({ isError: true, output: { message: "Command failed with exit code: 1.", brief: "Failed with exit code: 1" } }), { ok: true, exitCode: 1 });
  assert.deepEqual(kimiToolResultOutcome({ isError: true, output: "Permission denied" }), { ok: false });
});

test("KimiSdkRuntimeSession.interruptTurn cancels the running turn natively and ends it as interrupted, not failed", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  let rejectPrompt: (error: Error) => void = () => {};
  let cancelCalls = 0;
  const fakeSession = {
    id: "kimi-session-1",
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      eventListener?.({ ...eventBase(), type: "turn.started", turnId: 1 } as KimiSdkEvent);
      return new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      cancelCalls += 1;
      // Kimi ends the cancelled turn, then the pending prompt settles.
      eventListener?.({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "cancelled", interruptReason: "user_cancelled" } as KimiSdkEvent);
      rejectPrompt(new Error("turn cancelled"));
      return Promise.resolve();
    },
  } as unknown as KimiSession;
  const factory = async () => ({ harness: {} as unknown as KimiHarness, session: fakeSession, wrapperPath: WRAPPER_PATH });
  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, factory);
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  assert.equal(runtime.interruptTurn(), "unsupported", "no turn yet: the daemon takes its restart path");
  await runtime.start({ text: "work" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.interruptTurn(), "sent");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelCalls, 1);
  const turnEnds = runtimeEvents.filter((event) => event.kind === "turn_end");
  assert.deepEqual(turnEnds.map((event) => event.kind === "turn_end" && event.interrupted), [true]);
  assert.deepEqual(runtimeEvents.filter((event) => event.kind === "error" || event.kind === "delivery_error"), []);
  assert.equal(runtime.interruptTurn(), "unsupported", "the turn is over");

  await runtime.dispose();
});

test("#54 phase 3: KimiSdkRuntimeSession reads its context and window from the session, compacts when idle, settles on compaction.completed, and refuses while a turn runs", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  let compactCalls = 0;
  let resolvePrompt: () => void = () => {};
  const fakeSession = {
    id: "kimi-session-1",
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      eventListener?.({ ...eventBase(), type: "turn.started", turnId: 1 } as KimiSdkEvent);
      return new Promise<void>((resolve) => { resolvePrompt = resolve; });
    },
    steer() {
      return Promise.resolve();
    },
    getStatus() {
      return Promise.resolve({ contextTokens: 300_000, maxContextTokens: 1_000_000 });
    },
    compact() {
      compactCalls += 1;
      setImmediate(() => eventListener?.({ ...eventBase(), type: "compaction.completed" } as KimiSdkEvent));
      return Promise.resolve();
    },
  } as unknown as KimiSession;
  const factory = async () => ({ harness: {} as unknown as KimiHarness, session: fakeSession, wrapperPath: WRAPPER_PATH });
  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, factory);

  await runtime.start({ text: "work" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await runtime.compactAtTurnEnd(), { kind: "refused", reason: "busy" }, "a turn is running");
  assert.equal(compactCalls, 0);

  eventListener!({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "completed" } as KimiSdkEvent);
  resolvePrompt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await runtime.turnEndContextFacts(), { contextTokens: 300_000, windowTokens: 1_000_000 });
  assert.deepEqual(await runtime.compactAtTurnEnd(), { kind: "completed" });
  assert.equal(compactCalls, 1);

  await runtime.dispose();
});

test("a Kimi turn cancelled by anything other than the daemon's interrupt still ends without the interrupted mark", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  const events = mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "cancelled" } as KimiSdkEvent, state);
  assert.deepEqual(events.filter((event) => event.kind === "turn_end"), [{ kind: "turn_end", sessionId: "kimi-session-1" }]);
});

test("a cancelled Kimi prompt that rejects after the next turn started neither reports an error nor ends that turn", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const rejecters: Array<(error: Error) => void> = [];
  const fakeSession = {
    id: "kimi-session-1",
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) {
      eventListener = listener;
      return () => {};
    },
    prompt() {
      eventListener?.({ ...eventBase(), type: "turn.started", turnId: rejecters.length + 1 } as KimiSdkEvent);
      return new Promise<void>((_resolve, reject) => { rejecters.push(reject); });
    },
    steer() {
      return Promise.resolve();
    },
    cancel() {
      // The turn ends now; the prompt's own rejection comes later.
      eventListener?.({ ...eventBase(), type: "turn.ended", turnId: 1, reason: "cancelled" } as KimiSdkEvent);
      return Promise.resolve();
    },
  } as unknown as KimiSession;
  const factory = async () => ({ harness: {} as unknown as KimiHarness, session: fakeSession, wrapperPath: WRAPPER_PATH });
  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, factory);
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));

  await runtime.start({ text: "work" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.interruptTurn(), "sent");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.send({ mode: "idle", text: "next" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejecters.length, 2, "precondition: the next turn's prompt is out");
  rejecters[0]!(new Error("turn cancelled"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtimeEvents.filter((event) => event.kind === "error" || event.kind === "delivery_error"), []);
  assert.equal(runtime.interruptTurn(), "sent", "the next turn is still running and can be stopped natively");

  await runtime.dispose();
});

test("#proj-runtime:#41: a Kimi subagent's spawn, steps and end carry its lineage; its turn and errors stay out", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;
  const lineage = { parentToolUseId: "call_agent_1", taskId: "sub-1", subagentType: "coder" };
  // The spawn comes from the main agent (requester) and names the subagent's own agent id.
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-1", subagentName: "coder", parentToolCallId: "call_agent_1", runInBackground: true, taskId: "bg-7" }, state), [
    { kind: "subagent_progress", source: "kimi_subagent", phase: "started", ...lineage },
  ]);
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-1", subagentName: "coder", parentToolCallId: "call_agent_1", runInBackground: true }, state), [], "a repeat while it runs starts nothing");
  assert.equal(state.subagents?.get("sub-1")?.stopTaskId, "bg-7");

  const child = { agentId: "sub-1", sessionId: "kimi-session-1" };
  // Its deltas are buffered into one row, passed on before its next tool call.
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "thinking.delta", turnId: 1, delta: "pl" } as never, state), []);
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "thinking.delta", turnId: 1, delta: "an" } as never, state), []);
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "tool.call.started", turnId: 1, toolCallId: "c1", name: "Shell", args: { command: "ls" } } as never, state), [
    { kind: "thinking", text: "plan", subagent: lineage },
    { kind: "tool_call", name: "Shell", input: { command: "ls" }, callId: "sub-1:c1", subagent: lineage },
  ]);
  const result = mapKimiSubagentEvent({ ...child, type: "tool.result", turnId: 1, toolCallId: "c1", isError: false, output: "ok" } as never, state);
  assert.equal(result?.[0]?.kind, "tool_output");
  assert.equal((result?.[0] as { callId?: string }).callId, "sub-1:c1");
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "assistant.delta", turnId: 1, delta: "done" } as never, state), []);
  // Its turn end passes on its text, never a turn end; its errors stay out.
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "turn.ended", turnId: 1, reason: "completed" } as never, state), [{ kind: "text", text: "done", subagent: lineage }]);
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "error", message: "boom" } as never, state), []);
  // Its own (nested) subagent: the spawning call id is qualified by the spawner, as its tool rows are.
  assert.deepEqual(mapKimiSubagentEvent({ ...child, type: "subagent.spawned", subagentId: "sub-2", subagentName: "explore", parentToolCallId: "c9", runInBackground: false } as never, state), [
    { kind: "subagent_progress", source: "kimi_subagent", phase: "started", parentToolUseId: "sub-1:c9", taskId: "sub-2", subagentType: "explore" },
  ]);
  // The main agent's and an unknown agent's events are not a subagent's.
  assert.equal(mapKimiSubagentEvent({ ...eventBase(), type: "assistant.delta", turnId: 1, delta: "x" } as never, state), null);
  assert.equal(mapKimiSubagentEvent({ agentId: "stranger", sessionId: "kimi-session-1", type: "assistant.delta", turnId: 1, delta: "x" } as never, state), null);

  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.completed", subagentId: "sub-1", resultSummary: "done" }, state), [
    { kind: "subagent_progress", source: "kimi_subagent", phase: "notification", taskStatus: "completed", ...lineage },
  ]);
  // A resume spawns it again under a new call: a new run, started again.
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-1", subagentName: "coder", parentToolCallId: "call_agent_2", runInBackground: false }, state), [
    { kind: "subagent_progress", source: "kimi_subagent", phase: "started", parentToolUseId: "call_agent_2", taskId: "sub-1", subagentType: "coder" },
  ]);
  assert.equal(state.subagents?.get("sub-1")?.stopTaskId, undefined, "the new run names no task");
  for (const [type, extra, taskStatus] of [
    ["subagent.failed", { error: "oh" }, "failed"],
  ] as const) {
    assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type, subagentId: "sub-1", ...extra } as never, state), [
      { kind: "subagent_progress", source: "kimi_subagent", phase: "notification", taskStatus, parentToolUseId: "call_agent_2", taskId: "sub-1", subagentType: "coder" },
    ], type);
  }
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.cancelled", subagentId: "sub-2" }, state), [
    { kind: "subagent_progress", source: "kimi_subagent", phase: "notification", taskStatus: "stopped", parentToolUseId: "sub-1:c9", taskId: "sub-2", subagentType: "explore" },
  ]);
});

test("#proj-runtime:#41: a Kimi subagent cancelled before its spawn was announced is never counted as running", () => {
  const state = createKimiSdkEventMappingState("kimi-session-1");
  state.sessionAnnounced = true;
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.cancelled", subagentId: "sub-9" }, state), []);
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-9", subagentName: "coder", parentToolCallId: "c1", runInBackground: true }, state), []);
  assert.equal(state.subagents?.get("sub-9")?.running, false);
  // The same race on a resume: its end beats the resume's spawn.
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.failed", subagentId: "sub-9", error: "limit" }, state), []);
  assert.deepEqual(mapKimiSdkEventToParsedEvents({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-9", subagentName: "coder", parentToolCallId: "c2", runInBackground: false }, state), []);
  assert.equal(state.subagents?.get("sub-9")?.running, false);
});

test("#proj-runtime:#41: through the runtime session, a Kimi subagent's steps reach the activity with its lineage, and its turn end never ends the agent's turn", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const fakeSession = {
    id: "kimi-session-sub",
    getGoal() { return Promise.resolve({ goal: null }); },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) { eventListener = listener; return () => {}; },
    prompt() { return Promise.resolve(); },
    steer() { return Promise.resolve(); },
    cancel() { return Promise.resolve(); },
  } as unknown as KimiSession;
  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({ harness: {} as KimiHarness, session: fakeSession, wrapperPath: WRAPPER_PATH }));
  const runtimeEvents: ParsedEvent[] = [];
  runtime.on("runtime_event", (event) => runtimeEvents.push(event));
  assert.equal((await runtime.start({ text: "start" })).ok, true);
  await flushImmediate();
  const emit = eventListener as unknown as (event: KimiSdkEvent) => void;
  runtimeEvents.length = 0;
  const child = { agentId: "sub-1", sessionId: "kimi-session-sub" };
  emit({ ...eventBase(), type: "subagent.spawned", subagentId: "sub-1", subagentName: "coder", parentToolCallId: "call_1", runInBackground: true });
  emit({ ...child, type: "assistant.delta", turnId: 1, delta: "hi" } as never);
  emit({ ...child, type: "turn.ended", turnId: 1, reason: "completed" } as never);
  assert.deepEqual(runtimeEvents.map((event) => event.kind), ["subagent_progress", "text"], "no turn_end from the subagent");
  assert.ok(runtimeEvents.every((event) => (event as { subagent?: unknown }).subagent !== undefined || event.kind === "subagent_progress"));
});


test("#proj-runtime:#41: a Kimi subagent the main agent started stops through its task, foreground or background; a nested one cannot be stopped from the session", async () => {
  let eventListener: ((event: KimiSdkEvent) => void) | null = null;
  const stopped: Array<{ taskId: string; reason?: string }> = [];
  const fakeSession = {
    id: "kimi-session-stop",
    getGoal() { return Promise.resolve({ goal: null }); },
    setApprovalHandler() {},
    onEvent(listener: (event: KimiSdkEvent) => void) { eventListener = listener; return () => {}; },
    prompt() { return Promise.resolve(); },
    steer() { return Promise.resolve(); },
    cancel() { return Promise.resolve(); },
    stopBackgroundTask(taskId: string, options?: { reason?: string }) { stopped.push({ taskId, reason: options?.reason }); return Promise.resolve(); },
  } as unknown as KimiSession;
  const runtime = new KimiSdkRuntimeSession(makeSpawnContext(), () => {}, async () => ({ harness: {} as KimiHarness, session: fakeSession, wrapperPath: WRAPPER_PATH }));
  assert.equal((await runtime.start({ text: "start" })).ok, true);
  await flushImmediate();
  const emit = eventListener as unknown as (event: KimiSdkEvent) => void;
  emit({ ...eventBase(), type: "subagent.spawned", subagentId: "bg-sub", subagentName: "coder", parentToolCallId: "c1", runInBackground: true, taskId: "task-7" });
  emit({ ...eventBase(), type: "subagent.spawned", subagentId: "fg-sub", subagentName: "explore", parentToolCallId: "c2", runInBackground: false, taskId: "task-8" });
  // A subagent's own subagent: its task is in that subagent's task service, not the main agent's.
  emit({ agentId: "bg-sub", sessionId: "kimi-session-stop", type: "subagent.spawned", subagentId: "nested", subagentName: "explore", parentToolCallId: "c3", runInBackground: false, taskId: "task-9" } as never);

  assert.equal(runtime.interruptSubagent("bg-sub"), "sent");
  assert.deepEqual(stopped, [{ taskId: "task-7", reason: "Stopped from Raft" }]);
  assert.equal(runtime.interruptSubagent("fg-sub"), "sent", "a foreground run is a task too");
  assert.equal(runtime.interruptSubagent("nested"), "unsupported", "the main session cannot reach a nested subagent's task");
  assert.deepEqual(stopped.map((stop) => stop.taskId), ["task-7", "task-8"]);
  assert.equal(runtime.interruptSubagent("nobody"), "not_running");
  emit({ ...eventBase(), type: "subagent.cancelled", subagentId: "bg-sub" });
  assert.equal(runtime.interruptSubagent("bg-sub"), "not_running", "ended");
  assert.equal(stopped.length, 2);
  assert.equal(new KimiSdkDriver().stopsSubagentsInSession, true);
});
