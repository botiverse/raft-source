// #raft-antiproton:#14: a runtime process that ends abnormally drops the
// deliveries it acked and never handed to the agent (task #353 records them
// as `daemon.agent.inbox.dropped_on_exit`). Chat comes back with the next
// start's catch-up; app events do not, so the Server is told which ones
// (`agent:inbox:dropped_app_events`) and queues them for the next start. An
// idle hand-over, a carried inbox and a per-turn runtime's normal turns send
// nothing.
//
// RED proof (reverse-verified): drop the IDLE_HANDOVER_EXIT_PATHS check and
// "an idle end sends nothing" fails on the cold-idle recycle; never call
// reportDroppedAppEvents and the fence, stop, crash and cap cases find no frame.
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

const AGENT = "agent-dropped-app-events";
const DAEMON = "daemon-test";
// Not a text any runtime's resume matcher knows, and not a recoverable error.
const OPAQUE_ERROR = "Error: something went wrong while loading the conversation";

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
  deliver: (content: string | AgentMessage) => Promise<boolean>;
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-dropped-app-events-test-"));
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
    daemonInstanceId: DAEMON,
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
    await manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId }), undefined, undefined, undefined, "launch-1");
    await settle(() => children.length > before, 2_000);
    expect(children.length, "the wake spawned a process").toBe(before + 1);
  };
  const deliver = async (content: string | AgentMessage) => {
    const accepted = await manager.deliverMessage(AGENT, typeof content === "string" ? message(content) : content);
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


/** An app event as the Server pushes it (buildThirdPartyAgentMessage). */
function appEvent(id: string): AgentMessage {
  return {
    ...message(`Third-party notification: reminder ${id}`),
    seq: undefined,
    message_id: id,
    channel_id: `third-party-agent-events:${AGENT}`,
    channel_name: `third-party-agent-events:${AGENT}`,
    channel_type: "dm",
    sender_type: "third_party_app",
    sender_id: "reminder",
    sender_name: "reminder",
    third_party_event: { id, kind: "notification", client_id: "reminder", client_name: "Reminder", payload_hash: "0".repeat(64), payload: {}, expires_at: "2026-12-01T00:00:00.000Z" },
  } as unknown as AgentMessage;
}

const frames = (h: Harness) => h.sent.filter((msg) => msg.type === "agent:inbox:dropped_app_events");
const droppedOnExit = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.inbox.dropped_on_exit").map((event) => event.attrs);
const APP_1 = "11111111-1111-4111-8111-111111111111";
const APP_2 = "22222222-2222-4222-8222-222222222222";

/** A started agent busy in a turn, with a chat message and two app events queued in its process. */
async function busyWithQueued(h: Harness): Promise<void> {
  await h.wake();
  await h.deliver("a chat message");
  await h.deliver(appEvent(APP_1));
  await h.deliver(appEvent(APP_2));
  expect(h.m.agents.get(AGENT)?.inbox.length, "queued in the running process").toBe(3);
}

describe("agent:inbox:dropped_app_events: which ends report the app events they dropped", () => {
  const turnOnly: Partial<RuntimeDriver> = { supportsStdinNotification: false, busyDeliveryMode: "none" };

  test("the same-fingerprint fence: an app event acked into the runtime-error backoff is reported with its id", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const ap = (h.m.agents as Map<string, any>).get(AGENT)!;
      ap.runtimeErrorDeliveryBackoff = { kind: "backing_off", attempts: 1, untilMs: Date.now() + 60_000, timer: null, reason: "test" };
      expect(await h.deliver(appEvent(APP_1)), "acked").toBe(true);
      expect(await h.deliver("a chat message"), "acked").toBe(true);
      const routed = h.events.filter((event) => event.name === "daemon.agent.delivery.routed").map((event) => event.attrs.outcome);
      expect(routed, "held in the live process for the backoff").toEqual(["queued_runtime_error_backoff", "queued_runtime_error_backoff"]);

      // The third same-fingerprint error trips the fence (actOnStickyFailure).
      (h.manager as any).handStickyFailureToServer(AGENT, ap, { reason: "runtime_repeated_failure", detail: "Error: the same failure", cause: "fingerprint_fence" });

      expect(frames(h)).toEqual([{
        type: "agent:inbox:dropped_app_events",
        agentId: AGENT,
        launchId: "launch-1",
        daemonInstanceId: DAEMON,
        exitReason: "sticky_failure_handed_to_server",
        eventIds: [APP_1],
      }]);
    });
  }, 20_000);

  test("an explicit stop and a silent stop report the dropped app events, never the chat message", async () => {
    for (const silent of [false, true]) {
      await withManager(async (h) => {
        await busyWithQueued(h);
        await h.manager.stopAgent(AGENT, { silent });
        await settle();
        expect(frames(h).map((frame) => [frame.exitReason, frame.eventIds])).toEqual([[silent ? "silent_stop" : "explicit_stop", [APP_1, APP_2]]]);
      });
    }
  }, 20_000);

  test("a crash reports them with the exit reason dropped_on_exit records", async () => {
    await withManager(async (h) => {
      await busyWithQueued(h);
      await h.crash(1);
      const [dropped] = droppedOnExit(h);
      expect(dropped?.expected, "an abnormal end").toBe(false);
      expect(frames(h).map((frame) => [frame.exitReason, frame.eventIds])).toEqual([[dropped!.exit_reason, [APP_1, APP_2]]]);
    });
  }, 20_000);

  test("at most 100 ids per frame", async () => {
    await withManager(async (h) => {
      await h.wake();
      const ids = Array.from({ length: 105 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      for (const id of ids) await h.manager.deliverMessage(AGENT, appEvent(id));
      await h.manager.stopAgent(AGENT);
      await settle();
      expect(frames(h).map((frame) => frame.eventIds)).toEqual([ids.slice(0, 100)]);
    });
  }, 30_000);

  test("a clean exit that carries its queued app events into the next start sends nothing", async () => {
    await withManager(async (h) => {
      await busyWithQueued(h);
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      await settle(() => h.children.length > 1, 2_000);
      expect(h.children.length, "restarted with them").toBe(2);
      expect(frames(h)).toEqual([]);
    }, turnOnly);
  }, 20_000);

  test("an idle end sends nothing; nor does a cold-idle recycle that leaves its deferred deliveries to the server", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      await h.cleanExit();
      expect(frames(h)).toEqual([]);
      // The idle hand-over paths, as the close path names them.
      const ap = { launchId: "launch-1", config: { runtime: "codex" } };
      for (const exitPath of ["cold_idle_recycle", "clean_exit_deferred"]) {
        (h.manager as any).recordInboxDroppedOnExit(AGENT, ap, exitPath, [appEvent(APP_1)]);
      }
      expect(frames(h), "an idle hand-over").toEqual([]);
      (h.manager as any).recordInboxDroppedOnExit(AGENT, ap, "provider_stream_failure", [appEvent(APP_1)]);
      (h.manager as any).recordInboxDroppedOnExit(AGENT, ap, "recoverable_error_no_wake", [appEvent(APP_2)]);
      expect(frames(h).map((frame) => [frame.exitReason, frame.eventIds]), "the abnormal ones").toEqual([
        ["provider_stream_failure", [APP_1]],
        ["recoverable_error_no_wake", [APP_2]],
      ]);
    });
  }, 20_000);

  test("a per-turn runtime's three normal turns, each with an app event that arrived during it, send nothing", async () => {
    await withManager(async (h) => {
      await h.wake();
      for (let turn = 1; turn <= 3; turn += 1) {
        await h.deliver(appEvent(`3333333${turn}-3333-4333-8333-333333333333`));
        await h.emit([{ kind: "text", text: `turn ${turn}` }, { kind: "turn_end", sessionId: "session-1" }]);
        await h.cleanExit();
        await settle(() => h.children.length > turn, 2_000);
        expect(h.children.length, `turn ${turn + 1} started for the queued event`).toBe(turn + 1);
      }
      expect(frames(h)).toEqual([]);
    }, { supportsStdinNotification: false, busyDeliveryMode: "none", lifecycle: { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "coalesce_into_pending" } });
  }, 30_000);
});
