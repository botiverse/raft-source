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
import { assertBodyOnlyInInboxPreview } from "./testing/inboxPreview";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AxSurfaceText,
  BasicTracer,
  CONTEXT_GENERATION_FILENAME,
  DAEMON_LOG_TURN_BOUNDARIES,
  EMPTY_WAKE_CONTINUATION_MS,
  MemoryTraceSink,
  PASSIVE_RENDER_COUNTS_DDL,
  PASSIVE_RENDER_COUNTS_UPSERT,
  summarizeTurnsFromLog,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
  type Tracer,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import {
  ApmTraceRecorder,
  buildBehaviorDeltaRow,
  evaluateApmTracePredicateFixtures,
  serializeApmTraceArtifacts,
} from "./apmStateMachineTrace";
import { computeInboxNoticeFingerprint, RuntimeNotificationState } from "./runtimeNotificationState";
import { setSessionReadyDeliveryRetrySchedulerFactoryForTesting } from "./agentInboxDeliveryDebt";
import { FakeClock } from "./testing/fakeClock";
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
} from "./apmStateMachine";
import type {
  ApmObservedGatedStdinEffect,
  ApmTraceArtifactBundle,
  PredicateFixtureResult,
} from "./apmStateMachineTrace";
import { AgentProcessManager, providerLimitBackoffDelayMs, QUOTA_RESET_BACKOFF_MAX_MS } from "./agentProcessManager";
import { writeContextGeneration } from "./contextGeneration";
import { senderLedgerPath } from "./senderLedger";
import { buildCliTransportDir } from "./drivers/cliTransport";
import { installManagedRunnerCredentialFetch } from "./testing/managedRunnerCredentialFetch";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { exampleThirdPartyEvent } from "./axExampleFixtures";
import { createSystemCleanerAppRegistry } from "./apps/cleaner/definition";
import { formatAgentInboxAppItems, type AgentInboxAppItem } from "@botiverse/raft-shared";
import { installDaemonFetchMockForTests } from "./daemonFetch";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import type { RuntimeLaunchVersionPolicy } from "./drivers/types";
import { RuntimeVersionTooOldError } from "./runtimeLaunchVersion";
import { traceRows } from "./testing/traceRows";
import { CREDENTIAL_PROBLEM_MESSAGES } from "./runtimeErrorDiagnostics";
import { ClaudeEventNormalizer } from "./drivers/claudeEventNormalizer";
import { makeDeterministicTracer } from "./testing/deterministicTracer";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

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
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
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
    // No credential id by default: a stop would revoke it over the injected
    // fetch, and tests that do not fake the server must not send anything.
    agentCredentialId: null,
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
    appInboxForAgent?: (agentId: string) => AgentAppInboxStore;
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
      appInboxForAgent: options.appInboxForAgent,
    },
  );
  setSessionReadyDeliveryRetrySchedulerFactoryForTesting(options.sessionReadyDeliveryRetrySchedulerFactory ?? null);

  try {
    await fn({ driver, manager, sent, dataDir });
  } finally {
    await releaseAgentManagerForTests(manager);
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

// task #356: the stop-time credential revoke goes through the manager's
// injectable fetch. Before, it called the module-level daemonFetch, so every
// test that stopped an agent carrying `agentCredentialId` sent a real DELETE to
// daemon.example.com; the package-wide network guard now fails such a test.
test("stopAgent revokes the managed runner credential through the injected fetch", async () => {
  const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url: input, authorization: headers.get("authorization") });
    return new Response(null, { status: 204 });
  };
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1", agentCredentialId: "cred-test" }));
    assert.deepEqual(requests, [], "start with a pre-minted credential sends nothing");

    await manager.stopAgent("agent-1");
    await flush();

    assert.deepEqual(requests, [{
      method: "DELETE",
      url: "https://daemon.example.com/internal/computer/runners/agent-1/credentials/cred-test",
      authorization: "Bearer sk_machine_test",
    }]);
  }, { fetchImpl });
});

// #wg-rbac:#27: a start rebound onto a process or start the host already has
// keeps that one's runner credential; the credential the start brought is
// revoked once (it was left valid on the server for good), and the running
// one is revoked only when the process ends.
// Teeth: drop the carryRunnerCredential calls in agentProcessManager.ts -> no
// revoke of cred-new (running, queued) or of cred-old's replacement -> RED.
function credentialRevokes() {
  const revoked: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    if (init?.method === "DELETE") revoked.push(new URL(input).pathname.split("/").at(-1)!);
    return new Response(null, { status: 204 });
  };
  return { revoked, fetchImpl };
}

test("a start rebound onto the running process revokes its own credential, never the running one", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_old", agentCredentialId: "cred-old" }), undefined, undefined, undefined, "L-1");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_new", agentCredentialId: "cred-new" }), undefined, undefined, undefined, "L-2");
    await flush();
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal((manager as any).agents.get("agent-1")?.launchId, "L-2", "the process carries the rebound launch");
    assert.equal((manager as any).agents.get("agent-1")?.config.agentCredentialId, "cred-old", "the process keeps its credential");
    assert.deepEqual(revoked, ["cred-new"], "only the rebound start's unused credential is revoked");

    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-new", "cred-old"], "stop revokes the running credential once");
  }, { fetchImpl });
});

test("a start rebound onto a queued start keeps the queued start's credential and revokes its own", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    setAgentStartCapacityFull(manager);
    const queued = manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_old", agentCredentialId: "cred-old" }), undefined, undefined, undefined, "L-1");
    await flush();
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_new", agentCredentialId: "cred-new" }), undefined, undefined, undefined, "L-2");
    await flush();
    assert.deepEqual(revoked, ["cred-new"]);
    (manager as any).releaseAgentStartSlot("test-slot", "test: slot freed");
    await queued;
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-old", "the queued start spawns with its own credential");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_old");
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-new", "cred-old"]);
  }, { fetchImpl });
});

test("a start that lands mid-spawn revokes its own credential; the spawn keeps the first start's", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    const realBuildSpawnConfig = (manager as any).buildSpawnConfig.bind(manager);
    let releaseSpawnConfig!: () => void;
    const spawnConfigGate = new Promise<void>((resolve) => { releaseSpawnConfig = resolve; });
    let spawnConfigEntered!: () => void;
    const enteredSpawnConfig = new Promise<void>((resolve) => { spawnConfigEntered = resolve; });
    (manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => {
      spawnConfigEntered();
      await spawnConfigGate;
      return realBuildSpawnConfig(agentId, config);
    };

    const first = manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_old", agentCredentialId: "cred-old" }), undefined, undefined, undefined, "L-1");
    await enteredSpawnConfig;
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_new", agentCredentialId: "cred-new" }), undefined, undefined, undefined, "L-2");
    assert.deepEqual(revoked, ["cred-new"], "the deferred rebind's credential is revoked when deferred");
    releaseSpawnConfig();
    await first;
    await flush();

    assert.equal((manager as any).agents.get("agent-1")?.launchId, "L-2");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-old");
    assert.equal((manager as any).agents.get("agent-1")?.config.agentCredentialId, "cred-old");
    assert.deepEqual(revoked, ["cred-new"], "the running credential is not revoked by the late rebind");
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-new", "cred-old"]);
  }, { fetchImpl });
});

// #wg-rbac:#27: a start that never gets a process (queued start cancelled by
// a stop, spawn failed before or after the process record) revokes the
// credential it brought exactly once.
// Teeth: drop releaseUnheldRunnerCredential in cancelQueuedAgentStart / the
// spawn's finally, or the revoke dedupe -> RED.
test("a queued start cancelled by a stop revokes its credential once", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    setAgentStartCapacityFull(manager);
    const queued = manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_q", agentCredentialId: "cred-q" }), undefined, undefined, undefined, "L-1");
    await flush();
    await manager.stopAgent("agent-1");
    await queued;
    await flush();
    assert.equal(driver.spawnCalls.length, 0);
    assert.deepEqual(revoked, ["cred-q"]);
  }, { fetchImpl });
});

// #wg-rbac:#27: the daemon's ready lists the runner credentials this host
// holds: a queued start's, a spawn's in progress, a running process's; none
// once the process stopped.
// Teeth: drop the queued or the spawning part of getHeldRunnerCredentialIds -> RED.
test("getHeldRunnerCredentialIds: a queued start, a spawn in progress and a running process hold their credential", async () => {
  const { fetchImpl } = credentialRevokes();
  await withManager(async ({ manager }) => {
    assert.deepEqual(manager.getHeldRunnerCredentialIds(), []);
    const realBuildSpawnConfig = (manager as any).buildSpawnConfig.bind(manager);
    let releaseSpawnConfig!: () => void;
    const spawnConfigGate = new Promise<void>((resolve) => { releaseSpawnConfig = resolve; });
    let spawnConfigEntered!: () => void;
    const enteredSpawnConfig = new Promise<void>((resolve) => { spawnConfigEntered = resolve; });
    (manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => {
      spawnConfigEntered();
      await spawnConfigGate;
      return realBuildSpawnConfig(agentId, config);
    };
    setAgentStartCapacityFull(manager);
    const queued = manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_q", agentCredentialId: "cred-q" }), undefined, undefined, undefined, "L-1");
    await flush();
    assert.deepEqual(manager.getHeldRunnerCredentialIds(), ["cred-q"], "a queued start holds its credential");
    (manager as any).releaseAgentStartSlot("test-slot", "test: slot freed");
    await enteredSpawnConfig;
    assert.deepEqual(manager.getHeldRunnerCredentialIds(), ["cred-q"], "a spawn in progress holds its credential");
    releaseSpawnConfig();
    await queued;
    await flush();
    assert.deepEqual(manager.getHeldRunnerCredentialIds(), ["cred-q"], "the running process holds its credential");
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(manager.getHeldRunnerCredentialIds(), [], "a stopped process holds none");
  }, { fetchImpl });
});

test("a start whose spawn fails before a process exists revokes its credential once", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    (manager as any).buildSpawnConfig = async () => { throw new Error("spawn config failed"); };
    await assert.rejects(manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_f", agentCredentialId: "cred-f" }), undefined, undefined, undefined, "L-1"));
    await flush();
    assert.equal(driver.spawnCalls.length, 0);
    assert.deepEqual(revoked, ["cred-f"]);
  }, { fetchImpl });
});

test("a start whose driver spawn throws revokes its credential once, not twice", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    driver.spawn = () => { throw new Error("spawn exploded"); };
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_d", agentCredentialId: "cred-d" }), undefined, undefined, undefined, "L-1").catch(() => {});
    await flush();
    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.deepEqual(revoked, ["cred-d"]);
  }, { fetchImpl });
});

// Warden review of #wg-rbac:#27: the spawn's `finally` releases only a
// credential no process holds. A successful spawn registers its process (with
// the start's or the spawn-minted key) before the `finally` runs, so it never
// revokes its own key; only the process's end does, once.
// Teeth: make releaseUnheldRunnerCredential skip the `this.agents` check -> RED.
test("a successful spawn with the core's credential revokes nothing; the stop revokes it once", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_core", agentCredentialId: "cred-core" }), undefined, undefined, undefined, "L-1");
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_core");
    assert.equal((manager as any).agents.get("agent-1")?.config.agentCredentialKey, "sk_agent_core");
    assert.deepEqual(revoked, [], "a spawned process keeps its credential");
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-core"]);
  }, { fetchImpl });
});

test("a spawn that mints its credential (daemon-local start, no core key) keeps it; the stop revokes it once", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    let mints = 0;
    (manager as any).requestManagedRunnerCredentialOnce = async () => {
      mints += 1;
      return { apiKey: "sk_agent_spawn", credentialId: "cred-spawn" };
    };
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: null, agentCredentialId: null }));
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mints, 1);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_spawn", "the runtime is launched with the minted key");
    assert.equal((manager as any).agents.get("agent-1")?.config.agentCredentialKey, "sk_agent_spawn", "the live process holds it");
    assert.deepEqual(revoked, []);
    // The process keeps working on it: a message is still delivered.
    driver.processes[0]!.stdout.emit("data", Buffer.from("noop\n"));
    assert.equal(await manager.deliverMessage("agent-1", makeMessage("still alive")), true);
    await flush();
    assert.deepEqual(revoked, []);
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-spawn"]);
  }, { fetchImpl });
});

test("the spawn registers its process before the runtime starts; when the spawn's cleanup runs, a live process holds each key", async () => {
  const { revoked, fetchImpl } = credentialRevokes();
  await withManager(async ({ manager, driver }) => {
    const atSpawn: Array<{ registered: boolean; revokes: number }> = [];
    const realSpawn = driver.spawn.bind(driver);
    driver.spawn = (ctx) => {
      atSpawn.push({ registered: (manager as any).agents.has("agent-1"), revokes: revoked.length });
      return realSpawn(ctx);
    };
    const releases: Array<{ key: string | null | undefined; heldBy: Array<string | null | undefined> }> = [];
    const realRelease = (manager as any).releaseUnheldRunnerCredential.bind(manager);
    (manager as any).releaseUnheldRunnerCredential = (agentId: string, config: AgentConfig, launchId: string | null) => {
      releases.push({ key: config.agentCredentialKey, heldBy: [...(manager as any).agents.values()].map((ap: any) => ap.config.agentCredentialKey) });
      realRelease(agentId, config, launchId);
    };
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", agentCredentialKey: "sk_agent_core", agentCredentialId: "cred-core" }), undefined, undefined, undefined, "L-1");
    await flush();
    assert.deepEqual(atSpawn, [{ registered: true, revokes: 0 }]);
    assert.ok(releases.length >= 1, "the spawn's cleanup ran");
    for (const release of releases) assert.ok(release.heldBy.includes(release.key), `held when released: ${JSON.stringify(release)}`);
    assert.deepEqual(revoked, []);
    await manager.stopAgent("agent-1");
    await flush();
    assert.deepEqual(revoked, ["cred-core"]);
  }, { fetchImpl });
});

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

test("task #17: a finished tool call records its id, outcome, exit code and daemon-measured duration on the Tool finished row", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "Bash", input: { command: "pnpm test" }, callId: "toolu_1" }]);
    driver.parsedLines.set("tool-end", [{ kind: "tool_output", name: "toolu_1", callId: "toolu_1", ok: true, exitCode: 1 }]);
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();
      now += 2_500;
      driver.processes[0].stdout.emit("data", Buffer.from("tool-end\n"));
      await flush();
    } finally {
      Date.now = realNow;
    }
    const entries = sent.flatMap((msg) => msg.type === "agent:activity" ? msg.entries ?? [] : []);
    const start = entries.find((e) => e.kind === "tool_start");
    assert.equal(start?.kind === "tool_start" ? start.callId : undefined, "toolu_1");
    const finished = entries.find((e) => e.kind === "status" && e.detailKind === "tool_end");
    assert.ok(finished?.kind === "status");
    assert.deepEqual(finished.tool, { callId: "toolu_1", ok: true, durationMs: 2_500, exitCode: 1 });
  });
});

test("task #17: a tool end the runtime reports nothing about keeps the bare Tool finished row", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "ls" } }]);
    driver.parsedLines.set("tool-end", [{ kind: "tool_output", name: "shell" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    await flush();
    driver.processes[0].stdout.emit("data", Buffer.from("tool-end\n"));
    await flush();
    const entries = sent.flatMap((msg) => msg.type === "agent:activity" ? msg.entries ?? [] : []);
    const finished = entries.find((e) => e.kind === "status" && e.detailKind === "tool_end");
    assert.ok(finished?.kind === "status");
    assert.equal("tool" in finished, false, "no outcome is claimed when the runtime said nothing");
  });
});

test("task #17: a turn ends with one turn_summary entry folding its trigger, actions and problems", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("please fix the tests", { channel_name: "proj-runtime", message_id: "msg-wake", seq: 7, sender_name: "Tenny" }),
      { deliveryId: "delivery-wake" },
    );
    assert.equal(accepted, true);
    await waitFor(() => driver.encodedCalls.length === 1, "idle delivery written");
    driver.parsedLines.set("grep", [{ kind: "tool_call", name: "Bash", input: { command: "grep -rn listRecentActivityLog src" }, callId: "t1" }]);
    driver.parsedLines.set("grep-end", [{ kind: "tool_output", name: "t1", callId: "t1", ok: true }]);
    driver.parsedLines.set("test", [{ kind: "tool_call", name: "Bash", input: { command: "npx vitest run src/a.test.ts" }, callId: "t2" }]);
    driver.parsedLines.set("test-end", [{ kind: "tool_output", name: "t2", callId: "t2", ok: true, exitCode: 1 }]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    for (const line of ["grep", "grep-end", "test", "test-end", "turn-end"]) {
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    }
    // The proxy reports the reply the agent sent; it lands in the open turn
    // only before the turn ends, so this one belongs to no turn.
    (manager as any).turnSummaries.noteSendOutcome("agent-1", { state: "sent", messageId: "late" }, Date.now());

    const summaries = sent.flatMap((msg) => msg.type === "agent:activity" ? msg.entries ?? [] : [])
      .filter((entry) => entry.kind === "turn_summary");
    assert.equal(summaries.length, 1, "exactly one summary per turn");
    const summary = summaries[0]!.kind === "turn_summary" ? summaries[0]!.summary : undefined;
    assert.ok(summary);
    assert.equal(summary.outcome, "completed");
    assert.deepEqual(summary.trigger, { target: "#proj-runtime", channelId: "channel-1", sender: "Tenny", messageId: "msg-wake" });
    assert.deepEqual(summary.actions, [{ kind: "search", count: 1 }, { kind: "run_checks", count: 1 }]);
    assert.deepEqual(summary.problems.map(({ kind, reason, exitCode }) => ({ kind, reason, exitCode })), [
      { kind: "run_checks", reason: "exit_nonzero", exitCode: 1 },
    ]);
    assert.equal(summary.messagesSent, 0);
    assert.ok(summary.endedAt >= summary.startedAt);
  });
});

test("task #17: a turn's summary carries the runtime's last output text, not the daemon's diagnostic text", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("bash", [{ kind: "tool_call", name: "Bash", input: { command: "ls" }, callId: "t1" }]);
    driver.parsedLines.set("bash-end", [{ kind: "tool_output", name: "t1", callId: "t1", ok: true }]);
    driver.parsedLines.set("text", [{ kind: "text", text: "Listed the files; the message said no reply needed, so I didn't reply." }]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    await emitLines(driver, ["bash", "bash-end", "text"]);
    (manager as any).flushPendingTrajectory("agent-1");
    // A reconnect notice's text row (stderr) after the reply: the daemon's, not the runtime's output.
    (manager as any).broadcastActivity("agent-1", "working", "Codex reconnecting to provider…", [{ kind: "text", text: "stream disconnected, retrying" }], undefined, "runtime_reconnecting");
    await emitLines(driver, ["turn-end"]);
    const [summary, ...rest] = publishedTurnSummaries(sent);
    assert.equal(rest.length, 0);
    assert.equal(summary?.lastText, "Listed the files; the message said no reply needed, so I didn't reply.");
  });
});

function publishedTurnSummaries(sent: MachineToServerMessage[]) {
  return activityMessages(sent).flatMap((msg) => msg.entries ?? []).flatMap((entry) => entry.kind === "turn_summary" ? [entry.summary] : []);
}

/** Hand an idle agent one message (an idle-mode write, which opens a turn). */
async function wakeIdleAgent(manager: AgentProcessManager, driver: FakeClaudeDriver, messageId: string, senderName: string) {
  const ap = getProcess(manager, "agent-1");
  (manager as any).commitApmIdleState("agent-1", ap, true);
  const writes = driver.encodedCalls.length;
  const accepted = await manager.deliverMessage(
    "agent-1",
    makeMessage("please look", { channel_name: "proj-runtime", message_id: messageId, sender_name: senderName }),
    { deliveryId: `delivery-${messageId}` },
  );
  assert.equal(accepted, true);
  await waitFor(() => driver.encodedCalls.length === writes + 1, "idle delivery written");
}

async function emitLines(driver: FakeClaudeDriver, lines: readonly string[]) {
  for (const line of lines) {
    driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
  }
}

test("task #17: a wake the next Claude `result` ends before any work is one turn with the work that follows", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("text", [{ kind: "text", text: "picking the notice up" }]);
    driver.parsedLines.set("bash", [{ kind: "tool_call", name: "Bash", input: { command: "npx vitest run src/a.test.ts" }, callId: "t1" }]);
    driver.parsedLines.set("bash-end", [{ kind: "tool_output", name: "t1", callId: "t1", ok: true }]);
    driver.parsedLines.set("grep", [{ kind: "tool_call", name: "Bash", input: { command: "grep -rn x src" }, callId: "t2" }]);
    driver.parsedLines.set("grep-end", [{ kind: "tool_output", name: "t2", callId: "t2", ok: true }]);

    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    const trigger = { target: "#proj-runtime", channelId: "channel-1", sender: "Tenny", messageId: "msg-wake" };
    const received = activityMessages(sent).filter((msg) => msg.detail === "Message received").flatMap((msg) => msg.entries ?? []);
    assert.deepEqual(received.map((entry) => entry.kind === "status" ? entry.trigger : entry.kind), [trigger], "the frame that opens the turn names its trigger for the server's running turn");
    // Claude was still on a queued notice: its `result` ends the daemon's turn at once.
    await emitLines(driver, ["turn-end"]);
    assert.equal(activityMessages(sent).at(-1)?.detail, "Idle");
    assert.deepEqual(publishedTurnSummaries(sent), [], "the empty wake is held");

    await emitLines(driver, ["text", "bash", "bash-end", "grep", "grep-end", "turn-end"]);
    const summaries = publishedTurnSummaries(sent);
    assert.equal(summaries.length, 1, "one turn, not an empty wake and a turn with no trigger");
    assert.deepEqual(summaries[0]!.trigger, trigger);
    assert.equal(summaries[0]!.toolCalls, 2);
    assert.deepEqual(summaries[0]!.actions, [{ kind: "run_checks", count: 1 }, { kind: "search", count: 1 }]);
  });
});

for (const { label, turnEnd, outcome } of [
  { label: "completed", turnEnd: { kind: "turn_end", sessionId: "session-1" }, outcome: "completed" },
  { label: "interrupted", turnEnd: { kind: "turn_end", sessionId: "session-1", interrupted: true }, outcome: "interrupted" },
] as const) test(`task #17: messages queued during a turn and handed over at its end close it as it ended (${label}), not unknown`, async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    // Hold the message until the turn ends, as for a runtime that cannot take messages mid-turn.
    Object.defineProperty(driver, "busyDeliveryMode", { value: "none" });
    driver.parsedLines.set("bash", [{ kind: "tool_call", name: "Bash", input: { command: "ls" }, callId: "t1" }]);
    driver.parsedLines.set("bash-end", [{ kind: "tool_output", name: "t1", callId: "t1", ok: true }]);
    driver.parsedLines.set("turn-end", [turnEnd]);

    await wakeIdleAgent(manager, driver, "msg-1", "xxchan");
    await emitLines(driver, ["bash"]);
    const writes = driver.encodedCalls.length;
    assert.equal(await manager.deliverMessage("agent-1", makeMessage("one more", { message_id: "msg-2", sender_name: "xxchan" }), { deliveryId: "delivery-msg-2" }), true);
    assert.equal(driver.encodedCalls.length, writes, "queued while the turn runs");
    await emitLines(driver, ["bash-end", "turn-end"]);
    await waitFor(() => driver.encodedCalls.length === writes + 1, "queued message handed over at the turn end");
    assert.equal(driver.encodedCalls.at(-1)?.mode, "idle");
    assert.notEqual(activityMessages(sent).at(-1)?.detail, "Idle", "no idle frame between the two turns");

    const summaries = publishedTurnSummaries(sent);
    assert.equal(summaries.length, 1, "the first turn closes with the second one's start");
    assert.equal(summaries[0]!.outcome, outcome);
    assert.equal(summaries[0]!.trigger?.messageId, "msg-1");
  });
});

test("task #17: work after an empty wake that waits on a background task without a status still joins the wake", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("agent", [{ kind: "tool_call", name: "Agent", input: { description: "review" }, callId: "toolu_task_a" }]);
    driver.parsedLines.set("agent-end", [{ kind: "tool_output", name: "toolu_task_a", callId: "toolu_task_a", ok: true }]);
    driver.parsedLines.set("a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("a-unknown", subagentLine("notification", "task_a"));
    driver.parsedLines.set("a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));

    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    await emitLines(driver, ["turn-end", "agent", "a-start", "agent-end", "turn-end", "a-unknown"]);
    assert.equal(activityMessages(sent).at(-1)?.detail, "Waiting for 1 background task");
    assert.deepEqual(publishedTurnSummaries(sent), [], "still one turn, running");

    await emitLines(driver, ["a-done"]);
    assert.equal(activityMessages(sent).at(-1)?.detail, "Idle");
    const summaries = publishedTurnSummaries(sent);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.trigger?.messageId, "msg-wake");
    assert.equal(summaries[0]!.toolCalls, 1);
  });
});

test("task #17: a wake left unanswered is still a turn: the next wake publishes it, a stop publishes the last", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);

    await wakeIdleAgent(manager, driver, "msg-1", "Tenny");
    await emitLines(driver, ["turn-end"]);
    await wakeIdleAgent(manager, driver, "msg-2", "alice");
    const [first, ...none] = publishedTurnSummaries(sent);
    assert.equal(none.length, 0);
    assert.deepEqual({ messageId: first?.trigger?.messageId, outcome: first?.outcome, toolCalls: first?.toolCalls }, { messageId: "msg-1", outcome: "completed", toolCalls: 0 });

    await emitLines(driver, ["turn-end"]);
    await manager.stopAgent("agent-1");
    await flush();
    const summaries = publishedTurnSummaries(sent);
    assert.deepEqual(summaries.map((summary) => [summary.trigger?.messageId, summary.outcome, summary.toolCalls]), [
      ["msg-1", "completed", 0],
      ["msg-2", "completed", 0],
    ]);
  });
});

test("task #17: work after the bound releases a held empty wake ahead of its own entries, and the server's fold starts the new turn at its first tool call", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("bash", [{ kind: "tool_call", name: "Bash", input: { command: "ls" }, callId: "t1" }]);
    driver.parsedLines.set("bash-end", [{ kind: "tool_output", name: "t1", callId: "t1", ok: true }]);
    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    await emitLines(driver, ["turn-end"]);
    assert.deepEqual(publishedTurnSummaries(sent), []);

    const realNow = Date.now;
    const late = realNow() + EMPTY_WAKE_CONTINUATION_MS + 1_000;
    Date.now = () => late;
    try {
      await emitLines(driver, ["bash", "bash-end"]);
      assert.deepEqual(publishedTurnSummaries(sent).map((summary) => [summary.trigger?.messageId, summary.toolCalls]), [["msg-wake", 0]], "the wake is published as the empty turn it was");

      // The rows the server stores from these frames (status entries get
      // their activity back on ingest), folded as the running-turn read does.
      const rows = activityMessages(sent).flatMap((msg) => (msg.entries ?? []).map((entry) => ({
        timestamp: msg.observedAtMs!,
        entry: (entry.kind === "status" ? { ...entry, activity: msg.activityKind ?? msg.activity } : entry) as TrajectoryEntry,
      })));
      const { open } = summarizeTurnsFromLog(rows, DAEMON_LOG_TURN_BOUNDARIES);
      assert.deepEqual(open && [open.summary.startedAt, open.summary.toolCalls, open.summary.trigger], [late, 1, undefined]);

      await emitLines(driver, ["turn-end"]);
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(publishedTurnSummaries(sent).map((summary) => [summary.trigger?.messageId, summary.toolCalls, summary.startedAt === late]), [
      ["msg-wake", 0, false],
      [undefined, 1, true],
    ]);
  });
});

test("task #17: an orderly daemon stop publishes a held empty wake under the launch the server expects", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    await emitLines(driver, ["turn-end"]);
    const launchId = getProcess(manager, "agent-1").launchId || undefined;
    assert.deepEqual(publishedTurnSummaries(sent), []);

    await manager.stopAll();
    const carrying = activityMessages(sent).filter((msg) => (msg.entries ?? []).some((entry) => entry.kind === "turn_summary"));
    assert.equal(carrying.length, 1);
    assert.deepEqual([carrying[0]!.launchId, carrying[0]!.detail, carrying[0]!.detailKind], [launchId, "Idle", "idle"], "a re-statement of the current activity");
    assert.deepEqual(publishedTurnSummaries(sent).map((summary) => [summary.trigger?.messageId, summary.toolCalls]), [["msg-wake", 0]]);
  });
});

test("task #17: an orderly stop does not re-state a typed runtime error to carry a held empty wake", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("error", [{ kind: "error", message: "Budget limit exceeded" }]);
    await wakeIdleAgent(manager, driver, "msg-wake", "Tenny");
    await emitLines(driver, ["turn-end", "error"]);
    const errorFrame = activityMessages(sent).at(-1)!;
    assert.equal(errorFrame.detailKind, "runtime_error");
    assert.ok(errorFrame.runtimeError, "the error frame carries its typed diagnostic");
    const framesBefore = activityMessages(sent).length;

    await manager.stopAll();
    assert.equal(activityMessages(sent).length, framesBefore, "no re-statement without the error's carrier");
    assert.deepEqual(publishedTurnSummaries(sent), [], "the held wake is lost, as before holding");
  });
});

test("task #17: an explicit stop of an agent with no process forgets what the turn tracker holds for it", async () => {
  await withManager(async ({ manager }) => {
    const tracker = (manager as any).turnSummaries;
    tracker.begin("agent-gone", 1_000, { target: "#general", messageId: "m1" });
    tracker.finish("agent-gone", "completed", 2_000);
    await manager.stopAgent("agent-gone");
    assert.deepEqual(tracker.begin("agent-gone", 3_000, undefined), [], "nothing held is left for the next start");
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

// D2 (RFC 072 §7.7): compaction_started issues a new context id into the
// launch's transport dir; compaction_finished does not issue another.
test("Claude APM: compaction_started replaces the context id; compaction_finished keeps it", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    // The process writes where prepareCliTransport put the spawn id.
    assert.equal(ap.cliTransportDir, buildCliTransportDir((manager as any).slockHome, "agent-1", ap.launchId));
    // Keep the test out of the real Raft home; the fake driver does not run
    // prepareCliTransport, so seed its spawn write.
    ap.cliTransportDir = path.join(dataDir, "cli-transport");
    await mkdir(ap.cliTransportDir, { recursive: true });
    const spawnId = writeContextGeneration(ap.cliTransportDir, { reason: "spawn", runtime: "claude", compaction: ap.driver.session.compaction, passiveAx: false });
    const file = path.join(ap.cliTransportDir, CONTEXT_GENERATION_FILENAME);
    const readId = async () => JSON.parse(await readFile(file, "utf8")).contextId as string;

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);

    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();
    const compactedId = await readId();
    assert.notEqual(compactedId, spawnId);
    assert.equal(JSON.parse(await readFile(file, "utf8")).reason, "compaction");

    driver.processes[0].stdout.emit("data", Buffer.from("compact-finish\n"));
    await flush();
    assert.equal(await readId(), compactedId);
  });
});

// task #359: compaction republishes the gate the process was spawned with,
// read from the spawn config, not from the live config.
test("Claude APM: compaction writes carry the passive AX gate from the spawn config", async () => {
  for (const passiveAx of [true, undefined]) {
    await withManager(async ({ driver, manager, dataDir }) => {
      const config = { ...makeConfig({ sessionId: "session-1" }), ...(passiveAx === undefined ? {} : { passiveAx }) } as AgentConfig;
      await manager.startAgent("agent-1", config);
      const ap = getProcess(manager, "agent-1");
      assert.equal(ap.passiveAx, passiveAx === true);
      ap.cliTransportDir = path.join(dataDir, "cli-transport");
      await mkdir(ap.cliTransportDir, { recursive: true });

      driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
      await flush();
      const record = JSON.parse(await readFile(path.join(ap.cliTransportDir, CONTEXT_GENERATION_FILENAME), "utf8"));
      assert.equal(record.reason, "compaction");
      assert.equal(record.passiveAx, passiveAx === true, "an older Server's config (no field) publishes the gate off");
    });
  }
});

// Glimpse layer 2: each turn end takes what the agent's CLI printed of
// passive AX out of its ledger onto the turn span; nothing with passive AX off.
test("Claude APM: the turn span carries and clears the CLI's passive render counts, only with passive AX on", async () => {
  for (const passiveAx of [true, false]) {
    const { sink, tracer } = makeDeterministicTracer();
    await withManager(async ({ driver, manager, dataDir }) => {
      (manager as any).slockHome = dataDir;
      await manager.startAgent("agent-1", { ...makeConfig({ sessionId: "session-1" }), passiveAx } as AgentConfig);
      const ap = getProcess(manager, "agent-1");
      const dbPath = senderLedgerPath(dataDir, "agent-1")!;
      await mkdir(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta (key, value) VALUES ('version', '1')");
      db.exec(PASSIVE_RENDER_COUNTS_DDL);
      db.close();
      assert.equal(ap.agentLedgerPath, dbPath, "the spawn names the agent's ledger");

      (manager as any).commitApmIdleState("agent-1", ap, true);
      assert.equal(await manager.deliverMessage("agent-1", makeMessage("ship it", { message_id: "msg-wake", seq: 7 }), { deliveryId: "delivery-wake" }), true);
      await waitFor(() => driver.encodedCalls.length === 1, "idle delivery written");
      // The CLI prints a card during the turn.
      const cli = new DatabaseSync(dbPath);
      cli.prepare(PASSIVE_RENDER_COUNTS_UPSERT).run(ap.contextId, "channel_card", 320, 350);
      cli.prepare(PASSIVE_RENDER_COUNTS_UPSERT).run(ap.contextId, "channel_card", 320, 350);
      cli.close();
      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
      await flush();

      const turns = traceRows(sink).filter((row) => row.name === "daemon.runtime.turn");
      assert.equal(turns.length, 1, "one turn span");
      const attrs = turns[0]!.attrs ?? {};
      const check = new DatabaseSync(dbPath);
      const left = Number((check.prepare("SELECT COUNT(*) AS n FROM passive_render_counts").get() as { n: number }).n);
      check.close();
      if (!passiveAx) {
        assert.equal(Object.keys(attrs).some((key) => key.startsWith("passive_render_")), false, "passive AX off: no attributes");
        assert.equal(left, 1, "passive AX off: the ledger is not touched (both prints are one row)");
        return;
      }
      assert.equal(attrs.passive_render_outcome, "taken");
      assert.equal(attrs.passive_render_carried_over, false);
      assert.equal(attrs.model_context_id, ap.contextId);
      assert.equal(attrs.passive_render_count, 2);
      assert.equal(attrs.passive_render_char_count, 640);
      assert.equal(attrs.passive_render_channel_card_byte_count, 700);
      assert.equal(attrs.passive_render_other_context_render_count, 0);
      assert.equal(left, 0, "taken counts are cleared");
    }, { tracer });
  }
});

// #botiverse-raft-deployment:#208: the turn span's events go through the byte
// budget, and its end says how many were left off.
test("Claude APM: the turn span keeps its events and reports none dropped for a normal turn", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    assert.equal(await manager.deliverMessage("agent-1", makeMessage("ship it", { message_id: "msg-wake", seq: 7 }), { deliveryId: "delivery-wake" }), true);
    await waitFor(() => driver.encodedCalls.length === 1, "idle delivery written");
    driver.parsedLines.set("tool", [{ kind: "tool_call", name: "Bash", input: { command: "ls" } } as any]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool\n"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const turns = traceRows(sink).filter((row) => row.name === "daemon.runtime.turn");
    assert.equal(turns.length, 1, "one turn span");
    assert.equal(turns[0]!.attrs?.runtime_span_events_dropped_count, 0);
    assert.equal(turns[0]!.attrs?.runtime_span_event_bytes_dropped, undefined);
    assert.ok((turns[0]!.events ?? []).length > 0, "events still reach the span");
  }, { tracer });
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

    // Reconciler step 12: the delivery acts on the sticky failure first (the
    // process ends, the agent is the server's), so nothing is left pending.
    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("sticky terminal pending delivery", { message_id: "msg-sticky-probe", seq: 104 }),
      { deliveryId: "delivery-sticky-probe" },
    );
    assert.equal(accepted, false, "no process takes it: the server's start does");
    assert.equal(ap.inbox.length, 0);

    manager.respondToActivityProbe("agent-1", "probe-sticky-pending-delivery");

    const activity = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity" && msg.probeId === "probe-sticky-pending-delivery",
    );
    assert.ok(activity, "activity probe should receive a response");
    assert.equal(activity.activity, undefined);
    assert.notEqual(activity.detailKind, "message_received");
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

    const telemetrySpan = traceRows(sink)
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

    const telemetrySpan = traceRows(sink)
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

    const telemetrySpan = traceRows(sink)
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

function observedGatedEffectsFromTrace(sink: MemoryTraceSink): ApmObservedGatedStdinEffect[] {
  const effects: ApmObservedGatedStdinEffect[] = [];
  for (const span of traceRows(sink)) {
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
      turnInProgress: true,
      deliveryHold: null,
      openToolHoldsNoLiveWork: false,
      processAlive: undefined,
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
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
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
    turnInProgress: true,
    deliveryHold: null,
    openToolHoldsNoLiveWork: false,
    processAlive: undefined,
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
        assertBodyOnlyInInboxPreview(driver.encodedCalls[before].text, /compaction body must stay queued/);
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

    const runtimeError = traceRows(sink)
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

test("Claude APM: a runtime error after the failed turn's span ended joins that turn's trace", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    // The first error ends the turn span; the runtime reports a second one
    // before its turn end.
    driver.parsedLines.set("first-error", [{ kind: "error", message: "API Error: 500 Internal server error" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("first-error\n"));
    await flush();
    driver.parsedLines.set("second-error", [{ kind: "error", message: "API Error: 529 Overloaded" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("second-error\n"));
    await flush();

    const turnSpan = sink.getAllSpans().find((span) => span.name === "daemon.runtime.turn");
    assert.ok(turnSpan, "the failed turn's span ended");
    assert.equal(turnSpan.status, "error");
    const standaloneError = sink.getAllLogEvents().find((event) => event.name === "daemon.runtime.error");
    assert.ok(standaloneError, "the second error is a standalone daemon.runtime.error record");
    assert.equal(standaloneError.context?.traceId, turnSpan.context.traceId, "it carries the turn's trace id");
    assert.equal(standaloneError.context?.spanId, turnSpan.context.spanId, "its parent is the turn span");

    // After the turn end, an error is outside any turn: no turn context.
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    driver.parsedLines.set("late-error", [{ kind: "error", message: "API Error: 503 Service unavailable" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("late-error\n"));
    await flush();
    const lateError = sink.getAllLogEvents().filter((event) => event.name === "daemon.runtime.error")[1];
    assert.ok(lateError, "the late error is recorded");
    assert.notEqual(lateError.context?.spanId, turnSpan.context.spanId, "an error after the turn end does not join the ended turn");
  }, { tracer });
});

// AndyLok: a Claude turn that failed on a rate limit carried the generic
// RuntimeError and no status on its turn span (fingerprint 35d114d1), so
// dashboards could not tell a rate limit from a real runtime failure. The
// class and status come from Claude's typed API error, as the normalizer
// reports it; only an error with nothing typed or recognisable stays RuntimeError.
async function failedClaudeTurnSpanAttrs(error: Extract<ParsedEvent, { kind: "error" }>): Promise<{ span: Record<string, unknown>; event: Record<string, unknown> }> {
  const { sink, tracer } = makeDeterministicTracer();
  let attrs: { span: Record<string, unknown>; event: Record<string, unknown> } | null = null;
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("failed-turn", [error, { kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("failed-turn\n"));
    await flush();
    const turnSpan = sink.getAllSpans().find((span) => span.name === "daemon.runtime.turn");
    assert.ok(turnSpan, "the failed turn's span ended");
    assert.equal(turnSpan.status, "error");
    const runtimeError = traceRows(sink).flatMap((span) => span.events).find((event) => event.name === "runtime.error");
    assert.ok(runtimeError, "the error is recorded on the turn");
    attrs = { span: turnSpan.attrs as Record<string, unknown>, event: runtimeError.attrs as Record<string, unknown> };
  }, { tracer });
  assert.ok(attrs);
  return attrs;
}

// Claude Code's stream-json line for an API rate limit (2.1.3xx, snake_case).
function claudeRateLimitLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "session-1",
    error: "rate_limit",
    is_api_error_message: true,
    api_error_status: 429,
    api_error_code: "rate_limit_error",
    api_error_origin: "first_party",
  });
}

test("Claude APM: a turn that failed on a Claude rate_limit carries RateLimitError and 429 on its span", async () => {
  // Through the real normalizer, as the host receives it.
  const [error, ...rest] = new ClaudeEventNormalizer().normalizeLine(claudeRateLimitLine("You've hit your limit · resets 1pm (UTC)"));
  assert.equal(rest.length, 0);
  assert.equal(error?.kind, "error");
  const { span, event } = await failedClaudeTurnSpanAttrs(error as Extract<ParsedEvent, { kind: "error" }>);
  for (const attrs of [span, event]) {
    assert.equal(attrs.runtime_error_class, "RateLimitError");
    assert.equal(attrs.turn_reason, "rate_limited");
    assert.equal(attrs.runtime_error_http_status, 429);
  }
  assert.doesNotMatch(JSON.stringify(span), /hit your limit/, "no error text on the span");
});

// The fingerprint ignores reset times, so a run of limit errors now shares one.
// A limit is a wait (the provider-limit backoff), not a failure repeating: it
// must never trip the same-fingerprint fence and stop the agent.
test("Claude APM: repeated rate-limit errors with different reset times never trip the same-fingerprint fence", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const normalizer = new ClaudeEventNormalizer();
    for (const [i, reset] of ["1pm (UTC)", "2:30pm (UTC)", "4pm (Europe/London)", "5pm (UTC)"].entries()) {
      driver.parsedLines.set(`limit-${i}`, normalizer.normalizeLine(claudeRateLimitLine(`You've hit your limit · resets ${reset}`)));
      driver.processes[0].stdout.emit("data", Buffer.from(`limit-${i}\n`));
      await flush();
    }
    assert.ok(getProcess(manager, "agent-1"), "the runtime keeps running");
    assert.equal((manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1"), undefined, "limit errors are not counted");
    assert.equal(traceRows(sink).some((row) => row.name === "daemon.agent.runtime_error_fingerprint_fence.tripped"), false);
    assert.equal(sent.some((msg) => msg.type === "agent:runtime:outcome" && (msg as any).outcome?.kind === "terminal_failure"), false);
  }, { tracer });
});

test("Claude APM: the same real error three times still trips the fence, and its records carry the typed class, the turn's trace and the fingerprint", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    for (let i = 0; i < 3; i += 1) {
      driver.parsedLines.set(`server-error-${i}`, [{
        kind: "error",
        message: "Internal server error",
        nativeReasonPresent: true,
        reasonProvenance: "runtime_error_event",
        providerError: { codes: ["server_error"], httpStatus: 500 },
      }]);
      driver.processes[0].stdout.emit("data", Buffer.from(`server-error-${i}\n`));
      await flush();
    }
    assert.equal(getProcess(manager, "agent-1"), undefined, "the fence stopped the runtime");
    const tripped = traceRows(sink).filter((row) => row.name === "daemon.agent.runtime_error_fingerprint_fence.tripped");
    assert.equal(tripped.length, 1);
    // The text alone says RuntimeError; the fence's records agree with the span.
    assert.equal(tripped[0]!.attrs?.runtime_error_class, "ProviderServerError");
    const counted = traceRows(sink).filter((row) => row.name === "daemon.agent.runtime_error_fingerprint_fence");
    assert.ok(counted.length >= 3);
    assert.ok(counted.every((row) => row.attrs?.runtime_error_class === "ProviderServerError"));
    // The counted, tripped and reset records join the failed turn's trace and
    // name the fingerprint (a hash, never the text) under both spellings.
    const turnTraceIds = new Set(sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn").map((span) => span.context.traceId));
    const reset = traceRows(sink).filter((row) => row.name === "daemon.agent.runtime_error_fingerprint_fence.reset");
    assert.equal(reset.length, 1);
    assert.equal(reset[0]!.attrs?.reset_source, "tripped");
    const fingerprint = tripped[0]!.attrs?.fingerprint;
    assert.match(String(fingerprint), /^[0-9a-f]{16}$/);
    for (const row of [...counted, ...tripped, ...reset]) {
      assert.ok(turnTraceIds.has(row.context.traceId), `${row.name} carries the turn's trace id (got "${row.context.traceId}")`);
      assert.equal(row.attrs?.fingerprint, fingerprint, `${row.name} carries the fingerprint`);
      assert.equal(row.attrs?.runtime_error_fingerprint, fingerprint, `${row.name} carries runtime_error_fingerprint`);
    }
  }, { tracer });
});

test("Claude APM: a turn that failed on verification_required carries AuthError and 403 on its span", async () => {
  const { span } = await failedClaudeTurnSpanAttrs({
    kind: "error",
    message: CREDENTIAL_PROBLEM_MESSAGES.verification_required,
    nativeReasonPresent: true,
    reasonProvenance: "runtime_error_event",
    providerError: { codes: ["verification_required"], httpStatus: 403 },
  });
  assert.equal(span.runtime_error_class, "AuthError");
  assert.equal(span.runtime_error_http_status, 403);
});

test("Claude APM: a failed turn with no typed or recognisable error stays RuntimeError with no status", async () => {
  const { span } = await failedClaudeTurnSpanAttrs({ kind: "error", message: "Execution failed" });
  assert.equal(span.runtime_error_class, "RuntimeError");
  assert.equal(span.turn_reason, "unclassified_runtime_error");
  assert.equal(span.runtime_error_http_status, undefined);
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

// #proj-raft-computer:#46, reconciler step 4a replaces the B.5 churn rule:
// an auth error makes the agent's CREDENTIAL invalid (the ledger both hosts
// share), not the process. A transient/autonomous wake is still dropped (it
// would only hit the same rejection: no retry storm), and a user message is
// now held in the inbox too, instead of a recovery turn into the same
// rejection; the credential's change (login), model output or a person's stop
// releases them. Stale error text alone (above) gates nothing any more.
test("reconciler 4a: on an invalid credential a transient/autonomous wake is dropped and a user message is held; nothing is stopped", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    driver.parsedLines.set("auth-error", [{ kind: "error", message: "Invalid API key · authentication failed" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("auth-error\n"));
    await flush();

    const encodedBefore = driver.encodedCalls.length;
    await manager.deliverMessage("agent-1", makeMessage("autonomous wake"), { transient: true });
    await manager.deliverMessage("agent-1", makeMessage("user message"));
    await flush();

    assert.equal(driver.encodedCalls.length, encodedBefore, "no turn into the same rejection");
    assert.equal(getProcess(manager, "agent-1"), ap, "the process is kept");
    assert.deepEqual(ap.inbox.map((message: AgentMessage) => message.content), ["user message"]);
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

test("startup-timeout cleanup keeps a retryable config: the next user delivery waits out the short local backoff, then restarts", async () => {
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
    // The timeout counts toward the spawn-fail backoff (first step: 1s), so
    // the delivery is buffered, never dropped, and starts the agent after it.
    const result = await manager.deliverMessage("agent-1", makeMessage("retry after timeout"));
    assert.equal(result, true);
    assert.equal(lastDeliveryOutcome(sink), "spawn_fail_cooldown_active");
    const deadline = Date.now() + 4_000;
    while (driver.processes.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(driver.processes.length, 2, "restarted once the backoff ended");
  }, { tracer });
}, 10_000);

// Reconciler step 10a (D5): a crash keeps the restart snapshot, so the agent
// keeps its idle residency and the fence keeps counting across the restart
// (a loop guard); it is cleared once no residency is left (an explicit stop).
test("runtime error fingerprint fence stays across a crash that keeps the snapshot, and is cleared with the residency", async () => {
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

    assert.ok((manager as any).lifecycleRecords.getRestartSnapshot("agent-1"), "D5: the snapshot stays");
    assert.ok(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1"),
      "the fence stays while the crashed agent keeps its idle residency",
    );
    await manager.stopAgent("agent-1");
    assert.equal(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1"),
      undefined,
      "a fingerprint fence must not remain after the agent has no idle or terminal residency",
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
  return traceRows(sink)
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

test("rejected_no_process reports a typed rejection once through onRejectedNoProcess; transient deliveries stay silent (task #1113)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    const rejections: Array<{ deliveryId?: string }> = [];
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), {
      deliveryId: "delivery-1",
      onRejectedNoProcess: () => { rejections.push({ deliveryId: "delivery-1" }); },
    });
    assert.equal(r, false);
    assert.equal(lastDeliveryOutcome(sink), "rejected_no_process");
    assert.equal(rejections.length, 1, "the Server must hear exactly one typed rejection so it can fall back to agent:start");

    const transient = await manager.deliverMessage("agent-1", makeMessage("y"), {
      transient: true,
      onRejectedNoProcess: () => { rejections.push({}); },
    });
    assert.equal(transient, true);
    assert.equal(rejections.length, 1, "a transient delivery is dropped, not converted into a wake");
  }, { tracer });
});

// Reconciler step 4a: the auth gate is the credential's invalid record (no
// longer the process's error history, nor B.5's clear-on-user-turn).
async function startWithInvalidCredential(manager: any, driver: any) {
  await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
  const ap = getProcess(manager, "agent-1");
  (manager as any).commitApmIdleState("agent-1", ap, true);
  driver.parsedLines.set("auth-error", [{ kind: "error", message: "Invalid API key · authentication failed" }]);
  driver.processes[0].stdout.emit("data", Buffer.from("auth-error\n"));
  await flush();
  return ap;
}

test("delivery-gating baseline: ap + invalid credential + transient → transient_dropped_credential_invalid (suppressed)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await startWithInvalidCredential(manager, driver);
    const r = await manager.deliverMessage("agent-1", makeMessage("x"), { transient: true });
    assert.equal(r, true);
    assert.equal(lastDeliveryOutcome(sink), "transient_dropped_credential_invalid");
  }, { tracer });
});

test("delivery-gating baseline: ap + invalid credential + user → queued_credential_invalid (held, no turn)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    const ap = await startWithInvalidCredential(manager, driver);
    const encodedBefore = driver.encodedCalls.length;
    await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.deepEqual(deliveryOutcomes(sink), ["queued_credential_invalid"]);
    assert.equal(driver.encodedCalls.length, encodedBefore);
    assert.deepEqual(ap.inbox.map((message: AgentMessage) => message.content), ["x"]);
  }, { tracer });
});

test("delivery-gating baseline: ap + model-not-supported sticky + user → rejected_no_process (handed to the server: inactive + error)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["model is not supported"];
    const r = await manager.deliverMessage("agent-1", makeMessage("x"));
    assert.equal(r, false);
    assert.equal(lastDeliveryOutcome(sink), "rejected_no_process");
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

test("[D1] an inbox read page drops its messages from the local queue by id and seq, and a re-push of them is dropped; an unprinted one stays", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, false);
    ap.sessionId = "s1";
    const queued = (seq: number) => makeMessage(`m-${seq}`, { seq, message_id: `m-${seq}`, channel_name: "general", channel_type: "channel" });
    ap.inbox.push(queued(41), queued(42), queued(43));

    // What the credential proxy hands over for an `inbox read` page that printed 41 and 42.
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [
        { seq: 41, id: "m-41", message_id: "m-41", channel_type: "channel", channel_name: "general" },
        { seq: 42, id: "m-42", message_id: "m-42", channel_type: "channel", channel_name: "general" },
      ],
      source: "agent_api_inbox_read",
    });
    assert.deepEqual(ap.inbox.map((m: any) => m.message_id), ["m-43"], "printed messages leave the queue; the unprinted one stays");
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general"), undefined, "exact ids and seqs only, no boundary");

    // A server re-push of a printed message is not queued again.
    await manager.deliverMessage("agent-1", queued(42));
    assert.deepEqual(ap.inbox.map((m: any) => m.message_id), ["m-43"]);
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
  return traceRows(sink)
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

// ===========================================================================
// Two server starts for one agent a few ms apart (prod 2026-09/10, AndyLok's
// stale_launch_guard census): the second arrives while the first spawn is being
// prepared, after the deferred rebind was taken. The server armed its launch
// guard for the second launch, so the running process must end up carrying it;
// otherwise every frame of the first launch is dropped as stale for hours.
// Teeth: drop the late-rebind block after spawn -> launchId stays L-1 -> RED.
// ===========================================================================
test("agent-start: a start that lands mid-spawn rebinds the running process to its newer launch", async () => {
  await withManager(async ({ manager, sent }) => {
    const realBuildSpawnConfig = (manager as any).buildSpawnConfig.bind(manager);
    let releaseSpawnConfig!: () => void;
    const spawnConfigGate = new Promise<void>((resolve) => { releaseSpawnConfig = resolve; });
    let spawnConfigEntered!: () => void;
    const enteredSpawnConfig = new Promise<void>((resolve) => { spawnConfigEntered = resolve; });
    (manager as any).buildSpawnConfig = async (agentId: string, config: AgentConfig) => {
      spawnConfigEntered();
      await spawnConfigGate;
      return realBuildSpawnConfig(agentId, config);
    };

    const first = manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }), undefined, undefined, undefined, "L-1");
    await enteredSpawnConfig;
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }), undefined, undefined, undefined, "L-2");
    releaseSpawnConfig();
    await first;

    assert.equal((manager as any).agents.get("agent-1")?.launchId, "L-2", "the running process carries the newer launch");
    const lastStatus = sent.filter((msg) => msg.type === "agent:status" && msg.agentId === "agent-1").at(-1);
    assert.equal((lastStatus as { launchId?: string } | undefined)?.launchId, "L-2", "the server is told the newer launch is the live one");
    assert.equal((manager as any).lifecycleRecords.getPendingStartRebind("agent-1"), undefined, "no rebind is left pending");
  });
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
    assert.ok(traceRows(sink).some((span) => span.name === "daemon.runtime.telemetry.rate_limits"));
    assert.deepEqual(sent.filter((message) => message.type === "machine:runtime_account_usage:snapshot"), []);
  }, { tracer });
});

test("a Claude quota reading reaches the manager's provider quota store, traces its change, and goes with the workspace", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const nowMs = 1_791_800_000_000;
  await withManager(async ({ driver, manager, dataDir }) => {
    (manager as unknown as { readWallClock: () => number }).readWallClock = () => nowMs;
    await manager.startAgent("agent-1", makeConfig());
    driver.parsedLines.set("quota-warning", [{
      kind: "telemetry",
      name: "rate_limits",
      source: "claude_rate_limit_event",
      attrs: { status: "allowed_warning", rateLimitType: "seven_day" },
      providerQuota: { status: "allowed_warning", utilization: 0.94, rateLimitType: "seven_day", resetsAtMs: nowMs + 86_400_000 },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("quota-warning\n"));
    await flush();
    assert.deepEqual(manager.providerQuota.quotaFor("agent-1"), { state: "near_exhausted", utilization: 0.94 });
    assert.equal(manager.providerQuota.reading("agent-1")?.observedAtMs, nowMs, "read on the manager's clock");
    const changed = traceRows(sink).filter((row) => row.name === "daemon.provider_quota.changed");
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.attrs?.state, "near_exhausted");
    assert.equal(changed[0]?.attrs?.previous_state, "none");
    assert.equal(changed[0]?.attrs?.rate_limit_type, "seven_day");

    await manager.stopAgent("agent-1");
    assert.deepEqual(manager.providerQuota.quotaFor("agent-1"), { state: "near_exhausted", utilization: 0.94 }, "account quota outlives the process");
    await mkdir(path.join(dataDir, "agent-1"), { recursive: true });
    assert.equal(await manager.deleteWorkspaceDirectory("agent-1"), true);
    assert.equal(manager.providerQuota.quotaFor("agent-1"), undefined, "forgotten with the agent's workspace");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// task #1114 — delivery consumption observation. A stdin write is not a
// consumption signal; only model-driven runtime events are. The daemon must
// make "N writes since the last runtime signal" visible as typed, queryable
// state (observation only: no stop, restart, retry or quota action).
// ─────────────────────────────────────────────────────────────────────────────

function consumptionObservations(sink: MemoryTraceSink) {
  return traceRows(sink).filter((span) => span.name === "daemon.agent.delivery.consumption");
}

async function idleDeliver(manager: AgentProcessManager, ap: any, n: number) {
  // The field shape: the daemon believes the agent is idle before each write.
  (manager as any).commitApmIdleState("agent-1", ap, true);
  ap.sessionId = "s1";
  await manager.deliverMessage("agent-1", makeMessage(`m${n}`, { message_id: `msg-${n}`, seq: n }));
}

test("task #1114 A: three idle stdin deliveries with no runtime event are observed as unconsumed, keyed to the launch", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    for (const n of [1, 2, 3]) {
      await idleDeliver(manager, ap, n);
      assert.equal(lastDeliveryOutcome(sink), "stdin_idle_delivery");
    }
    const observations = consumptionObservations(sink);
    assert.equal(observations.length, 3, "every stdin write must record a consumption observation");
    const last = observations.at(-1)!.attrs!;
    assert.equal(last.unconsumed_deliveries, 3);
    assert.equal(last.episode, 1);
    assert.equal(last.last_delivery_key, "msg-3");
    assert.equal(last.last_consumption_kind, null);
    assert.equal(last.process_alive, true);
    assert.equal(typeof last.launch_id, "string");
    assert.equal(last.threshold_crossed, true, "the third write in one episode crosses the observation-only threshold");
    assert.equal(observations[1]!.attrs!.threshold_crossed, false);
    // No credentials in the observation.
    assert.ok(!JSON.stringify(last).includes("sk_"), "observation must not carry credentials");
  }, { tracer });
});

test("task #1114 B: three app-inbox idle notices with no runtime event are observed as unconsumed", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    ap.sessionId = "s1";
    for (const revision of ["1", "2", "3"]) {
      (manager as any).commitApmIdleState("agent-1", ap, true);
      const minted = store.mint({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision },
      });
      assert.equal(minted.ok, true);
      if (!minted.ok) return;
      assert.equal(await manager.notifyAgentAppInbox("agent-1", minted.item), true);
    }
    const observations = consumptionObservations(sink);
    assert.equal(observations.length, 3);
    assert.equal(observations.at(-1)!.attrs!.unconsumed_deliveries, 3);
    assert.equal(observations.at(-1)!.attrs!.delivery_write_kind, "app_inbox_notice");
  }, { tracer, appInboxForAgent: () => store });
});

test("task #1114 C: a model-driven runtime event resets the counter and records the consumption kind", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    await idleDeliver(manager, ap, 2);
    driver.parsedLines.set("assistant-text", [{ kind: "text", text: "on it" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("assistant-text\n"));
    await flush();
    await idleDeliver(manager, ap, 3);
    const last = consumptionObservations(sink).at(-1)!.attrs!;
    assert.equal(last.unconsumed_deliveries, 1, "the text event consumed the first two writes; the third starts a new episode");
    assert.equal(last.episode, 2);
    assert.equal(last.last_consumption_kind, "text");
  }, { tracer });
});

test("task #1114 D: a runtime error event is a turn result and resets the counter; a daemon-side write failure is not", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    driver.parsedLines.set("runtime-error", [{ kind: "error", message: "usage limit reached" } as ParsedEvent]);
    driver.processes[0].stdout.emit("data", Buffer.from("runtime-error\n"));
    await flush();
    // A runtime error is a turn result: the pending write was consumed (and failed).
    // Read the queryable state directly; after a runtime error the delivery path
    // itself is gated, so no new observation is expected here.
    const afterError = manager.getDeliveryConsumptionSnapshot("agent-1");
    assert.ok(afterError, "the process is still live after a non-auth runtime error");
    assert.equal(afterError.unconsumedDeliveries, 0);
    assert.equal(afterError.lastRuntimeResult?.kind, "error");
    assert.equal(typeof (afterError.lastRuntimeResult as { errorClass?: unknown }).errorClass, "string");
    assert.ok(!JSON.stringify(afterError).includes("usage limit reached"), "runtime error text must not be copied into the observation");
    assert.equal(afterError.lastDeliveryError, null, "a runtime error is not a daemon-side delivery error");
  }, { tracer });
});

test("task #1114 F: a process restart clears the counter and starts the episode numbering over", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    let ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    await idleDeliver(manager, ap, 2);
    await manager.stopAgent("agent-1");
    await flush();
    assert.equal(manager.getDeliveryConsumptionSnapshot("agent-1"), null, "a stopped process has no consumption state");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s2" }));
    ap = getProcess(manager, "agent-1");
    ap.sessionId = "s2";
    await idleDeliver(manager, ap, 3);
    // Only writes to the NEW process count; the old process's two writes are gone
    // with it. (The spawn path itself may write once, so compare per launch.)
    const newLaunch = consumptionObservations(sink).filter((span) => span.attrs?.launch_id === (ap.launchId || ""));
    assert.ok(newLaunch.length >= 1);
    assert.equal(newLaunch[0]!.attrs!.episode, 1, "episode numbering restarts with the new process");
    assert.equal(newLaunch[0]!.attrs!.unconsumed_deliveries, 1, "the first write to the new process is its first unconsumed delivery");
    assert.equal(newLaunch.at(-1)!.attrs!.episode, 1);
  }, { tracer });
});

test("task #1114 G: a turn_end for the live session is consumption; a turn_end naming a stale session on the same process is not", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    await idleDeliver(manager, ap, 2);
    // Live session: real consumption.
    driver.parsedLines.set("live-turn-end", [{ kind: "turn_end", sessionId: "s1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("live-turn-end\n"));
    await flush();
    const afterLive = manager.getDeliveryConsumptionSnapshot("agent-1");
    assert.equal(afterLive?.unconsumedDeliveries, 0, "the live session's turn_end consumes the pending writes");
    assert.equal(afterLive?.lastConsumption?.kind, "turn_end");
    assert.equal(afterLive?.lastRuntimeResult?.kind, "completed");

    // Huaihuai's mutation: same bound process, live session s1, event claims another session.
    await idleDeliver(manager, ap, 3);
    await idleDeliver(manager, ap, 4);
    const before = manager.getDeliveryConsumptionSnapshot("agent-1")!.unconsumedDeliveries;
    assert.equal(before, 2);
    driver.parsedLines.set("stale-turn-end", [{ kind: "turn_end", sessionId: "stale-session" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("stale-turn-end\n"));
    await flush();
    const afterStale = manager.getDeliveryConsumptionSnapshot("agent-1");
    // The turn_end still drives the ordinary turn-end redelivery (possibly one
    // more write), so the counter may grow; what it must never do is reset.
    assert.ok((afterStale?.unconsumedDeliveries ?? 0) >= 2, "a stale-session turn_end must not clear the counter");
    assert.equal(afterStale?.lastConsumption?.kind, "turn_end", "no new consumption was recorded by the stale event");
    assert.equal(afterStale?.lastConsumption?.atMs, afterLive?.lastConsumption?.atMs, "the last consumption is still the live one");
    const ignored = traceRows(sink).filter((span) => span.name === "daemon.agent.delivery.consumption.ignored");
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0]!.attrs!.reason, "session_mismatch");
    assert.equal(ignored[0]!.attrs!.event_kind, "turn_end");
  }, { tracer });
});

test("task #1114 H: a session-less consumption event only counts while a turn is live on the process", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    // Force the daemon's view back to idle with the write still unconsumed: a
    // bare text event with no live turn cannot be attributed to that write.
    (manager as any).commitApmIdleState("agent-1", ap, true);
    driver.parsedLines.set("orphan-text", [{ kind: "text", text: "late" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("orphan-text\n"));
    await flush();
    assert.equal(manager.getDeliveryConsumptionSnapshot("agent-1")?.unconsumedDeliveries, 1);
    const ignored = traceRows(sink).filter((span) => span.name === "daemon.agent.delivery.consumption.ignored");
    assert.equal(ignored.at(-1)?.attrs?.reason, "no_live_turn");
  }, { tracer });
});

test("task #1114 H2: a named foreign-session event fails closed when the live session is unknown", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    // Huaihuai's H2 mutation: pending write, process busy, live session unknown,
    // event names some other session.
    ap.sessionId = null;
    (manager as any).commitApmIdleState("agent-1", ap, false);
    // Drive the handler directly: this pins the association predicate itself,
    // independent of whether the binding fence would also drop the event.
    (manager as any).handleParsedEvent("agent-1", { kind: "turn_end", sessionId: "foreign-session" }, driver);
    await flush();
    const trail = traceRows(sink)
      .filter((span) => span.name.startsWith("daemon.agent.delivery.consumption"))
      .map((span) => [span.name, span.attrs?.event_kind, span.attrs?.reason, span.attrs?.unconsumed_deliveries]);
    // The turn_end handler still redelivers the pending inbox (a new write), so
    // the counter may grow; what it must never do is reset.
    const after = manager.getDeliveryConsumptionSnapshot("agent-1");
    assert.ok((after?.unconsumedDeliveries ?? 0) >= 1, `an unknown live session must not accept a named foreign event; trail=${JSON.stringify(trail)}`);
    assert.equal(after?.lastConsumption, null, "nothing was consumed");
    const ignored = traceRows(sink).filter((span) => span.name === "daemon.agent.delivery.consumption.ignored");
    assert.equal(ignored.at(-1)?.attrs?.reason, "session_mismatch");
    assert.equal(ignored.at(-1)?.attrs?.session_id_present, false);
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// task #1116 — web-visible projection of the #1114 observation. When one
// episode reaches the observation threshold, the daemon must emit ONE
// agent:activity carrying detailKind "delivery_unconsumed" and the typed
// deliveryConsumption carrier (ids / classes / times only). Observation only.
// ─────────────────────────────────────────────────────────────────────────────

function deliveryUnconsumedActivities(sent: MachineToServerMessage[]) {
  return sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
    msg.type === "agent:activity" && msg.detailKind === "delivery_unconsumed");
}

test("task #1116 daemon: the third unconsumed write in an episode emits one delivery_unconsumed activity with the typed carrier", async () => {
  const { tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    await idleDeliver(manager, ap, 1);
    await idleDeliver(manager, ap, 2);
    assert.equal(deliveryUnconsumedActivities(sent).length, 0, "below the threshold nothing is projected");
    await idleDeliver(manager, ap, 3);
    const projected = deliveryUnconsumedActivities(sent);
    assert.equal(projected.length, 1, "the threshold write projects exactly once");
    const carrier = (projected[0] as { deliveryConsumption?: Record<string, unknown> }).deliveryConsumption;
    assert.ok(carrier, "the activity must carry the typed deliveryConsumption diagnostic");
    assert.equal(carrier.unconsumedDeliveries, 3);
    assert.equal(carrier.episode, 1);
    assert.equal(carrier.lastDeliveryKey, "msg-3");
    assert.equal(carrier.lastDeliveryPath, "stdin_idle_delivery");
    assert.equal(carrier.processAlive, true);
    assert.equal(typeof carrier.launchId, "string");
    assert.equal(typeof carrier.firstUnconsumedAtMs, "number");
    assert.equal(carrier.lastConsumptionKind, null);
    const serialized = JSON.stringify(projected[0]);
    assert.ok(!serialized.includes("sk_"), "no credentials in the projection");
    assert.ok(!serialized.includes("m3"), "no message content in the projection");

    // A fourth write in the same episode does not project again.
    await idleDeliver(manager, ap, 4);
    assert.equal(deliveryUnconsumedActivities(sent).length, 1);
  }, { tracer });
});

test("#triage:eedc43fe: writes during a running turn or while a background task runs are normal queueing, not delivery_unconsumed", async () => {
  const { tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    ap.sessionId = "s1";

    // A turn is running: busy notifications.
    for (const n of [1, 2, 3]) (manager as any).observeDeliveryWrite("agent-1", ap, `m-${n}`, "busy_stdin_notification", true);
    assert.equal(ap.deliveryConsumption.snapshot().unconsumedDeliveries, 3, "the writes are still counted");
    assert.equal(deliveryUnconsumedActivities(sent).length, 0, "a running turn explains them");

    // The turn is over but the agent waits on its own background task.
    ap.backgroundTasks.set("task-bg", { startedAtMs: Date.now() });
    for (const n of [4, 5, 6]) await idleDeliver(manager, ap, n);
    assert.equal(deliveryUnconsumedActivities(sent).length, 0, "a background task explains them");

    // Nothing explains these: the real signal still fires, on its own count.
    ap.backgroundTasks.delete("task-bg");
    await idleDeliver(manager, ap, 7);
    await idleDeliver(manager, ap, 8);
    assert.equal(deliveryUnconsumedActivities(sent).length, 0, "explained writes did not count toward the threshold");
    await idleDeliver(manager, ap, 9);
    assert.equal(deliveryUnconsumedActivities(sent).length, 1);
  }, { tracer });
});

test("task #1116 daemon: after a consumption signal a new episode may project again, numbered as episode 2", async () => {
  const { tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    for (const n of [1, 2, 3]) await idleDeliver(manager, ap, n);
    driver.parsedLines.set("assistant-text", [{ kind: "text", text: "on it" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("assistant-text\n"));
    await flush();
    for (const n of [4, 5, 6]) await idleDeliver(manager, ap, n);
    const projected = deliveryUnconsumedActivities(sent);
    assert.equal(projected.length, 2);
    const second = (projected[1] as { deliveryConsumption?: Record<string, unknown> }).deliveryConsumption;
    assert.equal(second?.episode, 2);
    assert.equal(second?.lastConsumptionKind, "text");
  }, { tracer });
});

// task #1119 — the server's wake crash-loop breaker records how a process
// ended; the daemon must attach code/signal to the inactive status it reports
// for a non-recoverable crash.
test("task #1119 daemon: a crash-marked inactive status carries the exit code and signal", async () => {
  await withManager(async ({ manager, sent, driver }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).startRuntimeTrace("agent-1", ap, "e2e-turn", []);
    ap.lastRuntimeError = "ProviderModelNotFoundError: failed with model 'claude-4' (500)";
    ap.recentStderr = ["ProviderModelNotFoundError: failed with model 'claude-4' (500)"];

    driver.processes[0].emit("exit", null, "SIGTERM");
    driver.processes[0].emit("close", null, "SIGTERM");
    await flush();

    const inactive = sent.filter((m) =>
      m.type === "agent:status" && (m as { status?: string }).status === "inactive",
    ) as Array<Extract<MachineToServerMessage, { type: "agent:status" }>>;
    assert.ok(inactive.length >= 1, "a non-recoverable crash reports inactive");
    assert.deepEqual(inactive.at(-1)!.exit, { code: null, signal: "SIGTERM" }, "the inactive frame carries how the process ended");
  });
});

// ===========================================================================
// pi session rotation (plan §1): APM offers a due rotation at every turn end,
// and the hold the runtime reads right before rotating is the one idle
// definition (agentIdle.ts): a busy turn, a background task still running, a
// delivery not yet told to the session or not yet read from stdin, a tracked
// mention occurrence not yet settled. The runtime side (a hold means no
// rotation) is drivers/piSessionRotation.test.ts.
// ===========================================================================

test("session rotation: offered at every turn end, held until the agent is idle (turn, background tasks, deliveries, tracked mentions)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-rotation");
    const ap = getProcess(manager, "agent-1");
    ap.sessionReadyForDelivery = true;
    const offers: Array<() => string | null> = [];
    ap.runtime.rotateSessionIfDue = (hold: () => string | null) => { offers.push(hold); };
    const turnEnd = async (line: string) => {
      driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    await turnEnd("turn-end-1");
    assert.equal(offers.length, 1, "offered at the turn end");
    const hold = offers[0]!;
    assert.equal(hold(), null, "idle with nothing in flight");

    (manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal(hold(), "agent_busy");
    (manager as any).commitApmIdleState("agent-1", ap, true);

    // task #1260: the turn ended, but a background task it started still runs.
    ap.backgroundTasks.set("task-bg", { startedAtMs: Date.now() });
    assert.equal(hold(), "background_tasks");
    ap.backgroundTasks.delete("task-bg");
    assert.equal(hold(), null);

    // Written to stdin near the turn end, not yet read by any turn.
    ap.deliveryConsumption.recordWrite("late", "stdin_turn_end_delivery", Date.now());
    assert.equal(hold(), "delivery_in_flight");
    ap.deliveryConsumption.recordConsumption("turn_end", Date.now());
    assert.equal(hold(), null);

    const untold = makeMessage("not told to the session yet", { message_id: "m-untold", seq: 501 });
    ap.inbox.push(untold);
    assert.equal(hold(), "delivery_in_flight");
    ap.inbox.splice(ap.inbox.indexOf(untold), 1);
    assert.equal(hold(), null);

    // A tracked mention lands during a turn and is told to the session; until
    // the turn end settles the occurrence, it is in flight.
    (manager as any).commitApmIdleState("agent-1", ap, false);
    const mention = makeMessage("tracked mention", { message_id: "m-rotation", seq: 502 });
    let acks = 0;
    assert.equal(await manager.deliverMessage("agent-1", mention, {
      deliveryId: "occ-rotation",
      mentionDelivery: { occurrenceId: "occ-rotation", messageId: "m-rotation", launchId: ap.launchId, sessionId: ap.sessionId },
      onMentionAck: () => { acks += 1; },
    } as any), true);
    ap.notifications.recordNoticeWritten(computeInboxNoticeFingerprint([mention]), "session-1", [mention]);
    ap.notifications.clearPending();
    (manager as any).commitApmIdleState("agent-1", ap, true);
    assert.equal(hold(), "mention_in_flight");

    await turnEnd("turn-end-2");
    assert.equal(acks, 1, "the turn end settled the occurrence");
    assert.equal(offers.length, 2);
    assert.equal(offers[1]!(), null, "nothing in flight once it is settled");
  });
});

test("session rotation: held at a turn end whose turn had input written into it, until the turn the runtime runs on it ends", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-rotation-queued");
    const ap = getProcess(manager, "agent-1");
    ap.sessionReadyForDelivery = true;
    const offers: Array<() => string | null> = [];
    ap.runtime.rotateSessionIfDue = (hold: () => string | null) => { offers.push(hold); };
    const emit = async (line: string, events: ParsedEvent[]) => {
      driver.parsedLines.set(line, events);
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    // A busy write into the running turn (a busy inbox notice), "consumed" by that turn's own events.
    (manager as any).observeDeliveryWrite("agent-1", ap, "m-busy", "busy_stdin_notification", true);
    await emit("text-1", [{ kind: "text", text: "still in the first turn", sessionId: "session-1" } as ParsedEvent]);
    assert.equal(ap.deliveryConsumption.snapshot().unconsumedDeliveries, 0);
    await emit("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!(), "delivery_in_flight", "the runtime may run it as its next turn");

    // It does: a turn of its own, held until it ends.
    await emit("text-2", [{ kind: "text", text: "the queued turn", sessionId: "session-1" } as ParsedEvent]);
    assert.notEqual(offers[0]!(), null, "held while that turn runs");
    await emit("turn-end-2", [{ kind: "turn_end", sessionId: "session-1" }]);
    assert.equal(offers.length, 2);
    assert.equal(offers[1]!(), null, "a turn with nothing written into it: idle at its end");
  });
});

// ===========================================================================
// task #285 — a busy tracked mention whose content-free notice already
// contributed during the turn must still reach a terminal state at turn_end.
// Field shape (daemon 1.0.26): outcome=mention-accepted-awaiting-terminal-ack,
// then the server re-sent the same occurrence every 5s for 15h+. At turn_end
// the gated flush is suppressed as already-contributed, which returns false,
// so completePendingTrackedMentions never runs and the occurrence stays pending;
// every redelivery then hits duplicate_pending and returns true with no ack.
// ===========================================================================

test("task #285: a busy tracked mention whose notice already contributed is ACKed at turn_end, and a redelivery does not go silent", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-285");
    const ap = getProcess(manager, "agent-1");
    assert.ok(ap.launchId, "precondition: tracking is identity-bound, so the live launch must carry a launchId");
    assert.equal(ap.sessionId, "session-1");
    ap.sessionReadyForDelivery = true;
    (manager as any).commitApmIdleState("agent-1", ap, false);

    const occurrenceId = "occ-285";
    const message = makeMessage("tracked mention during a busy turn", { message_id: "m-285", seq: 285 });
    const transitions: { state: string; outcome: string }[] = [];
    const terminalErrors: string[] = [];
    let ackCount = 0;
    const context = () => ({
      deliveryId: occurrenceId,
      mentionDelivery: {
        occurrenceId,
        messageId: "m-285",
        launchId: ap.launchId,
        sessionId: ap.sessionId,
      },
      onMentionTransition: (state: string, outcome: string) => { transitions.push({ state, outcome }); },
      onMentionAck: () => { ackCount += 1; },
      onMentionTerminalError: (code: string) => { terminalErrors.push(code); },
    }) as any;

    assert.equal(await manager.deliverMessage("agent-1", message, context()), true);
    assert.deepEqual(
      transitions.map((t) => t.state),
      ["daemon_received", "daemon_pending"],
      "precondition: the mention took the busy tracked path and is pending",
    );

    // The runtime already received the content-free notice for this row during the turn.
    ap.notifications.recordNoticeWritten(computeInboxNoticeFingerprint([message]), "session-1", [message]);

    driver.parsedLines.set("turn-end-285", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-285\n"));
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(terminalErrors, [], "an already-notified mention is not a delivery failure");
    assert.equal(ackCount, 1, "the pending occurrence must be ACKed once at turn_end, not left pending forever");

    // A server redelivery of the same occurrence must be answered, never swallowed.
    assert.equal(await manager.deliverMessage("agent-1", message, context()), true);
    assert.equal(ackCount + terminalErrors.length, 2, "a redelivery must produce an ACK or a terminal error, not silence");
  });
});

test("a tracked mention to a busy fresh Claude session that is not yet resumable waits in the inbox and is ACKed when written, never refused", async () => {
  // Bencher's repro under CPU load: the mention arrived after session_init
  // but before the first turn_end (a fresh Claude session is resumable only
  // then). It was refused as UNSUPPORTED_DELIVERY_PATH and nothing redelivered it.
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-fresh" }), undefined, undefined, undefined, "launch-fresh");
    const ap = getProcess(manager, "agent-1");
    ap.sessionReadyForDelivery = false;
    (manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal((manager as any).canDeliverToRuntimeSession(ap), false, "precondition: session known, not yet resumable");

    const message = makeMessage("tracked mention before the first turn end", { message_id: "m-fresh", seq: 7 });
    const transitions: string[] = [];
    const terminalErrors: string[] = [];
    let ackCount = 0;
    const accepted = await manager.deliverMessage("agent-1", message, {
      deliveryId: "occ-fresh",
      mentionDelivery: { occurrenceId: "occ-fresh", messageId: "m-fresh", launchId: ap.launchId, sessionId: ap.sessionId },
      onMentionTransition: (state: string) => { transitions.push(state); },
      onMentionAck: () => { ackCount += 1; },
      onMentionTerminalError: (code: string) => { terminalErrors.push(code); },
    } as any);

    assert.equal(accepted, true);
    assert.deepEqual(transitions, ["daemon_received", "daemon_pending"]);
    assert.deepEqual(terminalErrors, []);
    assert.ok(ap.inbox.some((queued: { message_id?: string }) => queued.message_id === "m-fresh"), "held in the inbox");
    assert.equal(ap.sessionReadyDeliveryRetry.kind, "scheduled", "the session-ready retry will write it");

    const before = driver.processes[0].stdinWrites.length;
    driver.parsedLines.set("turn-end-fresh", [{ kind: "turn_end", sessionId: "session-fresh" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-fresh\n"));
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(terminalErrors, []);
    assert.equal(ackCount, 1, "written at the turn end and ACKed once");
    assert.ok(driver.processes[0].stdinWrites.length > before, "the turn end wrote it to the runtime");
    assert.match(driver.processes[0].stdinWrites.slice(before).join(""), /m-fresh|before the first turn end|inbox/);
  });
});

test("task #285: at turn_end a consumed tracked mention is ACKed, while a purged one and one never told to the runtime end with a terminal error that is reported once", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-285b");
    const ap = getProcess(manager, "agent-1");
    ap.sessionReadyForDelivery = true;
    (manager as any).commitApmIdleState("agent-1", ap, false);

    const outcomes = new Map<string, { acks: number; errors: string[]; states: string[] }>();
    const deliver = (occurrenceId: string, messageId: string, seq: number) => {
      const record = { acks: 0, errors: [] as string[], states: [] as string[] };
      outcomes.set(occurrenceId, record);
      return manager.deliverMessage("agent-1", makeMessage(`tracked ${messageId}`, { message_id: messageId, seq }), {
        deliveryId: occurrenceId,
        mentionDelivery: { occurrenceId, messageId, launchId: ap.launchId, sessionId: ap.sessionId },
        onMentionTransition: (state: string) => { record.states.push(state); },
        onMentionAck: () => { record.acks += 1; },
        onMentionTerminalError: (code: string) => { record.errors.push(code); },
      } as any);
    };

    assert.equal(await deliver("occ-consumed", "m-consumed", 301), true);
    assert.equal(await deliver("occ-untold", "m-untold", 302), true);
    const purgedMessage = makeMessage("tracked m-purged", { message_id: "m-purged", seq: 303, channel_id: "channel-purged", channel_name: "purged" });
    const purgedRecord = { acks: 0, errors: [] as string[], states: [] as string[] };
    outcomes.set("occ-purged", purgedRecord);
    assert.equal(await manager.deliverMessage("agent-1", purgedMessage, {
      deliveryId: "occ-purged",
      mentionDelivery: { occurrenceId: "occ-purged", messageId: "m-purged", launchId: ap.launchId, sessionId: ap.sessionId },
      onMentionTransition: (state: string) => { purgedRecord.states.push(state); },
      onMentionAck: () => { purgedRecord.acks += 1; },
      onMentionTerminalError: (code: string) => { purgedRecord.errors.push(code); },
    } as any), true);
    for (const id of ["occ-consumed", "occ-untold", "occ-purged"]) {
      assert.deepEqual(outcomes.get(id)!.states, ["daemon_received", "daemon_pending"], `precondition: ${id} took the busy tracked path`);
    }

    // The agent read m-consumed during the turn: the check/read path records it model-seen and drops it from the inbox.
    const consumedMessage = ap.inbox.find((message: any) => message.message_id === "m-consumed");
    (manager as any).consumeVisibleMessages("agent-1", { messages: [consumedMessage], source: "agent_api_events_local" });
    assert.equal(ap.inbox.some((message: any) => message.message_id === "m-consumed"), false, "precondition: consumed rows leave the inbox");
    // The server purged m-purged's channel (e.g. membership removed): gone from the inbox, never seen.
    assert.equal(manager.purgeInboxMessagesForChannels("agent-1", ["channel-purged"], "channel_membership_removed").removedCount, 1);
    // Make the boundary flush fail, so nothing tells the runtime about the rest.
    (manager as any).executeApmGatedSteeringEffect = () => false;

    const turnEnd = async (line: string) => {
      driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: "session-1" }]);
      (manager as any).commitApmIdleState("agent-1", ap, false);
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      await waitFor(() => (manager as any).isApmIdle(ap), `${line} settles to idle`);
    };
    await turnEnd("turn-end-285b");

    assert.deepEqual(outcomes.get("occ-consumed"), { acks: 1, errors: [], states: ["daemon_received", "daemon_pending", "daemon_drained"] });
    assert.equal(outcomes.get("occ-untold")!.acks, 0, "an occurrence never told to the runtime must not be ACKed");
    assert.deepEqual(outcomes.get("occ-untold")!.errors, ["DELIVERY_REJECTED"], "it must end with a terminal error instead of staying pending");
    assert.equal(purgedRecord.acks, 0, "a purged row was never seen by the runtime, so it must not be ACKed");
    assert.deepEqual(purgedRecord.errors, ["DELIVERY_REJECTED"]);

    // A later turn end must not report the same terminal occurrences again.
    await turnEnd("turn-end-285c");
    assert.deepEqual(outcomes.get("occ-untold")!.errors, ["DELIVERY_REJECTED"], "reported once");
    assert.deepEqual(purgedRecord.errors, ["DELIVERY_REJECTED"], "reported once");
    assert.equal(outcomes.get("occ-consumed")!.acks, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stalled-recovery must not measure idle time as stall time.
//
// Field incident (2026-09-22 05:55Z, 2026-09-25 11:57Z, same agent): after a
// long idle gap, two deliveries arrived in the same second. The first went out
// as an idle stdin notice and flipped the agent busy; the second queued and ran
// the stalled-recovery check, whose clock still measured the idle gap (174m,
// 114m). The process that had just been handed the notice was SIGTERMed, and
// on resume the Claude CLI closed the unanswered notice with a `<synthetic>`
// "No response requested." The model never saw that turn.
// ─────────────────────────────────────────────────────────────────────────────

const STALL_THRESHOLD_MS = 15 * 60_000;

async function settleIdleWithProgressAge(driver: FakeClaudeDriver, manager: any, progressAgeMs: number) {
  await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
  const ap = getProcess(manager, "agent-1");
  driver.parsedLines.set("turn-end-before-idle", [{ kind: "turn_end", sessionId: "session-1" }]);
  driver.processes[0].stdout.emit("data", Buffer.from("turn-end-before-idle\n"));
  await waitFor(() => manager.isApmIdle(ap), "agent settles to idle");
  // The last runtime event was the previous turn's end, `progressAgeMs` ago.
  ap.runtimeProgress.noteRuntimeEvent("turn_end", Date.now() - progressAgeMs);
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = driver.processes[0];
  const originalKill = proc.kill.bind(proc);
  proc.kill = (signal?: NodeJS.Signals | number) => {
    killSignals.push(signal);
    return originalKill(signal);
  };
  return { ap, killSignals };
}

function withNowOffset<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  return fn().finally(() => {
    Date.now = realNow;
  });
}

test("stalled recovery: idle over threshold, then two deliveries in the same second, does not terminate the runtime", async () => {
  await withManager(async ({ driver, manager }) => {
    const { ap, killSignals } = await settleIdleWithProgressAge(driver, manager, 114 * 60_000);

    await manager.deliverMessage("agent-1", makeMessage("first after idle", { message_id: "m-idle-1", seq: 900 }));
    assert.equal(driver.encodedCalls.length, 1, "precondition: first message goes out as an idle stdin notice");
    assert.equal(driver.encodedCalls[0].mode, "idle");

    await manager.deliverMessage("agent-1", makeMessage("second, same second", { message_id: "m-idle-2", seq: 901 }));

    assert.notEqual(ap.gatedSteering.expectedTerminationReason, "stalled_recovery", "idle time is not stall time");
    assert.deepEqual(killSignals, [], "the runtime that was just handed a notice must not be killed");
  });
});

test("stalled recovery control: idle under threshold, then two deliveries in the same second, does not terminate", async () => {
  await withManager(async ({ driver, manager }) => {
    const { ap, killSignals } = await settleIdleWithProgressAge(driver, manager, STALL_THRESHOLD_MS - 60_000);

    await manager.deliverMessage("agent-1", makeMessage("first", { message_id: "m-short-1", seq: 910 }));
    await manager.deliverMessage("agent-1", makeMessage("second", { message_id: "m-short-2", seq: 911 }));

    assert.notEqual(ap.gatedSteering.expectedTerminationReason, "stalled_recovery");
    assert.deepEqual(killSignals, []);
  });
});

test("stalled recovery control: idle over threshold, one delivery only, does not terminate", async () => {
  await withManager(async ({ driver, manager }) => {
    const { ap, killSignals } = await settleIdleWithProgressAge(driver, manager, 114 * 60_000);

    await manager.deliverMessage("agent-1", makeMessage("only one", { message_id: "m-one", seq: 920 }));

    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.notEqual(ap.gatedSteering.expectedTerminationReason, "stalled_recovery");
    assert.deepEqual(killSignals, []);
  });
});

test("stalled recovery guard: a runtime that stays silent past the threshold after an idle delivery is still terminated", async () => {
  // A restart strips the runner credential and mints a new one; answer the
  // mint here so the restart under test does not reach the network.
  onTestFinished(installManagedRunnerCredentialFetch());
  await withManager(async ({ driver, manager }) => {
    const { ap, killSignals } = await settleIdleWithProgressAge(driver, manager, 114 * 60_000);

    await manager.deliverMessage("agent-1", makeMessage("first after idle", { message_id: "m-hang-1", seq: 930 }));
    assert.equal(driver.encodedCalls[0]?.mode, "idle");

    // No runtime event arrives; the next message comes after the threshold,
    // measured from the idle delivery itself.
    await withNowOffset(STALL_THRESHOLD_MS + 60_000, async () => {
      await manager.deliverMessage("agent-1", makeMessage("still no answer", { message_id: "m-hang-2", seq: 931 }));
    });

    assert.equal(ap.gatedSteering.expectedTerminationReason, "stalled_recovery", "a real hang must still be recovered");
    assert.deepEqual(killSignals, ["SIGTERM"]);
  });
});

test("stalled recovery: idle over threshold, transient idle wake then a queued delivery, does not terminate the runtime", async () => {
  await withManager(async ({ driver, manager }) => {
    const { ap, killSignals } = await settleIdleWithProgressAge(driver, manager, 114 * 60_000);

    await manager.deliverMessage("agent-1", makeMessage("autonomous wake", { message_id: "m-wake", seq: 940 }), { transient: true });
    assert.equal(driver.encodedCalls[0]?.mode, "idle", "precondition: the transient wake is written through the idle stdin path");

    await manager.deliverMessage("agent-1", makeMessage("queued behind the wake", { message_id: "m-after-wake", seq: 941 }));

    assert.notEqual(ap.gatedSteering.expectedTerminationReason, "stalled_recovery");
    assert.deepEqual(killSignals, []);
  });
});

test("process exit telemetry: last_event_age_ms_bucket measures the last runtime event, not the turn-start anchor", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await settleIdleWithProgressAge(driver, manager, 114 * 60_000);

    // The idle write anchors a new turn start; the stall age is now ~0.
    await manager.deliverMessage("agent-1", makeMessage("first after idle", { message_id: "m-exit-1", seq: 950 }));
    assert.equal(driver.encodedCalls[0]?.mode, "idle");

    driver.processes[0].kill();
    await waitFor(
      () => traceRows(sink).some((span) => span.name === "daemon.runtime.process.exit"),
      "process exit event recorded",
    );

    const exit = traceRows(sink).find((span) => span.name === "daemon.runtime.process.exit");
    assert.equal(exit?.attrs?.last_event_age_ms_bucket, ">60m", "the 2026-06-22 contract column keeps its literal meaning");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #353: a queued delivery the runtime never consumed is either carried
// into the next start or recorded as dropped with its exit path. Before this,
// the close handler and stopAgent deleted the process with its inbox and left
// no trace, so a lost wake was invisible on every log surface.
// ─────────────────────────────────────────────────────────────────────────────

async function busyAgentWithTwoQueued(driver: FakeClaudeDriver, manager: any, configOverrides: Partial<AgentConfig> = {}) {
  await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1", ...configOverrides }));
  const ap = getProcess(manager, "agent-1");
  manager.commitApmIdleState("agent-1", ap, false);
  await manager.deliverMessage("agent-1", makeMessage("queued one", { message_id: "m-q-1", seq: 960 }));
  await manager.deliverMessage("agent-1", makeMessage("queued two", { message_id: "m-q-2", seq: 961 }));
  assert.equal(ap.inbox.length, 2, "precondition: two unconsumed deliveries queued while busy");
  return ap;
}

function droppedOnExit(sink: MemoryTraceSink) {
  return traceRows(sink).filter((span) => span.name === "daemon.agent.inbox.dropped_on_exit");
}

test("task #353: a non-recoverable crash records the unconsumed inbox as dropped with its exit path", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await busyAgentWithTwoQueued(driver, manager);

    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await waitFor(() => droppedOnExit(sink).length > 0, "dropped_on_exit recorded");

    const [event] = droppedOnExit(sink);
    assert.equal(event.attrs?.exit_reason, "nonrecoverable_crash");
    assert.equal(event.attrs?.dropped_count, 2);
    assert.equal(event.attrs?.expected, false, "the agent is marked inactive, so nothing re-drives the wake");
  }, { tracer });
});

test("task #353: stopAgent records the unconsumed inbox as dropped", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await busyAgentWithTwoQueued(driver, manager);

    await manager.stopAgent("agent-1", { silent: true });

    const [event] = droppedOnExit(sink);
    assert.equal(event?.attrs?.exit_reason, "silent_stop");
    assert.equal(event?.attrs?.dropped_count, 2);
    assert.equal(event?.attrs?.expected, true, "stop relies on the server's unread catch-up by design");
  }, { tracer });
});

test("task #353 control: a clean exit carries the queued inbox into the restart and records nothing dropped", async () => {
  // A restart strips the runner credential and mints a new one; answer the
  // mint here so the restart under test does not reach the network.
  onTestFinished(installManagedRunnerCredentialFetch());
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await busyAgentWithTwoQueued(driver, manager);
    driver.parsedLines.set("turn-end-before-exit", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-before-exit\n"));
    await flush();

    driver.processes[0].kill();
    // One queued message becomes the restart's wake; the other is buffered for the new start.
    await waitFor(() => (manager as any).startingInboxes.count("agent-1") === 1, "second message buffered for the restart");

    assert.deepEqual(droppedOnExit(sink), [], "carried, so nothing is recorded as dropped");
  }, { tracer });
});

test("task #353: a cold start after a missing resume session carries the queued inbox into the new start", async () => {
  // The cold start strips the runner credential and mints a new one. The
  // assertions below read the buffer while that mint is still outstanding, so
  // it is left pending here (as a slow server would) instead of reaching the
  // network.
  onTestFinished(installManagedRunnerCredentialFetch({ mint: "outstanding" }));
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager, sent }) => {
    await busyAgentWithTwoQueued(driver, manager);

    driver.parsedLines.set("missing-session-error", [{
      kind: "error",
      message: "No conversation found with session ID: session-1",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("missing-session-error\n"));
    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);

    await waitFor(
      () => sent.some((msg) => msg.type === "agent:session:invalidate"),
      "cold start after missing session",
    );
    await flush();
    assert.equal((manager as any).startingInboxes.count("agent-1"), 2, "both queued deliveries are buffered for the new start");
    assert.deepEqual(droppedOnExit(sink), [], "carried, so nothing is recorded as dropped");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #355: a delivery routed into an active cooldown must not be dropped as an
// orphan when the wall clock crosses untilMs before the invariant repair reads
// it again. Field trace: #8645 CI, "Repaired residency: dropped 2 orphan pending
// delivery message(s) … after delivery-spawn-fail-cooldown".
// ─────────────────────────────────────────────────────────────────────────────

test("task #355: cooldown expiring between routing and invariant repair does not drop buffered deliveries", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const m = manager as any;
    const ap = getProcess(manager, "agent-1");
    // The runtime closed after a recoverable error with one queued wake and one buffered message.
    m.agents.delete("agent-1");
    m.armRuntimeErrorProcessRestart(
      "agent-1",
      ap,
      "provider_stream",
      makeMessage("queued wake", { message_id: "m-wake", seq: 970 }),
      [makeMessage("buffered", { message_id: "m-buf", seq: 971 })],
      1,
      10_000,
    );
    const untilMs = m.lifecycleRecords.getSpawnFailBackoff("agent-1").untilMs;

    // The routing decision reads the clock just before untilMs; the invariant
    // repair reads it just after. The restart timer has not fired yet.
    let phase: "routing" | "repair" = "routing";
    m.readWallClock = () => (phase === "repair" ? untilMs + 10 : untilMs - 1);
    const repair = m.repairNoProcessResidency.bind(m);
    m.repairNoProcessResidency = (context: string) => {
      phase = "repair";
      try {
        return repair(context);
      } finally {
        phase = "routing";
      }
    };

    await manager.deliverMessage("agent-1", makeMessage("arrives in the last millisecond", { message_id: "m-late", seq: 972 }));

    assert.equal(m.startingInboxes.count("agent-1"), 3, "all three deliveries stay buffered for the pending restart");
    assert.equal(
      traceRows(sink).filter((span) => span.name === "daemon.agent.residency.repaired" && span.attrs?.repair === "orphan_pending_delivery").length,
      0,
      "nothing is dropped as an orphan",
    );
    m.cancelRuntimeErrorProcessRestart("agent-1");
  }, { tracer });
});

test("task #355: when a spawn-fail cooldown ends, deliveries buffered during it start the agent instead of being dropped", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const m = manager as any;
    const ap = getProcess(manager, "agent-1");
    // Process gone, idle restart config cached, and a spawn failure put the agent in cooldown.
    m.agents.delete("agent-1");
    m.lifecycleRecords.setRestartSnapshot("agent-1", {
      config: ap.config,
      sessionId: ap.sessionId,
      launchId: ap.launchId,
      processInstanceId: ap.processInstanceId,
    });
    const report = m.recordSpawnFailure("agent-1", "spawn_error");
    assert.equal(report.backoffActive, true, "precondition: cooldown active");

    await manager.deliverMessage("agent-1", makeMessage("sent during cooldown", { message_id: "m-cd", seq: 980 }));
    assert.equal(m.startingInboxes.count("agent-1"), 1, "precondition: buffered, not spawned");
    const spawnsBefore = driver.spawnCalls.length;

    // Fire the cooldown's expiry deterministically.
    clearTimeout(m.lifecycleRecords.getSpawnFailBackoff("agent-1").timer);
    m.onSpawnFailBackoffExpired("agent-1");

    await waitFor(() => driver.spawnCalls.length === spawnsBefore + 1, "start from the pending inbox");
    assert.equal(
      traceRows(sink).filter((span) => span.name === "daemon.agent.residency.repaired" && span.attrs?.repair === "orphan_pending_delivery").length,
      0,
      "the buffered delivery is not dropped as an orphan",
    );
  }, { tracer });
});

test("task #353: dropped_on_exit keeps its exit reason through the real local trace sink", async () => {
  const { LocalRotatingTraceSink } = await import("@botiverse/raft-trace-client");
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-353-sink-"));
  // CI flake 36577257233: `rmdir <machineDir>` failed with ENOTEMPTY. The late
  // writer was `daemon.runner_credential.revoke` (found by @Kabi): stopAgent
  // fires an un-awaited DELETE via the module-level daemonFetch (not the
  // injectable fetchImpl) to the test serverUrl over the real network, and its
  // `.then/.catch` records into this sink whenever the request settles
  // (~seconds), which can recreate `traces/` during the `finally` rm. This
  // test therefore runs an agent without a runner credential, so that writer
  // does not exist here. The gate below stays as the guard: records before
  // teardown reach the real sink unchanged; any record after teardown is not
  // written and fails the test by name.
  const realSink = new LocalRotatingTraceSink({ machineDir });
  const lateRecords: string[] = [];
  let sinkClosed = false;
  const sink = {
    record(span: Parameters<typeof realSink.record>[0]) {
      if (sinkClosed) lateRecords.push(`span:${span.name}`);
      else realSink.record(span);
    },
    recordLogEvent(event: { name: string } & Record<string, unknown>) {
      if (sinkClosed) lateRecords.push(`event:${event.name}`);
      else (realSink as any).recordLogEvent?.(event);
    },
  };
  try {
    const tracer = new BasicTracer({ sink: sink as any });
    await withManager(async ({ driver, manager }) => {
      // The default config carries no credential id; the explicit null keeps
      // this test from depending on that default. Without a credential,
      // stopAgent has no revoke, i.e. no request whose settlement would write
      // into this sink later.
      await busyAgentWithTwoQueued(driver, manager, { agentCredentialId: null });
      await manager.stopAgent("agent-1", { silent: true });
    }, { tracer });
    sinkClosed = true;
    // Short observation window: with the revoke writer removed, nothing should
    // record after teardown. Giving the agent a credential (agentCredentialId:
    // "cred-test") with a long enough window makes the assertion below fail
    // with `event:daemon.runner_credential.revoke`.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const traceDir = path.join(machineDir, "traces");
    const { readdir } = await import("node:fs/promises");
    const rows = (await Promise.all((await readdir(traceDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(path.join(traceDir, name), "utf8"))))
      .flatMap((text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    const record = rows.find((row) => row.name === "daemon.agent.inbox.dropped_on_exit");
    assert.ok(record, "the event reaches the on-disk trace");
    assert.equal(record.attrs.exit_reason, "silent_stop", "the reason survives the sink's attribute filter");
    assert.equal(record.attrs.dropped_count, 2);
    assert.equal(record.attrs.expected, true);
    assert.deepEqual(lateRecords, [], "no trace record may reach the sink after the manager is torn down");
  } finally {
    sinkClosed = true;
    await rm(machineDir, { recursive: true, force: true });
  }
});

// task #268: live stdin delivery shows a sender's description once per model
// context, through the CLI's agent ledger (senderLedger.ts).
test("Claude live delivery: a sender's description is shown once per context, again after compaction", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    await manager.startAgent("agent-1", { ...makeConfig({ sessionId: "session-1" }), passiveAx: true } as AgentConfig);
    const ap = getProcess(manager, "agent-1");
    (manager as any).slockHome = dataDir;
    ap.cliTransportDir = path.join(dataDir, "cli-transport");
    await mkdir(ap.cliTransportDir, { recursive: true });
    writeContextGeneration(ap.cliTransportDir, { reason: "spawn", runtime: "claude", compaction: ap.driver.session.compaction, passiveAx: true });
    // The ledger exists because the agent's CLI created it.
    const dbDir = path.join(dataDir, "agent-state", "agent-1");
    await mkdir(dbDir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dbDir, "state.db"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('version', '1');");
    db.exec("CREATE TABLE observations (type TEXT NOT NULL, id TEXT NOT NULL, rev TEXT NOT NULL, context_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (type, id))");
    db.close();

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    const deliverIdle = async (content: string) => {
      driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
      await flush();
      manager.deliverMessage("agent-1", makeMessage(content, { sender_description: "Founder of Raft" }), { transient: true });
      await flush();
      return driver.encodedCalls.at(-1)?.text ?? "";
    };

    assert.match(await deliverIdle("first"), /@richard — Founder of Raft: first/);
    const second = await deliverIdle("second");
    assert.match(second, /@richard: second/);
    assert.doesNotMatch(second, /Founder of Raft/);

    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();
    assert.match(await deliverIdle("third"), /@richard — Founder of Raft: third/);
  });
});

test("Claude live delivery: a ledger write lock held by the CLI never delays delivery; the description is shown in full", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    await manager.startAgent("agent-1", { ...makeConfig({ sessionId: "session-1" }), passiveAx: true } as AgentConfig);
    const ap = getProcess(manager, "agent-1");
    (manager as any).slockHome = dataDir;
    ap.cliTransportDir = path.join(dataDir, "cli-transport");
    await mkdir(ap.cliTransportDir, { recursive: true });
    writeContextGeneration(ap.cliTransportDir, { reason: "spawn", runtime: "claude", compaction: ap.driver.session.compaction, passiveAx: true });
    const dbDir = path.join(dataDir, "agent-state", "agent-1");
    await mkdir(dbDir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const cli = new DatabaseSync(path.join(dbDir, "state.db"));
    cli.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('version', '1');");
    cli.exec("CREATE TABLE observations (type TEXT NOT NULL, id TEXT NOT NULL, rev TEXT NOT NULL, context_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (type, id))");
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    cli.exec("BEGIN IMMEDIATE");
    try {
      for (const content of ["first", "second"]) {
        driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
        await flush();
        const started = performance.now();
        manager.deliverMessage("agent-1", makeMessage(content, { sender_description: "Founder of Raft" }), { transient: true });
        assert.ok(performance.now() - started < 200, "delivery must not wait on the ledger lock");
        await flush();
        assert.match(driver.encodedCalls.at(-1)?.text ?? "", new RegExp(`@richard — Founder of Raft: ${content}`));
      }
    } finally {
      cli.exec("ROLLBACK");
      cli.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// task #1260 — background tasks keep a quiet main turn out of "Idle"
// Real sequence captured from Claude Code (stream-json): Agent tool returns at
// once → system task_started → main turn `result` (turn_end) → subagent rows
// → system task_notification {status} → Claude opens a new turn by itself.
// ─────────────────────────────────────────────────────────────────────────────

function subagentLine(phase: "started" | "progress" | "notification", taskId: string, extra: Record<string, unknown> = {}) {
  return [{
    kind: "subagent_progress",
    source: "claude_task_lifecycle",
    phase,
    taskId,
    parentToolUseId: `toolu_${taskId}`,
    subagentType: "general-purpose",
    payloadBytes: 64,
    ...extra,
  } as ParsedEvent];
}

function lastActivity(sent: MachineToServerMessage[]) {
  const msg = activityMessages(sent).at(-1)!;
  return { detail: msg.detail, detailKind: msg.detailKind };
}

test("task #1260: a turn ending with a background task outstanding shows waiting, not Idle, and stays protocol-idle for delivery", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("task-a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("task-a-start-dup", subagentLine("started", "task_a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("task-a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));

    const proc = driver.processes[0];
    proc.stdout.emit("data", Buffer.from("task-a-start\n"));
    proc.stdout.emit("data", Buffer.from("task-a-start-dup\n"));
    proc.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.backgroundTasks.size, 1, "the same task_id counts once");
    assert.deepEqual(lastActivity(sent), { detail: "Waiting for 1 background task", detailKind: "subagent_activity" });
    assert.equal(ap.gatedSteering.isIdle, true, "delivery semantics: the main turn is over, the agent is idle for stdin delivery");

    proc.stdout.emit("data", Buffer.from("task-a-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.deepEqual(lastActivity(sent), { detail: "Idle", detailKind: "idle" });
    const details = activityMessages(sent).map((m) => m.detail);
    assert.ok(details.includes("Subagent completed (general-purpose)"), details.join(" | "));
    // #proj-runtime:#41: how it ended rides on the marker, so the web never reads the detail text.
    const ended = activityMessages(sent).flatMap((m) => (m as { entries?: Array<{ subagent?: { phase?: string; outcome?: string } }> }).entries ?? [])
      .map((entry) => entry.subagent).filter((lineage) => lineage?.phase === "notification");
    assert.deepEqual(ended.map((lineage) => lineage?.outcome), ["done"]);
  });
});

test("#proj-runtime:#43: a shell command Claude runs as a task is background work, never a sub-agent row", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("bash-start", subagentLine("started", "bash_1", { taskKind: "command", subagentType: undefined }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("bash-done", subagentLine("notification", "bash_1", { taskKind: "command", subagentType: undefined, taskStatus: "completed" }));

    const proc = driver.processes[0];
    proc.stdout.emit("data", Buffer.from("bash-start\n"));
    proc.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.backgroundTasks.size, 1, "a backgrounded command is still work the quiet turn waits for");
    assert.deepEqual(lastActivity(sent), { detail: "Waiting for 1 background task", detailKind: "subagent_activity" });

    proc.stdout.emit("data", Buffer.from("bash-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.deepEqual(lastActivity(sent), { detail: "Idle", detailKind: "idle" });
    const lineage = activityMessages(sent).flatMap((m) => (m as { entries?: Array<{ subagent?: unknown }> }).entries ?? []).filter((entry) => entry.subagent);
    assert.deepEqual(lineage, [], "no entry marks it as a sub-agent");
    assert.ok(!activityMessages(sent).some((m) => /Subagent/.test(m.detail ?? "")));

    // One that starts while the agent is already quiet says so at once.
    driver.parsedLines.set("bash-2-start", subagentLine("started", "bash_2", { taskKind: "command", subagentType: undefined }));
    proc.stdout.emit("data", Buffer.from("bash-2-start\n"));
    await flush();
    assert.deepEqual(lastActivity(sent), { detail: "Waiting for 1 background task", detailKind: "subagent_activity" });
  });
});

test("#proj-runtime:#41: a subagent's output and tools after the main turn ended keep the agent idle", async () => {
  // Codex subagents keep writing on their own thread after the agent's turn
  // ended; none of it is the agent's turn, so delivery must still see it idle.
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const subagent = { parentToolUseId: "call_2", taskId: "thread-child" };
    driver.parsedLines.set("child-start", [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "started", ...subagent } as ParsedEvent]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("child-work", [
      { kind: "thinking", text: "looking", subagent },
      { kind: "tool_call", name: "shell", input: { command: "ls" }, callId: "thread-child:call_1", subagent },
    ] as ParsedEvent[]);
    driver.parsedLines.set("child-work-end", [
      { kind: "tool_output", name: "shell", callId: "thread-child:call_1", subagent },
      { kind: "text", text: "child done", subagent },
    ] as ParsedEvent[]);
    driver.parsedLines.set("child-done", [{ kind: "subagent_progress", source: "codex_subagent_thread", phase: "notification", taskStatus: "completed", ...subagent } as ParsedEvent]);

    const proc = driver.processes[0];
    proc.stdout.emit("data", Buffer.from("child-start\n"));
    proc.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.gatedSteering.isIdle, true);

    proc.stdout.emit("data", Buffer.from("child-work\n"));
    await flush();
    assert.equal(ap.gatedSteering.isIdle, true, "the subagent's work does not reopen the agent's turn");
    assert.equal(ap.gatedSteering.outstandingToolUses, 0, "the subagent's tool is not one of the agent's open tool uses");
    assert.equal(ap.runtimeTraceSpan, null, "nor does it open a turn of the agent's");
    assert.equal(ap.openToolCallIds?.has("thread-child:call_1") ?? false, false, "nor is its open tool one of the agent's open calls");

    proc.stdout.emit("data", Buffer.from("child-work-end\n"));
    await flush();
    assert.equal(ap.gatedSteering.isIdle, true);
    assert.equal(ap.gatedSteering.outstandingToolUses, 0);
    assert.equal(ap.runtimeTraceSpan, null);

    proc.stdout.emit("data", Buffer.from("child-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.deepEqual(lastActivity(sent), { detail: "Idle", detailKind: "idle" });
  });
});

test("#proj-runtime:#41: a subagent's output does not end the agent's context compaction", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const subagent = { parentToolUseId: "call_2", taskId: "thread-child" };
    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("child-work", [
      { kind: "text", text: "child output", subagent },
      { kind: "tool_call", name: "shell", input: { command: "ls" }, callId: "thread-child:call_1", subagent },
    ] as ParsedEvent[]);
    driver.parsedLines.set("main-text", [{ kind: "text", text: "back" }]);
    const proc = driver.processes[0];
    proc.stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.compaction.kind, "active");
    proc.stdout.emit("data", Buffer.from("child-work\n"));
    await flush();
    assert.equal(ap.compaction.kind, "active", "the agent is still compacting");
    assert.equal(ap.gatedSteering.compacting, true);
    proc.stdout.emit("data", Buffer.from("main-text\n"));
    await flush();
    assert.notEqual(ap.compaction.kind, "active", "the agent's own output still ends it");
  });
});

function codexSubagentLine(phase: "started" | "notification", taskId: string, extra: Record<string, unknown> = {}) {
  return [{ kind: "subagent_progress", source: "codex_subagent_thread", phase, taskId, parentToolUseId: `call_${taskId}`, ...extra } as ParsedEvent];
}

const SUBAGENTS_FINISHED_WAKE = "Your sub-agents have finished. Their results are above. Continue your work with them. Complete all your work before stopping.";

test("#proj-runtime:#41: on a runtime that does not wake itself, the last subagent finishing after the turn ended starts the agent's next turn", async () => {
  await withManager(async ({ driver, manager }) => {
    Object.assign(driver, { needsWakeAfterSubagents: true });
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
    driver.parsedLines.set("b-start", codexSubagentLine("started", "b"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("a-done", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
    driver.parsedLines.set("a-done-again", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
    driver.parsedLines.set("b-done", codexSubagentLine("notification", "b", { taskStatus: "failed" }));

    const proc = driver.processes[0];
    for (const line of ["a-start", "b-start", "turn-end"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    const writes = driver.encodedCalls.length;

    proc.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, writes, "one subagent is still running: no wake yet");

    proc.stdout.emit("data", Buffer.from("b-done\n"));
    await flush();
    assert.deepEqual(driver.encodedCalls.slice(writes), [{ text: SUBAGENTS_FINISHED_WAKE, mode: "idle", sessionId: "session-1" }]);
    assert.equal(ap.gatedSteering.isIdle, false, "the wake claimed the turn");

    // The woken turn ends; a repeated notification then changes nothing, so it wakes nothing.
    proc.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(ap.gatedSteering.isIdle, true);
    proc.stdout.emit("data", Buffer.from("a-done-again\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, writes + 1, "a repeated notification changes nothing, so it wakes nothing");
  });
});

test("#proj-runtime:#41: no wake after a user stopped the turn, or while a runtime error is showing", async () => {
  for (const variant of ["stopped", "error"] as const) {
    await withManager(async ({ driver, manager }) => {
      Object.assign(driver, { needsWakeAfterSubagents: true });
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      await flush();
      driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1", ...(variant === "stopped" ? { interrupted: true as const } : {}) }]);
      driver.parsedLines.set("a-done", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
      const proc = driver.processes[0];
      for (const line of ["a-start", "turn-end"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
      const ap = (manager as any).agents.get("agent-1");
      if (variant === "error") ap.lastRuntimeError = "Codex turn failed";
      const writes = driver.encodedCalls.length;
      proc.stdout.emit("data", Buffer.from("a-done\n"));
      await flush();
      assert.equal(driver.encodedCalls.length, writes, `${variant}: the agent is not started again`);
      assert.equal(ap.gatedSteering.isIdle, true, `${variant}: the turn was not claimed`);
    });
  }
});

test("#proj-runtime:#41: no wake when the runtime wakes itself, or while the agent's turn is still running", async () => {
  await withManager(async ({ driver, manager }) => {
    // Claude Code opens the next turn by itself.
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("a-done", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    for (const line of ["a-start", "turn-end"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    const writes = driver.encodedCalls.length;
    proc.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, writes);
  });
  await withManager(async ({ driver, manager }) => {
    Object.assign(driver, { needsWakeAfterSubagents: true });
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
    driver.parsedLines.set("a-done", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    const writes = driver.encodedCalls.length;
    // The subagent ends inside the agent's turn: the runtime hands the result over in that turn.
    for (const line of ["a-start", "a-done"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    assert.equal(driver.encodedCalls.length, writes);
  });
});

test("#proj-runtime:#41: a person stops one sub-agent; its end then wakes nothing", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    // The fake runtime has no way to stop one sub-agent.
    assert.equal(await manager.interruptSubagent("agent-1", "a"), "unsupported");
    assert.equal(await manager.interruptSubagent("agent-2", "a"), "not_running");

    Object.assign(driver, {
      needsWakeAfterSubagents: true,
      encodeSubagentInterruptRequest: (taskId: string) => (taskId === "a" ? JSON.stringify({ stop: taskId }) : null),
    });
    driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("a-stopped", codexSubagentLine("notification", "a", { taskStatus: "stopped" }));
    const proc = driver.processes[0];
    for (const line of ["a-start", "turn-end"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();

    assert.equal(await manager.interruptSubagent("agent-1", "b"), "not_running", "no such sub-agent running");
    assert.equal(await manager.interruptSubagent("agent-1", "a"), "interrupted");
    assert.ok(proc.stdinWrites.some((chunk) => chunk.includes(JSON.stringify({ stop: "a" }))), "the stop went to the runtime");

    const writes = driver.encodedCalls.length;
    proc.stdout.emit("data", Buffer.from("a-stopped\n"));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(driver.encodedCalls.length, writes, "stopped on purpose: no 'your sub-agents have finished' wake");
    assert.equal(ap.gatedSteering.isIdle, true);
  });
});

test("#proj-runtime:#41: a stop that raced a sub-agent finishing on its own still wakes; so does one that finished before another was stopped", async () => {
  for (const variant of ["race", "two"] as const) {
    await withManager(async ({ driver, manager }) => {
      Object.assign(driver, {
        needsWakeAfterSubagents: true,
        encodeSubagentInterruptRequest: (taskId: string) => JSON.stringify({ stop: taskId }),
      });
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      await flush();
      driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
      driver.parsedLines.set("b-start", codexSubagentLine("started", "b"));
      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.parsedLines.set("a-completed", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
      driver.parsedLines.set("a-stopped", codexSubagentLine("notification", "a", { taskStatus: "stopped" }));
      driver.parsedLines.set("b-completed", codexSubagentLine("notification", "b", { taskStatus: "completed" }));
      const proc = driver.processes[0];
      const lines = variant === "race" ? ["a-start", "turn-end"] : ["a-start", "b-start", "turn-end"];
      for (const line of lines) proc.stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
      assert.equal(await manager.interruptSubagent("agent-1", "a"), "interrupted");
      const writes = driver.encodedCalls.length;
      // race: Codex refused the stop, the sub-agent had finished on its own.
      // two: B finishes on its own, then A ends as the person stopped it.
      for (const line of variant === "race" ? ["a-completed"] : ["b-completed", "a-stopped"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
      assert.equal(driver.encodedCalls.length, writes + 1, `${variant}: a finished sub-agent's result wakes the agent`);
      const ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.userStoppedSubagents.size, 0, `${variant}: the stopped id is forgotten`);
    });
  }
});

test("#proj-runtime:#41: a stop names only a subagent this process saw start and not end; nothing is written otherwise", async () => {
  await withManager(async ({ driver, manager }) => {
    // A runtime that does not track subagents itself (Claude Code): it would encode any id.
    Object.assign(driver, { encodeSubagentInterruptRequest: (taskId: string) => JSON.stringify({ stop_task: taskId }) });
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", codexSubagentLine("started", "a"));
    driver.parsedLines.set("a-done", codexSubagentLine("notification", "a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    const wrote = (id: string) => proc.stdinWrites.some((chunk) => chunk.includes(JSON.stringify({ stop_task: id })));

    assert.equal(await manager.interruptSubagent("agent-1", "a"), "not_running", "not started yet");
    proc.stdout.emit("data", Buffer.from("a-start\n"));
    await flush();
    assert.equal(await manager.interruptSubagent("agent-1", "unknown"), "not_running");
    assert.equal(wrote("unknown"), false);
    proc.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(await manager.interruptSubagent("agent-1", "a"), "not_running", "already ended");
    assert.equal(wrote("a"), false, "no stop was ever written");
  });
});

test("task #1260: failed and stopped notifications end a task; an unknown or repeated notification changes nothing; the count follows nested tasks", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("b-start", subagentLine("started", "task_b"));
    driver.parsedLines.set("c-start", subagentLine("started", "task_c"));
    driver.parsedLines.set("b-failed", subagentLine("notification", "task_b", { taskStatus: "failed" }));
    driver.parsedLines.set("c-stopped", subagentLine("notification", "task_c", { taskStatus: "stopped" }));
    driver.parsedLines.set("zz-done", subagentLine("notification", "task_zz", { taskStatus: "completed" }));
    driver.parsedLines.set("a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    const ap = (manager as any).agents.get("agent-1");

    for (const line of ["a-start", "turn-end", "b-start", "c-start"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    assert.equal(ap.backgroundTasks.size, 3);

    proc.stdout.emit("data", Buffer.from("b-failed\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 2);
    assert.equal(lastActivity(sent).detail, "Waiting for 2 background tasks", "a quiet turn re-states what is still outstanding");

    proc.stdout.emit("data", Buffer.from("zz-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 2, "a notification for a task this process never started is ignored");
    assert.equal(lastActivity(sent).detail, "Waiting for 2 background tasks", "the count is re-stated unchanged");

    proc.stdout.emit("data", Buffer.from("c-stopped\n"));
    proc.stdout.emit("data", Buffer.from("c-stopped\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 1, "a repeated notification is not double-counted");
    assert.equal(lastActivity(sent).detail, "Waiting for 1 background task");

    proc.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(lastActivity(sent).detail, "Idle");
  });
});

test("task #1260: a notification without a confirmed terminal status keeps the task outstanding (reviewer counterexample)", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("a-unknown", subagentLine("notification", "task_a"));
    driver.parsedLines.set("a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    const ap = (manager as any).agents.get("agent-1");

    for (const line of ["a-start", "turn-end", "a-unknown"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    assert.equal(ap.backgroundTasks.size, 1, "the envelope's name is not completion evidence");
    assert.equal(lastActivity(sent).detail, "Waiting for 1 background task");
    assert.equal(activityMessages(sent).filter((m) => m.detail === "Idle").length, 0);

    proc.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(lastActivity(sent).detail, "Idle");
  });
});

test("task #1260: the last notification does not overwrite a turn the main agent has already started", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("new-turn-text", [{ kind: "text", text: "picking the results up" }]);
    driver.parsedLines.set("a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));
    const proc = driver.processes[0];
    const ap = (manager as any).agents.get("agent-1");

    for (const line of ["a-start", "turn-end", "new-turn-text", "a-done"]) proc.stdout.emit("data", Buffer.from(`${line}\n`));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.notEqual(ap.runtimeTraceSpan, null, "the new turn is open");
    assert.notEqual(lastActivity(sent).detail, "Idle", "no Idle while a turn is open");
    assert.equal(activityMessages(sent).filter((m) => m.detail === "Idle").length, 0);

    // The open turn ends normally with nothing outstanding: Idle, as always.
    proc.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(lastActivity(sent).detail, "Idle");
  });
});

test("task #1260: a restart forgets the old process's background tasks; its late notification cannot reach the new one", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    driver.parsedLines.set("a-start", subagentLine("started", "task_a"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.parsedLines.set("a-done", subagentLine("notification", "task_a", { taskStatus: "completed" }));
    const first = driver.processes[0];
    first.stdout.emit("data", Buffer.from("a-start\n"));
    first.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(lastActivity(sent).detail, "Waiting for 1 background task");

    await manager.stopAgent("agent-1");
    await flush();
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.backgroundTasks.size, 0, "a fresh process record starts with no background tasks");
    const second = driver.processes[1];
    second.stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(lastActivity(sent).detail, "Idle", "no residue from the previous process");

    // A notification the old process emits late (e.g. during teardown) is addressed to the old record.
    first.stdout.emit("data", Buffer.from("a-done\n"));
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(lastActivity(sent).detail, "Idle");
  });
});

// task #379 — Claude Code's usage-limit reply is a structured provider limit
// (see claudeEventNormalizer). Field sample (KopiC, #proj-runtime:f0eadc47):
// each turn was one synthetic quota error plus turn_end, and the generic
// `runtime_error` backoff cleared at every turn_end, so each delivery and
// reminder immediately started another empty turn for 15 hours.
const QUOTA_TEXT_379 = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai.";

async function emitTurn(
  driver: { parsedLines: Map<string, unknown[]>; processes: Array<{ stdout: { emit: (event: string, data: Buffer) => void } }> },
  line: string,
  events: unknown[],
) {
  driver.parsedLines.set(line, events);
  driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
  await flush();
}

test("task #379: a used-up quota takes the rate-limit backoff, which survives turn_end and holds deliveries", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota-turn", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);

    const ap = getProcess(manager, "agent-1");
    assert.ok(ap, "a used-up quota keeps the runtime process (recoverable, not terminal)");
    assert.equal(ap.runtimeErrorDeliveryBackoff.kind, "backing_off", "turn_end must not clear the quota backoff");
    assert.equal(ap.runtimeErrorDeliveryBackoff.reason, "rate_limited");

    const writesBefore = driver.encodedCalls.length;
    const accepted = await manager.deliverMessage(
      "agent-1",
      makeMessage("delivery during quota backoff", { message_id: "msg-quota", seq: 379 }),
      { deliveryId: "delivery-quota" },
    );
    assert.equal(accepted, true);
    assert.equal(driver.encodedCalls.length, writesBefore, "a delivery during the backoff waits instead of starting another empty turn");
    assert.equal(getProcess(manager, "agent-1").inbox.length, 1);

    assert.equal(sent.some((m) => m.type === "agent:status" && (m as { status?: string }).status === "inactive"), false);
    const errorActivity = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .filter((msg) => projectTestActivity(msg) === "error")
      .at(-1);
    assert.match(errorActivity?.detail ?? "", /reached your Fable limit/);
    assert.doesNotMatch(errorActivity?.detail ?? "", /resets at/, "no reset time is invented when the runtime did not report one");
    // The typed carrier names the limit the runtime reported, not an unclassified error.
    const carrier = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .find((msg) => msg.runtimeError)?.runtimeError;
    assert.equal(carrier?.errorClass, "RateLimitError");
    assert.equal(carrier?.errorReason, "rate_limited");
  });
});

test("task #379: a runtime-reported reset time reaches the visible error", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota-reset", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted", resetsAt: "2026-10-14T00:00:00.000Z" } },
    ]);
    const errorActivity = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .filter((msg) => projectTestActivity(msg) === "error")
      .at(-1);
    assert.match(errorActivity?.detail ?? "", /limit resets at 2026-10-14T00:00:00\.000Z/);
  });
});

test("dm:@xxchan:#3: a quota-limited turn's summary carries the reset and ends when the runtime ended it, not at the next attempt", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    (manager as any).broadcastMessageReceivedActivity("agent-1", [makeMessage("hi", { message_id: "m-quota", seq: 1 })]);
    const beforeError = Date.now();
    await emitTurn(driver as never, "quota-turn", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted", resetsAt: "2026-11-08T07:00:00.000Z" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    const afterTurnEnd = Date.now();
    // The next attempt an hour later closes it.
    const [entry] = (manager as any).turnSummaries.begin("agent-1", afterTurnEnd + 3_600_000, undefined, "failed");
    assert.equal(entry?.kind, "turn_summary");
    assert.deepEqual(entry.summary.usageLimit, { resetsAt: Date.parse("2026-11-08T07:00:00.000Z") });
    assert.ok(entry.summary.endedAt >= beforeError && entry.summary.endedAt <= afterTurnEnd, "ended at the runtime's turn end, not an hour later");
  });
});

test("task #379: a transient throttle takes the same recoverable backoff and never goes terminal", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    // Wording the text classifier does not know: only the structured
    // classification can route it to the rate-limit backoff.
    const throttle = { kind: "error", message: "Slow down a little, then send again.", providerLimit: { kind: "transient_rate_limit" } };
    for (let i = 0; i < 4; i += 1) {
      await emitTurn(driver as never, `throttle-${i}`, [throttle, { kind: "turn_end", sessionId: "session-1" }]);
    }
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.reason, "rate_limited");
    assert.equal(sent.some((m) => m.type === "agent:status" && (m as { status?: string }).status === "inactive"), false);
  });
});

test("task #379: real progress after the quota resets clears the backoff", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota-before-recovery", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "backing_off");
    await emitTurn(driver as never, "recovered", [{ kind: "text", text: "Back to work." }]);
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "idle");
  });
});

test("task #379: an unclassified runtime error keeps today's backoff that turn_end clears (control)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "generic", [
      { kind: "error", message: QUOTA_TEXT_379 },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "idle", "without the structured limit the same text keeps the old runtime_error behaviour");
  });
});

// task #379 (prod readback 10-19, 1.0.50): Claude emits `status: requesting`
// and stream events as `internal_progress` at the start of every turn,
// including a turn that immediately hits the same limit. That used to clear
// the rate_limited backoff, so attempts never grew past 1 and a quota-
// exhausted agent started a turn per incoming message (96 turns/day).
test("task #379: turn-start internal progress does not clear a rate-limit backoff, so it keeps growing", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const quotaError = { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } };
    const turnStart = { kind: "internal_progress", source: "claude_system_status", itemType: "requesting", payloadBytes: 0 };
    await emitTurn(driver as never, "quota-1", [quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.attempts, 1);
    await emitTurn(driver as never, "quota-2", [turnStart, quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    await emitTurn(driver as never, "quota-3", [turnStart, { kind: "runtime_diagnostic", name: "status", attrs: {} }, quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    const backoff = getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff;
    assert.equal(backoff.kind, "backing_off", "the next turn's start must not clear the backoff");
    assert.equal(backoff.reason, "rate_limited");
    assert.equal(backoff.attempts, 3, "each further limited turn grows the backoff instead of restarting at 1");
  });
});

// task #386 (prod 1.0.50): Codex (turn/started), Copilot, Kimi and OpenCode
// mark the start of a turn or step with an empty `thinking` event before the
// model has produced anything. It is the same turn-start bookkeeping as
// Claude's internal_progress above and must not count as recovery.
test("task #386: an empty turn-start thinking marker does not clear a rate-limit backoff, so it keeps growing", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const quotaError = { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } };
    const turnStartMarker = { kind: "thinking", text: "" };
    await emitTurn(driver as never, "quota-1", [turnStartMarker, quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    await emitTurn(driver as never, "quota-2", [turnStartMarker, quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    await emitTurn(driver as never, "quota-3", [turnStartMarker, quotaError, { kind: "turn_end", sessionId: "session-1" }]);
    const backoff = getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff;
    assert.equal(backoff.kind, "backing_off", "the next turn's empty thinking marker must not clear the backoff");
    assert.equal(backoff.reason, "rate_limited");
    assert.equal(backoff.attempts, 3, "each further limited turn grows the backoff instead of restarting at 1");
  });
});

test("task #379: real model output after a rate-limit backoff still clears it (control)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    await emitTurn(driver as never, "recovered", [
      { kind: "internal_progress", source: "claude_system_status", itemType: "requesting", payloadBytes: 0 },
      { kind: "text", text: "Back to work." },
    ]);
    assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "idle");
  });
});

test("task #379: tool_output, subagent progress and diagnostics do not clear a rate-limit backoff", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    await emitTurn(driver as never, "late", [
      { kind: "tool_output", name: "Bash", output: "a tool started before the limit finished late" },
      { kind: "subagent_progress", source: "claude_subagent", phase: "running", parentToolUseId: "t1", payloadBytes: 10 },
      { kind: "runtime_diagnostic", name: "status", attrs: {} },
    ]);
    const backoff = getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff;
    assert.equal(backoff.kind, "backing_off");
    assert.equal(backoff.attempts, 1);
  });
});

test("task #379: a used-up quota with a reported future reset waits until the reset, at most 60 minutes", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    const before = Date.now();
    await emitTurn(driver as never, "quota-reset-far", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted", resetsAt: new Date(before + 2 * 60 * 60_000).toISOString() } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    const after = Date.now();
    const untilMs = getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.untilMs;
    assert.ok(untilMs >= before + QUOTA_RESET_BACKOFF_MAX_MS && untilMs <= after + QUOTA_RESET_BACKOFF_MAX_MS, `holds for 60 minutes, not 2 hours (untilMs - now = ${untilMs - after})`);
  });
});

// #proj-raft-computer:#46: the limit belongs to the credential. A manual
// restart (explicit stop, then start) is a human "try again" and releases it,
// on the shared sign-in for every agent on it (the next request re-arms it if
// the account is still limited).
test("task #379: restarting the agent is a manual recovery that starts with no backoff, on its own credentials or the shared sign-in", async () => {
  for (const envVars of [{ CLAUDE_CONFIG_DIR: "/srv/claude-agent-1" }, null]) {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1", envVars }));
      await flush();
      await emitTurn(driver as never, "quota", [
        { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted", resetsAt: new Date(Date.now() + 30 * 60_000).toISOString() } },
        { kind: "turn_end", sessionId: "session-1" },
      ]);
      assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "backing_off");
      // Another agent on the shared sign-in: it waits for the same limit.
      await manager.startAgent("agent-2", makeConfig({ name: "claude-agent-2", sessionId: "session-2" }));
      await flush();
      assert.equal(getProcess(manager, "agent-2").runtimeErrorDeliveryBackoff.kind, envVars ? "idle" : "backing_off", `envVars=${JSON.stringify(envVars)}`);
      await manager.stopAgent("agent-1");
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1", envVars }));
      await flush();
      assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "idle", `envVars=${JSON.stringify(envVars)}`);
      assert.equal(getProcess(manager, "agent-2").runtimeErrorDeliveryBackoff.kind, "idle", "the shared sign-in's other agent is released too");
    });
  }
});

test("task #379: providerLimitBackoffDelayMs only waits for a valid future quota reset, capped at 60 minutes", () => {
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const exp = 10_000;
  const at = (ms: number) => new Date(now + ms).toISOString();
  const quota = (resetsAt?: string) => ({ kind: "quota_exhausted" as const, ...(resetsAt !== undefined ? { resetsAt } : {}) });
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(5 * 60_000)), exponentialDelayMs: exp, nowMs: now }), 5 * 60_000, "future reset within the cap");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(60 * 60_000)), exponentialDelayMs: exp, nowMs: now }), 60 * 60_000, "exactly at the cap");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(60 * 60_000 + 1)), exponentialDelayMs: exp, nowMs: now }), QUOTA_RESET_BACKOFF_MAX_MS, "just past the cap is capped");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(7 * 24 * 60 * 60_000)), exponentialDelayMs: exp, nowMs: now }), QUOTA_RESET_BACKOFF_MAX_MS, "a weekly reset is capped");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(0)), exponentialDelayMs: exp, nowMs: now }), exp, "a reset at now is not in the future");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(at(-60_000)), exponentialDelayMs: exp, nowMs: now }), exp, "a past reset falls back");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota("not-a-time"), exponentialDelayMs: exp, nowMs: now }), exp, "an invalid reset falls back");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(), exponentialDelayMs: exp, nowMs: now }), exp, "a missing reset falls back");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: { kind: "transient_rate_limit", resetsAt: at(5 * 60_000) }, exponentialDelayMs: exp, nowMs: now }), exp, "a transient throttle never waits for a reset");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: undefined, exponentialDelayMs: exp, nowMs: now }), exp, "an unclassified error keeps the exponential delay");
  // #proj-raft-computer:#46 Q3: any single provider-limit wait, with or without a reported reset.
  const longExp = 2 * QUOTA_RESET_BACKOFF_MAX_MS;
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: quota(), exponentialDelayMs: longExp, nowMs: now }), QUOTA_RESET_BACKOFF_MAX_MS, "an exponential quota wait is capped too");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: { kind: "transient_rate_limit" }, exponentialDelayMs: longExp, nowMs: now }), QUOTA_RESET_BACKOFF_MAX_MS, "so is a throttle's");
  assert.equal(providerLimitBackoffDelayMs({ providerLimit: undefined, exponentialDelayMs: longExp, nowMs: now }), longExp, "not a provider limit: untouched");
});

test("task #379: a subagent's own text, thinking or tool call does not clear the main agent's rate-limit backoff (Huaihuai counterexample)", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();
    await emitTurn(driver as never, "quota", [
      { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    const lineage = { subagent: { parentToolUseId: "toolu_sub", subagentType: "general-purpose", phase: "active" } };
    await emitTurn(driver as never, "subagent-output", [
      { kind: "thinking", text: "subagent reasoning", ...lineage },
      { kind: "text", text: "subagent reply", ...lineage },
      { kind: "tool_call", name: "Read", input: { file_path: "/tmp/x" }, ...lineage },
    ]);
    const backoff = getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff;
    assert.equal(backoff.kind, "backing_off", "subagent output may come from a different, unlimited model");
    assert.equal(backoff.attempts, 1);
  });
});

for (const recovery of [
  { kind: "thinking", text: "main model reasoning" },
  { kind: "tool_call", name: "Read", input: { file_path: "/tmp/x" } },
  { kind: "text", text: "main model reply" },
]) {
  test(`task #379: the main model's own ${recovery.kind} after a quota error clears the backoff (control)`, async () => {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      await flush();
      await emitTurn(driver as never, "quota", [
        { kind: "error", message: QUOTA_TEXT_379, providerLimit: { kind: "quota_exhausted" } },
        { kind: "turn_end", sessionId: "session-1" },
      ]);
      await emitTurn(driver as never, `main-${recovery.kind}`, [recovery]);
      assert.equal(getProcess(manager, "agent-1").runtimeErrorDeliveryBackoff.kind, "idle");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task #25: a tool call that never returns kept the agent "busy" with nothing
// to say which command it was on. The heartbeat now reports a call quiet for
// the threshold once per quiet episode, with the tool and the queued count.
// ─────────────────────────────────────────────────────────────────────────────

test("task #25: a tool call with no output for 10 minutes is reported once as stuck, with the tool and the queued messages", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    driver.parsedLines.set("hung-tool", [
      { kind: "tool_call", name: "Bash", input: { command: "pnpm dev" }, callId: "toolu_hung" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("hung-tool\n"));
    await flush();
    await manager.deliverMessage("agent-1", makeMessage("queued behind the command", { message_id: "m-stuck-1", seq: 990 }));
    const stuckEvents = () => traceRows(sink).filter((span) => span.name === "daemon.runtime.tool.stuck");
    const report = () => (manager as any).reportStuckToolCallIfNeeded("agent-1", ap);

    await withNowOffset(9 * 60_000, async () => report());
    assert.equal(stuckEvents().length, 0, "not before the threshold");

    await withNowOffset(10 * 60_000 + 1_000, async () => report());
    await withNowOffset(20 * 60_000, async () => report());
    assert.equal(stuckEvents().length, 1, "once per quiet episode");
    const stuck = stuckEvents()[0]!;
    assert.match(String(stuck.attrs?.tool), /bash/i);
    assert.equal(stuck.attrs?.tool_detail_kind, "running_command");
    assert.equal(stuck.attrs?.queued_messages, ap.inbox.length);
    assert.equal(stuck.attrs?.threshold_ms, 10 * 60_000);
    assert.doesNotMatch(JSON.stringify(stuck), /pnpm dev/, "the command itself is not traced");
    const last = activitySequence(sent).at(-1);
    assert.deepEqual(last, { activity: "working", detail: "Stuck: running command, no output for 10+ min" });
    assert.equal(ap.lastActivityDetail, last?.detail, "the heartbeat keeps sending the stuck detail");
  }, { tracer });
});

test("task #25: a finished tool call or a turn end leaves nothing to report", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    driver.parsedLines.set("tool-done", [
      { kind: "tool_call", name: "Bash", input: { command: "ls" }, callId: "toolu_done" },
      { kind: "tool_output", name: "Bash", callId: "toolu_done" },
    ]);
    driver.parsedLines.set("tool-open-then-turn-end", [
      { kind: "tool_call", name: "Bash", input: { command: "ls" }, callId: "toolu_open" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-done\ntool-open-then-turn-end\n"));
    await flush();

    await withNowOffset(60 * 60_000, async () => (manager as any).reportStuckToolCallIfNeeded("agent-1", ap));

    assert.equal(traceRows(sink).filter((span) => span.name === "daemon.runtime.tool.stuck").length, 0);
  }, { tracer });
});

test("task #25: the working heartbeat runs the stuck-tool check", async () => {
  await withManager(async ({ driver, manager }) => {
    const check = vi.spyOn(manager as any, "reportStuckToolCallIfNeeded");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      driver.parsedLines.set("tool-start-heartbeat", [
        { kind: "tool_call", name: "Bash", input: { command: "sleep 1" }, callId: "toolu_hb" },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start-heartbeat\n"));
      await flush();
      vi.advanceTimersByTime(60_000);
      assert.ok(check.mock.calls.some(([agentId]) => agentId === "agent-1"), "a heartbeat tick checks for a stuck tool");
    } finally {
      vi.useRealTimers();
    }
  });
});

test("task #25: while stuck, every activity frame (heartbeats and probe replies included) carries toolStuck, and the first runtime event drops it", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      const ap = getProcess(manager, "agent-1");
      driver.parsedLines.set("hung-tool-carrier", [
        { kind: "tool_call", name: "Bash", input: { command: "pnpm dev" }, callId: "toolu_carrier" },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from("hung-tool-carrier\n"));
      await flush();
      await manager.deliverMessage("agent-1", makeMessage("queued", { message_id: "m-carrier-1", seq: 995 }));
      const frames = () => activityMessages(sent);
      assert.equal(frames().some((frame) => frame.toolStuck), false, "nothing is stuck before the threshold");

      const startedAtMs = (ap.toolStuck as any).open.values().next().value.startedAtMs as number;
      await withNowOffset(10 * 60_000 + 1_000, async () => {
        vi.advanceTimersByTime(60_000); // heartbeat: reports, then re-sends
        vi.advanceTimersByTime(60_000);
        manager.respondToActivityProbe("agent-1", "probe-1");
      });
      const stuckFrames = frames().filter((frame) => frame.toolStuck);
      assert.ok(stuckFrames.some((frame) => !frame.isHeartbeat && !frame.probeId), "the stuck report frame");
      assert.ok(stuckFrames.some((frame) => frame.isHeartbeat), "heartbeats keep carrying it");
      assert.ok(stuckFrames.some((frame) => frame.probeId === "probe-1"), "probe replies carry it");
      assert.deepEqual(stuckFrames[0]!.toolStuck, {
        toolName: stuckFrames[0]!.toolStuck!.toolName,
        toolDetailKind: "running_command",
        startedAtMs,
        quietSinceMs: startedAtMs,
        thresholdMs: 10 * 60_000,
        queuedMessages: ap.inbox.length,
      });
      assert.match(stuckFrames[0]!.toolStuck!.toolName, /bash/i);

      const before = frames().length;
      driver.parsedLines.set("tool-prints", [{ kind: "text", text: "still going" }]);
      await withNowOffset(10 * 60_000 + 2_000, async () => {
        driver.processes[0].stdout.emit("data", Buffer.from("tool-prints\n"));
        await flush();
        vi.advanceTimersByTime(60_000);
      });
      const after = frames().slice(before);
      assert.ok(after.length > 0, "precondition: frames after the output");
      assert.equal(after.some((frame) => frame.toolStuck), false, "any runtime event ends the stuck state on every later frame");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #25 step 2: a person stops the current turn, not the agent.
// ─────────────────────────────────────────────────────────────────────────────

async function busyOnHungTool(driver: FakeClaudeDriver, manager: any) {
  await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
  const ap = getProcess(manager, "agent-1");
  manager.commitApmIdleState("agent-1", ap, false);
  driver.parsedLines.set("hung-tool-interrupt", [
    { kind: "tool_call", name: "Bash", input: { command: "pnpm dev" }, callId: "toolu_interrupt" },
  ]);
  driver.processes[0].stdout.emit("data", Buffer.from("hung-tool-interrupt\n"));
  await flush();
  return ap;
}

test("task #25 step 2: a native interrupt of a first turn with no open tool kills nothing the runtime started at launch", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    (driver as unknown as { encodeInterruptRequest: () => string }).encodeInterruptRequest = () => "{\"type\":\"interrupt\"}";
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as unknown as { commitApmIdleState: (agentId: string, ap: unknown, idle: boolean) => void }).commitApmIdleState("agent-1", ap, false);
    driver.parsedLines.set("thinking", [{ kind: "thinking", text: "hm" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thinking\n"));
    await flush();

    const pending = manager.interruptTurn("agent-1");
    await flush();
    driver.parsedLines.set("interrupted-turn-end", [{ kind: "turn_end", sessionId: "session-1", interrupted: true }]);
    driver.processes[0].stdout.emit("data", Buffer.from("interrupted-turn-end\n"));
    assert.equal((await pending).outcome, "interrupted");

    // The first turn rides the spawn: its start would also cover MCP servers the runtime launched.
    const treeKill = traceRows(sink).find((span) => span.name === "daemon.agent.turn_interrupt.tree_kill");
    assert.equal(treeKill?.attrs?.skip_reason, "first_turn_without_open_tool");
  }, { tracer });
});

test("task #25 step 2: a native interrupt ends the turn and keeps the process", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    const interruptLine = JSON.stringify({ type: "control_request", request_id: "raft-interrupt-1", request: { subtype: "interrupt" } });
    (driver as unknown as { encodeInterruptRequest: () => string }).encodeInterruptRequest = () => interruptLine;
    const ap = await busyOnHungTool(driver, manager);

    const pending = manager.interruptTurn("agent-1");
    await flush();
    assert.ok(driver.processes[0].stdinWrites.includes(`${interruptLine}\n`), "the interrupt goes to the runtime's stdin");

    driver.parsedLines.set("interrupted-turn-end", [{ kind: "turn_end", sessionId: "session-1", interrupted: true }]);
    driver.processes[0].stdout.emit("data", Buffer.from("interrupted-turn-end\n"));
    const result = await pending;

    assert.equal(result.outcome, "interrupted");
    assert.match(String(result.toolName), /bash/i);
    assert.equal(getProcess(manager, "agent-1"), ap, "the same process keeps running");
    assert.equal(driver.processes.length, 1, "nothing was restarted");
    const event = traceRows(sink).find((span) => span.name === "daemon.agent.turn_interrupt");
    assert.equal(event?.attrs?.outcome, "interrupted");
    assert.equal(event?.attrs?.method, "native");
    const treeKill = traceRows(sink).find((span) => span.name === "daemon.agent.turn_interrupt.tree_kill");
    assert.equal(treeKill?.attrs?.method, "native", "what the turn started is cleaned up after a native interrupt too");
    assert.equal(treeKill?.attrs?.skip_reason, undefined, "the open tool dates what this first turn started");
    assert.doesNotMatch(JSON.stringify(traceRows(sink)), /pnpm dev/);
  }, { tracer });
});

test("task #25 step 2: a runtime without a native interrupt is restarted and resumes its session for the queued message", async () => {
  onTestFinished(installManagedRunnerCredentialFetch());
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    const ap = await busyOnHungTool(driver, manager);
    await manager.deliverMessage("agent-1", makeMessage("waiting behind the command", { message_id: "m-interrupt-1", seq: 1001 }));
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const proc = driver.processes[0];
    const originalKill = proc.kill.bind(proc);
    proc.kill = (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return originalKill(signal);
    };

    const result = await manager.interruptTurn("agent-1");

    assert.equal(result.outcome, "restarted");
    assert.deepEqual(killSignals, ["SIGTERM"]);
    assert.equal(ap.gatedSteering.expectedTerminationReason, "turn_interrupt");
    await waitFor(() => driver.spawnCalls.length === 2, "the runtime restarts for the queued message");
    assert.equal(driver.spawnCalls[1]!.config.sessionId, "session-1", "and resumes the same session");
    assert.equal(traceRows(sink).find((span) => span.name === "daemon.agent.turn_interrupt")?.attrs?.outcome, "restarted");
    assert.equal(
      traceRows(sink).some((span) => span.name === "daemon.runtime.process.exit" && span.attrs?.outcome === "process-crash"),
      false,
      "the interrupt is not a crash",
    );
  }, { tracer });
});

test("task #25 step 2: with no turn running there is nothing to stop", async () => {
  await withManager(async ({ manager }) => {
    assert.deepEqual(await manager.interruptTurn("agent-missing"), { outcome: "not_running" });
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    assert.deepEqual(await manager.interruptTurn("agent-1"), { outcome: "not_running" });
  });
});

test("task #25 step 2: a native interrupt that does not end the turn in time falls back to the restart", async () => {
  onTestFinished(installManagedRunnerCredentialFetch());
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withManager(async ({ driver, manager }) => {
    (driver as unknown as { encodeInterruptRequest: () => string }).encodeInterruptRequest = () => "{\"type\":\"control_request\"}";
    const ap = await busyOnHungTool(driver, manager);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let result: Awaited<ReturnType<typeof manager.interruptTurn>>;
    try {
      const pending = manager.interruptTurn("agent-1");
      await vi.advanceTimersByTimeAsync(10_000);
      result = await pending;
    } finally {
      vi.useRealTimers();
    }

    assert.equal(result.outcome, "restarted");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "turn_interrupt");
    assert.equal(traceRows(sink).find((span) => span.name === "daemon.agent.turn_interrupt.native_fallback")?.attrs?.reason, "turn_did_not_end");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #26: the onboarding owner-facts context ("onboarding-context" is a
// label, not a channel) became an inbox row whose `open:` command could not
// resolve and that never cleared. The daemon holds it and writes it as its
// body ahead of the next input each runtime process gets.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_FACTS = "Onboarding context for this server (re-sent on every start; not a message to reply to):\nowner_name=Ada";

function ownerFactsMessage(content = OWNER_FACTS): AgentMessage {
  return makeMessage(content, {
    channel_id: "onboarding-context",
    channel_name: "onboarding-context",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    seq: 0,
    message_id: "onboarding-owner-facts-server-1",
  });
}

test("task #26: a running agent gets the owner facts ahead of its next input, once, with no inbox row and no turn of their own", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);

    assert.equal(await manager.deliverMessage("agent-1", ownerFactsMessage()), true);
    await flush();
    assert.equal(driver.encodedCalls.length, 0, "context alone starts no turn");
    assert.deepEqual((manager as any).allPendingVisibleMessages("agent-1"), [], "and leaves no inbox row to open");

    await manager.deliverMessage("agent-1", makeMessage("hi Cindy", { message_id: "m-1", seq: 7 }));
    await waitFor(() => driver.encodedCalls.length === 1, "the message is written");
    const first = driver.encodedCalls[0]!.text;
    assert.ok(first.startsWith(OWNER_FACTS), "the facts ride ahead of the message");
    assert.match(first, /hi Cindy/);
    assert.doesNotMatch(first, /#onboarding-context|msg=onboardi/, "as their body, not as a message to open");

    // A re-send on reconnect does not repeat them into the same session.
    await manager.deliverMessage("agent-1", ownerFactsMessage());
    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-1\n"));
    await waitFor(() => (manager as any).isApmIdle(ap), "turn ends");
    await manager.deliverMessage("agent-1", makeMessage("one more", { message_id: "m-2", seq: 8 }));
    await waitFor(() => driver.encodedCalls.length === 2, "the second message is written");
    assert.doesNotMatch(driver.encodedCalls[1]!.text, /owner_name=Ada/);
  });
});

test("task #26: the owner facts never wake or start an agent; its next start carries them in the first prompt", async () => {
  await withManager(async ({ driver, manager }) => {
    assert.equal(await manager.deliverMessage("agent-1", ownerFactsMessage()), true);
    await flush();
    assert.equal(driver.spawnCalls.length, 0, "no start for context alone");

    await manager.startAgent("agent-1", makeConfig(), makeMessage("hello", { message_id: "m-wake", seq: 3 }));
    assert.equal(driver.spawnCalls.length, 1);
    const prompt = String(driver.spawnCalls[0]!.prompt);
    assert.ok(prompt.startsWith(OWNER_FACTS), "the first prompt opens with the facts");
    assert.equal(prompt.split("owner_name=Ada").length - 1, 1, "once");
    assert.doesNotMatch(prompt, /#onboarding-context/);
  });
});

test("task #26: a server start woken by the owner facts holds them and starts without a wake message", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), ownerFactsMessage());
    assert.equal(driver.spawnCalls.length, 1);
    const prompt = String(driver.spawnCalls[0]!.prompt);
    assert.ok(prompt.startsWith(OWNER_FACTS), "the facts ride the first prompt");
    assert.doesNotMatch(prompt, /#onboarding-context/, "no row naming the label");
    assert.deepEqual((manager as any).allPendingVisibleMessages("agent-1"), [], "and none left to open");
  });
});

test("task #26: a fresh start's session counts as having the facts only once the runtime reports it", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.deliverMessage("agent-1", ownerFactsMessage());
    await manager.startAgent("agent-1", makeConfig());
    assert.ok(String(driver.spawnCalls[0]!.prompt).startsWith(OWNER_FACTS));
    const ap = getProcess(manager, "agent-1");
    const ledger = (manager as any).serverContext;
    assert.ok(ledger.pending("agent-1", { processInstanceId: "a-later-process", sessionId: "session-new" }) !== null, "not yet: the session is unknown");

    driver.parsedLines.set("turn-end-new", [{ kind: "turn_end", sessionId: "session-new" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-new\n"));
    await waitFor(() => ap.sessionId === "session-new", "the runtime reports its session");
    assert.equal(driver.encodedCalls.length, 0, "no later write taught it the session");
    assert.equal(ledger.pending("agent-1", { processInstanceId: "a-later-process", sessionId: "session-new" }), null, "a resume of that session has them");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent typing line (shared agentTyping.ts): `agent:send_intent` frames from
// the driver's early `send_intent` event or the complete tool call, ended by
// the call's output, the turn end or the process stop; only to a server that
// advertised the capability.
// ─────────────────────────────────────────────────────────────────────────────

function sendIntentFrames(sent: MachineToServerMessage[]) {
  return sent
    .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:send_intent" }> => msg.type === "agent:send_intent")
    .map(({ callId, phase, target, early }) => ({ callId, phase, ...(target ? { target } : {}), ...(early !== undefined ? { early } : {}) }));
}

const TYPING_SEND_COMMAND = "raft message send --target '#general' <<'EOF'\nhello\nEOF";

test("agent typing line: early intent, no duplicate from the tool_call, end on its output; late intent ends on turn end", async () => {
  await withManager(async ({ manager, driver, sent }) => {
    manager.setServerSendIntentCapable(true);
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const ap = getProcess(manager, "agent-1");
    const emit = async (line: string, events: ParsedEvent[]) => {
      driver.parsedLines.set(line, events);
      driver.processes[0].stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    };
    await emit("typing-early", [{ kind: "send_intent", callId: "toolu_1", target: "#general", early: true }]);
    const first = sent.find((msg) => msg.type === "agent:send_intent");
    assert.equal((first as { launchId?: string } | undefined)?.launchId, ap.launchId || undefined);
    await emit("typing-call", [{ kind: "tool_call", name: "Bash", input: { command: TYPING_SEND_COMMAND }, callId: "toolu_1" }]);
    await emit("typing-sub-output", [{ kind: "tool_output", name: "Bash", subagent: { parentToolUseId: "toolu_x", phase: "active" } }]);
    await emit("typing-output", [{ kind: "tool_output", name: "Bash", callId: "toolu_1", ok: true }]);
    await emit("typing-late", [{ kind: "tool_call", name: "Bash", input: { command: TYPING_SEND_COMMAND }, callId: "toolu_2" }]);
    await emit("typing-sub-call", [{ kind: "tool_call", name: "Bash", input: { command: TYPING_SEND_COMMAND }, callId: "toolu_3", subagent: { parentToolUseId: "toolu_x", phase: "active" } }]);
    await emit("typing-turn-end", [{ kind: "turn_end", sessionId: "s1" }]);
    assert.deepEqual(sendIntentFrames(sent), [
      { callId: "toolu_1", phase: "start", target: "#general", early: true },
      { callId: "toolu_1", phase: "end" },
      { callId: "toolu_2", phase: "start", target: "#general", early: false },
      { callId: "toolu_2", phase: "end" },
    ]);
  });
});

test("agent typing line: stopping the agent ends a live intent; no frames without the capability", async () => {
  await withManager(async ({ manager, driver, sent }) => {
    manager.setServerSendIntentCapable(true);
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    driver.parsedLines.set("typing-early", [{ kind: "send_intent", callId: "toolu_1", target: "dm:@sam", early: true }]);
    driver.processes[0].stdout.emit("data", Buffer.from("typing-early\n"));
    await flush();
    await manager.stopAgent("agent-1", { wait: true, silent: true });
    assert.deepEqual(sendIntentFrames(sent), [
      { callId: "toolu_1", phase: "start", target: "dm:@sam", early: true },
      { callId: "toolu_1", phase: "end" },
    ]);
  });

  await withManager(async ({ manager, driver, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    driver.parsedLines.set("typing", [
      { kind: "send_intent", callId: "toolu_1", target: "#general", early: true },
      { kind: "tool_call", name: "Bash", input: { command: TYPING_SEND_COMMAND }, callId: "toolu_2" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("typing\n"));
    await flush();
    assert.deepEqual(sendIntentFrames(sent), []);
  });
});

test("Claude root refusal is visible on the actual crash activity without exposing other stderr", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = [
      "private diagnostic context",
      "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
    ];
    driver.processes[0].emit("exit", 1, null);
    driver.processes[0].emit("close", 1, null);
    await flush();
    const crash = sent.filter((m) => m.type === "agent:activity" && m.detailKind === "claude_root_privileges").at(-1);
    assert.ok(crash && crash.type === "agent:activity");
    assert.equal(crash.runtimeError?.errorReason, "root_privileges");
    assert.equal(crash.runtimeError?.errorClass, "RootPrivilegesError");
    assert.match(crash.detail ?? "", /Run Raft Computer as a non-root user/);
    assert.ok(!JSON.stringify(crash).includes("private diagnostic context"));
    assert.equal(driver.processes.length, 1, "diagnostic must not add a restart");
  });
});

test("Claude root stderr cannot turn a clean exit into an actionable crash", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = getProcess(manager, "agent-1");
    (manager as any).commitApmIdleState("agent-1", ap, true);
    ap.recentStderr = ["--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"];
    driver.processes[0].emit("exit", 0, null);
    driver.processes[0].emit("close", 0, null);
    await flush();
    assert.ok(!sent.some((m) => m.type === "agent:activity" && m.detail?.includes("non-root user")));
  });
});

test("Claude root detailKind alone projects offline, not working", () => {
  const result = reduceAgentActivityProjection(createInitialApmDecisionState(), {
    transitionSeq: 1, scenario: "root-refusal", correlationId: "root-refusal", inputId: "input-1", inputKind: "ParsedEvent", inputSummary: "crash",
    message: { type: "agent:activity", agentId: "agent-1", detail: "Changed display text", detailKind: "claude_root_privileges" },
  });
  assert.equal(result.snapshotEntry.activityKind, "offline");
});

// task #1362: a compaction started after the run's end (compaction_started.afterRunEnd)
// releases what waited only once both its own end and the turn end are in.
describe("task #1362: compaction after the run end", () => {
  async function heldCompaction(fn: (ctx: { driver: FakeClaudeDriver; manager: AgentProcessManager; emit: (...lines: string[]) => Promise<void> }) => Promise<void>) {
    await withManager(async ({ driver, manager }) => {
      (driver as any).acceptsStdinDuringCompaction = false;
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
      driver.parsedLines.set("end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.parsedLines.set("start-1", [{ kind: "compaction_started", cycleId: 1, afterRunEnd: true }]);
      driver.parsedLines.set("finish-1", [{ kind: "compaction_finished", cycleId: 1 }]);
      driver.parsedLines.set("finish-2", [{ kind: "compaction_finished", cycleId: 2 }]);
      driver.parsedLines.set("aborted-1", [{ kind: "compaction_interrupted", cycleId: 1, outcome: "aborted", reason: "manual" }]);
      driver.parsedLines.set("output", [{ kind: "text", text: "retried run output" }]);
      const emit = async (...lines: string[]) => {
        driver.processes[0].stdout.emit("data", Buffer.from(lines.map((line) => `${line}\n`).join("")));
        await flush();
      };
      await fn({ driver, manager, emit });
    });
  }

  test("finish first: another cycle's finish, a repeated finish and turn output release nothing; the turn end delivers once, idle", async () => {
    await heldCompaction(async ({ driver, manager, emit }) => {
      await emit("start-1");
      manager.deliverMessage("agent-1", makeMessage("arrives while compacting"));
      await flush();
      const before = driver.encodedCalls.length;
      await emit("finish-2");
      await emit("finish-1");
      await emit("finish-1");
      await emit("output");
      assert.equal(driver.encodedCalls.length, before, "nothing goes before the turn end");
      assert.equal(getProcess(manager, "agent-1").gatedSteering.compacting, true, "the gate stays shut");
      await emit("end");
      await waitFor(() => driver.encodedCalls.length > before, "the delivery at the turn end");
      assert.deepEqual(driver.encodedCalls.slice(before).map((call) => call.mode), ["idle"]);
      assert.equal(getProcess(manager, "agent-1").compactionAfterRunEnd, undefined);
    });
  });

  test("turn end first: nothing goes and the agent is not idle until the compaction's own finish, which delivers once, idle", async () => {
    await heldCompaction(async ({ driver, manager, emit }) => {
      await emit("start-1");
      manager.deliverMessage("agent-1", makeMessage("arrives while compacting"));
      await flush();
      const before = driver.encodedCalls.length;
      await emit("end");
      assert.equal(driver.encodedCalls.length, before, "the turn end does not deliver into a running compaction");
      assert.equal(getProcess(manager, "agent-1").gatedSteering.isIdle, false);
      manager.deliverMessage("agent-1", makeMessage("arrives after the turn end"));
      await flush();
      await emit("finish-2");
      assert.equal(driver.encodedCalls.length, before, "another cycle's finish does not release");
      await emit("finish-1");
      await waitFor(() => driver.encodedCalls.length > before, "the delivery at the finish");
      assert.deepEqual(driver.encodedCalls.slice(before).map((call) => call.mode), ["idle"]);
      await emit("finish-1");
      assert.equal(driver.encodedCalls.length, before + 1, "a repeated finish delivers nothing more");
    });
  });

  test("an interruption ends the held compaction like a finish: released by the turn end", async () => {
    await heldCompaction(async ({ driver, manager, emit }) => {
      await emit("start-1");
      manager.deliverMessage("agent-1", makeMessage("arrives while compacting"));
      await flush();
      const before = driver.encodedCalls.length;
      await emit("aborted-1");
      assert.equal(driver.encodedCalls.length, before, "an interruption alone does not release before the turn end");
      await emit("end");
      await waitFor(() => driver.encodedCalls.length > before, "the delivery at the turn end");
      assert.deepEqual(driver.encodedCalls.slice(before).map((call) => call.mode), ["idle"]);
    });
  });

  /** Reconcile keeps the process (returns false); count the session rotation checks. */
  function countRotationChecks(manager: AgentProcessManager): () => number {
    let rotations = 0;
    (manager as any).reconcile = () => false;
    (manager as any).rotateRuntimeSessionIfDue = () => { rotations += 1; };
    return () => rotations;
  }

  test("turn end first, nothing queued: the rotation check the turn end left goes at the compaction's finish, once", async () => {
    await heldCompaction(async ({ manager, emit }) => {
      const rotations = countRotationChecks(manager);
      await emit("start-1", "end");
      assert.equal(rotations(), 0, "no rotation while the session still compacts");
      await emit("finish-1");
      assert.equal(rotations(), 1);
      await emit("finish-1");
      assert.equal(rotations(), 1, "a repeated finish checks nothing more");
    });
  });

  test("turn end first, a message queued: its delivery starts a new turn, so the finish starts no rotation", async () => {
    await heldCompaction(async ({ driver, manager, emit }) => {
      const rotations = countRotationChecks(manager);
      await emit("start-1");
      manager.deliverMessage("agent-1", makeMessage("arrives while compacting"));
      await flush();
      const before = driver.encodedCalls.length;
      await emit("end", "finish-1");
      await waitFor(() => driver.encodedCalls.length > before, "the delivery at the finish");
      assert.equal(rotations(), 0);
    });
  });

  test("finish first: the turn end runs its own rotation check, once", async () => {
    await heldCompaction(async ({ manager, emit }) => {
      const rotations = countRotationChecks(manager);
      await emit("start-1", "finish-1");
      assert.equal(rotations(), 0);
      await emit("end");
      assert.equal(rotations(), 1);
    });
  });

  test("with nothing queued, both ends leave the agent idle, and the next message is an idle delivery", async () => {
    await heldCompaction(async ({ driver, manager, emit }) => {
      await emit("start-1", "end", "finish-1");
      assert.equal(getProcess(manager, "agent-1").gatedSteering.isIdle, true);
      assert.equal(getProcess(manager, "agent-1").gatedSteering.compacting, false);
      const before = driver.encodedCalls.length;
      manager.deliverMessage("agent-1", makeMessage("next message"));
      await waitFor(() => driver.encodedCalls.length > before, "the next delivery");
      assert.deepEqual(driver.encodedCalls.slice(before).map((call) => call.mode), ["idle"]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RFC 081 D3/D16: the notice written into a running turn (busy) is the same
// text as the notice that starts a turn (idle): the same header, item rows and
// footer, through the one wake-up formatter. Pinned for a conversation item,
// an app item and a reminder (with its `ack:` line); with inbox items off the
// app Inbox notice stays the count notice.
// ─────────────────────────────────────────────────────────────────────────────

const PARITY_REMINDER_ID = "1598ee1a-81c7-4aba-a76b-c75aab407097";

const PARITY_INBOX_REGISTRY = {
  ...REMINDER_AGENT_INBOX_REGISTRY,
  ...createSystemCleanerAppRegistry(() => ({ thresholdBytes: 1024, maximumThresholdBytes: 4096 })),
};

async function noticeTextFor(
  mode: "idle" | "busy",
  deliver: (manager: AgentProcessManager, store: AgentAppInboxStore) => Promise<void>,
  config: Partial<AgentConfig> = { inboxItems: true },
): Promise<string> {
  const store = createAgentAppInboxStore({ registry: PARITY_INBOX_REGISTRY });
  let text = "";
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", ...config }));
    const ap = getProcess(manager, "agent-1");
    ap.sessionId = "s1";
    (manager as any).commitApmIdleState("agent-1", ap, mode === "idle");
    const before = driver.encodedCalls.length;
    await deliver(manager, store);
    if (mode === "busy" && driver.encodedCalls.length === before) {
      assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    }
    const written = driver.encodedCalls.slice(before);
    assert.equal(written.length, 1, `one ${mode} notice`);
    assert.equal(written[0]!.mode, mode);
    text = written[0]!.text;
  }, { appInboxForAgent: () => store });
  return text;
}

function deliverMessageOnce(message: AgentMessage) {
  return async (manager: AgentProcessManager) => {
    assert.equal(await manager.deliverMessage("agent-1", message), true);
  };
}

async function notifyReminderOnce(manager: AgentProcessManager, store: AgentAppInboxStore): Promise<void> {
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: PARITY_REMINDER_ID, revision: "1" },
    title: "查看「今日待办」页面有没有新评论",
    summary: "Reminder due",
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(await manager.notifyAgentAppInbox("agent-1", minted.item), true);
}

test("RFC 081 inbox items: a conversation item's mid-turn notice is the between-turn notice", async () => {
  const message = makeMessage("can you look at this?", { message_id: "11111111-2222-4333-8444-555555555555", seq: 7 });
  const idle = await noticeTextFor("idle", deliverMessageOnce(message));
  const busy = await noticeTextFor("busy", deliverMessageOnce(message));
  assert.equal(busy, idle);
  assert.match(idle, /^\[Raft inbox notice:\nInbox update: 1 message pending/);
  assert.match(idle, /\n#general · 1 unread/);
  assert.match(idle, /\n {2}read: raft inbox read --target "#general"\n/);
});

test("RFC 081 inbox items: an app item's (app:<key>/<ref>) mid-turn notice is the between-turn notice", async () => {
  const message = exampleThirdPartyEvent(201, "app:stamp/pr-13754");
  const idle = await noticeTextFor("idle", deliverMessageOnce(message));
  const busy = await noticeTextFor("busy", deliverMessageOnce(message));
  assert.equal(busy, idle);
  assert.match(idle, /\napp:stamp\/pr-13754 · 1 unread · from Stamp/);
  assert.match(idle, /\n {2}read: raft inbox read --target "app:stamp\/pr-13754"\n/);
});

// RFC 081 D9: the host reads when inbox items launched from the config whose
// `inboxItems` it reads (AgentConfig.inboxItemsLaunchAt). A reminder fired at
// or after it is its `reminder:` row with its `ack:` line; one fired before
// it, or any reminder while the launch time is unknown, is in the daemon
// section, never a `reminder:` row its read could not find.
const PARITY_REMINDER_ROW_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "reminder:1598ee1a · 1 fired, not acked · latest just now",
  "  \"查看「今日待办」页面有没有新评论\" (preview)",
  "  read: raft inbox read --target \"reminder:1598ee1a\"",
  `  ack: raft reminder ack --id ${PARITY_REMINDER_ID} --revision 1`,
  "]",
].join("\n");

const PARITY_REMINDER_DAEMON_SECTION_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "",
  "App items: 1",
  "",
  `app=system.reminder · class=due · item=reminder · retention=until_explicit_ack · sourceRef=reminder:${PARITY_REMINDER_ID}:1 · action=raft reminder ack --id 1598ee1a --revision 1 · title=查看「今日待办」页面有没有新评论 · summary=Reminder due`,
  "]",
].join("\n");

test("RFC 081 inbox items: a reminder fired after the Server's inbox-items launch time is its reminder: row, mid-turn as between-turn", async () => {
  const config = { inboxItems: true, inboxItemsLaunchAt: "2026-01-01T00:00:00.000Z" };
  const idle = await noticeTextFor("idle", notifyReminderOnce, config);
  const busy = await noticeTextFor("busy", notifyReminderOnce, config);
  assert.equal(busy, idle);
  assert.equal(idle, PARITY_REMINDER_ROW_NOTICE);
});

test("RFC 081 inbox items: a reminder fired before the Server's inbox-items launch time is in the daemon section, mid-turn as between-turn", async () => {
  const config = { inboxItems: true, inboxItemsLaunchAt: "2999-01-01T00:00:00.000Z" };
  const idle = await noticeTextFor("idle", notifyReminderOnce, config);
  const busy = await noticeTextFor("busy", notifyReminderOnce, config);
  assert.equal(busy, idle);
  assert.equal(idle, PARITY_REMINDER_DAEMON_SECTION_NOTICE);
});

// A busy agent takes a server:features answer at once (its stop waits for the
// turn end), so a notice written into that turn reads the refreshed launch time.
test("RFC 081 inbox items: a server:features refresh's launch time reaches the mid-turn notice", async () => {
  const busy = await noticeTextFor("busy", async (manager, store) => {
    manager.applyServerFeatures({ inboxItems: true, inboxItemsLaunchAt: "2026-01-01T00:00:00.000Z" });
    await notifyReminderOnce(manager, store);
  }, { inboxItems: true, inboxItemsLaunchAt: "2999-01-01T00:00:00.000Z" });
  assert.equal(busy, PARITY_REMINDER_ROW_NOTICE);
});

test("RFC 081 inbox items: a reminder's mid-turn notice is the between-turn notice, in the daemon section while the launch time is unknown", async () => {
  const idle = await noticeTextFor("idle", notifyReminderOnce);
  const busy = await noticeTextFor("busy", notifyReminderOnce);
  assert.equal(busy, idle);
  assert.equal(idle, PARITY_REMINDER_DAEMON_SECTION_NOTICE);
});

test("RFC 081 inbox items off: the app Inbox notice stays the count notice, idle and busy", async () => {
  const legacy = "[Raft Inbox notice:\nApp items pending: 1\nRun `raft inbox check` to inspect them.]";
  assert.equal(await noticeTextFor("idle", notifyReminderOnce, {}), legacy);
  assert.equal(await noticeTextFor("busy", notifyReminderOnce, {}), legacy);
});

test("RFC 081 inbox items: a mixed batch (a reminder and a local-only cleaner item) mid-turn is the between-turn notice, as inbox check's daemon section prints them", async () => {
  let pending: readonly AgentInboxAppItem[] = [];
  const notifyMixed = async (manager: AgentProcessManager, store: AgentAppInboxStore) => {
    const reminder = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: PARITY_REMINDER_ID, revision: "1" },
      title: "查看「今日待办」页面有没有新评论",
    });
    const cleaner = store.mint({
      appId: "system.cleaner",
      notificationClass: "disk_space_hint",
      sourceRef: { kind: "disk_hint", agentId: "agent-1" },
      title: "Disk is low",
    });
    assert.equal(reminder.ok && cleaner.ok, true);
    if (!reminder.ok || !cleaner.ok) return;
    pending = store.list();
    assert.equal(await manager.notifyAgentAppInbox("agent-1", cleaner.item), true);
  };
  const idle = await noticeTextFor("idle", notifyMixed);
  const busy = await noticeTextFor("busy", notifyMixed);
  assert.equal(busy, idle);
  // Launch time unknown: both are what `inbox check` prints in its daemon section (shared formatAgentInboxAppItems).
  const localSection = formatAgentInboxAppItems(pending);
  assert.match(localSection, /^App items: 2\n\n/);
  assert.match(localSection, /app=system\.reminder · class=due/);
  assert.match(localSection, /app=system\.cleaner · class=disk_space_hint/);
  assert.equal(idle, [
    "[Raft inbox notice:",
    "Inbox update: 2 messages pending your read across all conversations; 2 changed targets",
    "",
    localSection,
    "]",
  ].join("\n"));
});

test("RFC 081 inbox items: in the notice a local-only cleaner item's row is followed by its dismiss command; a reminder's is not", async () => {
  let cleanerItemId = "";
  const notice = await noticeTextFor("idle", async (manager, store) => {
    const reminder = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: PARITY_REMINDER_ID, revision: "1" },
    });
    const cleaner = store.mint({
      appId: "system.cleaner",
      notificationClass: "disk_space_hint",
      sourceRef: { kind: "backup_ignore_hint", agentId: "agent-1" },
      title: "Review .raftbackupignore",
    });
    assert.equal(reminder.ok && cleaner.ok, true);
    if (!reminder.ok || !cleaner.ok) return;
    cleanerItemId = cleaner.item.itemId;
    assert.equal(await manager.notifyAgentAppInbox("agent-1", cleaner.item), true);
  });
  const lines = notice.split("\n");
  const cleanerRow = lines.findIndex((line) => line.startsWith("app=system.cleaner · class=disk_space_hint · "));
  assert.ok(cleanerRow >= 0, notice);
  assert.equal(lines[cleanerRow + 1], `  dismiss: raft inbox dismiss --target "app:system.cleaner/${cleanerItemId.slice(0, 8)}"`);
  assert.equal(lines.filter((line) => line.startsWith("  dismiss: ")).length, 1, "the reminder is acked, never dismissed");
});

// A Computer-local item's id is stable per (app, class, source): a reminder
// the Cleaner mints again after its item was dismissed or withdrawn has the id
// of the one before. The notice memo keeps the item's createdAtMs beside its
// id (appInboxItemNoticed), so the one that came back is announced, in whatever
// order the removal, the mint and the host's reads of the store came. An item
// still pending is not announced twice, also when it is updated in place.
test("app Inbox notice: an item removed and minted again is announced again, also when both happen between two reads of the store; a pending item is not announced twice", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  // Every mint is a minute after the one before, as the Cleaner's are hours apart.
  let now = Date.parse("2026-11-12T08:00:00.000Z");
  const store = createAgentAppInboxStore({ registry: PARITY_INBOX_REGISTRY, nowMs: () => now });
  const mint = (summary: string) => {
    now += 60_000;
    const minted = store.mint({
      appId: "system.cleaner",
      notificationClass: "disk_space_hint",
      sourceRef: { kind: "backup_ignore_hint", agentId: "agent-1" },
      title: "Review .raftbackupignore",
      summary,
    });
    if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
    return minted.item;
  };
  const outcomes = () => traceRows(sink)
    .filter((span) => span.name === "daemon.agent.app_inbox_notice")
    .map((span) => span.attrs?.outcome);
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1", inboxItems: true }));
    const ap = getProcess(manager, "agent-1");
    ap.sessionId = "s1";
    const notices = () => driver.encodedCalls.filter((call) => call.text.startsWith("[Raft inbox notice:"));
    const goIdle = () => (manager as any).commitApmIdleState("agent-1", ap, true);

    goIdle();
    const first = mint("first");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", first), true);
    assert.equal(notices().length, 1);

    // Still pending, and minted again as the same identity (an update): no second notice,
    // from the app's own wake or from the idle drain.
    goIdle();
    const updated = mint("updated");
    assert.equal(updated.itemId, first.itemId);
    assert.equal(await manager.notifyAgentAppInbox("agent-1", updated), true);
    goIdle();
    await flush();
    assert.equal(notices().length, 1, "one notice for an item that is still there");
    assert.equal(outcomes().at(-1), "already_delivered");

    // Dismissed, then minted again before the host read the store in between.
    assert.equal(store.dismiss(first.itemId), true);
    const again = mint("again");
    assert.equal(again.itemId, first.itemId, "the same id as the item before");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", again), true);
    assert.equal(notices().length, 2, "the item that came back is announced");
    assert.equal(outcomes().at(-1), "written");
    assert.match(notices()[1]!.text, /summary=again/);

    // Withdrawn by its app (an ack) and minted again with no wake of its own: the next idle drain offers it.
    assert.equal(store.ack(first.itemId), true);
    mint("third");
    goIdle();
    await waitFor(() => notices().length === 3, "the idle drain's notice");
    assert.match(notices()[2]!.text, /summary=third/);

    goIdle();
    await flush();
    assert.equal(notices().length, 3, "and once only");
  }, { tracer, appInboxForAgent: () => store });
});
