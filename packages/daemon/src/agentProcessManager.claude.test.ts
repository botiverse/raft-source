// Claude APM behavior baseline tests.
//
// Scope (PR 4, Option B per #proj-runtime:991a69e6 msg=8e85249a + msg=a2a63a87):
// Only the most load-bearing invariants that future driver-level extraction
// PRs (Hao PR 1-3) and behavior-changing PRs (#2217 etc.) must not break:
//
//   1. runtime phase transitions driven by ParsedEvent kinds.
//   2. direct inbox steering during tool execution, with compaction buffering.
//
// Deferred to follow-up PRs (per Hao msg=8e85249a vote):
//   - Activity Log emit-point assertions
//   - Status dot transitions
//   - Compaction watchdog timing under Claude
//   - APM consumes ParsedEvent.error (status/activity/recovery state)
//   - live Claude Code queued-command integration (covered by the guarded
//     claude.integration.test.ts black-box)
//
// Per @Hao msg=2eb549a2 (A) Additive only: this file does not move existing
// `runtime: "claude"` tests out of agentProcessManager.codex.test.ts. It
// adds net-new focused coverage for Claude-specific busyDeliveryMode=direct
// behavior. Helpers are duplicated (slimmed) to avoid touching codex.test.ts.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AxSurfaceText,
  BasicTracer,
  MemoryTraceSink,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
  type Tracer,
} from "@botiverse/raft-shared";
import {
  ApmTraceRecorder,
  buildBehaviorDeltaRow,
  evaluateApmTracePredicateFixtures,
  serializeApmTraceArtifacts,
} from "./apmStateMachineTrace.js";
import { computeInboxNoticeFingerprint, RuntimeNotificationState } from "./runtimeNotificationState.js";
import { setSessionReadyDeliveryRetrySchedulerFactoryForTesting } from "./agentInboxDeliveryDebt.js";
import { FakeClock } from "./testing/fakeClock.js";
import {
  buildApmFreshnessDecisionProducerFactId,
  createInitialApmDecisionState,
  createInitialApmGatedSteeringState,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
  reduceApmGatedAssistantContinuation,
  reduceApmGatedCompaction,
  reduceApmGatedCompactionBoundaryFlush,
  reduceApmGatedError,
  reduceApmGatedTurnEnd,
  reduceApmToolUse,
  reduceApmIdleState,
  reduceApmStalledRecoveryTermination,
  reduceApmStartupTimeoutTermination,
  reduceAgentActivityProjection,
} from "./apmStateMachine.js";
import type {
  ApmObservedGatedStdinEffect,
  ApmTraceArtifactBundle,
  PredicateFixtureResult,
} from "./apmStateMachineTrace.js";
import { AgentProcessManager } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index.js";
import type { RuntimeLaunchVersionPolicy } from "./drivers/types.js";
import { RuntimeVersionTooOldError } from "./runtimeLaunchVersion.js";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };
  ignoredKillSignals = new Set<NodeJS.Signals | number | undefined>();

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.ignoredKillSignals.has(signal)) return true;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

// Minimal Claude driver mock — pinned to the real Claude shape:
//   busyDeliveryMode = "direct"
//   inFlightWake = "steer"
//   supportsStdinNotification = true
//   supportsNativeStandingPrompt = true
class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  deferSpawnUntilMessage?: boolean;
  launchVersionPolicy?: RuntimeLaunchVersionPolicy;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  readonly encodedCalls: Array<{ text: string; mode: "idle" | "busy"; sessionId: string | null | undefined }> = [];
  currentSessionId: string | null = null;

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const proc = new FakeChildProcess();
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }

  encodeStdinMessage(
    text?: string,
    _sessionId?: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    if (!text) return null;
    const mode = opts?.mode || "busy";
    this.encodedCalls.push({ text, mode, sessionId: _sessionId });
    return JSON.stringify({ mode, text });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-agent",
    displayName: "Claude Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: "cred-test",
    ...overrides,
  };
}

function makeMessage(content: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    timestamp: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentStartSnapshot(manager: AgentProcessManager) {
  return (manager as any).agentStarts.snapshot();
}

function markAgentStarting(manager: AgentProcessManager, agentId: string): void {
  (manager as any).agentStarts.markStarting(agentId);
}

function setAgentStartCapacityFull(manager: AgentProcessManager): void {
  (manager as any).agentStarts.setMaxConcurrentStartsForTesting(1);
  (manager as any).agentStarts.setActiveStartsForTesting(1);
}

function queuedAgentStart(manager: AgentProcessManager, agentId: string) {
  return (manager as any).agentStarts.getQueued(agentId);
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function withManager(
  fn: (ctx: {
    driver: FakeClaudeDriver;
    manager: AgentProcessManager;
    sent: MachineToServerMessage[];
    dataDir: string;
  }) => Promise<void>,
  options: {
    tracer?: Tracer;
    daemonInstanceId?: string;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    sessionReadyDeliveryRetryMs?: number;
    sessionReadyDeliveryRetrySchedulerFactory?: () => RuntimeNotificationState;
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-claude-apm-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeClaudeDriver();
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      tracer: options.tracer,
      fetchImpl: options.fetchImpl,
      daemonInstanceId: options.daemonInstanceId,
      sessionReadyDeliveryRetryMs: options.sessionReadyDeliveryRetryMs,
    },
  );
  setSessionReadyDeliveryRetrySchedulerFactoryForTesting(options.sessionReadyDeliveryRetrySchedulerFactory ?? null);

  try {
    await fn({ driver, manager, sent, dataDir });
  } finally {
    setSessionReadyDeliveryRetrySchedulerFactoryForTesting(null);
    if ((manager as any).agentStartPumpTimer) clearTimeout((manager as any).agentStartPumpTimer);
    for (const ap of (manager as any).agents?.values?.() ?? []) {
      ap.notifications.clearTimer();
      if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
      if (ap.activityHeartbeat?.kind === "active") clearInterval(ap.activityHeartbeat.timer);
      if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
      if (ap.exit?.kind === "live" && ap.exit.stalledRecoverySigtermTimer) clearTimeout(ap.exit.stalledRecoverySigtermTimer);
      if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
      if (ap.runtimeErrorDeliveryBackoff?.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
        clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
      }
      if (ap.sessionReadyDeliveryRetry?.kind === "scheduled") {
        ap.sessionReadyDeliveryRetry.scheduler.clearTimer();
      }
    }
    (manager as any).agents?.clear?.();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function getProcess(manager: AgentProcessManager, agentId: string): any {
  return (manager as any).agents.get(agentId);
}

function makeSessionReadyDeliveryRetryScheduler() {
  const clock = new FakeClock();
  return {
    clock,
    factory: () => new RuntimeNotificationState({
      schedule: (fn, ms) => clock.setTimeout(fn, ms),
      cancel: (timer) => clock.clearTimeout(timer),
    }),
  };
}

function assertPendingInputInvariant(
  manager: AgentProcessManager,
  ap: any,
  admittedInputCount: number,
  label: string,
): void {
  const pendingInputCount = ap.inbox.length;
  if (pendingInputCount <= admittedInputCount) return;
  const hasScheduledTurn = ap.notifications.pendingCount > 0
    || ap.notifications.hasTimer
    || ap.sessionReadyDeliveryRetry.kind === "scheduled";
  const hasRunningTurn = !(manager as any).isApmIdle(ap);
  assert.ok(
    hasScheduledTurn || hasRunningTurn,
    `${label}: pending_input > admitted_input must have a scheduled or running turn`,
  );
}

test("Claude creation-time version gate blocks known-bad CLI before deferred-empty return and spawn", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    driver.deferSpawnUntilMessage = true;
    driver.launchVersionPolicy = {
      displayName: "Claude Code",
      knownBadVersions: ["2.1.59"],
      testedGoodVersion: "2.1.220",
      probe: () => ({ available: true, version: "2.1.59 (Claude Code)" }),
    };

    await assert.rejects(
      manager.startAgent("agent-version-bad", makeConfig()),
      RuntimeVersionTooOldError,
    );
    assert.equal(driver.spawnCalls.length, 0, "known-bad CLI must create no child/session");
    assert.equal(driver.processes.length, 0);
    assert.equal(sent.some((message) => message.type === "agent:status" && message.status === "active"), false);
  });
});

test("Claude creation-time version gate visibly warns but starts an unproven older CLI", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    driver.launchVersionPolicy = {
      displayName: "Claude Code",
      knownBadVersions: ["2.1.59"],
      testedGoodVersion: "2.1.220",
      probe: () => ({ available: true, version: "2.1.60 (Claude Code)" }),
    };

    await manager.startAgent("agent-version-warning", makeConfig());
    assert.equal(driver.spawnCalls.length, 1, "warn-only version must still start");
    assert.equal(sent.some((message) =>
      message.type === "agent:activity" &&
      message.detail?.includes("2.1.60") &&
      message.detail.includes("starting anyway")
    ), true, "warning must be user-visible");
    assert.equal(sent.some((message) => message.type === "agent:status" && message.status === "inactive"), false);
    assert.equal(sent.some((message) => message.type === "agent:status" && message.status === "active"), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block 1 — shared runtime progress state (load-bearing subset)
// ─────────────────────────────────────────────────────────────────────────────

test("Claude APM baseline: tool_call event increments outstandingToolUses", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.gatedSteering.outstandingToolUses, 1);
  });
});
test("Claude APM baseline: tool_output decrements outstandingToolUses", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    driver.parsedLines.set("tool-end", [
      { kind: "tool_output", name: "shell" },
    ]);

    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();
    driver.processes[0].stdout.emit("data", Buffer.from("tool-end\n"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.gatedSteering.outstandingToolUses, 0);
  });
});

test("Claude APM baseline: compaction_started sets compacting=true; compaction_finished clears it", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);

    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();
    const apMid = getProcess(manager, "agent-1");
    assert.equal(apMid.gatedSteering.compacting, true);

    driver.processes[0].stdout.emit("data", Buffer.from("compact-finish\n"));
    await flush();
    const apAfter = getProcess(manager, "agent-1");
    assert.equal(apAfter.gatedSteering.compacting, false);
  });
});

test("Claude APM invariant: fresh-session parked pending input schedules retry without turn_end", async () => {
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "fresh-session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("fresh session delivery", { message_id: "msg-parked", seq: 100 }),
      {
        deliveryId: "delivery-parked",
      },
    );
    assert.equal(accepted, true);

    let ap = getProcess(manager, "agent-1");
    assert.equal(ap.sessionReadyForDelivery, false, "Claude fresh session is not ready until turn_end or retry fallback");
    assert.equal(ap.inbox.length, 1, "message parks locally before session is ready");
    assert.equal(driver.encodedCalls.length, 0, "fresh-session park must not inject immediately");
    assertPendingInputInvariant(manager, ap, driver.encodedCalls.length, "fresh-session parking");

    retryScheduler.clock.advanceBy(4);
    assert.equal(driver.encodedCalls.length, 0, "retry must not fire before the configured settlement delay");
    retryScheduler.clock.advanceBy(1);

    ap = getProcess(manager, "agent-1");
    assert.equal(ap.sessionReadyForDelivery, true, "retry fallback marks session deliverable");
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.equal(driver.encodedCalls[0].sessionId, "fresh-session-1");
    assert.match(driver.encodedCalls[0].text, /Raft inbox notice/);
  }, { sessionReadyDeliveryRetryMs: 5, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("Claude APM invariant: session_init schedules retry for delivery queued before session exists", async () => {
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));

    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("pre-session delivery", { message_id: "msg-pre-session", seq: 103 }),
      { deliveryId: "delivery-pre-session" },
    );
    assert.equal(accepted, true);

    let ap = getProcess(manager, "agent-1");
    assert.equal(ap.sessionId, null);
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.sessionReadyDeliveryRetry.kind, "idle", "retry cannot schedule until session_init supplies a session id");
    assert.equal(driver.encodedCalls.length, 0, "pre-session delivery must not inject immediately");

    driver.parsedLines.set("session-init-after-pre-session-delivery", [
      { kind: "session_init", sessionId: "fresh-session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init-after-pre-session-delivery\n"));
    await flush();

    ap = getProcess(manager, "agent-1");
    assert.equal(ap.sessionId, "fresh-session-1");
    assert.equal(ap.sessionReadyForDelivery, false, "fresh Claude session is still readiness-gated before retry fallback");
    assert.equal(ap.sessionReadyDeliveryRetry.kind, "scheduled");
    assert.equal(ap.sessionReadyDeliveryRetry.reason, "session_init_with_pending_delivery");
    assertPendingInputInvariant(manager, ap, driver.encodedCalls.length, "session_init pending input");

    retryScheduler.clock.advanceBy(4);
    assert.equal(driver.encodedCalls.length, 0, "retry must not fire before the configured settlement delay");
    retryScheduler.clock.advanceBy(1);

    ap = getProcess(manager, "agent-1");
    assert.equal(ap.sessionReadyForDelivery, true, "retry fallback marks session deliverable");
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.equal(driver.encodedCalls[0].sessionId, "fresh-session-1");
    assert.match(driver.encodedCalls[0].text, /Raft inbox notice/);
  }, { sessionReadyDeliveryRetryMs: 5, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("Claude APM delivery: pending injection debt is activity-probe visible", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "fresh-session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    await manager.deliverMessage(
      "agent-1",
      makeMessage("parked before session ready", { message_id: "msg-probe", seq: 101 }),
      { deliveryId: "delivery-probe" },
    );

    manager.respondToActivityProbe("agent-1", "probe-pending-delivery");

    const activity = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity" && msg.probeId === "probe-pending-delivery",
    );
    assert.ok(activity, "activity probe should receive a response");
    assert.equal(activity.activity, undefined);
    assert.equal(activity.detail, "Message received");
    assert.equal(activity.detailKind, "message_received");
  }, { sessionReadyDeliveryRetryMs: 10_000 });
});

test("Claude APM delivery: activity probe does not let pending debt mask sticky terminal error", async () => {
  const { tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["model is not supported"];

    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("sticky terminal pending delivery", { message_id: "msg-sticky-probe", seq: 104 }),
      { deliveryId: "delivery-sticky-probe" },
    );
    assert.equal(accepted, true);
    assert.equal(ap.inbox.length, 1);

    manager.respondToActivityProbe("agent-1", "probe-sticky-pending-delivery");

    const activity = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity" && msg.probeId === "probe-sticky-pending-delivery",
    );
    assert.ok(activity, "activity probe should receive a response");
    assert.equal(activity.activity, undefined);
    assert.equal(activity.detailKind, "runtime_error");
    assert.notEqual(activity.detailKind, "message_received");
  }, { tracer });
});

test.skip("RETIRED 2026-08-03 (task #524): Claude APM invariant: turn_end re-arms write-only pending input into a new turn", async () => {
  // RETIRED WITH ITS PRODUCTION CODE, not silenced. This tooth pinned the
  // turn_end delivery-debt re-arm from #5911, which was proven to be an
  // unbounded fixpoint (re-delivered already-contributed messages on every
  // turn_end; see the RETIRED note in agentProcessManager.ts). Tenny authorized
  // removing behavior + tooth together on 2026-08-03. A correct bounded version
  // — at-least-once anchored on "debt genuinely unconsumed" with a suppression
  // memo surviving the turn boundary — is task #70's redesign; this tooth must
  // be REPLACED by that design's teeth, never merely re-enabled.
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);

    const message = makeMessage("delivered while active turn is about to end", { message_id: "msg-midturn", seq: 102 });
    const accepted = await manager.deliverMessage(
      "agent-1",
      message,
      { deliveryId: "delivery-midturn" },
    );
    assert.equal(accepted, true);
    assert.equal(ap.inbox.length, 1);
    assert.equal(driver.encodedCalls.length, 0, "active-turn queue must wait for boundary flush");
    assertPendingInputInvariant(manager, ap, driver.encodedCalls.length, "active-turn pending input");

    ap.notifications.recordNoticeWritten(
      computeInboxNoticeFingerprint([message]),
      "session-1",
      [message],
    );

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));

    await waitFor(() => driver.encodedCalls.length === 1, "turn_end inbox flush");
    assertPendingInputInvariant(manager, ap, driver.encodedCalls.length, "turn_end re-arm");
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.equal(driver.encodedCalls[0].sessionId, "session-1");
    assert.match(driver.encodedCalls[0].text, /Raft inbox notice/);
    assert.ok(
      sink.getAllSpans().some((span) => span.name === "daemon.agent.delivery_debt.rearmed_on_turn_end"),
      "turn_end flush must record that write-only debt was re-armed",
    );
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block 2 — inbox gating lifecycle (queue-during-tool / flush-at-boundary)
// ─────────────────────────────────────────────────────────────────────────────

test("Claude APM baseline: messages delivered during tool_wait use direct busy stdin without waiting for tool_output", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const encodedBefore = driver.encodedCalls.length;
    manager.deliverMessage("agent-1", makeMessage("question delivered mid-tool"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.gatedSteering.outstandingToolUses, 1);
    assert.equal(ap.inbox.length, 1, "message should queue while tool is running");
    assert.equal(driver.encodedCalls.length, encodedBefore, "busy updates remain batched until the notification timer fires");

    const written = (manager as any).sendStdinNotification("agent-1");
    assert.equal(written, true);
    assert.equal(driver.encodedCalls.length, encodedBefore + 1);
    assert.equal(driver.encodedCalls.at(-1)?.mode, "busy");
    assert.match(driver.encodedCalls.at(-1)?.text ?? "", /Raft inbox notice/);
    assert.equal(ap.gatedSteering.outstandingToolUses, 1, "direct steering must not mutate tool lifecycle state");
  });
});

test("Claude APM baseline: direct stdin remains available mid-compaction", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    const encodedBefore = driver.encodedCalls.length;
    manager.deliverMessage("agent-1", makeMessage("question delivered mid-compaction"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.gatedSteering.compacting, true);
    assert.equal(ap.inbox.length, 1, "message should queue while compacting");
    assert.equal(driver.encodedCalls.length, encodedBefore, "busy updates remain batched until the timer fires");
    assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    assert.equal(driver.encodedCalls.length, encodedBefore + 1);
    assert.equal(driver.encodedCalls.at(-1)?.mode, "busy");
  });
});

test("Claude token usage telemetry records result identity without refreshing turn progress", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "launch-session" }));
    const ap = getProcess(manager, "agent-1");
    assert.ok(ap, "agent process should exist");

    ap.runtimeProgress.noteRuntimeEvent("tool_output", 123);
    ap.runtimeProgress.markStale(456);

    driver.parsedLines.set("usage", [{
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      sessionId: "session-result",
      runtimeResultId: "result-uuid-1",
      attrs: {
        inputTokens: 154,
        outputTokens: 4,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 30,
        totalTokens: 208,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("usage\n"));
    await flush();

    assert.equal(ap.runtimeProgress.lastEventAt, 123);
    assert.equal(ap.runtimeProgress.lastEventKind, "tool_output");
    assert.equal(ap.runtimeProgress.staleSince, 456);

    const telemetrySpan = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.ok(telemetrySpan, "telemetry sidecar span should be recorded");
    assert.equal(telemetrySpan.attrs?.agentId, "agent-1");
    assert.equal(telemetrySpan.attrs?.runtime, "claude");
    assert.equal(telemetrySpan.attrs?.model, "sonnet");
    assert.equal(telemetrySpan.attrs?.source, "claude_result_usage");
    assert.equal(telemetrySpan.attrs?.usageKind, "per_turn");
    assert.equal(telemetrySpan.attrs?.sessionId, "session-result");
    assert.equal(telemetrySpan.attrs?.runtimeResultId, "result-uuid-1");
    assert.equal(telemetrySpan.attrs?.turnId, undefined);
    assert.equal(telemetrySpan.attrs?.cacheCreationInputTokens, 30);
    assert.equal(telemetrySpan.attrs?.totalTokens, 208);
  }, { tracer });
});

test("runtime telemetry uses live driver session identity when event omits sessionId", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "launch-session" }));
    driver.currentSessionId = "live-session-1";

    driver.parsedLines.set("usage-without-session", [{
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      runtimeResultId: "result-uuid-2",
      attrs: {
        agentId: "payload-agent",
        launchId: "payload-launch",
        runtime: "codex",
        model: "payload-model",
        telemetry_name: "rate_limits",
        source: "payload-source",
        usageKind: "unknown",
        sessionId: "payload-session",
        turnId: "payload-turn",
        runtimeResultId: "payload-result",
        runtimeResultIdSource: "payload-source",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("usage-without-session\n"));
    await flush();

    const telemetrySpan = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.ok(telemetrySpan, "telemetry sidecar span should be recorded");
    assert.equal(telemetrySpan.attrs?.agentId, "agent-1");
    assert.notEqual(telemetrySpan.attrs?.launchId, "payload-launch");
    assert.equal(telemetrySpan.attrs?.runtime, "claude");
    assert.equal(telemetrySpan.attrs?.model, "sonnet");
    assert.equal(telemetrySpan.attrs?.telemetry_name, "token_usage");
    assert.equal(telemetrySpan.attrs?.source, "claude_result_usage");
    assert.equal(telemetrySpan.attrs?.usageKind, "per_turn");
    assert.equal(telemetrySpan.attrs?.sessionId, "live-session-1");
    assert.equal(telemetrySpan.attrs?.runtimeResultId, "result-uuid-2");
    assert.equal(telemetrySpan.attrs?.runtimeResultIdSource, undefined);
    assert.equal(telemetrySpan.attrs?.turnId, undefined);
  }, { tracer });
});

test("Claude token usage telemetry falls back to launch session and daemon result sequence", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "launch-session" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );

    driver.parsedLines.set("usage-without-runtime-identity", [{
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usageKind: "per_turn",
      attrs: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("usage-without-runtime-identity\n"));
    await flush();

    const telemetrySpan = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.ok(telemetrySpan, "telemetry sidecar span should be recorded");
    assert.equal(telemetrySpan.attrs?.agentId, "agent-1");
    assert.equal(telemetrySpan.attrs?.launchId, "launch-1");
    assert.equal(telemetrySpan.attrs?.runtime, "claude");
    assert.equal(telemetrySpan.attrs?.source, "claude_result_usage");
    assert.equal(telemetrySpan.attrs?.usageKind, "per_turn");
    assert.equal(telemetrySpan.attrs?.sessionId, "launch-session");
    assert.equal(telemetrySpan.attrs?.runtimeResultId, "launch-1:claude_result_usage:1");
    assert.equal(telemetrySpan.attrs?.runtimeResultIdSource, "daemon_sequence");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block 3 — Status dot transitions correlated with ParsedEvent kinds
// (per Hao msg=5b986bba priority + tygg msg=2aadf9eb trace-as-linear-projection
// methodology: assert chronological activity sequence emitted, not just final
// snapshot. agent:activity upstream messages are the linear projection of the
// gatedSteering state machine that drives the web status dot.)
// ─────────────────────────────────────────────────────────────────────────────

function projectTestActivity(
  msg: Extract<MachineToServerMessage, { type: "agent:activity" }>,
): string {
  switch (msg.detailKind) {
    case "thinking_started":
      return "thinking";
    case "runtime_error":
    case "runtime_stalled":
    case "computer_operation_failed":
      return "error";
    case "runtime_crashed":
    case "runtime_unavailable":
    case "stopped":
    case "runtime_interrupted":
    case "machine_disconnected":
      return "offline";
    case "idle":
    case "ready":
    case "computer_started":
    case "computer_restarted":
    case "computer_upgraded":
    case "synthetic_repair":
      return "online";
    default:
      return "working";
  }
}

function activitySequence(sent: MachineToServerMessage[]): Array<{ activity: string; detail: string }> {
  return sent
    .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
    .map((msg) => ({ activity: projectTestActivity(msg), detail: msg.detail }));
}

function cloneTraceArtifacts(bundle: ApmTraceArtifactBundle): ApmTraceArtifactBundle {
  return JSON.parse(JSON.stringify(bundle)) as ApmTraceArtifactBundle;
}

function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const spanIds = ["2".repeat(16), "3".repeat(16), "4".repeat(16), "5".repeat(16)];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => spanIds[spanIndex++] ?? "6".repeat(16),
  });
  return { sink, tracer };
}

function observedGatedEffectsFromTrace(sink: MemoryTraceSink): ApmObservedGatedStdinEffect[] {
  const effects: ApmObservedGatedStdinEffect[] = [];
  for (const span of sink.getAllSpans()) {
    if (span.name !== "daemon.apm.gated_effect") continue;
    const payload = {
      outcome: span.attrs?.outcome,
      deliveredMessagesCount: span.attrs?.delivered_messages_count ?? null,
      pendingMessages: span.attrs?.pending_messages ?? null,
    };
    if (
      span.attrs?.effect_kind === "notify_stdin" &&
      span.attrs?.reason === "compaction_finished" &&
      span.attrs?.stdin_mode === "busy"
    ) {
      effects.push({
        kind: "notify_stdin",
        reason: span.attrs.reason,
        stdinMode: "busy",
        payload,
      });
    }
    if (
      span.attrs?.effect_kind === "deliver_stdin" &&
      span.attrs?.reason === "turn_end" &&
      span.attrs?.stdin_mode === "idle"
    ) {
      effects.push({
        kind: "deliver_stdin",
        reason: "turn_end",
        stdinMode: "idle",
        payload,
      });
    }
  }
  return effects;
}

function predicateResult(
  bundle: ApmTraceArtifactBundle,
  name: PredicateFixtureResult["name"],
): PredicateFixtureResult {
  const result = evaluateApmTracePredicateFixtures(bundle).find((entry) => entry.name === name);
  assert.ok(result, `missing predicate result for ${name}`);
  return result;
}

test("APM reducer seam: agent:activity projection produces typed effect and producer lineage", () => {
  const initial = createInitialApmDecisionState();
  const reduction = reduceAgentActivityProjection(initial, {
    transitionSeq: 1,
    scenario: "unit-reducer-seam",
    correlationId: "trace-unit-reducer-seam",
    inputId: "input-001",
    inputKind: "ParsedEvent",
    inputSummary: "tool_call",
    message: {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "Running shell command",
      clientSeq: 7,
      launchId: "launch-1",
    },
  });

  assert.equal(reduction.transition.previousStateHash, initial.stateHash);
  assert.notEqual(reduction.nextState.stateHash, initial.stateHash);
  assert.equal(reduction.transition.nextStateHash, reduction.nextState.stateHash);
  assert.deepEqual(reduction.transition.effects, [
    {
      effectId: "effect-unit-reducer-seam-1",
      kind: "activity",
      reason: "tool_call",
      target: "activity-projector",
      clauseId: "SMR-002",
    },
  ]);
  assert.equal(reduction.transition.projectorOutputs.length, 1);
  const projectorOutput = reduction.transition.projectorOutputs[0];
  assert.ok(projectorOutput, "reducer emits one activity projector output");
  assert.equal(projectorOutput.projectorId, "projector-unit-reducer-seam-1");
  assert.equal(projectorOutput.projector, "activity-sequence");
  assert.equal(projectorOutput.surface, "agent:activity");
  assert.match(projectorOutput.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(projectorOutput.producerFactId, "fact-unit-reducer-seam-7");
  assert.equal(projectorOutput.sourceEffectId, "effect-unit-reducer-seam-1");
  assert.equal(projectorOutput.clauseId, "SMR-003");
  assert.equal(reduction.snapshotEntry.producerFactId, projectorOutput.producerFactId);
  assert.equal(reduction.snapshotEntry.activity, "working");
  assert.equal(reduction.snapshotEntry.detail, "Running shell command");
});

test("APM reducer seam: tool-use count remains available to stalled-recovery decisions", () => {
  const initial = createInitialApmGatedSteeringState();

  const firstCall = reduceApmToolUse(initial, { kind: "tool_call" });
  assert.equal(firstCall.nextState.outstandingToolUses, 1);

  const secondCall = reduceApmToolUse(firstCall.nextState, { kind: "tool_call" });
  assert.equal(secondCall.nextState.outstandingToolUses, 2);

  const firstOutput = reduceApmToolUse(secondCall.nextState, { kind: "tool_output" });
  assert.equal(firstOutput.nextState.outstandingToolUses, 1);

  const finalOutput = reduceApmToolUse(firstOutput.nextState, { kind: "tool_output" });
  assert.equal(finalOutput.nextState.outstandingToolUses, 0);

  const extraOutput = reduceApmToolUse(finalOutput.nextState, { kind: "tool_output" });
  assert.equal(extraOutput.nextState.outstandingToolUses, 0);
});

test("APM reducer seam: Claude compaction state transitions stay behavior-equivalent", () => {
  const initial = {
    ...createInitialApmGatedSteeringState(),
    outstandingToolUses: 2,
  };

  const started = reduceApmGatedCompaction(initial, { kind: "compaction_started" });
  assert.equal(started.nextState.compacting, true);
  assert.equal(
    started.nextState.outstandingToolUses,
    2,
    "compaction must preserve outstanding tool count for delivery gating",
  );

  const interrupted = reduceApmGatedCompaction(started.nextState, { kind: "compaction_interrupted" });
  assert.equal(interrupted.nextState.compacting, false);
  assert.equal(interrupted.nextState.outstandingToolUses, 2);

  const finished = reduceApmGatedCompaction(started.nextState, { kind: "compaction_finished" });
  assert.equal(finished.nextState.compacting, false);
  assert.equal(
    finished.nextState.outstandingToolUses,
    2,
    "compaction completion must not imply tool output/batch flush",
  );
});

test("APM reducer seam: Claude compaction-boundary flush emits legacy notify effect", () => {
  const active = {
    ...createInitialApmGatedSteeringState(),
    compacting: true,
  };

  const reduction = reduceApmGatedCompactionBoundaryFlush(active, {
    hasSession: true,
    supportsStdinNotification: true,
    inboxLength: 1,
    pendingNotificationCount: 1,
  });

  assert.deepEqual(reduction.effects, [{
    kind: "notify_stdin",
    reason: "compaction_finished",
    stdinMode: "busy",
    clauseId: "SMR-002",
  }]);
  assert.deepEqual(
    reduceApmGatedCompactionBoundaryFlush(active, {
      hasSession: true,
      supportsStdinNotification: true,
      inboxLength: 1,
      pendingNotificationCount: 0,
    }).effects,
    [],
    "legacy compaction-boundary path only notifies when a pending notification exists",
  );
});

test("APM reducer seam: Claude turn_end reset state stays behavior-equivalent", () => {
  const active = {
    ...createInitialApmGatedSteeringState(),
    outstandingToolUses: 3,
    compacting: true,
  };

  const reduction = reduceApmGatedTurnEnd(active);
  assert.equal(reduction.nextState.outstandingToolUses, 0);
  assert.equal(reduction.nextState.compacting, false);
  assert.deepEqual(reduction.effects, []);

  const withQueuedDelivery = reduceApmGatedTurnEnd(active, {
    inboxLength: 2,
    supportsStdinNotification: true,
    hasSession: true,
  });
  assert.deepEqual(withQueuedDelivery.effects, [{
    kind: "deliver_stdin",
    reason: "turn_end",
    stdinMode: "idle",
    clauseId: "SMR-002",
  }]);

  const withoutSessionButAllowed = reduceApmGatedTurnEnd(active, {
    inboxLength: 1,
    supportsStdinNotification: true,
    hasSession: false,
    canDeliverWithoutSession: true,
  });
  assert.deepEqual(withoutSessionButAllowed.effects, [{
    kind: "deliver_stdin",
    reason: "turn_end",
    stdinMode: "idle",
    clauseId: "SMR-002",
  }]);

  const withoutSessionAndDisallowed = reduceApmGatedTurnEnd(active, {
    inboxLength: 1,
    supportsStdinNotification: true,
    hasSession: false,
    canDeliverWithoutSession: false,
  });
  assert.deepEqual(
    withoutSessionAndDisallowed.effects,
    [],
    "session-init-required runtimes must not flush queued messages without a session boundary",
  );
});

test("APM reducer seam: Claude error clears compacting while preserving outstanding tools", () => {
  const active = {
    ...createInitialApmGatedSteeringState(),
    outstandingToolUses: 2,
    compacting: true,
  };

  const reduction = reduceApmGatedError(active);
  assert.equal(
    reduction.nextState.outstandingToolUses,
    2,
    "error phase transition must not imply tool-output completion",
  );
  assert.equal(
    reduction.nextState.compacting,
    false,
    "runtime error must clear compaction gating so queued messages cannot remain permanently blocked",
  );
});

test("APM reducer seam: idle state is owned by reducer transitions", () => {
  const busy = reduceApmIdleState(createInitialApmGatedSteeringState(), { isIdle: false }).nextState;
  const idleTurnEnd = reduceApmGatedTurnEnd(busy, {
    inboxLength: 0,
    supportsStdinNotification: true,
    hasSession: true,
  });
  assert.equal(idleTurnEnd.nextState.isIdle, true);
  assert.deepEqual(idleTurnEnd.effects, []);

  const queuedTurnEnd = reduceApmGatedTurnEnd(idleTurnEnd.nextState, {
    inboxLength: 1,
    supportsStdinNotification: true,
    hasSession: true,
  });
  assert.equal(
    queuedTurnEnd.nextState.isIdle,
    false,
    "queued turn_end delivery keeps the runtime busy until the executor result is known",
  );
  assert.deepEqual(queuedTurnEnd.effects.map((effect) => effect.kind), ["deliver_stdin"]);

  const terminalWakeable = reduceApmGatedError(queuedTurnEnd.nextState, { terminalWakeable: true });
  assert.equal(terminalWakeable.nextState.isIdle, true);

  const nonTerminal = reduceApmGatedError(terminalWakeable.nextState, { terminalWakeable: false });
  assert.equal(nonTerminal.nextState.isIdle, false);
});

test("APM reducer seam: expected termination reason is owned by reducer transitions", () => {
  const initial = createInitialApmGatedSteeringState();

  const perTurn = reduceApmGatedTurnEnd(initial, {
    terminateProcessOnTurnEnd: true,
  });
  assert.equal(perTurn.nextState.expectedTerminationReason, "turn_end");

  const persistent = reduceApmGatedTurnEnd(initial, {
    terminateProcessOnTurnEnd: false,
  });
  assert.equal(persistent.nextState.expectedTerminationReason, null);

  const preservingTurnEnd = reduceApmGatedTurnEnd(
    { ...initial, expectedTerminationReason: "stalled_recovery" },
    { terminateProcessOnTurnEnd: false },
  );
  assert.equal(preservingTurnEnd.nextState.expectedTerminationReason, "stalled_recovery");

  const blockedToolWait = reduceApmStalledRecoveryTermination(
    { ...persistent.nextState, outstandingToolUses: 1 },
    {
      inboxLength: 1,
      supportsStdinNotification: true,
      busyDeliveryMode: "direct",
      hasSession: true,
      hasDirectStdinRecoveryEvidence: false,
      runtimeProgressIsStale: true,
      staleForMs: 20 * 60_000,
      staleThresholdMs: 15 * 60_000,
    },
  );
  assert.equal(blockedToolWait.shouldTerminate, false);
  assert.equal(blockedToolWait.blockedReason, "runtime_not_restartable");
  assert.equal(blockedToolWait.nextState.expectedTerminationReason, null);

  const staleRecovery = reduceApmStalledRecoveryTermination(persistent.nextState, {
    inboxLength: 1,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: true,
    staleForMs: 20 * 60_000,
    staleThresholdMs: 15 * 60_000,
  });
  assert.equal(staleRecovery.shouldTerminate, true);
  assert.equal(staleRecovery.nextState.expectedTerminationReason, "stalled_recovery");

  const alreadyRecovering = reduceApmStalledRecoveryTermination(staleRecovery.nextState, {
    inboxLength: 2,
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    hasSession: true,
    hasDirectStdinRecoveryEvidence: false,
    runtimeProgressIsStale: true,
    staleForMs: 20 * 60_000,
    staleThresholdMs: 15 * 60_000,
  });
  assert.equal(alreadyRecovering.alreadyRecovering, true);
  assert.equal(alreadyRecovering.shouldTerminate, false);

  const runtimeProgressStarted = reduceApmStartupTimeoutTermination(persistent.nextState, {
    hasRuntimeProgressEvent: true,
  });
  assert.equal(runtimeProgressStarted.shouldTerminate, false);
  assert.equal(runtimeProgressStarted.blockedReason, "runtime_progress_started");
  assert.equal(runtimeProgressStarted.nextState.expectedTerminationReason, null);

  const startupTimeout = reduceApmStartupTimeoutTermination(persistent.nextState, {
    hasRuntimeProgressEvent: false,
  });
  assert.equal(startupTimeout.shouldTerminate, true);
  assert.equal(startupTimeout.blockedReason, null);
  assert.equal(startupTimeout.nextState.expectedTerminationReason, "startup_timeout");
  assert.equal(startupTimeout.nextState.isIdle, false);
});

test("APM reducer seam: freshness decision producer fact is stable and body-free", () => {
  const input = {
    action: "send" as const,
    decision: "local_hold" as const,
    target: "#proj-runtime:ec2e5abc",
    reason: "pending messages are newer than model boundary",
    pendingMaxSeq: 42,
    modelSeenSeq: 40,
    heldMessageCount: 2,
    omittedMessageCount: 1,
  };
  const factId = buildApmFreshnessDecisionProducerFactId("agent-1", input);
  assert.match(factId, /^freshness_decision_fact:[0-9a-f]{64}$/);
  assert.equal(
    buildApmFreshnessDecisionProducerFactId("agent-1", { ...input }),
    factId,
    "same freshness decision boundaries must produce stable lineage",
  );
  assert.notEqual(
    buildApmFreshnessDecisionProducerFactId("agent-1", { ...input, pendingMaxSeq: 43 }),
    factId,
    "lineage must change when the freshness boundary changes",
  );
  assert.doesNotMatch(factId, /pending messages|#proj-runtime|body/i);
});

test("APM held-envelope projector creates canonical held response and body-free activity readout", () => {
  const heldMessages = [
    { seq: 42, message_id: "pending-42", content: "newer pending body" },
    { seq: 43, message_id: "pending-43", content: "second pending body" },
  ];
  const envelope = projectApmHeldFreshnessEnvelope({
    producerFactId: "freshness_decision_fact:unit-held-response",
    action: "send",
    heldMessages,
    newMessageCount: 5,
    omittedMessageCount: 3,
    seenUpToSeq: 43,
  });

  assert.equal(envelope.clauseId, "SMR-006");
  assert.equal(envelope.projector, "held-envelope");
  assert.equal(envelope.surface, "agent-api-held-response");
  assert.equal(envelope.producerFactId, "freshness_decision_fact:unit-held-response");
  assert.deepEqual(envelope.body, {
    state: "held",
    outcome: "held",
    subtype: "freshness",
    reason: "newer_messages_available",
    decision: "local_hold",
    producerFactId: "freshness_decision_fact:unit-held-response",
    available_actions: ["check_messages", "send_draft", "send_anyway"],
    heldMessages,
    newMessageCount: 5,
    shownMessageCount: 2,
    omittedMessageCount: 3,
    seenUpToSeq: 43,
  });

  const activity = projectApmHeldFreshnessActivity({
    producerFactId: "freshness_decision_fact:unit-held-response",
    action: "send",
    decision: "local_hold",
    target: "dm:@tygg",
    messageCount: 2,
  });
  assert.equal(activity.clauseId, "SMR-006");
  assert.equal(activity.projector, "held-envelope");
  assert.equal(activity.surface, "agent:activity");
  assert.equal(activity.producerFactId, envelope.producerFactId);
  assert.deepEqual(activity.entry, {
    kind: "slock_action",
    producerFactId: envelope.producerFactId,
    title: "Send held by freshness check",
    text: [
      "target: dm:@tygg",
      "new messages: 2 newer messages",
      "decision: local hold; review the newer context before retrying",
    ].join("\n"),
  });
  assert.doesNotMatch(JSON.stringify(activity.entry), /newer pending body|second pending body/);
});

test("APM held-envelope projector keeps non-send held actions non-executable retry readouts", () => {
  const envelope = projectApmHeldFreshnessEnvelope({
    producerFactId: "freshness_decision_fact:unit-task-hold",
    action: "task_claim",
    heldMessages: [{ seq: 8, message_id: "pending-task" }],
    newMessageCount: 1,
    omittedMessageCount: 0,
    seenUpToSeq: 8,
  });
  assert.deepEqual(envelope.body.available_actions, ["check_messages", "retry_action"]);

  const activity = projectApmHeldFreshnessActivity({
    producerFactId: envelope.producerFactId,
    action: "task_claim",
    decision: "syncing_hold",
    target: "#proj-runtime",
    messageCount: 1,
  });
  assert.deepEqual(activity.entry, {
    kind: "slock_action",
    producerFactId: envelope.producerFactId,
    title: "Task claim held by freshness check",
    text: [
      "target: #proj-runtime",
      "unreviewed synced context for this target: 1 message",
      "reason: this target's latest synced context was not yet in your reviewed context",
      "action: review the synced context, then retry this action",
    ].join("\n"),
  });
});

test("APM manager mutation gate: reducer-owned gated state writes go through one commit seam", async () => {
  const source = await readFile(new URL("./agentProcessManager.ts", import.meta.url), "utf8");
  const reducerOwnedFields = [
    "isIdle",
    "expectedTerminationReason",
    "outstandingToolUses",
    "compacting",
  ];

  for (const field of reducerOwnedFields) {
    const pattern = new RegExp(`ap\\.gatedSteering\\.${field}\\s*=(?!=)`, "g");
    const matches = [...source.matchAll(pattern)];
    assert.equal(
      matches.length,
      0,
      `${field} must not be written field-by-field in AgentProcessManager`,
    );
  }

  const wholeStateWrites = [...source.matchAll(/ap\.gatedSteering\s*=(?!=)/g)];
  assert.equal(wholeStateWrites.length, 1, "gated steering state must have one whole-state manager write seam");
  assert.equal(
    source.includes("ap.gatedSteering = commitApmGatedSteeringDecisionState(nextState);"),
    true,
    "manager whole-state write must go through the APM state-machine commit primitive",
  );

  assert.equal(
    source.includes("ap.isIdle"),
    false,
    "idle state must not be mirrored on AgentProcess",
  );
  assert.equal(
    source.includes("isIdle: boolean"),
    false,
    "AgentProcess must not declare a separate isIdle source of truth",
  );

  assert.equal(
    source.includes("ap.expectedTerminationReason"),
    false,
    "expected termination reason must not be mirrored on AgentProcess",
  );
  assert.equal(
    source.includes("expectedTerminationReason: ApmExpectedTerminationReason"),
    false,
    "AgentProcess must not declare a separate expectedTerminationReason source of truth",
  );
  assert.equal(
    source.includes("startupTimedOut"),
    false,
    "startup timeout expected termination must be represented by the reducer-owned expectedTerminationReason",
  );

  assert.match(
    source,
    /private readonly lifecycleRecords = new AgentLifecycleRecords</,
    "manager must keep lifecycle facts behind the AgentLifecycleRecords owner",
  );
  const lifecycleFactFields = [
    "activityClientSeqByAgent",
    "terminalRuntimeFailures",
    "runtimeErrorFingerprintFences",
    "pendingStartRebinds",
    "idleAgentConfigs",
    "pendingSpawnCause",
    "agentSpawnFailBackoff",
  ];
  for (const field of lifecycleFactFields) {
    assert.equal(
      new RegExp(`private(?: readonly)? ${field}\\s*=\\s*new Map`).test(source),
      false,
      `${field} must not be reintroduced as an independent manager Map`,
    );
    assert.equal(
      new RegExp(`private get ${field}\\s*\\(`).test(source),
      false,
      `${field} must not be reintroduced as an APM map-shaped lifecycle shim`,
    );
  }

  assert.equal(
    /runtimeExitTraceAttrs\.set\(ap\.runtime,\s*\{[\s\S]*?stop_source:\s*"turn_end"[\s\S]*?expectedTerminationReason:\s*"turn_end"[\s\S]*?\}\)/.test(source),
    false,
    "turn_end process-exit attrs must come from the APM termination projection helper",
  );
  assert.match(
    source,
    /projectApmRuntimeTerminationTrace\(\{\s*reason:\s*"turn_end"\s*\}\)/,
    "turn_end process-stop termination must use the APM termination projection helper",
  );
  assert.match(
    source,
    /markRuntimeProgressStaleIfNeeded[\s\S]*projectApmRuntimeProgressStalledTrace\(/,
    "non-terminating runtime-stall trace attrs must come from the APM projection helper",
  );
  assert.match(
    source,
    /function buildRuntimeStallDiagnostic[\s\S]*projectApmRuntimeStallDiagnostic\(/,
    "runtime-stall diagnostic detail and attrs must come from the APM projection helper",
  );
  assert.equal(
    source.includes("recentDecisionStderr"),
    false,
    "progress-bounded stderr evidence must live inside DecisionErrorWindow, not AgentProcess raw fields",
  );
  assert.equal(
    source.includes("runtimeErrorSinceProgress"),
    false,
    "progress-bounded runtime errors must live inside DecisionErrorWindow, not AgentProcess raw fields",
  );
  assert.match(
    source,
    /private invalidateRecoveryErrorView\(ap: AgentProcess\) \{\s*ap\.decisionErrorWindow\.noteRuntimeProgress\(\);\s*\}/,
    "runtime progress must invalidate recovery error evidence through the DecisionErrorWindow seam",
  );
  assert.equal(
    /function classify(?:RuntimeStallReason|ActivityDetailForTrace)\(/.test(source),
    false,
    "runtime-stall reason and activity-detail classification must stay out of AgentProcessManager",
  );
});

test("APM manager effect gate: gated effects execute through a typed switch", async () => {
  const source = await readFile(new URL("./agentProcessManager.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /private executeApmGatedSteeringEffect\([\s\S]*?effect: ApmGatedSteeringEffect[\s\S]*?switch \(effect\.kind\)/,
    "gated effects must be executed through the typed effect executor",
  );
  assert.match(
    source,
    /case "notify_stdin":[\s\S]*?sendStdinNotification\(agentId\)/,
    "notify_stdin must be the executor path that sends stdin notification",
  );
  assert.match(
    source,
    /case "deliver_stdin":[\s\S]*?const ordinaryMessageCandidates = messages\.filter[\s\S]*?(?:const|let) ordinaryMessages = ap\.notifications\.filterUncontributedMessages[\s\S]*?deliverInboxUpdateViaStdin\([\s\S]*?ordinaryMessages[\s\S]*?effect\.stdinMode/,
    "deliver_stdin must split runtime-profile controls from ordinary queued inbox updates",
  );
  assert.match(
    source,
    /case "deliver_stdin":[\s\S]*?const messages = \[\.\.\.ap\.inbox\][\s\S]*?ap\.notifications\.clearPending\(\)[\s\S]*?ap\.notifications\.clearTimer\(\)/,
    "deliver_stdin executor must own queued-message snapshotting",
  );
  assert.match(
    source,
    /default:[\s\S]*?assertNeverApmEffect\(effect\)/,
    "effect executor must fail compile-time exhaustiveness when the union grows",
  );
  assert.doesNotMatch(
    source,
    /readiness\.effects\.some\(\(effect\) => effect\.kind === "notify_stdin"\)/,
    "manager must not collapse typed effects back into a boolean kind check",
  );
  const compactionFlush = /private flushCompactionBoundaryMessages[\s\S]*?private startRuntimeStartupTimeout/.exec(source)?.[0];
  assert.ok(compactionFlush, "compaction-boundary flush method must exist");
  assert.match(
    compactionFlush,
    /reduceApmGatedCompactionBoundaryFlush/,
    "compaction-boundary flush decisions must come from the APM reducer",
  );
  assert.doesNotMatch(
    compactionFlush,
    /sendStdinNotification\(agentId\)/,
    "compaction-boundary flush must execute typed effects instead of sending directly",
  );
});

test("APM reducer seam: assistant continuation preserves tool and compaction state", () => {
  const active = {
    ...createInitialApmGatedSteeringState(),
    outstandingToolUses: 1,
    compacting: true,
  };

  const reduction = reduceApmGatedAssistantContinuation(active);
  assert.equal(
    reduction.nextState.outstandingToolUses,
    1,
    "assistant continuation must not imply tool-output completion",
  );
  assert.equal(
    reduction.nextState.compacting,
    true,
    "assistant continuation preserves compaction flag; manager-owned inference clears it first when active",
  );
});

test("Claude APM baseline: activity sequence on startup is starting→working", async () => {
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const seq = activitySequence(sent);
    assert.ok(seq.length >= 1, "at least one activity should be emitted on startup");
    assert.equal(seq[0].activity, "working", "first activity is working with 'Starting…' detail");
    assert.match(seq[0].detail, /Starting/i);
  });
});

test("Claude APM baseline: tool_call event broadcasts a new working activity", async () => {
  // Trace-as-linear-projection: the gatedSteering tool_wait state must emit a
  // visible 'working' activity to the upstream agent:activity stream so the
  // status dot can show tool execution. The exact detail string is derived by
  // `getToolActivityLabel` (shared/toolDisplay.ts) and is not pinned here —
  // that label belongs to toolDisplay's own tests. What this test pins is the
  // APM-side emit point: a tool_call ParsedEvent produces a fresh upstream
  // 'working' activity, not silence.
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const baseline = activitySequence(sent).length;

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const seq = activitySequence(sent);
    assert.ok(seq.length > baseline, "tool_call should emit a new activity");
    const toolActivity = seq[seq.length - 1];
    assert.equal(toolActivity.activity, "working");
    assert.ok(toolActivity.detail.length > 0, "tool activity carries a non-empty detail label");
  });
});

function activityMessages(sent: MachineToServerMessage[]) {
  return sent.filter(
    (msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APM 1.6 6a — internal_progress drives a live "working" signal during long turns
// ─────────────────────────────────────────────────────────────────────────────

test("APM 1.6 6a: internal_progress during a quiet long turn broadcasts a working progress activity", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    // Drop the agent out of the startup "working" state so the quiet-turn
    // transition is observable (mirror the real post-startup idle baseline).
    (manager as any).broadcastActivity("agent-1", "online", "Idle", [], undefined, "idle");
    const baseline = activitySequence(sent).length;

    driver.parsedLines.set("progress", [
      { kind: "internal_progress", source: "claude_stream_event", itemType: "content_block_delta", payloadBytes: 42 },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("progress\n"));
    await flush();

    const seq = activitySequence(sent);
    assert.ok(seq.length > baseline, "internal_progress must emit a new activity, not stay silent");
    const progress = seq[seq.length - 1];
    assert.equal(progress.activity, "working", "internal_progress drives a working signal (6a)");

    // Structured/bounded — no raw partial-message content leaks into the activity.
    const msg = activityMessages(sent).at(-1)!;
    assert.equal(msg.detailKind, "runtime_progress");
    assert.doesNotMatch(JSON.stringify(msg), /partial|content_block_delta/i);
    // 6a is generic progress — never fabricates a subagent marker.
    const statusEntry = (msg.entries ?? []).find((e) => e.kind === "status") as any;
    assert.equal(statusEntry?.subagent, undefined, "generic progress must not be marked as a subagent");
  });
});

test("APM 1.6 6a: internal_progress does not spam a rendered status line every tick", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    (manager as any).broadcastActivity("agent-1", "online", "Idle", [], undefined, "idle");
    const baseline = activitySequence(sent).length;

    driver.parsedLines.set("progress", [
      { kind: "internal_progress", source: "claude_stream_event", itemType: "content_block_delta", payloadBytes: 10 },
    ]);
    for (let i = 0; i < 5; i++) {
      driver.processes[0].stdout.emit("data", Buffer.from("progress\n"));
      await flush();
    }

    const seq = activitySequence(sent);
    assert.equal(
      seq.length - baseline,
      1,
      "only the first internal_progress transitions into the working signal; the heartbeat keeps it live",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// APM 1.6 6b — subagent_progress broadcasts a subagent-marked activity
// ─────────────────────────────────────────────────────────────────────────────

test("APM 1.6 6b: subagent_progress broadcasts a subagent-marked working activity carrying lineage ids", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const baseline = activitySequence(sent).length;

    driver.parsedLines.set("subagent", [
      {
        kind: "subagent_progress",
        source: "claude_task_lifecycle",
        phase: "started",
        parentToolUseId: "toolu_outer_1",
        subagentType: "Explore",
        taskId: "task_1",
        lastToolName: "Grep",
        payloadBytes: 88,
      },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("subagent\n"));
    await flush();

    const seq = activitySequence(sent);
    assert.ok(seq.length > baseline, "subagent_progress must emit a new activity");
    const msg = activityMessages(sent).at(-1)!;
    assert.equal(msg.activity, undefined);
    assert.equal(msg.activityKind, undefined);
    assert.equal(msg.detailKind, "subagent_activity");

    const statusEntry = (msg.entries ?? []).find((e) => e.kind === "status") as any;
    assert.ok(statusEntry, "subagent activity produces a status entry");
    assert.deepEqual(statusEntry.subagent, {
      parentToolUseId: "toolu_outer_1",
      subagentType: "Explore",
      taskId: "task_1",
      phase: "started",
    });
    // No raw content — only closed ids / bounded tokens.
    assert.doesNotMatch(JSON.stringify(statusEntry), /prompt|output/i);
  });
});

test("APM 1.6 6b: inner subagent tool_call carries the lineage marker on its tool_start entry", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    driver.parsedLines.set("inner-tool", [
      {
        kind: "tool_call",
        name: "Read",
        input: { file_path: "/x.ts" },
        subagent: { parentToolUseId: "toolu_outer_2", subagentType: "Plan", phase: "active" },
      },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("inner-tool\n"));
    await flush();

    const msg = activityMessages(sent).at(-1)!;
    assert.equal(msg.detailKind, "subagent_activity");
    const toolStart = (msg.entries ?? []).find((e) => e.kind === "tool_start") as any;
    assert.ok(toolStart, "subagent tool call produces a tool_start entry");
    assert.deepEqual(toolStart.subagent, { parentToolUseId: "toolu_outer_2", subagentType: "Plan", phase: "active" });
  });
});

test("APM 1.6 6b: a plain tool_call WITHOUT lineage stays flat (no subagent marker, ordinary detailKind)", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    driver.parsedLines.set("flat-tool", [
      { kind: "tool_call", name: "Read", input: { file_path: "/x.ts" } },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("flat-tool\n"));
    await flush();

    const msg = activityMessages(sent).at(-1)!;
    assert.notEqual(msg.detailKind, "subagent_activity", "flat tool call must not be marked as subagent activity");
    const toolStart = (msg.entries ?? []).find((e) => e.kind === "tool_start") as any;
    assert.ok(toolStart, "ordinary tool call still produces a tool_start entry");
    assert.equal(toolStart.subagent, undefined, "no lineage → no subagent marker (flat)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activity dedup clock survives self-restart (#proj-o11y:a1e54b59)
//
// The server dedupes agent:activity by (launchId, clientSeq). Daemon-internal
// restarts (cold-start-resume / idle-auto-restart / queued-continuation /
// runtime-profile restart) REUSE the server-issued launchId but spawn a fresh
// process. The old per-`ap` clientSeq reset to 0 on each respawn, so the reused
// launchId's (launchId, clientSeq) window collided and the server dropped the
// post-restart activity as stale — "activity log stops updating after
// error→restart". The clientSeq is now a manager-level per-agent monotonic
// clock that never resets on respawn, keeping the dedup key fresh under a
// reused launchId. (launchId = identity/gate token ⊥ clientSeq = dedup clock.)
// ─────────────────────────────────────────────────────────────────────────────

function activityClientSeqs(
  sent: MachineToServerMessage[],
): Array<{ clientSeq: number; launchId: string | undefined }> {
  return sent
    .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
    .filter((msg) => typeof msg.clientSeq === "number")
    .map((msg) => ({ clientSeq: msg.clientSeq as number, launchId: msg.launchId }));
}

test("activity dedup clock: clientSeq stays strictly monotonic across a self-restart that reuses launchId", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    // Launch with an explicit launchId — the value daemon-internal restarts reuse.
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );
    await flush();

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const beforeRestart = activityClientSeqs(sent);
    assert.ok(beforeRestart.length >= 1, "activity emitted before restart");
    const maxBefore = Math.max(...beforeRestart.map((e) => e.clientSeq));

    // Self-restart: the process exits cleanly, then the daemon respawns the SAME
    // agent REUSING launch-1 (mirrors cold-start-resume / idle-auto-restart /
    // queued-continuation, which all thread ap.launchId back into startAgent).
    driver.processes[0].kill();
    await flush();
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );
    await flush();
    driver.processes[1].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const all = activityClientSeqs(sent);
    // The collision precondition: every emit carried the reused launchId.
    assert.ok(all.every((e) => e.launchId === "launch-1"), "all activity reused launch-1");

    // Post-restart emits continued PAST the pre-restart highwater — the dedup
    // clock never reset, so (launch-1, clientSeq) is always fresh.
    const afterRestart = all.slice(beforeRestart.length);
    assert.ok(afterRestart.length >= 1, "activity emitted after restart");
    assert.ok(
      afterRestart.every((e) => e.clientSeq > maxBefore),
      `post-restart clientSeq must exceed pre-restart max ${maxBefore}; got ${afterRestart.map((e) => e.clientSeq).join(",")}`,
    );

    // The regression guard: strictly increasing across the whole stream. The old
    // per-ap counter reset to 1 after restart → this sequence would not hold.
    const seqs = all.map((e) => e.clientSeq);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(
        seqs[i] > seqs[i - 1],
        `clientSeq must be strictly increasing across restart; broke at index ${i}: ${seqs.join(",")}`,
      );
    }
  });
});

test("activity dedup clock: launchless explicit Stop/Start keeps clientSeq monotonic within one daemon instance", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);

    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    // Mirror the field high-water from task #577 without emitting hundreds of
    // redundant activity frames. The next real frame must be 583.
    (manager as any).lifecycleRecords.activityClientSeqs.set("agent-1", 582);
    const seededAt = activityClientSeqs(sent).length;
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const beforeFirstStop = activityClientSeqs(sent).slice(seededAt);
    assert.ok(beforeFirstStop.length >= 1, "activity emitted after seeding the field high-water");
    assert.equal(beforeFirstStop[0]?.clientSeq, 583);
    const firstHighWater = Math.max(...beforeFirstStop.map((entry) => entry.clientSeq));

    // A launchless explicit Stop/Start remains in the daemon-instance activity
    // generation. The stop marker and the restarted process must continue past
    // the existing high-water rather than resetting to 1.
    const firstRestartAt = activityClientSeqs(sent).length;
    await manager.stopAgent("agent-1");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.processes[1].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const afterFirstRestart = activityClientSeqs(sent).slice(firstRestartAt);
    assert.ok(afterFirstRestart.length >= 2, "stop marker and restarted activity emitted");
    assert.ok(
      afterFirstRestart.every((entry) => entry.clientSeq > firstHighWater),
      `first launchless restart must continue above ${firstHighWater}; got ${afterFirstRestart.map((entry) => entry.clientSeq).join(",")}`,
    );
    const secondHighWater = Math.max(...afterFirstRestart.map((entry) => entry.clientSeq));

    // A second explicit cycle pins the real incident shape: repeated Stop/Start
    // cannot reopen the same stale range.
    const secondRestartAt = activityClientSeqs(sent).length;
    await manager.stopAgent("agent-1");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.processes[2].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();

    const afterSecondRestart = activityClientSeqs(sent).slice(secondRestartAt);
    assert.ok(afterSecondRestart.length >= 2, "second stop marker and restarted activity emitted");
    assert.ok(
      afterSecondRestart.every((entry) => entry.clientSeq > secondHighWater),
      `second launchless restart must continue above ${secondHighWater}; got ${afterSecondRestart.map((entry) => entry.clientSeq).join(",")}`,
    );

    const postSeed = activityClientSeqs(sent).slice(seededAt);
    assert.ok(postSeed.every((entry) => entry.launchId === undefined), "test must stay on the launchless path");
    for (let i = 1; i < postSeed.length; i += 1) {
      assert.ok(
        postSeed[i]!.clientSeq > postSeed[i - 1]!.clientSeq,
        `clientSeq must stay strictly increasing across both explicit restarts: ${postSeed.map((entry) => entry.clientSeq).join(",")}`,
      );
    }

    const produced = sent.filter(
      (msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
        msg.type === "agent:activity" && typeof msg.clientSeq === "number" && msg.clientSeq >= 583,
    );
    assert.ok(produced.length >= 5, "expected the seeded frame plus both stop/start cycles");
    assert.ok(
      produced.every((msg) => msg.daemonInstanceId === "daemon-instance-1"),
      "every frame must remain in the same daemon-instance generation",
    );
  }, { daemonInstanceId: "daemon-instance-1" });
});

test("Claude APM PR1 trace artifacts: activity sequence baseline is harness-generated", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    const recorder = new ApmTraceRecorder({
      scenario: "claude-apm-pr1-activity-sequence",
      agentId: "agent-1",
      sent,
      correlationId: "trace-claude-apm-pr1",
    });

    await recorder.step(
      {
        inputKind: "RuntimeStart",
        driver: "claude",
        summary: "start_agent",
      },
      async () => {
        await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
        await flush();
      },
    );

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "tool_call",
      },
      async () => {
        driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
        await flush();
      },
    );

    const ap = getProcess(manager, "agent-1");
    const artifacts = recorder.buildFinal({
      agentStatus: "active",
      gatedSteeringPhase: ap.gatedSteering.phase,
      outstandingToolUses: ap.gatedSteering.outstandingToolUses,
    });

    const emittedSequence = activitySequence(sent);
    assert.deepEqual(
      artifacts.surfaceSnapshots["agent-activity.sequence.json"].sequence.map((entry) => ({
        activity: entry.activity,
        detail: entry.detail,
      })),
      emittedSequence,
      "surface snapshot must be generated from the actual emitted agent:activity sequence",
    );
    assert.equal(artifacts.inputs.length, 2);
    assert.equal(artifacts.transitionTrace.length, emittedSequence.length);
    assert.equal(artifacts.writerTrace.length, 0, "PR1 daemon-side trace does not write lifecycle surfaces");

    const predicateResults = evaluateApmTracePredicateFixtures(artifacts);
    assert.deepEqual(
      predicateResults.map((result) => [result.name, result.ok, result.violations] as const),
      [
        ["INV-NO-APM-DURABLE-WRITE", true, []],
        ["INV-NO-LIFECYCLE-STDIN-OR-KILL", true, []],
        ["INV-NO-INDEPENDENT-DOT-DERIVE", true, []],
      ],
    );

    const noApmDurableGreen = predicateResult(artifacts, "INV-NO-APM-DURABLE-WRITE");
    assert.equal(noApmDurableGreen.ok, true);
    assert.deepEqual(noApmDurableGreen.violations, []);

    const noApmDurableRed = cloneTraceArtifacts(artifacts);
    const firstTransition = noApmDurableRed.transitionTrace[0];
    assert.ok(firstTransition, "red fixture needs at least one transition row");
    const firstOutput = firstTransition.projectorOutputs[0];
    assert.ok(firstOutput, "red fixture needs at least one projector output");
    firstTransition.projectorOutputs.push({
      ...firstOutput,
      projectorId: "projector-forbidden-db-status",
      surface: "db_status",
    } as unknown as typeof firstOutput);
    const noApmDurableRedResult = predicateResult(noApmDurableRed, "INV-NO-APM-DURABLE-WRITE");
    assert.equal(noApmDurableRedResult.ok, false);
    assert.deepEqual(noApmDurableRedResult.violations, [
      `transition ${firstTransition.seq} projected directly to db_status`,
    ]);

    const noLifecycleRuntimeControlGreen = predicateResult(artifacts, "INV-NO-LIFECYCLE-STDIN-OR-KILL");
    assert.equal(noLifecycleRuntimeControlGreen.ok, true);
    assert.deepEqual(noLifecycleRuntimeControlGreen.violations, []);

    const noLifecycleRuntimeControlRed = cloneTraceArtifacts(artifacts);
    noLifecycleRuntimeControlRed.writerTrace.push({
      seq: 1,
      producerFactId: "fact-red-lifecycle",
      correlationId: "trace-claude-apm-pr1",
      sourceEffectIds: ["effect-red-lifecycle"],
      sourceProjectorIds: ["projector-red-lifecycle"],
      writes: [
        {
          surface: "kill",
          value: "SIGTERM",
          clauseId: "SMR-004",
        },
      ],
    });
    const noLifecycleRuntimeControlRedResult = predicateResult(
      noLifecycleRuntimeControlRed,
      "INV-NO-LIFECYCLE-STDIN-OR-KILL",
    );
    assert.equal(noLifecycleRuntimeControlRedResult.ok, false);
    assert.deepEqual(noLifecycleRuntimeControlRedResult.violations, [
      "writer row 1 wrote forbidden runtime-control surface kill",
    ]);

    const noIndependentDotGreen = predicateResult(artifacts, "INV-NO-INDEPENDENT-DOT-DERIVE");
    assert.equal(noIndependentDotGreen.ok, true);
    assert.deepEqual(noIndependentDotGreen.violations, []);

    const noIndependentDotRed = cloneTraceArtifacts(artifacts);
    const firstSnapshotEntry = noIndependentDotRed.surfaceSnapshots["agent-activity.sequence.json"].sequence[0];
    assert.ok(firstSnapshotEntry, "red fixture needs at least one activity snapshot row");
    firstSnapshotEntry.producerFactId = "";
    const noIndependentDotRedResult = predicateResult(noIndependentDotRed, "INV-NO-INDEPENDENT-DOT-DERIVE");
    assert.equal(noIndependentDotRedResult.ok, false);
    assert.deepEqual(noIndependentDotRedResult.violations, [
      `activity sequence entry 1 (${firstSnapshotEntry.activity}:${firstSnapshotEntry.detail}) missing producerFactId`,
    ]);

    const delta = buildBehaviorDeltaRow({
      scenario: "claude-apm-pr1-activity-sequence",
      oldTrace: artifacts.transitionTrace,
      newTrace: artifacts.transitionTrace,
      surfaceSnapshots: artifacts.surfaceSnapshots,
      classification: "preserved",
      clauseOrConceptAnchor: "SMR-007",
      reviewerSign: "test-harness",
    });
    assert.deepEqual(Object.keys(delta), [
      "scenario",
      "old_trace_hash",
      "new_trace_hash",
      "surface_snapshot_hash",
      "classification",
      "clause_or_concept_anchor",
      "reviewer_sign",
    ]);
    assert.equal(delta.classification, "preserved");

    const serialized = serializeApmTraceArtifacts(artifacts, [delta]);
    assert.deepEqual(Object.keys(serialized), [
      "inputs.jsonl",
      "transition.trace.jsonl",
      "writer.trace.jsonl",
      "surface.snapshots/agent-activity.sequence.json",
      "surface.snapshots/gated-effects.sequence.json",
      "final.snapshot.json",
      "behavior-delta.table.json",
    ]);
    assert.match(serialized["inputs.jsonl"], /"inputKind":"RuntimeStart"/);
    assert.match(serialized["transition.trace.jsonl"], /"projector":"activity-sequence"/);
    assert.equal(serialized["writer.trace.jsonl"], "", "empty writer trace serializes as an empty JSONL artifact");
    assert.match(serialized["surface.snapshots/agent-activity.sequence.json"], /"clauseId":"SMR-003"/);
    assert.match(serialized["surface.snapshots/gated-effects.sequence.json"], /"clauseId":"SMR-002"/);
    assert.match(serialized["behavior-delta.table.json"], /"classification":"preserved"/);
  });
});

test("Claude APM trace oracle: direct busy stdin no longer waits for a tool boundary", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    const recorder = new ApmTraceRecorder({
      scenario: "claude-apm-direct-busy-delivery",
      agentId: "agent-1",
      sent,
      correlationId: "trace-claude-apm-direct-busy-delivery",
      observedGatedEffects: () => observedGatedEffectsFromTrace(sink),
    });

    await recorder.step(
      {
        inputKind: "RuntimeStart",
        driver: "claude",
        summary: "start_agent",
      },
      async () => {
        await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
        await flush();
      },
    );

    driver.parsedLines.set("tool-start", [
      { kind: "tool_call", name: "shell", input: { command: "pnpm test" } },
    ]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "tool_call",
      },
      async () => {
        driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
        await flush();
      },
    );

    await recorder.step(
      {
        inputKind: "Delivery",
        driver: "claude",
        summary: "queue direct message during tool_wait",
      },
      async () => {
        manager.deliverMessage("agent-1", makeMessage("tool-boundary body must stay queued"));
        await flush();
        assert.equal(driver.encodedCalls.length, 0);
        assert.equal((manager as any).sendStdinNotification("agent-1"), true);
        assert.equal(driver.encodedCalls.length, 1);
        assert.equal(driver.encodedCalls[0].mode, "busy");
        assert.match(driver.encodedCalls[0].text, /Raft inbox notice/);
      },
    );

    driver.parsedLines.set("tool-result", [
      { kind: "tool_output", name: "shell" },
    ]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "tool_output",
      },
      async () => {
        const before = driver.encodedCalls.length;
        driver.processes[0].stdout.emit("data", Buffer.from("tool-result\n"));
        await flush();
        assert.equal(driver.encodedCalls.length, before, "tool_output must not be a second delivery trigger");
      },
    );

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "compaction_started",
      },
      async () => {
        driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
        await flush();
      },
    );

    await recorder.step(
      {
        inputKind: "Delivery",
        driver: "claude",
        summary: "queue message during compaction",
      },
      async () => {
        manager.deliverMessage("agent-1", makeMessage("compaction body must stay queued"));
        await flush();
        assert.equal(driver.encodedCalls.length, 1);
      },
    );

    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "compaction_finished",
      },
      async () => {
        const before = driver.encodedCalls.length;
        driver.processes[0].stdout.emit("data", Buffer.from("compact-finish\n"));
        await flush();
        assert.equal(driver.encodedCalls.length, before + 1);
        assert.match(driver.encodedCalls[before].text, /Inbox update:/);
        assert.match(driver.encodedCalls[before].text, /Raft inbox notice/);
        assert.doesNotMatch(driver.encodedCalls[before].text, /System notification/);
        assert.doesNotMatch(driver.encodedCalls[before].text, /compaction body must stay queued/);
      },
    );

    await recorder.step(
      {
        inputKind: "Delivery",
        driver: "claude",
        summary: "queue message for turn_end fallback",
      },
      async () => {
        manager.deliverMessage("agent-1", makeMessage("turn-end fallback body"));
        await flush();
        assert.equal(driver.encodedCalls.length, 2);
        assert.equal((manager as any).sendStdinNotification("agent-1"), true);
        assert.equal(driver.encodedCalls.length, 3);
        assert.equal(driver.encodedCalls[2].mode, "busy");
      },
    );

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    await recorder.step(
      {
        inputKind: "ParsedEvent",
        driver: "claude",
        summary: "turn_end",
      },
      async () => {
        const before = driver.encodedCalls.length;
        driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
        await flush();
        assert.equal(driver.encodedCalls.length, before + 1, "turn_end keeps the existing unread-debt idle handoff");
        assert.equal(driver.encodedCalls[before].mode, "idle");
      },
    );

    const ap = getProcess(manager, "agent-1");
    const artifacts = recorder.buildFinal({
      gatedSteeringPhase: ap.gatedSteering.phase,
      inboxLength: ap.inbox.length,
      encodedStdinWrites: driver.encodedCalls.length,
    });

    const gatedEffects = artifacts.surfaceSnapshots["gated-effects.sequence.json"].sequence;
    assert.deepEqual(
      gatedEffects.map((entry) => ({
        kind: entry.kind,
        reason: entry.reason,
        stdinMode: entry.stdinMode,
      })),
      [
        { kind: "notify_stdin", reason: "compaction_finished", stdinMode: "busy" },
        { kind: "deliver_stdin", reason: "turn_end", stdinMode: "idle" },
      ],
    );
    assert.deepEqual(
      artifacts.transitionTrace
        .flatMap((row) => row.effects)
        .filter((effect) => effect.kind === "notify_stdin" || effect.kind === "deliver_stdin")
        .map((effect) => ({
          kind: effect.kind,
          reason: effect.reason,
          target: effect.target,
          clauseId: effect.clauseId,
        })),
      [
        { kind: "notify_stdin", reason: "compaction_finished", target: "runtime-stdin", clauseId: "SMR-002" },
        { kind: "deliver_stdin", reason: "turn_end", target: "runtime-stdin", clauseId: "SMR-002" },
      ],
    );
    assert.equal(ap.inbox.length, 3);
    assert.equal(driver.encodedCalls.length, 4);
    assert.deepEqual(driver.encodedCalls.map((call) => call.mode), ["busy", "busy", "busy", "idle"]);
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block 4 — APM consumes ParsedEvent.error → status/activity/recovery
// (per Hao msg=2eb549a2 NARROW scope: only the APM consumer-side reaction to
// an error ParsedEvent; parser heuristic itself stays in claudeEventNormalizer
// tests. Per tygg msg=2aadf9eb: trace-as-linear-projection — verify the error
// activity is in the chronological sequence and the runtime state captures it.)
// ─────────────────────────────────────────────────────────────────────────────

test("Claude APM baseline: ParsedEvent.error broadcasts an error activity with the cause", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    driver.parsedLines.set("error-line", [
      { kind: "error", message: "API Error: Unable to connect to API (ECONNRESET)" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("error-line\n"));
    await flush();

    const seq = activitySequence(sent);
    const errorActivity = seq.find((entry) => entry.activity === "error");
    assert.ok(errorActivity, "error activity should appear in the upstream sequence");
    assert.match(
      errorActivity!.detail,
      /API Error: Unable to connect to API \(ECONNRESET\)/,
      "error detail carries the cause text from the ParsedEvent",
    );
  });
});

test("Claude APM baseline: ParsedEvent.error captures lastRuntimeError on the AgentProcess", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    driver.parsedLines.set("error-line", [
      { kind: "error", message: "Budget limit exceeded" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("error-line\n"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.match(
      ap.lastRuntimeError ?? "",
      /Budget limit exceeded/,
      "lastRuntimeError captures the error detail for stalled-recovery diagnostics",
    );
  });
});

test("Claude APM: provider context-overflow error is recoverable and bounded in Activity", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const providerOverflow = "API Error: 400 maximum context length is 100 tokens; you requested 101 tokens";
    driver.parsedLines.set("overflow-error", [
      { kind: "error", message: providerOverflow },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("overflow-error\n"));
    await flush();

    const ap = getProcess(manager, "agent-1");
    assert.ok(ap, "overflow must not terminal-cleanup the live Claude process");
    assert.equal(ap.runtimeErrorDeliveryBackoff.kind, "backing_off");
    assert.equal(ap.runtimeErrorDeliveryBackoff.reason, "runtime_error");

    const errorActivity = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .find((msg) => projectTestActivity(msg) === "error");
    assert.ok(errorActivity, "bounded error activity should be emitted");
    assert.match(errorActivity.detail, /Claude Code reported input that is too large/);
    assert.doesNotMatch(errorActivity.detail, /API Error|maximum context length|you requested/);
    assert.doesNotMatch(JSON.stringify(errorActivity.entries ?? []), /API Error|maximum context length|you requested/);
    assert.equal(sent.some((m) => m.type === "agent:status" && (m as any).status === "inactive"), false);

    const runtimeError = sink.getAllSpans()
      .flatMap((span) => span.events)
      .find((event) => event.name === "runtime.error");
    assert.ok(runtimeError, "raw diagnostic payload must still reach runtime.error trace");
    assert.equal(runtimeError.attrs?.runtime_error_class, "InputTooLargeError");
    assert.equal(
      String(runtimeError.attrs?.runtime_error_message_excerpt).includes("maximum context length"),
      true,
      "trace keeps the provider-shaped diagnostic excerpt for debugging",
    );

    const sentBeforeTurnEnd = sent.length;
    driver.parsedLines.set("overflow-turn-end", [
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("overflow-turn-end\n"));
    await flush();

    const rebroadcastErrorActivity = sent
      .slice(sentBeforeTurnEnd)
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .find((msg) => projectTestActivity(msg) === "error");
    assert.ok(rebroadcastErrorActivity, "turn_end should keep the latest runtime error visible");
    assert.match(rebroadcastErrorActivity.detail, /Claude Code reported input that is too large/);
    assert.doesNotMatch(rebroadcastErrorActivity.detail, /API Error|maximum context length|you requested/);
    assert.doesNotMatch(JSON.stringify(rebroadcastErrorActivity.entries ?? []), /API Error|maximum context length|you requested/);
  }, { tracer });
});

test("Claude APM: repeated provider context-overflow fingerprint fence stays bounded in Activity", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const providerOverflow = "API Error: 400 maximum context length is 100 tokens; you requested 101 tokens";
    for (let i = 0; i < 3; i += 1) {
      const line = `overflow-error-${i}`;
      driver.parsedLines.set(line, [
        { kind: "error", message: providerOverflow },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    }

    const errorActivities = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .filter((msg) => projectTestActivity(msg) === "error");
    assert.ok(errorActivities.length > 0, "fingerprint fence should surface an error activity");
    const latestErrorActivity = errorActivities.at(-1)!;
    assert.match(latestErrorActivity.detail, /Claude Code reported input that is too large/);
    assert.doesNotMatch(latestErrorActivity.detail, /API Error|maximum context length|you requested/);
    assert.doesNotMatch(JSON.stringify(latestErrorActivity.entries ?? []), /API Error|maximum context length|you requested/);
    assert.doesNotMatch(JSON.stringify(errorActivities), /API Error|maximum context length|you requested/);
  });
});

test("Claude APM baseline: error followed by turn_end shows error before a non-error activity in the upstream sequence", async () => {
  // Trace-as-linear-projection: after an error ParsedEvent fires the runtime
  // emits an 'error' activity. When the turn ends, the runtime should NOT
  // stay stuck in 'error' — the linear upstream sequence has the error entry
  // followed by at least one non-error activity (typically online/idle after
  // process exit, or working for a recovery flow). This pin doesn't depend
  // on the AgentProcess survival semantics (turn_end may exit the process
  // for per-turn drivers; for Claude persistent runtime the AgentProcess
  // typically survives, but this test only inspects the upstream stream).
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    // Use a generic transient error rather than an auth-shaped one — auth
    // errors trigger terminal SIGTERM and exit the process before any
    // recovery activity can be emitted (different branch of error handling).
    driver.parsedLines.set("error-line", [
      { kind: "error", message: "Transient provider error: upstream timed out" },
    ]);
    driver.parsedLines.set("turn-end", [
      { kind: "turn_end", sessionId: "session-1" },
    ]);

    driver.processes[0].stdout.emit("data", Buffer.from("error-line\n"));
    await flush();
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const seq = activitySequence(sent);
    const errorIdx = seq.findIndex((entry) => entry.activity === "error");
    assert.ok(errorIdx >= 0, "error activity must appear in the upstream sequence");

    const ap = getProcess(manager, "agent-1");
    if (ap) {
      // Persistent runtime survived turn_end (non-terminal error path): the
      // gated steering phase must leave 'error' so the next turn isn't stuck.
      assert.notEqual(
        ap.gatedSteering.phase,
        "error",
        "non-terminal error path: phase must leave 'error' once turn_end arrives",
      );
    } else {
      // Terminal error path: process was torn down. The recovery signal is in
      // the upstream sequence (e.g. 'offline' or another non-error activity).
      const tailAfterError = seq.slice(errorIdx + 1);
      assert.ok(
        tailAfterError.some((entry) => entry.activity !== "error"),
        "terminal error path: upstream sequence must include a non-error activity after the error",
      );
    }
  });
});

// B.5 reproduction (RED until the daemon fix): a STICKY terminal error (auth-class
// — token/login/credential/invalid-key, or model-not-supported) leaves an
// alive-idle process. recentStderr is never reset within a process lifetime, so
// classifyStickyTerminalFailure permanently gates delivery — even a user message
// after the underlying cause is resolved (e.g. a delinquent account that surfaced
// as an auth failure is restored) re-errors and is never retried. (Plain
// quota/usage-limit is NON-sticky and already auto-retries — verified — so it is
// NOT the latch.) Per RS-clause: a user-driven turn MUST re-evaluate (recover);
// autonomous retry stays suppressed (churn). Pairs with the daemon fix (XX).
test("B.5: user message to an agent latched by a stale prior-turn sticky terminal error (auth-class) must re-evaluate and recover, not stay permanently gated", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    // Sticky terminal error (auth-class — e.g. a delinquent account surfacing as
    // an auth failure) from a PRIOR turn that left the process alive-idle.
    // recentStderr is never reset within a process lifetime, so the sticky gate
    // re-fires on every later delivery even after the underlying cause is fixed.
    ap.recentStderr = ["Invalid API key · authentication failed"];

    const encodedBefore = driver.encodedCalls.length;
    const sentBefore = sent.length;
    await manager.deliverMessage("agent-1", makeMessage("please continue (user retried after recharge)"));
    await flush();

    const newSent = sent.slice(sentBefore);
    const reErrored = newSent.some(
      (m) => m.type === "agent:activity" && (m as { activity?: string }).activity === "error",
    );
    assert.equal(reErrored, false, "stale prior-turn terminal error must not permanently re-gate a new user turn");
    assert.equal(
      driver.encodedCalls.length > encodedBefore,
      true,
      "a recovery turn must be attempted for the user message after the underlying cause cleared",
    );
  });
});

// B.5 churn protection (test ③, per tygg + Kai): a transient/autonomous wake
// (reminder / system nudge — isTransientDelivery) hitting an auth-class sticky
// agent must stay SUPPRESSED. Only a user-driven (non-transient) turn re-evaluates
// and un-sticks (test ② above); autonomous wakes must NOT trigger a recovery turn
// or clear the sticky source, so the fix cannot regress into a retry-storm.
test("B.5 churn: a transient/autonomous wake on an auth-class sticky agent stays suppressed (no recovery turn, sticky source preserved)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["Invalid API key · authentication failed"];

    const encodedBefore = driver.encodedCalls.length;
    // Transient = autonomous wake (reminder / system), not a user turn.
    await manager.deliverMessage("agent-1", makeMessage("autonomous wake"), { transient: true });
    await flush();

    assert.equal(
      driver.encodedCalls.length,
      encodedBefore,
      "autonomous/transient wake must not start a recovery turn on a sticky agent (churn protection)",
    );
    assert.deepEqual(
      ap.recentStderr,
      ["Invalid API key · authentication failed"],
      "autonomous/transient wake must not clear the sticky source (only a user-driven turn re-evaluates)",
    );
  });
});

// Antigravity-class startup-timeout status-masking (close-handler integration).
// When startup times out, the daemon marks the agent error/inactive and then
// terminates the runtime. Antigravity's `agy` exits with code 0 when killed,
// which previously routed the close handler down the clean-exit path and
// broadcast "online / Process idle" — masking the startup failure on the status
// dot and the runner-availability view. A startup-timeout termination must never
// be treated as a clean exit, regardless of the killed process's exit code.
test("startup-timeout termination that exits code 0 must not be masked by a clean online/idle status", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    // Daemon-detected startup timeout: the reducer records the termination
    // reason and the agent was already surfaced as error/inactive; the daemon
    // then terminates the runtime, which exits with code 0 (as `agy` does on kill).
    (manager as any).commitGatedSteeringDecisionState("agent-1", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "startup_timeout",
    });

    const sentBefore = sent.length;
    driver.processes[0].kill(); // emits exit(0) + close(0)
    await flush();

    const after = sent
      .slice(sentBefore)
      .filter(
        (m): m is Extract<MachineToServerMessage, { type: "agent:activity" }> => m.type === "agent:activity",
      );
    assert.equal(
      after.some((m) => m.activity === "online"),
      false,
      "startup-timeout close (code 0) must not overwrite error/inactive with a clean online/idle status",
    );
  });
});

test("startup-timeout cleanup keeps a retryable idle config for the next user delivery", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitGatedSteeringDecisionState("agent-1", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "startup_timeout",
    });

    driver.processes[0].kill();
    await flush();

    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.ok(cached, "startup-timeout cleanup should keep the agent wakeable");
    assert.equal(cached.sessionId, "session-1");
    assert.equal(cached.config.agentCredentialKey, undefined, "cached retry config must not retain managed runner credentials");

    cached.config.agentCredentialKey = "sk_agent_retry";
    cached.config.agentCredentialId = "cred-retry";
    const result = await manager.deliverMessage("agent-1", makeMessage("retry after timeout"));
    assert.equal(result, true);
    assert.equal(lastDeliveryOutcome(sink), "auto_restart_from_idle");
  }, { tracer });
});

test("runtime error fingerprint fence is cleared when a process exits without recovery residency", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );
    const ap = getProcess(manager, "agent-1");
    (manager as any).lifecycleRecords.setRuntimeErrorFingerprintFence("agent-1", {
      fingerprint: "runtime-error:fingerprint",
      attempts: 1,
      lastRuntimeError: "same runtime error",
      detail: "same runtime error detail",
      launchId: ap.launchId,
    });

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    assert.equal(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1"),
      undefined,
      "a fingerprint fence must not remain after the process is gone with no idle or terminal residency",
    );

    await manager.startAgent("agent-2", makeConfig({ sessionId: "session-2" }));
    assert.ok(getProcess(manager, "agent-2"), "unrelated agent starts must not be blocked by a stale fence");
  });
});

test("stale runtime error fingerprint fence is repaired before unrelated visible-consume", async () => {
  await withManager(async ({ manager }) => {
    (manager as any).lifecycleRecords.setRuntimeErrorFingerprintFence(
      "agent-with-stale-fence",
      {
        fingerprint: "runtime-error:fingerprint",
        attempts: 1,
        lastRuntimeError: "same runtime error",
        detail: "same runtime error detail",
        launchId: "launch-stale",
      },
    );

    assert.doesNotThrow(() => {
      (manager as any).consumeVisibleMessages("unrelated-agent", {
        target: "#general",
        boundarySeq: 1,
        messages: [{
          seq: 1,
          message_id: "m-1",
          channel_type: "channel",
          channel_name: "general",
          sender_type: "human",
          sender_name: "tygg",
          content: "visible message",
        }],
        source: "agent_api_events_local",
      });
    });
    assert.equal(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-with-stale-fence"),
      undefined,
      "visible-consume should repair stale fence-only state before the global invariant runs",
    );
  });
});

test("APM-managed start stores minted runner credential for process cleanup", async () => {
  const mintCalls: Array<{ url: string; headers: Headers; body: any }> = [];
  const revokeCalls: Array<{ url: string; headers: Headers; method?: string }> = [];
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      revokeCalls.push({
        url: String(input),
        headers: new Headers(init.headers),
        method: init.method,
      });
      return new Response(null, { status: 204 });
    }
    mintCalls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ apiKey: "sk_agent_apm_minted", credentialId: "cred-apm" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  try {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        agentCredentialKey: undefined,
        agentCredentialId: undefined,
      }), undefined, undefined, undefined, "launch-A");
      await waitFor(() => mintCalls.length === 1 && driver.spawnCalls.length === 1, "APM runner credential mint and spawn");

      assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_apm_minted");
      assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-apm");
      const ap = getProcess(manager, "agent-1");
      assert.equal(ap.config.agentCredentialId, "cred-apm");
      const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
      assert.ok(cached, "registered process should leave an idle restart cache");
      assert.equal(cached.config.agentCredentialKey, undefined);
      assert.equal(cached.config.agentCredentialId, undefined);
      assert.equal(cached.config.serverUrl, "https://daemon.example.com");

      await manager.startAgent("agent-1", makeConfig({
        sessionId: "server-session-B",
        agentCredentialKey: undefined,
        agentCredentialId: undefined,
      }), undefined, undefined, undefined, "launch-B");
      assert.equal(ap.launchId, "launch-B");
      assert.equal(ap.config.agentCredentialKey, "sk_agent_apm_minted");
      assert.equal(ap.config.agentCredentialId, "cred-apm");

      driver.processes[0].kill();
      await waitFor(() => revokeCalls.length === 1, "APM runner credential revoke");

      const revokeUrl = new URL(revokeCalls[0]!.url);
      assert.equal(revokeUrl.pathname, "/internal/computer/runners/agent-1/credentials/cred-apm");
      assert.equal(revokeCalls[0]!.headers.get("Authorization"), "Bearer sk_machine_test");
    });
  } finally {
    restoreFetch();
  }
});

// ===========================================================================
// Behavior-lock baseline — deliverMessage gating state machine (methodology run 1).
// The decision tree at deliverMessage(...) emits a `daemon.agent.delivery.routed`
// span whose `outcome` attr IS the linear oracle for each non-linear branch.
// This suite pins the current behavior (outcome + key side effects) per
// (ap state × message kind) so a later contract-clarifying refactor can run
// under it: every row must stay GREEN (behavior unchanged) or a change is a
// genuinely-discovered bug (red/green'd separately). Source thread #proj-o11y:9bf7d748.
//
// Enumeration (Adspectum review): 19 baseline outcomes + 4b/6 return-false special
// cases, all pinned below. Outcome #20 `dropped_already_consumed` is the step-5
// boundary-gate's outcome — a genuinely-discovered bug (delivery had no consumed-
// boundary gate), so it is red/green'd in the "Seam ①②" suite further down rather
// than as a current-behavior baseline row. That keeps the outcome enumeration
// complete (20 outcomes total) without pinning a bug as baseline.
// ===========================================================================

function deliveryOutcomes(sink: MemoryTraceSink): string[] {
  return sink.getAllSpans()
    .filter((s) => s.name === "daemon.agent.delivery.routed")
    .map((s) => s.attrs?.outcome as string);
}

function lastDeliveryOutcome(sink: MemoryTraceSink): string | undefined {
  return deliveryOutcomes(sink).at(-1);
}

function activityEvents(sent: MachineToServerMessage[]): Array<{ activity: string; detail: string }> {
  return sent
    .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
    .map((msg) => ({ activity: projectTestActivity(msg), detail: msg.detail }));
}

test("delivery-gating baseline: no-ap + starting + transient → transient_dropped_during_start", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    markAgentStarting(manager, "agent-1");
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "transient_dropped_during_start");
  }, { tracer });
});

test("delivery-gating baseline: no-ap + starting + user → queued_during_start", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    markAgentStarting(manager, "agent-1");
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_during_start");
    assert.equal((manager as any).startingInboxes.values("agent-1")?.length, 1);
  }, { tracer });
});

test("delivery-gating baseline: no-ap + no-cache + transient → transient_dropped_no_process", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "transient_dropped_no_process");
  }, { tracer });
});

test("delivery-gating baseline: no-ap + no-cache + user → rejected_no_process (return false + inactive + offline)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, false, "no process + no cached config rejects (the only false-returning delivery)");
    assert.equal(lastDeliveryOutcome(sink), "rejected_no_process");
    assert.ok(sent.some((m) => m.type === "agent:status" && (m as any).status === "inactive"));
    assert.ok(activityEvents(sent).some((a) => a.activity === "offline"));
  }, { tracer });
});

test("delivery-gating baseline: ap + auth-sticky + transient → transient_dropped_terminal_runtime_error (suppressed)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["Invalid API key · authentication failed"];
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "transient_dropped_terminal_runtime_error");
  }, { tracer });
});

test("delivery-gating baseline: ap + auth-sticky + user → user_turn_recover_from_sticky_terminal_error (un-stick)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["Invalid API key · authentication failed"];
    await manager.deliverMessage("agent-1", makeMessage("x"));
    // A recovery is a TWO-event linear trace: it emits the recover outcome, then
    // FALLS THROUGH to the idle delivery that starts the recovery turn.
    assert.deepEqual(
      deliveryOutcomes(sink),
      ["user_turn_recover_from_sticky_terminal_error", "stdin_idle_delivery"],
      "auth-class recover emits the recover outcome then falls through to the recovery turn delivery",
    );
    assert.deepEqual(ap.recentStderr, [], "auth-class sticky source cleared on user-driven recover");
  }, { tracer });
});

test("delivery-gating baseline: ap + model-not-supported sticky + user → queued_terminal_runtime_error (stays gated + inactive + error)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["model is not supported"];
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_terminal_runtime_error");
    assert.ok(sent.some((m) => m.type === "agent:status" && (m as any).status === "inactive"));
    assert.ok(activityEvents(sent).some((a) => a.activity === "error"));
  }, { tracer });
});

test("Anthropic maximum-context failure stays recoverable and retries the resumed session on a new message", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = [
      "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"This model's maximum context length is 1,048,565 tokens. However, you requested 1,048,925 tokens (1,016,925 in the messages, 32,000 in the completion).\"}}",
    ];

    const encodedBefore = driver.encodedCalls.length;
    const accepted = await manager.deliverMessage("agent-1", makeMessage("ordinary new message"));
    await flush();

    assert.equal(accepted, true);
    assert.equal(lastDeliveryOutcome(sink), "stdin_idle_delivery");
    assert.equal(
      driver.encodedCalls.length,
      encodedBefore + 1,
      "ordinary delivery should retry the live Claude session instead of terminal-gating the agent",
    );
    assert.deepEqual(
      ap.runtimeErrorDeliveryBackoff,
      { kind: "idle", attempts: 0, untilMs: 0, timer: null, reason: null },
      "stale stderr alone does not create generic runtime-error backoff before a new error event",
    );
    assert.equal(sent.some((m) => m.type === "agent:status" && (m as any).status === "inactive"), false);
    assert.equal(
      activityEvents(sent).some((activity) => activity.activity === "error"),
      false,
      "stale stderr must not be promoted into user-visible Activity on delivery retry",
    );
  }, { tracer });
});

test("delivery-gating baseline: ap + idle + stdin + session + transient → stdin_idle_transient_delivery", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.sessionId = "s1";
    await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(lastDeliveryOutcome(sink), "stdin_idle_transient_delivery");
  }, { tracer });
});

test("delivery-gating baseline: ap + idle + stdin + session + user → stdin_idle_delivery", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.sessionId = "s1";
    await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(lastDeliveryOutcome(sink), "stdin_idle_delivery");
  }, { tracer });
});

test("delivery-gating baseline: ap + busy + transient → transient_dropped_busy", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "transient_dropped_busy");
  }, { tracer });
});

test("delivery-gating baseline: ap + busy + no-session + user → queued_before_session", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = null;
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_before_session");
  }, { tracer });
});

test("Claude cold-start turn_end flushes pending delivery even before session id is observed", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = null;

    const accepted = await manager.deliverMessage("agent-1", makeMessage("during cold start"));
    assert.equal(accepted, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_before_session");
    assert.equal(driver.encodedCalls.length, 0, "pre-session busy delivery must stay queued");

    driver.parsedLines.set("turn-end-without-session", [{ kind: "turn_end" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-without-session\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "turn_end should flush the queued inbox update");
    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.match(driver.encodedCalls[0]?.text ?? "", /^\[Raft inbox notice:/);
    assert.match(driver.encodedCalls[0]?.text ?? "", /pending: 1 message/);
  }, { tracer });
});

test("Claude turn_end uses live driver session before readiness-gated flush", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));
    const ap = getProcess(manager, "agent-1") as any;
    (manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal(ap.sessionId, null);
    assert.equal(ap.sessionReadyForDelivery, false);

    const accepted = await manager.deliverMessage("agent-1", makeMessage("during cold start before live session sync"));
    assert.equal(accepted, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_before_session");
    assert.equal(driver.encodedCalls.length, 0);

    driver.currentSessionId = "fresh-session-1";
    driver.parsedLines.set("turn-end-live-session", [{ kind: "turn_end" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-live-session\n"));
    await flush();

    assert.equal(ap.sessionId, "fresh-session-1");
    assert.equal(ap.sessionReadyForDelivery, true);
    assert.equal(driver.encodedCalls.length, 1, "turn_end should sync the live session and flush the queued update");
    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.equal(driver.encodedCalls[0]?.sessionId, "fresh-session-1");
    assert.match(driver.encodedCalls[0]?.text ?? "", /^\[Raft inbox notice:/);
    assert.ok(sent.some((msg) =>
      msg.type === "agent:session"
      && msg.agentId === "agent-1"
      && msg.sessionId === "fresh-session-1"
    ));
  }, { tracer });
});

test("Claude fresh session waits for turn_end before busy inbox update can resume it", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));
    const ap = getProcess(manager, "agent-1") as any;
    assert.equal(ap.sessionId, null);
    assert.equal(ap.sessionReadyForDelivery, false);

    driver.parsedLines.set("session-init-before-persist", [{ kind: "session_init", sessionId: "fresh-session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init-before-persist\n"));
    await flush();
    assert.equal(ap.sessionId, "fresh-session-1");
    assert.equal(ap.sessionReadyForDelivery, false, "fresh Claude session is not resumable until the producing turn ends");

    const accepted = await manager.deliverMessage("agent-1", makeMessage("during session persist race"));
    assert.equal(accepted, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_before_session_ready");
    assert.equal(driver.encodedCalls.length, 0, "busy delivery must not resume a session before its first turn persists");

    driver.parsedLines.set("turn-end-after-persist", [{ kind: "turn_end" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-after-persist\n"));
    await flush();

    assert.equal(ap.sessionReadyForDelivery, true);
    assert.equal(driver.encodedCalls.length, 1, "turn_end should deliver the queued inbox update after session readiness");
    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.equal(driver.encodedCalls[0]?.sessionId, "fresh-session-1");
    assert.match(driver.encodedCalls[0]?.text ?? "", /^\[Raft inbox notice:/);
    assert.match(driver.encodedCalls[0]?.text ?? "", /pending: 1 message/);
  }, { tracer });
});

test("Claude fresh session wake rebind waits for turn_end before resume delivery", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: null }));
    const ap = getProcess(manager, "agent-1") as any;

    driver.parsedLines.set("session-init-before-wake", [{ kind: "session_init", sessionId: "fresh-session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init-before-wake\n"));
    await flush();
    assert.equal(ap.sessionId, "fresh-session-1");
    assert.equal(ap.sessionReadyForDelivery, false);

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "fresh-session-1" }),
      makeMessage("wake during session persist race", { message_id: "msg-wake-race" }),
      undefined,
      undefined,
      "launch-1",
    );

    assert.equal(driver.spawnCalls.length, 1, "wake rebind must not spawn a second Claude process");
    assert.equal(lastDeliveryOutcome(sink), "queued_before_session_ready");
    assert.equal(driver.encodedCalls.length, 0, "wake rebind must not resume a fresh session before turn_end");

    driver.parsedLines.set("turn-end-after-wake", [{ kind: "turn_end" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-after-wake\n"));
    await flush();

    assert.equal(ap.sessionReadyForDelivery, true);
    assert.equal(driver.encodedCalls.length, 1, "turn_end should deliver the wake message after session readiness");
    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.equal(driver.encodedCalls[0]?.sessionId, "fresh-session-1");
    assert.match(driver.encodedCalls[0]?.text ?? "", /^\[Raft inbox notice:/);
    assert.match(driver.encodedCalls[0]?.text ?? "", /pending: 1 message/);
  }, { tracer });
});

test("delivery-gating baseline: Claude direct session does not reintroduce a compaction hold", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";
    ap.gatedSteering.compacting = true;
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_busy_notification");
    assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    assert.equal(driver.encodedCalls.at(-1)?.mode, "busy");
  }, { tracer });
});

test("delivery-gating baseline: ap + busy + direct session → queued_busy_notification", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";
    ap.gatedSteering.compacting = false;
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_busy_notification");
  }, { tracer });
});

test("delivery-gating baseline: ap + busy + session + non-stdin driver → queued_busy_non_stdin", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";
    (ap.driver as any).supportsStdinNotification = false;
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "queued_busy_non_stdin");
  }, { tracer });
});

// ===========================================================================
// Seam ①② red-green — delivery-side visible-boundary gate (methodology run 1, step 3).
// Verified gap (Noel, #proj-o11y:9bf7d748 msg=81805402): deliverMessage has NO
// boundary gate — re-delivering a seq the model has ALREADY consumed (server
// reconnect re-push / cross-replica mirror) re-enters the local inbox AND, on the
// busy path, re-increments the user-visible notification counter (re-notify).
// Fix (step 5): gate non-transient delivery on the authoritative consumed boundary
// (getVisibleBoundary/isVisibleMessageModelSeen) BEFORE any delivery-branch inbox
// push / notifications.add() (Kai cut-point); seq<=boundary → drop + outcome
// "dropped_already_consumed". Double-assert per Kai (msg 7e945075): inbox queue AND
// pendingCount. RED on current code; GREEN after the step-5 boundary-drop fix.
// ===========================================================================

test("delivery-gating seam ①: re-delivering an already-consumed seq to a busy agent must not re-queue or re-notify (boundary-drop)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);        // busy → non-transient delivery queues to inbox + notifies
    ap.sessionId = "s1";

    // The model has ALREADY consumed seq 42 on #general through a verified
    // contiguous full-body source.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 42,
      messages: [],
      source: "verified_contiguous_content_consumption",
    });
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general"), 42, "boundary seeded");

    const pendingBefore = ap.notifications.pendingCount;
    const inboxBefore = ap.inbox.length;

    // Server re-delivers the SAME already-consumed seq (reconnect re-push / mirror).
    await manager.deliverMessage(
      "agent-1",
      makeMessage("x", { seq: 42, message_id: "m-42", channel_name: "general", channel_type: "channel" }),
    );

    // ① the already-consumed seq must NOT re-enter the inbox queue.
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 42).length,
      0,
      "already-consumed seq must not re-enter the inbox",
    );
    assert.equal(ap.inbox.length, inboxBefore, "inbox length unchanged");
    // ② the user-visible re-notify surface (pendingCount) must NOT increment (Kai).
    assert.equal(
      ap.notifications.pendingCount,
      pendingBefore,
      "already-consumed re-delivery must not increment pendingCount (no re-notify)",
    );
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed");
  }, { tracer });
});

test("delivery-gating seam ②: re-delivering an already-consumed seq to an idle stdin agent (fall-through path) must drop, not re-queue", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);         // idle stdin path = stdin_idle_delivery (seam ② fall-through, also inbox.push)
    ap.sessionId = "s1";

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 7,
      messages: [],
      source: "verified_contiguous_content_consumption",
    });

    const inboxBefore = ap.inbox.length;

    await manager.deliverMessage(
      "agent-1",
      makeMessage("x", { seq: 7, message_id: "m-7", channel_name: "general", channel_type: "channel" }),
    );

    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 7).length,
      0,
      "already-consumed seq must not re-enter the inbox on the idle fall-through path",
    );
    assert.equal(ap.inbox.length, inboxBefore, "inbox length unchanged");
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed");
  }, { tracer });
});

test("delivery-gating seam ①b: an already-consumed seq re-delivered DURING agent start must drop, not queue into startingInbox (entry-gate covers the queue-class branch — Kai conformance)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    // Model has already consumed seq 5 on #general.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 5,
      messages: [],
      source: "verified_contiguous_content_consumption",
    });
    // Agent is mid-start (no ap yet) — this is the during-start push branch that a
    // gate placed only at the idle/busy delivery point would have bypassed.
    markAgentStarting(manager, "agent-1");
    const startingBefore = ((manager as any).startingInboxes.values("agent-1") ?? []).length;

    await manager.deliverMessage(
      "agent-1",
      makeMessage("x", { seq: 5, message_id: "m-5", channel_name: "general", channel_type: "channel" }),
    );

    const startingAfter = ((manager as any).startingInboxes.values("agent-1") ?? []).length;
    assert.equal(startingAfter, startingBefore, "already-consumed seq must not queue into startingInbox during start");
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed");
  }, { tracer });
});

// ===========================================================================
// Seam C2 (lead-run, methodology run 1 follow-up). The entry boundary-gate
// `isVisibleMessageModelSeen` matches on seq<=boundary OR message_id ∈ seen-set.
// Seams ①②①b only exercised the SEQ branch. This locks the ID branch: a re-push
// that DROPS the seq (cross-replica mirror / re-serialization paths can omit seq)
// but carries an already-consumed message_id must still be dropped. Without the
// id-branch (gate seq-only) this re-push slips the gate → re-inject + re-notify.
// Teeth: revert agentProcessManager.ts:1732 (the id-branch) → this flips RED.
// ===========================================================================
test("delivery-gating seam C2: a seq-MISSING re-push of an already-consumed message_id drops via the gate id-branch (not the seq branch)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);        // busy → a non-gated non-transient delivery would queue + notify
    ap.sessionId = "s1";

    // Model has consumed message m-88 on #general — consuming the message records
    // BOTH the boundary (maxSeq) AND the message_id in the visible-id-set.
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [makeMessage("seen", { seq: 88, message_id: "m-88", channel_name: "general", channel_type: "channel" })],
      source: "test_seed_consume",
    });
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#general")?.has("m-88"),
      true,
      "message_id recorded in the visible-id-set on consume",
    );

    const pendingBefore = ap.notifications.pendingCount;
    const inboxBefore = ap.inbox.length;

    // Server re-delivers the SAME logical message but WITHOUT a seq (mirror / re-push
    // that omits seq). seq-branch cannot fire (seq missing) → only the id-branch can gate.
    await manager.deliverMessage(
      "agent-1",
      makeMessage("x", { message_id: "m-88", channel_name: "general", channel_type: "channel" }), // no seq on purpose
    );

    assert.equal(
      ap.inbox.filter((m: any) => m.message_id === "m-88").length,
      0,
      "seq-missing re-push of an already-seen message_id must not re-enter the inbox (id-branch gate)",
    );
    assert.equal(ap.inbox.length, inboxBefore, "inbox length unchanged");
    assert.equal(
      ap.notifications.pendingCount,
      pendingBefore,
      "seq-missing re-push of a seen id must not increment pendingCount (no re-notify)",
    );
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed");
  }, { tracer });
});

// ===========================================================================
// Seam ①c — the boundary drop must also DRAIN a tracked mention delivery.
// The four teeth above prove the gate does not re-queue / re-notify. None of them
// carries a tracked mention occurrence, so none of them can see what happens to the
// occurrence state machine when the gate fires: an accepted occurrence that is never
// drained stays un-acked, so the server keeps finding it recoverable and redrives a
// message the model has ALREADY consumed — the drop would trade a re-notify for an
// endless redrive. Contract per @Huaihuai (msg fae9fb4a): daemon_received →
// daemon_drained, ACK exactly once, zero terminal errors, and still zero inbox/re-notify.
// ===========================================================================

test("delivery-gating seam ①c: a boundary-dropped already-consumed seq must still drain and ACK its tracked mention occurrence exactly once", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);        // busy → an ungated delivery would queue + notify
    ap.sessionId = "s1";
    ap.launchId = "launch-1";                                         // occurrence tracking is identity-bound; without it begin rejects IDENTITY_UNKNOWN

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 42,
      messages: [],
      source: "verified_contiguous_content_consumption",
    });
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general"), 42, "boundary seeded");

    const pendingBefore = ap.notifications.pendingCount;
    const inboxBefore = ap.inbox.length;

    // The re-push carries a tracked mention occurrence. launchId/sessionId are read off
    // the live process so the identity checks pass and tracking is genuinely ACCEPTED —
    // otherwise begin would reject and this tooth would pass without ever reaching the gate.
    const occurrenceId = "occ-42";
    const transitions: { state: string; outcome: string }[] = [];
    const terminalErrors: string[] = [];
    let ackCount = 0;

    await manager.deliverMessage(
      "agent-1",
      makeMessage("x", { seq: 42, message_id: "m-42", channel_name: "general", channel_type: "channel" }),
      {
        deliveryId: occurrenceId,
        mentionDelivery: {
          occurrenceId,
          messageId: "m-42",
          launchId: ap.launchId,
          sessionId: ap.sessionId,
        },
        onMentionTransition: (state: string, outcome: string) => { transitions.push({ state, outcome }); },
        onMentionAck: () => { ackCount += 1; },
        onMentionTerminalError: (code: string) => { terminalErrors.push(code); },
      } as any,
    );

    // The gate still fired, on the same terms the other four teeth assert.
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed");
    assert.equal(ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 42).length, 0, "already-consumed seq must not re-enter the inbox");
    assert.equal(ap.inbox.length, inboxBefore, "inbox length unchanged");
    assert.equal(ap.notifications.pendingCount, pendingBefore, "no re-notify");

    // And the tracked occurrence reached a terminal-clean drained state.
    assert.deepEqual(
      transitions,
      [
        { state: "daemon_received", outcome: "accepted" },
        { state: "daemon_drained", outcome: "accepted" },
      ],
      "a boundary-dropped tracked mention must go daemon_received → daemon_drained",
    );
    assert.equal(ackCount, 1, "the occurrence must be ACKed exactly once — never zero (endless redrive) and never twice");
    assert.deepEqual(terminalErrors, [], "dropping an already-consumed seq is a normal outcome, not a terminal error");
  }, { tracer });
});

// ===========================================================================
// Agent-start slot accounting (lead-run, methodology run 2 — start/spawn state
// machine). `activeAgentStartCount` is incremented once at dequeue (pumpAgentStartQueue,
// :2148) and must be released exactly once when startAgentNow settles — on BOTH
// the success (.then) and failure (.catch) branches (:2165/:2168 → releaseAgentStartSlot).
// A leak (increment without a matching release) permanently consumes a concurrency
// slot; once activeAgentStartCount >= maxConcurrentAgentStarts the pump early-returns
// (:2107) and EVERY future start stalls in the queue forever. This locks the
// balance invariant on the settle path. Teeth: drop the success-branch
// releaseAgentStartSlot call → count stuck at 1 → these go RED.
// ===========================================================================
test("agent-start slot accounting: activeAgentStartCount returns to 0 after a start settles, and subsequent starts are not stalled", async () => {
  await withManager(async ({ manager }) => {
    assert.equal(agentStartSnapshot(manager).activeStarts, 0, "no slots held initially");

    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    assert.equal(agentStartSnapshot(manager).activeStarts, 0, "slot released after the first start settles");

    // If the first start had leaked its slot, a later start could stall once the
    // leak count reaches maxConcurrentAgentStarts. Drive a second start to prove flow.
    await manager.startAgent("agent-2", makeConfig({ sessionId: "s2" }));
    assert.equal(agentStartSnapshot(manager).activeStarts, 0, "slot released after the second start too");
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "no starts left stalled in the queue");
  });
});

// ===========================================================================
// Agent-start transient-tracking cleanup (start/spawn run). `agentsStarting` is
// added at startAgentNow entry (:2246) and must be deleted on every terminal path
// (normal spawn :2465, deferred spawn :2386, and the error path). A leak (add
// without delete) wedges the agent: every subsequent startAgent short-circuits at
// the entry guard `start.ignored{already_starting}` (:2056) → the agent can never
// be (re)started for the rest of the daemon's life. Likewise startingInboxes /
// queuedAgentStarts must drain. This locks the clean terminal state after a
// settled successful start. Teeth: drop the :2465 agentsStarting.delete →
// agentsStarting stays set → RED.
// ===========================================================================
test("agent-start tracking cleanup: a settled successful start clears agentsStarting / queuedAgentStarts / startingInboxes (no stuck-starting wedge)", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    assert.equal((manager as any).agents.has("agent-1"), true, "agent registered as running after start");
    assert.equal(
      agentStartSnapshot(manager).startingAgentIds.includes("agent-1"),
      false,
      "agentsStarting cleared — else every future start short-circuits at start.ignored{already_starting} forever",
    );
    assert.equal(agentStartSnapshot(manager).queuedAgentIds.includes("agent-1"), false, "queuedAgentStarts cleared");
    assert.equal(((manager as any).startingInboxes.values("agent-1") ?? []).length, 0, "startingInboxes drained");
  });
});

// ===========================================================================
// Agent-start entry dedup (start/spawn run, baseline rows). startAgent's three
// entry guards each emit a unique daemon.agent.start.ignored{reason} (the linear
// oracle) and early-return WITHOUT enqueuing — so a redundant start request never
// double-spawns / double-queues. Locks each guard's outcome. Teeth: drop a guard →
// that request would enqueue (length 1) / get a different outcome → RED.
// ===========================================================================
function startIgnoredReasons(sink: MemoryTraceSink): Array<string | undefined> {
  return sink.getAllSpans()
    .filter((s) => s.name === "daemon.agent.start.ignored")
    .map((s) => s.attrs?.reason as string | undefined);
}

test("agent-start entry dedup: already-running agent → start.ignored{already_running}, not enqueued", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" })); // real start → now running
    assert.equal((manager as any).agents.has("agent-1"), true, "agent running after first start");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" })); // redundant
    assert.deepEqual(startIgnoredReasons(sink), ["already_running"], "only the redundant start is ignored");
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "already-running start must not enqueue");
  }, { tracer });
});

test("agent-start entry dedup: already-starting agent → start.ignored{already_starting}, not enqueued", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    markAgentStarting(manager, "agent-1");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    assert.deepEqual(startIgnoredReasons(sink), ["already_starting"]);
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "already-starting start must not enqueue");
  }, { tracer });
});

test("agent-start entry dedup: already-queued agent → start.ignored{already_queued}, not double-queued", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    setAgentStartCapacityFull(manager);
    const queued = manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    await flush();
    assert.equal(agentStartSnapshot(manager).queuedAgentIds.includes("agent-1"), true, "agent is queued before duplicate start");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    assert.deepEqual(startIgnoredReasons(sink), ["already_queued"]);
    assert.equal(agentStartSnapshot(manager).queueDepth, 1, "already-queued start must not double-queue");
    (manager as any).releaseAgentStartSlot("test-slot", "test: slot freed");
    await queued;
  }, { tracer });
});

// ===========================================================================
// Agent-start concurrency-cap branch (start/spawn run — Adspectum completeness
// review). The cap guard in pumpAgentStartQueue (`if (activeAgentStartCount >=
// maxConcurrentAgentStarts) return`, ~2104) is SILENT — it emits no trace outcome,
// so the outcome-oracle baseline can't cover it; it must be locked by STATE
// assertion. The load-bearing invariant is the re-pump chain: a start that parks
// behind the cap MUST resume the moment a slot frees (releaseAgentStartSlot →
// pumpAgentStartQueue). If that chain ever breaks, the queue stalls silently and
// the parked agent never starts — invisible on traces. This locks: capacity holds
// the 2nd start in the queue, and freeing the slot drains it.
// Teeth: drop the pumpAgentStartQueue() call in releaseAgentStartSlot → parked
// start never resumes → second assertion RED.
// ===========================================================================
test("agent-start concurrency cap: a start parked behind a full cap resumes when a slot frees (silent-stall guard)", async () => {
  await withManager(async ({ manager }) => {
    (manager as any).agentStarts.setMaxConcurrentStartsForTesting(1);
    // Occupy the only slot WITHOUT settling it (so the cap stays full): drive the
    // pump with a sentinel active count, then enqueue a real second start.
    (manager as any).agentStarts.setActiveStartsForTesting(1);

    const started = manager.startAgent("agent-2", makeConfig({ sessionId: "s2" }));
    // Cap is full → the start parks in the queue, silently (no outcome emitted).
    assert.equal((manager as any).agents.has("agent-2"), false, "parked behind a full cap — not started yet");
    assert.equal(agentStartSnapshot(manager).queueDepth, 1, "second start is queued behind the cap");

    // Free the slot the way a settled start does → re-pump must drain the parked one.
    (manager as any).releaseAgentStartSlot("agent-1", "test: slot freed");
    // pumpAgentStartQueue shifts the queue SYNCHRONOUSLY (waitMs=0), so the re-pump
    // chain shows up immediately in queue state — a dropped re-pump fails here fast
    // (queue stays 1) rather than hanging on the await below.
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "re-pump drained the queue synchronously on slot release — no silent stall");
    await started;
    assert.equal((manager as any).agents.has("agent-2"), true, "parked start resumed once the slot freed (re-pump chain intact)");
  });
});

// ===========================================================================
// Agent-start cancel-path promise settle (start/spawn run). startAgent() returns
// a Promise that resolves when the queued start settles (resolve at :2160/:2183,
// reject at :2186). When a queued start is CANCELLED instead of run, the caller's
// promise MUST still settle (cancelQueuedAgentStart → item.resolve() :2222;
// cancelAllQueuedAgentStarts → item.resolve() :2234) and all tracking MUST clear.
// If the cancel path forgot to resolve, the caller awaits forever (leaked pending
// promise — e.g. a stopAgent() during a queued start would hang). These lock that
// both cancel paths settle the promise + drain tracking. Teeth: drop item.resolve()
// in cancelQueuedAgentStart → the await below never returns (caller hang).
// ===========================================================================
test("agent-start cancel (single): cancelling a queued start settles the caller promise and clears tracking", async () => {
  await withManager(async ({ manager }) => {
    setAgentStartCapacityFull(manager); // occupy the only slot → next start parks

    const queued = manager.startAgent("agent-2", makeConfig({ sessionId: "s2" }));
    assert.equal(agentStartSnapshot(manager).queuedAgentIds.includes("agent-2"), true, "second start parked in queue");

    // stopAgent cancels the queued start (cancelQueuedAgentStart "stop requested").
    await manager.stopAgent("agent-2");
    // The caller's startAgent promise MUST settle (else this await hangs forever).
    await queued;
    assert.equal(agentStartSnapshot(manager).queuedAgentIds.includes("agent-2"), false, "queuedAgentStarts cleared on cancel");
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "queue drained on cancel");
    assert.equal(((manager as any).startingInboxes.values("agent-2") ?? []).length, 0, "startingInboxes cleared on cancel");
  });
});

test("agent-start cancel (all): cancelAllQueuedAgentStarts settles every queued caller promise and clears tracking", async () => {
  await withManager(async ({ manager }) => {
    setAgentStartCapacityFull(manager); // occupy slot → both parks

    const q2 = manager.startAgent("agent-2", makeConfig({ sessionId: "s2" }));
    const q3 = manager.startAgent("agent-3", makeConfig({ sessionId: "s3" }));
    assert.equal(agentStartSnapshot(manager).queueDepth, 2, "two starts parked");

    (manager as any).cancelAllQueuedAgentStarts("daemon shutdown");
    // BOTH caller promises must settle (else Promise.all hangs forever).
    await Promise.all([q2, q3]);
    assert.equal(agentStartSnapshot(manager).queueDepth, 0, "queue fully drained");
    assert.deepEqual(agentStartSnapshot(manager).queuedAgentIds, [], "queuedAgentStarts fully cleared");
  });
});

// ===========================================================================
// C1 — consume-side suppress() orphaned-retain (methodology run, #proj-o11y:9bf7d748).
// FM2's consume↔delivery counterpart: consumeVisibleMessages buckets pending by
// formatVisibleMessageTarget (returned NULL when channel_name is falsy → no bucket
// built) but suppress() looks the pending up by formatMessageTarget (TOTAL). The
// null-skip ASYMMETRY means a pending whose channel_name is falsy is never bucketed
// → `!bucket → return true` retains it even though its seq was consumed → #64
// residue (re-fires every idle cycle; Cindy unreadable-channel signature). Real root
// per Adspectum (he refuted "formatter logic divergence" — byte-identical for same
// inputs; root is the null-skip). Fix (suppress-match domain, does NOT touch
// model-seen): formatVisibleMessageTarget returns the SAME total non-null key as
// formatMessageTarget on the falsy fallback so the bucket IS built under the key
// suppress looks up → residue actually suppress-removed (not symmetric-stuck).
// GREEN asserts ACTUAL removal from inbox, not key equality. RED today; GREEN w/ fix.
// ===========================================================================
test("C1 consume suppress(): a pending with falsy channel_name is left as orphaned residue while siblings drain (null-skip asymmetry)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    // Two pendings consumed in the same round: P1 well-formed, P2 has a falsy
    // channel_name (unresolved channel — #64 signature).
    const p1 = makeMessage("a", { seq: 5, message_id: "m-5", channel_name: "general", channel_type: "channel" });
    const p2 = makeMessage("b", { seq: 6, message_id: "m-6", channel_name: "" as any, channel_type: "channel" });
    ap.inbox.push(p1, p2);

    // Consume both (their seqs are now model-seen). P1 buckets under "#general";
    // P2's formatVisibleMessageTarget is null (falsy channel_name) → no bucket.
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [
        { seq: 5, message_id: "m-5", channel_name: "general", channel_type: "channel" },
        { seq: 6, message_id: "m-6", channel_name: "", channel_type: "channel" },
      ],
      source: "test_consume_batch",
    });

    // P1 drains (sanity — proves the consume round ran).
    assert.equal(ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 5).length, 0, "well-formed sibling P1 must drain");
    // P2 must ALSO be removed — its seq was consumed. RED before fix: falsy
    // channel_name skips bucket-build → suppress can't match → P2 retained = residue.
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 6).length,
      0,
      "consumed pending with falsy channel_name must be suppressed, not left as orphaned residue",
    );
  }, { tracer });
});

// ===========================================================================
// C3 — consume suppress() residue for THREAD-falsy and DM-falsy (#proj-o11y:9bf7d748).
// C1 only made the channel branch symmetric. formatMessageTarget's thread/dm branches
// have NO channel_name guard (falsy → `#{parent}:` / `dm:@`), but
// formatVisibleMessageTarget's did (`&& channel_name` → falls to `#`) → the two keys
// still diverge → orphaned-retain for a thread/dm pending whose channel_name is falsy
// (Adspectum + ApplePI byte-verified: real residue, not theory). End-state fix =
// project-from-single-source: a shared computeTarget() both formatters delegate to →
// all branches non-divergent by construction. RED = thread-falsy + dm-falsy residue;
// GREEN asserts ACTUAL removal.
// ===========================================================================

test("C3 consume suppress(): a consumed THREAD pending with falsy channel_name must be suppressed, not left as residue (thread-branch divergence)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    // Thread pending with falsy channel_name: formatMessageTarget → `#general:` (thread
    // branch, no guard); pre-fix formatVisibleMessageTarget → `#` (guard fails → fallback).
    const pt = makeMessage("t", {
      seq: 7, message_id: "m-7",
      channel_type: "thread" as any, channel_name: "" as any,
      parent_channel_name: "general", parent_channel_type: "channel" as any,
    });
    ap.inbox.push(pt);

    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [{ seq: 7, message_id: "m-7", channel_type: "thread", channel_name: "", parent_channel_name: "general", parent_channel_type: "channel" }],
      source: "test_consume_thread_falsy",
    });

    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 7).length,
      0,
      "consumed thread pending with falsy channel_name must be suppressed, not left as orphaned residue",
    );
  }, { tracer });
});

test("C3 consume suppress(): a consumed DM pending with falsy channel_name must be suppressed, not left as residue (dm-branch divergence)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    // DM pending with falsy channel_name: formatMessageTarget → `dm:@` (dm branch, no
    // guard); pre-fix formatVisibleMessageTarget → `#` (guard fails → fallback).
    const pd = makeMessage("d", {
      seq: 8, message_id: "m-8",
      channel_type: "dm" as any, channel_name: "" as any,
    });
    ap.inbox.push(pd);

    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [{ seq: 8, message_id: "m-8", channel_type: "dm", channel_name: "" }],
      source: "test_consume_dm_falsy",
    });

    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 8).length,
      0,
      "consumed dm pending with falsy channel_name must be suppressed, not left as orphaned residue",
    );
  }, { tracer });
});

// ===========================================================================
// CC2 — boundary overshoot × FM2 gate = message loss (#proj-o11y:9bf7d748).
// The FM2 entry gate ("seq<=boundary → dropped_already_consumed") IMPLICITLY assumes
// every seq<=boundary was delivered+consumed CONTIGUOUSLY from below (Kai's clause).
// But the preflight (agentCredentialProxy.localHeldContext) sets boundary =
// `seenUpToSeq = maxSeq(server-recent-3 via HTTP history GET)` — a view that can LEAD
// daemon WS delivery, leaving a GAP below (seqs not delivered+consumed). A real,
// never-shown message in that gap, delivered LATE via WS (the two transports have no
// cross-ordering guarantee — REACHABLE), hits the gate at seq<=boundary → DROPPED =
// message loss; FM2 is the weapon. RED today; GREEN once boundary is clamped to the
// daemon authoritative contiguous delivered-high-water (Kai clamp clause — boundarySeq
// from server-preflight must not raise boundary past it). Test-only; fix pending clause.
// ===========================================================================
test("CC2 boundary overshoot: a never-shown gap message delivered late must NOT be dropped by the FM2 gate (preflight seenUpToSeq overshoot)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";

    // Preflight (post caller-fix: NO boundarySeq) — only recent-3 (98/99/100) shown.
    // The recent-3 are a NON-CONTIGUOUS SUFFIX (seqs 1..97 are a gap, never
    // delivered+consumed). Pre-guard, bucket.maxSeq=100 raises boundary to 100 via the
    // messages-maxSeq path (boundarySeq removal alone doesn't stop this — verified).
    // The contiguity-guard must advance boundary only across a contiguous prefix from
    // the prior boundary, so a non-contiguous suffix does NOT raise it past the gap.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      messages: [
        { seq: 98, message_id: "m-98", channel_name: "general", channel_type: "channel" },
        { seq: 99, message_id: "m-99", channel_name: "general", channel_type: "channel" },
        { seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" },
      ],
      source: "side_effect_preflight_context",
    });

    // A REAL, never-shown message in the gap (seq 50, < boundary, NOT in the consumed
    // set) arrives late via WS delivery. It was never shown/consumed by the model.
    await manager.deliverMessage(
      "agent-1",
      makeMessage("late", { seq: 50, message_id: "m-50", channel_name: "general", channel_type: "channel" }),
    );

    // It must NOT be dropped as already-consumed — the model never saw it (gap below
    // the overshoot boundary). RED today: FM2 gate drops it (seq 50 <= boundary 100) = loss.
    assert.notEqual(
      lastDeliveryOutcome(sink),
      "dropped_already_consumed",
      "a never-shown gap message below an overshoot boundary must not be FM2-dropped (message loss)",
    );
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 50).length,
      1,
      "the never-shown gap message must be delivered into the inbox, not silently dropped",
    );
  }, { tracer });
});

test("CC2 self-authored: an agent's own send (agent_api_send_commit) must NOT advance the boundary past undelivered counterparty messages (set-only)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";

    // The agent sends its own message at seq=100 (agent_api_send_commit). This proves
    // "the agent WROTE 100", NOT "the agent saw all <100 for this target". A concurrent
    // counterparty message at seq=50 may be in flight, not yet delivered to the agent.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 100,
      messages: [{ seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" }],
      source: "agent_api_send_commit",
    });

    // The self-send must be exact-deduped (re-delivery of m-100 drops via the id-branch)…
    await manager.deliverMessage(
      "agent-1",
      makeMessage("self-redelivery", { seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" }),
    );
    assert.equal(lastDeliveryOutcome(sink), "dropped_already_consumed", "self-send re-delivery still deduped via id-branch");

    // …but a never-shown concurrent counterparty (seq=50, < self-send 100) delivered late
    // must NOT be FM2-dropped: the self-send must not have advanced the boundary past it.
    await manager.deliverMessage(
      "agent-1",
      makeMessage("counterparty", { seq: 50, message_id: "m-50", channel_name: "general", channel_type: "channel" }),
    );
    assert.notEqual(
      lastDeliveryOutcome(sink),
      "dropped_already_consumed",
      "a never-shown counterparty below a self-send must not be FM2-dropped (self → set-only, not boundary-advance)",
    );
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 50).length,
      1,
      "the never-shown counterparty message must be delivered, not masked by the self-send boundary",
    );
  }, { tracer });
});

test("CC2 history-fetch: agent_api_history (server-view GET) must NOT advance the boundary past undelivered messages (set-only)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";

    // agent_api_history = the daemon proxying the agent's read_history to the SERVER
    // (GET /internal/agent-api/history?limit=N). It's a server view (recent-N), can lead
    // daemon WS delivery → same overshoot class as preflight. Must be set-only.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 100,
      messages: [
        { seq: 98, message_id: "m-98", channel_name: "general", channel_type: "channel" },
        { seq: 99, message_id: "m-99", channel_name: "general", channel_type: "channel" },
        { seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" },
      ],
      source: "agent_api_history",
    });

    // A never-shown message below the server-history-max, delivered late, must NOT be dropped.
    await manager.deliverMessage(
      "agent-1",
      makeMessage("late", { seq: 50, message_id: "m-50", channel_name: "general", channel_type: "channel" }),
    );
    assert.notEqual(
      lastDeliveryOutcome(sink),
      "dropped_already_consumed",
      "agent_api_history (server-view) must not advance boundary past undelivered messages (set-only)",
    );
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 50).length,
      1,
      "the never-shown message must be delivered, not masked by the history-fetch boundary",
    );
  }, { tracer });
});

// CC2 Stage-2 — server-view consume sources must be set-only. They may record
// exact ids for dedupe, but only verified contiguous content consumption may
// advance model-seen high-water.
test("CC2 server_held_context: a server seenUpToSeq view must NOT advance the boundary past undelivered messages (set-only)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";

    // server_held_context projects the server's held messages + boundarySeq =
    // server-computed seenUpToSeq. That is a sparse server view, not verified
    // contiguous content consumption. It must be set-only; overshooting to 100
    // here would drop a never-shown gap message.
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 100,
      messages: [
        { seq: 98, message_id: "m-98", channel_name: "general", channel_type: "channel" },
        { seq: 99, message_id: "m-99", channel_name: "general", channel_type: "channel" },
        { seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" },
      ],
      source: "server_held_context",
    });

    await manager.deliverMessage(
      "agent-1",
      makeMessage("late", { seq: 50, message_id: "m-50", channel_name: "general", channel_type: "channel" }),
    );
    assert.notEqual(
      lastDeliveryOutcome(sink),
      "dropped_already_consumed",
      "server_held_context (server seenUpToSeq view) must not advance boundary past undelivered messages (set-only)",
    );
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 50).length,
      1,
      "the never-shown gap message must be delivered, not masked by the server_held_context boundary",
    );
  }, { tracer });
});

test("CC2 agent_api_events_server: the server /events sync/repair forward must NOT advance the boundary past undelivered messages (set-only)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";

    // agent_api_events_server (agentCredentialProxy:879) = the server `/events` sync/repair
    // forward (used only after the local pending drain is empty). It is a SERVER VIEW that
    // can lead daemon WS delivery — same overshoot class as preflight/history. No boundarySeq
    // on the real call, so the overshoot would come via bucket.maxSeq (100). Must be set-only.
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [
        { seq: 98, message_id: "m-98", channel_name: "general", channel_type: "channel" },
        { seq: 99, message_id: "m-99", channel_name: "general", channel_type: "channel" },
        { seq: 100, message_id: "m-100", channel_name: "general", channel_type: "channel" },
      ],
      source: "agent_api_events_server",
    });

    await manager.deliverMessage(
      "agent-1",
      makeMessage("late", { seq: 50, message_id: "m-50", channel_name: "general", channel_type: "channel" }),
    );
    assert.notEqual(
      lastDeliveryOutcome(sink),
      "dropped_already_consumed",
      "agent_api_events_server (server-view forward) must not advance boundary past undelivered messages (set-only)",
    );
    assert.equal(
      ap.inbox.filter((m: any) => Math.floor(m.seq ?? 0) === 50).length,
      1,
      "the never-shown gap message must be delivered, not masked by the events-server boundary",
    );
  }, { tracer });
});

// CC2 Stage-2 guard#1: transient stdin delivery is an attention signal. It
// must not advance model-seen even if a future refactor accidentally records
// it as consumed.
test("CC2 guard#1: a transient stdin delivery must NOT advance the boundary", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.sessionId = "s1";

    // Transient (autonomous/re-notify) stdin delivery → stdin_idle_transient_delivery.
    // It must NOT consume → boundary must stay unset for the target.
    await manager.deliverMessage(
      "agent-1",
      makeMessage("transient", { seq: 200, message_id: "m-200", channel_name: "general", channel_type: "channel" }),
      { transient: true },
    );
    assert.equal(lastDeliveryOutcome(sink), "stdin_idle_transient_delivery");
    assert.equal(
      (manager as any).getVisibleBoundary("agent-1", "#general"),
      undefined,
      "a transient stdin delivery must not advance the boundary (it never consumes)",
    );
  }, { tracer });
});

// CC1 (id-set lifecycle): the per-agent consume-boundary high-water and the
// exact-id dedup set (CL-CC2 visible-state) are never otherwise pruned, so they
// grow unbounded across an agent's stop/start churn. An EXPLICIT stop resets the
// dedup clock (fresh launchId next start), so the whole visible-state is cleared
// on stopAgent({silent:false}). RED without the cleanup (ledger still holds the
// agent entry after stop); GREEN once stopAgent clears the owner state.
// Counterpart: a SILENT stop must NOT clear (same-launchId respawn keeps dedup) —
// pinned by the sibling test below (CL-CC2-4 boundary-aware-pruning precondition).
test("CC1 lifecycle: an explicit stopAgent clears the per-agent consume-boundary + id-dedup maps (unbounded-growth cleanup)", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));

    // Seed visible-state via verified contiguous content consumption (boundary
    // + id-set populated).
    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 42,
      messages: [{ seq: 42, message_id: "m-42", channel_name: "general", channel_type: "channel" }],
      source: "verified_contiguous_content_consumption",
    });
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general"), 42, "boundary seeded");
    assert.equal(
      (manager as any).agentVisibleDelivery.hasAgentState("agent-1"),
      true,
      "visible ledger holds the agent entry before stop",
    );

    // Explicit stop (silent defaults to false) → visible-state must be cleared.
    await manager.stopAgent("agent-1");

    assert.equal(
      (manager as any).agentVisibleDelivery.hasAgentState("agent-1"),
      false,
      "explicit stop must clear the per-agent visible ledger (no unbounded growth)",
    );
  });
});

// CC1 counterpart (CL-CC2-4 precondition): a SILENT stop may respawn under the
// SAME launchId, so the visible-state (dedup set) MUST survive — clearing it
// would let a not-yet-boundary-covered set-only id be re-delivered and miss
// dedup → re-wakeup. RED if the cleanup is ungated (clears on silent too).
test("CC1 lifecycle: a silent stopAgent KEEPS the per-agent visible-state (same-launchId respawn must not lose dedup)", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      boundarySeq: 42,
      messages: [{ seq: 42, message_id: "m-42", channel_name: "general", channel_type: "channel" }],
      source: "verified_contiguous_content_consumption",
    });
    assert.equal((manager as any).agentVisibleDelivery.hasAgentState("agent-1"), true, "visible ledger seeded");

    // Silent (daemon-internal) stop → visible-state must be preserved.
    await manager.stopAgent("agent-1", { silent: true });

    assert.equal(
      (manager as any).agentVisibleDelivery.hasAgentState("agent-1"),
      true,
      "silent stop must keep the visible ledger (else re-delivery misses dedup → re-wakeup)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan subprocess prevention: stopAgent with wait=true must SIGKILL
// processes that survive SIGTERM (daemon restart → orphan child prevention).
// RED without the SIGKILL in wait-timeout callback; GREEN once the timeout
// sends SIGKILL before resolving.
// ─────────────────────────────────────────────────────────────────────────────

test("stopAgent wait=true sends SIGKILL when child process ignores SIGTERM (orphan prevention)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const proc = driver.processes[0];
    assert.ok(proc, "agent process must exist");

    // Make the child process ignore SIGTERM (simulates a slow-to-exit runtime)
    proc.ignoredKillSignals.add("SIGTERM");

    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const originalKill = proc.kill.bind(proc);
    proc.kill = (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return originalKill(signal);
    };

    await manager.stopAgent("agent-1", { wait: true, silent: true });

    assert.ok(
      killSignals.includes("SIGKILL"),
      `stopAgent must send SIGKILL after wait timeout when SIGTERM is ignored; signals sent: ${JSON.stringify(killSignals)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stopAll verify-then-exit: after all stopAgent calls complete, stopAll must
// probe surviving child PIDs and SIGKILL them before returning. This prevents
// orphan subprocesses when the runner (daemon __run process) exits.
// Uses a real subprocess to test the process.kill(pid, 0) probe + SIGKILL path.
// ─────────────────────────────────────────────────────────────────────────────

test("stopAll SIGKILLs real subprocess that survives SIGTERM", async () => {
  const { spawn: realSpawn } = await import("node:child_process");

  // Spawn a real process that traps SIGTERM and stays alive.
  const child = realSpawn("node", ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const childPid = child.pid;
  assert.ok(typeof childPid === "number", "real child must have a PID");

  try {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      await flush();

      const fakeProc = driver.processes[0];
      assert.ok(fakeProc, "agent process must exist");

      // Graft the real PID onto the FakeChildProcess so stopAll snapshots it.
      (fakeProc as any).pid = childPid;

      // FakeChildProcess.kill exits immediately on SIGTERM (can't prevent that
      // in the mock), but the real child ignores SIGTERM. stopAll's post-stop
      // verify loop probes the real PID via process.kill(pid, 0) and must
      // SIGKILL it.
      await manager.stopAll();

      // The real subprocess must be dead after stopAll returns.
      let alive = false;
      try {
        process.kill(childPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `subprocess ${childPid} must be dead after stopAll`);
    });
  } finally {
    // Safety net: kill child if test fails before stopAll runs.
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});

test("#688 E2E positive arm: active-turn Claude crash emits typed runtimeError carrier on runtime_crashed", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.driver.id, "claude", "FakeClaudeDriver must be claude");
    // Advance to an ACTIVE runtime-trace span (non-idle) => parsed_event boundary satisfied
    // at close, so the crash takes the else (non-startup) branch that broadcasts runtime_crashed.
    // Open an ACTIVE runtime trace span (as a mid-turn state) so parsed_event boundary
    // is not satisfied at close => closeBeforeTurnBoundary=true => else(non-startup) branch.
    (manager as any).startRuntimeTrace("agent-1", ap, "e2e-turn", []);
    assert.ok(ap.runtimeTraceSpan, "runtime trace span must be active before crash");
    ap.lastRuntimeError = "ProviderModelNotFoundError: failed with model 'claude-4' (500)";
    ap.recentStderr = ["ProviderModelNotFoundError: failed with model 'claude-4' (500)"];

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    // With lastRuntimeError present, the crash emits the runtime_error arm (mutually
    // exclusive against runtime_crashed), carrying the diagnostic payload.
    const errors = sent.filter((m) =>
      m.type === "agent:activity" && (m as { detailKind?: string }).detailKind === "runtime_error",
    ) as Extract<MachineToServerMessage, { type: "agent:activity" }>[];
    assert.ok(errors.length >= 1, "active-turn crash with lastRuntimeError MUST emit runtime_error");
    const error = errors.at(-1);
    const err = (error as { runtimeError?: { errorClass?: string; errorReason?: string; fingerprint?: string } }).runtimeError;
    assert.ok(err, "runtime_error must carry a typed runtimeError diagnostic");
    assert.equal(err?.errorClass, "RuntimeError", "ProviderModelNotFoundError normalizes to RuntimeError (not in closed enum)");
    assert.equal(err?.errorReason, "unclassified_runtime_error");
    assert.equal(typeof err?.fingerprint, "string");
    assert.match(err?.fingerprint ?? "", /^[0-9a-f]{16}$/);
  });
});

test("#688 E2E negative arm: startup-period crash must NOT emit runtime_crashed (no false-hit)", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    assert.equal(ap.driver.id, "claude");
    // Crash DURING startup (no active-trace commit) => startup-skip path only sends
    // inactive, never runtime_crashed (the anti-false-hit arm of the tooth).
    ap.lastRuntimeError = "ProviderModelNotFoundError: failed with model 'claude-4' (500)";
    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    const crashes = sent.filter((m) =>
      m.type === "agent:activity" && (m as { detailKind?: string }).detailKind === "runtime_crashed",
    ) as Extract<MachineToServerMessage, { type: "agent:activity" }>[];
    assert.equal(crashes.length, 0, "startup-skip path must NOT emit runtime_crashed");
  });
});

test("#688 E2E poisoned-visible: runtime_error detail/entries are scrubbed on the crash arm", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    // Poisoned stderr: an env-assignment secret the old visible path would leak raw.
    const secret = "ANTHROPIC_API_KEY=sk-ant-this-is-a-secret-1234567890";
    ap.lastRuntimeError = `ProviderModelNotFoundError: failed with ${secret} (500)`;
    ap.recentStderr = [`ProviderModelNotFoundError: failed with ${secret} (500)`];

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    const errors = sent.filter((m) =>
      m.type === "agent:activity" && (m as { detailKind?: string }).detailKind === "runtime_error",
    ) as Extract<MachineToServerMessage, { type: "agent:activity" }>[];
    assert.ok(errors.length >= 1, "must emit runtime_error");
    const err = errors.at(-1);
    const join = [String((err as { detail?: unknown }).detail ?? ""), JSON.stringify((err as { entries?: unknown }).entries ?? [])].join(" ");
    assert.ok(!join.includes("sk-ant-this-is-a-secret-1234567890"), "env secret VALUE must not appear in visible detail/entries (key label may stay)");
    assert.match(join, /ANTHROPIC_API_KEY\s*=\s*\[REDACTED_TOKEN\]/, "env assignment must be redacted in visible surface");
  });
});

test("#688 E2E stderr-only arm: no lastRuntimeError crash falls back to runtime_crashed with typed carrier", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    // stderr-only (no lastRuntimeError) — validates the recentStderr fallback in the helper.
    ap.lastRuntimeError = null;
    ap.recentStderr = ["ProviderApiError: API Error: 500 upstream failure"];

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    const crashes = sent.filter((m) =>
      m.type === "agent:activity" && (m as { detailKind?: string }).detailKind === "runtime_crashed",
    ) as Extract<MachineToServerMessage, { type: "agent:activity" }>[];
    assert.ok(crashes.length >= 1, "stderr-only (no lastRuntimeError) crash falls back to runtime_crashed arm");
    const err = (crashes.at(-1) as { runtimeError?: { errorClass?: string; errorReason?: string } }).runtimeError;
    assert.ok(err, "stderr-only crash fallback arm must carry a typed runtimeError diagnostic (recentStderr source)");
  });
});

test("#688 E2E bounded-visible: long poisoned crash detail is redacted AND capped on the sent activity", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    const long = "ProviderModelNotFoundError: upstream model not found ".repeat(200);
    const secret = "ANTHROPIC_API_KEY=sk-ant-this-is-a-long-secret-value-1234567890";
    ap.lastRuntimeError = `${long} ${secret}`;
    ap.recentStderr = [`${long} ${secret}`];

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();

    const errors = sent.filter((m) =>
      m.type === "agent:activity" && (m as { detailKind?: string }).detailKind === "runtime_error",
    ) as Extract<MachineToServerMessage, { type: "agent:activity" }>[];
    assert.ok(errors.length >= 1, "must emit runtime_error");
    const err = errors.at(-1);
    const detail = String((err as { detail?: unknown }).detail ?? "");
    const join = detail + " " + JSON.stringify((err as { entries?: unknown }).entries ?? []);
    // (a) redacted half: the env-secret VALUE must not surface.
    assert.ok(!join.includes("sk-ant-this-is-a-long-secret-value-1234567890"), "env secret VALUE must be redacted in visible surface");
    // (b) bounded half: the visible detail string must be capped.
    assert.ok(detail.length <= 520, "visible runtime_error detail must be bounded (~512B cap)");
  });
});


test("runtime rate-limit telemetry remains diagnostic without publishing account usage", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());
    driver.parsedLines.set("rate-limit", [{
      kind: "telemetry",
      name: "rate_limits",
      source: "claude_rate_limit_event",
      attrs: { status: "allowed", rateLimitType: "five_hour" },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("rate-limit\n"));
    await flush();
    assert.ok(sink.getAllSpans().some((span) => span.name === "daemon.runtime.telemetry.rate_limits"));
    assert.deepEqual(sent.filter((message) => message.type === "machine:runtime_account_usage:snapshot"), []);
  }, { tracer });
});
