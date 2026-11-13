// Reconciler step 15 (task #48, Tenny + Otter): a live Codex or Claude
// process keeps the provider account it started with (for Claude verified by
// a live test, task #48, Otter bfe2d441). When its held credential is
// released for a credentials change (a web login, or a change on disk) and
// now signs in as another account, or one that cannot be read while the
// start's was known, the process is stopped once idle and started again on
// the same session with its held deliveries; the same account only releases.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { CredentialDiskWatch } from "./credentialDiskWatch";
import { createCredentialAccountReader } from "./credentialSource";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { ParsedEvent, RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const AGENT = "agent-credential-account";
const AUTH_ERROR = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";

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
  home: string;
  spawnConfigs: AgentConfig[];
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-credential-account-test-"));
  const children: FakeChild[] = [];
  const spawnConfigs: AgentConfig[] = [];
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
      spawnConfigs.push(ctx.config);
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
    credentialAccountReader: createCredentialAccountReader(() => ({}), { homeDir: dataDir, platform: "linux", cwd: dataDir }),
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
    await run({ manager, m, children, sent, events, emit, home: dataDir, spawnConfigs });
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

const eventsNamed = (h: Harness, name: string) => h.events.filter((event) => event.name === name);
const writes = (h: Harness) => h.children.at(-1)!.writes.length;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  const at = new Date(Date.now() + Math.floor(Math.random() * 1000) * 1000);
  utimesSync(file, at, at);
}

const codexAuth = (h: Harness) => path.join(h.home, ".codex", "auth.json");
const claudeAccountFile = (h: Harness) => path.join(h.home, ".claude.json");
const writeCodexAccount = (h: Harness, accountId: string) => writeJson(codexAuth(h), { tokens: { account_id: accountId, access_token: `token-${accountId}-${Math.random()}` } });
const writeClaudeAccount = (h: Harness, accountUuid: string) => writeJson(claudeAccountFile(h), { oauthAccount: { accountUuid, emailAddress: "someone@example.test" } });

async function deliveryReachesRuntime(h: Harness, content: string): Promise<boolean> {
  const before = writes(h);
  expect(await h.manager.deliverMessage(AGENT, message(content))).toBe(true);
  await settle();
  return writes(h) > before;
}

/** A live, idle agent held for an invalid credential, with one held delivery. */
async function heldAgent(h: Harness, config: AgentConfig): Promise<LiveProcess> {
  await h.manager.startAgent(AGENT, config);
  await h.emit([{ kind: "turn_end", sessionId: "session-1" }]);
  expect(await deliveryReachesRuntime(h, "the turn that hits the error")).toBe(true);
  await h.emit([{ kind: "error", message: AUTH_ERROR }, { kind: "turn_end", sessionId: "session-1" }]);
  expect(await deliveryReachesRuntime(h, "held 1")).toBe(false);
  return h.m.agents.get(AGENT)!;
}

/** The held process was stopped and the agent started again on its session, with the held delivery. */
async function expectRestartedOnSession(h: Harness, check: "account_changed" | "account_unknown"): Promise<void> {
  await settle(() => h.children.length > 1, 3_000);
  expect(h.children[0]!.killSignals, "the held process is stopped").toContain("SIGTERM");
  expect(h.children, "and started again").toHaveLength(2);
  expect(h.spawnConfigs.at(-1)?.sessionId, "on the same session").toBe("session-1");
  const next = h.m.agents.get(AGENT)!;
  const told = [...h.children[1]!.writes, ...next.inbox.map((entry) => entry.content)].join("\n");
  expect(told, "with the held delivery").toContain("held 1");
  expect(eventsNamed(h, "daemon.agent.credential_account.restart").at(-1)?.attrs).toMatchObject({
    agentId: AGENT,
    release_cause: "credentials_changed",
    account_changed: check === "account_changed",
    account_unknown: check === "account_unknown",
    host: "legacy",
  });
  expect(eventsNamed(h, "daemon.agent.spec_restart_stop").at(-1)?.attrs).toMatchObject({ drift: "credential_account" });
  // Booleans and reasons only: never an account id.
  expect(JSON.stringify(h.events)).not.toMatch(/acct-|uuid-/u);
}

async function expectReleasedOnly(h: Harness, ap: LiveProcess, held: number, check: string): Promise<void> {
  await settle(() => writes(h) > held);
  expect(writes(h), "the held delivery goes to the same process").toBeGreaterThan(held);
  expect(h.children, "neither stopped nor restarted").toHaveLength(1);
  expect(h.children[0]!.killSignals).toEqual([]);
  expect(h.m.agents.get(AGENT)).toBe(ap);
  expect(eventsNamed(h, "daemon.agent.credential_account.restart")).toEqual([]);
  expect(eventsNamed(h, "daemon.agent.credential_invalid.released").at(-1)?.attrs).toMatchObject({ released: "held_deliveries", account_check: check });
}

test("Codex, web login as another account: the held process is stopped and started again on its session", async () => {
  await withManager(async (h) => {
    writeCodexAccount(h, "acct-A");
    await heldAgent(h, agentConfig());
    writeCodexAccount(h, "acct-B");
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await expectRestartedOnSession(h, "account_changed");
  });
}, 20_000);

test("Codex, terminal login as another account (disk change): the held process is stopped and started again on its session", async () => {
  await withManager(async (h) => {
    writeCodexAccount(h, "acct-A");
    const watch = new CredentialDiskWatch({
      ledger: h.manager.providerLimitLedger,
      recordEvent: () => {},
      baseEnv: () => ({}),
      homeDir: h.home,
      platform: "linux",
      cwd: h.home,
      setInterval: () => ({}),
      clearInterval: () => {},
    });
    try {
      await heldAgent(h, agentConfig());
      expect(watch.watchedCount).toBe(1);
      writeCodexAccount(h, "acct-B");
      await watch.check();
      expect(h.manager.providerLimitLedger.hasAnyInvalid()).toBe(false);
      await expectRestartedOnSession(h, "account_changed");
    } finally {
      watch.stop();
    }
  });
}, 20_000);

test("Codex, the same account signed in again: release only (held deliveries go to the same process)", async () => {
  await withManager(async (h) => {
    writeCodexAccount(h, "acct-A");
    const ap = await heldAgent(h, agentConfig());
    const held = writes(h);
    writeCodexAccount(h, "acct-A");
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await expectReleasedOnly(h, ap, held, "same_account");
  });
}, 20_000);

test("Claude, signed in as another account (.claude.json oauthAccount.accountUuid): restarted on its session", async () => {
  await withManager(async (h) => {
    writeClaudeAccount(h, "uuid-A");
    await heldAgent(h, agentConfig({ runtime: "claude" }));
    writeClaudeAccount(h, "uuid-B");
    h.manager.noteRuntimeCredentialsChanged("claude", "login");
    await expectRestartedOnSession(h, "account_changed");
  });
}, 20_000);

test("Claude, the same account: release only", async () => {
  await withManager(async (h) => {
    writeClaudeAccount(h, "uuid-A");
    const ap = await heldAgent(h, agentConfig({ runtime: "claude" }));
    const held = writes(h);
    writeClaudeAccount(h, "uuid-A");
    h.manager.noteRuntimeCredentialsChanged("claude", "login");
    await expectReleasedOnly(h, ap, held, "same_account");
  });
}, 20_000);

test("the account cannot be read now while it was known at the start: restarted", async () => {
  await withManager(async (h) => {
    writeCodexAccount(h, "acct-A");
    await heldAgent(h, agentConfig());
    rmSync(codexAuth(h));
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await expectRestartedOnSession(h, "account_unknown");
  });
}, 20_000);

test("the account was not known at the start: release only", async () => {
  await withManager(async (h) => {
    const ap = await heldAgent(h, agentConfig());
    const held = writes(h);
    writeCodexAccount(h, "acct-B");
    h.manager.noteRuntimeCredentialsChanged("codex", "login");
    await expectReleasedOnly(h, ap, held, "started_unknown");
  });
}, 20_000);
