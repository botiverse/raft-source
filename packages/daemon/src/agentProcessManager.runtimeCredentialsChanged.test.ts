// #proj-raft-computer:#46 (xxchan): after a Codex sign-in from the web, agents
// that had hit "Your access token could not be refreshed ..." stayed stuck
// until a human sent another message: the auth error SIGTERMed the process,
// dropped its restart snapshot and gated it until a user turn. Reconciler step
// 4a: the error makes the credential invalid, not the process broken. The
// process (and its background tasks) is kept, deliveries are held, and a
// successful web login or provider connect (RuntimeAuthHost
// `onCredentialsChanged`) for that runtime's machine-shared credential hands
// them to the same process with no human message. It also ends the
// provider-limit backoff kept across processes.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, sharedCredentialsAuthRuntime, type AgentConfig, type AgentMessage, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";
import type { StickyFailureRecords } from "./stickyFailureRecords";

const AGENT = "agent-credentials";
const AUTH_ERROR = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
const MODEL_ERROR = "The requested model is not supported for this account.";
const QUOTA_TEXT = "You've hit your usage limit. Try again later.";
const HOUR_MS = 60 * 60_000;

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly killSignals: string[] = [];
  readonly stdin = { write: (chunk: string) => { this.writes.push(String(chunk)); return true; } };
  kill(signal: string = "SIGTERM"): boolean {
    this.killSignals.push(signal);
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

type LiveProcess = {
  inbox: AgentMessage[];
  recentStderr: string[];
  lastRuntimeError: string | null;
  sessionId: string | null;
  backgroundTasks: Map<string, unknown>;
  runtimeErrorDeliveryBackoff: { kind: string; untilMs: number };
};
type Internals = {
  agents: Map<string, LiveProcess>;
  commitApmIdleState(agentId: string, ap: LiveProcess, idle: boolean): void;
  startingInboxes: { values(agentId: string): AgentMessage[] | undefined };
  lifecycleRecords: {
    terminalFailures: Map<string, unknown>;
    getSpawnFailBackoff(agentId: string): { untilMs: number; reason: string } | undefined;
    getProviderLimit(key: string): { untilMs: number } | undefined;
    getRestartSnapshot(agentId: string): { sessionId: string | null } | undefined;
  };
};

type Harness = {
  manager: AgentProcessManager;
  m: Internals;
  children: FakeChild[];
  sent: MachineToServerMessage[];
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  emit: (events: ParsedEvent[]) => Promise<void>;
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-credentials-changed-test-"));
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
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((msg) => { sent.push(msg); }, "sk_machine_test", {
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
  try {
    await run({ manager, m, children, sent, events, emit });
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

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return promptConfig({ name: AGENT, displayName: AGENT, sessionId: "session-1", ...overrides });
}

/**
 * A live, idle agent whose prior turn left a sticky error, as in the B.5
 * reproduction (agentProcessManager.claude.test.ts): the classifier reads the
 * process's error history, which nothing but B.5 resets.
 */
/** An autonomous wake (reminder, system notice): B.5 never recovers on one, so only the login can un-stick it. */
async function autonomousWakeReachesRuntime(h: Harness): Promise<boolean> {
  const writesBefore = h.children.at(-1)!.writes.length;
  await h.manager.deliverMessage(AGENT, message("reminder"), { transient: true });
  await settle();
  return h.children.at(-1)!.writes.length > writesBefore;
}

const clearedEvents = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.runtime_credentials_changed.cleared");

test("only an agent on the runtime's machine-shared credentials counts", () => {
  expect(sharedCredentialsAuthRuntime(agentConfig())).toBe("codex");
  expect(sharedCredentialsAuthRuntime(agentConfig({ envVars: { CODEX_HOME: "/srv/codex-agent-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ envVars: { HOME: "/srv/agent-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ envVars: { OPENAI_BASE_URL: "https://example.test" } }))).toBe("codex");
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "claude" }))).toBe("claude");
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "claude", envVars: { CLAUDE_CONFIG_DIR: "/srv/claude-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "kimi-sdk", envVars: { KIMI_CODE_HOME: "/srv/kimi-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "kimi" })), "the Kimi CLI has no web sign-in").toBeNull();
  // Otter (#46): own credential homes and keys passed directly are not the shared sign-in.
  expect(sharedCredentialsAuthRuntime(agentConfig({ envVars: { OPENAI_API_KEY: "sk-test" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "claude", envVars: { ANTHROPIC_API_KEY: "k" } })), "scrubbed from a Claude agent's env, so it still runs on the shared sign-in").toBe("claude");
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "claude", envVars: { ANTHROPIC_AUTH_TOKEN: "t" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qwen" }))).toBe("qwen");
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qwen", envVars: { QWEN_HOME: "/srv/qwen-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qoder" }))).toBe("qoder");
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qoder", envVars: { QODER_CONFIG_DIR_NAME: ".qoder-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qoder", envVars: { QODERCN_CONFIG_DIR_NAME: ".qodercn-1" } }))).toBeNull();
  expect(sharedCredentialsAuthRuntime(agentConfig({ runtime: "qoder", envVars: { QODER_PERSONAL_ACCESS_TOKEN: "pat" } }))).toBeNull();
});

const writes = (h: Harness) => h.children.at(-1)!.writes.length;

/** Whether a user message reaches the runtime now (rather than being held in the inbox). */
async function deliveryReachesRuntime(h: Harness, content: string): Promise<boolean> {
  const before = writes(h);
  expect(await h.manager.deliverMessage(AGENT, message(content))).toBe(true);
  await settle();
  return writes(h) > before;
}

/** A live, idle agent whose next turn (a user message) ends in the runtime error `text`. */
async function idleAgentHitsError(h: Harness, config: AgentConfig, text: string, before: ParsedEvent[] = []): Promise<LiveProcess> {
  await h.manager.startAgent(AGENT, config);
  await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
  expect(await deliveryReachesRuntime(h, "the turn that hits the error")).toBe(true);
  await h.emit([...before, { kind: "error", message: text }, { kind: "turn_end", sessionId: "session-1" }]);
  return h.m.agents.get(AGENT)!;
}

const inactiveFrames = (h: Harness) => h.sent.filter((frame) => frame.type === "agent:status" && frame.status === "inactive");
const lastError = (h: Harness) => h.sent.filter((frame) => frame.type === "agent:activity" && frame.detailKind === "runtime_error").at(-1) as
  | (MachineToServerMessage & { detail?: string; runtimeError?: { requiredAction?: string } })
  | undefined;
const eventsNamed = (h: Harness, name: string) => h.events.filter((event) => event.name === name);

test("#46 regression: an auth error on the shared Codex sign-in keeps the process and holds deliveries; a Codex login hands them to the same process with no new message", async () => {
  await withManager(async (h) => {
    const ap = await idleAgentHitsError(h, agentConfig(), AUTH_ERROR);
    const child = h.children[0]!;

    expect(child.killSignals, "the process is not stopped").toEqual([]);
    expect(h.m.agents.get(AGENT)).toBe(ap);
    expect(ap.sessionId, "its session is kept").toBe("session-1");
    expect(inactiveFrames(h)).toEqual([]);
    expect(h.m.lifecycleRecords.terminalFailures.has(AGENT)).toBe(false);
    expect(h.manager.providerLimitLedger.invalidFor("shared:codex", agentConfig().model)).toMatchObject({ invalidReason: "user_reauth" });
    expect(lastError(h)?.detail, "the user still sees what to do").toMatch(/not logged in/);
    expect(lastError(h)?.runtimeError?.requiredAction).toBe("user_reauth");
    expect(eventsNamed(h, "daemon.agent.credential_invalid.recorded").at(-1)?.attrs)
      .toMatchObject({ credential_invalid_reason: "user_reauth", credential_key_kind: "shared", host: "legacy", source: "runtime_error" });

    const held = writes(h);
    expect(await deliveryReachesRuntime(h, "held 1")).toBe(false);
    expect(await deliveryReachesRuntime(h, "held 2")).toBe(false);
    expect(await autonomousWakeReachesRuntime(h), "an autonomous wake would only hit the same rejection").toBe(false);
    // Nothing times the hold out (no backoff timer runs it).
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(writes(h)).toBe(held);
    expect(ap.inbox.map((entry) => entry.content)).toEqual(expect.arrayContaining(["held 1", "held 2"]));

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => writes(h) > held);

    expect(writes(h), "the held deliveries go to the same process").toBeGreaterThan(held);
    expect(h.children, "neither stopped nor restarted").toHaveLength(1);
    expect(h.m.agents.get(AGENT)).toBe(ap);
    expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(false);
    expect(clearedEvents(h).at(-1)?.attrs).toMatchObject({
      runtime: "codex", reason: "login", release_cause: "credentials_changed", credential_invalid_released: 1, credential_invalid_reason: "user_reauth",
    });
    expect(eventsNamed(h, "daemon.agent.credential_invalid.released").at(-1)?.attrs).toMatchObject({
      agentId: AGENT, release_cause: "credentials_changed", released: "held_deliveries", credential_invalid_reason: "user_reauth", credential_key_kind: "shared", host: "legacy",
    });
  });
}, 20_000);

test("a background task running when the auth error comes is not killed: the process and the task stay", async () => {
  await withManager(async (h) => {
    const task: ParsedEvent = { kind: "subagent_progress", source: "claude_task_lifecycle", phase: "started", taskId: "task-1", parentToolUseId: "toolu_1", payloadBytes: 64 } as ParsedEvent;
    const ap = await idleAgentHitsError(h, agentConfig(), AUTH_ERROR, [task]);
    expect(h.children[0]!.killSignals).toEqual([]);
    expect(h.m.agents.get(AGENT)).toBe(ap);
    expect([...ap.backgroundTasks.keys()]).toEqual(["task-1"]);
    expect(eventsNamed(h, "daemon.agent.credential_invalid.recorded").at(-1)?.attrs.background_tasks_outstanding).toBe(1);
  });
}, 20_000);

test("a process that exits while its credential is invalid keeps its restart snapshot and waits for the credential; a login starts it from the held deliveries", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig(), AUTH_ERROR);
    h.children[0]!.end(1);
    await settle();

    expect(h.m.agents.has(AGENT)).toBe(false);
    expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, "the restart snapshot (and session) is kept").toBe("session-1");
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.reason).toBe("credential_invalid");
    expect(inactiveFrames(h)).toEqual([]);
    expect(await h.manager.deliverMessage(AGENT, message("while closed"))).toBe(true);
    await settle();
    expect(h.children, "not restarted into the same rejection").toHaveLength(1);

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => h.children.length > 1, 2_000);

    expect(h.children).toHaveLength(2);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(expect.arrayContaining(["while closed"]));
    expect(eventsNamed(h, "daemon.agent.credential_invalid.released").at(-1)?.attrs).toMatchObject({ released: "cooldown", release_cause: "credentials_changed" });
  });
}, 20_000);

// Task #50: a server start (a wake) of an agent held for its invalid
// credential waits with the held deliveries instead of spawning into the same
// rejection; the launch settles `deferred`. A login then starts it from all of
// them. RED proof: drop the credential-hold branch in spawnAgentProcess and the
// wake spawns a second process.
test("a server start of an agent held for its invalid credential does not spawn; its wake waits with the held deliveries", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig(), AUTH_ERROR);
    h.children[0]!.end(1);
    await settle();
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.reason).toBe("credential_invalid");
    const untilMs = h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)!.untilMs;

    await h.manager.startAgent(AGENT, agentConfig(), message("server wake"), undefined, undefined, "launch-wake");
    await settle();

    expect(h.children, "the wake spawned nothing").toHaveLength(1);
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.untilMs, "the hold keeps its deadline").toBe(untilMs);
    expect(eventsNamed(h, "daemon.agent.start.held_credential_invalid").at(-1)?.attrs).toMatchObject({
      invalid_reason: "user_reauth",
    });
    expect(inactiveFrames(h)).toEqual([]);

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => h.children.length > 1, 2_000);
    expect(h.children).toHaveLength(2);
    const inbox = h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content) ?? [];
    expect(inbox.filter((content) => content === "server wake"), "the wake is held once").toHaveLength(1);
  });
}, 20_000);

// Task #50 (Tenny d723678d): an exhausted billing balance (402) is the same
// credential hold; once the hold's deadline has passed, a server start spawns
// as any start does.
test("a 402 billing hold holds a server start too; after the hold's deadline a server start spawns", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig(), "API Error: 402 {\"error\":{\"message\":\"Insufficient balance\"}}");
    h.children[0]!.end(1);
    await settle();
    const hold = h.m.lifecycleRecords.getSpawnFailBackoff(AGENT);
    expect(hold?.reason).toBe("credential_invalid");

    await h.manager.startAgent(AGENT, agentConfig(), message("wake inside the hold"), undefined, undefined, "launch-in-hold");
    await settle();
    expect(h.children, "held: the billing refusal is not asked again").toHaveLength(1);
    expect(eventsNamed(h, "daemon.agent.start.held_credential_invalid").at(-1)?.attrs).toMatchObject({ invalid_reason: "billing" });

    // Past the deadline without running its timer: the start itself is not held.
    vi.setSystemTime(hold!.untilMs + 1);
    await h.manager.startAgent(AGENT, agentConfig(), message("wake after the hold"), undefined, undefined, "launch-after-hold");
    await settle(() => h.children.length > 1, 2_000);
    expect(h.children).toHaveLength(2);
  });
}, 20_000);

test("an agent with its own CODEX_HOME stays held after a Codex login: its credential did not change", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig({ envVars: { CODEX_HOME: "/srv/codex-agent-1" } }), AUTH_ERROR);
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    expect(h.manager.providerLimitLedger.invalidFor(`agent:${AGENT}`, agentConfig().model)).toMatchObject({ invalidReason: "user_reauth" });
    expect(await deliveryReachesRuntime(h, "still held")).toBe(false);
    expect(clearedEvents(h).at(-1)?.attrs.credential_invalid_released).toBe(0);
  });
}, 20_000);

test("a login for another runtime, or a logout, releases nothing; a login on the runtime lifts its unusable model", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig(), AUTH_ERROR);
    h.manager.noteRuntimeCredentialsChanged("claude", "login");
    h.manager.noteRuntimeCredentialsChanged("kimi", "connect_provider");
    h.manager.noteRuntimeCredentialsChanged("codex", "logout");
    expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(true);
    expect(await deliveryReachesRuntime(h, "still held")).toBe(false);
  });
  // Reconciler step 12 (Tenny msg 96fa8766, decision 2): a model the runtime
  // cannot use is the server's pause now (`model_unsupported`); a new sign-in
  // or plan may have it, so the daemon's own record of it lifts on a login on
  // that runtime too, never on another runtime's or a logout.
  await withManager(async (h) => {
    await h.manager.startAgent(AGENT, agentConfig());
    await h.emit([{ kind: "error", message: MODEL_ERROR }]);
    expect(h.m.agents.has(AGENT), "the process ended at the error").toBe(false);
    const sticky = (h.m as unknown as { lifecycleRecords: { exitStreaks: { sticky: StickyFailureRecords } } }).lifecycleRecords.exitStreaks.sticky;
    const unusable = () => sticky.isUnusableModel(AGENT, "codex", agentConfig().model);
    expect(unusable()).toBe(true);
    h.manager.noteRuntimeCredentialsChanged("claude", "login");
    h.manager.noteRuntimeCredentialsChanged("codex", "logout");
    expect(unusable()).toBe(true);
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    expect(unusable()).toBe(false);
  });
}, 20_000);

/** The provider-limit credential key: the shared sign-in's, or this agent's own. */
function limitKey(config: AgentConfig): string {
  const shared = sharedCredentialsAuthRuntime(config);
  return shared ? `shared:${shared}` : `agent:${AGENT}`;
}

async function closeInsideQuotaBackoff(h: Harness, config: AgentConfig): Promise<void> {
  await h.manager.startAgent(AGENT, config);
  await h.manager.deliverMessage(AGENT, message("first"));
  await settle(() => (h.m.agents.get(AGENT)?.inbox.length ?? 0) > 0);
  // A weekly quota days from its reset: the wait is capped at an hour, then tried again (agentProcessManager.recoverableCrashBackoff.test.ts).
  const resetsAt = new Date(Date.now() + 5 * 24 * HOUR_MS).toISOString();
  await h.emit([{ kind: "error", message: QUOTA_TEXT, providerLimit: { kind: "quota_exhausted", resetsAt } }]);
  expect(h.m.lifecycleRecords.getProviderLimit(limitKey(config))?.untilMs).toBe(Date.now() + HOUR_MS);
  h.children.at(-1)!.end(1);
  await settle();
  expect(h.m.agents.has(AGENT)).toBe(false);
  expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.untilMs, "held in the cooldown until the quota wait ends").toBe(Date.now() + HOUR_MS);
  expect(await h.manager.deliverMessage(AGENT, message("during the wait"))).toBe(true);
  await settle();
  expect(h.children, "no respawn inside the wait").toHaveLength(1);
}

test("a Codex login ends the provider-limit wait of an agent on the shared login: it starts from its pending inbox at once", async () => {
  await withManager(async (h) => {
    await closeInsideQuotaBackoff(h, agentConfig());
    expect(h.m.lifecycleRecords.getProviderLimit("shared:codex")).toBeDefined();

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => h.children.length > 1, 2_000);

    expect(h.children, "started without waiting out the hour").toHaveLength(2);
    expect(h.m.lifecycleRecords.getProviderLimit("shared:codex")).toBeUndefined();
    expect(h.m.agents.get(AGENT)?.runtimeErrorDeliveryBackoff.kind, "the new process inherits no wait").toBe("idle");
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(["first", "during the wait"]);
    expect(clearedEvents(h).at(-1)?.attrs).toMatchObject({ provider_limit_backoffs_cleared: 1, cooldowns_ended: 1 });
  });
}, 20_000);

test("the provider-limit wait stays for an agent with its own CODEX_HOME, after another runtime's login, and after a logout", async () => {
  await withManager(async (h) => {
    await closeInsideQuotaBackoff(h, agentConfig({ envVars: { CODEX_HOME: "/srv/codex-agent-1" } }));
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle();
    expect(h.children).toHaveLength(1);
    expect(h.m.lifecycleRecords.getProviderLimit(`agent:${AGENT}`)).toBeDefined();
  });
  await withManager(async (h) => {
    await closeInsideQuotaBackoff(h, agentConfig());
    h.manager.noteRuntimeCredentialsChanged("claude", "login");
    h.manager.noteRuntimeCredentialsChanged("codex", "logout");
    await settle();
    expect(h.children).toHaveLength(1);
    expect(h.m.lifecycleRecords.getProviderLimit("shared:codex")).toBeDefined();
    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.untilMs).toBeGreaterThan(Date.now());
  });
}, 20_000);

// Reconciler step 6 (Tenny): a server features stop is the daemon's own stop
// of an idle process. With the credential invalid it closes into the same
// credential hold as any clean exit, but nothing it did asks for a start: the
// hold's deadline (CREDENTIAL_INVALID_CLOSED_HOLD_MS) starts nothing, a
// message that arrives later waits for the credential, and goes once it is
// restored.
test("a server features stop while the credential is invalid: no restart at the hold's deadline; a later message waits for the credential", async () => {
  await withManager(async (h) => {
    await idleAgentHitsError(h, agentConfig({ enabledApps: [] }), AUTH_ERROR);
    h.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await settle(() => !h.m.agents.has(AGENT));
    expect(h.m.agents.has(AGENT), "stopped: idle, the error and the invalid credential do not hold it").toBe(false);
    expect(eventsNamed(h, "daemon.agent.spec_restart_stop").at(-1)?.attrs).toMatchObject({ agentId: AGENT, drift: "features", trigger: "signal", host: "legacy" });
    expect(h.m.lifecycleRecords.getRestartSnapshot(AGENT)?.sessionId, "the session is kept").toBe("session-1");

    expect(h.m.lifecycleRecords.getSpawnFailBackoff(AGENT)?.reason).toBe("credential_invalid");

    await vi.advanceTimersByTimeAsync(HOUR_MS + 60_000);
    await settle();
    expect(h.children, "no start at the hold's deadline").toHaveLength(1);
    expect(eventsNamed(h, "daemon.agent.spawn_fail_cooldown.expired_restart")).toEqual([]);

    expect(await h.manager.deliverMessage(AGENT, message("after the deadline"))).toBe(true);
    await settle();
    expect(h.children, "held: not started into the same rejection").toHaveLength(1);
    // A held message does not turn the next deadline into a try of the credential either.
    await vi.advanceTimersByTimeAsync(HOUR_MS + 60_000);
    await settle();
    expect(h.children).toHaveLength(1);
    expect(eventsNamed(h, "daemon.agent.credential_invalid.hold_renewed").length).toBeGreaterThanOrEqual(2);

    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await settle(() => h.children.length > 1, 2_000);
    expect(h.children).toHaveLength(2);
    expect(h.m.agents.get(AGENT)?.inbox.map((entry) => entry.content)).toEqual(expect.arrayContaining(["after the deadline"]));
  });
}, 20_000);
