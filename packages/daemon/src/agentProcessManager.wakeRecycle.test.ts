// RFC 070 phase 1 behavior baseline: at-wake session recycling.
//
// Named protected object (invariant): a cold wake (>1h since last transcript
// activity) whose prior Claude session context exceeds the recycle threshold
// starts WITHOUT `--resume` (spawn config sessionId is null) and its first
// runtime input opens with the reconstructed wake briefing, while warm or
// disabled wakes resume the prior session unchanged.
//
// RED proof: revert the wakeRecycle hook in startAgentNow (or force
// `planWakeSessionRecycle` to always resume) and the first test fails with
// spawn config sessionId "session-recycle-1" !== null; restoring the hook
// returns it to green. Helpers are slimmed copies per this repo's APM test
// convention (see agentProcessManager.claude.test.ts header).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { installManagedRunnerCredentialFetch } from "./testing/managedRunnerCredentialFetch";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import type { ProcessTreeEntry } from "./drivers/processTree";
import type { SessionResumeFacts } from "./wakeSessionRecycle";
import { drainAgentManagerForTests, releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { takeRecordedNetworkAttempts } from "./testing/networkGuard";

class FakeChildProcess extends EventEmitter {
  readonly pid = RUNTIME_PID;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  killed = false;

  kill(): boolean {
    this.killed = true;
    // SIGTERM, as the daemon sends: node reports code 143 with the signal.
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess();
    this.processes.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) ?? [];
  }

  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
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

async function writeSessionTranscript(
  homeDir: string,
  sessionId: string,
  args: { lastActivityAtMs: number; contextTokens: number },
): Promise<void> {
  const projectDir = path.join(homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(projectDir, { recursive: true });
  const record = {
    type: "assistant",
    timestamp: new Date(args.lastActivityAtMs).toISOString(),
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: args.contextTokens - 12,
        cache_creation_input_tokens: 0,
      },
    },
  };
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify(record) + "\n");
}

type ManagerCtx = {
  driver: FakeClaudeDriver;
  manager: AgentProcessManager;
  dataDir: string;
  sent: MachineToServerMessage[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
};

async function withManager(
  fn: (ctx: ManagerCtx) => Promise<void>,
  opts: Pick<NonNullable<ConstructorParameters<typeof AgentProcessManager>[2]>, "readSessionResumeFacts" | "readRuntimeDescendants" | "detectedRuntimeCliVersion"> = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-wake-recycle-test-"));
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
      // The Claude Code the daemon detected: past the cold-idle version floor.
      detectedRuntimeCliVersion: () => "2.1.304 (Claude Code)",
      ...opts,
    },
  );
  const events: ManagerCtx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, dataDir, sent, events });
  } finally {
    (manager as any).frozenClockMs = null;
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const RUNTIME_PID = 4242;

test("cold wake with large prior context spawns fresh with the wake briefing", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-recycle-1";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-recycle",
      makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }),
      undefined,
      { "#general": 3 },
    );

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, null, "recycled start must not resume the prior session");
    assert.match(spawn.prompt, /^<memory-index|^<recent-messages|^<objects-in-play|^<recent-actions/); // first input opens directly with a context block
    assert.doesNotMatch(spawn.prompt, /retired|fresh session|~\d+k tokens/); // v2: no announcement, no stats
    // The resume-shaped ladder still delivers the unread summary after the briefing.
    assert.match(spawn.prompt, /#general: 3 unread/);
  });
});


test("fresh start injects the MEMORY.md block by default", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const agentDir = path.join(dataDir, "agent-fresh-mem");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "MEMORY.md"), "# Memory marker seven\n- durable fact\n");
    await manager.startAgent("agent-fresh-mem", makeConfig({ sessionId: null }));

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.match(spawn.prompt, /<memory-index file="MEMORY\.md"/);
    assert.match(spawn.prompt, /Memory marker seven/);
  });
});

test("warm wake resumes the prior session without a briefing", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-warm-1";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 10 * 60_000,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-warm",
      makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }),
    );

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, sessionId);
    assert.doesNotMatch(spawn.prompt, /wake briefing/);
  });
});

test("recycle stays inert when the kill switch is set", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-flag-off";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent("agent-flag-off", makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "0" } }));

    assert.equal(driver.spawnCalls.length, 1);
    const spawn = driver.spawnCalls[0]!;
    assert.equal(spawn.config.sessionId, sessionId);
    assert.doesNotMatch(spawn.prompt, /wake briefing/);
  });
});

test("the retired constructedWakeContext field is ignored: absent or false, a cold wake still recycles and a fresh start still gets the MEMORY.md block", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "session-field-ignored";
    await writeSessionTranscript(dataDir, sessionId, {
      lastActivityAtMs: Date.now() - 3 * HOUR_MS,
      contextTokens: 500_000,
    });
    await manager.startAgent(
      "agent-field-absent",
      makeConfig({ sessionId, constructedWakeContext: undefined, envVars: null }),
    );
    const agentDir = path.join(dataDir, "agent-field-false-fresh");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "MEMORY.md"), "# Memory marker nine\n- durable fact\n");
    await manager.startAgent(
      "agent-field-false-fresh",
      makeConfig({ sessionId: null, constructedWakeContext: false, envVars: null }),
    );

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[0]!.config.sessionId, null, "field absent: the cold wake still recycles");
    assert.match(driver.spawnCalls[1]!.prompt, /<memory-index file="MEMORY\.md"/);
    assert.match(driver.spawnCalls[1]!.prompt, /Memory marker nine/, "field false: the startup memory block is still injected");
  });
});

test("RAFT_STARTUP_MEMORY_BLOCK=0 keeps the MEMORY.md block out of a fresh start", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const agentDir = path.join(dataDir, "agent-fresh-mem-off");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "MEMORY.md"), "# Memory marker ten\n- durable fact\n");
    await manager.startAgent("agent-fresh-mem-off", makeConfig({ sessionId: null, envVars: { RAFT_STARTUP_MEMORY_BLOCK: "0" } }));

    assert.equal(driver.spawnCalls.length, 1);
    assert.doesNotMatch(driver.spawnCalls[0]!.prompt, /<memory-index|Memory marker ten/);
  });
});

const coldStops = (ctx: ManagerCtx) => ctx.events.filter((event) => event.name === "daemon.agent.cold_idle_stop").map((event) => event.attrs);
const sweepSummaries = (ctx: ManagerCtx) => ctx.events.filter((event) => event.name === "daemon.agent.cold_idle_sweep").map((event) => event.attrs);
const flush = async (times = 5) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Cold-idle sweep under inbox-notice delivery (2026-09-18 fix). Messages the
// agent was notified about and left unread used to count as pending work, so
// the sweep never fired for agents idling with unread notices (Maria: 4 stops
// in 8 days while dozens of 300-900k sessions sat cold). RED proof: restore the
// `ap.inbox.length === 0` gate and the first test never stops the process;
// drop the notified-deferral guard in the exit path and the same test restarts
// the agent immediately on its oldest unread message (spawnCalls === 2).

function coldIdleFixture(seq: number) {
  return {
    seq,
    message_id: `msg-${seq}`,
    channel_name: "general",
    channel_type: "channel",
    sender_name: "someone",
    sender_type: "human",
    content: `unread ${seq}`,
    timestamp: new Date().toISOString(),
  } as any;
}

async function startIdleColdAgent(
  ctx: { driver: FakeClaudeDriver; manager: AgentProcessManager; dataDir: string },
  agentId: string,
  sessionId: string,
) {
  // Start warm (resume), then age the transcript and progress clock so the
  // live process looks cold and idle to the sweep.
  await writeSessionTranscript(ctx.dataDir, sessionId, { lastActivityAtMs: Date.now() - 60_000, contextTokens: 500_000 });
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }));
  await writeSessionTranscript(ctx.dataDir, sessionId, { lastActivityAtMs: Date.now() - 3 * HOUR_MS, contextTokens: 500_000 });
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = sessionId;
  ap.gatedSteering = { ...ap.gatedSteering, isIdle: true };
  ap.runtimeProgress.noteInternalProgress(Date.now() - 3 * HOUR_MS);
  return ap;
}

test("cold-idle sweep stops an idle process whose only queued messages were already notified, without restarting it", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-notified", "session-sweep-notified");
    assert.equal(ctx.driver.spawnCalls.length, 1);
    const unread = [coldIdleFixture(101), coldIdleFixture(102)];
    ap.inbox.push(...unread);
    ap.notifications.recordNoticeWritten("fp-unread", ap.sessionId, unread);
    const restarts: unknown[] = [];
    const realStartAgent = (ctx.manager as any).startAgent.bind(ctx.manager);
    (ctx.manager as any).startAgent = (...args: unknown[]) => {
      restarts.push(args[2]);
      return realStartAgent(...args);
    };

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.driver.processes[0]!.killed, true, "the cold idle process was stopped");
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle", "sweep stop is an expected termination");
    assert.deepEqual(coldStops(ctx), [{
      agentId: "agent-sweep-notified",
      session_id: "session-sweep-notified",
      idle_ms: (coldStops(ctx)[0] as { idle_ms: number }).idle_ms,
      prior_context_tokens: 500_000,
      cache_tier: "unknown",
      tier_gate: false,
      min_cold_gap_ms: HOUR_MS,
      min_context_tokens: 128_000,
      notified_unread_count: 2,
      trigger: "sweep",
    }]);
    assert.ok((coldStops(ctx)[0] as { idle_ms: number }).idle_ms > HOUR_MS);
    assert.deepEqual(restarts, [], "notified-but-unread messages must not wake an immediate restart");
    // The stop leaves an idle, restartable record (not terminal), so a later
    // server wake or app-inbox reminder can bring the agent back. The
    // notified messages stay unread on the server and ride the next start's
    // resume catch-up (see the cold-wake test above for the unread summary).
    const lifecycle = (ctx.manager as any).lifecycleRecords;
    assert.ok(lifecycle.getRestartSnapshot("agent-sweep-notified"), "a restart snapshot is kept");
    assert.equal(lifecycle.getTerminalFailure("agent-sweep-notified"), undefined, "the sweep stop is not terminal");
  });
});

test("a cold-idle recycle publishes a held empty wake with the process exit (task #17)", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-held", "session-sweep-held");
    const tracker = (ctx.manager as any).turnSummaries;
    tracker.begin("agent-sweep-held", Date.now() - 3 * HOUR_MS, { target: "#general", messageId: "m-wake" });
    tracker.finish("agent-sweep-held", "completed", Date.now() - 3 * HOUR_MS + 1_000);

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.driver.processes[0]!.killed, true);
    const summaries = ctx.sent.flatMap((msg) => msg.type === "agent:activity" ? msg.entries ?? [] : [])
      .flatMap((entry) => entry.kind === "turn_summary" ? [entry.summary] : []);
    assert.deepEqual(summaries.map((summary) => [summary.trigger?.messageId, summary.toolCalls]), [["m-wake", 0]]);
    assert.equal(ctx.sent.filter((msg) => msg.type === "agent:activity" && msg.launchId === (ap.launchId || undefined) && msg.entries?.some((entry) => entry.kind === "turn_summary")).length, 1);
  });
});

test("cold-idle sweep leaves a process alone while a queued message has not been notified yet", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-untold", "session-sweep-untold");
    const told = coldIdleFixture(201);
    const untold = coldIdleFixture(202);
    ap.inbox.push(told, untold);
    ap.notifications.recordNoticeWritten("fp-told", ap.sessionId, [told]);

    await (ctx.manager as any).sweepColdIdleRuntimes();

    assert.equal(ctx.driver.processes[0]!.killed, false, "an untold message is pending work");
    assert.equal(ap.gatedSteering.expectedTerminationReason, null);
  });
});

// ===========================================================================
// Reconciler step 8b: cold idle is decided by the one reconcile entry. Idle is
// agentNotIdle (agentIdle.ts), nothing of its own: background tasks from the
// event stream, input not yet read from stdin and untold messages hold it.
// Cold is a session policy on top: no event for over an hour, then the
// session's context read from the transcript (async), over 128k. The read is
// one per agent; when it answers, idle and the rest are decided again.
// RED proofs (run by hand): drop `backgroundTasks` from agentNotIdle's facts
// and the background-bash test stops the process; drop the agentNotIdle
// re-check after the read and the message-during-read test stops it.
// ===========================================================================

/** A session facts reader whose answers the test controls (one per call). */
function controlledFactsReader() {
  const calls: Array<{ runtime: string; sessionId: string; answer: (facts: SessionResumeFacts) => void }> = [];
  const read = (runtime: string, sessionId: string) => new Promise<SessionResumeFacts>((resolve) => {
    calls.push({ runtime, sessionId, answer: resolve });
  });
  return { calls, read };
}

const contextFacts = (tokens: number | null, lastActivityAtMs: number | null = Date.now() - 3 * HOUR_MS): SessionResumeFacts =>
  ({ transcriptPath: null, lastActivityAtMs, lastContextTokens: tokens });

async function startColdClaude(ctx: ManagerCtx, agentId: string) {
  const sessionId = `session-${agentId}`;
  await ctx.manager.startAgent(agentId, makeConfig({ sessionId, envVars: { RAFT_WAKE_RECYCLE: "1" } }));
  const ap = (ctx.manager as any).agents.get(agentId);
  ap.sessionId = sessionId;
  (ctx.manager as any).commitApmIdleState(agentId, ap, true);
  return ap;
}

function emitLine(ctx: ManagerCtx, line: string, events: ParsedEvent[]): void {
  ctx.driver.parsedLines.set(line, events);
  ctx.driver.processes[0]!.stdout.emit("data", Buffer.from(`${line}\n`));
}

test("idle 61 minutes with a 200k context and no background task: the sweep stops it the cold-idle way", async () => {
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-cold");
    ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();

    assert.equal(ctx.driver.processes[0]!.killed, true);
    assert.equal(ap.gatedSteering.expectedTerminationReason, "cold_idle_recycle");
    assert.equal(coldStops(ctx).length, 1);
    assert.equal(coldStops(ctx)[0]!.trigger, "sweep");
    assert.equal(coldStops(ctx)[0]!.prior_context_tokens, 200_000);
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 1 }], "the sweep counts the stop its read made");
  }, { readSessionResumeFacts: async () => contextFacts(200_000) });
});

test("idle 61 minutes but the context cannot be read: not cold, nothing stopped", async () => {
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-unreadable");
    ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();

    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(coldStops(ctx), []);
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 0, skipped_session_facts_unavailable: 1 }]);
  }, { readSessionResumeFacts: async () => contextFacts(null, null) });
});

test("a Claude Code below the cold-idle version floor, or of unknown version, is never stopped as cold; at the floor it is", async () => {
  for (const [version, stopped] of [["2.1.219 (Claude Code)", false], [undefined, false], ["2.1.220 (Claude Code)", true]] as const) {
    let reads = 0;
    await withManager(async (ctx) => {
      const ap = await startColdClaude(ctx, "agent-version");
      ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);

      await (ctx.manager as any).sweepColdIdleRuntimes();
      await flush();

      assert.equal(ctx.driver.processes[0]!.killed, stopped, `version ${version}`);
      assert.deepEqual(
        sweepSummaries(ctx),
        [stopped ? { views: 1, stops: 1 } : { views: 1, stops: 0, skipped_runtime_version_below_floor: 1 }],
        `version ${version}`,
      );
      assert.equal(reads, stopped ? 1 : 0, "below the floor, nothing is read");
    }, {
      detectedRuntimeCliVersion: () => version,
      readSessionResumeFacts: async () => { reads += 1; return contextFacts(200_000); },
    });
  }
});

test("an event within the hour: the transcript is not read at all", async () => {
  let reads = 0;
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-recent");
    ap.runtimeProgress.noteInternalProgress(Date.now() - 59 * MIN_MS);

    await (ctx.manager as any).sweepColdIdleRuntimes();

    assert.equal(reads, 0, "the time compare comes first");
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 0, skipped_recent_event: 1 }]);
  }, { readSessionResumeFacts: async () => { reads += 1; return contextFacts(500_000); } });
});

test("a message that arrives while the context is read: decided again after the read, not stopped", async () => {
  const facts = controlledFactsReader();
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-race");
    ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);

    const sweep = (ctx.manager as any).sweepColdIdleRuntimes() as Promise<void>;
    await flush();
    assert.equal(facts.calls.length, 1, "the read is in flight");
    // One read per agent: another reconcile while it runs starts none.
    (ctx.manager as any).reconcile("agent-race", ap, "delivery_consumed");
    assert.equal(facts.calls.length, 1);

    // A message nobody has told the session yet arrives meanwhile.
    ap.inbox.push(coldIdleFixture(501));
    facts.calls[0]!.answer(contextFacts(500_000));
    await sweep;
    await flush();

    assert.equal(ctx.driver.processes[0]!.killed, false, "the new message holds it");
    assert.equal(ap.gatedSteering.expectedTerminationReason, null);
    assert.deepEqual(coldStops(ctx), []);
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 0, skipped_not_idle: 1 }]);
  }, { readSessionResumeFacts: facts.read });
});

test("input written to stdin and not yet read holds a cold process", async () => {
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-stdin");
    ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);
    ap.deliveryConsumption.recordWrite("delivery-1", "stdin_idle_delivery", Date.now() - 61 * MIN_MS);

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();

    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 0, skipped_not_idle: 1 }]);
  }, { readSessionResumeFacts: async () => contextFacts(500_000) });
});

test("a cold-idle read in flight does not hold a session rotation (pi) at a turn end", async () => {
  const facts = controlledFactsReader();
  await withManager(async (ctx) => {
    const ap = await startColdClaude(ctx, "agent-rotate");
    ap.sessionReadyForDelivery = true;
    const offers: Array<() => string | null> = [];
    ap.runtime.rotateSessionIfDue = (hold: () => string | null) => { offers.push(hold); };
    ap.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);

    const sweep = (ctx.manager as any).sweepColdIdleRuntimes() as Promise<void>;
    await flush();
    assert.equal(facts.calls.length, 1, "the read is in flight");

    emitLine(ctx, "turn-end-rotate", [{ kind: "turn_end", sessionId: "session-agent-rotate" }]);
    await flush(20);
    assert.equal(offers.length, 1, "the rotation is offered while the read is pending");
    assert.equal(offers[0]!(), null, "and nothing holds it");

    facts.calls[0]!.answer(contextFacts(500_000));
    await sweep;
    assert.equal(ctx.driver.processes[0]!.killed, false, "the turn end is an event within the hour: not cold any more");
    assert.deepEqual(sweepSummaries(ctx), [{ views: 1, stops: 0, skipped_recent_event: 1 }]);
  }, { readSessionResumeFacts: facts.read });
});

test("a Claude background bash task silent for over an hour keeps the process from a cold-idle stop while a process it started lives, or the tree cannot be read", async () => {
  const tree: { answer: readonly ProcessTreeEntry[] | null | Error } = { answer: [] };
  await withManager(async (ctx) => {
    const t0 = Date.now();
    (ctx.manager as any).frozenClockMs = t0;
    const ap = await startColdClaude(ctx, "agent-bash");
    // `run_in_background` bash: Claude Code's task_started (task_type
    // local_bash), then the main turn ends.
    emitLine(ctx, "bash-started", [{
      kind: "subagent_progress",
      source: "claude_task_lifecycle",
      phase: "started",
      taskId: "bash_1",
      parentToolUseId: "toolu_bash_1",
      taskKind: "command",
      payloadBytes: 64,
    } as ParsedEvent]);
    emitLine(ctx, "turn-end-bash", [{ kind: "turn_end", sessionId: "session-agent-bash" }]);
    await flush(20);
    assert.equal(ap.backgroundTasks.size, 1);

    // The build the task runs (started after it) is alive.
    tree.answer = [{ pid: 8, pgid: 8, startedAtMs: t0 + MIN_MS }];
    (ctx.manager as any).frozenClockMs = t0 + 61 * MIN_MS;
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();
    assert.equal(ap.backgroundTasks.size, 1, "kept: a process started since the task lives");
    assert.equal(ctx.driver.processes[0]!.killed, false, "the background task holds idle");
    assert.deepEqual(coldStops(ctx), []);

    tree.answer = new Error("ps failed");
    (ctx.manager as any).frozenClockMs = t0 + 71 * MIN_MS;
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();
    assert.equal(ap.backgroundTasks.size, 1, "kept: the tree cannot be read");
    assert.equal(ctx.driver.processes[0]!.killed, false);
    assert.deepEqual(coldStops(ctx), []);
    assert.deepEqual(sweepSummaries(ctx).map((summary) => summary.skipped_not_idle), [1, 1]);

    // The build is gone: the task is presumed ended, and that end decides
    // the process again at once (not at the next sweep): now it is cold.
    tree.answer = [];
    (ctx.manager as any).frozenClockMs = t0 + 81 * MIN_MS;
    await (ctx.manager as any).sweepColdIdleRuntimes();
    await flush();
    assert.equal(ap.backgroundTasks.size, 0);
    assert.equal(ctx.driver.processes[0]!.killed, true);
    assert.equal(coldStops(ctx)[0]?.trigger, "background_tasks_done");
  }, {
    readSessionResumeFacts: async () => contextFacts(200_000),
    readRuntimeDescendants: async () => {
      if (tree.answer instanceof Error) throw tree.answer;
      return tree.answer;
    },
  });
});

test("drift and cold together: a spec stop past the cold gap says so, and one found after a cold read carries its facts", async () => {
  const facts = controlledFactsReader();
  await withManager(async (ctx) => {
    const specStops = () => ctx.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);

    // Past the gap when the spec changes: the stop does not wait for a read.
    const first = await startColdClaude(ctx, "agent-drift-gap");
    first.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);
    first.config = { ...first.config, model: "opus" };
    (ctx.manager as any).reconcile("agent-drift-gap", first, "signal");
    assert.equal(first.gatedSteering.expectedTerminationReason, "cold_idle_recycle");
    assert.equal(specStops()[0]?.cold_gap, true);
    assert.ok((specStops()[0]?.idle_ms as number) > HOUR_MS);
    assert.equal(facts.calls.length, 0, "a spec stop reads nothing");

    // A drift no entry has decided yet when a cold read answers: one spec stop that says both.
    const second = await startColdClaude(ctx, "agent-drift-cold");
    second.runtimeProgress.noteInternalProgress(Date.now() - 61 * MIN_MS);
    (ctx.manager as any).reconcile("agent-drift-cold", second, "sweep");
    assert.equal(facts.calls.length, 1);
    second.config = { ...second.config, model: "opus" };
    facts.calls[0]!.answer(contextFacts(300_000));
    await flush();
    assert.equal(second.gatedSteering.expectedTerminationReason, "cold_idle_recycle");
    assert.deepEqual(coldStops(ctx), [], "the spec stop, not a second one");
    assert.equal(specStops()[1]?.cold, true);
    assert.equal(specStops()[1]?.prior_context_tokens, 300_000);
    assert.equal(specStops()[1]?.trigger, "sweep");
  }, { readSessionResumeFacts: facts.read });
});

test("a message that arrives untold during a cold-idle stop still wakes the agent", async () => {
  // A restart strips the runner credential and mints a new one; answer the
  // mint here so the restart under test does not reach the network.
  onTestFinished(installManagedRunnerCredentialFetch());
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-race", "session-sweep-race");
    const told = coldIdleFixture(301);
    const untold = coldIdleFixture(302);
    ap.inbox.push(told, untold);
    ap.notifications.recordNoticeWritten("fp-race", ap.sessionId, [told]);
    const wakes: unknown[] = [];
    const realStartAgent = (ctx.manager as any).startAgent.bind(ctx.manager);
    (ctx.manager as any).startAgent = (...args: unknown[]) => {
      wakes.push(args[2]);
      return realStartAgent(...args);
    };

    // The stop was decided while only `told` was queued; `untold` raced in.
    (ctx.manager as any).commitGatedSteeringDecisionState("agent-sweep-race", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "cold_idle_recycle",
    });
    await ap.runtime.stop({ signal: "SIGTERM", reason: "cold_idle_recycle" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(wakes.length, 1, "the untold message restarts the agent");
    assert.equal((wakes[0] as { seq: number }).seq, 302, "and it, not the deferred unread, is the wake message");
    // The restart is queued and mints its runner credential later. Let it
    // finish while this test's mint answer is installed; otherwise the mint
    // reaches the network during the next test.
    const deadline = Date.now() + 5_000;
    while (ctx.driver.processes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ctx.driver.processes.length, 2, "the restart spawned before the test ends");
  });
});

test("test teardown fences a restart still queued when the test ends: nothing reaches the network afterwards", async () => {
  const restoreMint = installManagedRunnerCredentialFetch();
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-teardown-fence", "session-teardown-fence");
    const untold = coldIdleFixture(402);
    ap.inbox.push(untold);
    (ctx.manager as any).commitGatedSteeringDecisionState("agent-teardown-fence", ap, {
      ...ap.gatedSteering,
      expectedTerminationReason: "cold_idle_recycle",
    });
    await ap.runtime.stop({ signal: "SIGTERM", reason: "cold_idle_recycle" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.driver.processes.length, 1, "precondition: the restart is still pending");

    // What withManager's teardown does, followed by the mint answer going away.
    await drainAgentManagerForTests(ctx.manager);
    restoreMint();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(takeRecordedNetworkAttempts(), [], "no mint after teardown");
    assert.equal(ctx.driver.processes.length, 1, "no spawn after teardown");
  });
});

test("a sweep stop is a clean exit even when a recovered runtime error is still latched", async () => {
  await withManager(async (ctx) => {
    const ap = await startIdleColdAgent(ctx, "agent-sweep-stale-error", "session-sweep-stale-error");
    // The agent hit a rate limit hours ago and has been working fine since;
    // `lastRuntimeError` is only cleared by an ordinary message delivery.
    ap.lastRuntimeError = "You've hit your weekly limit · resets Sep 23 at 9am (Asia/Shanghai)";

    await (ctx.manager as any).sweepColdIdleRuntimes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.driver.processes[0]!.killed, true);
    const activities = ctx.sent.filter((m) => m.type === "agent:activity") as Array<{ activity: string; detail?: string }>;
    assert.equal(
      activities.some((a) => a.detail === "Process idle"),
      true,
      "the sweep stop must close as a normal idle exit",
    );
    assert.equal(
      activities.some((a) => a.activity === "error" || /crash/i.test(a.detail ?? "")),
      false,
      "a stale runtime error must not make the sweep stop look like a crash",
    );
  });
});
