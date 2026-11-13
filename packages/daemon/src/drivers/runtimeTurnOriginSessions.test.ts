import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { KimiHarness, Session as KimiSession } from "@botiverse/kimi-code-sdk";
import { asAxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeTurnOriginReader } from "../runtimeTurnOrigin";
import { KimiSdkRuntimeSession } from "./kimi-sdk";
import { PiSdkRuntimeSession } from "./pi";
import { ChildProcessRuntimeSession } from "./runtimeSession";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./types";

// Task #21 (@peng msg 3bc1a766). Each RuntimeSession implementation owns its turn origin. These pin,
// per implementation, the four rules the call surfaces rely on: a new prompt sets it, a steer does
// not change it, turn_end/exit/stop clear it, and the getter handed to the call surfaces is the one
// the session actually updates.

const M1 = { sourceMessageId: "11111111-1111-4111-8111-111111111111" };
const M2 = { sourceMessageId: "22222222-2222-4222-8222-222222222222" };

function spawnContext(processInstanceId: string | null = "process-1"): SpawnContext {
  return {
    agentId: "agent-1",
    config: {
      name: "agent",
      displayName: "Agent",
      description: "test",
      model: "model",
      runtime: "origin-test",
      reasoningEffort: null,
      envVars: null,
      sessionId: null,
      serverUrl: "https://raft.example.test",
      authToken: "sk_machine_test",
      runtimeContext: null,
    },
    standingPrompt: "",
    prompt: "",
    workingDirectory: "/tmp/agent",
    slockCliPath: "/tmp/slock",
    daemonApiKey: "token",
    processInstanceId,
  };
}

const origin = (read: RuntimeTurnOriginReader | undefined) => read?.()?.sourceMessageId ?? null;

// ------------------------------------------------------------------ child process

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4321;
  kill(signal?: NodeJS.Signals) {
    this.signalCode = signal ?? "SIGTERM";
    return true;
  }
  line(text: string) {
    this.stdout.emit("data", Buffer.from(`${text}\n`));
  }
}

class OriginDriver implements RuntimeDriver {
  readonly id = "origin-test";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "fresh", compaction: "unreported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly child = new FakeChild();
  encodeNull = false;
  spawnedCtx: SpawnContext | null = null;

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnedCtx = ctx;
    return { process: this.child as unknown as ChildProcess };
  }
  parseLine(line: string): ParsedEvent[] {
    return line === "TURN_END" ? [{ kind: "turn_end" }] : [];
  }
  encodeStdinMessage(text: string): string | null {
    return this.encodeNull ? null : text;
  }
  buildSystemPrompt() {
    return asAxSurfaceText("");
  }
}

test("child process: start sets the origin, steer keeps it, turn_end clears it, the next prompt sets its own", async () => {
  const driver = new OriginDriver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext());
  await session.start({ text: "first", origin: M1 });
  const read = driver.spawnedCtx?.readTurnOrigin;
  assert.equal(typeof read, "function", "spawn must receive the session's getter");
  assert.equal(origin(read), M1.sourceMessageId);

  assert.deepEqual(session.send({ mode: "busy", text: "steer", origin: M2 }), { ok: true, acceptedAs: "steer" });
  assert.equal(origin(read), M1.sourceMessageId, "⭐ a steer must not re-home the running turn");

  driver.child.line("TURN_END");
  assert.equal(origin(read), null);

  session.send({ mode: "idle", text: "second", origin: M2 });
  assert.equal(origin(read), M2.sourceMessageId);
});

test("child process: an idle prompt before turn_end fails closed instead of overwriting", async () => {
  const driver = new OriginDriver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext());
  await session.start({ text: "first", origin: M1 });
  session.send({ mode: "idle", text: "second", origin: M2 });
  assert.equal(origin(driver.spawnedCtx?.readTurnOrigin), null);
});

test("child process: a refused input never opens a turn", async () => {
  const driver = new OriginDriver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext());
  await session.start({ text: "first", origin: M1 });
  driver.child.line("TURN_END");
  driver.encodeNull = true;
  assert.deepEqual(session.send({ mode: "idle", text: "x", origin: M2 }), { ok: false, reason: "unsupported" });
  assert.equal(origin(driver.spawnedCtx?.readTurnOrigin), null);
  driver.encodeNull = false;
  session.send({ mode: "idle", text: "y", origin: M2 });
  assert.equal(origin(driver.spawnedCtx?.readTurnOrigin), M2.sourceMessageId, "not poisoned by the refusal");
});

test("⭐ child process: the session sees turn_end BEFORE a manager listener that immediately sends the next prompt", async () => {
  // AgentProcessManager's turn_end reducer can deliver the queued message synchronously from inside
  // its runtime_event listener. If the session updated its holder after that listener, every such
  // back-to-back turn would look like "new prompt while turn open" and lose its origin.
  const driver = new OriginDriver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext());
  session.on("runtime_event", (event) => {
    if (event.kind === "turn_end") session.send({ mode: "idle", text: "queued", origin: M2 });
  });
  await session.start({ text: "first", origin: M1 });
  driver.child.line("TURN_END");
  assert.equal(origin(driver.spawnedCtx?.readTurnOrigin), M2.sourceMessageId);
});

test("child process: stop and exit both end origins for good", async () => {
  const stopped = new OriginDriver();
  const a = new ChildProcessRuntimeSession(stopped, spawnContext());
  await a.start({ text: "first", origin: M1 });
  await a.stop({ reason: "test" });
  assert.equal(origin(stopped.spawnedCtx?.readTurnOrigin), null, "a stopping process may still call; none of it is a turn");

  const exited = new OriginDriver();
  const b = new ChildProcessRuntimeSession(exited, spawnContext());
  await b.start({ text: "first", origin: M1 });
  exited.child.emit("exit", 0, null);
  assert.equal(origin(exited.spawnedCtx?.readTurnOrigin), null);
});

test("child process: two sessions never see each other's origin", async () => {
  const d1 = new OriginDriver();
  const d2 = new OriginDriver();
  const s1 = new ChildProcessRuntimeSession(d1, spawnContext("process-1"));
  const s2 = new ChildProcessRuntimeSession(d2, spawnContext("process-2"));
  await s1.start({ text: "a", origin: M1 });
  await s2.start({ text: "b", origin: M2 });
  assert.equal(origin(d1.spawnedCtx?.readTurnOrigin), M1.sourceMessageId);
  assert.equal(origin(d2.spawnedCtx?.readTurnOrigin), M2.sourceMessageId);
  assert.equal(d1.spawnedCtx?.readTurnOrigin?.()?.processInstanceId, "process-1");
  assert.equal(d2.spawnedCtx?.readTurnOrigin?.()?.processInstanceId, "process-2");
});

// ------------------------------------------------------------------ Pi SDK

function fakePiSession() {
  let listener: ((event: AgentSessionEvent) => void) | null = null;
  let streaming = false;
  return {
    sessionId: "pi-origin-session",
    get isStreaming() {
      return streaming;
    },
    subscribe(cb: (event: AgentSessionEvent) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    async prompt() {},
    async steer() {},
    async abort() {},
    dispose() {},
    setStreaming(value: boolean) {
      streaming = value;
    },
    endTurn() {
      listener?.({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
      listener?.({ type: "agent_settled" } as unknown as AgentSessionEvent);
    },
  };
}

async function startPi(startOrigin = M1) {
  const fake = fakePiSession();
  let factoryCtx: SpawnContext | null = null;
  const session = new PiSdkRuntimeSession(spawnContext(), () => undefined, async (ctx) => {
    factoryCtx = ctx;
    return fake as unknown as AgentSession;
  });
  const events: ParsedEvent[] = [];
  session.on("runtime_event", (event) => events.push(event));
  await session.start({ text: "first", origin: startOrigin });
  const read = (factoryCtx as SpawnContext | null)?.readTurnOrigin;
  return { fake, session, read, events };
}

test("pi: the session factory (where the managed MCP tools are built) receives the live getter", async () => {
  const { fake, session, read, events } = await startPi();
  assert.equal(origin(read), M1.sourceMessageId);

  session.send({ mode: "busy", text: "steer", origin: M2 });
  assert.equal(origin(read), M1.sourceMessageId, "⭐ steer keeps the turn's origin");

  fake.endTurn();
  assert.equal(events.some((event) => event.kind === "turn_end"), true, "fixture must really end the turn");
  assert.equal(origin(read), null);

  session.send({ mode: "idle", text: "second", origin: M2 });
  assert.equal(origin(read), M2.sourceMessageId);

  await session.stop({ reason: "test" });
  assert.equal(origin(read), null);
});

test("pi: an idle prompt that has to wait behind a streaming run carries no origin", async () => {
  // It may fall back to steering that run, and until it does the run's own calls would otherwise
  // borrow the new message.
  const { fake, session, read } = await startPi();
  fake.endTurn();
  fake.setStreaming(true);
  assert.deepEqual(session.send({ mode: "idle", text: "late", origin: M2 }), { ok: true, acceptedAs: "prompt" });
  assert.equal(origin(read), null);
  await session.stop({ reason: "test" });
});

// ------------------------------------------------------------------ Kimi SDK

async function startKimi() {
  let listener: ((event: unknown) => void) | null = null;
  const fakeSession = {
    id: "kimi-origin-session",
    setApprovalHandler() {},
    onEvent(cb: (event: unknown) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  } as unknown as KimiSession;
  let factoryCtx: SpawnContext | null = null;
  const session = new KimiSdkRuntimeSession(spawnContext(), () => {}, async (ctx) => {
    factoryCtx = ctx;
    return { harness: {} as unknown as KimiHarness, session: fakeSession, wrapperPath: "/tmp/wrapper" };
  });
  const events: ParsedEvent[] = [];
  session.on("runtime_event", (event) => events.push(event));
  await session.start({ text: "first", origin: M1 });
  const emit = (type: string) => listener?.({ agentId: "main", sessionId: "kimi-origin-session", type, turnId: 1, reason: "completed" });
  return { session, read: (factoryCtx as SpawnContext | null)?.readTurnOrigin, emit, events };
}

test("kimi: start sets, a steer while the SDK turn is active keeps, turn_end clears", async () => {
  const { session, read, emit, events } = await startKimi();
  assert.equal(origin(read), M1.sourceMessageId);

  emit("turn.started");
  assert.deepEqual(session.send({ mode: "idle", text: "during turn", origin: M2 }), { ok: true, acceptedAs: "steer" });
  assert.equal(origin(read), M1.sourceMessageId, "⭐ idle input folded into the active SDK turn is a steer");

  emit("turn.ended");
  assert.equal(events.some((event) => event.kind === "turn_end"), true, "fixture must really end the turn");
  assert.equal(origin(read), null);

  session.send({ mode: "idle", text: "second", origin: M2 });
  assert.equal(origin(read), M2.sourceMessageId);

  await session.stop({ reason: "test" });
  assert.equal(origin(read), null);
});
