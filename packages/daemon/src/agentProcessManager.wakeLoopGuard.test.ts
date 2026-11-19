// Wake-loop guard (agentWakeLoopGuard.ts): an agent woken again and again by
// the SAME message while doing nothing. Walked through the real manager, one
// test per path a turn is started by: the clean-exit restart of a per-turn
// runtime (Cursor onboarding: 633 turns), the async-rejected idle retry of a
// long-lived runtime (Grok: 136 turns, same process), an idle stdin delivery
// of a message the server pushes again.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { WAKE_LOOP_BACKOFF_AT, WAKE_LOOP_BACKOFF_MS, WAKE_LOOP_PARK_AT } from "./agentWakeLoopGuard";
import { formatAgentMessageVisibleTarget } from "./agentVisibleDeliveryLedger";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { AgentProxyInboxCoordinator } from "./agentCredentialProxy";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { CopilotDriver } from "./drivers/copilot";
import { CursorDriver } from "./drivers/cursor";
import { GeminiDriver } from "./drivers/gemini";
import { noteRaftMessageSendOutcome } from "./runtimeCommunicationTrace";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-wake-loop";
/** The idle retry interval; its timer is `node:timers` (not faked here), so a short real one. */
const RETRY_MS = 20;

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

type Process = { inbox: AgentMessage[]; runtimeTraceCounters: Parameters<typeof noteRaftMessageSendOutcome>[0] };
type Sent = Record<string, any>;

type Harness = {
  manager: AgentProcessManager;
  agents: Map<string, Process>;
  children: FakeChild[];
  /** What the agent's credential proxy reads through (the spawn's `agentCredentialProxyInboxCoordinator`), latest spawn. */
  coordinator: () => AgentProxyInboxCoordinator;
  /** Each spawn's first input. */
  prompts: string[];
  sent: Sent[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
  cleanExit: () => Promise<void>;
  wake: () => Promise<void>;
  deliver: (message: AgentMessage, transient?: boolean) => Promise<boolean>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "andy", sender_type: "human",
    content, timestamp: "2026-11-05T00:00:00.000Z",
    message_id: `wake-loop-${seq}`, seq: 7_000_000 + seq,
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-wake-loop-test-"));
  const children: FakeChild[] = [];
  const coordinators: AgentProxyInboxCoordinator[] = [];
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
      coordinators.push(ctx.agentCredentialProxyInboxCoordinator!);
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
    stdinNotificationRetryMs: RETRY_MS,
  });
  const events: Harness["events"] = [];
  const m = manager as unknown as { agents: Map<string, Process>; recordDaemonEvent: (name: string, attrs: Record<string, unknown>, ...rest: unknown[]) => void };
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
  const cleanExit = async () => {
    children.at(-1)!.end(0);
    await settle();
  };
  const wake = async () => {
    const before = children.length;
    await manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1" }));
    await settle(() => children.length > before, 2_000);
    expect(children.length, "the wake spawned a process").toBe(before + 1);
  };
  const deliver = async (msg: AgentMessage, transient = false) => {
    const accepted = await manager.deliverMessage(AGENT, { ...msg }, transient ? { transient: true } : {});
    await settle();
    return accepted;
  };
  try {
    await run({ manager, agents: m.agents, children, coordinator: () => coordinators.at(-1)!, prompts, sent, events, emit, cleanExit, wake, deliver });
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

const guardEvents = (h: Harness) => h.events
  .filter((event) => event.name === "daemon.agent.wake.repeated_no_progress")
  .map((event) => event.attrs);
const parkedNotice = (h: Harness) => h.sent.find((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_error"
  && String(msg.detail ?? "").includes("Stopped waking this agent for a message"));
const inboxIds = (h: Harness) => h.agents.get(AGENT)?.inbox.map((entry) => entry.message_id) ?? [];
const writesOf = (child: FakeChild | undefined) => child?.writes.length ?? 0;
/** The guard's held offers (its 60 s timers), by message key. */
const heldKeys = (h: Harness) => [...((h.manager as any).wakeLoopHeld.get(AGENT)?.keys() ?? [])];
/** Parking never reads for the agent: no consumption recorded, not model-seen in the ledger. */
function expectNotConsumed(h: Harness, msg: AgentMessage): void {
  expect(h.events.filter((event) => event.name === "daemon.agent.inbox.visible_consumed"), "no consumption recorded").toEqual([]);
  expect((h.manager as any).isVisibleMessageModelSeen(AGENT, formatAgentMessageVisibleTarget(msg), msg), "not model-seen").toBe(false);
}

// A runtime that takes no input while it runs and whose process exits after
// its turn: a clean exit with the message still queued restarts it at once
// for that message (actOnCleanExit). Not a per-turn driver: since #14982 their
// natural exit is a turn end, which no longer restarts for what they were told.
const exitsAfterTurn: Partial<RuntimeDriver> = { supportsStdinNotification: false, busyDeliveryMode: "none" };
/** A turn that read nothing and did nothing (Cursor reports `init` and `result`). */
const idleTurn: ParsedEvent[] = [{ kind: "session_init", sessionId: "session-1" }, { kind: "turn_end", sessionId: "session-1" }];
const toolTurn: ParsedEvent[] = [
  { kind: "session_init", sessionId: "session-1" },
  { kind: "tool_call", name: "shell", input: { command: "ls" } },
  { kind: "turn_end", sessionId: "session-1" },
];

/** Starts the agent with `msg` queued, and ends the first (message-less) turn: the clean exit restarts it for `msg`. */
async function restartLoop(h: Harness, msg: AgentMessage): Promise<void> {
  await h.wake();
  await h.deliver(msg);
  await h.emit(idleTurn);
  await h.cleanExit();
  await settle(() => h.children.length > 1, 2_000);
  expect(h.children.length, "restarted for the queued message").toBe(2);
  expect(inboxIds(h), "the message woke it and waits unread in its inbox").toEqual([msg.message_id]);
}

/** What decides how a real per-turn driver is woken and ends its turns; the fake process and parser stay. */
function lifecycleOf(driver: RuntimeDriver): Partial<RuntimeDriver> {
  return {
    lifecycle: driver.lifecycle,
    supportsStdinNotification: driver.supportsStdinNotification,
    busyDeliveryMode: driver.busyDeliveryMode,
    terminateProcessOnTurnEnd: driver.terminateProcessOnTurnEnd,
  };
}

describe("wake-loop guard", () => {
  test.each<[string, RuntimeDriver, boolean]>([
    ["cursor", new CursorDriver(), false],
    ["gemini", new GeminiDriver(), false],
    ["copilot", new CopilotDriver(), false],
    // The server's onboarding wake on a per-turn driver (#14955): transient, same message id.
    ["cursor (transient onboarding wake)", new CursorDriver(), true],
  ])("per-turn %s lifecycle: the server pushing the same message after every turn starts it at most 3 times, then it is parked", async (_runtime, real, transient) => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit(idleTurn);
      await h.cleanExit();
      const onboarding = message("onboarding step");
      for (let turn = 1; turn <= WAKE_LOOP_PARK_AT; turn += 1) {
        const before = h.children.length;
        expect(await h.deliver(onboarding, transient)).toBe(true);
        if (turn === WAKE_LOOP_PARK_AT) {
          expect(h.children.length, "held in the backoff").toBe(before);
          await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
        }
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `woken by it, turn ${turn}`).toBe(before + 1);
        await h.emit(idleTurn);
        await h.cleanExit();
      }
      expect(guardEvents(h).map((event) => event.action)).toEqual(["backoff", "park"]);
      expect(parkedNotice(h)).toBeDefined();
      const before = h.children.length;
      expect(await h.deliver(onboarding, transient)).toBe(true);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(h.children.length, "never woken for it again").toBe(before);
      const next = message("a person asks something");
      expect(await h.deliver(next)).toBe(true);
      await settle(() => h.children.length > before, 2_000);
      expect(h.children.length, "a new message wakes it").toBe(before + 1);
    }, lifecycleOf(real));
  }, 30_000);

  test("a per-turn process that exits 0 before its turn end is woken again as before, however often (not counted)", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit(idleTurn);
      await h.cleanExit();
      const work = message("work");
      for (let turn = 1; turn <= 2 * WAKE_LOOP_PARK_AT; turn += 1) {
        const before = h.children.length;
        expect(await h.deliver(work)).toBe(true);
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `woken at once, time ${turn}`).toBe(before + 1);
        // The runtime started, then its process ended (exit 0) before it reported a turn end.
        await h.emit([{ kind: "session_init", sessionId: "session-1" }]);
        await h.cleanExit();
      }
      expect(guardEvents(h)).toEqual([]);
    }, lifecycleOf(new CursorDriver()));
  }, 30_000);

  test(`clean-exit restart: an agent restarted ${WAKE_LOOP_PARK_AT} times in a row by the same unread message backs off once, then the message is parked and the owner told`, async () => {
    await withManager(async (h) => {
      const onboarding = message("onboarding step");
      await restartLoop(h, onboarding);

      // Turn 1 started by it: nothing done; restarted at once for it.
      await h.emit(idleTurn);
      await h.cleanExit();
      await settle(() => h.children.length > 2, 2_000);
      expect(h.children.length, "restarted at once after one turn").toBe(3);
      expect(guardEvents(h)).toEqual([]);

      // Turn 2: nothing done; the next offer waits the backoff.
      await h.emit(idleTurn);
      await h.cleanExit();
      expect(guardEvents(h)).toMatchObject([{ action: "backoff", message_id: onboarding.message_id, count: 2, reasons: "spawn,spawn", backoff_ms: WAKE_LOOP_BACKOFF_MS }]);
      await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS - 1_000);
      await settle();
      expect(h.children.length, "not restarted inside the backoff").toBe(3);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => h.children.length > 3, 2_000);
      expect(h.children.length, "offered again after the backoff").toBe(4);
      expect(inboxIds(h)).toEqual([onboarding.message_id]);

      // Turn 3: nothing done; parked.
      await h.emit(idleTurn);
      await h.cleanExit();
      expect(guardEvents(h).at(-1)).toMatchObject({ action: "park", message_id: onboarding.message_id, count: WAKE_LOOP_PARK_AT });
      expect(parkedNotice(h), "the owner sees why").toBeDefined();
      expectNotConsumed(h, onboarding);
      expect(heldKeys(h), "no held offer left").toEqual([]);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(h.children.length, "never woken for it again").toBe(4);

      // The server pushes it again: dropped, no wake.
      expect(await h.deliver(onboarding)).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await settle();
      expect(h.children.length, "a re-push of the parked message does not wake it").toBe(4);

      // A new, different message wakes it as usual, without the parked one.
      const next = message("a person asks something");
      expect(await h.deliver(next)).toBe(true);
      await settle(() => h.children.length > 4, 2_000);
      expect(h.children.length, "a new message wakes it").toBe(5);
      expect(inboxIds(h)).toEqual([next.message_id]);
    }, exitsAfterTurn);
  }, 30_000);

  test("async-rejected idle retry: the runtime rejects every idle turn/start in one process and session; the retries count by their message, back off, and stop", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const stuck = message("hello grok");
      // A different rejection text each time: the same-fingerprint fence
      // (task #917) stops identical ones at its own threshold; these it never sees repeat.
      const texts = ["upstream connect error", "model overloaded, try later", "invalid request state", "stream reset by peer"];
      let rejections = 0;
      const reject = () => h.emit([{
        kind: "delivery_error",
        message: `Grok rejected turn/start: ${texts[rejections++ % texts.length]}`,
        requestMethod: "turn/start",
        source: "grok_acp_response",
        payloadBytes: 10,
      }]);

      expect(await h.deliver(stuck)).toBe(true);
      expect(writesOf(child), "offered at once (idle stdin delivery)").toBe(1);
      await reject();
      expect(guardEvents(h)).toEqual([]);

      // The daemon's own retry (flushAsyncRejectedIdleDelivery) after the retry interval.
      await settle(() => writesOf(child) > 1, 2_000);
      expect(writesOf(child), "retried after the interval").toBe(2);
      await reject();
      expect(guardEvents(h)).toMatchObject([{ action: "backoff", message_id: stuck.message_id, count: 2, reasons: "stdin-idle-delivery,async-rejected-idle-delivery-retry" }]);
      // One timer: the guard's 60 s hold. The 15 s retry was not armed (the message left the inbox before the restore).
      expect(heldKeys(h)).toEqual([stuck.message_id]);
      expect((h.agents.get(AGENT) as any).notifications.hasTimer, "no idle retry timer").toBe(false);
      expect((h.agents.get(AGENT) as any).notifications.pendingCount, "no retry debt").toBe(0);

      // Backoff: no retry at the usual interval, one offer after the backoff.
      await settle(() => false, 20 * RETRY_MS);
      await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS - 1_000);
      await settle();
      expect(writesOf(child), "no retry inside the backoff").toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => writesOf(child) > 2, 2_000);
      expect(writesOf(child), "offered again after the backoff").toBe(3);
      await reject();
      expect(guardEvents(h).at(-1)).toMatchObject({ action: "park", message_id: stuck.message_id, count: WAKE_LOOP_PARK_AT });
      expect(parkedNotice(h)).toBeDefined();
      expect(inboxIds(h), "no longer offered").toEqual([]);
      expect(heldKeys(h)).toEqual([]);
      expect((h.agents.get(AGENT) as any).notifications.hasTimer, "no idle retry timer").toBe(false);
      expectNotConsumed(h, stuck);

      await settle(() => false, 20 * RETRY_MS);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await settle();
      expect(writesOf(child), "no more retries").toBe(3);
      expect(h.children.length, "the same process throughout").toBe(1);
    });
  }, 30_000);

  test("the same rejection over and over is left to the same-fingerprint fence (task #917), which still trips at its threshold", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      expect(await h.deliver(message("hello grok"))).toBe(true);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await settle(() => writesOf(child) >= attempt, 2_000);
        await h.emit([{ kind: "delivery_error", message: "Grok rejected turn/start: upstream connect error", requestMethod: "turn/start", source: "grok_acp_response", payloadBytes: 10 }]);
      }
      expect(h.events.some((event) => event.name === "daemon.agent.runtime_error_fingerprint_fence" && event.attrs.fenced === true), "the fence trips").toBe(true);
      expect(guardEvents(h), "the guard never held it back from the fence").toEqual([]);
    });
  }, 30_000);

  // Production (Grok on Computer 1.0.42): Grok's ACP server rejected every
  // idle prompt with a provider rate limit. Each failed turn ends with a bare
  // turn_end (no output) and the delivery error arrives a few ms after it. The
  // bare turn end used to reset the same-fingerprint fence, so every rejection
  // was attempt 1 and the fence never stopped the loop.
  describe("a turn end resets the repeated-error fences only when its turn had output", () => {
    const RATE_LIMIT = "Grok Build ACP delivery failed: 429 Too Many Requests: rate limit exceeded (Bearer abcdefghijklmnopqrstuvwxyz0123)";
    const rejectRateLimited = (h: Harness) => h.emit([{ kind: "delivery_error", message: RATE_LIMIT, requestMethod: "turn/start", source: "grok_acp_response", payloadBytes: RATE_LIMIT.length }]);
    const named = (h: Harness, name: string) => h.events.filter((event) => event.name === name).map((event) => event.attrs);
    /** The next offer: the idle retry (real timer) or, after the guard's hold, its 60 s timer. */
    const nextOffer = async (h: Harness, child: FakeChild, writes: number) => {
      await settle(() => writesOf(child) >= writes, 20 * RETRY_MS);
      if (writesOf(child) < writes) await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
      await settle(() => writesOf(child) >= writes, 2_000);
      expect(writesOf(child), `offer ${writes}`).toBe(writes);
    };

    test("the production cycle (bare turn end, then the same rate-limit rejection) trips the fence at the third and hands the agent to the server", async () => {
      await withManager(async (h) => {
        await h.wake();
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        const child = h.children[0]!;
        expect(await h.deliver(message("hello grok"))).toBe(true);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await nextOffer(h, child, attempt);
          await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
          await rejectRateLimited(h);
        }

        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.reset").map((attrs) => attrs.reset_source), "a bare turn end is no progress").toEqual(["tripped"]);
        const counted = named(h, "daemon.agent.runtime_error_fingerprint_fence");
        expect(counted.map((attrs) => attrs.attempts)).toEqual([1, 2, 3]);
        expect(counted.map((attrs) => attrs.runtime_error_class), "production's class").toEqual(["RateLimitError", "RateLimitError", "RateLimitError"]);
        const tripped = named(h, "daemon.agent.runtime_error_fingerprint_fence.tripped");
        expect(tripped).toMatchObject([{ runtime_error_class: "RateLimitError", attempts: 3 }]);
        // A rate limit is no credential problem: not held for the credential
        // (step 4a) but handed to the server's self-retrying pause.
        expect(named(h, "daemon.agent.stdin_delivery.terminal_rejected")).toEqual([]);
        expect(named(h, "daemon.agent.sticky_failure.handed_to_server")).toMatchObject([{ reason: "runtime_repeated_failure", cause: "fingerprint_fence" }]);
        expect(h.agents.has(AGENT), "the runtime is released").toBe(false);
        // The bare turn ends are also counted by the wake-loop guard (the
        // error comes after them): its hold puts the third offer 60 s later,
        // and that turn parks the message just before the fence trips.
        expect(guardEvents(h).map((attrs) => attrs.action)).toEqual(["backoff", "park"]);

        // The rejection's text rides the events, scrubbed and bounded as on
        // daemon.runtime.error; the planted token does not.
        const rejected = named(h, "daemon.agent.stdin_delivery.async_rejected");
        expect(rejected.length, "the first two are restored for another offer").toBe(2);
        for (const attrs of [...rejected, ...named(h, "daemon.runtime.delivery.async_rejected"), ...tripped]) {
          const excerpt = String(attrs.runtime_error_message_excerpt ?? "");
          expect(excerpt).toContain("429 Too Many Requests: rate limit exceeded (Bearer [REDACTED_TOKEN])");
          expect(excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
          expect(attrs.runtime_error_message_truncated).toBe(false);
        }
        expect(rejected[0]).toMatchObject({ runtime_error_class: "RateLimitError", runtime_error_fingerprint: counted[0]!.runtime_error_fingerprint });

        await settle(() => false, 20 * RETRY_MS);
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        await settle();
        expect(writesOf(child), "no offer after the trip").toBe(3);

        // #wg-rbac:#57: the fence's visible detail names the last error, and it
        // leaves the daemon (activity detail and entries, the start-failure
        // report as runtime_unavailable) scrubbed only.
        const PLANTED = "abcdefghijklmnopqrstuvwxyz0123";
        const startFailures = () => h.sent.filter((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_unavailable");
        expect(startFailures().length, "the trip is reported as a failed start").toBeGreaterThan(0);
        expect(startFailures()[0]!.detail).toContain("Last error: Grok Build ACP delivery failed: 429 Too Many Requests: rate limit exceeded (Bearer [REDACTED_TOKEN])");
        const fenceActivities = h.sent.filter((msg) => msg.type === "agent:activity" && String(msg.detail ?? "").includes("Runtime stopped after 3 repeated runtime errors"));
        expect(fenceActivities.some((msg) => msg.detailKind === "runtime_error" && (msg.entries ?? []).some((entry: { text?: string }) => String(entry.text).includes("Bearer [REDACTED_TOKEN]")))).toBe(true);
        expect(JSON.stringify(h.sent), "no frame the daemon sent carries the raw token").not.toContain(PLANTED);
        // A delivery that finds no process re-sends the remembered failed start: scrubbed too.
        const before = startFailures().length;
        await h.deliver(message("are you there?"));
        expect(startFailures().length, "the failed start is shown again").toBe(before + 1);
        expect(JSON.stringify(h.sent)).not.toContain(PLANTED);
      });
    }, 30_000);

    const outputs: Array<[string, ParsedEvent[]]> = [
      ["text", [{ kind: "text", text: "working on it" }]],
      ["tool use only", [{ kind: "tool_call", name: "read_file", input: { path: "README.md" } }, { kind: "tool_output", name: "read_file", ok: true }]],
    ];
    for (const [label, output] of outputs) {
      test(`a turn with ${label} before the same rejection never trips the fence`, async () => {
        await withManager(async (h) => {
          await h.wake();
          await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
          const child = h.children[0]!;
          expect(await h.deliver(message(`rejected after ${label}`))).toBe(true);
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            await nextOffer(h, child, attempt);
            await h.emit([...output, { kind: "turn_end", sessionId: "session-1" }]);
            await rejectRateLimited(h);
          }
          expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1, 1]);
          expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.tripped")).toEqual([]);
          expect(h.agents.has(AGENT), "the runtime keeps running").toBe(true);
        });
      }, 30_000);
    }

    // Output arriving after its turn's end (a late flush) resets the fence by
    // itself, and leaves the flag set for the next turn end: either can only
    // miss a trip, never cause one.
    test("output after the turn end resets by itself; it never makes a trip", async () => {
      await withManager(async (h) => {
        await h.wake();
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        const child = h.children[0]!;
        expect(await h.deliver(message("late output"))).toBe(true);
        // Offer 1: its late line resets what the rejection counted.
        await nextOffer(h, child, 1);
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        await rejectRateLimited(h);
        await h.emit([{ kind: "text", text: "a late line of the turn that ended" }]);
        // Offer 2: the flag that late line left makes this bare turn end reset (nothing to reset yet).
        await nextOffer(h, child, 2);
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        await rejectRateLimited(h);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1]);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.reset").map((attrs) => attrs.reset_source)).toEqual(["runtime_progress:text"]);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.tripped")).toEqual([]);
      });
    }, 30_000);

    // A busy delivery (a steer into the running turn) does not start a turn:
    // the output before it still counts at the turn's end.
    test("a steer mid-turn keeps the turn's output: its error then turn end still resets", async () => {
      await withManager(async (h) => {
        await h.wake();
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        const child = h.children[0]!;
        const failed = { kind: "error", message: "Cursor agent failed: upstream rejected the request" } as ParsedEvent;
        for (let turn = 1; turn <= 3; turn += 1) {
          expect(await h.deliver(message(`turn ${turn}`))).toBe(true);
          await h.emit([{ kind: "text", text: "working" }]);
          const writes = writesOf(child);
          expect(await h.deliver(message(`steer ${turn}`))).toBe(true);
          // Queued as a busy notification; its flush writes it into the turn.
          (h.manager as any).sendStdinNotification(AGENT);
          await settle(() => writesOf(child) > writes, 2_000);
          expect(writesOf(child), "steered into the running turn").toBe(writes + 1);
          await h.emit([failed, { kind: "turn_end", sessionId: "session-1" }]);
        }
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1, 1]);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.reset").map((attrs) => attrs.reset_source)).toEqual(Array(3).fill("runtime_progress:turn_end"));
      });
    }, 30_000);

    // Cursor reports a failed turn as error + turn_end. With output before the
    // error the turn end is progress (it resets the count the error added);
    // without, it is not, and the same error three times trips the fence.
    // These depend on the per-turn flag: the output comes before the error, so
    // only the turn end can reset what the error counted. (In Grok's order,
    // the tests above, the output resets by itself before the rejection.)
    for (const [label, output] of outputs) {
      test(`error then turn end (Cursor's failed turn) after ${label}: the turn end resets`, async () => {
        await withManager(async (h) => {
          await h.wake();
          const failed = { kind: "error", message: "Cursor agent failed: upstream rejected the request" } as ParsedEvent;
          for (let turn = 1; turn <= 3; turn += 1) {
            await h.emit([...output, failed, { kind: "turn_end", sessionId: "session-1" }]);
          }
          expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1, 1]);
          expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.reset").map((attrs) => attrs.reset_source)).toEqual(Array(3).fill("runtime_progress:turn_end"));
          expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.tripped")).toEqual([]);
        });
      }, 30_000);
    }

    test("error then turn end (Cursor's failed turn): reset when the turn had output, counted when it had none", async () => {
      await withManager(async (h) => {
        await h.wake();
        const failed = { kind: "error", message: "Cursor agent failed: upstream rejected the request" } as ParsedEvent;
        for (let turn = 1; turn <= 3; turn += 1) {
          await h.emit([{ kind: "text", text: "partial answer" }, failed, { kind: "turn_end", sessionId: "session-1" }]);
        }
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1, 1]);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.reset").map((attrs) => attrs.reset_source)).toEqual(Array(3).fill("runtime_progress:turn_end"));
        for (let turn = 1; turn <= 3; turn += 1) {
          await h.emit([failed, { kind: "turn_end", sessionId: "session-1" }]);
        }
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence").map((attrs) => attrs.attempts)).toEqual([1, 1, 1, 1, 2, 3]);
        expect(named(h, "daemon.agent.runtime_error_fingerprint_fence.tripped").length).toBe(1);
      });
    }, 30_000);
  });

  test("a busy rejection (turn.agent_busy) is back-pressure and never counts", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      expect(await h.deliver(message("while busy"))).toBe(true);
      for (let attempt = 1; attempt <= WAKE_LOOP_PARK_AT + 2; attempt += 1) {
        await h.emit([{ kind: "delivery_error", message: "busy", code: "turn.agent_busy", requestMethod: "turn/start", source: "grok_acp_response", payloadBytes: 1 }]);
        await settle(() => writesOf(child) > attempt, 2_000);
      }
      expect(guardEvents(h)).toEqual([]);
      expect(writesOf(child), "retried every interval").toBe(WAKE_LOOP_PARK_AT + 3);
    });
  }, 30_000);

  test("idle stdin redelivery: a message the server pushes again after each idle turn is counted, held through the backoff at the delivery entry, then dropped", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const repushed = message("pushed again and again");
      const idleTurnThenLeaveInbox = async () => {
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        // It leaves the inbox without the agent reading it (the server takes it back), and comes again.
        h.agents.get(AGENT)!.inbox.splice(0);
      };

      expect(await h.deliver(repushed)).toBe(true);
      expect(writesOf(child)).toBe(1);
      await idleTurnThenLeaveInbox();
      expect(await h.deliver(repushed)).toBe(true);
      expect(writesOf(child), "offered again").toBe(2);
      await idleTurnThenLeaveInbox();
      expect(guardEvents(h)).toMatchObject([{ action: "backoff", count: 2, reasons: "stdin-idle-delivery,stdin-idle-delivery" }]);

      expect(await h.deliver(repushed)).toBe(true);
      expect(writesOf(child), "held at the delivery entry during the backoff").toBe(2);
      expect(h.events.some((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.outcome === "held_wake_loop_backoff")).toBe(true);
      await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
      await settle(() => writesOf(child) > 2, 2_000);
      expect(writesOf(child), "offered after the backoff").toBe(3);
      await idleTurnThenLeaveInbox();
      expect(guardEvents(h).at(-1)).toMatchObject({ action: "park", count: WAKE_LOOP_PARK_AT });

      expect(await h.deliver(repushed)).toBe(true);
      expect(writesOf(child), "a parked message is not offered").toBe(3);
      expect(h.events.some((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.outcome === "dropped_wake_loop_parked")).toBe(true);

      const next = message("something new");
      expect(await h.deliver(next)).toBe(true);
      expect(writesOf(child), "a new message is offered as usual").toBe(4);
    });
  }, 30_000);

  test("progress resets the count: the same message, with a tool call, a send or a read every other turn, is never held or parked", async () => {
    await withManager(async (h) => {
      const work = message("long task");
      await restartLoop(h, work);
      const progress: Array<() => Promise<void>> = [
        () => h.emit(toolTurn),
        async () => { noteRaftMessageSendOutcome(h.agents.get(AGENT)!.runtimeTraceCounters, "sent"); await h.emit(idleTurn); },
        // The agent reads its messages through the credential proxy (a local events read).
        async () => { h.coordinator().consumeVisibleMessages({ messages: [], source: "agent_api_events_local" }); await h.emit(idleTurn); },
      ];
      for (let turn = 0; turn < 8; turn += 1) {
        if (turn % 2 === 0) await h.emit(idleTurn);
        else await progress[(turn - 1) / 2 % progress.length]!();
        const before = h.children.length;
        await h.cleanExit();
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `restarted at once after turn ${turn + 1}`).toBe(before + 1);
        expect(inboxIds(h)).toEqual([work.message_id]);
      }
      expect(guardEvents(h)).toEqual([]);
    }, exitsAfterTurn);
  }, 30_000);

  test("a busy agent is unchanged: many turns on different messages with nothing to do, or on the same one with tool calls, never count", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      for (let turn = 1; turn <= 3 * WAKE_LOOP_PARK_AT; turn += 1) {
        expect(await h.deliver(message(`system message ${turn}`))).toBe(true);
        expect(writesOf(child), `message ${turn} offered at once`).toBe(turn);
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      }
      expect(guardEvents(h)).toEqual([]);
    });
    await withManager(async (h) => {
      const work = message("keeps working on it");
      await restartLoop(h, work);
      for (let turn = 1; turn <= 3 * WAKE_LOOP_PARK_AT; turn += 1) {
        await h.emit(toolTurn);
        const before = h.children.length;
        await h.cleanExit();
        await settle(() => h.children.length > before, 2_000);
        expect(h.children.length, `restarted at once after turn ${turn}`).toBe(before + 1);
      }
      expect(guardEvents(h)).toEqual([]);
    }, exitsAfterTurn);
  }, 30_000);

  test("a person's stop releases a parked message (a re-push is offered again)", async () => {
    await withManager(async (h) => {
      const onboarding = message("onboarding step");
      await restartLoop(h, onboarding);
      for (let turn = 1; turn <= WAKE_LOOP_PARK_AT; turn += 1) {
        await h.emit(idleTurn);
        await h.cleanExit();
        if (turn < WAKE_LOOP_PARK_AT) {
          await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
          await settle(() => h.children.length > turn + 1, 2_000);
        }
      }
      expect(guardEvents(h).at(-1)).toMatchObject({ action: "park" });
      await h.manager.stopAgent(AGENT);
      await settle();
      await h.wake();
      expect(await h.deliver(onboarding)).toBe(true);
      expect(inboxIds(h), "after a stop the message is offered again").toEqual([onboarding.message_id]);
    }, exitsAfterTurn);
  }, 30_000);
  test("a parked tracked mention pushed again is refused, never acked as drained or seen", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const stuck = message("@agent hello");
      const leaveInbox = async () => {
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        h.agents.get(AGENT)!.inbox.splice(0);
      };
      expect(await h.deliver(stuck)).toBe(true);
      await leaveInbox();
      expect(await h.deliver(stuck)).toBe(true);
      await leaveInbox();
      await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
      expect(await h.deliver(stuck)).toBe(true);
      await leaveInbox();
      expect(guardEvents(h).at(-1)).toMatchObject({ action: "park" });
      const writes = writesOf(child);

      const onMentionAck = vi.fn();
      const onMentionTerminalError = vi.fn();
      const accepted = await h.manager.deliverMessage(AGENT, { ...stuck }, {
        deliveryId: "delivery-parked",
        mentionDelivery: { occurrenceId: "occ-parked", messageId: stuck.message_id!, machineId: "machine-1", launchId: "launch-1", sessionId: "session-1" },
        onMentionAck,
        onMentionTerminalError,
      } as any);
      await settle();
      expect(accepted).toBe(true);
      expect(onMentionAck, "never acked as drained").not.toHaveBeenCalled();
      expect(onMentionTerminalError).toHaveBeenCalledWith("DELIVERY_REJECTED");
      expect(writesOf(child), "not offered").toBe(writes);
      expectNotConsumed(h, stuck);
    });
  }, 30_000);

  test("a quiet turn counts only when the same message starts the next turn again", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const a = message("FYI one");
      const b = message("FYI two");
      // a, b, a, b, ...: each a quiet turn (no reply needed), and the same two
      // messages come back, but never the same one twice in a row.
      for (let turn = 1; turn <= 4 * WAKE_LOOP_PARK_AT; turn += 1) {
        expect(await h.deliver(turn % 2 === 1 ? a : b)).toBe(true);
        expect(writesOf(child), `offered at once, turn ${turn}`).toBe(turn);
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        h.agents.get(AGENT)!.inbox.splice(0);
      }
      expect(guardEvents(h)).toEqual([]);
    });
  }, 30_000);

  test("timers: a stop inside the backoff clears the held offer; shutdown clears one held for an agent with no process", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const stuck = message("hello");
      const texts = ["upstream connect error", "model overloaded, try later"];
      expect(await h.deliver(stuck)).toBe(true);
      for (const text of texts) {
        await settle(() => writesOf(child) >= 1 + texts.indexOf(text), 2_000);
        await h.emit([{ kind: "delivery_error", message: `rejected: ${text}`, requestMethod: "turn/start", source: "grok_acp_response", payloadBytes: 1 }]);
      }
      expect(guardEvents(h).map((event) => event.action)).toEqual(["backoff"]);
      expect(heldKeys(h)).toEqual([stuck.message_id]);
      const fakeTimersBefore = vi.getTimerCount();
      await h.manager.stopAgent(AGENT);
      await settle();
      expect(heldKeys(h), "the stop cleared it").toEqual([]);
      expect(vi.getTimerCount(), "its timer is gone").toBeLessThan(fakeTimersBefore);
      const spawned = h.children.length;
      await vi.advanceTimersByTimeAsync(2 * WAKE_LOOP_BACKOFF_MS);
      await settle();
      expect(h.children.length, "nothing offered after the stop").toBe(spawned);
    });
    await withManager(async (h) => {
      await h.wake();
      await h.emit(idleTurn);
      await h.cleanExit();
      const onboarding = message("onboarding step");
      for (let turn = 1; turn <= WAKE_LOOP_BACKOFF_AT; turn += 1) {
        expect(await h.deliver(onboarding)).toBe(true);
        await settle(() => h.children.length > turn, 2_000);
        await h.emit(idleTurn);
        await h.cleanExit();
      }
      expect(await h.deliver(onboarding)).toBe(true);
      expect(heldKeys(h), "held, no process").toEqual([onboarding.message_id]);
      await h.manager.stopAll();
      expect(heldKeys(h), "shutdown cleared it").toEqual([]);
    }, lifecycleOf(new CursorDriver()));
  }, 30_000);
  /** Parks `msg` on a per-turn Cursor agent through server re-pushes (each one a turn with nothing done). */
  async function parkByRepush(h: Harness, msg: AgentMessage): Promise<void> {
    await h.wake();
    await h.emit(idleTurn);
    await h.cleanExit();
    for (let turn = 1; turn <= WAKE_LOOP_PARK_AT; turn += 1) {
      const before = h.children.length;
      expect(await h.deliver(msg)).toBe(true);
      if (turn === WAKE_LOOP_PARK_AT) await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
      await settle(() => h.children.length > before, 2_000);
      await h.emit(idleTurn);
      await h.cleanExit();
    }
    expect(guardEvents(h).at(-1)).toMatchObject({ action: "park", message_id: msg.message_id });
  }

  test("parked for good while the agent runs: progress on a different message does not re-offer it", async () => {
    await withManager(async (h) => {
      const onboarding = message("onboarding step");
      await parkByRepush(h, onboarding);
      const next = message("a person asks something");
      const before = h.children.length;
      expect(await h.deliver(next)).toBe(true);
      await settle(() => h.children.length > before, 2_000);
      // Real progress: a tool call, a send and a read through the proxy.
      noteRaftMessageSendOutcome(h.agents.get(AGENT)!.runtimeTraceCounters, "sent");
      h.coordinator().consumeVisibleMessages({ messages: [], source: "agent_api_events_local" });
      await h.emit(toolTurn);
      await h.cleanExit();
      expect(inboxIds(h)).toEqual([]);
      const afterProgress = h.children.length;
      expect(await h.deliver(onboarding)).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await settle();
      expect(h.children.length, "the parked message still does not wake it").toBe(afterProgress);
      expect(h.events.filter((event) => event.name === "daemon.agent.delivery.routed" && event.attrs.outcome === "dropped_wake_loop_parked").length).toBeGreaterThanOrEqual(1);
    }, lifecycleOf(new CursorDriver()));
  }, 30_000);

  test("stop and start: the start's catch-up of what is unread on the server offers the parked message again", async () => {
    await withManager(async (h) => {
      const parked = message("a real unread message");
      await parkByRepush(h, parked);
      // The delivery ack took it off the server's pending set and parking took
      // it out of the inbox: nothing in the daemon re-offers it. It is still
      // unread on the server, whose start of a stopped agent with a session
      // carries the unread catch-up (agentOrchestrator resume catch-up,
      // `resumeMessages`).
      // Without a stop, a start's catch-up does not bring it back.
      await h.manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1" }), undefined, { "channel-1": 1 }, undefined, undefined, false, [{ ...parked }]);
      await settle(() => h.prompts.length > 4, 2_000);
      expect(h.prompts.length, "started without a stop").toBe(5);
      expect(h.prompts.at(-1), "still parked while the agent runs here").not.toContain(parked.content);
      expect(inboxIds(h)).not.toContain(parked.message_id);
      await h.emit(idleTurn);
      await h.cleanExit();
      await h.manager.stopAgent(AGENT);
      await settle();
      const before = h.children.length;
      await h.manager.startAgent(AGENT, promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1" }), undefined, { "channel-1": 1 }, undefined, undefined, false, [{ ...parked }]);
      await settle(() => h.children.length > before, 2_000);
      expect(h.children.length, "started").toBe(before + 1);
      expect(h.prompts.at(-1), "the new process is offered the parked message (the catch-up is its first input)").toContain(parked.content);
    }, lifecycleOf(new CursorDriver()));
  }, 30_000);

  test("a tracked mention that arrives during the hold ends refused (never left in flight); the held offer goes out untracked", async () => {
    await withManager(async (h) => {
      await h.wake();
      await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
      const child = h.children[0]!;
      const stuck = message("@agent hello");
      for (let turn = 1; turn <= WAKE_LOOP_BACKOFF_AT; turn += 1) {
        expect(await h.deliver(stuck)).toBe(true);
        await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
        h.agents.get(AGENT)!.inbox.splice(0);
      }
      expect(guardEvents(h).map((event) => event.action)).toEqual(["backoff"]);
      const writes = writesOf(child);
      const onMentionAck = vi.fn();
      const onMentionTerminalError = vi.fn();
      const onMentionTransition = vi.fn();
      expect(await h.manager.deliverMessage(AGENT, { ...stuck }, {
        deliveryId: "delivery-held",
        mentionDelivery: { occurrenceId: "occ-held", messageId: stuck.message_id!, machineId: "machine-1", launchId: "launch-1", sessionId: "session-1" },
        onMentionAck,
        onMentionTerminalError,
        onMentionTransition,
      } as any)).toBe(true);
      expect(onMentionTerminalError).toHaveBeenCalledWith("DELIVERY_REJECTED");
      expect(writesOf(child), "held").toBe(writes);
      await vi.advanceTimersByTimeAsync(WAKE_LOOP_BACKOFF_MS);
      await settle(() => writesOf(child) > writes, 2_000);
      expect(writesOf(child), "offered after the hold").toBe(writes + 1);
      expect(onMentionAck, "the held offer is untracked").not.toHaveBeenCalled();
      expect(onMentionTransition).not.toHaveBeenCalled();
    });
  }, 30_000);
});
