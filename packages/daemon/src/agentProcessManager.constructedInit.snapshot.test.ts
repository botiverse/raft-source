// Constructed-init baseline on the legacy host (plan oar39 §E, PR S0): for
// each runtime driver and start scenario, the standing prompt the APM hands
// the driver (`SpawnContext.standingPrompt`, which each driver carries its
// own way), the full first input (`SpawnContext.prompt`, as the runtime
// session gives it to the driver: server-context prefix included) and the
// prompt source (`runtime_input_source` of the spawn turn). The refactor that
// moves constructed initialization into a plugin must leave every file
// unchanged. Real drivers, except for the child process (as
// agentProcessManager.systemPrompt.test.ts). Local runs write the files
// (vitest `update`); CI only compares.
//
// Not covered here (none of these changes the standing prompt or the first
// input today; S1 to S3 must not move constructed-init logic into them
// without a test of their own):
// - what a driver makes of `SpawnContext` (argv, files, ACP fields), which
//   its own tests pin, e.g. OpenCode's turn text, which becomes
//   NO_MESSAGE_PROMPT when the first input equals the standing prompt
//   (drivers/opencode.ts); no scenario below composes such an input;
// - the in-process sessions of Pi and Kimi SDK (`createSession`), replaced
//   here by the generic session, including Kimi SDK's
//   `composeFirstTurnPreamble` over the first input (identity today);
// - on the OAR side (oarAgentHost.constructedInit.snapshot.test.ts), the
//   `prepare*OarLaunch` wrappers: the real launch environment and the managed
//   MCP server, which also shape OPENCODE_CONFIG_CONTENT (`mcp`).
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BasicTracer, MemoryTraceSink, type AgentConfig, type AgentMessage, type Tracer } from "@botiverse/raft-shared";
import { createAgentAppInboxStore } from "./agentAppInbox";
import { AgentProcessManager } from "./agentProcessManager";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import { getDriver, type RuntimeDriver, type SpawnContext } from "./drivers/index";
import { stableStandingPromptConfig, standingPromptHash, StandingPromptLedger } from "./standingPromptRefresh";
import {
  CONSTRUCTED_INIT_IDENTITY,
  CONSTRUCTED_INIT_MEMORY_MD,
  CONSTRUCTED_INIT_NOW_MS,
  CONSTRUCTED_INIT_WAKE_MESSAGE,
  staleConstructedInitSnapshotFiles,
  constructedInitSnapshotPath,
  makeNormalizer,
  renderConstructedInitCase,
} from "./testing/constructedInitSnapshot";
import { promptConfig } from "./testing/promptFixture";

const HOUR_MS = 3_600_000;
const RUNTIMES = ["claude", "grok", "cursor", "gemini", "copilot", "kimi", "kimi-sdk", "opencode", "pi", "antigravity"];
/** Claude resumes by its transcript's id, a UUID (it appears in no snapshot). */
const sessionIdFor = (runtime: string) => (runtime === "claude" ? "11111111-2222-4333-8444-555555555555" : "session-1");

class PromptChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

interface Ctx {
  manager: AgentProcessManager;
  driver: RuntimeDriver;
  dataDir: string;
  spawns: SpawnContext[];
  /** `runtime_input_source` of each spawn turn, in order. */
  sources: string[];
  /** `daemon.agent.standing_prompt_stale` actions, in order. */
  staleActions: string[];
  appInbox: ReturnType<typeof createAgentAppInboxStore>;
}

async function withManager<T>(runtime: string, run: (ctx: Ctx) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-constructed-init-"));
  const spawns: SpawnContext[] = [];
  const sources: string[] = [];
  const staleActions: string[] = [];
  const driver = getDriver(runtime);
  driver.spawn = async (ctx) => {
    spawns.push(ctx);
    return { process: new PromptChild() as unknown as ChildProcess };
  };
  // Pi and Kimi SDK run an in-process session; the generic one hands the same
  // start text to `spawn` instead.
  (driver as { createSession?: unknown }).createSession = undefined;
  // A tracer that also hands over what the spawn turn and the stale-prompt event say.
  const real = new BasicTracer({ sink: new MemoryTraceSink() });
  const tracer = Object.create(real) as Tracer;
  tracer.startSpan = (name, options) => {
    if (name === "daemon.runtime.turn" && options?.attrs?.reason === "spawn") sources.push(String(options.attrs.runtime_input_source));
    return real.startSpan(name, options);
  };
  tracer.emitEvent = (name, options) => {
    if (name === "daemon.agent.standing_prompt_stale") staleActions.push(String(options?.attrs?.action));
    return real.emitEvent(name, options);
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const appInbox = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
    tracer, appInboxForAgent: () => appInbox, serverConnected: () => true,
  });
  try {
    return await run({ manager, driver, dataDir, spawns, sources, staleActions, appInbox });
  } finally {
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

const config = (runtime: string, overrides: Partial<AgentConfig> = {}) => promptConfig({ ...CONSTRUCTED_INIT_IDENTITY, runtime, ...overrides });

const wakeMessage: AgentMessage = { ...CONSTRUCTED_INIT_WAKE_MESSAGE };

interface Outcome {
  spawn: SpawnContext | null;
  promptSource: string | null;
}

/** This start's spawn (null when the driver deferred it) and the prompt source its spawn turn reported. */
async function started(ctx: Ctx, start: () => Promise<unknown>): Promise<Outcome> {
  const before = ctx.spawns.length;
  const sourcesBefore = ctx.sources.length;
  await start();
  // Only what this start reported, never an earlier start's.
  const sources = ctx.sources.slice(sourcesBefore);
  if (ctx.spawns.length === before) {
    assert.deepEqual(sources, [], "no spawn turn without a spawn");
    return { spawn: null, promptSource: null };
  }
  assert.equal(ctx.spawns.length, before + 1);
  assert.equal(sources.length, 1, "one spawn turn for this start");
  return { spawn: ctx.spawns.at(-1)!, promptSource: sources[0]! };
}

type Scenario = (ctx: Ctx, runtime: string) => Promise<Outcome>;

const resume = (runtime: string, overrides: Partial<AgentConfig> = {}) => config(runtime, { sessionId: sessionIdFor(runtime), ...overrides });

const SCENARIOS: Record<string, Scenario> = {
  "cold-fresh": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", config(runtime))),
  "fresh-wake-message": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", config(runtime), wakeMessage)),
  "fresh-memory-md": async (ctx, runtime) => {
    const workspace = path.join(ctx.dataDir, "agent-1");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), CONSTRUCTED_INIT_MEMORY_MD);
    return started(ctx, () => ctx.manager.startAgent("agent-1", config(runtime), wakeMessage));
  },
  "runtime-profile-control": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", config(runtime, {
    runtimeProfileControl: { kind: "daemon_release_notice", key: "release-1", message: "Daemon updated from 1.0.0 to 1.0.1." } as never,
  }))),
  "resume-baseline-unknown": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime))),
  "resume-wake-message": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime), wakeMessage)),
  // A resume with unread counts and no message: the offline catch-up prompt,
  // with inbox items on (it names `raft inbox check` / `raft inbox read`).
  "resume-unread-summary": (ctx, runtime) => started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime, { inboxItems: true }), undefined, { "#general": 3, "dm:@bob": 1 })),
  // The ledger records the hash the APM computes for this session (written by
  // hand: the fake child never reports its session); the resume then plans `unchanged`.
  "resume-unchanged": async (ctx, runtime) => {
    const first = await started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime)));
    await ctx.manager.stopAgent("agent-1", { wait: true });
    // OpenCode defers this empty start (no spawn) and rebuilds the prompt on resume anyway.
    if (first.spawn) {
      const stable = String(ctx.driver.buildSystemPrompt(stableStandingPromptConfig(first.spawn.config), "agent-1"));
      const hash = standingPromptHash(stable, { nativeStandingPrompt: Boolean(ctx.driver.supportsNativeStandingPrompt) });
      new StandingPromptLedger(ctx.dataDir).write("agent-1", sessionIdFor(runtime), hash);
    }
    const staleBefore = ctx.staleActions.length;
    const second = await started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime)));
    assert.equal(ctx.staleActions.length, staleBefore, "planned unchanged: no stale-prompt event");
    return second;
  },
  "resume-standing-prompt-changed": async (ctx, runtime) => {
    new StandingPromptLedger(ctx.dataDir, () => CONSTRUCTED_INIT_NOW_MS - HOUR_MS).write("agent-1", sessionIdFor(runtime), "stale-prompt-hash");
    return started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime)));
  },
  // D1: server features changed under a running session; the drift stop
  // (silent, as the spec-drift stop is) and the next start says what changed.
  "server-features-notice": async (ctx, runtime) => {
    await started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime)));
    ctx.manager.applyServerFeatures({ enabledApps: ["artifacts"] });
    await ctx.manager.stopAgent("agent-1", { wait: true, silent: true });
    return started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime, { enabledApps: ["artifacts"] })));
  },
  // D2: a due reminder for a stopped agent; the Server's start answers the wake.
  "app-inbox-notice": async (ctx, runtime) => {
    const minted = ctx.appInbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: "11111111-1111-4111-8111-111111111111", revision: "1" },
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) throw new Error("mint failed");
    await ctx.manager.notifyAgentAppInbox("agent-1", minted.item);
    return started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime)));
  },
  // RFC 070: a Claude transcript with a cold gap and a large context.
  "recycle-briefing": async (ctx, runtime) => {
    const sessionId = sessionIdFor(runtime);
    const projectDir = path.join(ctx.dataDir, ".claude", "projects", "-workspace-agent-1");
    await mkdir(projectDir, { recursive: true });
    const at = (msAgo: number) => new Date(CONSTRUCTED_INIT_NOW_MS - msAgo).toISOString();
    // Five shell actions (the panel needs at least five), then the turn's last text.
    const commands = ["git status", "git log -1 --oneline", "raft message read --target \"#ops\"", "git diff --stat", "raft task list"];
    const usage = { input_tokens: 5, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 1_000 };
    const records = [
      { type: "user", timestamp: at(3 * HOUR_MS + 600_000), sessionId, message: { role: "user", content: "[target=#ops msg=aaaaaaaa time=2026-10-01 08:50:00Z type=human] @bob: please review the deploy notes" } },
      ...commands.flatMap((command, i) => [
        { type: "assistant", timestamp: at(3 * HOUR_MS + 500_000 - i * 60_000), sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command } }], usage } },
        { type: "user", timestamp: at(3 * HOUR_MS + 490_000 - i * 60_000), sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "ok" }] } },
      ]),
      { type: "assistant", timestamp: at(3 * HOUR_MS), sessionId, message: { role: "assistant", content: [{ type: "text", text: "Waiting on review of the deploy notes." }], usage } },
    ];
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return started(ctx, () => ctx.manager.startAgent("agent-1", resume(runtime), wakeMessage));
  },
};

function scenariosFor(runtime: string): string[] {
  return Object.keys(SCENARIOS).filter((scenario) => {
    // Only Claude's transcript supplies recycle facts on this host; every other runtime resumes.
    if (scenario === "recycle-briefing") return runtime === "claude";
    // The catch-up prompt is the same text for every driver; one runtime pins it.
    if (scenario === "resume-unread-summary") return runtime === "claude";
    // The notice rides the first input only for a driver that defers an empty
    // start (OpenCode); Claude shows the others, which get it as a delivery.
    if (scenario === "app-inbox-notice") return runtime === "opencode" || runtime === "claude";
    return true;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: CONSTRUCTED_INIT_NOW_MS, shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

interface Result {
  standingPrompt: string | null;
  firstInput: string | null;
  promptSource: string | null;
  flags: string;
}

async function run(runtime: string, scenario: string): Promise<Result> {
  return withManager(runtime, async (ctx) => {
    const outcome = await SCENARIOS[scenario]!(ctx, runtime);
    const normalize = makeNormalizer([
      ["<WORKSPACE>", path.join(ctx.dataDir, "agent-1")],
      ["<DATA_DIR>", ctx.dataDir],
    ]);
    const { driver } = ctx;
    return {
      standingPrompt: outcome.spawn ? normalize(String(outcome.spawn.standingPrompt)) : null,
      firstInput: outcome.spawn ? normalize(String(outcome.spawn.prompt)) : null,
      promptSource: outcome.promptSource,
      flags: `supportsNativeStandingPrompt=${driver.supportsNativeStandingPrompt === true} standingPromptRefreshesOnResume=${driver.standingPromptRefreshesOnResume === true} deferSpawnUntilMessage=${driver.deferSpawnUntilMessage === true}`,
    };
  });
}

let basePrompt: string | null = null;
/** The host's shared standing prompt: grok's at a cold start. */
async function base(): Promise<string> {
  basePrompt ??= (await run("grok", "cold-fresh")).standingPrompt!;
  return basePrompt;
}

test("standing-prompt.md: the legacy host's shared standing prompt (grok, cold start)", async () => {
  await expect(await base()).toMatchFileSnapshot("./__snapshots__/constructedInit/legacy/standing-prompt.md");
});

const cases = RUNTIMES.flatMap((runtime) => scenariosFor(runtime).map((scenario) => [runtime, scenario] as const));

test.each(cases)("legacy %s %s", async (runtime, scenario) => {
  const shared = await base();
  const result = await run(runtime, scenario);
  // Guards: each scenario took the path it names.
  if (scenario === "recycle-briefing") assert.match(String(result.promptSource), /^recycled_/);
  if (scenario === "resume-unread-summary") {
    assert.equal(result.promptSource, "resume_unread_summary");
    assert.match(String(result.firstInput), /raft inbox read --target <item>/);
    assert.doesNotMatch(String(result.firstInput), /raft message check/);
  }
  if (scenario === "resume-standing-prompt-changed" && !["kimi-sdk", "opencode", "pi"].includes(runtime)) {
    assert.match(String(result.firstInput), /^<raft-standing-prompt-update>/);
  }
  if (scenario === "server-features-notice" && runtime !== "opencode") assert.match(String(result.firstInput), /artifacts|Artifacts/);
  await expect(renderConstructedInitCase({
    host: "legacy",
    runtime,
    scenario,
    notes: [`driver: ${result.flags}`, ...(result.firstInput === null ? ["no spawn: the driver deferred the empty start until a concrete message"] : [])],
    promptSource: result.promptSource,
    standingPrompt: result.standingPrompt,
    basePrompt: shared,
    carrier: [["SpawnContext.standingPrompt", result.standingPrompt ?? undefined]],
    firstInput: result.firstInput,
  })).toMatchFileSnapshot(constructedInitSnapshotPath("legacy", runtime, scenario));
});

test("no case file on disk without a case that writes it", () => {
  const expected = ["standing-prompt.md", ...cases.map(([runtime, scenario]) => `${runtime}/${scenario}.txt`)];
  expect(staleConstructedInitSnapshotFiles(path.join(import.meta.dirname, "__snapshots__/constructedInit/legacy"), expected)).toEqual([]);
});
