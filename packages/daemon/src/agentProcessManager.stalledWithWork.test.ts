// Reconciler step 9 (#proj-raft-computer:#48, rule 3 / E2, rows C14 and C15)
// on the legacy host: a process stalled with work queued is broken; reconcile
// stops it at once and the close path starts it again with the queued work,
// resuming its session. What decides is stalledWithWork (stalledWithWork.ts);
// what reaches it is the delivery, the 10-minute sweep and one stall-deadline
// timer per process (no fixed recheck interval).
//
// RED proof (reverse-verified): drop the deadline timer (armStallDeadline arms
// nothing) and the acceptance test replaces nothing at the threshold (only
// the sweep at minute 20 would); drop the delivery-hold fact and the three
// hold tests replace the process at the sweep; drop the streak cap and the
// loop test replaces a third time.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentMessage, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { providerLimitCredentialKey } from "./providerLimitLedger";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-stalled-with-work";
const MIN = 60_000;
const THRESHOLD_MS = 15 * MIN;

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  readonly killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    queueMicrotask(() => this.end(0));
    return true;
  }
  end(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

type Process = {
  inbox: AgentMessage[];
  sessionId: string | null;
  stallDeadlineTimer?: unknown;
  gatedSteering: { expectedTerminationReason: string | null; isIdle: boolean };
  config: Parameters<typeof providerLimitCredentialKey>[1];
  runtimeErrorDeliveryBackoff: unknown;
};

type Harness = {
  manager: AgentProcessManager;
  children: FakeChild[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  sent: MachineToServerMessage[];
  process: () => Process | undefined;
  internals: any;
  /** Runtime events on the newest process. */
  emit: (events: ParsedEvent[]) => Promise<void>;
  sweep: () => Promise<void>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "andy", sender_type: "human",
    content, timestamp: "2026-11-05T00:00:00.000Z",
    message_id: `m-stall-${seq}`, seq,
  };
}

async function withManager(run: (h: Harness) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-stalled-with-work-test-"));
  const children: FakeChild[] = [];
  const parsed = new Map<string, ParsedEvent[]>();
  const driver: RuntimeDriver = {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const,
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
    buildSystemPrompt: () => asAxSurfaceText("standing"),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return { process: child as unknown as ChildProcess };
    },
    parseLine: (line) => parsed.get(line) ?? [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  // The sweep interval is faked too: it runs every 10 minutes, so a
  // replacement at minute 15 can only come from the stall deadline.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((msg) => sent.push(msg), "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  const events: Harness["events"] = [];
  const internals = manager as any;
  const recordDaemonEvent = internals.recordDaemonEvent.bind(manager);
  internals.recordDaemonEvent = (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => {
    events.push({ name, attrs });
    recordDaemonEvent(name, attrs, ...rest);
  };
  let line = 0;
  const emit = async (parsedEvents: ParsedEvent[]) => {
    const key = `line-${line++}`;
    parsed.set(key, parsedEvents);
    children.at(-1)!.stdout.emit("data", Buffer.from(`${key}\n`));
    await settle();
  };
  try {
    await run({
      manager,
      children,
      events,
      sent,
      internals,
      process: () => internals.agents.get(AGENT),
      emit,
      sweep: async () => {
        await internals.sweepColdIdleRuntimes();
        await settle();
      },
    });
  } finally {
    vi.useRealTimers();
    await drainAgentManagerForTests(manager);
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

/** Lets real I/O (session files, credential mint) settle without moving the fake clock. */
async function settle(until: () => boolean = () => false, realMs = 100): Promise<void> {
  const deadline = performance.now() + realMs;
  while (!until() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** A started process in a turn (a session, a first event), `queued` delivered behind it. */
async function startBusyWithQueued(h: Harness, queued: AgentMessage[]): Promise<Process> {
  await h.manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1" }));
  await h.emit([{ kind: "session_init", sessionId: "session-1" }]);
  for (const each of queued) await h.manager.deliverMessage(AGENT, each);
  await settle();
  const ap = h.process()!;
  expect(ap.gatedSteering.isIdle, "precondition: a turn is under way").toBe(false);
  expect(ap.inbox.map((each) => each.message_id), "precondition: the deliveries wait in the inbox").toEqual(queued.map((each) => each.message_id));
  return ap;
}

const named = (h: Harness, name: string) => h.events.filter((event) => event.name === name).map((event) => event.attrs);
const replacements = (h: Harness) => named(h, "daemon.runtime.stall.recovery_action");

test("acceptance: stalled past the threshold with queued messages, replaced at the threshold by the stall deadline; the messages reach the new process once each", async () => {
  await withManager(async (h) => {
    const queued = [message("first queued"), message("second queued")];
    const t0 = Date.now();
    await startBusyWithQueued(h, queued);
    expect(h.process()!.stallDeadlineTimer, "the delivery arms one deadline").toBeDefined();

    await advance(THRESHOLD_MS - 1 - (Date.now() - t0));
    expect(h.children[0]!.killedSignals, "not yet past the threshold").toEqual([]);
    expect(replacements(h)).toEqual([]);

    await advance(1);
    await settle(() => h.children.length > 1, 2_000);
    expect(h.children[0]!.killedSignals, "killed without waiting for idle (E2)").toEqual(["SIGTERM"]);
    expect(h.children.length, "started again for the queued work").toBe(2);
    expect(replacements(h)).toEqual([expect.objectContaining({ trigger: "stall_deadline", streak: 1, action: "terminate_for_restart" })]);
    expect(Date.now() - t0, "at the threshold, not at a poll").toBe(THRESHOLD_MS);

    await h.emit([{ kind: "session_init", sessionId: "session-1" }]);
    const next = h.process()!;
    expect(next.sessionId, "the session is resumed").toBe("session-1");
    expect(next.inbox.map((each) => each.message_id), "every queued message, once, in order").toEqual(queued.map((each) => each.message_id));
  });
});

test("progress re-arms the deadline: the threshold counts from the last progress", async () => {
  await withManager(async (h) => {
    const t0 = Date.now();
    await startBusyWithQueued(h, [message("queued")]);
    await advance(10 * MIN);
    await h.emit([{ kind: "thinking", text: "still thinking" }]);
    await advance(THRESHOLD_MS - 10 * MIN);
    expect(h.children[0]!.killedSignals, "the deadline that fired found recent progress").toEqual([]);
    await advance(10 * MIN - 1);
    expect(h.children[0]!.killedSignals).toEqual([]);
    await advance(1);
    expect(h.children[0]!.killedSignals, "15 minutes after the last progress").toEqual(["SIGTERM"]);
    expect(Date.now() - t0).toBe(10 * MIN + THRESHOLD_MS);
  });
});

test("an open tool still doing work is not replaced", async () => {
  await withManager(async (h) => {
    await startBusyWithQueued(h, []);
    await h.emit([{ kind: "tool_call", name: "bash", input: { command: "make build" }, callId: "call-1" }]);
    await h.manager.deliverMessage(AGENT, message("queued behind the build"));
    await settle();
    // What the runtime says of the open tool: its command still runs.
    h.internals.agents.get(AGENT).runtime.emitToolDiagnosticSnapshots = () => [{
      toolExecutionInstanceId: "tool-execution-1",
      runtimeToolCallId: "call-1",
      toolPending: true,
      progressState: "stale",
      negativeEvidenceBucket: "none",
      classification: "running_no_observed_progress",
      processLiveness: "alive",
    }];
    await advance(45 * MIN);
    await h.sweep();
    expect(h.children[0]!.killedSignals).toEqual([]);
    expect(h.children.length).toBe(1);
    expect(named(h, "daemon.runtime.stall.open_tool_recovery").map((attrs) => attrs.decision)).toContain("alive_silent_blocked");
  });
});

test("stalled without queued messages is only a fact (C15): not replaced, no deadline", async () => {
  await withManager(async (h) => {
    const ap = await startBusyWithQueued(h, []);
    expect(ap.stallDeadlineTimer).toBeUndefined();
    await advance(2 * 60 * MIN);
    expect(h.children[0]!.killedSignals).toEqual([]);
    expect(replacements(h)).toEqual([]);
  });
});

const HOLDS: Array<{ hold: string; apply: (h: Harness, ap: Process) => void }> = [
  {
    hold: "provider_limit",
    apply: (h, ap) => h.internals.lifecycleRecords.setProviderLimit(providerLimitCredentialKey(AGENT, ap.config), {
      attempts: 1, reason: "rate_limited", untilMs: Date.now() + 3 * 60 * MIN, providerLimitKind: "quota_exhausted", recordedAtMs: Date.now(),
    }),
  },
  {
    hold: "credential_invalid",
    apply: (h, ap) => h.internals.lifecycleRecords.providerLimitLedger.recordInvalid(
      providerLimitCredentialKey(AGENT, ap.config),
      { invalidReason: "user_reauth", recordedAtMs: Date.now() },
      { host: "legacy", agentId: AGENT },
    ),
  },
  {
    hold: "runtime_error_backoff",
    apply: (_h, ap) => {
      ap.runtimeErrorDeliveryBackoff = { kind: "backing_off", attempts: 1, reason: "provider_connection", untilMs: Date.now() + 3 * 60 * MIN, timer: null };
    },
  },
];

test.each(HOLDS)("held deliveries ($hold) with queued messages past the threshold are not stalled", async ({ apply }) => {
  await withManager(async (h) => {
    const ap = await startBusyWithQueued(h, [message("queued before the hold")]);
    apply(h, ap);
    await advance(40 * MIN);
    await h.sweep();
    expect(h.children[0]!.killedSignals, "a hold makes no progress by design").toEqual([]);
    expect(replacements(h)).toEqual([]);
  });
});

test("two stalled replacements in a row: the third stall gives up (traced, shown once); progress in between resets the streak", async () => {
  await withManager(async (h) => {
    await startBusyWithQueued(h, [message("one"), message("two")]);
    // Each replacement resumes the session, says so, and stalls again.
    for (const n of [1, 2]) {
      await advance(THRESHOLD_MS);
      await settle(() => h.children.length > n, 2_000);
      expect(h.children.length, `replacement ${n}`).toBe(n + 1);
      await h.emit([{ kind: "session_init", sessionId: "session-1" }]);
    }
    expect(replacements(h).map((attrs) => attrs.streak)).toEqual([1, 2]);

    await advance(THRESHOLD_MS);
    await h.sweep();
    await advance(THRESHOLD_MS);
    expect(h.children.length, "no third replacement").toBe(3);
    expect(h.children[2]!.killedSignals).toEqual([]);
    expect(named(h, "daemon.agent.stalled_recovery.gave_up")).toEqual([expect.objectContaining({ streak: 2, queued_messages_count: 2 })]);
    const shown = h.sent.filter((msg) => msg.type === "agent:activity" && (msg as { detail?: string }).detail?.includes("stalled repeatedly with queued messages; restart it to retry"));
    expect(shown.length, "shown once").toBe(1);

    // Model output: the streak ends, and the next stall is replaced again.
    await h.emit([{ kind: "text", text: "back" }]);
    await advance(THRESHOLD_MS);
    await settle(() => h.children.length > 3, 2_000);
    expect(h.children.length).toBe(4);
    expect(replacements(h).map((attrs) => attrs.streak)).toEqual([1, 2, 1]);
  });
});
