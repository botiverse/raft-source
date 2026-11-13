// #proj-raft-computer:#46 (reconciler, step 2): usage and rate limits belong
// to the provider account, not to one agent. Agents on the same machine-shared
// sign-in share one provider-limit backoff, keyed `shared:<runtime>`: when one
// of them hits the limit, the others hold their deliveries until the same
// deadline instead of each running into it, an agent started later restores
// it, and a web login for that runtime ends it for all of them. An agent on
// its own credentials (own CODEX_HOME ...) keeps a limit of its own
// (`agent:<id>`), exactly as before.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type CredentialHoldReason, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";
import { codexShared, limitEvents, limitHarness, message as oarMessage, sleep, startRequest, until } from "./testing/oarAgentHostHarness";

const A = "agent-a";
const B = "agent-b";
const C = "agent-c-own-home";
const D = "agent-d";
const SHARED = "shared:codex";
const QUOTA_TEXT = "You've hit your usage limit. Try again later.";
const MINUTE_MS = 60_000;

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
  end(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

type LiveProcess = { inbox: AgentMessage[]; runtimeErrorDeliveryBackoff: { kind: string; attempts: number; untilMs: number; reason: string } };
type ProviderLimitRecord = { attempts: number; untilMs: number; reason: string; providerLimitKind: string; resetsAt?: string; recordedAtMs: number };
type Internals = {
  agents: Map<string, LiveProcess>;
  lifecycleRecords: {
    /** Without `nowMs` nothing counts as expired: a read that prunes nothing. */
    getProviderLimit(key: string, nowMs?: number): ProviderLimitRecord | undefined;
    /** The store itself, to see whether a record is still there without reading it. */
    providerLimits: Map<string, ProviderLimitRecord>;
  };
};

type Harness = {
  manager: AgentProcessManager;
  m: Internals;
  children: Map<string, FakeChild[]>;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  /** Every frame sent to the server. */
  frames: MachineToServerMessage[];
  emit: (agentId: string, events: ParsedEvent[]) => Promise<void>;
};

let seq = 0;
function message(content: string): AgentMessage {
  seq += 1;
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "xxchan", sender_type: "human",
    content, timestamp: "2026-11-05T00:00:00.000Z",
    message_id: `m-${seq}`, seq,
  };
}

async function withManager(run: (h: Harness) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-shared-credential-limit-test-"));
  const children = new Map<string, FakeChild[]>();
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
      const child = new FakeChild();
      children.set(ctx.agentId, [...(children.get(ctx.agentId) ?? []), child]);
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
  const frames: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((frame) => { frames.push(frame); }, "sk_machine_test", {
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
  const emit = async (agentId: string, parsedEvents: ParsedEvent[]) => {
    const key = `line-${line++}`;
    parsed.set(key, parsedEvents);
    children.get(agentId)!.at(-1)!.stdout.emit("data", Buffer.from(`${key}\n`));
    await settle();
  };
  try {
    await run({ manager, m, children, events, frames, emit });
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

async function settle(until: () => boolean = () => false, realMs = 100): Promise<void> {
  const deadline = performance.now() + realMs;
  while (!until() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

function config(agentId: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return promptConfig({ name: agentId, displayName: agentId, sessionId: `session-${agentId}`, ...overrides });
}

/** Own credential home: `sharedCredentialsAuthRuntime` is null, so the limit is keyed `agent:<id>`. */
const ownHome = { envVars: { CODEX_HOME: "/srv/codex-agent-c" } };

/** A live agent whose first turn has ended: idle, with a session, so a delivery goes straight to stdin. */
async function startIdle(h: Harness, agentId: string, overrides: Partial<AgentConfig> = {}): Promise<void> {
  await h.manager.startAgent(agentId, config(agentId, overrides));
  await h.emit(agentId, [{ kind: "turn_end", sessionId: `session-${agentId}` }]);
}

/** A quota that resets in 30 minutes (under the 60-minute cap, so the wait is exactly until then). */
async function hitQuota(h: Harness, agentId: string): Promise<number> {
  const resetsAtMs = Date.now() + 30 * MINUTE_MS;
  await h.emit(agentId, [
    { kind: "error", message: QUOTA_TEXT, providerLimit: { kind: "quota_exhausted", resetsAt: new Date(resetsAtMs).toISOString() } },
    { kind: "turn_end", sessionId: `session-${agentId}` },
  ]);
  return resetsAtMs;
}

const writes = (h: Harness, agentId: string) => h.children.get(agentId)!.at(-1)!.writes.length;

/** Whether a fresh delivery reaches the agent's runtime now (rather than being held in its inbox). */
async function deliveryReachesRuntime(h: Harness, agentId: string, content: string): Promise<boolean> {
  const before = writes(h, agentId);
  expect(await h.manager.deliverMessage(agentId, message(content))).toBe(true);
  await settle();
  return writes(h, agentId) > before;
}

const restoredEvents = (h: Harness, agentId: string) => h.events
  .filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.restored" && event.attrs.agentId === agentId);

test("one agent hitting the shared sign-in's quota holds the other live agents on it until the same reset; an agent with its own CODEX_HOME is unaffected", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);

    const untilMs = await hitQuota(h, A);

    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toMatchObject({ untilMs, reason: "rate_limited", providerLimitKind: "quota_exhausted" });
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${A}`), "keyed by the credential, not the agent").toBeUndefined();
    expect(h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === A)?.attrs)
      .toMatchObject({ provider_limit_kind: "quota_exhausted", credential_key_kind: "shared" });
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff, "B never hit the limit itself").toMatchObject({ kind: "backing_off", untilMs, reason: "rate_limited" });
    expect(restoredEvents(h, B).at(-1)?.attrs).toMatchObject({ restore_point: "shared_credential_limit", credential_key_kind: "shared" });
    expect(h.m.agents.get(C)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");

    expect(await deliveryReachesRuntime(h, B, "for B during the quota wait")).toBe(false);
    expect(h.m.agents.get(B)?.inbox.map((entry) => entry.content)).toEqual(["for B during the quota wait"]);
    expect(await deliveryReachesRuntime(h, C, "for C, on its own account")).toBe(true);
    expect(h.children.get(B), "no process is stopped or restarted").toHaveLength(1);

    const bWrites = writes(h, B);
    await vi.advanceTimersByTimeAsync(untilMs - Date.now() - 1_000);
    await settle();
    expect(writes(h, B), "still held a second before the reset").toBe(bWrites);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(() => writes(h, B) > bWrites);
    expect(writes(h, B), "the backoff timer flushes the held delivery at the reset").toBeGreaterThan(bWrites);
  });
}, 20_000);

test("an agent on the shared sign-in started after the limit restores the same backoff at process start", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    const untilMs = await hitQuota(h, A);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    await startIdle(h, B);

    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", untilMs, reason: "rate_limited" });
    expect(restoredEvents(h, B).at(-1)?.attrs).toMatchObject({ restore_point: "process_start", credential_key_kind: "shared", remaining_ms_bucket: expect.any(String) });
    expect(await deliveryReachesRuntime(h, B, "for B")).toBe(false);

    await startIdle(h, C, ownHome);
    expect(h.m.agents.get(C)?.runtimeErrorDeliveryBackoff.kind, "own credentials restore only their own limit").toBe("idle");
  });
}, 20_000);

test("a Codex login releases every agent on the shared sign-in at once and leaves an own-credential agent's limit alone", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);
    const sharedUntilMs = await hitQuota(h, A);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    const cUntilMs = await hitQuota(h, C);
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`)?.untilMs).toBe(cUntilMs);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)?.untilMs, "C's own limit does not touch the shared one").toBe(sharedUntilMs);
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff.untilMs).toBe(sharedUntilMs);
    for (const agentId of [A, B, C]) {
      expect(await deliveryReachesRuntime(h, agentId, `for ${agentId}`)).toBe(false);
    }
    const before = { a: writes(h, A), b: writes(h, B), c: writes(h, C) };

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => writes(h, A) > before.a && writes(h, B) > before.b);

    expect(writes(h, A), "A's held delivery is flushed").toBeGreaterThan(before.a);
    expect(writes(h, B), "B's held delivery is flushed").toBeGreaterThan(before.b);
    expect(writes(h, C)).toBe(before.c);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toBeUndefined();
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`)?.untilMs).toBe(cUntilMs);
    expect(h.m.agents.get(C)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", untilMs: cUntilMs });
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_credentials_changed.cleared").at(-1)?.attrs)
      .toMatchObject({ provider_limit_backoffs_cleared: 1, live_backoffs_ended: 2, cooldowns_ended: 0 });
    expect(h.children.get(A)).toHaveLength(1);
    expect(h.children.get(B)).toHaveLength(1);
  });
}, 20_000);

// task #379: an explicit stop, and so a manual restart (the Server's stop then
// start), is a human "try again". The limit is the credential's, so on a shared
// sign-in it ends for every agent on it; if the account is still limited, the
// next request records it again for all of them.
test("an explicit stop (manual restart) releases the agent's credential limit: every agent on the shared sign-in, or just its own", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);
    await hitQuota(h, A);
    const cUntilMs = await hitQuota(h, C);
    expect(await deliveryReachesRuntime(h, B, "for B")).toBe(false);
    const bWrites = writes(h, B);

    await h.manager.stopAgent(A);
    await settle(() => writes(h, B) > bWrites);

    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toBeUndefined();
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");
    expect(writes(h, B), "B's held delivery is flushed").toBeGreaterThan(bWrites);
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.agentId === B).at(-1)?.attrs)
      .toMatchObject({ reset_source: "provider_limit_released", release_cause: "explicit_stop", released: "live_backoff", credential_key_kind: "shared" });
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.agentId === A).at(-1)?.attrs)
      .toMatchObject({ release_cause: "explicit_stop", credential_key_kind: "shared", shared_live_backoffs_ended: 1 });
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`)?.untilMs, "another credential's limit stays").toBe(cUntilMs);

    await startIdle(h, A);
    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff.kind, "A restarted starts with no backoff").toBe("idle");

    await h.manager.stopAgent(C);
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`)).toBeUndefined();
    await startIdle(h, C, ownHome);
    expect(h.m.agents.get(C)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");
  });
}, 20_000);

test("another agent's unrelated error neither erases nor shortens the shared limit; model output from a turn started after the limit ends it, for every agent", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await vi.advanceTimersByTimeAsync(1_000);
    const untilMs = await hitQuota(h, A);
    expect(await deliveryReachesRuntime(h, A, "for A")).toBe(false);

    // Output of a turn that was already running when A hit the limit proves nothing about the account.
    await h.emit(B, [{ kind: "text", text: "late output of a turn started before the limit" }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)?.untilMs).toBe(untilMs);
    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", untilMs });

    // An unclassified runtime error, then its turn's end: for an own-credential
    // agent the first drops the record and the second ends the wait; the
    // account's limit is not B's to drop, and B keeps waiting for it.
    await h.emit(B, [{ kind: "error", message: "Error: something unrelated broke" }, { kind: "turn_end", sessionId: `session-${B}` }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)?.untilMs).toBe(untilMs);
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff, "not shortened to the error's own 10 s").toMatchObject({ kind: "backing_off", untilMs, reason: "rate_limited" });
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === B).at(-1)?.attrs)
      .toMatchObject({ reason: "runtime_error", held_by_shared_limit: true, until_ms: untilMs });
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(await deliveryReachesRuntime(h, B, "for B, still inside the account's wait")).toBe(false);

    // An agent started now runs its first turn on the spawn; its answer proves the account serves again.
    await startIdle(h, D);
    expect(h.m.agents.get(D)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", untilMs });
    const before = { a: writes(h, A), b: writes(h, B) };
    await h.emit(D, [{ kind: "text", text: "answering" }]);
    await settle(() => writes(h, A) > before.a && writes(h, B) > before.b);

    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toBeUndefined();
    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");
    expect(writes(h, A), "A's held delivery is flushed without waiting out the reset").toBeGreaterThan(before.a);
    expect(writes(h, B), "B's held deliveries too").toBeGreaterThan(before.b);
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.agentId === D).at(-1)?.attrs)
      .toMatchObject({ credential_key_kind: "shared", provider_limit_cleared: true, release_cause: "model_output", shared_live_backoffs_ended: 2 });
  });
}, 20_000);

test("own credentials, unchanged: a later non-limit error drops the agent's limit and waits only its own delay", async () => {
  await withManager(async (h) => {
    await startIdle(h, C, ownHome);
    await hitQuota(h, C);
    await h.emit(C, [{ kind: "error", message: "Error: something unrelated broke" }]);
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`)).toBeUndefined();
    expect(h.m.agents.get(C)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", reason: "runtime_error", untilMs: Date.now() + 20_000 });
  });
}, 20_000);

// #proj-raft-computer:#46, C5: a runtime that reports no structured limit
// (Codex) says only "You've hit your usage limit". That is the same used-up
// quota with no reported reset, so it must derive exactly what a structured
// `quota_exhausted` without `resetsAt` derives. It used to take the plain
// terminal-error backoff instead (`recoverable_terminal_runtime_error`, no
// credential record): the other agents on the sign-in kept running into it.
const CODEX_USAGE_LIMIT_TEXT = "You've hit your usage limit. Upgrade your plan or try again later.";

async function deriveLimitState(error: ParsedEvent): Promise<unknown> {
  let derived: unknown;
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await h.emit(A, [error, { kind: "turn_end", sessionId: `session-${A}` }]);
    const now = Date.now();
    const record = h.m.lifecycleRecords.getProviderLimit(SHARED);
    const own = (agentId: string) => {
      const backoff = h.m.agents.get(agentId)!.runtimeErrorDeliveryBackoff;
      return { kind: backoff.kind, reason: backoff.reason, attempts: backoff.attempts, remainingMs: backoff.untilMs - now };
    };
    const armed = h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === A)!.attrs;
    derived = {
      record: record && { ...record, untilMs: record.untilMs - now, recordedAtMs: record.recordedAtMs - now },
      ownRecordForA: h.m.lifecycleRecords.getProviderLimit(`agent:${A}`),
      a: own(A),
      b: own(B),
      bHeld: !(await deliveryReachesRuntime(h, B, "for B during the limit")),
      armed: { ...armed, agentId: undefined, launchId: undefined, provider_limit_source: undefined, until_ms: Number(armed.until_ms) - now },
      bRestore: restoredEvents(h, B).at(-1)?.attrs.restore_point,
    };
  });
  return derived;
}

test("C5: a usage limit known only from its wording derives the same shared state as a structured quota_exhausted with no reset", async () => {
  const fromText = await deriveLimitState({ kind: "error", message: CODEX_USAGE_LIMIT_TEXT });
  const fromStructured = await deriveLimitState({ kind: "error", message: CODEX_USAGE_LIMIT_TEXT, providerLimit: { kind: "quota_exhausted" } });

  expect(fromText).toEqual(fromStructured);
  expect(fromText).toMatchObject({
    record: { reason: "rate_limited", providerLimitKind: "quota_exhausted", attempts: 1, untilMs: 10_000, recordedAtMs: 0 },
    ownRecordForA: undefined,
    a: { kind: "backing_off", reason: "rate_limited", remainingMs: 10_000 },
    b: { kind: "backing_off", reason: "rate_limited", remainingMs: 10_000 },
    bHeld: true,
    bRestore: "shared_credential_limit",
    armed: { reason: "rate_limited", provider_limit_kind: "quota_exhausted", credential_key_kind: "shared", waits_for_reported_reset: false, delay_ms: 10_000, until_ms: 10_000 },
  });
}, 40_000);

test("C5: every usage-limit wording the classifier knows records the limit on the credential, tagged as text; other errors do not", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, C, ownHome);
    for (const text of ["Budget limit exceeded", "Error: quota exceeded for this account", "usage limit reached", "API quota limit hit"]) {
      await h.emit(C, [{ kind: "error", message: text }, { kind: "turn_end", sessionId: `session-${C}` }]);
      expect(h.m.lifecycleRecords.getProviderLimit(`agent:${C}`), text).toMatchObject({ reason: "rate_limited", providerLimitKind: "quota_exhausted" });
      expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === C).at(-1)?.attrs, text)
        .toMatchObject({ reason: "rate_limited", provider_limit_kind: "quota_exhausted", provider_limit_source: "text", credential_key_kind: "agent" });
    }

    await h.emit(A, [{ kind: "error", message: "Error: something unrelated broke" }, { kind: "turn_end", sessionId: `session-${A}` }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toBeUndefined();

    await hitQuota(h, A);
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === A).at(-1)?.attrs)
      .toMatchObject({ provider_limit_source: "structured" });
  });
}, 20_000);

test("Q3: a reported reset 5 hours away holds the sign-in's agents for at most 1 hour", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    const resetsAt = new Date(Date.now() + 5 * 60 * MINUTE_MS).toISOString();
    await h.emit(A, [
      { kind: "error", message: QUOTA_TEXT, providerLimit: { kind: "quota_exhausted", resetsAt } },
      { kind: "turn_end", sessionId: `session-${A}` },
    ]);
    const capMs = 60 * MINUTE_MS;
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toMatchObject({ resetsAt, untilMs: Date.now() + capMs });
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff.untilMs).toBe(Date.now() + capMs);
    expect(await deliveryReachesRuntime(h, B, "for B")).toBe(false);
    const bWrites = writes(h, B);
    await vi.advanceTimersByTimeAsync(capMs);
    await settle(() => writes(h, B) > bWrites);
    expect(writes(h, B), "B's held delivery goes out after 1 hour, not 5").toBeGreaterThan(bWrites);
  });
}, 20_000);

// A limit whose wait is over holds nothing, but is kept for an hour so the
// next process restores its attempts and the next hit waits longer (task #379:
// otherwise a new process per wake restarts at 10 s each time). Quiet for an
// hour, it is dropped on the next read and the credential starts fresh.
test("an elapsed limit holds nothing but carries its attempts for an hour; after that it is removed when next read", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await h.emit(A, [{ kind: "error", message: CODEX_USAGE_LIMIT_TEXT }, { kind: "turn_end", sessionId: `session-${A}` }]);
    const firstUntilMs = h.m.lifecycleRecords.getProviderLimit(SHARED)!.untilMs;
    await vi.advanceTimersByTimeAsync(firstUntilMs - Date.now() + 1_000);

    await startIdle(h, B);
    expect(h.m.lifecycleRecords.providerLimits.has(SHARED), "elapsed under an hour ago: kept").toBe(true);
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", attempts: 1, untilMs: firstUntilMs });
    expect(restoredEvents(h, B).at(-1)?.attrs).toMatchObject({ restore_point: "process_start", remaining_ms_bucket: "elapsed", attempts: 1 });
    expect(await deliveryReachesRuntime(h, B, "for B after the wait"), "an elapsed limit holds nothing").toBe(true);

    await h.emit(B, [{ kind: "error", message: CODEX_USAGE_LIMIT_TEXT }, { kind: "turn_end", sessionId: `session-${B}` }]);
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED), "the next hit keeps growing the wait").toMatchObject({ attempts: 2, untilMs: Date.now() + 20_000 });

    const secondUntilMs = h.m.lifecycleRecords.getProviderLimit(SHARED)!.untilMs;
    await vi.advanceTimersByTimeAsync(secondUntilMs - Date.now() + 60 * MINUTE_MS);
    expect(h.m.lifecycleRecords.providerLimits.has(SHARED), "nothing has read it since").toBe(true);

    await startIdle(h, D);
    expect(h.m.lifecycleRecords.providerLimits.has(SHARED), "elapsed an hour ago: the read at D's start dropped it").toBe(false);
    expect(h.m.agents.get(D)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");
    expect(restoredEvents(h, D)).toEqual([]);

    // The window boundary, read directly with the clock.
    const record = (untilMs: number) => ({ attempts: 3, untilMs, reason: "rate_limited", providerLimitKind: "quota_exhausted", recordedAtMs: 0 });
    h.m.lifecycleRecords.providerLimits.set(SHARED, record(Date.now() - 60 * MINUTE_MS + 1));
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED, Date.now())?.attempts).toBe(3);
    h.m.lifecycleRecords.providerLimits.set(SHARED, record(Date.now() - 60 * MINUTE_MS));
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED, Date.now())).toBeUndefined();
    expect(h.m.lifecycleRecords.providerLimits.has(SHARED)).toBe(false);
  });
}, 20_000);

// Step 3b: the ledger is shared with the OAR host (`providerLimitLedger`).
// What the OAR host records there holds this host's agents on the sign-in,
// what it releases ends their waits, and this host's own limits and releases
// are announced to it.

const oarLimit = (untilMs: number) => ({ attempts: 1, reason: "rate_limited", untilMs, providerLimitKind: "quota_exhausted" as const, recordedAtMs: Date.now() });

test("a limit an OAR agent records on the shared sign-in holds the live legacy agents on it until the OAR host releases it; an own-credential agent is unaffected", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, C, ownHome);
    const untilMs = Date.now() + 30 * MINUTE_MS;

    h.manager.providerLimitLedger.record(SHARED, oarLimit(untilMs), { host: "oar", agentId: "oar-agent" });

    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff).toMatchObject({ kind: "backing_off", untilMs, reason: "rate_limited" });
    expect(restoredEvents(h, A).at(-1)?.attrs).toMatchObject({ restore_point: "shared_credential_limit", credential_key_kind: "shared" });
    expect(await deliveryReachesRuntime(h, A, "for A during the OAR agent's limit")).toBe(false);
    expect(await deliveryReachesRuntime(h, C, "for C, on its own account")).toBe(true);
    const aWrites = writes(h, A);

    h.manager.providerLimitLedger.release(SHARED, "model_output", { host: "oar", agentId: "oar-agent" });
    await settle(() => writes(h, A) > aWrites);

    expect(writes(h, A), "the held delivery goes at the OAR host's release").toBeGreaterThan(aWrites);
    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff.kind).toBe("idle");
    expect(h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.agentId === A)?.attrs)
      .toMatchObject({ reset_source: "provider_limit_released", release_cause: "model_output", released: "live_backoff" });
  });
}, 20_000);

test("a legacy agent's limit on the shared sign-in, and its release by a login, are announced to the OAR host", async () => {
  await withManager(async (h) => {
    const changes: string[] = [];
    h.manager.providerLimitLedger.subscribe((change) => {
      changes.push(`${change.kind}:${change.key}:${change.source.host}${change.kind === "released" ? `:${change.cause}` : ""}`);
    });
    await startIdle(h, A);
    await hitQuota(h, A);
    expect(changes).toEqual([`recorded:${SHARED}:legacy`]);

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    expect(changes).toEqual([`recorded:${SHARED}:legacy`, `released:${SHARED}:legacy:credentials_changed`]);
  });
}, 20_000);

test("C6: a credentials change for the runtime (through the legacy host) releases the OAR agent's held deliveries", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "oar-host-credentials-"));
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", { dataDir, slockHome: dataDir, serverUrl: "http://localhost:3001" });
  const resetsAt = new Date(Date.now() + 30 * MINUTE_MS).toISOString();
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: ["agent-1"], extra: { resetsAt }, ledger: manager.providerLimitLedger });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the shared limit");
    await h.host.deliverMessage("agent-1", oarMessage("m-held"));
    await sleep(50);
    expect(turnInputs.get("agent-1")?.length, "held").toBe(1);

    manager.noteRuntimeCredentialsChanged("codex", "login");

    expect(ledger.has(SHARED)).toBe(false);
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 2, "the held delivery after the login");
    const reset = h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.release_cause === "credentials_changed");
    expect(reset?.attrs.agentId).toBe("agent-1");
    expect(reset?.attrs.host).toBe("oar");
  } finally {
    await h.cleanup();
    await drainAgentManagerForTests(manager);
    await manager.stopAll();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a transient rate limit another agent hits during the shared quota wait never shortens it: the record and every held agent keep the quota reset", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    const untilMs = await hitQuota(h, A);

    await h.emit(B, [
      { kind: "error", message: "429 Too Many Requests", providerLimit: { kind: "transient_rate_limit" } },
      { kind: "turn_end", sessionId: `session-${B}` },
    ]);

    expect(h.m.lifecycleRecords.getProviderLimit(SHARED)).toMatchObject({ untilMs, providerLimitKind: "quota_exhausted" });
    expect(h.m.agents.get(A)?.runtimeErrorDeliveryBackoff.untilMs).toBe(untilMs);
    expect(h.m.agents.get(B)?.runtimeErrorDeliveryBackoff.untilMs, "the throttled agent waits for the quota too").toBe(untilMs);
    expect(h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff" && event.attrs.agentId === B).at(-1)?.attrs)
      .toMatchObject({ provider_limit_kind: "transient_rate_limit", kept_longer_limit: true, until_ms: untilMs });
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(await deliveryReachesRuntime(h, A, "for A after the throttle")).toBe(false);
    expect(await deliveryReachesRuntime(h, B, "for B after the throttle")).toBe(false);
  });
}, 20_000);

// #proj-raft-computer:#46, reconciler step 4a: a rejected sign-in, a plan
// without the model, an exhausted billing balance make the credential's
// current version invalid. The process is not broken: nothing is stopped, and
// the deliveries of every agent the record applies to, on either host, are
// held until the credential changes, a turn on it produces model output, or a
// person stops an agent on it (the Retry).
const AUTH_TEXT = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
const CODEX_PLAN_TEXT = "unexpected status 403 Forbidden: Usage not included in your plan";

async function hitError(h: Harness, agentId: string, text: string): Promise<void> {
  await h.emit(agentId, [{ kind: "error", message: text }, { kind: "turn_end", sessionId: `session-${agentId}` }]);
}

const invalidEvents = (h: Harness, name: string, agentId?: string) => h.events
  .filter((event) => event.name === `daemon.agent.credential_invalid.${name}` && (agentId === undefined || event.attrs.agentId === agentId));

test("4a: an auth error on agent A holds agent B on the same sign-in; an agent with its own CODEX_HOME is unaffected; a login releases both", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);

    await hitError(h, A, AUTH_TEXT);

    expect(h.manager.providerLimitLedger.invalidFor(SHARED, config(A).model)).toMatchObject({ invalidReason: "user_reauth" });
    expect(invalidEvents(h, "held", B).at(-1)?.attrs).toMatchObject({ credential_invalid_reason: "user_reauth", credential_key_kind: "shared", restore_point: "shared_credential_invalid" });
    expect(await deliveryReachesRuntime(h, A, "for A")).toBe(false);
    expect(await deliveryReachesRuntime(h, B, "for B, on the same sign-in")).toBe(false);
    expect(await deliveryReachesRuntime(h, C, "for C, on its own account")).toBe(true);
    for (const agentId of [A, B, C]) expect(h.children.get(agentId), `${agentId}: nothing stopped or restarted`).toHaveLength(1);
    expect(h.children.get(A)!.at(-1)!.exitCode).toBeNull();

    const before = { a: writes(h, A), b: writes(h, B) };
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => writes(h, A) > before.a && writes(h, B) > before.b);
    expect(writes(h, A)).toBeGreaterThan(before.a);
    expect(writes(h, B)).toBeGreaterThan(before.b);
    expect(invalidEvents(h, "released").map((event) => event.attrs.agentId).sort()).toEqual([A, B]);
  });
}, 20_000);

test("4a: Codex 'usage not included in your plan' makes the credential invalid for that model only: same-model agents are held, another model is not, and a model change releases", async () => {
  await withManager(async (h) => {
    await startIdle(h, A, { model: "gpt-x" });
    await startIdle(h, B, { model: "gpt-x" });
    await startIdle(h, D, { model: "gpt-y" });
    await startIdle(h, C, { ...ownHome, model: "gpt-x" });

    await hitError(h, A, CODEX_PLAN_TEXT);

    expect(h.manager.providerLimitLedger.invalidFor(SHARED, "gpt-x")).toMatchObject({ invalidReason: "user_model_access", model: "gpt-x" });
    expect(h.manager.providerLimitLedger.invalidFor(SHARED, "gpt-y")).toBeUndefined();
    expect(h.m.lifecycleRecords.getProviderLimit(SHARED), "the plan, not a limit that waiting ends").toBeUndefined();
    expect(await deliveryReachesRuntime(h, B, "for B on gpt-x")).toBe(false);
    expect(await deliveryReachesRuntime(h, D, "for D on gpt-y")).toBe(true);
    expect(h.children.get(A)).toHaveLength(1);

    // Own credential: the agent restarted on another model is no longer held, and the record for the old model goes.
    await hitError(h, C, CODEX_PLAN_TEXT);
    expect(h.manager.providerLimitLedger.invalidFor(`agent:${C}`, "gpt-x")).toMatchObject({ invalidReason: "user_model_access" });
    await h.manager.stopAgent(C, { silent: true });
    await startIdle(h, C, { ...ownHome, model: "gpt-y" });
    expect(h.manager.providerLimitLedger.invalidFor(`agent:${C}`, "gpt-x"), "model_changed").toBeUndefined();
    expect(await deliveryReachesRuntime(h, C, "for C on gpt-y")).toBe(true);
  });
}, 20_000);

test("4a: an explicit stop (manual restart, the Retry) releases the invalid credential for every agent on it", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await hitError(h, A, AUTH_TEXT);
    expect(await deliveryReachesRuntime(h, B, "for B")).toBe(false);
    const bWrites = writes(h, B);

    await h.manager.stopAgent(A);
    await settle(() => writes(h, B) > bWrites);

    expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(false);
    expect(writes(h, B), "B's held delivery is flushed").toBeGreaterThan(bWrites);
    expect(invalidEvents(h, "cleared", A).at(-1)?.attrs).toMatchObject({ release_cause: "explicit_stop", credential_invalid_reason: "user_reauth", credential_key_kind: "shared", host: "legacy" });
    expect(invalidEvents(h, "released", B).at(-1)?.attrs).toMatchObject({ release_cause: "explicit_stop", released: "held_deliveries" });
  });
}, 20_000);

test("4a: model output from a later turn on the credential proves it works and releases it; output of the failed turn does not", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await hitError(h, A, AUTH_TEXT);
    await h.emit(A, [{ kind: "text", text: "late output of the turn that failed" }]);
    expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await startIdle(h, D);
    const bWrites = writes(h, B);
    await h.emit(D, [{ kind: "text", text: "answering" }]);
    await settle(() => writes(h, B) > bWrites);

    expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(false);
    expect(invalidEvents(h, "cleared", D).at(-1)?.attrs).toMatchObject({ release_cause: "model_output" });
  });
}, 20_000);

test("4a: an invalid credential the OAR host records holds the live legacy agents on the sign-in until it is released there", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, C, ownHome);
    h.manager.providerLimitLedger.recordInvalid(SHARED, { invalidReason: "user_reauth", recordedAtMs: Date.now() }, { host: "oar", agentId: "oar-agent" });
    expect(await deliveryReachesRuntime(h, A, "for A")).toBe(false);
    expect(await deliveryReachesRuntime(h, C, "for C")).toBe(true);
    const aWrites = writes(h, A);

    h.manager.providerLimitLedger.releaseInvalid(SHARED, "model_output", { host: "oar", agentId: "oar-agent" });
    await settle(() => writes(h, A) > aWrites);
    expect(writes(h, A)).toBeGreaterThan(aWrites);
    expect(invalidEvents(h, "released", A).at(-1)?.attrs).toMatchObject({ source_host: "oar", release_cause: "model_output" });
  });
}, 20_000);

test("4a: an OAR auth failure keeps the session and holds its deliveries; a credentials change through the legacy host releases them", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "oar-host-credential-invalid-"));
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", { dataDir, slockHome: dataDir, serverUrl: "http://localhost:3001" });
  const { h, ledger, turnInputs } = await limitHarness("auth", { failing: ["agent-1"], ledger: manager.providerLimitLedger });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    expect(ledger.invalidFor(SHARED, codexShared().model)).toMatchObject({ invalidReason: "user_reauth" });
    expect(h.framesOf("agent:status").some((frame) => frame.status === "inactive"), "the session is not ended").toBe(false);
    expect(h.framesOf("agent:process_exited")).toHaveLength(0);
    expect(h.host.owns("agent-1")).toBe(true);

    await h.host.deliverMessage("agent-1", oarMessage("m-held"));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_for_credential_invalid"), "held");
    await sleep(50);
    expect(turnInputs.get("agent-1")?.length, "held").toBe(1);

    manager.noteRuntimeCredentialsChanged("codex", "login");

    expect(ledger.hasAnyInvalid()).toBe(false);
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 2, "the held delivery after the login");
    const released = h.events.find((event) => event.name === "daemon.agent.credential_invalid.released");
    expect(released?.attrs).toMatchObject({ agentId: "agent-1", release_cause: "credentials_changed", host: "oar", credential_invalid_reason: "user_reauth" });
  } finally {
    await h.cleanup();
    await drainAgentManagerForTests(manager);
    await manager.stopAll();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Reconciler step 4a follow-up (Tenny's release condition): an agent held for
// an invalid credential another agent reported must show why. It shows the
// same copy as the reporting agent's error, with where it came from, as its
// idle status: no `runtimeError` (so no `requiredAction` and no AuthError
// class) and not the `runtime_error` detail kind, so the server neither stores
// it as the agent's runtime error nor puts a login-only wake block on it.
type ActivityFrame = Extract<MachineToServerMessage, { type: "agent:activity" }>;
const activities = (h: Harness, agentId: string) => h.frames
  .filter((frame): frame is ActivityFrame => frame.type === "agent:activity" && frame.agentId === agentId);
const HELD_NOTE = "(Reported by another agent on the same sign-in.)";
// Notices shown, not re-stated: a probe reply repeats the current one.
const heldNotices = (h: Harness, agentId: string) => activities(h, agentId).filter((frame) => frame.detail.includes(HELD_NOTE) && !frame.probeId);

function expectHeldNoticeFrame(frame: ActivityFrame | undefined, copy: RegExp, reason: CredentialHoldReason): void {
  expect(frame).toBeDefined();
  expect(frame!.detail).toMatch(copy);
  expect(frame!.detail.endsWith(HELD_NOTE)).toBe(true);
  // The frame names no activity: the server reads "online" from `idle`.
  expect(frame!.detailKind, "not runtime_error: the server would store it as the agent's runtime error").toBe("idle");
  expect(frame!.runtimeError, "no requiredAction (or AuthError class) for the server's wake block").toBeUndefined();
  // Step 4b: the reason rides typed, so the web never reads the text.
  expect(frame!.credentialHold, "the held notice carries its reason typed").toEqual({ reason });
}

test("4a: an agent held for another agent's auth error on its sign-in shows why once, without requiredAction; an own-CODEX_HOME agent shows nothing; a login shows it idle again", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);
    const cFrames = activities(h, C).length;

    await hitError(h, A, AUTH_TEXT);

    expect(activities(h, A).at(-1)?.runtimeError?.requiredAction, "the reporting agent keeps its own error").toBe("user_reauth");
    expect(heldNotices(h, A)).toHaveLength(0);
    expect(heldNotices(h, B)).toHaveLength(1);
    expectHeldNoticeFrame(heldNotices(h, B)[0], /not logged in/, "user_reauth");
    expect(activities(h, C).length, "C is on its own credential").toBe(cFrames);
    expect(invalidEvents(h, "notice", B).map((event) => event.attrs)).toEqual([expect.objectContaining({
      notice: "shown", visible: true, trigger: "recorded", host: "legacy", credential_key_kind: "shared", credential_invalid_reason: "user_reauth",
    })]);

    // The same rejection recorded again: no second notice.
    await hitError(h, A, AUTH_TEXT);
    expect(heldNotices(h, B)).toHaveLength(1);
    expect(invalidEvents(h, "notice", B)).toHaveLength(1);

    // Step 4b: a probe reply re-states the held notice with its reason.
    h.manager.respondToActivityProbe(B, "probe-held");
    expect(activities(h, B).at(-1)).toMatchObject({ probeId: "probe-held", detailKind: "idle", credentialHold: { reason: "user_reauth" } });

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle();
    expect(activities(h, B).at(-1)).toMatchObject({ detailKind: "idle", detail: "Process idle" });
    expect(activities(h, B).at(-1)?.credentialHold, "released: the idle frame carries no reason").toBeUndefined();
    h.manager.respondToActivityProbe(B, "probe-released");
    expect(activities(h, B).at(-1)).toMatchObject({ probeId: "probe-released", detailKind: "idle" });
    expect(activities(h, B).at(-1)?.credentialHold, "released: nor does a probe reply").toBeUndefined();
    expect(activities(h, A).some((frame) => frame.credentialHold), "the reporting agent shows its own error, never the hold").toBe(false);
    expect(invalidEvents(h, "notice", B).at(-1)?.attrs).toMatchObject({ notice: "cleared", visible: false, release_cause: "credentials_changed" });
    expect(heldNotices(h, B)).toHaveLength(1);
    expect(activities(h, C).length).toBe(cFrames);
  });
}, 20_000);

test("4a: the held notice says plan or billing as the reporting agent's error does; an agent on another model is not held and shows nothing", async () => {
  await withManager(async (h) => {
    await startIdle(h, A, { model: "gpt-x" });
    await startIdle(h, B, { model: "gpt-x" });
    await startIdle(h, D, { model: "gpt-y" });

    await hitError(h, A, CODEX_PLAN_TEXT);
    expectHeldNoticeFrame(heldNotices(h, B).at(-1), /does not include access to the configured model \(gpt-x\)/, "user_model_access");
    expect(heldNotices(h, D)).toHaveLength(0);

    await hitError(h, D, "Your credit balance is too low to access the API");
    expect(heldNotices(h, B), "a new record on the sign-in: one notice for it").toHaveLength(2);
    expectHeldNoticeFrame(heldNotices(h, B).at(-1), /billing or credit balance is exhausted/, "billing");
    expect(heldNotices(h, D), "D reported it: its own error").toHaveLength(0);
    expect(heldNotices(h, A)).toHaveLength(0);
  });
}, 20_000);

test("4a: an agent busy when another agent's record holds it, or started while it holds, shows the notice with its next idle status", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await h.manager.startAgent(B, config(B));
    await settle();

    await hitError(h, A, AUTH_TEXT);
    expect(heldNotices(h, B), "busy: nothing over its running turn").toHaveLength(0);
    await h.emit(B, [{ kind: "turn_end", sessionId: `session-${B}` }]);
    expectHeldNoticeFrame(heldNotices(h, B).at(-1), /not logged in/, "user_reauth");
    expect(invalidEvents(h, "notice", B).at(-1)?.attrs).toMatchObject({ trigger: "idle" });

    await startIdle(h, D);
    expect(heldNotices(h, D)).toHaveLength(1);
    expectHeldNoticeFrame(heldNotices(h, D)[0], /not logged in/, "user_reauth");
  });
}, 20_000);

test("4a: an invalid credential the OAR host records shows the held notice on the live legacy agents on the sign-in; its release shows them idle", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, C, ownHome);
    const cFrames = activities(h, C).length;
    h.manager.providerLimitLedger.recordInvalid(SHARED, { invalidReason: "user_reauth", recordedAtMs: Date.now() }, { host: "oar", agentId: "oar-agent" });
    expect(heldNotices(h, A)).toHaveLength(1);
    expectHeldNoticeFrame(heldNotices(h, A)[0], /not logged in/, "user_reauth");
    expect(activities(h, C).length).toBe(cFrames);

    h.manager.providerLimitLedger.releaseInvalid(SHARED, "model_output", { host: "oar", agentId: "oar-agent" });
    await settle();
    expect(activities(h, A).at(-1)).toMatchObject({ detailKind: "idle", detail: "Process idle" });
    expect(activities(h, A).at(-1)?.credentialHold).toBeUndefined();
  });
}, 20_000);

// #proj-raft-computer:#48, reconciler step 4b: the server blocked the
// reporting agent's automatic wakes for its error (`requiredAction`). When the
// daemon releases the record, each agent that showed it (its own error or the
// held notice) is reported to the server with the reason it showed and the
// release cause, so the server lifts that block, and only a block of that
// reason. Agents that never showed it are not reported.
type RestoredFrame = Extract<MachineToServerMessage, { type: "agent:credential:restored" }>;
const restoredFrames = (h: Harness) => h.frames
  .filter((frame): frame is RestoredFrame => frame.type === "agent:credential:restored")
  .map(({ agentId, reason, releaseCause }) => ({ agentId, reason, releaseCause }))
  .sort((left, right) => `${left.agentId}:${left.reason}`.localeCompare(`${right.agentId}:${right.reason}`));

test("4b: a login tells the server for the agent that showed the error and the one shown the notice; an own-CODEX_HOME agent and a busy agent never shown are not reported", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await startIdle(h, C, ownHome);
    await h.manager.startAgent(D, config(D));
    await settle();

    await hitError(h, A, AUTH_TEXT);
    expect(heldNotices(h, D), "busy: not shown the notice yet").toHaveLength(0);
    expect(restoredFrames(h), "nothing before the release").toEqual([]);

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle();

    expect(restoredFrames(h)).toEqual([
      { agentId: A, reason: "user_reauth", releaseCause: "credentials_changed" },
      { agentId: B, reason: "user_reauth", releaseCause: "credentials_changed" },
    ]);
    expect(invalidEvents(h, "restored_reported").map((event) => event.attrs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: A, shown_as: "own_error", credential_invalid_reason: "user_reauth", release_cause: "credentials_changed", agent_live: true, host: "legacy" }),
      expect.objectContaining({ agentId: B, shown_as: "notice", credential_invalid_reason: "user_reauth", release_cause: "credentials_changed", host: "legacy" }),
    ]));

    // Released once: a second login reports nothing more.
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle();
    expect(restoredFrames(h)).toHaveLength(2);
  });
}, 20_000);

test("4b: model output on the sign-in (on either host) reports the plan-access error with its reason; an agent on another model, never held, is not reported", async () => {
  await withManager(async (h) => {
    await startIdle(h, A, { model: "gpt-x" });
    await startIdle(h, B, { model: "gpt-x" });
    await startIdle(h, D, { model: "gpt-y" });
    await hitError(h, A, CODEX_PLAN_TEXT);

    h.manager.providerLimitLedger.releaseInvalid(SHARED, "model_output", { host: "oar", agentId: "oar-agent" });
    await settle();

    expect(restoredFrames(h)).toEqual([
      { agentId: A, reason: "user_model_access", releaseCause: "model_output" },
      { agentId: B, reason: "user_model_access", releaseCause: "model_output" },
    ]);
  });
}, 20_000);

test("4b: a billing record replacing the sign-in's auth record still reports the auth error the first agent showed when it ends", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, D);
    await hitError(h, A, AUTH_TEXT);
    await hitError(h, D, "Your credit balance is too low to access the API");
    expect(h.manager.providerLimitLedger.invalidFor(SHARED, config(A).model)).toMatchObject({ invalidReason: "billing" });

    await h.manager.stopAgent(D);
    await settle();

    expect(restoredFrames(h), "A's server block is for user_reauth; D showed the auth notice, then its own billing error").toEqual([
      { agentId: A, reason: "user_reauth", releaseCause: "explicit_stop" },
      { agentId: D, reason: "billing", releaseCause: "explicit_stop" },
      { agentId: D, reason: "user_reauth", releaseCause: "explicit_stop" },
    ]);
  });
}, 20_000);

test("4b: the Retry (an explicit stop) of the agent that showed the error reports it too; the server lifts that block itself as well", async () => {
  await withManager(async (h) => {
    await startIdle(h, A);
    await startIdle(h, B);
    await hitError(h, A, AUTH_TEXT);

    await h.manager.stopAgent(A);
    await settle();

    expect(restoredFrames(h)).toEqual([
      { agentId: A, reason: "user_reauth", releaseCause: "explicit_stop" },
      { agentId: B, reason: "user_reauth", releaseCause: "explicit_stop" },
    ]);
  });
}, 20_000);
