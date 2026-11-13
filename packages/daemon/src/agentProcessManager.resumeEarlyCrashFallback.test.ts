// Field (AndyLok, #proj-raft-computer:#42, Computer 1.0.60): a Claude agent
// SIGTERMed mid-task was restarted 4 times on the SAME stored session; each
// launch exited 1 within 1-4 s after a runtime error, until automatic wakes
// stopped. It never tried a fresh session, so the task it held stayed locked.
// Generic rule (any runtime, no error text): two launches in a row that
// resumed the same session and crashed early, before model output, make the
// next start fresh.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText } from "@botiverse/raft-shared";
import { AgentProcessManager, RESUMED_EARLY_CRASH_WINDOW_MS } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-resume-fallback";
// Not a text any runtime's resume matcher knows, and not a recoverable error.
const OPAQUE_ERROR = "Error: something went wrong while loading the conversation";

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
  end(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

type Harness = {
  manager: AgentProcessManager;
  children: FakeChild[];
  /** config.sessionId each spawn was asked to resume. */
  spawnedSessionIds: Array<string | null>;
  sent: Array<Record<string, unknown>>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
  /** The runtime reports an error, then exits with `code` (or the signal). */
  crash: (code?: number | null, signal?: NodeJS.Signals | null, error?: ParsedEvent) => Promise<void>;
  /** A server wake: start the agent on the stored session. */
  wake: (sessionId?: string) => Promise<void>;
};

async function settle(until: () => boolean = () => false, realMs = 100): Promise<void> {
  const deadline = performance.now() + realMs;
  while (!until() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function withManager(run: (h: Harness) => Promise<void>, driverOverrides: Partial<RuntimeDriver> = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-resume-fallback-test-"));
  const children: FakeChild[] = [];
  const spawnedSessionIds: Array<string | null> = [];
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
    spawn: (ctx) => {
      spawnedSessionIds.push(ctx.config.sessionId ?? null);
      const child = new FakeChild();
      children.push(child);
      return { process: child as unknown as ChildProcess };
    },
    parseLine: (line) => parsed.get(line) ?? [],
    encodeStdinMessage: (text) => text,
    ...driverOverrides,
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
  const sent: Array<Record<string, unknown>> = [];
  const manager = new AgentProcessManager((msg) => { sent.push(msg as unknown as Record<string, unknown>); }, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    runtimeErrorDeliveryBackoff: { jitterRatio: 0 },
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const m = manager as unknown as { recordDaemonEvent: (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => void };
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
  const crash = async (code: number | null = 1, signal: NodeJS.Signals | null = null, error: ParsedEvent = { kind: "error", message: OPAQUE_ERROR }) => {
    await emit([error]);
    children.at(-1)!.end(code, signal);
    await settle();
  };
  const wake = async (sessionId = "session-1") => {
    const before = children.length;
    await manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId }));
    await settle(() => children.length > before, 2_000);
    expect(children.length, "the wake spawned a process").toBe(before + 1);
  };
  try {
    await run({ manager, children, spawnedSessionIds, sent, events, emit, crash, wake });
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

const resumeFailed = (h: Harness) => h.events.filter((event) => event.name === "daemon.runtime.resume_failed");
const invalidations = (h: Harness) => h.sent.filter((msg) => msg.type === "agent:session:invalidate");

test("two resumed launches crashing early in a row: the next start is fresh, the session is invalidated, and the trace says so", async () => {
  await withManager(async (h) => {
    await h.wake();
    await h.crash();
    expect(h.children.length, "one early crash: no restart from the daemon (the server wakes it)").toBe(1);
    expect(resumeFailed(h).map((event) => [event.attrs.consecutive_count, event.attrs.fell_back_fresh])).toEqual([[1, false]]);

    await h.wake();
    await h.crash();
    await settle(() => h.children.length > 2, 2_000);
    expect(h.children.length, "the second early crash cold-starts at once").toBe(3);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", null]);
    expect(invalidations(h)).toEqual([expect.objectContaining({ agentId: AGENT, sessionId: "session-1", reason: "repeated_early_crash" })]);
    const traced = resumeFailed(h).map((event) => event.attrs);
    expect(traced.map((attrs) => [attrs.consecutive_count, attrs.fell_back_fresh])).toEqual([[1, false], [2, true]]);
    expect(traced[1]).toMatchObject({ session_id: "session-1", threshold: 2, exit_code: 1, runtime_error_class: expect.any(String) });
    expect(typeof traced[1].runtime_error_fingerprint).toBe("string");
    expect(JSON.stringify(traced), "no raw error text in the trace").not.toContain("something went wrong");

    // The fresh session is not a resume: the idle task reminder's first ask
    // of it lists every open task assigned to the agent (freshSession).
    await h.emit([{ kind: "session_init", sessionId: "session-2" }]);
    expect(h.manager.idleNoticeFacts(AGENT)).toMatchObject({ sessionId: "session-2", resumed: false });
    // And it never counts toward the rule: its own early crash is not a resume.
    await h.crash();
    expect(resumeFailed(h)).toHaveLength(2);
  });
}, 20_000);

test("a resumed launch that crashes after model output does not count", async () => {
  await withManager(async (h) => {
    for (let n = 0; n < 3; n++) {
      await h.wake();
      await h.emit([{ kind: "text", text: "real work" }]);
      await h.crash();
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", "session-1"]);
  });
}, 20_000);

test("a resumed launch that crashes after the early window does not count", async () => {
  await withManager(async (h) => {
    for (let n = 0; n < 3; n++) {
      await h.wake();
      await vi.advanceTimersByTimeAsync(RESUMED_EARLY_CRASH_WINDOW_MS + 1_000);
      await h.crash();
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
  });
}, 20_000);

test("a SIGTERM from outside (exit 143 or the signal) does not count", async () => {
  await withManager(async (h) => {
    await h.wake();
    await h.crash(143);
    await h.wake();
    await h.crash(null, "SIGTERM");
    await h.wake();
    await h.crash(143);
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.children.length).toBe(3);
  });
}, 20_000);

test("an explicit stop between two early crashes ends the streak", async () => {
  await withManager(async (h) => {
    await h.wake();
    await h.crash();
    await h.manager.stopAgent(AGENT);
    await h.wake();
    await h.crash();
    expect(resumeFailed(h).map((event) => event.attrs.consecutive_count)).toEqual([1, 1]);
    expect(invalidations(h)).toEqual([]);
    expect(h.children.length).toBe(2);
  });
}, 20_000);

test("a deliberate stop of a resumed launch is not a crash", async () => {
  await withManager(async (h) => {
    for (let n = 0; n < 2; n++) {
      await h.wake();
      await h.emit([{ kind: "error", message: OPAQUE_ERROR }]);
      await h.manager.stopAgent(AGENT, { wait: true });
      await settle();
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
  });
}, 20_000);

test("early crashes of launches that did not resume a session are unaffected", async () => {
  await withManager(async (h) => {
    for (let n = 0; n < 3; n++) {
      await h.manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: null }));
      await settle(() => h.children.length > n, 2_000);
      await h.crash();
    }
    expect(h.children.length, "no daemon restart: each crash stays inactive").toBe(3);
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
  });
}, 20_000);

test("early crashes on two different sessions do not add up", async () => {
  await withManager(async (h) => {
    await h.wake("session-1");
    await h.crash();
    await h.wake("session-other");
    await h.crash();
    expect(resumeFailed(h).map((event) => [event.attrs.consecutive_count, event.attrs.fell_back_fresh])).toEqual([[1, false], [1, false]]);
    expect(invalidations(h)).toEqual([]);
  });
}, 20_000);

test("a runtime that names its session only at session_init: the resumed session is still invalidated", async () => {
  await withManager(async (h) => {
    await h.wake();
    await h.crash();
    await h.wake();
    await h.crash();
    await settle(() => h.children.length > 2, 2_000);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", null]);
    expect(invalidations(h)).toEqual([expect.objectContaining({ agentId: AGENT, sessionId: "session-1", reason: "repeated_early_crash" })]);
  }, { requiresSessionInitForDelivery: true });
}, 20_000);

test("an early exit 1 after a daemon-caused turn interrupt does not count", async () => {
  await withManager(async (h) => {
    await h.wake();
    for (let n = 0; n < 2; n++) {
      // The interrupt restarts the runtime itself; wake it only if it did not.
      if (n > 0 && !h.manager.idleNoticeFacts(AGENT) && h.children.at(-1)!.exitCode !== null) await h.wake();
      await h.manager.deliverMessage(AGENT, {
        channel_id: "channel-1", channel_name: "general", channel_type: "channel",
        sender_id: "user-1", sender_name: "andy", sender_type: "human",
        content: `work ${n}`, timestamp: "2026-11-04T00:00:00.000Z", message_id: `m-${n}`, seq: n + 1,
      });
      await h.emit([{ kind: "error", message: OPAQUE_ERROR }]);
      // The runtime dies on the daemon's SIGTERM with exit 1, inside the window.
      const child = h.children.at(-1)!;
      child.kill = () => { queueMicrotask(() => child.end(1)); return true; };
      const before = h.children.length;
      expect((await h.manager.interruptTurn(AGENT)).outcome).toBe("restarted");
      await settle(() => h.children.length > before, 2_000);
    }
    expect(h.spawnedSessionIds.length, "each interrupt ended a resumed launch").toBeGreaterThanOrEqual(2);
    expect(h.spawnedSessionIds.every((id) => id === "session-1"), "every launch resumed the session").toBe(true);
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
  });
}, 20_000);

test("an early exit 1 after the daemon stops a failed startup request does not count", async () => {
  await withManager(async (h) => {
    for (let n = 0; n < 2; n++) {
      await h.wake();
      const child = h.children.at(-1)!;
      child.kill = () => { queueMicrotask(() => child.end(1)); return true; };
      await h.emit([{ kind: "error", message: "initialize failed: invalid params", startupRequestMethod: "initialize" }]);
      await settle(() => child.exitCode !== null, 2_000);
      expect(child.exitCode, "the daemon terminated the launch").toBe(1);
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1"]);
  });
}, 20_000);

/** Past the credential hold's deadline without running its timer (CREDENTIAL_INVALID_CLOSED_HOLD_MS, 1 h). */
function passCredentialHold(): void {
  vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
}

test("early crashes on an action-required error (not logged in) do not count and keep the session", async () => {
  await withManager(async (h) => {
    const authError: ParsedEvent = { kind: "error", message: "Error: Not logged in · Please run /login" };
    for (let n = 0; n < 2; n++) {
      await h.wake();
      await h.crash(1, null, authError);
      // Task #50: the crash leaves the agent in the credential hold, which a
      // wake now waits out; the next wake comes after it.
      passCredentialHold();
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1"]);
  });
}, 20_000);

test("early exits whose stderr names an action-required error (not logged in) do not count and keep the session", async () => {
  // No error event: the close path finds the action-required failure itself.
  await withManager(async (h) => {
    for (let n = 0; n < 2; n++) {
      await h.wake();
      const child = h.children.at(-1)!;
      child.stderr.emit("data", Buffer.from("Error: Not logged in · Please run /login\n"));
      child.end(1);
      await settle();
      passCredentialHold();
    }
    expect(h.children.length, "no cold start").toBe(2);
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.spawnedSessionIds).toEqual(["session-1", "session-1"]);
  });
}, 20_000);

test("early crashes inside a provider-limit backoff do not count and keep the session", async () => {
  await withManager(async (h) => {
    const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const quota: ParsedEvent = { kind: "error", message: "You've reached your usage limit", providerLimit: { kind: "quota_exhausted", resetsAt } };
    for (let n = 0; n < 2; n++) {
      await h.wake();
      await h.crash(1, null, quota);
    }
    expect(resumeFailed(h)).toEqual([]);
    expect(invalidations(h)).toEqual([]);
    expect(h.spawnedSessionIds.every((id) => id === "session-1")).toBe(true);
  });
}, 20_000);
