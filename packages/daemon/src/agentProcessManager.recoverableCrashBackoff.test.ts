// Field (AndyLok, daemon 1.0.53): three cursor agents on a machine that could
// not reach the model service crashed 760 times in about 2 hours, about once
// every 30s per agent (`daemon.runtime.turn` outcome=process-crash,
// runtime_input_source=starting_inbox_update). Each crash's error was only on
// stderr (classified ProviderConnectionError), the close path armed a
// restart with attempts=1 every time, so the delay never grew past ~10s.
// Consecutive recoverable crashes of one agent must back off exponentially
// (10s, 20s, 40s, 80s), hold deliveries until the backoff ends, and reset on
// real progress. Reconciler step 10a (D3): never capped, the backoff stays at
// its 5 min max through an outage (agentProcessManager.exitPlan.test.ts walks
// a 30 min outage and the cap of every other crash).
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-crash-backoff";
/** The provider-limit credential key of an agent on the machine-shared Codex sign-in (promptConfig's default). */
const SHARED_CODEX = "shared:codex";
const CONNECTION_ERROR = "Error: Unable to connect to API (ECONNREFUSED)";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
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

type Internals = {
  agents: Map<string, { inbox: AgentMessage[] }>;
  lifecycleRecords: {
    getSpawnFailBackoff(agentId: string): { untilMs: number; attempts: number; reason: string | null } | undefined;
    getRuntimeErrorCloseStreak(agentId: string): number;
    getProviderLimit(key: string): { untilMs: number; attempts: number; reason: string; providerLimitKind: string; resetsAt?: string } | undefined;
    getRestartSnapshot(agentId: string): { sessionId: string | null } | undefined;
  };
};

type Harness = {
  manager: AgentProcessManager;
  m: Internals;
  children: FakeChild[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
  crash: (stderr?: string) => Promise<void>;
  cleanExit: () => Promise<void>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "andy", sender_type: "human",
    content, timestamp: "2026-10-31T00:00:00.000Z",
    message_id: `m-${seq}`, seq,
  };
}

async function withManager(run: (h: Harness) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-crash-backoff-test-"));
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    runtimeErrorDeliveryBackoff: { jitterRatio: 0 },
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const m = manager as unknown as Internals & { recordDaemonEvent: (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => void };
  const recordDaemonEvent = m.recordDaemonEvent.bind(manager);
  m.recordDaemonEvent = (name, attrs, ...rest) => {
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
  const crash = async (stderr = CONNECTION_ERROR) => {
    const child = children.at(-1)!;
    child.stderr.emit("data", Buffer.from(`${stderr}\n`));
    child.end(1);
    await settle();
  };
  const cleanExit = async () => {
    children.at(-1)!.end(0);
    await settle();
  };
  try {
    await run({ manager, m, children, events, emit, crash, cleanExit });
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

/**
 * Lets real I/O (session files, credential mint) settle without moving the
 * fake clock: the restart path awaits fs work that fake timers do not drive.
 */
async function settle(until: () => boolean = () => false, realMs = 100): Promise<void> {
  const deadline = performance.now() + realMs;
  while (!until() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Asserts no respawn until just before `delayMs` has passed, then exactly one right after. */
async function expectRestartAfter(h: Harness, delayMs: number): Promise<void> {
  const before = h.children.length;
  await vi.advanceTimersByTimeAsync(delayMs - 10);
  await settle();
  expect(h.children.length, `no respawn before ${delayMs}ms`).toBe(before);
  await vi.advanceTimersByTimeAsync(20);
  await settle(() => h.children.length > before, 2_000);
  expect(h.children.length, `one respawn at ${delayMs}ms`).toBe(before + 1);
}

async function startWithPendingMessage(h: Harness, content: string, overrides: Partial<AgentConfig> = {}): Promise<void> {
  await h.manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1", ...overrides }));
  await h.manager.deliverMessage(AGENT, message(content));
  await settle(() => (h.m.agents.get(AGENT)?.inbox.length ?? 0) > 0);
  expect(h.m.agents.get(AGENT)?.inbox.length, "the delivery is pending in the running process").toBeGreaterThan(0);
}

const scheduledDelays = (h: Harness) => h.events
  .filter((event) => event.name === "daemon.agent.runtime_error_process_restart.scheduled")
  .map((event) => event.attrs.delay_ms);

test("repeated provider-connection crashes back off 10s, 20s, 40s, 80s, 160s, then 5 min each, and are never handed off (D3 is not capped)", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "work that keeps failing");
    const expected = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
    for (const delayMs of expected) {
      await h.crash();
      expect(h.m.agents.has(AGENT)).toBe(false);
      await expectRestartAfter(h, delayMs);
    }
    expect(scheduledDelays(h)).toEqual(expected);
    const scheduled = h.events.filter((event) => event.name === "daemon.agent.runtime_error_process_restart.scheduled");
    expect(scheduled.map((event) => event.attrs.attempts)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(scheduled.every((event) => event.attrs.reason === "provider_connection_error")).toBe(true);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["work that keeps failing"]);
    expect(h.events.some((event) => event.name === "daemon.agent.spawn.local_restart_stopped"), "never handed to the server").toBe(false);
  });
}, 20_000);

// task #927: the reqwest request-send failure is diagnosed as a connection
// error, but a process that exits on it alone keeps its old close handling:
// no runtime-error restart is armed. Socket evidence still arms one.
test("a crash on a reqwest request-send failure alone arms no runtime-error restart", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "work");
    await h.crash("reqwest error stream: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)");
    const before = h.children.length;
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(scheduledDelays(h), "no restart scheduled").toEqual([]);
    expect(h.children.length, "no respawn").toBe(before);
  });
});

test("a crash on a request-send failure that also carries a socket error still restarts after the backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "work");
    await h.crash("reqwest error stream: error sending request for url (https://x.example/v1): connection reset (ECONNRESET)");
    await expectRestartAfter(h, 10_000);
    expect(scheduledDelays(h)).toEqual([10_000]);
  });
});

test("a crash on an explicit ProviderConnectionError without a socket code still restarts after the backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "work");
    await h.crash("ProviderConnectionError: transport unavailable");
    await expectRestartAfter(h, 10_000);
    expect(scheduledDelays(h)).toEqual([10_000]);
  });
});

test("deliveries during the backoff are held and handed to the process started when it ends", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.crash();
    // Second consecutive crash: 20s. A delivery 1s in must not spawn now.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await h.manager.deliverMessage(AGENT, message("arrives during backoff"))).toBe(true);
    await settle();
    expect(h.children.length, "held, not spawned").toBe(2);
    await expectRestartAfter(h, 19_000);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["first", "arrives during backoff"]);
  });
}, 20_000);

test("a crash with nothing queued still holds the next delivery once crashes repeat", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    // The restarted process consumes its input, then crashes with an empty inbox.
    h.m.agents.get(AGENT)!.inbox.splice(0);
    await h.crash();
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.untilMs).toBe(Date.now() + 20_000);
    expect(await h.manager.deliverMessage(AGENT, message("next delivery"))).toBe(true);
    await settle();
    expect(h.children.length, "the next delivery does not respawn at once").toBe(2);
    await expectRestartAfter(h, 20_000);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["next delivery"]);
  });
}, 20_000);

test("real progress resets the crash backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.crash();
    await expectRestartAfter(h, 20_000);
    await h.emit([{ kind: "text", text: "the provider answered" }]);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(0);
    expect(h.events.some((event) => event.name === "daemon.agent.runtime_error_process_restart.reset")).toBe(true);
    await h.crash();
    await expectRestartAfter(h, 10_000);
  });
}, 20_000);

test("a turn end after a runtime error is not progress", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.emit([{ kind: "error", message: CONNECTION_ERROR }, { kind: "turn_end", sessionId: "session-1" }]);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(1);
  });
}, 20_000);

test("a clean exit with a queued message still restarts at once", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.manager.deliverMessage(AGENT, message("queued before exit"));
    await settle();
    await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
    const before = h.children.length;
    await h.cleanExit();
    await settle();
    expect(h.children.length, "clean exit restarts immediately").toBe(before + 1);
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)).toBeUndefined();
  });
}, 20_000);

test("an explicit stop resets the crash backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.crash();
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(2);
    await h.manager.stopAgent(AGENT);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(0);
  });
}, 20_000);

test("an empty thinking marker at turn start does not reset the crash backoff", async () => {
  // Codex (turn/started), Copilot, Kimi, OpenCode and Pi emit an empty
  // thinking event at every turn start, before the model produced anything.
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.emit([{ kind: "thinking", text: "" }]);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(1);
    await h.crash();
    await expectRestartAfter(h, 20_000);
  });
}, 20_000);

test("subagent output does not reset the crash backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.emit([{ kind: "text", text: "from a subagent", subagent: { parentToolUseId: "toolu_sub", subagentType: "general-purpose", phase: "active" } }]);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(1);
    await h.crash();
    await expectRestartAfter(h, 20_000);
  });
}, 20_000);

const resetSources = (h: Harness) => h.events
  .filter((event) => event.name === "daemon.agent.runtime_error_process_restart.reset")
  .map((event) => event.attrs.reset_source);

// Reconciler step 10a (D5): a non-recoverable close no longer resets the
// streak; it counts into it (the loop guard) and keeps the restart snapshot.
test("a non-recoverable close counts into the crash streak and keeps the restart snapshot", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    const child = h.children.at(-1)!;
    child.stderr.emit("data", Buffer.from("fatal: unexpected internal assertion\n"));
    child.end(1);
    await settle();
    expect(h.m.agents.has(AGENT)).toBe(false);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(2);
    expect(resetSources(h)).toEqual([]);
    expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId).toBe("session-1");
  });
}, 20_000);

test("a startup request error resets the crash backoff", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    await h.emit([{ kind: "error", message: "initialize failed: invalid params", startupRequestMethod: "initialize" }]);
    await settle(() => !h.m.agents.has(AGENT));
    expect(h.m.agents.has(AGENT)).toBe(false);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(0);
    expect(resetSources(h)).toEqual(["startup_request_error_cleanup"]);
  });
}, 20_000);

// Reconciler step 12: a fence trip hands the agent to the server and no
// longer zeroes the crash streak (that made a loop look new every time).
test("a fence trip leaves the crash streak as it was", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await h.crash();
    await expectRestartAfter(h, 10_000);
    // Three identical runtime errors trip the same-fingerprint fence.
    for (let n = 0; n < 3; n++) {
      await h.emit([{ kind: "error", message: "Error: deterministic tool failure" }]);
    }
    await settle(() => !h.m.agents.has(AGENT));
    expect(h.m.agents.has(AGENT)).toBe(false);
    expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(1);
    expect(resetSources(h)).not.toContain("terminal_runtime_error");
  });
}, 20_000);

// Field (Grace, #proj-runtime:af29bda9): a Claude weekly quota ran out with
// the reset 5 days away. The provider-limit delivery backoff (60 min per wait,
// task #379) lived only on the process, so once that process closed the next
// delivery respawned the agent straight into the same limit. The backoff now
// survives on the agent record until real model output clears it.
const QUOTA_TEXT = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai.";
const HOUR_MS = 60 * 60_000;

async function hitWeeklyQuota(h: Harness, key = SHARED_CODEX): Promise<void> {
  const resetsAt = new Date(Date.now() + 5 * 24 * HOUR_MS).toISOString();
  await h.emit([{ kind: "error", message: QUOTA_TEXT, providerLimit: { kind: "quota_exhausted", resetsAt } }]);
  const armed = h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff").at(-1);
  expect(armed?.attrs.delay_ms, "the wait is capped at 60 minutes").toBe(HOUR_MS);
  expect(h.m.lifecycleRecords.getProviderLimit(key)).toMatchObject({
    attempts: 1, reason: "rate_limited", untilMs: Date.now() + HOUR_MS, providerLimitKind: "quota_exhausted", resetsAt,
  });
}

async function closeAfterQuota(h: Harness): Promise<void> {
  h.children.at(-1)!.end(1);
  await settle();
  expect(h.m.agents.has(AGENT)).toBe(false);
}

const restoredEvents = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.restored");

test("a quota backoff survives the process closing: deliveries are held until it ends", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await hitWeeklyQuota(h);
    await closeAfterQuota(h);
    expect(restoredEvents(h).at(-1)?.attrs).toMatchObject({
      restore_point: "process_close", restored_from_agent_record: true, provider_limit_kind: "quota_exhausted", remaining_ms_bucket: ">60m",
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await h.manager.deliverMessage(AGENT, message("arrives during the quota wait"))).toBe(true);
    await settle();
    expect(h.children.length, "no respawn inside the quota wait").toBe(1);
    await expectRestartAfter(h, 50 * 60_000);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["first", "arrives during the quota wait"]);
    expect(restoredEvents(h).at(-1)?.attrs).toMatchObject({ restore_point: "process_start", remaining_ms_bucket: "elapsed", attempts: 1 });
  });
}, 20_000);

test("a quota backoff survives a clean exit with nothing queued", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await hitWeeklyQuota(h);
    h.m.agents.get(AGENT)!.inbox.splice(0);
    await h.cleanExit();
    expect(h.m.agents.has(AGENT)).toBe(false);
    expect(await h.manager.deliverMessage(AGENT, message("next delivery"))).toBe(true);
    await settle();
    expect(h.children.length, "the next delivery does not wake the agent").toBe(1);
    await expectRestartAfter(h, HOUR_MS);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["next delivery"]);
  });
}, 20_000);

test("after the quota wait a delivery wakes the agent, and real model output clears the agent record", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first");
    await hitWeeklyQuota(h);
    h.m.agents.get(AGENT)!.inbox.splice(0);
    await closeAfterQuota(h);
    await vi.advanceTimersByTimeAsync(HOUR_MS + 1_000);
    await settle();
    expect(h.children.length, "nothing pending, nothing started").toBe(1);
    expect(await h.manager.deliverMessage(AGENT, message("after the wait"))).toBe(true);
    await settle(() => h.children.length > 1, 2_000);
    expect(h.children.length, "the delivery wakes the agent").toBe(2);
    // The new process keeps the limit's attempts until the model answers.
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED_CODEX)?.attempts).toBe(1);
    await h.emit([{ kind: "internal_progress", source: "claude_system_status", itemType: "requesting" }]);
    await h.emit([{ kind: "thinking", text: "" }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED_CODEX), "turn-start bookkeeping is not output").toBeDefined();
    await h.emit([{ kind: "text", text: "the quota is back" }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED_CODEX)).toBeUndefined();
    expect(h.events.some((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset")).toBe(true);
  });
}, 20_000);

// The limit is keyed by credential (#proj-raft-computer:#46): an explicit stop
// clears the agent's own-credential limit here; on a shared sign-in it releases
// every agent on it (agentProcessManager.sharedCredentialProviderLimit.test.ts).
test("an explicit stop clears the quota backoff record of an agent on its own credentials", async () => {
  await withManager(async (h) => {
    await startWithPendingMessage(h, "first", { envVars: { CODEX_HOME: "/srv/codex-agent-1" } });
    await hitWeeklyQuota(h, `agent:${AGENT}`);
    await h.manager.stopAgent(AGENT);
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${AGENT}`)).toBeUndefined();
  });
}, 20_000);
