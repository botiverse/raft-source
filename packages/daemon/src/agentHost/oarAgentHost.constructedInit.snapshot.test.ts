// Constructed-init baseline on the OAR host (plan oar39 §E, PR S0): for each
// OAR runtime and start scenario, the standing prompt, the launch options
// that carry it (`systemPrompt`, `appendSystemPrompt`, OpenCode's
// `OPENCODE_CONFIG_CONTENT`), the exact string given to `session.prompt`
// (server-context prefix included) and the prompt source. The refactor that
// moves constructed initialization into a plugin must leave every file
// unchanged. Each runtime's real launch builder runs with a fixed command and
// environment (no binaries, no managed MCP). Local runs write the files
// (vitest `update`); CI only compares.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { StandingPromptLedger } from "../standingPromptRefresh";
import {
  CONSTRUCTED_INIT_IDENTITY,
  CONSTRUCTED_INIT_MEMORY_MD,
  CONSTRUCTED_INIT_NOW_MS,
  CONSTRUCTED_INIT_WAKE_MESSAGE,
  constructedInitSnapshotPath,
  makeNormalizer,
  staleConstructedInitSnapshotFiles,
  renderConstructedInitCase,
  STANDING_PROMPT_TOKEN,
} from "../testing/constructedInitSnapshot";
import { harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";
import type { AgentStartRequest } from "./agentLifecycleHost";
import type { OarAgentHostDeps } from "./oarAgentHost";
import { antigravityOarLaunch } from "./oarAntigravityLaunch";
import { codexOarLaunch } from "./oarCodexLaunch";
import { cursorOarLaunch } from "./oarCursorLaunch";
import { grokOarLaunch } from "./oarGrokLaunch";
import type { OarLaunch } from "./oarLaunch";
import { oarOnlyLaunch } from "./oarOnlyLaunch";
import { loadOarRuntime, oarInstalledSessionCapabilities } from "../oarLoader";
import type { AvailableInstallation, ContextUsageCapability, Runtime } from "@botiverse/oar";
import { dshRuntime } from "@botiverse/oar/runtimes/dsh";
import { qoderRuntime } from "@botiverse/oar/runtimes/qoder";
import { qwenRuntime } from "@botiverse/oar/runtimes/qwen";
import { opencodeOarLaunch } from "./oarOpencodeLaunch";
import { buildOpenCodeLaunchEnv } from "../drivers/opencode";
import { emptySessionSummary, SessionSummaryStore } from "./oarSessionSummary";
import { summarySuppliesResumeFacts } from "../wakeSessionRecycle";

const HOUR_MS = 3_600_000;
/** The session a resume names; Cursor on OAR resumes only an SDK agent id. */
const sessionIdFor = (runtime: string) => (runtime === "cursor" ? "agent-00000000-0000-4000-8000-000000000001" : "session-1");

/** An OAR-only launch from a fixed executable, with OAR's real capability answer for it. */
function oarOnlyFixedLaunch(runtimeId: "qwen" | "qoder" | "dsh", runtime: Runtime, ctx: SpawnContext, command: string): OarLaunch {
  const installation = INSTALLATIONS[runtimeId]!;
  assert.equal(installation.via === "executable" && installation.command, command);
  return oarOnlyLaunch(runtimeId, ctx, {}, installation, oarInstalledSessionCapabilities(runtime, installation), {});
}

/** The installation each launch below runs on (versions as Raft's or OAR's probe reads them). */
const INSTALLATIONS: Record<string, AvailableInstallation> = {
  codex: { kind: "available", via: "executable", command: "/usr/local/bin/codex", version: "codex-cli 0.166.0" },
  grok: { kind: "available", via: "executable", command: "/usr/local/bin/grok" },
  opencode: { kind: "available", via: "executable", command: "/usr/local/bin/opencode", version: "2.3.0" },
  cursor: { kind: "available", via: "bundled" },
  antigravity: { kind: "available", via: "executable", command: "/usr/local/bin/agy" },
  qwen: { kind: "available", via: "executable", command: "/usr/local/bin/qwen", version: "0.26.0" },
  qoder: { kind: "available", via: "executable", command: "/usr/local/bin/qodercli" },
  dsh: { kind: "available", via: "executable", command: "/usr/local/bin/dsh" },
};

/** Each runtime's real `*OarLaunch` builder over a fixed command and environment. */
const LAUNCHES: Record<string, (ctx: SpawnContext, home: string) => OarLaunch> = {
  codex: (ctx) => codexOarLaunch(ctx, {
    command: "/usr/local/bin/codex", args: ["app-server"], appServerArgs: ["app-server"],
    spawnEnv: {}, appServerEnv: {}, windowsShim: undefined, managedMcp: null, version: "codex-cli 0.166.0",
  }, {}),
  grok: (ctx) => grokOarLaunch(ctx, {
    command: "/usr/local/bin/grok", env: {}, managedMcp: null,
    ...(ctx.config.sessionId ? { resumeSessionId: ctx.config.sessionId } : {}),
  }, {}),
  // OpenCode 2.x, with its real config document from an empty user home.
  opencode: (ctx, home) => opencodeOarLaunch(ctx, {
    command: "/usr/local/bin/opencode",
    release: { major: 2, minor: 3, patch: 0 },
    env: buildOpenCodeLaunchEnv(ctx, {}, { home, version: "2.3.0", managedMcp: null, selectDefaultAgent: true }).env,
    resume: ctx.config.sessionId ?? null,
    record: null,
  }, {}),
  cursor: (ctx) => cursorOarLaunch(ctx, { env: {} }),
  antigravity: (ctx) => antigravityOarLaunch(ctx, { command: "/usr/local/bin/agy", env: {} }, {}),
  qwen: (ctx) => oarOnlyFixedLaunch("qwen", qwenRuntime, ctx, "/usr/local/bin/qwen"),
  qoder: (ctx) => oarOnlyFixedLaunch("qoder", qoderRuntime, ctx, "/usr/local/bin/qodercli"),
  dsh: (ctx) => oarOnlyFixedLaunch("dsh", dshRuntime, ctx, "/usr/local/bin/dsh"),
};
const RUNTIMES = Object.keys(LAUNCHES);
/** OAR's `contextUsage` declaration for each launch's installation: what a session summary records. */
const CONTEXT_USAGE: Record<string, ContextUsageCapability | undefined> = Object.fromEntries(await Promise.all(RUNTIMES.map(async (runtime) => [
  runtime,
  oarInstalledSessionCapabilities(await loadOarRuntime(runtime as Parameters<typeof loadOarRuntime>[0]), INSTALLATIONS[runtime]!).contextUsage,
])));
/** Runtimes whose resume facts come from the session summary, by that declaration. */
const RECYCLE_RUNTIMES = new Set(RUNTIMES.filter((runtime) => summarySuppliesResumeFacts({ wakeRecycleOar: true }, runtime, CONTEXT_USAGE[runtime])));

const NOTES: Record<string, string[]> = {
  antigravity: ["standing prompt only as appendSystemPrompt (the OAR launch carries it natively; D5, a fresh session no longer also gets it in the first input)"],
};

interface Captured {
  h: Harness;
  ctxs: SpawnContext[];
  home: string;
}

async function oarHarness(runtime: string): Promise<Captured> {
  const ctxs: SpawnContext[] = [];
  let home = "";
  const deps: Partial<OarAgentHostDeps> = {
    daemonVersion: "1.0.1-test",
    computerVersion: "2.0.1-test",
    detectedRuntimeCliVersion: (id) => (id === "grok" ? "grok 1.0.77" : id === "opencode" ? "opencode v2.3.0" : undefined),
    // Cursor: the bundled SDK, signed in.
    cursorSdkAvailable: () => true,
    cursorAuthStatus: async () => ({ kind: "logged_in", source: "Cursor.auth.status" }),
    prepareLaunch: async (ctx) => {
      ctxs.push(ctx);
      return LAUNCHES[runtime]!(ctx, home);
    },
  };
  const h = await harness({ deps });
  home = path.join(h.dataDir, ".empty-home");
  await mkdir(home, { recursive: true });
  return { h, ctxs, home };
}

const config = (runtime: string, overrides: Partial<AgentConfig> = {}) => makeConfig({ ...CONSTRUCTED_INIT_IDENTITY, runtime, ...overrides });
const wakeMessage: AgentMessage = { ...CONSTRUCTED_INIT_WAKE_MESSAGE };

function normalizerFor(h: Harness) {
  return makeNormalizer([
    ["<WORKSPACE>", path.join(h.dataDir, "agent-1")],
    ["<DATA_DIR>", h.dataDir],
  ]);
}

/** Starts `start` on the harness and returns what the launch carried and its first input. */
async function capture(c: Captured, start: AgentStartRequest) {
  const { h, ctxs } = c;
  const inputsBefore = h.inputs.length;
  const openedBefore = h.opened.length;
  const eventsBefore = h.events.length;
  assert.deepEqual(await h.host.start(start), { kind: "started" });
  await until(() => h.inputs.length > inputsBefore, "first input");
  await until(() => h.events.slice(eventsBefore).some((event) => event.name === "daemon.agent.oar.first_input"), "first input event");
  // The source this start's first input reported, never an earlier start's.
  const firstInputEvents = h.events.slice(eventsBefore).filter((event) => event.name === "daemon.agent.oar.first_input");
  assert.equal(firstInputEvents.length, 1, "one first-input event for this start");
  const normalize = normalizerFor(h);
  const ctx = ctxs.at(-1)!;
  assert.equal(h.opened.length, openedBefore + 1);
  const options = h.opened.at(-1)!.options;
  const standingPrompt = normalize(String(ctx.standingPrompt));
  const opencodeConfig = options.env?.OPENCODE_CONFIG_CONTENT;
  return {
    promptSource: String(firstInputEvents[0]!.attrs.source),
    standingPrompt,
    resume: options.resume,
    carrier: [
      ["launch.options.systemPrompt", options.systemPrompt === undefined ? undefined : normalize(options.systemPrompt)],
      ["launch.options.appendSystemPrompt", options.appendSystemPrompt === undefined ? undefined : normalize(options.appendSystemPrompt)],
      ["launch.options.env.OPENCODE_CONFIG_CONTENT", typeof opencodeConfig === "string" ? renderOpencodeConfig(normalize(opencodeConfig), standingPrompt) : undefined],
    ] as Array<[string, string | undefined]>,
    firstInput: normalize(h.inputs[inputsBefore]!),
  };
}

/**
 * The config document, pretty-printed, with a prompt equal to the standing
 * prompt written as STANDING_PROMPT_TOKEN. Lossless: the raw value must be the
 * compact JSON.stringify of the same document (key order kept), which the
 * pretty form with the token expanded gives back.
 */
function renderOpencodeConfig(raw: string, standingPrompt: string): string {
  const doc = JSON.parse(raw) as { agent?: Record<string, { prompt?: string }> };
  assert.equal(JSON.stringify(doc), raw, "OPENCODE_CONFIG_CONTENT is compact JSON.stringify output");
  for (const agent of Object.values(doc.agent ?? {})) {
    if (agent.prompt === standingPrompt) agent.prompt = STANDING_PROMPT_TOKEN;
  }
  return JSON.stringify(doc, null, 2);
}

type Scenario = (c: Captured, runtime: string) => Promise<Awaited<ReturnType<typeof capture>>>;

const SCENARIOS: Record<string, Scenario> = {
  "cold-fresh": (c, runtime) => capture(c, request({ config: config(runtime) })),
  "fresh-wake-message": (c, runtime) => capture(c, request({ config: config(runtime), wakeMessage })),
  "fresh-memory-md": async (c, runtime) => {
    const workspace = path.join(c.h.dataDir, "agent-1");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), CONSTRUCTED_INIT_MEMORY_MD);
    return capture(c, request({ config: config(runtime), wakeMessage }));
  },
  "runtime-profile-control": (c, runtime) => capture(c, request({
    config: config(runtime, { runtimeProfileControl: { kind: "daemon_release_notice", key: "release-1", message: "Daemon updated from 1.0.0 to 1.0.1." } as never }),
  })),
  "resume-baseline-unknown": (c, runtime) => capture(c, request({ config: config(runtime, { sessionId: sessionIdFor(runtime) }) })),
  "resume-wake-message": (c, runtime) => capture(c, request({ config: config(runtime, { sessionId: sessionIdFor(runtime) }), wakeMessage })),
  // The first start records the session's standing prompt; the second resumes it unchanged.
  "resume-unchanged": async (c, runtime) => {
    await capture(c, request({ config: config(runtime, { sessionId: sessionIdFor(runtime) }) }));
    await c.h.host.stopAgent("agent-1", { wait: true, silent: true });
    c.h.waiting.set("agent-1", ["launch-2"]);
    return capture(c, request({ launchId: "launch-2", config: config(runtime, { sessionId: sessionIdFor(runtime) }) }));
  },
  "resume-standing-prompt-changed": async (c, runtime) => {
    new StandingPromptLedger(c.h.dataDir, () => CONSTRUCTED_INIT_NOW_MS - HOUR_MS).write("agent-1", sessionIdFor(runtime), "stale-prompt-hash");
    return capture(c, request({ config: config(runtime, { sessionId: sessionIdFor(runtime) }) }));
  },
  // RFC 070 with `wake_recycle_oar`: a cold gap and a large context in the session summary.
  "recycle-briefing": async (c, runtime) => {
    const at = new Date(CONSTRUCTED_INIT_NOW_MS - 3 * HOUR_MS).toISOString();
    new SessionSummaryStore(path.join(c.h.dataDir, ".daemon-state", "agent-session-summaries")).write("agent-1", {
      ...emptySessionSummary(runtime, sessionIdFor(runtime), CONSTRUCTED_INIT_NOW_MS - 3 * HOUR_MS),
      lastActivityAt: at,
      context: { tokens: 300_000, window: 1_000_000, at },
      // Written by the session's recorder from its installation's declaration.
      ...(CONTEXT_USAGE[runtime] ? { contextUsage: CONTEXT_USAGE[runtime] } : {}),
      turns: { count: 4, lastEndedAt: at, lastOutcome: "completed" },
      lastNote: { sessionId: sessionIdFor(runtime), at, text: "Waiting on review of the deploy notes." },
      messages: [{ sessionId: sessionIdFor(runtime), direction: "received", at: "2026-10-01 09:00:00Z", target: "#ops", msgId: "aaaaaaaa", raw: "[target=#ops msg=aaaaaaaa time=2026-10-01 09:00:00Z type=human] @bob: please review the deploy notes" }],
      actions: [{ sessionId: sessionIdFor(runtime), at, tool: "shell", summary: "git status", paths: [], result: "ok", exitCode: 0, mutating: false }],
    });
    return capture(c, request({ config: config(runtime, { sessionId: sessionIdFor(runtime), wakeRecycleOar: true }), wakeMessage }));
  },
  // task #26: held server context rides ahead of the first input.
  "server-context-prefix": (c, runtime) => capture(c, request({
    config: config(runtime),
    wakeMessage: message("ctx-1", { channel_id: "onboarding-context", sender_type: "system", content: "Owner facts: Ada" }),
  })),
};

function scenariosFor(runtime: string): string[] {
  return Object.keys(SCENARIOS).filter((scenario) => {
    if (scenario === "recycle-briefing") return RECYCLE_RUNTIMES.has(runtime);
    // One runtime is enough to pin where the prefix goes.
    if (scenario === "server-context-prefix") return runtime === "codex" || runtime === "cursor";
    return true;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: CONSTRUCTED_INIT_NOW_MS, shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(runtime: string, scenario: string) {
  const c = await oarHarness(runtime);
  try {
    return await SCENARIOS[scenario]!(c, runtime);
  } finally {
    await c.h.cleanup();
  }
}

let basePrompt: string | null = null;
/** The host's shared standing prompt: codex's at a cold start. */
async function base(): Promise<string> {
  basePrompt ??= (await run("codex", "cold-fresh")).standingPrompt;
  return basePrompt;
}

test("standing-prompt.md: the OAR host's shared standing prompt (codex, cold start)", async () => {
  await expect(await base()).toMatchFileSnapshot("./__snapshots__/constructedInit/oar/standing-prompt.md");
});

const cases = RUNTIMES.flatMap((runtime) => scenariosFor(runtime).map((scenario) => [runtime, scenario] as const));

test.each(cases)("oar %s %s", async (runtime, scenario) => {
  const shared = await base();
  const result = await run(runtime, scenario);
  // Guards: each scenario took the path it names.
  const update = result.firstInput.includes("<raft-standing-prompt-update>");
  assert.equal(update, scenario === "resume-standing-prompt-changed" && !["opencode", "qwen", "qoder", "dsh"].includes(runtime), "standing prompt update only where the scenario asks for it");
  if (scenario === "recycle-briefing") assert.match(result.promptSource, /^recycled_/);
  if (scenario.startsWith("resume-")) assert.equal(result.resume === undefined ? null : result.resume, sessionIdFor(runtime));
  await expect(renderConstructedInitCase({
    host: "oar",
    runtime,
    scenario,
    notes: [...(NOTES[runtime] ?? []), ...(scenario.startsWith("resume-") ? [`launch.options.resume: ${result.resume ?? "(absent)"}`] : [])],
    promptSource: result.promptSource,
    standingPrompt: result.standingPrompt,
    basePrompt: shared,
    carrier: result.carrier,
    firstInput: result.firstInput,
  })).toMatchFileSnapshot(constructedInitSnapshotPath("oar", runtime, scenario));
});

test("the recycle briefing covers the runtimes OAR declares a context size for (the old named list, unchanged for these installations)", () => {
  assert.deepEqual([...RECYCLE_RUNTIMES].sort(), ["antigravity", "codex", "cursor", "grok", "opencode", "qwen"]);
});

test("no case file on disk without a case that writes it", () => {
  const expected = ["standing-prompt.md", ...cases.map(([runtime, scenario]) => `${runtime}/${scenario}.txt`)];
  expect(staleConstructedInitSnapshotFiles(path.join(import.meta.dirname, "__snapshots__/constructedInit/oar"), expected)).toEqual([]);
});
