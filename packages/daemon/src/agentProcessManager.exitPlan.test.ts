// Reconciler step 10a (#proj-raft-computer:#48, rows D1-D5; Tenny msg
// 89e55a48): the legacy close path gathers an exit's facts, `planExit`
// decides, the host acts. These walk each row through the real manager.
//
// RED proof (reverse-verified): count a D3 close toward the cap again and
// "D3 is never capped" is handed off at the fifth close; drop the cap from
// planExit (`handToServer` never true) and "capped" wakes a fifth time and
// shows no error;
// delete the restart snapshot on a D5 crash again and "D5 keeps the
// snapshot" finds none and the delivery does not wake the agent; stop
// counting D5 crashes into the streak (the loop guard) and the bad-session
// walk keeps restarting past the cap.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { noteRaftMessageSendOutcome } from "./runtimeCommunicationTrace";
import { CRASH_STREAK_CAP } from "./planExit";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-exit-plan";
const CONNECTION_ERROR = "Error: Unable to connect to API (ECONNREFUSED)";
const SERVER_ERROR = "API Error: 503 Service Unavailable";
// Not a text any runtime's resume matcher knows, and not a recoverable error.
const OPAQUE_ERROR = "Error: something went wrong while loading the conversation";
const SHARED_CODEX = "shared:codex";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = { write: (chunk: string) => { this.writes.push(String(chunk)); return true; } };
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

type Internals = {
  agents: Map<string, { inbox: AgentMessage[] }>;
  lifecycleRecords: {
    getRuntimeErrorCloseStreak(agentId: string): number;
    getRestartSnapshot(agentId: string): { sessionId: string | null; config: AgentConfig } | undefined;
    getProviderLimit(key: string, nowMs: number): { untilMs: number } | undefined;
  };
};

type Sent = Record<string, any>;

type Harness = {
  manager: AgentProcessManager;
  m: Internals;
  children: FakeChild[];
  spawnedSessionIds: Array<string | null>;
  prompts: string[];
  sent: Sent[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
  /**
   * The runtime prints `error` on stderr, then exits with `code`. Not an
   * error event: identical ones would trip the same-fingerprint fence (its
   * own loop guard) before the paths under test.
   */
  crash: (code?: number | null, error?: string | null) => Promise<void>;
  cleanExit: () => Promise<void>;
  /** A server start of the agent on `sessionId`. */
  wake: (sessionId?: string | null) => Promise<void>;
  deliver: (content: string) => Promise<boolean>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "andy", sender_type: "human",
    content, timestamp: "2026-11-05T00:00:00.000Z",
    message_id: `m-${seq}`, seq,
  };
}

async function settle(until: () => boolean = () => false, realMs = 100): Promise<void> {
  const deadline = performance.now() + realMs;
  while (!until() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function withManager(run: (h: Harness) => Promise<void>, driverOverrides: Partial<RuntimeDriver> = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-exit-plan-test-"));
  const children: FakeChild[] = [];
  const spawnedSessionIds: Array<string | null> = [];
  const prompts: string[] = [];
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
      prompts.push(ctx.prompt);
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
  const sent: Sent[] = [];
  const manager = new AgentProcessManager((msg) => { sent.push(msg as unknown as Sent); }, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    runtimeErrorDeliveryBackoff: { jitterRatio: 0 },
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  const events: Harness["events"] = [];
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
  const crash = async (code: number | null = 1, error: string | null = OPAQUE_ERROR) => {
    const child = children.at(-1)!;
    if (error) child.stderr.emit("data", Buffer.from(`${error}\n`));
    child.end(code);
    await settle();
  };
  const cleanExit = async () => {
    children.at(-1)!.end(0);
    await settle();
  };
  const wake = async (sessionId: string | null = "session-1") => {
    const before = children.length;
    await manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId }));
    await settle(() => children.length > before, 2_000);
    expect(children.length, "the wake spawned a process").toBe(before + 1);
  };
  const deliver = async (content: string) => {
    const accepted = await manager.deliverMessage(AGENT, message(content));
    await settle();
    return accepted;
  };
  try {
    await run({ manager, m, children, spawnedSessionIds, prompts, sent, events, emit, crash, cleanExit, wake, deliver });
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

const plans = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.exit.planned").map((event) => event.attrs);
const invalidations = (h: Harness) => h.sent.filter((msg) => msg.type === "agent:session:invalidate");
const scheduledDelays = (h: Harness) => h.events
  .filter((event) => event.name === "daemon.agent.runtime_error_process_restart.scheduled")
  .map((event) => event.attrs.delay_ms);
/** How many times `content` reached a runtime: in a spawn's first input or written to stdin. */
const deliveredCount = (h: Harness, content: string) => [...h.prompts, ...h.children.flatMap((child) => child.writes)]
  .reduce((count, text) => count + text.split(content).length - 1, 0);

/** The agent's state as the server last heard it. */
function lastShown(h: Harness) {
  const status = h.sent.filter((msg) => msg.type === "agent:status").at(-1);
  const activity = h.sent.filter((msg) => msg.type === "agent:activity" && !msg.isHeartbeat).at(-1);
  return { status, activity };
}

async function startWithPending(h: Harness, content: string): Promise<void> {
  await h.wake();
  await h.deliver(content);
  expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content), "the delivery is queued in the running process").toEqual([content]);
}

describe("reconciler step 10a: the legacy close path acts on planExit", () => {
  // A runtime that takes no input while it runs: what arrives during a turn
  // waits in the inbox for the turn's end.
  const turnOnly: Partial<RuntimeDriver> = { supportsStdinNotification: false, busyDeliveryMode: "none" };

  test("D1: a clean exit with work queued starts again at once, and the work reaches the runtime once", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "queued-before-exit");
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      await settle(() => h.children.length > 1, 2_000);
      expect(h.children.length, "restarted at once").toBe(2);
      expect(h.spawnedSessionIds, "on the same session").toEqual(["session-1", "session-1"]);
      expect(deliveredCount(h, "queued-before-exit"), "delivered once").toBe(1);
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", plan_start: "now", keep_snapshot: true });
    }, turnOnly);
  }, 20_000);

  test("D1 with a provider limit on the credential: held until the limit ends, then started with the work once", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "queued-in-limit");
      const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await h.emit([{ kind: "error", message: "You've reached your usage limit", providerLimit: { kind: "quota_exhausted", resetsAt } }]);
      const untilMs = h.m.lifecycleRecords.getProviderLimit(SHARED_CODEX, Date.now())!.untilMs;
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", plan_start: "after", plan_hold: "provider_limit" });
      await vi.advanceTimersByTimeAsync(untilMs - Date.now() - 10);
      await settle();
      expect(h.children.length, "held while the limit runs").toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.children.length, "started when it ends").toBe(2);
      expect(deliveredCount(h, "queued-in-limit"), "delivered once").toBe(1);
    }, turnOnly);
  }, 20_000);

  test("D2: a clean exit with nothing queued waits for the next wake, which resumes the session", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await settle();
      expect(h.children.length, "no restart").toBe(1);
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", plan_start: "next_wake" });
      expect(await h.deliver("next")).toBe(true);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.spawnedSessionIds).toEqual(["session-1", "session-1"]);
    });
  }, 20_000);

  // Tenny, review of #13328: a provider outage must not hand the agent to
  // the server (whose start-failure pause would outlast the outage). Its
  // closes back off to the 5 min max and the agent keeps trying until the
  // provider answers, then runs the queued work once.
  test("D3 is never capped: a 30 min provider outage backs off to 5 min and keeps trying; the agent runs the queued work once the provider is back", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "queued before the outage");
      const outageEndsAt = Date.now() + 30 * 60_000;
      let closes = 0;
      while (Date.now() < outageEndsAt) {
        closes += 1;
        await h.crash(1, closes % 2 === 0 ? SERVER_ERROR : CONNECTION_ERROR);
        if (closes === 3) expect(await h.deliver("queued during the outage")).toBe(true);
        const delayMs = scheduledDelays(h).at(-1) as number;
        expect(delayMs, "the backoff never passes 5 min").toBeLessThanOrEqual(5 * 60_000);
        const before = h.children.length;
        await vi.advanceTimersByTimeAsync(delayMs);
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `respawn ${closes} after ${delayMs}ms`).toBe(before + 1);
      }
      expect(closes, "well past the cap").toBeGreaterThanOrEqual(2 * CRASH_STREAK_CAP);
      expect(scheduledDelays(h)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, ...Array(closes - 5).fill(300_000)]);
      expect(plans(h).every((plan) => plan.plan_kind === "recoverable" && !plan.hand_to_server && plan.cap_streak === 0)).toBe(true);
      expect(h.events.some((event) => event.name === "daemon.agent.spawn.local_restart_stopped"), "never handed off").toBe(false);
      expect(h.sent.some((msg) => msg.type === "agent:activity" && msg.spawnFailure?.reason === "runtime_spawn_failed"), "never a failed start").toBe(false);
      expect(h.sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"), "never inactive").toBe(false);
      expect(h.sent.some((msg) => msg.type === "agent:activity" && /crashed \d+ times in a row/.test(String(msg.detail ?? ""))), "never \"crashed N times\"").toBe(false);

      // The provider is back: the last respawn (at most 5 min after the last
      // close) holds the queued work once each, in order, and its model
      // output ends the streak.
      const recovered = h.children.at(-1)!;
      expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content), "the queued work, once each").toEqual(["queued before the outage", "queued during the outage"]);
      expect(h.prompts.at(-1), "the recovered process is woken by it").toContain("queued during the outage");
      await h.emit([{ kind: "text", text: "working again" }]);
      expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(0);
      expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["queued before the outage", "queued during the outage"]);
      expect(h.children.at(-1), "running").toBe(recovered);
    });
  }, 60_000);

  test(`capped: the ${CRASH_STREAK_CAP}th unclassified crash in a row goes to the server with an error to restart from and the exit's facts; Retry clears it`, async () => {
    await withManager(async (h) => {
      // Each crash comes after the resume window, so no resume failure (D4) intervenes.
      const crashLate = async () => {
        await vi.advanceTimersByTimeAsync(16_000);
        await h.crash(1, OPAQUE_ERROR);
      };
      await startWithPending(h, "work that keeps failing");
      for (let n = 1; n < CRASH_STREAK_CAP; n += 1) {
        await crashLate();
        const before = h.children.length;
        expect(await h.deliver(`wake ${n}`)).toBe(true);
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `the delivery after crash ${n} wakes it`).toBe(before + 1);
      }
      await crashLate();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(h.children.length, "no self-restart after the cap").toBe(CRASH_STREAK_CAP);
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "crash", plan_start: "none", hand_to_server: true, crash_streak: CRASH_STREAK_CAP, cap_streak: CRASH_STREAK_CAP, keep_snapshot: false });
      // The hand-off names the last exit (sanitized) so a provider error the
      // classes missed can be told apart in the traces.
      const stopped = h.events.find((event) => event.name === "daemon.agent.spawn.local_restart_stopped")?.attrs;
      expect(stopped).toMatchObject({
        source: "process_close", failure_reason: "crash", stop_cause: "attempts_exhausted", attempts: CRASH_STREAK_CAP, crash_streak: CRASH_STREAK_CAP,
        exit_kind: "crash", exit_code: 1, runtime_error_class: "RuntimeError",
        runtime_error_fingerprint: expect.any(String), exit_uptime_ms_bucket: expect.any(String),
      });
      expect(stopped?.exit_signal).toBeUndefined();
      expect(JSON.stringify(stopped), "no error text").not.toContain("went wrong");
      // Visible: inactive, a failed start for the server's start-failure
      // breaker (F2), and last an error with no required action (Restart).
      expect(h.sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive" && msg.exit?.code === 1)).toBe(true);
      expect(h.sent.some((msg) => msg.type === "agent:activity" && msg.spawnFailure?.reason === "runtime_spawn_failed")).toBe(true);
      const shown = lastShown(h);
      expect(shown.status).toMatchObject({ status: "inactive" });
      expect(shown.activity).toMatchObject({ detailKind: "runtime_error", detail: expect.stringContaining(`crashed ${CRASH_STREAK_CAP} times in a row`) });
      expect(shown.activity?.runtimeError).toMatchObject({ errorClass: expect.any(String) });
      expect(shown.activity?.runtimeError?.requiredAction).toBeUndefined();
      expect(shown.activity?.detail).not.toMatch(/^Process idle/);
      // Handed over: nothing left for the daemon to restart from.
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)).toBeUndefined();
      expect(await h.deliver("after the hand-off")).toBe(false);
      expect(h.children.length, "a delivery does not restart it").toBe(CRASH_STREAK_CAP);

      // Retry = the server's restart: an explicit stop (ends the streak), then a start.
      await h.manager.stopAgent(AGENT);
      expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(0);
      await startWithPending(h, "after retry");
      await crashLate();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "crash", crash_streak: 1, cap_streak: 1 });
      expect(h.events.filter((event) => event.name === "daemon.agent.spawn.local_restart_stopped")).toHaveLength(1);
    });
  }, 30_000);

  test("D4: two early crashes in a row on the resumed session: chooseSession starts a new one at once", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.crash();
      await h.wake();
      await h.crash();
      await settle(() => h.children.length > 2, 2_000);
      expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", null]);
      expect(invalidations(h)).toEqual([expect.objectContaining({ sessionId: "session-1", reason: "repeated_early_crash" })]);
      expect(plans(h).map((plan) => [plan.plan_kind, plan.plan_session])).toEqual([["crash", "resume"], ["resume_failed", "new:resume_failed"]]);
    });
  }, 20_000);

  test("D5: a crash keeps the restart snapshot; the next wake resumes the session from it", async () => {
    await withManager(async (h) => {
      await h.wake();
      // Model output: not an early crash of a resumed session.
      await h.emit([{ kind: "text", text: "working" }]);
      await h.crash();
      expect(h.m.agents.has(AGENT)).toBe(false);
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "crash", plan_start: "next_wake", keep_snapshot: true, crash_streak: 1 });
      expect(lastShown(h).status).toMatchObject({ status: "inactive", exit: { code: 1, signal: null } });
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, "the snapshot is the agent's state").toBe("session-1");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await settle();
      expect(h.children.length, "no restart of its own").toBe(1);
      expect(await h.deliver("next wake")).toBe(true);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.spawnedSessionIds, "the next wake resumes the session").toEqual(["session-1", "session-1"]);
      expect(deliveredCount(h, "next wake")).toBe(1);
    });
  }, 20_000);

  // A process per turn, like OpenCode, Cursor, Gemini and Copilot.
  const perTurn: Partial<RuntimeDriver> = {
    ...turnOnly,
    lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "coalesce_into_pending" },
  };

  test("D6: a per-turn runtime that keeps ending turns having done nothing backs off, then stops with an error", async () => {
    await withManager(async (h) => {
      // The field case: OpenCode 1.17.13 exited 0 with no events every 38 s, for days, with the same message.
      await startWithPending(h, "never-handled");
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "zero_evidence_turn", plan_start: "after", crash_streak: 1 });
      expect(h.children.length, "not restarted at once").toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.children.length, "restarted after the backoff").toBe(2);
      for (let turn = 2; turn < CRASH_STREAK_CAP; turn += 1) {
        await h.deliver(`never-handled-${turn}`);
        await h.cleanExit();
        expect(plans(h).at(-1)).toMatchObject({ plan_kind: "zero_evidence_turn", crash_streak: turn });
        await vi.advanceTimersByTimeAsync(10_000 * 2 ** (turn - 1));
        await settle(() => h.children.length > turn, 2_000);
        expect(h.children.length, `restarted for turn ${turn + 1}`).toBe(turn + 1);
      }
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "zero_evidence_turn", crash_streak: CRASH_STREAK_CAP, hand_to_server: true });
      const shown = lastShown(h);
      expect(shown.status).toMatchObject({ status: "inactive" });
      expect(shown.activity).toMatchObject({ detailKind: "runtime_error", detail: expect.stringContaining("turns in a row without any output") });
      expect(shown.activity?.detail).toContain("logs");
      expect(h.sent.some((msg) => msg.type === "agent:activity" && msg.spawnFailure?.reason === "runtime_spawn_failed"), "the failed start reaches the server's breaker").toBe(true);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(h.children.length, "no restart after the cap").toBe(CRASH_STREAK_CAP);
      const stopped = h.events.find((event) => event.name === "daemon.agent.spawn.local_restart_stopped")?.attrs;
      expect(stopped).toMatchObject({ exit_kind: "zero_evidence_turn", runtime_cli_version: "9.9.9" });
      expect(stopped).toHaveProperty("model");
    }, { ...perTurn, launchedCliVersion: "9.9.9" });
  }, 30_000);

  test("D6: a turn with output clears the count, and a long-lived process never counts", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "one");
      await h.cleanExit();
      expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT)).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await settle(() => h.children.length > 1, 2_000);
      await h.emit([{ kind: "text", text: "An answer." }]);
      expect(h.m.lifecycleRecords.getRuntimeErrorCloseStreak(AGENT), "output clears it").toBe(0);
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", crash_streak: 0 });
    }, perTurn);
    await withManager(async (h) => {
      await startWithPending(h, "two");
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", crash_streak: 0 });
    }, turnOnly);
  }, 30_000);

  test.each<[string, ParsedEvent[]]>([
    ["only `init` and `result` (Gemini, Cursor)", [{ kind: "session_init", sessionId: "session-1" }, { kind: "turn_end", sessionId: "session-1" }]],
    ["only an empty thinking marker and no end event (OpenCode 2.x)", [{ kind: "thinking", text: "" }]],
  ])("D6: a turn with nothing to do reports %s: a clean exit, at once and uncounted", async (_shape, events) => {
    await withManager(async (h) => {
      for (let turn = 1; turn <= CRASH_STREAK_CAP + 1; turn += 1) {
        if (turn === 1) await startWithPending(h, "a system message");
        else await h.deliver(`a system message ${turn}`);
        await h.emit(events);
        await h.cleanExit();
        expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", crash_streak: 0 });
        await settle(() => h.children.length > turn, 2_000);
        expect(h.children.length, "restarted at once").toBe(turn + 1);
      }
    }, perTurn);
  }, 30_000);

  test.each(["sent", "held"] as const)("D6: a send through the CLI (%s) is a sign the turn ran, with no event parsed", async (outcome) => {
    await withManager(async (h) => {
      await startWithPending(h, "one");
      noteRaftMessageSendOutcome((h.m as any).agents.get(AGENT).runtimeTraceCounters, outcome);
      await h.cleanExit();
      expect(plans(h).at(-1)).toMatchObject({ plan_kind: "clean", crash_streak: 0 });
    }, perTurn);
  }, 30_000);

  test("D6: a turn that reports only an error and exits 0 (Gemini after a blocked stream) backs off, then stops", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "blocked");
      for (let turn = 1; turn <= CRASH_STREAK_CAP; turn += 1) {
        await h.emit([{ kind: "session_init", sessionId: "session-1" }, { kind: "error", message: "The stream was blocked." }, { kind: "turn_end", sessionId: "session-1" }]);
        await h.cleanExit();
        expect(plans(h).at(-1)).toMatchObject({ plan_kind: "zero_evidence_turn", crash_streak: turn, ...(turn === CRASH_STREAK_CAP ? { hand_to_server: true } : { plan_start: "after" }) });
        if (turn === CRASH_STREAK_CAP) break;
        expect(h.children.length, "not restarted at once").toBe(turn);
        await vi.advanceTimersByTimeAsync(10_000 * 2 ** (turn - 1));
        await settle(() => h.children.length > turn, 2_000);
        await h.deliver(`blocked-${turn}`);
      }
    }, perTurn);
  }, 30_000);

  test("D6: an error after output is the turn's own business: a clean exit", async () => {
    await withManager(async (h) => {
      await startWithPending(h, "one");
      await h.emit([{ kind: "text", text: "Partly done." }, { kind: "error", message: "Something went wrong." }]);
      await h.cleanExit();
      expect(plans(h).at(-1)?.plan_kind).not.toBe("zero_evidence_turn");
    }, perTurn);
  }, 30_000);

  // Tenny msg 89e55a48 (b): keeping the snapshot must not make a loop. A
  // session that keeps crashing early: two resumes fail, chooseSession
  // replaces it (D4), the new session fails the same way, and every crash
  // counts into the crash streak until its cap stops the daemon's own
  // restarts and shows an error; the server's breakers own what follows.
  test("a bad session that crashes over and over: resume, new session, then stopped with an error", async () => {
    await withManager(async (h) => {
      // 1. A server start resumes session-1; it crashes early (resume failure 1, streak 1).
      await h.wake("session-1");
      await h.crash();
      // 2. The next server start resumes it again: resume failure 2 → a new session at once (streak 2).
      await h.wake("session-1");
      await h.crash();
      await settle(() => h.children.length > 2, 2_000);
      expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", null]);
      expect(invalidations(h).map((msg) => msg.sessionId)).toEqual(["session-1"]);
      // 3. The new session names itself and crashes (not a resume: streak 3; the snapshot keeps session-2).
      await h.emit([{ kind: "session_init", sessionId: "session-2" }]);
      await h.crash();
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId).toBe("session-2");
      // 4. A delivery wakes it from the snapshot, resuming session-2: crash (resume failure 1, streak 4).
      expect(await h.deliver("wake 4")).toBe(true);
      await settle(() => h.children.length > 3, 2_000);
      await h.crash();
      // 5. Again: resume failure 2 on session-2 and streak 5: the cap wins over a new session.
      expect(await h.deliver("wake 5")).toBe(true);
      await settle(() => h.children.length > 4, 2_000);
      expect(h.spawnedSessionIds).toEqual(["session-1", "session-1", null, "session-2", "session-2"]);
      await h.crash();
      expect(plans(h).map((plan) => [plan.plan_kind, plan.crash_streak, plan.hand_to_server ?? false])).toEqual([
        ["crash", 1, false],
        ["resume_failed", 2, false],
        ["crash", 3, false],
        ["crash", 4, false],
        ["resume_failed", CRASH_STREAK_CAP, true],
      ]);
      // Stopped: the bad session is dropped on the server too, an error shows, nothing restarts.
      expect(invalidations(h).map((msg) => msg.sessionId)).toEqual(["session-1", "session-2"]);
      const shown = lastShown(h);
      expect(shown.status).toMatchObject({ status: "inactive" });
      expect(shown.activity).toMatchObject({ detailKind: "runtime_error", detail: expect.stringContaining(`crashed ${CRASH_STREAK_CAP} times in a row`) });
      expect(shown.activity?.runtimeError?.requiredAction).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(await h.deliver("wake 6")).toBe(false);
      expect(h.children.length, "no restart after the cap").toBe(5);
      // A later delivery finds no process and shows the same failure again (never idle).
      expect(lastShown(h).activity).toMatchObject({ detailKind: "runtime_unavailable", detail: shown.activity?.detail });
    });
  }, 30_000);
});
