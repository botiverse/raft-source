// Reconciler step 12 (#proj-raft-computer:#48, rows C8-C11; Tenny msg
// 96fa8766): a failure a runtime reports after it started no longer leaves a
// terminal record that any start clears. The session is replaced once (C8, a
// failed compaction), or the agent goes back to the server at the first
// report with a typed start-failure reason (C9, C11, the crash-streak cap,
// C10's cap). Every round here is start, `agent:runtime:ready`, then the
// failure: the start's readiness ends the server's own failed-start count, so
// a hand-off that relied on that count would never pause (the hole this step
// closes).
//
// RED proof (reverse-verified): start the new session without the anti-loop
// record (`actOnStickyFailure` never reads `sessionReset`) and "C8 a second
// time" starts a third process; report `runtime_spawn_failed` from
// `handStickyFailureToServer` whatever the server says and "C9 to a server
// that counts it" finds no `model_unsupported`; keep the 404 count on the
// process again (reset it at every start) and "the 404 count grows across
// respawns" never trips;
// report `runtime_spawn_failed` from `handCrashStreakToServer` and "the crash
// cap" finds no `runtime_repeated_failure`.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { CRASH_STREAK_CAP } from "./planExit";
import type { StickyFailureRecords } from "./stickyFailureRecords";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-sticky";
const TOO_LARGE = "API Error: 400 maximum context length is 100 tokens; you requested 101 tokens";
const MODEL_ERROR = "The requested model is not supported for this account.";
const SAME_ERROR = "Error: deterministic tool failure in the runtime";
const OPAQUE_ERROR = "Error: something went wrong while loading the conversation";
const notFound = (n: number) => `unexpected status 404 Not Found: model gpt-x unavailable, request req_${"abcdefghij"[n % 10]}Zq${n}x`;

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
  agents: Map<string, { inbox: AgentMessage[]; config: AgentConfig }>;
  startingInboxes: { values(agentId: string): AgentMessage[] };
  lifecycleRecords: {
    getRestartSnapshot(agentId: string): { sessionId: string | null; config: AgentConfig } | undefined;
    getTerminalFailure(agentId: string): unknown;
    getRuntimeErrorFingerprintFence(agentId: string): { attempts: number } | undefined;
    getRuntimeErrorClassFence(agentId: string): { attempts: number } | undefined;
    getCrashCapStreak(agentId: string): number;
    exitStreaks: { sticky: StickyFailureRecords };
  };
};

type Sent = Record<string, any>;

type Harness = {
  manager: AgentProcessManager;
  m: Internals;
  children: FakeChild[];
  spawnedSessionIds: Array<string | null>;
  spawnedModels: Array<string | null | undefined>;
  sent: Sent[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
  /** A server start (`launchId`), then the runtime's first event: the start is ready. */
  startReady: (launchId: string, overrides?: Partial<AgentConfig>) => Promise<void>;
  crash: (error?: string) => Promise<void>;
  deliver: (content: string) => Promise<boolean>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "andy", sender_type: "human",
    content, timestamp: "2026-11-07T00:00:00.000Z",
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

async function withManager(run: (h: Harness) => Promise<void>, options: { capable?: boolean } = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-sticky-failure-test-"));
  const children: FakeChild[] = [];
  const spawnedSessionIds: Array<string | null> = [];
  const spawnedModels: Array<string | null | undefined> = [];
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
      spawnedModels.push(ctx.config.model);
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
  const sent: Sent[] = [];
  const manager = new AgentProcessManager((msg) => { sent.push(msg as unknown as Sent); }, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    runtimeErrorDeliveryBackoff: { jitterRatio: 0 },
    runtimeStartScheduler: { minStartIntervalMs: 0 },
  });
  if (options.capable) manager.setServerStickyFailureReasonsCapable(true);
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
  const startReady = async (launchId: string, overrides: Partial<AgentConfig> = {}) => {
    const before = children.length;
    await manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1", ...overrides }), undefined, undefined, undefined, launchId);
    await settle(() => children.length > before, 2_000);
    expect(children.length, "the start spawned a process").toBe(before + 1);
    await emit([{ kind: "session_init", sessionId: overrides.sessionId ?? "session-1" }]);
    expect(readyFrames({ sent } as Harness).at(-1)?.launchId, "the start is ready").toBe(launchId);
  };
  // Exit 137: a crash the cap counts, never an early crash of a resumed
  // session (D4 would start a new session by itself).
  const crash = async (error = OPAQUE_ERROR) => {
    const child = children.at(-1)!;
    child.stderr.emit("data", Buffer.from(`${error}\n`));
    child.end(137);
    await settle();
  };
  const deliver = async (content: string) => {
    const accepted = await manager.deliverMessage(AGENT, message(content));
    await settle();
    return accepted;
  };
  try {
    await run({ manager, m, children, spawnedSessionIds, spawnedModels, sent, events, emit, startReady, crash, deliver });
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

const readyFrames = (h: Pick<Harness, "sent">) => h.sent.filter((msg) => msg.type === "agent:runtime:ready");
/** The typed start failures reported, one per hand-off (a later refused delivery shows the last one again). */
const startFailures = (h: Harness) => h.sent
  .filter((msg) => msg.type === "agent:activity" && msg.spawnFailure)
  .map((msg) => ({ reason: msg.spawnFailure.reason as string, launchId: msg.launchId as string | undefined }));
const handOffs = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.sticky_failure.handed_to_server").map((event) => event.attrs);
const invalidations = (h: Harness) => h.sent.filter((msg) => msg.type === "agent:session:invalidate").map((msg) => ({ sessionId: msg.sessionId, reason: msg.reason }));
const pendingContents = (h: Harness) => [
  ...(h.m.agents.get(AGENT)?.inbox ?? []),
  ...h.m.startingInboxes.values(AGENT),
].map((entry) => entry.content);

describe("reconciler step 12, C8: a session that no longer fits is replaced once", () => {
  test("with queued deliveries: one new process on a new session, the deliveries carried; again in it: session_needs_reset, no restart", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.deliver("first queued");
      await h.deliver("second queued");
      expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content), "both are queued in the running process").toEqual(["first queued", "second queued"]);

      await h.emit([{ kind: "error", message: TOO_LARGE }]);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.children.length, "exactly one new process").toBe(2);
      expect(h.spawnedSessionIds, "the new one on a new session").toEqual(["session-1", null]);
      expect(invalidations(h), "the server forgets the old session").toEqual([{ sessionId: "session-1", reason: "input_too_large" }]);
      expect(pendingContents(h), "the deliveries are carried into it").toEqual(expect.arrayContaining(["first queued", "second queued"]));
      expect(h.m.lifecycleRecords.getTerminalFailure(AGENT), "no terminal record").toBeUndefined();
      expect(startFailures(h), "no start failure: the agent recovers by itself").toEqual([]);

      // The new session is ready, then fails the same way before any model output.
      await h.emit([{ kind: "session_init", sessionId: "session-2" }]);
      expect(readyFrames(h)).toHaveLength(2);
      await h.emit([{ kind: "error", message: TOO_LARGE }]);
      await settle(() => false, 200);
      expect(h.children.length, "no third process").toBe(2);
      expect(startFailures(h)).toEqual([{ reason: "session_needs_reset", launchId: "launch-1" }]);
      expect(invalidations(h), "the session the person resets is not dropped again").toHaveLength(1);
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT), "the server owns the next start").toBeUndefined();
      expect(h.sent.filter((msg) => msg.type === "agent:status").at(-1)?.status).toBe("inactive");

      // A message finds no process: it does not start one either.
      expect(await h.deliver("after the reset request")).toBe(false);
      expect(h.children.length).toBe(2);
    });
  }, 20_000);

  test("a turn of the new session that completes with output makes the next overflow a new session again", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.deliver("queued");
      await h.emit([{ kind: "error", message: TOO_LARGE }]);
      await settle(() => h.children.length > 1, 2_000);
      await h.emit([{ kind: "session_init", sessionId: "session-2" }, { kind: "text", text: "on it" }, { kind: "turn_end", sessionId: "session-2" }]);
      expect(h.m.lifecycleRecords.exitStreaks.sticky.sessionReset(AGENT), "the new session fits").toBeNull();
      await h.deliver("much later");
      await h.emit([{ kind: "error", message: TOO_LARGE }]);
      await settle(() => h.children.length > 2, 2_000);
      expect(h.children.length, "a new session again").toBe(3);
      expect(startFailures(h)).toEqual([]);
    });
  }, 20_000);

  test("with nothing queued: no process now, the next delivery starts the new session", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.emit([{ kind: "error", message: TOO_LARGE }]);
      await settle();
      expect(h.children.length).toBe(1);
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, "kept wakeable, on no session").toBeNull();
      expect(invalidations(h)).toEqual([{ sessionId: "session-1", reason: "input_too_large" }]);
      expect(await h.deliver("wake")).toBe(true);
      await settle(() => h.children.length > 1, 2_000);
      expect(h.spawnedSessionIds).toEqual(["session-1", null]);
    });
  }, 20_000);
});

describe("reconciler step 12, C9: a model the runtime cannot use goes to the server at once", () => {
  test("to a server that counts it: model_unsupported once; deliveries do not start it; a model change does", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.deliver("queued");
      await h.emit([{ kind: "error", message: MODEL_ERROR }]);
      expect(h.m.agents.has(AGENT), "the process ended at the error").toBe(false);
      expect(handOffs(h)).toHaveLength(1);
      expect(startFailures(h)).toEqual([{ reason: "model_unsupported", launchId: "launch-1" }]);
      expect(h.m.lifecycleRecords.getTerminalFailure(AGENT)).toBeUndefined();

      expect(await h.deliver("later one")).toBe(false);
      expect(await h.deliver("later two")).toBe(false);
      await settle(() => false, 200);
      expect(h.children.length, "no delivery starts it").toBe(1);
      expect(handOffs(h), "reported once").toHaveLength(1);
      expect(new Set(startFailures(h).map((failure) => failure.reason))).toEqual(new Set(["model_unsupported"]));

      await h.startReady("launch-2", { model: "another-model" });
      expect(h.spawnedModels.at(-1)).toBe("another-model");
      expect(h.m.lifecycleRecords.exitStreaks.sticky.isUnusableModel(AGENT, "claude", "another-model")).toBe(false);
      expect(h.m.lifecycleRecords.exitStreaks.sticky.unusableModelAgents(), "a model change clears the record").toEqual([]);
    }, { capable: true });
  }, 20_000);

  test("the daemon does not start it itself on the same model; model output clears the record", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.emit([{ kind: "error", message: MODEL_ERROR }]);
      // The server's start on the same model (a person's, say) runs; it exits
      // with no model output, leaving a restart snapshot behind.
      await h.startReady("launch-2");
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      h.children.at(-1)!.end(0);
      await settle();
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT), "precondition: a restart snapshot").toBeDefined();
      expect(await h.deliver("would restart it")).toBe(false);
      expect(h.children.length, "not restarted into the same model").toBe(2);
      expect(h.events.some((event) => event.name === "daemon.agent.restart.refused_unusable_model")).toBe(true);

      await h.startReady("launch-3");
      await h.emit([{ kind: "text", text: "it works after all" }]);
      expect(h.m.lifecycleRecords.exitStreaks.sticky.unusableModelAgents()).toEqual([]);
    }, { capable: true });
  }, 20_000);

  test("to a server without the capability: runtime_spawn_failed instead", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      await h.emit([{ kind: "error", message: MODEL_ERROR }]);
      expect(startFailures(h)).toEqual([{ reason: "runtime_spawn_failed", launchId: "launch-1" }]);
      expect(handOffs(h)[0]).toMatchObject({ reason: "model_unsupported", reported_reason: "runtime_spawn_failed" });
    });
  }, 20_000);
});

describe("reconciler step 12, C11: the fences hand the agent to the server at the first trip", () => {
  test("the same-fingerprint count grows across respawns and trips with runtime_repeated_failure", async () => {
    await withManager(async (h) => {
      for (let round = 1; round <= 3; round += 1) {
        await h.startReady(`launch-${round}`);
        await h.emit([{ kind: "error", message: SAME_ERROR }]);
        if (round < 3) {
          expect(h.m.lifecycleRecords.getRuntimeErrorFingerprintFence(AGENT)?.attempts, `round ${round}`).toBe(round);
          await h.crash();
          expect(h.m.lifecycleRecords.getRuntimeErrorFingerprintFence(AGENT)?.attempts, "kept across the exit").toBe(round);
        }
      }
      expect(h.m.agents.has(AGENT)).toBe(false);
      expect(startFailures(h)).toEqual([{ reason: "runtime_repeated_failure", launchId: "launch-3" }]);
      expect(h.m.lifecycleRecords.getTerminalFailure(AGENT)).toBeUndefined();
      expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)).toBeUndefined();
      expect(await h.deliver("after the trip")).toBe(false);
      expect(h.children.length).toBe(3);
    }, { capable: true });
  }, 20_000);

  test("the 404 count grows across respawns (it lives in the lifecycle records) and trips with runtime_repeated_failure", async () => {
    await withManager(async (h) => {
      let n = 0;
      for (let round = 1; round <= 3; round += 1) {
        await h.startReady(`launch-${round}`);
        for (let each = 0; each < 2 && n < 5; each += 1) await h.emit([{ kind: "error", message: notFound(n++) }]);
        if (n < 5) {
          expect(h.m.lifecycleRecords.getRuntimeErrorClassFence(AGENT)?.attempts, `after round ${round}`).toBe(n);
          await h.crash();
          expect(h.m.lifecycleRecords.getRuntimeErrorClassFence(AGENT)?.attempts, "kept across the exit").toBe(n);
        }
      }
      expect(h.m.agents.has(AGENT)).toBe(false);
      expect(startFailures(h)).toEqual([{ reason: "runtime_repeated_failure", launchId: "launch-3" }]);
      expect(h.m.lifecycleRecords.getRuntimeErrorClassFence(AGENT), "the server's try counts from zero").toBeUndefined();
    }, { capable: true });
  }, 20_000);

  test("to a server without the capability: runtime_spawn_failed instead", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      for (let each = 0; each < 3; each += 1) await h.emit([{ kind: "error", message: SAME_ERROR }]);
      expect(startFailures(h)).toEqual([{ reason: "runtime_spawn_failed", launchId: "launch-1" }]);
    });
  }, 20_000);
});

describe("reconciler step 12: crashes the daemon counted after the start was ready", () => {
  test("the crash cap reports runtime_repeated_failure, which the start's readiness cannot reset", async () => {
    await withManager(async (h) => {
      for (let round = 1; round <= CRASH_STREAK_CAP; round += 1) {
        await h.startReady(`launch-${round}`);
        await h.crash();
      }
      expect(startFailures(h)).toEqual([{ reason: "runtime_repeated_failure", launchId: `launch-${CRASH_STREAK_CAP}` }]);
      // The cap streak stays at the cap: the server's next try that crashes is handed back at once, with the same reason.
      await h.startReady("launch-next");
      await h.crash();
      expect(startFailures(h).at(-1)).toEqual({ reason: "runtime_repeated_failure", launchId: "launch-next" });
    }, { capable: true });
  }, 30_000);

  test("C10: a Codex turn that did nothing counts like a crash and is handed over at the cap", async () => {
    await withManager(async (h) => {
      await h.startReady("launch-1");
      const zeroEvidence = "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)";
      for (let turn = 1; turn < CRASH_STREAK_CAP; turn += 1) {
        await h.emit([{ kind: "error", message: zeroEvidence }, { kind: "turn_end", sessionId: "session-1" }]);
        expect(h.m.agents.has(AGENT), `turn ${turn}: the process stays`).toBe(true);
        expect(h.m.lifecycleRecords.getCrashCapStreak(AGENT)).toBe(turn);
      }
      expect(startFailures(h), "not sticky: nothing reported before the cap").toEqual([]);
      expect(h.m.lifecycleRecords.getRuntimeErrorFingerprintFence(AGENT), "not counted by the same-fingerprint fence").toBeUndefined();
      await h.emit([{ kind: "error", message: zeroEvidence }]);
      expect(h.m.agents.has(AGENT)).toBe(false);
      expect(startFailures(h)).toEqual([{ reason: "runtime_repeated_failure", launchId: "launch-1" }]);
    }, { capable: true });
  }, 20_000);
});
