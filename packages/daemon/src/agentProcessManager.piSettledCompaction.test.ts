import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "./core";
import { AgentProcessManager } from "./agentProcessManager";
import { PiDriver, PiSdkRuntimeSession } from "./drivers/pi";
import type { ParsedEvent, RuntimeSession, SpawnContext } from "./drivers/types";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { installManagedRunnerCredentialFetch } from "./testing/managedRunnerCredentialFetch";

// task #1362: Pi compacts after a run has ended and before it settles (its own
// post-run compaction, or an extension's from its agent_settled hook). The SDK
// hands agent_settled to extensions before the daemon, and an extension's
// compact is not deferred past it, so the daemon sees the compaction and the
// turn end in either order. A message that arrives meanwhile must reach the
// model exactly once: not stranded as a steer the finished run never reads, and
// not refused as a prompt while the session still compacts.
//
// The real APM runs over the real Pi runtime session and a real Pi SDK
// AgentSession (event dispatch, extension runner, compaction). Only the model
// is a stand-in (pi-ai's faux provider). Interleavings are pinned by barriers:
// a held summary request keeps a compaction open, a gated tool keeps a run open.

const AGENT = "agent-1";

class RealSdkPiDriver extends PiDriver {
  readonly runtimeEvents: ParsedEvent[] = [];

  constructor(private readonly factory: ConstructorParameters<typeof PiSdkRuntimeSession>[2]) {
    super();
  }

  override createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    const session = new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    }, this.factory);
    (session as unknown as { events: NodeJS.EventEmitter }).events.on("runtime_event", (event: ParsedEvent) => this.runtimeEvents.push(event));
    return session;
  }
}

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => (part?.type === "text" ? part.text : "")).join("");
  return "";
}

/** An inbox notice names its messages by id (`msg=m-<seq>`); a test's marker is that id. */
function mentions(text: string, marker: string): boolean {
  return new RegExp(`msg=${marker}(?![\\w-])`).test(text);
}

function message(content: string, seq: number): AgentMessage {
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel", sender_id: "user-1", sender_name: "richard",
    sender_type: "human", content, timestamp: "2026-11-08T10:00:00.000Z", message_id: `m-${seq}`, seq,
  };
}

// A safety bound only: every wait below is for a state the barriers make reachable.
async function waitUntil(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type CompactFrom = "none" | "settled_fire_and_forget" | "settled_awaited";
type TurnReply = "text" | "tool" | "overflow";

interface Harness {
  manager: AgentProcessManager;
  driver: () => RealSdkPiDriver;
  session: () => AgentSession;
  /** Model requests in order: each one's kind and the user inputs it carried. */
  requests: Array<{ kind: "turn" | "summary"; users: string[] }>;
  sdkEvents: string[];
  /** Prompts the SDK refused (e.g. one submitted mid-compaction). */
  refusedPrompts: string[];
  armCompaction: (how: CompactFrom) => void;
  holdNextSummary: () => Gate;
  holdNextTurn: () => Gate;
  /** Replies for the next turn requests, in order; then plain text. */
  scriptTurns: (...replies: TurnReply[]) => void;
  /** The gated tool's barrier: the run stays open in the tool until it opens. */
  toolGate: () => Gate;
  compactNow: () => void;
  setCompactionSettings: (settings: Record<string, unknown>) => void;
  ap: () => any;
  transcriptCount: (marker: string) => number;
  dispose: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-settled-compaction-"));
  const faux = fauxProvider({
    api: "faux-settled-compaction",
    provider: "fauxsettled",
    models: [{ id: "faux-model", contextWindow: 200_000, maxTokens: 1_000 }],
  });
  const requests: Harness["requests"] = [];
  const sdkEvents: string[] = [];
  const refusedPrompts: string[] = [];
  const turnScript: TurnReply[] = [];
  let summaryHold: Gate | null = null;
  let turnHold: Gate | null = null;
  let toolHold = gate();
  const respond = async (context: any) => {
    const users = ((context.messages ?? []) as any[]).filter((m) => m.role === "user").map((m) => textOf(m.content));
    const last = users.at(-1) ?? "";
    const kind = /^(<conversation>|# Conversation)/.test(last.trimStart()) ? "summary" : "turn";
    requests.push({ kind, users });
    const hold = kind === "summary" ? summaryHold : turnHold;
    if (hold) {
      if (kind === "summary") summaryHold = null; else turnHold = null;
      await hold.promise;
    }
    if (kind === "summary") return fauxAssistantMessage("Summary of earlier work.");
    const lastIsToolResult = (context.messages ?? []).at(-1)?.role === "toolResult";
    const reply = lastIsToolResult ? "text" : turnScript.shift() ?? "text";
    if (reply === "tool") return fauxAssistantMessage([fauxToolCall("wait_here", {})], { stopReason: "toolUse" });
    if (reply === "overflow") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" });
    return fauxAssistantMessage("Done.");
  };
  faux.setResponses(Array.from({ length: 64 }, () => respond));

  let armed: CompactFrom = "none";
  let extensionCtx: any = null;
  let session!: AgentSession;
  let settingsManager: any = null;
  let driver!: RealSdkPiDriver;
  const restoreFetch = installManagedRunnerCredentialFetch();
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager((msg) => sent.push(msg), "sk_machine_test", {
    dataDir: root,
    serverUrl: "https://daemon.example.com",
    slockHome: root,
    slockCliPath: "__cli",
    runtimeSessionHomeDir: root,
    // Trace attributes are checked against the daemon's contracts.
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink: new MemoryTraceSink() }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
    driverResolver: () => (driver = new RealSdkPiDriver(async () => {
      const services = await createAgentSessionServices({
        cwd: root,
        agentDir: root,
        resourceLoaderOptions: {
          extensionFactories: [{
            name: "settled-compaction",
            factory: (pi: any) => {
              pi.on("agent_settled", async (_event: any, ctx: any) => {
                extensionCtx = ctx;
                const how = armed;
                armed = "none";
                if (how === "settled_fire_and_forget") ctx.compact();
                if (how === "settled_awaited") {
                  await new Promise<void>((resolve) => ctx.compact({ onComplete: () => resolve(), onError: () => resolve() }));
                }
              });
            },
          }],
        },
      });
      services.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } } as any);
      settingsManager = services.settingsManager;
      services.modelRuntime.registerNativeProvider(faux.provider);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(root),
        model: faux.getModel(),
        noTools: "builtin",
        customTools: [{
          name: "wait_here",
          label: "wait here",
          description: "Waits for the test.",
          parameters: Type.Object({}),
          execute: async () => {
            await toolHold.promise;
            return { content: [{ type: "text", text: "waited" }], details: undefined };
          },
        }],
      } as any);
      session = created.session;
      const prompt = session.prompt.bind(session);
      (session as any).prompt = async (text: string, options?: unknown) => {
        try {
          return await prompt(text, options as any);
        } catch (error) {
          refusedPrompts.push(String((error as Error)?.message ?? error));
          throw error;
        }
      };
      session.subscribe((event: any) => {
        if (event.type !== "message_update") sdkEvents.push(event.type);
      });
      return session;
    })),
  });
  const config = {
    name: "pi-agent", displayName: "Pi Agent", description: "test agent", model: "fauxsettled/faux-model", runtime: "pi",
    reasoningEffort: null, envVars: null, sessionId: null,
    serverUrl: "https://daemon.example.com", authToken: "sk_machine_test", agentCredentialKey: "sk_agent_test", agentCredentialId: null,
  } as AgentConfig;
  await manager.startAgent(AGENT, config, undefined, undefined, undefined, "launch-pi-settled-compaction");
  const ap = () => (manager as any).agents.get(AGENT);
  await waitUntil(() => requests.some((r) => r.kind === "turn") && ap()?.gatedSteering.isIdle === true && (session as any)?.isIdle === true, "the start turn");

  return {
    manager,
    driver: () => driver,
    session: () => session,
    requests,
    sdkEvents,
    refusedPrompts,
    armCompaction: (how) => { armed = how; },
    holdNextSummary: () => { summaryHold = gate(); return summaryHold; },
    holdNextTurn: () => { turnHold = gate(); return turnHold; },
    scriptTurns: (...replies) => { turnScript.push(...replies); },
    toolGate: () => { toolHold = gate(); return toolHold; },
    compactNow: () => { assert.ok(extensionCtx, "the extension saw a settle"); extensionCtx.compact(); },
    setCompactionSettings: (settings) => { settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, ...settings } }); },
    ap,
    transcriptCount: (marker) => (session.sessionManager.getEntries() as any[])
      .filter((entry) => entry.type === "message" && entry.message?.role === "user" && mentions(textOf(entry.message.content), marker)).length,
    dispose: async () => {
      await manager.stopAgent(AGENT).catch(() => {});
      await releaseAgentManagerForTests(manager);
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Turn requests that carried `marker`, and how many copies the first of them carried. */
function modelReach(h: Harness, marker: string): { requests: number; firstRequestCopies: number } {
  const counts = h.requests.filter((r) => r.kind === "turn").map((r) => r.users.filter((u) => mentions(u, marker)).length).filter((n) => n > 0);
  return { requests: counts.length, firstRequestCopies: counts[0] ?? 0 };
}

async function settled(h: Harness, label: string): Promise<void> {
  await waitUntil(() => h.ap()?.gatedSteering.isIdle === true && (h.session() as any).isIdle === true && h.ap()?.gatedSteering.compacting === false, label);
}

function assertReachedOnce(h: Harness, marker: string): void {
  assert.equal(modelReach(h, marker).firstRequestCopies, 1, `the first model request carrying ${marker} carries it once`);
  assert.equal(h.transcriptCount(marker), 1, `the session holds one user entry for ${marker}`);
  assert.deepEqual(h.refusedPrompts, [], "no prompt was refused");
}

function compactionStarts(h: Harness): Array<Extract<ParsedEvent, { kind: "compaction_started" }>> {
  return h.driver().runtimeEvents.filter((event): event is Extract<ParsedEvent, { kind: "compaction_started" }> => event.kind === "compaction_started");
}

/** A settled-hook compaction held open by its summary request; `m-2` arrives at `deliverAt`. */
async function settledHookCompaction(h: Harness, how: Exclude<CompactFrom, "none">, deliverAt: "before_turn_end" | "after_turn_end"): Promise<Gate> {
  const summary = h.holdNextSummary();
  h.armCompaction(how);
  await h.manager.deliverMessage(AGENT, message("seed work", 1));
  await waitUntil(() => (h.session() as any).isCompacting === true, "the settled-hook compaction to start");
  if (deliverAt === "after_turn_end") {
    const lastIndex = (kind: ParsedEvent["kind"]) => h.driver().runtimeEvents.map((event) => event.kind).lastIndexOf(kind);
    await waitUntil(() => lastIndex("turn_end") > lastIndex("compaction_started"), "the turn end while compacting");
  }
  assert.deepEqual(compactionStarts(h).at(-1), { kind: "compaction_started", cycleId: 1, afterRunEnd: true });
  await h.manager.deliverMessage(AGENT, message("arrives while compacting", 2));
  await runtimeCallsMade(h);
  return summary;
}

/**
 * Barrier: the Pi runtime makes its SDK calls on a later tick (deferSdkCall).
 * Wait until every call it has accepted was made, so releasing a held
 * compaction afterwards cannot reorder a prompt or steer behind it.
 */
async function runtimeCallsMade(h: Harness): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await waitUntil(() => (h.ap()?.runtime as { queuedInputs?: number } | undefined)?.queuedInputs === 0, "the runtime's queued SDK calls");
  await new Promise((resolve) => setImmediate(resolve));
}

for (const [how, order] of [["settled_fire_and_forget", "started > turn_end > finished"], ["settled_awaited", "started > finished > turn_end"]] as const) {
  test(`a message during a settled-hook compaction (${order}) reaches the model exactly once`, async () => {
    const h = await startHarness();
    try {
      const summary = await settledHookCompaction(h, how, "before_turn_end");
      assert.equal(modelReach(h, "m-2").requests, 0, "held while the session compacts");
      summary.open();
      await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
      await settled(h, "the delivery turn");
      assertReachedOnce(h, "m-2");
    } finally {
      await h.dispose();
    }
  });
}

test("a message after the turn end while a fire-and-forget compaction still runs is held, not refused, and reaches the model once", async () => {
  const h = await startHarness();
  try {
    const summary = await settledHookCompaction(h, "settled_fire_and_forget", "after_turn_end");
    assert.equal(h.ap()?.gatedSteering.isIdle, false, "not idle while the held compaction runs");
    assert.equal(modelReach(h, "m-2").requests, 0);
    summary.open();
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the delivery turn");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});

test("a settled-hook compaction that is aborted still delivers what waited, once", async () => {
  const h = await startHarness();
  try {
    const summary = await settledHookCompaction(h, "settled_awaited", "before_turn_end");
    h.session().abortCompaction();
    summary.open(); // the stand-in model ignores the abort signal: let the aborted request return
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the delivery turn");
    assert.ok(h.driver().runtimeEvents.some((e) => e.kind === "compaction_interrupted" && e.outcome === "aborted"), "precondition: the compaction was interrupted");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});

test("an overflow compaction after the run end that retries the run holds new input through the retry, then delivers it once", async () => {
  const h = await startHarness();
  try {
    h.setCompactionSettings({ enabled: true });
    const summary = h.holdNextSummary();
    h.scriptTurns("overflow");
    await h.manager.deliverMessage(AGENT, message("seed work", 1));
    await waitUntil(() => (h.session() as any).isCompacting === true, "the overflow compaction to start");
    assert.deepEqual(compactionStarts(h).at(-1), { kind: "compaction_started", cycleId: 1, afterRunEnd: true });
    await h.manager.deliverMessage(AGENT, message("arrives while compacting", 2));
    await runtimeCallsMade(h);
    const turnsBeforeRetry = h.requests.filter((r) => r.kind === "turn").length;
    summary.open();
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the delivery turn");
    const turns = h.requests.filter((r) => r.kind === "turn");
    assert.ok(turns.length >= turnsBeforeRetry + 2, "the SDK retried the run, then a turn carried m-2");
    assert.equal(turns[turnsBeforeRetry]!.users.some((u) => mentions(u, "m-2")), false, "the retried run's start did not release it");
    assert.ok(h.driver().runtimeEvents.some((e) => e.kind === "compaction_finished" && e.cycleId === 1), "precondition: the compaction finished and the run retried");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});

test("Pi's own threshold compaction after the run end holds new input and delivers it once", async () => {
  const h = await startHarness();
  try {
    const turn = h.holdNextTurn();
    await h.manager.deliverMessage(AGENT, message("seed work", 1));
    await waitUntil(() => (h.session() as any).isStreaming === true && h.requests.filter((r) => r.kind === "turn").length >= 2, "the held turn");
    // The run's last reply crosses the threshold: Pi compacts after agent_end.
    h.setCompactionSettings({ enabled: true, reserveTokens: 199_900 });
    const summary = h.holdNextSummary();
    turn.open();
    await waitUntil(() => (h.session() as any).isCompacting === true, "the threshold compaction to start");
    assert.deepEqual(compactionStarts(h).at(-1), { kind: "compaction_started", cycleId: 1, afterRunEnd: true });
    h.setCompactionSettings({ enabled: false });
    await h.manager.deliverMessage(AGENT, message("arrives while compacting", 2));
    await runtimeCallsMade(h);
    summary.open();
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the delivery turn");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});

test("control: a message during an active run is steered into that run once", async () => {
  const h = await startHarness();
  try {
    const tool = h.toolGate();
    h.scriptTurns("tool");
    await h.manager.deliverMessage(AGENT, message("work that runs a tool", 1));
    await waitUntil(() => h.sdkEvents.includes("tool_execution_start"), "the run to wait in its tool");
    await h.manager.deliverMessage(AGENT, message("arrives during the run", 2));
    await waitUntil(() => h.sdkEvents.includes("queue_update"), "the steer to be queued in the running session");
    const runsBefore = h.sdkEvents.filter((e) => e === "agent_start").length;
    tool.open();
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the steered run");
    assert.equal(h.sdkEvents.filter((e) => e === "agent_start").length, runsBefore, "it went into the run that was open, not a new one");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});

test("control: a compaction that starts on an idle agent hands it back to idle and delivers its message once", async () => {
  const h = await startHarness();
  try {
    await settled(h, "idle before the compaction");
    const summary = h.holdNextSummary();
    h.compactNow();
    await waitUntil(() => h.ap()?.compaction?.kind === "active", "the idle compaction to start");
    assert.equal(h.ap()?.compaction?.startedIdleOn, h.ap()?.runtime, "precondition: it started on an idle agent");
    assert.deepEqual(compactionStarts(h).at(-1), { kind: "compaction_started", cycleId: 1 }, "no run end pending: not held for a turn end");
    await h.manager.deliverMessage(AGENT, message("arrives while idle-compacting", 2));
    await runtimeCallsMade(h);
    summary.open();
    await waitUntil(() => modelReach(h, "m-2").requests >= 1, "m-2 to reach the model");
    await settled(h, "the idle compaction and the delivery");
    assertReachedOnce(h, "m-2");
  } finally {
    await h.dispose();
  }
});
