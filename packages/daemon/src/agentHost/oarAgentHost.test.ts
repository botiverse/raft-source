import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Event, EventObserver, EventsOptions, FailedTurn, FailureClass, Session } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { BasicTracer, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { applyStartupMemoryBlock, buildStartupMemoryBlock } from "../startupMemoryBlock";
import { exampleUnreadSummary } from "../axExampleFixtures";
import { getDriver } from "../drivers/index";
import { AGENT_STOP_KILL_GRACE_MS } from "../drivers/processStop";
import { planStartupInput } from "../startupInput";
import { formatInboxUpdateRuntimeInput, NATIVE_STANDING_PROMPT_STARTUP_INPUT, projectThreadJoinContextsForRuntimeInput } from "../agentRuntimeInput";
import {
  codexShared,
  harness,
  limitEvents,
  limitHarness,
  makeConfig,
  message,
  QUOTA_TEXT,
  request,
  sleep,
  startRequest,
  until,
  withFailure,
  type Harness,
} from "../testing/oarAgentHostHarness";
import { AgentHostRouter } from "./agentHostRouter";
import type { AgentDeliveryContext, LegacyAgentHost } from "./agentLifecycleHost";
import { isVerifiedGrokCli, OAR_OPEN_FAILURE_CLASSES, OAR_RETAINED_BYTES, oarFailureProviderLimit, oarOpenFailureClass, withOarRecordRetention, type OarAgentHostDeps } from "./oarAgentHost";
import type { OarLaunch } from "./oarLaunch";
import { ProviderLimitLedger, providerLimitCredentialKey } from "../providerLimitLedger";
import { createAgentAppInboxStore } from "../agentAppInbox";
import { REMINDER_AGENT_INBOX_REGISTRY } from "../apps/reminder/inboxDefinition";
import { createSystemCleanerAppRegistry } from "../apps/cleaner/definition";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a cold start runs on OAR with the grok driver's standing prompt and the legacy cold-start input", async () => {
  const h = await harness();
  try {
    const started = h.host.start(request());
    assert.deepEqual(h.host.getAgentStartAcceptance("agent-1"), { queueState: "starting", queueDepth: 0, queueAgeMs: 0 });
    assert.deepEqual(await started, { kind: "started" });
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "turn_completed");

    // Standing prompt: the grok driver's, built from the same launch config.
    const workspace = path.join(h.dataDir, "agent-1");
    const driver = getDriver("grok");
    const runtimeConfig = { ...makeConfig(), runtimeContext: { agentId: "agent-1", workspacePath: workspace } };
    assert.equal(h.opened[0]!.options.systemPrompt, String(driver.buildSystemPrompt(runtimeConfig, "agent-1")));
    // The host bounds what OAR keeps of the session's records (OAR_RETAINED_BYTES).
    assert.equal(h.opened[0]!.options.retainedBytes, OAR_RETAINED_BYTES);

    // First input: the legacy ladder (cold start) plus the startup MEMORY.md block.
    const ladder = planStartupInput({
      driver,
      runtimeConfig,
      isResume: false,
      standingPromptReachesSession: true,
      standingPromptInFirstInput: false,
      wakeMessageTransient: false,
      startingInboxMessages: [],
      projectThreadJoinContexts: (messages, render) => projectThreadJoinContextsForRuntimeInput(messages, () => undefined, render),
    });
    assert.equal(ladder.prompt, NATIVE_STANDING_PROMPT_STARTUP_INPUT);
    const memoryBlock = await buildStartupMemoryBlock({ workspacePath: workspace, budgetTokens: 2_000 });
    const expected = memoryBlock ? applyStartupMemoryBlock(memoryBlock, ladder.prompt, ladder.promptSource).prompt : ladder.prompt;
    assert.equal(h.inputs[0], String(expected));

    // RFC 071 / status: spawned (naming the accepted launch), active, session, ready, E2.
    const types = h.frames.map((frame) => frame.type);
    assert.ok(types.indexOf("agent:process_spawned") < types.indexOf("agent:status"), types.join(","));
    const spawned = h.framesOf("agent:process_spawned")[0]!;
    assert.equal(spawned.launchId, "launch-1");
    assert.equal(spawned.respawn, undefined);
    assert.equal(h.framesOf("agent:status")[0]!.status, "active");
    assert.equal(h.framesOf("agent:session")[0]!.sessionId, h.sessions[0]!.id);
    assert.equal(h.framesOf("agent:runtime:ready").length, 1);
    const outcome = h.framesOf("agent:runtime:outcome")[0]!;
    assert.equal(outcome.outcome.kind, "turn_completed");
    assert.equal(outcome.launchId, "launch-1");
    assert.deepEqual(h.gateCalls.slice(0, 2), ["refusal:launch-1", `open:${spawned.processInstanceId}:launch-1`]);
    assert.deepEqual(h.framesOf("agent:turn:ended").map((frame) => frame.outcome), ["completed"]);
    // Activity: the legacy shapes (Starting…, the text row, Idle).
    const activity = h.framesOf("agent:activity");
    assert.ok(activity.some((frame) => frame.detail === "Starting…"));
    assert.ok(activity.some((frame) => frame.entries?.some((entry) => entry.kind === "text" && entry.text === "ok")));
    assert.equal(activity.at(-1)!.detailKind, "idle");
    // Every frame on one client sequence.
    const seqs = h.frames.map((frame) => (frame as { clientSeq?: number }).clientSeq).filter((value): value is number => typeof value === "number");
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally {
    await h.cleanup();
  }
});

test("a wake start gets the legacy wake input (inbox notice and unread suffix)", async () => {
  const h = await harness();
  try {
    const wake = message("m-1");
    assert.deepEqual(await h.host.start(request({ wakeMessage: wake, unreadSummary: exampleUnreadSummary })), { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    const workspace = path.join(h.dataDir, "agent-1");
    const driver = getDriver("grok");
    const runtimeConfig = { ...makeConfig(), runtimeContext: { agentId: "agent-1", workspacePath: workspace } };
    const ladder = planStartupInput({
      driver,
      runtimeConfig,
      isResume: false,
      standingPromptReachesSession: true,
      standingPromptInFirstInput: false,
      wakeMessage: wake,
      wakeMessageTransient: false,
      unreadSummary: exampleUnreadSummary,
      startingInboxMessages: [],
      projectThreadJoinContexts: (messages, render) => projectThreadJoinContextsForRuntimeInput(messages, () => undefined, render),
    });
    assert.equal(ladder.promptSource, "wake_inbox_update");
    assert.ok(h.inputs[0]!.endsWith(String(ladder.prompt)), h.inputs[0]);
    // The unread targets it showed ride the first turn end.
    await until(() => h.framesOf("agent:turn:ended").length > 0, "turn ended");
    assert.deepEqual(h.framesOf("agent:turn:ended")[0]!.shownUnreadTargets, Object.keys(exampleUnreadSummary));
  } finally {
    await h.cleanup();
  }
});

test("the session summary on disk carries each turn's actions and note, and survives the stop (#wg-ax task #3)", async () => {
  const h = await harness({
    turn: async (t: ScriptedTurn) => {
      await t.tool("shell", "cat notes/plan.md", () => "plan");
      await t.tool("shell", "raft message check", () => "[target=#a msg=aaaa1111 time=2026-11-03 09:00:00Z type=human] @tygg: go");
      await t.tool("shell", "raft message send --target \"#a\" <<'RAFTMSG'\nOn it.\nRAFTMSG", () => "Message sent to #a. Message ID: bbbb2222-0000");
      t.say("Waiting on Sage.");
    },
  });
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-1") })), { kind: "started" });
    await until(() => h.framesOf("agent:turn:ended").length > 0, "turn ended");
    const file = path.join(h.dataDir, ".daemon-state", "agent-session-summaries", "agent-1.json");
    const summary = JSON.parse(await readFile(file, "utf8"));
    assert.equal(summary.runtime, "grok");
    assert.equal(summary.turns.count, 1);
    assert.equal(summary.lastNote.text, "Waiting on Sage.");
    assert.deepEqual(summary.actions.map((action: { summary: string }) => action.summary.split("\n")[0]), [
      "cat notes/plan.md",
      "raft message check",
      "raft message send --target \"#a\" <<'RAFTMSG'",
    ]);
    // Real OAR tool output: the check's listing and the delivered send are both messages.
    const tail = summary.messages.slice(-2).map((entry: { direction: string; msgId: string }) => [entry.direction, entry.msgId]);
    assert.deepEqual(tail, [["received", "aaaa1111"], ["sent", "bbbb2222"]]);
    assert.deepEqual(summary.files.map((entry: { path: string }) => entry.path), [path.join(h.dataDir, "agent-1", "notes", "plan.md")]);
    assert.ok(summary.wake.input.length > 0);
    await h.host.stopAgent("agent-1", { wait: true });
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionId, summary.sessionId);
  } finally {
    await h.cleanup();
  }
});

test("a refused resume never opens a fresh session: the start goes back to the legacy host", async () => {
  const opened: OarLaunch[] = [];
  const h = await harness({
    openSession: async (launch) => {
      opened.push(launch);
      const error = new Error("session not found");
      error.name = "SessionNotFoundError";
      throw error;
    },
  });
  try {
    // The start carries the core's runner credential (the harness launch config keeps it).
    const outcome = await h.host.start(request({ config: makeConfig({ sessionId: "grok-session-1", agentCredentialKey: "sk_agent_x", agentCredentialId: "cred-1" }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "resume_failed:SessionNotFoundError");
    assert.equal(outcome.request.config.sessionId, "grok-session-1", "the legacy host gets the same session to resume");
    assert.equal(opened.length, 1, "no second, fresh open");
    assert.equal(opened[0]!.options.resume, "grok-session-1");
    assert.equal(h.host.owns("agent-1"), false);
    // Nothing was reported: no spawn, no status, the open record closed as never started.
    assert.deepEqual(h.framesOf("agent:process_spawned"), []);
    assert.deepEqual(h.framesOf("agent:status"), []);
    assert.ok(h.gateCalls.some((call) => call.startsWith("notStarted:")));
    assert.deepEqual(h.waiting.get("agent-1"), ["launch-1"], "the launch still waits for the legacy host's result");
    assert.deepEqual(h.revokes, [], "the runner credential stays for the legacy start");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.fallback" && event.attrs.reason === "resume_failed:SessionNotFoundError"));
  } finally {
    await h.cleanup();
  }
});

// task #1328: a failed open's reason names only the error class ("Error").
// The error's text is content and never reaches a trace; a closed class does.
test("oarOpenFailureClass maps a failed open to a closed class, never to its text", () => {
  const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
  const cases: Array<[unknown, string]> = [
    [new Error('Qoder did not confirm model "auto"; reported "Qwen3.8-Flash"'), "model_not_confirmed"],
    [new Error("codex thread/resume kept model gpt-5.5 although gpt-6.1 was requested"), "model_not_confirmed"],
    [new Error('Qoder model catalog did not contain requested selector "Efficient"'), "model_not_confirmed"],
    [new Error('Qoder model catalog did not provide a resolved name for "auto"; reported "Qwen3.8-Flash"'), "model_not_confirmed"],
    [new Error("codex thread/start reports serviceTier default although priority was requested"), "settings_not_confirmed"],
    [new Error("codex thread/start kept effort none (the model's default) although effort high was requested"), "settings_not_confirmed"],
    [new Error("codex thread/start did not confirm the requested additionalDirectories in runtimeWorkspaceRoots"), "settings_not_confirmed"],
    [new Error("codex thread/start reports no reasoningEffort although effort high was requested"), "settings_not_confirmed"],
    [new Error("codex thread/settings/update left effort low although high was requested"), "settings_not_confirmed"],
    [new Error("codex reported no thread/settings/updated within 10000 ms, so effort high cannot be confirmed"), "settings_not_confirmed"],
    [new Error("session/set_config_option reasoning_effort=xhigh was refused: Invalid params (unknown reasoning_effort value)"), "settings_not_confirmed"],
    [new Error("session/set_config_option reasoning_effort=high was refused: ACP request session/set_config_option timed out after 15000ms"), "timeout"],
    [withCode("spawn qodercli ENOENT", "ENOENT"), "runtime_not_found"],
    [withCode("spawn qodercli EACCES", "EACCES"), "permission_denied"],
    [new Error("401 Unauthorized: please log in"), "auth_failed"],
    [new Error("initialize timed out after 30000ms"), "timeout"],
    [withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"), "network"],
    [new Error("something else entirely"), "unknown"],
    ["not an error", "unknown"],
  ];
  for (const [cause, expected] of cases) assert.equal(oarOpenFailureClass(cause), expected, String(cause));
  for (const [cause] of cases) assert.ok((OAR_OPEN_FAILURE_CLASSES as readonly string[]).includes(oarOpenFailureClass(cause)));
});

test("a failed open's class reaches the local diagnostic trace on disk, and its text does not", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "oar-open-failure-trace-"));
  const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 4 * 1024 * 1024, maxFiles: 4 });
  const tracer = new BasicTracer({ sink });
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const h = await harness({
    openSession: async () => { throw new Error(`Qoder did not confirm model "auto"; reported "Qwen3.8-Flash" (key ${secret}, prompt: hello there)`); },
    deps: {
      recordEvent: (name, attrs, status = "ok") => { tracer.emitEvent(name, { surface: "daemon", attrs: { ...attrs, status } }); },
    },
  });
  try {
    const outcome = await h.host.start(request());
    assert.equal(outcome.kind === "fallback" && outcome.reason, "open_failed:Error");
    const dir = path.join(machineDir, "traces");
    const lines: string[] = [];
    for (const name of await readdir(dir)) lines.push(...(await readFile(path.join(dir, name), "utf8")).split("\n").filter(Boolean));
    const fallback = lines.map((line) => JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> })
      .find((record) => record.name === "daemon.agent.oar.fallback");
    assert.ok(fallback, "the fallback event is on disk");
    assert.equal(fallback.attrs?.reason, "open_failed:Error");
    assert.equal(fallback.attrs?.open_failure_class, "model_not_confirmed");
    const raw = lines.join("\n");
    assert.doesNotMatch(raw, /Qwen3\.8-Flash|hello there|sk-ant-/, "no error text on disk");
  } finally {
    await h.cleanup();
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("an open failure and an RFC 071 refusal both hand the start back before any runtime runs", async () => {
  const failing = await harness({ openSession: async () => { throw new Error("spawn grok ENOENT"); } });
  try {
    const outcome = await failing.host.start(request());
    assert.equal(outcome.kind === "fallback" && outcome.reason, "open_failed:Error");
  } finally {
    await failing.cleanup();
  }
  const refused = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => ({ reason: "terminal_failure_needs_manual", detail: "needs a manual start" }),
        waitForCapability: () => ({ confirmed: Promise.resolve(true), cancel: () => {} }),
      },
    },
  });
  try {
    const outcome = await refused.host.start(request());
    assert.equal(outcome.kind === "fallback" && outcome.reason, "start_refused");
    assert.equal(refused.opened.length, 0);
  } finally {
    await refused.cleanup();
  }
});

test("a stop while the start waits for the server capability cancels it: no runtime, the launch is cancelled", async () => {
  let cancel!: () => void;
  const h = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => null,
        waitForCapability: () => {
          let settle!: (value: boolean) => void;
          const confirmed = new Promise<boolean>((resolve) => { settle = resolve; });
          cancel = () => settle(false);
          return { confirmed, cancel: () => cancel() };
        },
      },
    },
  });
  try {
    const started = h.host.start(request());
    await until(() => typeof cancel === "function", "capability wait");
    await h.host.stopAgent("agent-1");
    assert.deepEqual(await started, { kind: "stopped" });
    assert.equal(h.opened.length, 0);
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

/** Holds the first launch in `buildSpawnConfig` until `release()`; each launch gets its own runner credential. */
function heldFirstSpawnConfig(): { deps: Partial<OarAgentHostDeps>; calls: () => number; release: () => void } {
  const gate = deferred();
  let calls = 0;
  return {
    deps: {
      buildSpawnConfig: async (_agentId, config) => {
        calls += 1;
        const n = calls;
        if (n === 1) await gate.promise;
        return { ...config, agentCredentialKey: `sk_agent_${n}`, agentCredentialId: `cred-${n}` };
      },
    },
    calls: () => calls,
    release: gate.resolve,
  };
}

test("a start after a stop of a start still in progress is a new start: only the stopped launch is cancelled", async () => {
  const held = heldFirstSpawnConfig();
  const h = await harness({ deps: held.deps });
  try {
    const first = h.host.start(request());
    await until(() => held.calls() === 1, "the first launch's spawn config");
    await h.host.stopAgent("agent-1");
    assert.equal(h.host.owns("agent-1"), false, "a stopped start no longer holds the agent");
    // The server accepted another start after the stop.
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    const second = h.host.start(request({ launchId: "launch-2" }));
    assert.deepEqual(h.host.getAgentStartAcceptance("agent-1"), { queueState: "starting", queueDepth: 0, queueAgeMs: 0 });
    held.release();
    assert.deepEqual(await first, { kind: "stopped" });
    assert.deepEqual(await second, { kind: "started" }, "never rebound onto the stopped start");
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    const spawned = h.framesOf("agent:process_spawned");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.launchId, "launch-2");
    assert.equal(spawned[0]!.supersededLaunchIds, undefined);
    assert.equal(h.opened.length, 1, "only the new start opened a session, after the stopped one unwound");
    assert.deepEqual(h.host.getRunningAgentIds(), ["agent-1"]);
    await until(() => h.revokes.length > 0, "the stopped launch's credential revoked");
    assert.equal(h.revokes.length, 1, "the new launch keeps its credential");
  } finally {
    await h.cleanup();
  }
});

/** A router over the harness's host, beside a legacy stand-in that logs its starts. */
function routerOver(h: Harness, log: string[] = []): { router: AgentHostRouter; legacyStarts: Array<string | undefined> } {
  const legacyStarts: Array<string | undefined> = [];
  const legacy = {
    agentHostState: () => (legacyStarts.length > 0 ? "active" as const : "none" as const),
    forgetSpecHandback: () => {},
    startAgent: async (...args: unknown[]) => {
      legacyStarts.push(args[5] as string | undefined);
      log.push(`legacy start ${String(args[5])}`);
    },
    stopAgent: async () => {},
    stopAll: async () => {},
    deliverMessage: () => false,
    // What the legacy host reads for an agent it holds no start for.
    getAgentStartAcceptance: () => ({ queueState: "rebound" as const, queueDepth: 0, queueAgeMs: 0 }),
    getRunningAgentIds: () => [],
    getHeldRunnerCredentialIds: () => [],
    setTracer: () => {},
    setCliTransportTraceDir: () => {},
  };
  const router = new AgentHostRouter(legacy as unknown as LegacyAgentHost, h.host, {
    recordEvent: () => {},
    settleNotSpawned: h.settleNotSpawned,
    releaseUnusedCredential: () => {},
  });
  return { router, legacyStarts };
}

const STARTING = { queueState: "starting", queueDepth: 0, queueAgeMs: 0 } as const;

test("router: a start after a stop of an OAR start still in progress goes to the host it asks for, once the stopped start unwound", async () => {
  const held = heldFirstSpawnConfig();
  const h = await harness({ deps: held.deps });
  const { router, legacyStarts } = routerOver(h);
  try {
    const first = router.startAgent("agent-1", makeConfig(), undefined, undefined, undefined, "launch-1");
    await until(() => held.calls() === 1, "the first launch's spawn config");
    await router.stopAgent("agent-1");
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    const second = router.startAgent("agent-1", makeConfig({ runtimeHost: undefined }), undefined, undefined, undefined, "launch-2");
    assert.deepEqual(router.getAgentStartAcceptance("agent-1"), STARTING, "read as starting while it waits");
    held.release();
    await first;
    await second;
    assert.deepEqual(legacyStarts, ["launch-2"], "the legacy start runs, not absorbed by the stopped OAR start");
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    assert.deepEqual(h.waiting.get("agent-1"), ["launch-2"], "the legacy start's launch still waits for its own result");
    assert.equal(h.opened.length, 0);
    assert.deepEqual(h.host.getRunningAgentIds(), []);
  } finally {
    await h.cleanup();
  }
});

test("router: a legacy start after a stop of an OAR start that is opening the session runs only after that session is disposed", async () => {
  const openGate = deferred();
  const log: string[] = [];
  const h = await harness({
    firstOpenGate: openGate.promise,
    wrapSession: (session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "dispose") return async () => { await target.dispose(); log.push("oar session disposed"); };
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  const { router, legacyStarts } = routerOver(h, log);
  try {
    const first = router.startAgent("agent-1", makeConfig({ sessionId: "grok-session-1" }), undefined, undefined, undefined, "launch-1");
    await until(() => h.gateCalls.some((call) => call.startsWith("open:")), "the OAR start opening grok-session-1");
    await router.stopAgent("agent-1");
    // The flag went off: the next start asks for the legacy host, on the same session.
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    const second = router.startAgent("agent-1", makeConfig({ sessionId: "grok-session-1", runtimeHost: undefined }), undefined, undefined, undefined, "launch-2");
    assert.deepEqual(router.getAgentStartAcceptance("agent-1"), STARTING);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(legacyStarts, [], "no legacy grok while the OAR grok may still load the session");
    openGate.resolve();
    await first;
    await second;
    assert.deepEqual(log, ["oar session disposed", "legacy start launch-2"]);
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    assert.deepEqual(h.waiting.get("agent-1"), ["launch-2"]);
  } finally {
    await h.cleanup();
  }
});

test("a stop of a start waiting for a stopped start to unwind cancels it at once, on either host", async () => {
  const openGate = deferred();
  const h = await harness({ firstOpenGate: openGate.promise });
  const { router, legacyStarts } = routerOver(h);
  try {
    const first = router.startAgent("agent-1", makeConfig(), undefined, undefined, undefined, "launch-1");
    await until(() => h.gateCalls.some((call) => call.startsWith("open:")), "the first start opening its session");
    await router.stopAgent("agent-1");

    // An OAR start waits for the unwind; a stop cancels it without waiting for it.
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    const second = router.startAgent("agent-1", makeConfig(), undefined, undefined, undefined, "launch-2");
    assert.equal(h.host.owns("agent-1"), true);
    await router.stopAgent("agent-1");
    await second;
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-2", reason: "cancelled" }], "cancelled while the first start still unwinds");

    // A legacy start waits for the unwind too; a stop cancels it the same way.
    h.waiting.set("agent-1", ["launch-1", "launch-3"]);
    const third = router.startAgent("agent-1", makeConfig({ runtimeHost: undefined }), undefined, undefined, undefined, "launch-3");
    assert.deepEqual(router.getAgentStartAcceptance("agent-1"), STARTING);
    await router.stopAgent("agent-1");
    await third;
    assert.deepEqual(h.notSpawned.map((each) => each.launchId), ["launch-2", "launch-3"]);
    assert.equal(h.host.isUnwinding("agent-1"), true, "the first start is still undoing its launch");

    openGate.resolve();
    await first;
    assert.deepEqual(h.notSpawned.map((each) => each.launchId), ["launch-2", "launch-3", "launch-1"]);
    assert.equal(h.opened.length, 1, "only the first start opened a session");
    assert.deepEqual(legacyStarts, [], "nothing ran on the legacy host");
    await h.host.unwound("agent-1");
    assert.equal(h.host.isUnwinding("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

test("stopAll resolves only once a stopped start's launch is undone: its open record is closed first", async () => {
  const openGate = deferred();
  const h = await harness({ firstOpenGate: openGate.promise });
  try {
    const started = h.host.start(request());
    await until(() => h.gateCalls.some((call) => call.startsWith("open:")), "the start opening its session");
    let resolved = false;
    const stopping = h.host.stopAll().then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false, "the daemon's outbox must not stop while the open record is still open");
    assert.ok(!h.gateCalls.some((call) => call.startsWith("notStarted:")));
    openGate.resolve();
    await stopping;
    assert.ok(h.gateCalls.some((call) => call.startsWith("notStarted:")), "closed as never started before stopAll resolved");
    assert.equal(h.revokes.length, 1);
    assert.deepEqual(await started, { kind: "stopped" });
  } finally {
    openGate.resolve();
    await h.cleanup();
  }
});

test("a waiting stop resolves only once the stopped start's launch is undone, also through the router after an earlier stop", async () => {
  const openGate = deferred();
  const h = await harness({ firstOpenGate: openGate.promise });
  try {
    const started = h.host.start(request());
    await until(() => h.gateCalls.some((call) => call.startsWith("open:")), "the start opening its session");
    let resolved = false;
    const stopping = h.host.stopAgent("agent-1", { wait: true, silent: true }).then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false, "a migration must not upload the workspace while grok may still open the session in it");
    openGate.resolve();
    await stopping;
    assert.ok(h.gateCalls.some((call) => call.startsWith("notStarted:")));
    assert.equal(h.host.isUnwinding("agent-1"), false);
    await started;
  } finally {
    openGate.resolve();
    await h.cleanup();
  }
  // An earlier stop already gave the agent up: the router's waiting stop still waits for the unwind.
  const gate = deferred();
  const r = await harness({ firstOpenGate: gate.promise });
  const { router } = routerOver(r);
  try {
    const started = router.startAgent("agent-1", makeConfig(), undefined, undefined, undefined, "launch-1");
    await until(() => r.gateCalls.some((call) => call.startsWith("open:")), "the start opening its session");
    await router.stopAgent("agent-1");
    assert.equal(r.host.owns("agent-1"), false);
    let resolved = false;
    const stopping = router.stopAgent("agent-1", { wait: true, silent: true }).then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false);
    gate.resolve();
    await stopping;
    assert.ok(r.gateCalls.some((call) => call.startsWith("notStarted:")));
    await started;
  } finally {
    gate.resolve();
    await r.cleanup();
  }
});

test("a start after a stop of a running session waits for that session's dispose; the stop's inactive is not sent over it", async () => {
  const disposeGate = deferred();
  let disposing = false;
  const log: string[] = [];
  const h = await harness({
    wrapSession: (session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "dispose") {
          return async () => {
            if (!disposing) {
              disposing = true;
              await disposeGate.promise;
            }
            await target.dispose();
            log.push("disposed");
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    const stopped = h.host.stopAgent("agent-1");
    await until(() => disposing, "the session's dispose");
    assert.equal(h.host.isUnwinding("agent-1"), true);
    h.waiting.set("agent-1", ["launch-2"]);
    const second = h.host.start(request({ launchId: "launch-2" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.opened.length, 1, "no second grok on the session while the first one is still releasing it");
    disposeGate.resolve();
    await stopped;
    assert.deepEqual(await second, { kind: "started" });
    assert.equal(h.opened.length, 2);
    const order = h.frames.map((frame) => (frame.type === "agent:status" ? `status:${frame.status}` : frame.type))
      .filter((type) => type === "agent:process_exited" || type === "agent:process_spawned" || type.startsWith("status:"));
    assert.deepEqual(order, ["agent:process_spawned", "status:active", "agent:process_exited", "agent:process_spawned", "status:active"]);
  } finally {
    disposeGate.resolve();
    await h.cleanup();
  }
});

test("a rebind while the start waits keeps the start's own wake and adds its own: both reach the first input once", async () => {
  let confirm: ((value: boolean) => void) | undefined;
  const spawnConfigs: AgentConfig[] = [];
  const h = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => null,
        waitForCapability: () => {
          const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
          return { confirmed, cancel: () => confirm?.(false) };
        },
      },
      buildSpawnConfig: async (_agentId, config) => {
        spawnConfigs.push(config);
        return { ...config, agentCredentialKey: "sk_agent_x", agentCredentialId: "cred-1" };
      },
    },
  });
  try {
    const own = message("m-own", { channel_id: "ch-alpha", channel_name: "alpha" });
    const later = message("m-later", { channel_id: "ch-beta", channel_name: "beta" });
    const started = h.host.start(request({ wakeMessage: own }));
    await until(() => confirm !== undefined, "capability wait");
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", wakeMessage: later, config: makeConfig({ model: "grok-next" }) })), { kind: "rebound" });
    confirm!(true);
    assert.deepEqual(await started, { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    const named = (id: string) => h.inputs[0]!.split(`first msg=${id} `).length - 1;
    assert.equal(named("m-own"), 1, `the start's own wake: ${h.inputs[0]}`);
    assert.equal(named("m-later"), 1, `the rebind's wake, once: ${h.inputs[0]}`);
    assert.equal(spawnConfigs[0]!.model, "grok-next", "the launch runs the latest config");
    assert.deepEqual(h.framesOf("agent:process_spawned")[0]!.supersededLaunchIds, ["launch-1"]);
  } finally {
    await h.cleanup();
  }
});

test("a rebind that carries the start's own wake counts it once", async () => {
  let confirm: ((value: boolean) => void) | undefined;
  const h = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => null,
        waitForCapability: () => {
          const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
          return { confirmed, cancel: () => confirm?.(false) };
        },
      },
    },
  });
  try {
    const same = message("m-same", { channel_id: "ch-alpha", channel_name: "alpha" });
    const started = h.host.start(request({ wakeMessage: same }));
    await until(() => confirm !== undefined, "capability wait");
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    await h.host.start(request({ launchId: "launch-2", wakeMessage: { ...same } }));
    confirm!(true);
    await started;
    await until(() => h.inputs.length > 0, "first input");
    assert.match(h.inputs[0]!, /#alpha {2}pending: 1 message · first msg=m-same /, h.inputs[0]);
  } finally {
    await h.cleanup();
  }
});

test("a stop while a fallback disposes the opened session wins: no fallback, the launch is cancelled", async () => {
  const disposeGate = deferred();
  let disposing = false;
  const h = await harness({
    wrapSession: (session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "prompt") return async () => ({ kind: "rejected", code: "runtime_refused", reason: "refused", seq: 0, requestId: "r-1" });
        if (prop === "dispose") return async () => { disposing = true; await disposeGate.promise; return target.dispose(); };
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    const started = h.host.start(request({ config: makeConfig({ sessionId: "grok-session-1" }) }));
    await until(() => disposing, "the fallback's dispose");
    await h.host.stopAgent("agent-1");
    disposeGate.resolve();
    assert.deepEqual(await started, { kind: "stopped" }, "never a fallback after the stop");
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    assert.equal(h.host.owns("agent-1"), false);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["inactive"]);
    assert.ok(!h.events.some((event) => event.name === "daemon.agent.oar.fallback"));
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.start_cancelled"));
  } finally {
    await h.cleanup();
  }
});

test("deliveries: idle ones start a turn with the legacy inbox notice; a redelivery is acked once and never sent again", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    const delivered = message("m-2");
    const acked: string[] = [];
    const context: AgentDeliveryContext = { onMentionAck: () => acked.push("ack") };
    assert.equal(await h.host.deliverMessage("agent-1", delivered, context), true);
    await until(() => h.inputs.length === 2, "delivery turn");
    assert.equal(h.inputs[1], String(formatInboxUpdateRuntimeInput([delivered], getDriver("grok"), 1)));
    assert.equal(await h.host.deliverMessage("agent-1", delivered, context), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.inputs.length, 2, "the redelivery never reached the runtime");
    assert.ok(h.framesOf("agent:activity").some((frame) => frame.detail === "Message received"));
  } finally {
    await h.cleanup();
  }
});

/** A harness whose first turn runs until `release`; later turns answer at once. */
async function busyHarness(): Promise<{ h: Harness; release: () => void }> {
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await gate.promise;
      turn.say("done");
    },
  });
  await h.host.start(request());
  await until(() => h.inputs.length === 1, "first turn running");
  return { h, release: gate.resolve };
}

const MENTION = { occurrenceId: "occ-1", messageId: "m-mention", machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never;

test("a delivery to a busy grok session is acked on custody, held in the host and prompted after the turn end, never steered", async () => {
  const { h, release } = await busyHarness();
  try {
    // Custody, as the legacy host acks what it queues: no server re-sends while the turn runs.
    assert.equal(await h.host.deliverMessage("agent-1", message("m-busy"), { deliveryId: "d-busy" }), true);
    assert.equal(h.inputs.length, 1, "not in the running turn");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_until_turn_end"));
    release();
    await until(() => h.inputs.length === 2, "the delivery's own turn");
    assert.equal(h.inputs[1], String(formatInboxUpdateRuntimeInput([message("m-busy")], getDriver("grok"), 1)));
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "prompted"));
    assert.deepEqual(h.steered(), [], "nothing was steered into the running turn");
  } finally {
    release();
    await h.cleanup();
  }
});

test("a transient delivery (no message id) re-sent by the server while held reaches grok once", async () => {
  const { h, release } = await busyHarness();
  try {
    const notice = (): AgentMessage => ({ ...message("unused"), message_id: undefined, sender_type: "system", content: "ONE-TIME NOTICE" });
    const results: Array<boolean | Promise<boolean>> = [];
    // The first push, then the server's ack-retry re-sends (same delivery id).
    for (let i = 0; i < 4; i += 1) results.push(h.host.deliverMessage("agent-1", notice(), { deliveryId: "d-transient", transient: true }));
    assert.deepEqual(await Promise.all(results), [true, true, true, true]);
    release();
    await until(() => h.inputs.length === 2, "the notice's turn");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.inputs.filter((input) => input.includes("ONE-TIME NOTICE")).length, 1);
    // A re-send after it was taken: acked, never sent again.
    assert.equal(await h.host.deliverMessage("agent-1", notice(), { deliveryId: "d-transient", transient: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.inputs.length, 2);
  } finally {
    release();
    await h.cleanup();
  }
});

test("a tracked mention to a busy grok: daemon_received and daemon_pending when held, re-sends coalesced, drained and acked once at the hand-off", async () => {
  const { h, release } = await busyHarness();
  try {
    const transitions: string[] = [];
    let acks = 0;
    const context = (): AgentDeliveryContext => ({
      deliveryId: "occ-1",
      mentionDelivery: MENTION,
      onMentionTransition: (stage, outcome) => { transitions.push(`${stage}:${outcome}`); },
      onMentionAck: () => { acks += 1; },
    });
    const mention = message("m-mention");
    await h.host.deliverMessage("agent-1", mention, context());
    assert.deepEqual(transitions, ["daemon_received:accepted", "daemon_pending:accepted"], "the server stops re-sending");
    await h.host.deliverMessage("agent-1", mention, context());
    assert.deepEqual(transitions.slice(2), ["daemon_pending:coalesced"]);
    assert.equal(acks, 0);
    release();
    await until(() => acks > 0, "the mention's hand-off");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(transitions.slice(3), ["daemon_drained:accepted"]);
    assert.equal(acks, 1);
    assert.equal(h.inputs.length, 2, "one turn for it");
    // A re-send after the hand-off is acked again (the legacy host's duplicate_drained), not re-sent.
    await h.host.deliverMessage("agent-1", mention, context());
    assert.equal(acks, 2);
    assert.equal(transitions.length, 4);
  } finally {
    release();
    await h.cleanup();
  }
});

test("a stop with a delivery held for the turn end: it was acked on custody, is not prompted, and stays for the server's catch-up", async () => {
  const { h, release } = await busyHarness();
  try {
    let rejectedNoProcess = 0;
    assert.equal(await h.host.deliverMessage("agent-1", message("m-busy"), { onRejectedNoProcess: () => { rejectedNoProcess += 1; } }), true);
    await h.host.stopAgent("agent-1");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.inputs.length, 1, "never prompted");
    assert.equal(rejectedNoProcess, 0, "nothing to take back: unread on the server, carried by the next start");
    const dropped = h.events.find((event) => event.name === "daemon.agent.oar.held_dropped");
    assert.deepEqual(dropped?.attrs, { agentId: "agent-1", count: 1, unconsumed_count: 1, reason: "explicit_stop", expected: true });
  } finally {
    release();
    await h.cleanup();
  }
});

test("a held tracked mention is handed back once when grok exits, never at a stop", async () => {
  const outcomes: Record<string, string[]> = {};
  for (const end of ["silent_stop", "explicit_stop", "crash"] as const) {
    const { h, release } = await busyHarness();
    const seen: string[] = [];
    try {
      const context = (): AgentDeliveryContext => ({
        deliveryId: "occ-1",
        mentionDelivery: MENTION,
        onMentionTransition: (stage, outcome) => { seen.push(`${stage}:${outcome}`); },
        onRejectedNoProcess: () => { seen.push("rejected_no_process"); },
        onMentionTerminalError: (code) => { seen.push(`terminal:${code}`); },
      });
      await h.host.deliverMessage("agent-1", message("m-mention"), context());
      await h.host.deliverMessage("agent-1", message("m-mention"), context());
      if (end === "crash") {
        await h.sessions[0]!.dispose();
        await until(() => h.framesOf("agent:process_exited").length > 0, "process_exited");
      } else {
        await h.host.stopAgent("agent-1", { silent: end === "silent_stop" });
      }
      outcomes[end] = seen.slice(3);
    } finally {
      release();
      await h.cleanup();
    }
  }
  // A stop: the server's held cycle settles it (no wake start for an agent shutting down or migrating).
  assert.deepEqual(outcomes.silent_stop, []);
  assert.deepEqual(outcomes.explicit_stop, []);
  // A crash: handed back once, so the server wakes the agent for it.
  assert.deepEqual(outcomes.crash, ["rejected_no_process"]);
});

test("a new mention occurrence of a message the runtime already took is received, drained and acked", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-x"), { deliveryId: "d-plain" }), true);
    await until(() => h.inputs.length === 2, "the plain delivery's turn");
    const seen: string[] = [];
    await h.host.deliverMessage("agent-1", message("m-x"), {
      deliveryId: "occ-2",
      mentionDelivery: MENTION,
      onMentionTransition: (stage, outcome) => { seen.push(`${stage}:${outcome}`); },
      onMentionAck: () => { seen.push("ack"); },
    });
    assert.deepEqual(seen, ["daemon_received:accepted", "daemon_drained:accepted", "ack"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.inputs.length, 2, "not sent again");
  } finally {
    await h.cleanup();
  }
});

test("the taken ids a launch remembers for dedup are bounded (oldest first)", async () => {
  const h = await harness({ deps: { takenIdLimit: 4 } });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    // Each taken delivery leaves its message id and its delivery id.
    for (const n of [1, 2, 3]) {
      await h.host.deliverMessage("agent-1", message(`m-${n}`), { deliveryId: `d-${n}` });
      await until(() => h.inputs.length === 1 + n, `delivery ${n}`);
    }
    await h.host.deliverMessage("agent-1", message("m-3"), { deliveryId: "d-3" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.inputs.length, 4, "a recent one is still deduplicated");
    await h.host.deliverMessage("agent-1", message("m-1"), { deliveryId: "d-1" });
    await until(() => h.inputs.length === 5, "the oldest was evicted");
  } finally {
    await h.cleanup();
  }
});

test("a start for a running agent rebinds the session (RFC 071 rebound) instead of starting another", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    const processInstanceId = h.framesOf("agent:process_spawned")[0]!.processInstanceId;
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2" })), { kind: "rebound" });
    assert.deepEqual(h.rebound, [{ launchId: "launch-2", processInstanceId }]);
    assert.equal(h.host.getAgentLaunchId("agent-1"), "launch-2");
    assert.deepEqual(h.host.getAgentStartAcceptance("agent-1"), { queueState: "running", queueDepth: 0, queueAgeMs: 0, processInstanceId });
    assert.equal(h.opened.length, 1);
  } finally {
    await h.cleanup();
  }
});

// #wg-rbac:#27: a rebound start runs on the credential the launch holds. The
// rebind replaced the request (and its credential) while the revoke read the
// launch config, so the rebound start's credential stayed valid for good.
// Teeth: drop carryRunnerCredential in rebind -> no revoke of cred-new -> RED.
const keepOrMintCredential = async (_agentId: string, config: AgentConfig): Promise<AgentConfig> => (
  config.agentCredentialKey ? config : { ...config, agentCredentialKey: "sk_agent_spawn", agentCredentialId: "cred-spawn" }
);
const credentialConfig = (id: string) => makeConfig({ agentCredentialKey: `sk_agent_${id}`, agentCredentialId: `cred-${id}` });
const revokedIds = (h: Harness) => h.revokes.map((url) => new URL(url).pathname.split("/").at(-1));

test("a successful OAR start revokes nothing until its release, then its credential once", async () => {
  for (const [config, expected] of [[credentialConfig("core"), "cred-core"], [makeConfig(), "cred-spawn"]] as const) {
    const h = await harness({ deps: { buildSpawnConfig: keepOrMintCredential } });
    try {
      assert.deepEqual(await h.host.start(request({ config })), { kind: "started" });
      await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(revokedIds(h), [], "a running session keeps its credential");
      await h.host.stopAgent("agent-1");
      await until(() => h.revokes.length > 0, "credential revoked at release");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(revokedIds(h), [expected]);
    } finally {
      await h.cleanup();
    }
  }
});

test("a start rebound onto a running session revokes its own credential once; the stop revokes the session's", async () => {
  const h = await harness({ deps: { buildSpawnConfig: keepOrMintCredential } });
  try {
    await h.host.start(request({ config: credentialConfig("old") }));
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: credentialConfig("new") })), { kind: "rebound" });
    await until(() => h.revokes.length > 0, "unused credential revoked");
    assert.deepEqual(revokedIds(h), ["cred-new"], "only the rebound start's credential, never the session's");
    await h.host.stopAgent("agent-1");
    await until(() => h.revokes.length > 1, "session credential revoked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(revokedIds(h), ["cred-new", "cred-old"]);
  } finally {
    await h.cleanup();
  }
});

test("a start rebound onto a start still waiting keeps the start's credential and revokes its own", async () => {
  let confirm: ((value: boolean) => void) | undefined;
  const spawnConfigs: AgentConfig[] = [];
  const h = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => null,
        waitForCapability: () => {
          const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
          return { confirmed, cancel: () => confirm?.(false) };
        },
      },
      buildSpawnConfig: async (agentId, config) => { spawnConfigs.push(config); return keepOrMintCredential(agentId, config); },
    },
  });
  try {
    const started = h.host.start(request({ config: credentialConfig("old") }));
    await until(() => confirm !== undefined, "capability wait");
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: credentialConfig("new") })), { kind: "rebound" });
    confirm!(true);
    assert.deepEqual(await started, { kind: "started" });
    assert.equal(spawnConfigs[0]!.agentCredentialId, "cred-old", "the launch runs on the start's credential");
    assert.deepEqual(revokedIds(h), ["cred-new"]);
    await h.host.stopAgent("agent-1");
    await until(() => h.revokes.length > 1, "launch credential revoked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(revokedIds(h), ["cred-new", "cred-old"]);
  } finally {
    await h.cleanup();
  }
});

test("a start handed back to the legacy host revokes a credential its launch minted, never the one it hands over", async () => {
  for (const [config, handedOver, revoked] of [
    [makeConfig(), undefined, ["cred-spawn"]],
    [credentialConfig("own"), "cred-own", []],
  ] as const) {
    const h = await harness({
      deps: {
        buildSpawnConfig: keepOrMintCredential,
        openSession: async () => { throw new Error("boom"); },
      },
    });
    try {
      const outcome = await h.host.start(request({ config }));
      assert.equal(outcome.kind, "fallback");
      assert.equal(outcome.kind === "fallback" ? outcome.request.config.agentCredentialId : null, handedOver);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(revokedIds(h), revoked);
    } finally {
      await h.cleanup();
    }
  }
});

// #wg-rbac:#27: the daemon's ready lists the runner credentials a live launch
// holds (its spawn-minted one and its start's, when another), also while it
// is still starting; a stopped launch's are gone from the list.
// Teeth: return [] from OarAgentHost.getHeldRunnerCredentialIds -> RED.
test("getHeldRunnerCredentialIds: a starting and a running launch's credentials, none once stopped", async () => {
  let confirm: ((value: boolean) => void) | undefined;
  const h = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: () => null,
        waitForCapability: () => {
          const confirmed = new Promise<boolean>((resolve) => { confirm = resolve; });
          return { confirmed, cancel: () => confirm?.(false) };
        },
      },
      buildSpawnConfig: keepOrMintCredential,
    },
  });
  try {
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), []);
    const started = h.host.start(request({ config: credentialConfig("old") }));
    await until(() => confirm !== undefined, "capability wait");
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), ["cred-old"], "a starting launch holds its start's credential");
    h.waiting.set("agent-1", ["launch-1", "launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: credentialConfig("new") })), { kind: "rebound" });
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), ["cred-old"], "a rebound start's own credential is not held");
    confirm!(true);
    assert.deepEqual(await started, { kind: "started" });
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), ["cred-old"]);
    await h.host.stopAgent("agent-1");
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), []);
  } finally {
    await h.cleanup();
  }
  // A launch that minted its own at spawn holds that one.
  const minted = await harness({ deps: { buildSpawnConfig: keepOrMintCredential } });
  try {
    assert.deepEqual(await minted.host.start(request({ config: makeConfig() })), { kind: "started" });
    assert.deepEqual(minted.host.getHeldRunnerCredentialIds(), ["cred-spawn"]);
  } finally {
    await minted.cleanup();
  }
});

test("a runtime that exits on its own: inactive with the exit, process_exited, held deliveries dropped for the server's catch-up", async () => {
  const release = deferred();
  const h = await harness({ turn: async () => { await release.promise; } });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "first turn running");
    let rejectedNoProcess = 0;
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held"), { onRejectedNoProcess: () => { rejectedNoProcess += 1; } }), true, "acked on custody");
    // The scripted runtime's process "exits" (a dispose the host did not ask for).
    await h.sessions[0]!.dispose();
    await until(() => h.framesOf("agent:process_exited").length > 0, "process_exited");
    release.resolve();
    const exited = h.framesOf("agent:process_exited")[0]!;
    assert.equal(exited.spawnLaunchId, "launch-1");
    assert.equal(exited.launchId, "launch-1");
    const inactive = h.framesOf("agent:status").find((frame) => frame.status === "inactive")!;
    assert.ok(inactive.exit, "the exit rides the status for the crash-loop breaker");
    assert.equal(h.host.owns("agent-1"), false);
    // Held for the turn end, never taken: unread on the server for the next start; the drop is a warning.
    assert.equal(rejectedNoProcess, 0);
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.held_dropped" && event.attrs.reason === "runtime_exited" && event.attrs.expected === false));
    assert.equal(h.revokes.length, 1, "the runner credential is revoked at the end of the launch");
  } finally {
    await h.cleanup();
  }
});

// #proj-raft-computer:#46 (reconciler step 4a): an exhausted billing balance
// is the credential's (C3), not a broken session: it used to end the session
// with E1 billing_rejected. Now the session is kept, no E1, and deliveries wait
// for the credential (or a person's Retry).
test("a billing failure keeps the session (no E1) and holds deliveries until a stop; the stop reports the exit once", async () => {
  const h = await harness({
    turn: () => { throw new Error("insufficient credits"); },
    wrapSession: (session) => withFailure(session, "billing"),
  });
  try {
    await h.host.start(request());
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    assert.deepEqual(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "terminal_failure"), []);
    assert.equal(h.framesOf("agent:status").some((frame) => frame.status === "inactive"), false);
    assert.equal(h.framesOf("agent:activity").at(-1)!.detailKind, "runtime_error");
    assert.match(h.framesOf("agent:activity").at(-1)!.detail, /billing or credit balance is exhausted/);
    assert.equal(h.framesOf("agent:process_exited").length, 0);
    assert.equal(h.host.owns("agent-1"), true);
    assert.equal(h.events.find((event) => event.name === "daemon.agent.credential_invalid.recorded")?.attrs.credential_invalid_reason, "billing");
    await h.host.deliverMessage("agent-1", message("m-held"));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_for_credential_invalid"), "held");
    assert.equal(h.inputs.length, 1, "nothing goes into the same rejection");
    await h.host.stopAgent("agent-1");
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

test("an explicit stop: once the session is gone, the runtime profile report, inactive, Stopped; process_exited once, credential revoked", async () => {
  const reports: string[] = [];
  const h = await harness({ deps: { sendRuntimeProfileReport: (_agentId, session, source) => { reports.push(`${source}:${session.sessionId}`); } } });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    const sessionId = h.sessions[0]!.id;
    assert.deepEqual(reports, [`session_init:${sessionId}`]);
    await h.host.stopAgent("agent-1");
    assert.deepEqual(reports, [`session_init:${sessionId}`, `stop:${sessionId}`]);
    const order = h.frames.map((frame) => (frame.type === "agent:status" ? `status:${frame.status}` : frame.type === "agent:activity" ? `activity:${frame.detailKind}` : frame.type));
    assert.ok(order.indexOf("agent:process_exited") < order.indexOf("status:inactive"), order.join(","));
    assert.ok(order.indexOf("status:inactive") < order.indexOf("activity:stopped"), order.join(","));
    assert.equal(h.framesOf("agent:status").at(-1)!.status, "inactive");
    assert.ok(h.framesOf("agent:activity").some((frame) => frame.detailKind === "stopped"));
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    assert.equal(h.revokes.length, 1);
    assert.deepEqual(h.host.getRunningAgentIds(), []);
    assert.equal(h.host.deliverMessage("agent-1", message("m-late")), false);
  } finally {
    await h.cleanup();
  }
});

test("the frame that opens a turn names the message that woke it, as the legacy host does (#proj-raft-computer:#40)", async () => {
  const h = await harness();
  try {
    await h.host.start(request({ wakeMessage: message("m-1") }));
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the wake's turn end");
    const opening = h.framesOf("agent:activity").find((frame) => frame.detailKind === "model_request_started");
    const status = opening?.entries?.find((entry) => entry.kind === "status");
    assert.equal(status?.kind === "status" && status.trigger?.messageId, "m-1", JSON.stringify(opening));
  } finally {
    await h.cleanup();
  }
});

test("stopAll publishes a held empty wake on the current activity first, as the legacy host does (task #17)", async () => {
  const h = await harness();
  try {
    await h.host.start(request({ wakeMessage: message("m-1") }));
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the wake's turn end");
    const summaries = () => h.framesOf("agent:activity").filter((frame) => frame.entries?.some((entry) => entry.kind === "turn_summary"));
    assert.deepEqual(summaries(), [], "an empty wake is held");
    await h.host.stopAll();
    assert.equal(summaries().length, 1);
    assert.equal(summaries()[0]!.detailKind, "idle");
  } finally {
    await h.cleanup();
  }
});

test("server context rides ahead of the first input and is not a wake (task #26)", async () => {
  const h = await harness();
  try {
    const context = message("ctx-1", { channel_id: "onboarding-context", sender_type: "system", content: "Owner facts: Ada" });
    await h.host.start(request({ wakeMessage: context }));
    await until(() => h.inputs.length > 0, "first input");
    assert.ok(h.inputs[0]!.startsWith("Owner facts: Ada\n\n"), h.inputs[0]);
    assert.ok(h.inputs[0]!.endsWith(String(NATIVE_STANDING_PROMPT_STARTUP_INPUT)), "a cold start, not a wake");
    // Written once per session: the next input does not repeat it.
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    await h.host.deliverMessage("agent-1", message("m-3"));
    await until(() => h.inputs.length === 2, "second input");
    assert.ok(!h.inputs[1]!.includes("Owner facts"));
  } finally {
    await h.cleanup();
  }
});

test("View Context hears of each session, and of the sends its launch's proxy reports", async () => {
  const sessions: Array<{ agentId: string; launchId: string | null; sessionId: string | null; enabled: boolean }> = [];
  const commits: unknown[] = [];
  let reportCommit: ((input: { messageId: string; route: "send" | "task_reply" }) => void) | undefined;
  const h = await harness({
    deps: {
      contextView: {
        sessionStarted: (agentId, session, enabled) => sessions.push({ agentId, launchId: session.launchId, sessionId: session.sessionId, enabled }),
        messageCommitted: (agentId, input) => commits.push({ agentId, ...input }),
      },
      prepareLaunch: async (ctx) => {
        reportCommit = ctx.agentCredentialProxyMessageCommitted;
        return {
          runtimeId: "grok",
          installation: { kind: "available", via: "bundled" },
          options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
          busyDelivery: "after_turn",
        };
      },
    },
  });
  try {
    await h.host.start(request());
    await until(() => sessions.length === 1, "the session reported");
    const sessionId = h.sessions[0]!.id;
    assert.deepEqual(sessions, [{ agentId: "agent-1", launchId: "launch-1", sessionId, enabled: false }]);

    reportCommit?.({ messageId: "m-1", route: "send" });
    assert.deepEqual(commits, [{ agentId: "agent-1", messageId: "m-1", route: "send" }]);

    // The gate follows the newest answer, not the launch's config: a rebind never turns it back.
    h.host.applyServerFeatures({ agentContextView: true });
    await h.host.start(request({ launchId: "launch-2" }));
    assert.deepEqual(sessions.at(-1), { agentId: "agent-1", launchId: "launch-2", sessionId, enabled: true });
    h.host.applyServerFeatures({ agentContextView: false });
    await h.host.start(request({ launchId: "launch-3", config: makeConfig({ agentContextView: true }) }));
    assert.deepEqual(sessions.at(-1), { agentId: "agent-1", launchId: "launch-3", sessionId, enabled: false });
  } finally {
    await h.cleanup();
  }
});

test("supports(): every case it cannot run is named", async () => {
  const h = await harness();
  try {
    assert.deepEqual(h.host.supports(request()), { ok: true });
    assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtime: "claude" }) })), { ok: false, reason: "runtime_not_hosted:claude" });
    assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtimeProfileControl: { kind: "daemon_release_notice", key: "k", message: "m" } as never }) })), { ok: false, reason: "runtime_profile_control" });
    assert.deepEqual(h.host.supports(request({ recoveryGrant: { grantId: "g" } as never })), { ok: false, reason: "recovery_grant" });
  } finally {
    await h.cleanup();
  }
  const windows = await harness({ deps: { platform: "win32" } });
  try {
    assert.deepEqual(windows.host.supports(request()), { ok: false, reason: "platform_unsupported" });
    assert.deepEqual(windows.host.supports(request({ config: makeConfig({ runtime: "qwen" }) })), { ok: false, reason: "platform_unsupported" });
    assert.deepEqual(windows.host.supports(request({ config: makeConfig({ runtime: "cursor" }) })), { ok: false, reason: "platform_unsupported" });
    // Codex runs here on Windows too (its launch takes the driver's Windows resolution).
    assert.deepEqual(windows.host.supports(request({ config: makeConfig({ runtime: "codex" }) })), { ok: true });
  } finally {
    await windows.cleanup();
  }
});

test("supports(): Grok runs here only as Grok Build itself at a checked version; other programs in the Grok slot keep the driver (#oar-raft:#4)", async () => {
  assert.equal(isVerifiedGrokCli("grok 1.0.77"), true);
  assert.equal(isVerifiedGrokCli("grok 1.0.70 [stable]"), true);
  assert.equal(isVerifiedGrokCli("grok 1.1.0"), true);
  for (const other of [undefined, "", "grok 1.0.62", "grok 0.9.0 (raft-acp-bridge 0.3.0)", "raft-devin-adapter 0.2.0", "aiderdesk 0.1.0", "grok"]) {
    assert.equal(isVerifiedGrokCli(other), false, String(other));
  }
  for (const version of ["raft-devin-adapter 0.2.0", "grok 1.0.62", undefined]) {
    const h = await harness({ deps: { detectedRuntimeCliVersion: () => version } });
    try {
      assert.deepEqual(h.host.supports(request()), { ok: false, reason: "grok_cli_not_verified" }, String(version));
      assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtime: "qwen" }) })), { ok: true }, "an OAR-only runtime is not asked");
    } finally {
      await h.cleanup();
    }
  }
});

test("supports(): an OAR-only runtime runs here what the legacy host would have taken", async () => {
  const h = await harness();
  try {
    for (const runtime of ["qwen", "qoder"]) {
      assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtime }) })), { ok: true });
      assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtime, runtimeProfileControl: { kind: "daemon_release_notice", key: "k", message: "m" } as never }) })), { ok: true });
      assert.deepEqual(h.host.supports(request({ config: makeConfig({ runtime }), recoveryGrant: { grantId: "g" } as never })), { ok: true });
    }
  } finally {
    await h.cleanup();
  }
});

test("an OAR-only start spends its recovery grant at this host's gate, and a refusal carries the gate's decision", async () => {
  const grants: unknown[] = [];
  const refused = await harness({
    deps: {
      gate: {
        openProcess: () => true,
        processExitedLocally: () => {},
        processNotStarted: () => {},
        startRefusal: (_agentId, _launchId, grant) => { grants.push(grant); return { reason: "terminal_failure_needs_manual", detail: "needs a manual start" }; },
        waitForCapability: () => ({ confirmed: Promise.resolve(true), cancel: () => {} }),
      },
    },
  });
  try {
    const grant = { grantId: "g-1", launchId: "launch-1" } as never;
    const outcome = await refused.host.start(request({ config: makeConfig({ runtime: "qwen" }), recoveryGrant: grant }));
    assert.equal(outcome.kind, "fallback");
    assert.deepEqual(outcome.kind === "fallback" && outcome.refusal, { reason: "terminal_failure_needs_manual", detail: "needs a manual start" });
    assert.deepEqual(grants, [grant]);
    // Grok keeps the legacy host's rule: its grant is the legacy gate's to spend.
    grants.length = 0;
    await refused.host.start(request({ recoveryGrant: grant }));
    assert.deepEqual(grants, [null]);
  } finally {
    await refused.cleanup();
  }
});

test("an OAR-only launch error travels with the hand-back as its cause", async () => {
  const missing = new Error("qwen ENOENT");
  const failing = await harness({ openSession: async () => { throw missing; } });
  try {
    const outcome = await failing.host.start(request({ config: makeConfig({ runtime: "qwen" }) }));
    assert.equal(outcome.kind === "fallback" && outcome.cause, missing);
  } finally {
    await failing.cleanup();
  }
});

test("a resumed session whose standing prompt changed gets the current one in its first input (task #13)", async () => {
  const h = await harness();
  try {
    const ledgerDir = path.join(h.dataDir, "agent-1", ".raft");
    await import("node:fs/promises").then((fs) => fs.mkdir(ledgerDir, { recursive: true }));
    await writeFile(path.join(ledgerDir, "standing-prompt.json"), JSON.stringify({ version: 1, sessionId: "grok-session-1", promptHash: "old", recordedAtMs: 0 }));
    await h.host.start(request({ config: makeConfig({ sessionId: "grok-session-1" }) }));
    await until(() => h.inputs.length > 0, "first input");
    assert.match(h.inputs[0]!, /^<raft-standing-prompt-update>/);
    assert.equal(h.opened[0]!.options.resume, "grok-session-1");
  } finally {
    await h.cleanup();
  }
});

test("the idle hook fires once a turn ends with nothing held, not while a held delivery opens the next turn", async () => {
  const idleEdges: string[] = [];
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await gate.promise;
      turn.say("done");
    },
    deps: { onAgentWorkingToIdle: (agentId) => { idleEdges.push(agentId); } },
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held"), { deliveryId: "d-held" }), true);
    gate.resolve();
    await until(() => h.inputs.length === 2, "the held delivery's own turn");
    await until(() => idleEdges.length === 1, "the idle edge after the delivery's turn");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(idleEdges, ["agent-1"], "the first turn ended with a delivery held: no edge for it");

    assert.equal(await h.host.deliverMessage("agent-1", message("m-idle"), { deliveryId: "d-idle" }), true);
    await until(() => h.inputs.length === 3, "an idle delivery's turn");
    await until(() => idleEdges.length === 2, "its idle edge");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(idleEdges, ["agent-1", "agent-1"], "one edge per turn that ends with nothing held");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("idle task reminder: facts of the committed session, and a notice written only into an idle session", async () => {
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 2) await gate.promise;
      turn.say("done");
    },
  });
  try {
    assert.equal(h.host.idleNoticeFacts("agent-1"), null, "nothing runs it yet");
    assert.equal(await h.host.deliverIdleNotice("agent-1", "NOTICE"), "not_running");
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    const facts = h.host.idleNoticeFacts("agent-1");
    assert.deepEqual(facts, {
      sessionId: h.sessions[0]!.id,
      launchId: "launch-1",
      resumed: false,
      backgroundTasks: 0,
      blocked: false,
      deliveriesPending: false,
    }, "a cold start runs a new session");

    const written = h.host.deliverIdleNotice("agent-1", "[Raft task notice: …]");
    await until(() => h.inputs.length === 2, "the notice's turn");
    assert.equal(h.inputs[1], "[Raft task notice: …]", "handed over as it is");
    assert.equal(await h.host.deliverIdleNotice("agent-1", "SECOND"), "busy", "never into a running turn");
    gate.resolve();
    assert.equal(await written, "written");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.inputs.includes("SECOND"), false, "a busy notice is not kept");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("a launch's first-input readiness holds the first input until it settles, and is traced", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let signalSeen: AbortSignal | null = null;
  const h = await harness({
    deps: {
      prepareLaunch: async (ctx) => ({
        runtimeId: "grok",
        installation: { kind: "available", via: "bundled" },
        options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
        busyDelivery: "after_turn",
        firstInputReady: async (_session, signal) => {
          signalSeen = signal;
          await released;
          return { waitedFor: "managed_mcp", outcome: "failed", waitedMs: 7 };
        },
      }),
    },
  });
  try {
    const started = h.host.start(request());
    await until(() => signalSeen !== null, "readiness wait started");
    assert.deepEqual(h.inputs, [], "no first input while it waits");
    release();
    assert.deepEqual(await started, { kind: "started" });
    await until(() => h.inputs.length === 1, "first input after the wait");
    // A failed readiness still lets the turn run (as the driver does), and says so.
    const ready = h.events.find((event) => event.name === "daemon.agent.oar.first_input_ready");
    assert.deepEqual(ready?.attrs, { agentId: "agent-1", launchId: "launch-1", runtime: "grok", waited_for: "managed_mcp", outcome: "failed", waited_ms: 7 });
  } finally {
    await h.cleanup();
  }
});

test("a stop during the first-input readiness wait ends the start without a first input", async () => {
  let disposed = 0;
  const h = await harness({
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "dispose" ? async () => { disposed += 1; await target.dispose(); } : Reflect.get(target, prop, receiver),
    }),
    deps: {
      prepareLaunch: async (ctx) => ({
        runtimeId: "grok",
        installation: { kind: "available", via: "bundled" },
        options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
        busyDelivery: "after_turn",
        firstInputReady: (_session, signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ waitedFor: "managed_mcp", outcome: "stopped", waitedMs: 1 }));
        }),
      }),
    },
  });
  try {
    const started = h.host.start(request());
    await until(() => h.sessions.length === 1, "session open");
    await h.host.stopAgent("agent-1");
    assert.deepEqual(await started, { kind: "stopped" });
    assert.deepEqual(h.inputs, []);
    await h.host.unwound("agent-1");
    assert.equal(disposed, 1, "the opened session is disposed");
    assert.deepEqual(h.notSpawned, [{ launchId: "launch-1", reason: "cancelled" }]);
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

// #wg-ax:#3 D1/D2: a launch that steers (codex, qoder) into a busy turn.
const STEER_LAUNCH: OarAgentHostDeps["prepareLaunch"] = async (ctx) => ({
  runtimeId: "grok",
  installation: { kind: "available", via: "bundled" },
  options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
  busyDelivery: "now",
});

/** The session's event observer, so a test can say what the runtime reports (compaction). */
function withEventTap(taps: EventObserver[]) {
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "events"
      ? (observer: EventObserver, options?: EventsOptions) => { taps.push(observer); return target.events(observer, options); }
      : Reflect.get(target, prop, receiver),
  });
}

const reported = (session: Session, body: Record<string, unknown>): Event => ({ sessionId: session.id, agentPath: [], seq: 1_000_000, receivedAt: Date.now(), ...body }) as unknown as Event;

test("a delivery into a compacting turn is held, then steered when the compaction ends", async () => {
  const gate = deferred();
  const taps: EventObserver[] = [];
  let turns = 0;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
    wrapSession: withEventTap(taps),
    deps: { prepareLaunch: STEER_LAUNCH },
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "first turn running");
    for (const tap of taps) tap(reported(h.sessions[0]!, { kind: "compaction_started" }));
    assert.equal(await h.host.deliverMessage("agent-1", message("m-compacting"), { deliveryId: "d-c" }), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_while_compacting"), "held while compacting");
    for (const tap of taps) tap(reported(h.sessions[0]!, { kind: "compaction_ended", outcome: "completed" }));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "steered"), "steered after the compaction");
    gate.resolve();
    await until(() => h.steered().length === 1, "the turn took the steer");
    assert.match(h.steered()[0]!, /m-compacting|Inbox/);
    assert.equal(h.inputs.length, 1, "no turn of its own: it went into the running turn");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("a steer the runtime refused is held and tried again at the next tool start, not refused", async () => {
  const toolGate = deferred();
  const endGate = deferred();
  let refusals = 1;
  let terminal = 0;
  const h = await harness({
    turn: async (turn) => {
      if (turn.input.includes("m-refused")) { turn.say("own turn"); return; }
      await toolGate.promise;
      await turn.tool("Bash", JSON.stringify({ command: "ls" }));
      await endGate.promise;
      turn.say("done");
    },
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          if (refusals > 0) { refusals -= 1; return { landed: "rejected", code: "runtime_refused", reason: "not_steerable: in review" }; }
          return target.deliver(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
    deps: { prepareLaunch: STEER_LAUNCH },
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-refused"), {
      deliveryId: "d-r",
      mentionDelivery: MENTION,
      onMentionTerminalError: () => { terminal += 1; },
    }), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "runtime_refused"), "the refused steer");
    toolGate.resolve();
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "steered"), "steered at the tool start");
    endGate.resolve();
    await until(() => h.steered().length === 1, "the turn took the steer");
    assert.equal(terminal, 0, "the mention was never answered as rejected");
    assert.equal(h.inputs.length, 1, "it went into the running turn, once");
  } finally {
    toolGate.resolve();
    endGate.resolve();
    await h.cleanup();
  }
});

/** Prompts numbered from 1 (the first input is 1); `refuse` names the ones the runtime refuses. */
function refusingPrompts(control: { refuse: (n: number) => boolean; prompts: number; code?: "runtime_refused" | "session_not_found" }) {
  return (session: Session) => new Proxy(session, {
    get: (target, prop, receiver) => prop === "prompt"
      ? async (...args: Parameters<Session["prompt"]>) => {
        control.prompts += 1;
        if (control.refuse(control.prompts)) {
          return { kind: "rejected", code: control.code ?? "runtime_refused", reason: "codex turn/start failed: thread not loaded", seq: 0, requestId: `r-${control.prompts}` };
        }
        return target.prompt(...args);
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("an idle prompt the runtime refuses starts the agent again on its session once; the held message goes in once and is never handed back", async () => {
  const control = { refuse: (n: number) => n === 2, prompts: 0 };
  let terminal = 0;
  const h = await harness({ wrapSession: refusingPrompts(control) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01"), {
      deliveryId: "d-r",
      mentionDelivery: MENTION,
      onMentionTerminalError: () => { terminal += 1; },
    }), true);
    await until(() => h.inputs.some((input) => input.includes("m-rfsd01")), "delivered on the restarted session");
    assert.equal(h.inputs.filter((input) => input.includes("m-rfsd01")).length, 1, "once");
    assert.equal(terminal, 0, "the mention was never answered as rejected");
    assert.equal(h.opened.length, 2, "one start again");
    const recovery = h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery");
    assert.deepEqual(recovery.map((event) => event.attrs.action), ["reopen"]);
    assert.equal(typeof recovery[0]!.attrs.refusal_fingerprint, "string");
    assert.ok(!Object.values(recovery[0]!.attrs).some((value) => String(value).includes("thread not loaded")), "never the reason's text");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.restart_scheduled" && event.attrs.cause === "prompt_refused"));
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.spawnFailure).length, 0, "no failed start");
  } finally {
    await h.cleanup();
  }
});

test("OAR 0.97 session_not_found on an idle prompt starts the agent again on its session once; the held message goes in once (#726)", async () => {
  const control = { refuse: (n: number) => n === 2, prompts: 0, code: "session_not_found" as const };
  let terminal = 0;
  const h = await harness({ wrapSession: refusingPrompts(control) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-snf01"), {
      deliveryId: "d-snf",
      mentionDelivery: MENTION,
      onMentionTerminalError: () => { terminal += 1; },
    }), true);
    await until(() => h.inputs.some((input) => input.includes("m-snf01")), "delivered on the restarted session");
    assert.equal(h.inputs.filter((input) => input.includes("m-snf01")).length, 1, "once");
    assert.equal(terminal, 0, "never answered as rejected");
    assert.equal(h.opened.length, 2, "one start again");
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").map((event) => event.attrs.action), ["reopen"]);
  } finally {
    await h.cleanup();
  }
});

test("a refusal again on the restarted session, before it took any later prompt, hands the agent to the server as a failed start", async () => {
  // 1: first input; 2: refused (restart); 3: the restart's first input, taken; 4: refused again.
  const control = { refuse: (n: number) => n === 2 || n >= 4, prompts: 0 };
  const h = await harness({ wrapSession: refusingPrompts(control) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.inputs.some((input) => input.includes("m-rfsd01")), "the restart's first input");
    await until(() => h.framesOf("agent:runtime:outcome").length > 1, "its turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd02")), true);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.spawnFailure), "the failed start");
    const failure = h.framesOf("agent:activity").find((frame) => frame.spawnFailure)!;
    assert.match(String(failure.detail), /refused new messages again right after Raft restarted its session/);
    assert.match(String(failure.detail), /messages sent to it stay unread until it starts/);
    assert.doesNotMatch(String(failure.detail), /thread not loaded|runtime_refused/, "never the runtime's text or a code");
    assert.deepEqual(
      h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").map((event) => event.attrs.action),
      ["reopen", "hand_to_server"],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(control.prompts, 4, "no prompt after the hand-over");
    assert.equal(h.opened.length, 2, "no third session");
  } finally {
    await h.cleanup();
  }
});

test("a restart whose first input is refused too shows the agent stopped and offers nothing again", async () => {
  const control = { refuse: (n: number) => n >= 2, prompts: 0 };
  const h = await harness({ wrapSession: refusingPrompts(control) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.exit_restart_failed" && event.attrs.cause === "prompt_refused"), "the failed restart");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(control.prompts, 3, "the refused prompt and the restart's first input, then nothing");
    assert.equal(h.host.owns("agent-1"), false, "nothing runs it; the server's next start picks the host");
    const stopped = h.framesOf("agent:activity").find((frame) => /refused new messages and could not be started again/.test(String(frame.detail)));
    assert.ok(stopped);
    assert.doesNotMatch(String(stopped.detail), /first_input_rejected|runtime_refused/, "no internal code for the owner");
    assert.match(String(stopped.detail), /Restart \/ Reset/);
  } finally {
    await h.cleanup();
  }
});

test("a server that counts sticky reasons gets the hand-over as runtime_repeated_failure", async () => {
  const control = { refuse: (n: number) => n === 2 || n >= 4, prompts: 0 };
  const h = await harness({ wrapSession: refusingPrompts(control) });
  h.host.setServerStickyFailureReasonsCapable(true);
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.framesOf("agent:runtime:outcome").length > 1, "the restart's turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd02")), true);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.spawnFailure), "the failed start");
    const failure = h.framesOf("agent:activity").find((frame) => frame.spawnFailure)!;
    assert.equal(failure.spawnFailure?.reason, "runtime_repeated_failure");
  } finally {
    await h.cleanup();
  }
});

test("a delivery that arrives while the refused session is being started again goes in once, after its first input", async () => {
  const control = { refuse: (n: number) => n === 2, prompts: 0 };
  const secondOpen = deferred();
  const h = await harness({ wrapSession: refusingPrompts(control), openGate: (n) => (n === 2 ? secondOpen.promise : undefined) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.restart_scheduled" && event.attrs.cause === "prompt_refused"), "the restart");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd02")), true);
    secondOpen.resolve();
    await until(() => ["m-rfsd01", "m-rfsd02"].every((id) => h.inputs.some((input) => input.includes(id))), "both delivered");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const id of ["m-rfsd01", "m-rfsd02"]) assert.equal(h.inputs.filter((input) => input.includes(id)).length, 1, `${id} once`);
    assert.equal(h.opened.length, 2);
  } finally {
    secondOpen.resolve();
    await h.cleanup();
  }
});

test("a stop while the refused session is being started again ends it; nothing is offered again", async () => {
  const control = { refuse: (n: number) => n === 2, prompts: 0 };
  const secondOpen = deferred();
  const h = await harness({ wrapSession: refusingPrompts(control), openGate: (n) => (n === 2 ? secondOpen.promise : undefined) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.restart_scheduled" && event.attrs.cause === "prompt_refused"), "the restart");
    const stopped = h.host.stopAgent("agent-1", { wait: true });
    secondOpen.resolve();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(control.prompts, 2, "no prompt after the stop");
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(h.inputs.filter((input) => input.includes("m-rfsd01")).length, 0, "never delivered on a session that the stop ended");
  } finally {
    secondOpen.resolve();
    await h.cleanup();
  }
});

/** A steering launch's idle deliveries (`session.deliver`, codex's path) numbered from 1; `refuse` names the ones the runtime refuses. */
function refusingIdleDelivers(control: { refuse: (n: number) => boolean; delivers: number }) {
  return (session: Session) => new Proxy(session, {
    get: (target, prop, receiver) => prop === "deliver"
      ? async (...args: Parameters<Session["deliver"]>) => {
        if (target.status().value.kind === "idle") {
          control.delivers += 1;
          if (control.refuse(control.delivers)) return { landed: "rejected", code: "runtime_refused", reason: "codex turn/start failed: thread not loaded" };
        }
        return target.deliver(...args);
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("on a steering launch (codex), an idle delivery the runtime refuses starts the agent again once; the message goes in once", async () => {
  const control = { refuse: (n: number) => n === 1, delivers: 0 };
  const h = await harness({ wrapSession: refusingIdleDelivers(control), deps: { prepareLaunch: STEER_LAUNCH } });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfst01")), true);
    await until(() => h.inputs.some((input) => input.includes("m-rfst01")), "delivered on the restarted session");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.inputs.filter((input) => input.includes("m-rfst01")).length, 1, "once");
    assert.equal(h.opened.length, 2, "one start again");
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").map((event) => event.attrs.action), ["reopen"]);
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.spawnFailure).length, 0, "no failed start");
  } finally {
    await h.cleanup();
  }
});

test("a steer taken into a running turn does not end the refusal streak: the next idle refusal hands the agent to the server", async () => {
  const gate = deferred();
  const control = { refuse: () => true, delivers: 0 };
  const h = await harness({
    turn: async (turn) => { if (turn.input.includes("m-rfst01")) await gate.promise; turn.say("done"); },
    wrapSession: refusingIdleDelivers(control),
    deps: { prepareLaunch: STEER_LAUNCH },
  });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    // Refused while idle: the session starts again, its first input runs the held message and waits.
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfst01")), true);
    await until(() => h.inputs.some((input) => input.includes("m-rfst01")), "the restart's first input running");
    // Taken into the running turn: not a new turn.
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfst02")), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "steered"), "steered");
    gate.resolve();
    await until(() => h.framesOf("agent:runtime:outcome").length > 1, "the restart's turn ended");
    // Refused while idle again: no second reopen.
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfst03")), true);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.spawnFailure), "the failed start");
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").map((event) => event.attrs.action), ["reopen", "hand_to_server"]);
    assert.equal(h.opened.length, 2, "no third session");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("a person's stop resets the refusal streak: after a Restart, the first idle refusal reopens again", async () => {
  const control = { refuse: (n: number) => n === 2 || n === 5, prompts: 0 };
  const h = await harness({ wrapSession: refusingPrompts(control) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd01")), true);
    await until(() => h.inputs.some((input) => input.includes("m-rfsd01")), "the restart's first input");
    await until(() => h.framesOf("agent:runtime:outcome").length > 1, "its turn");
    await h.host.stopAgent("agent-1", { wait: true });
    h.waiting.set("agent-1", ["launch-2"]);
    await h.host.start(request({ launchId: "launch-2" }));
    await until(() => h.framesOf("agent:runtime:outcome").length > 2, "the Restart's first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-rfsd02")), true);
    await until(() => h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").length === 2, "the second refusal");
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.oar.prompt_refused_recovery").map((event) => event.attrs.action), ["reopen", "reopen"]);
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.spawnFailure).length, 0, "no failed start");
  } finally {
    await h.cleanup();
  }
});

test("after a turn's steers were refused STEER_REFUSALS_PER_TURN times, the delivery waits for the turn end; the next turn steers again", async () => {
  const gate = deferred();
  const secondTurn = deferred();
  let turns = 0;
  let refuseSteers = true;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 2) { await secondTurn.promise; turn.say("own turn"); return; }
      if (turns > 2) { turn.say("later"); return; }
      for (let index = 0; index < 5; index += 1) await turn.tool("Bash", JSON.stringify({ command: `step ${index}` }), () => (index === 0 ? gate.promise : undefined));
      turn.say("done");
    },
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => (refuseSteers && target.status().value.kind !== "idle"
          ? { landed: "rejected", code: "runtime_refused", reason: "not_steerable" }
          : target.deliver(...args))
        : Reflect.get(target, prop, receiver),
    }),
    deps: { prepareLaunch: STEER_LAUNCH },
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-stubborn"), { deliveryId: "d-s" }), true);
    gate.resolve();
    await until(() => h.inputs.length === 2, "its own turn after the turn end");
    assert.match(h.inputs[1]!, /m-stubborn|Inbox/);
    const refused = h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "runtime_refused").length;
    assert.equal(refused, 3, "three refused steers, then it waited for the turn end");

    // The cap is per turn: in the next turn a steer goes in at once.
    refuseSteers = false;
    assert.equal(await h.host.deliverMessage("agent-1", message("m-next"), { deliveryId: "d-n" }), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "steered"), "steered into the second turn");
    secondTurn.resolve();
    await until(() => h.steered().length === 1, "the second turn took it");
    assert.equal(h.inputs.length, 2, "no third turn: it went into the second");
  } finally {
    gate.resolve();
    secondTurn.resolve();
    await h.cleanup();
  }
});

// #wg-ax:#3 A8: codex reports an expired login (and other plain failures) as `unknown`.
// Reconciler step 4a: the login is the credential's; the session is kept (it used to end).
test("a failure OAR left unknown whose text says log in keeps the session and asks for a login, as the legacy host does", async () => {
  const h = await harness({
    turn: () => { throw new Error("unexpected status 401 Unauthorized: Your access token could not be refreshed. Please log out and sign in again."); },
  });
  try {
    await h.host.start(request());
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.equal(failed?.attrs.failure, "auth");
    assert.equal(failed?.attrs.failure_from_text, true);
    assert.equal(h.framesOf("agent:status").some((frame) => frame.status === "inactive"), false);
    assert.match(h.framesOf("agent:activity").at(-1)!.detail, /log ?in|sign in/i);
    assert.equal(h.framesOf("agent:activity").at(-1)!.runtimeError?.requiredAction, "user_reauth");
    assert.deepEqual(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "terminal_failure"), []);
    assert.equal(h.framesOf("agent:process_exited").length, 0);
    assert.equal(h.host.owns("agent-1"), true, "the session keeps running");
  } finally {
    await h.cleanup();
  }
});

test("a failure OAR left unknown whose text says nothing terminal stays a failed turn", async () => {
  const h = await harness({ turn: () => { throw new Error("the model stopped unexpectedly"); } });
  try {
    await h.host.start(request());
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.turn_failed"), "the failed turn");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.equal(failed?.attrs.failure, "unknown");
    assert.equal(failed?.attrs.failure_from_text, undefined);
    assert.equal(h.host.owns("agent-1"), true, "the session keeps running");
  } finally {
    await h.cleanup();
  }
});

test("a failure OAR left unknown whose text says the plan lacks the model keeps the session with the plan-access message, invalid for that model only, no E1", async () => {
  const ledger = new ProviderLimitLedger();
  const h = await harness({
    turn: () => { throw new Error("HTTP 403: Your plan does not include the model gpt-5-pro"); },
    deps: { providerLimits: ledger },
  });
  try {
    await h.host.start(request({ config: makeConfig({ model: "gpt-5-pro" }) }));
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.equal(failed?.attrs.required_action, "user_model_access");
    assert.equal(h.framesOf("agent:status").some((frame) => frame.status === "inactive"), false);
    assert.match(h.framesOf("agent:activity").at(-1)!.detail, /does not include access to the configured model \(gpt-5-pro\)/);
    assert.deepEqual(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "terminal_failure"), [], "action required: nothing counts toward the wake breaker");
    assert.equal(h.host.owns("agent-1"), true);
    const key = providerLimitCredentialKey("agent-1", makeConfig({ model: "gpt-5-pro" }));
    assert.equal(ledger.invalidFor(key, "gpt-5-pro")?.invalidReason, "user_model_access");
    assert.equal(ledger.invalidFor(key, "grok-4"), undefined, "another model on the same credential is not held");
  } finally {
    await h.cleanup();
  }
});

test("a failure OAR left unknown whose text is a billing rejection is billing: the session is kept, no E1", async () => {
  const h = await harness({ turn: () => { throw new Error("Your credit balance is too low to access the API"); } });
  try {
    await h.host.start(request());
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.equal(failed?.attrs.failure, "billing");
    assert.equal(failed?.attrs.failure_from_text, true);
    assert.deepEqual(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "terminal_failure"), []);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("OAR's own failure class is never overridden by the text", async () => {
  // OAR says billing; the text alone would say log in.
  const h = await harness({
    turn: () => { throw new Error("401 Unauthorized: please log in"); },
    wrapSession: (session) => withFailure(session, "billing"),
  });
  try {
    await h.host.start(request());
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.turn_failed"), "the failed turn");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.equal(failed?.attrs.failure, "billing");
    assert.equal(failed?.attrs.failure_from_text, undefined);
  } finally {
    await h.cleanup();
  }
});

// #proj-raft-computer:#46 (reconciler step 3b, design row C6): a provider
// limit an OAR turn hits belongs to the credential, in the ledger both hosts
// share. It holds the agent's deliveries (and every agent's on the same
// shared sign-in, on either host) until it ends or is released; the session
// is not ended.

/** Own credential home: the limit is the agent's alone (`agent:<id>`). */
const codexOwnHome = () => codexShared({ envVars: { CODEX_HOME: "/srv/codex-own" } });
const heldForLimit = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_for_provider_limit");

test("C6: a quota failed turn holds the next delivery until the wait ends, then delivers it; the session is not ended", async () => {
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: ["agent-1"] });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the provider limit recorded");
    const recorded = limitEvents(h, "agent-1")[0]!.attrs;
    assert.equal(recorded.provider_limit_kind, "quota_exhausted");
    assert.equal(recorded.provider_limit_source, "structured");
    assert.equal(recorded.credential_key_kind, "shared");
    assert.equal(recorded.host, "oar");
    assert.equal(recorded.delay_ms, 300, "no reported reset: the legacy host's exponential backoff");
    assert.equal(ledger.get("shared:codex", Date.now())?.providerLimitKind, "quota_exhausted");

    assert.equal(await h.host.deliverMessage("agent-1", message("m-held")), true, "custody: acked while held");
    await sleep(100);
    assert.equal(turnInputs.get("agent-1")?.length, 1, "no turn while the limit runs");
    assert.ok(heldForLimit(h).length > 0);
    assert.equal(h.host.owns("agent-1"), true, "the session keeps running");
    assert.deepEqual(h.framesOf("agent:process_exited"), []);

    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 2, "the held delivery's turn once the wait ended");
    assert.equal(turnInputs.get("agent-1")![1], String(formatInboxUpdateRuntimeInput([message("m-held")], getDriver("codex"), 1)));
    // Its model output, from a turn started after the limit, ends the limit for the sign-in.
    await until(() => !ledger.has("shared:codex"), "the limit released by model output");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.release_cause === "model_output" && event.attrs.host === "oar"));
  } finally {
    await h.cleanup();
  }
});

test("C6: overloaded and rate_limited are a transient rate limit with the short backoff; a quota waits for its reported reset", async () => {
  for (const failure of ["overloaded", "rate_limited"] as const) {
    const { h, ledger } = await limitHarness(failure, { backoff: { jitterRatio: 0 } });
    try {
      await h.host.start(startRequest("agent-1", codexShared()));
      await until(() => limitEvents(h, "agent-1").length > 0, `${failure} recorded`);
      const recorded = limitEvents(h, "agent-1")[0]!.attrs;
      assert.equal(recorded.provider_limit_kind, "transient_rate_limit", failure);
      assert.equal(recorded.delay_ms, 10_000, `${failure}: the legacy host's first backoff step`);
      const record = ledger.get("shared:codex", Date.now())!;
      assert.equal(record.untilMs - record.recordedAtMs, 10_000);
      assert.equal(h.host.owns("agent-1"), true);
    } finally {
      await h.cleanup();
    }
  }
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const { h, ledger } = await limitHarness("quota", { extra: { resetsAt }, backoff: { jitterRatio: 0 } });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "quota recorded");
    assert.equal(limitEvents(h, "agent-1")[0]!.attrs.waits_for_reported_reset, true);
    assert.equal(ledger.get("shared:codex", Date.now())?.untilMs, Date.parse(resetsAt));
  } finally {
    await h.cleanup();
  }
});

test("C6: an OAR quota on shared:codex holds the other OAR agent on it; an agent with its own CODEX_HOME is unaffected and its own limit holds only itself", async () => {
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: ["agent-1", "agent-3"], extra: { resetsAt } });
  try {
    await h.host.start(startRequest("agent-2", codexShared()));
    await h.host.start(startRequest("agent-4", codexShared()));
    await h.host.start(startRequest("agent-3", codexOwnHome()));
    await until(() => limitEvents(h, "agent-3").length > 0, "agent-3's own limit");
    assert.equal(limitEvents(h, "agent-3")[0]!.attrs.credential_key_kind, "agent");
    assert.ok(ledger.has("agent:agent-3"));
    // agent-3's own limit: agent-2 (shared sign-in) takes deliveries; agent-3 holds its own.
    await h.host.deliverMessage("agent-2", message("m-2a"));
    await h.host.deliverMessage("agent-3", message("m-3a"));
    await until(() => (turnInputs.get("agent-2")?.length ?? 0) === 2, "agent-2's delivery turn");
    await sleep(50);
    assert.equal(turnInputs.get("agent-3")?.length, 1, "agent-3 holds for its own limit");

    // agent-1 hits the shared sign-in's quota: agent-2 and agent-4 hold too; agent-3 keeps only its own limit.
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the shared limit");
    const restored = h.events.filter((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.restored" && event.attrs.restore_point === "shared_credential_limit");
    assert.deepEqual(restored.map((event) => event.attrs.agentId).sort(), ["agent-2", "agent-4"]);
    assert.ok(restored.every((event) => event.attrs.host === "oar" && event.attrs.source_host === "oar" && event.attrs.credential_key_kind === "shared"));
    await h.host.deliverMessage("agent-2", message("m-2b"));
    await sleep(100);
    assert.equal(turnInputs.get("agent-2")?.length, 2, "agent-2 holds for the shared limit");
    assert.equal(ledger.get("agent:agent-3", Date.now())?.untilMs, Date.parse(resetsAt), "agent-3's own limit is untouched");
  } finally {
    await h.cleanup();
  }
});

test("C6: a limit the legacy host records on the shared sign-in holds an OAR agent on it, and its release hands the held delivery over", async () => {
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: [] });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await h.host.start(startRequest("agent-2", codexOwnHome()));
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 1 && (turnInputs.get("agent-2")?.length ?? 0) === 1, "first turns");
    await sleep(20);
    const now = Date.now();
    ledger.record("shared:codex", { attempts: 1, reason: "rate_limited", untilMs: now + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: now }, { host: "legacy", agentId: "legacy-agent" });
    const restored = h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.restored" && event.attrs.agentId === "agent-1");
    assert.equal(restored?.attrs.source_host, "legacy");
    await h.host.deliverMessage("agent-1", message("m-1"));
    await h.host.deliverMessage("agent-2", message("m-2"));
    await until(() => (turnInputs.get("agent-2")?.length ?? 0) === 2, "the own-credential agent's delivery");
    await sleep(50);
    assert.equal(turnInputs.get("agent-1")?.length, 1, "held for the legacy agent's limit");
    // A legacy agent's model output ends the limit: the OAR agent's held delivery goes at once.
    ledger.release("shared:codex", "model_output", { host: "legacy", agentId: "legacy-agent" });
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 2, "the released delivery");
    const reset = h.events.find((event) => event.name === "daemon.agent.runtime_error_delivery_backoff.reset" && event.attrs.agentId === "agent-1");
    assert.equal(reset?.attrs.release_cause, "model_output");
    assert.equal(reset?.attrs.source_host, "legacy");
  } finally {
    await h.cleanup();
  }
});

test("C6: an OAR quota on the shared sign-in is announced to the legacy host, and an explicit stop releases it for the other agents", async () => {
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: ["agent-1"], extra: { resetsAt } });
  const changes: string[] = [];
  ledger.subscribe((change) => changes.push(`${change.kind}:${change.key}:${change.source.host}${change.kind === "released" ? `:${change.cause}` : ""}`));
  try {
    await h.host.start(startRequest("agent-2", codexShared()));
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the shared limit");
    assert.deepEqual(changes, ["recorded:shared:codex:oar"]);
    await h.host.deliverMessage("agent-2", message("m-2"));
    await sleep(50);
    assert.equal(turnInputs.get("agent-2")?.length, 1, "held");
    await h.host.stopAgent("agent-1");
    assert.deepEqual(changes, ["recorded:shared:codex:oar", "released:shared:codex:oar:explicit_stop"]);
    await until(() => (turnInputs.get("agent-2")?.length ?? 0) === 2, "agent-2's held delivery after the stop");
  } finally {
    await h.cleanup();
  }
});

test("C6: a start on a credential at its provider limit opens and reports the session; its first input is held, then handed over when the limit ends", async () => {
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: [] });
  try {
    const now = Date.now();
    ledger.record("shared:codex", { attempts: 1, reason: "rate_limited", untilMs: now + 400, providerLimitKind: "transient_rate_limit", recordedAtMs: now }, { host: "legacy" });
    assert.equal((await h.host.start(startRequest("agent-1", codexShared()))).kind, "started", "not kept starting for the limit");
    assert.equal(h.host.getAgentStartAcceptance("agent-1").queueState, "running");
    assert.equal(h.framesOf("agent:process_spawned").length, 1);
    assert.equal(h.framesOf("agent:runtime:ready").length, 1);
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "held_for_provider_limit"));
    await h.host.deliverMessage("agent-1", message("m-later"));
    await sleep(100);
    assert.equal(turnInputs.get("agent-1"), undefined, "no turn while the limit runs");
    await until(() => turnInputs.get("agent-1")?.length === 2, "the first input, then the later delivery, once the limit ended");
    assert.equal(turnInputs.get("agent-1")![1], String(formatInboxUpdateRuntimeInput([message("m-later")], getDriver("codex"), 1)));
  } finally {
    await h.cleanup();
  }
});

test("C6: a held first input goes at once when the limit is released", async () => {
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: [] });
  try {
    const now = Date.now();
    ledger.record("shared:codex", { attempts: 1, reason: "rate_limited", untilMs: now + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: now }, { host: "legacy" });
    await h.host.start(startRequest("agent-1", codexShared()));
    await sleep(50);
    assert.equal(turnInputs.get("agent-1"), undefined);
    ledger.release("shared:codex", "credentials_changed", { host: "legacy" });
    await until(() => turnInputs.get("agent-1")?.length === 1, "the first input after the release");
    assert.equal(h.framesOf("agent:process_spawned").length, 1, "the session was reported while the first input was held");
  } finally {
    await h.cleanup();
  }
});

test("C6: a shorter limit never cuts a longer one on the same credential: the record keeps the quota reset and held agents keep waiting", async () => {
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const { h, ledger, turnInputs } = await limitHarness("quota", { failing: ["agent-1"], extra: { resetsAt } });
  try {
    await h.host.start(startRequest("agent-2", codexShared()));
    await until(() => turnInputs.get("agent-2")?.length === 1, "agent-2's first turn");
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the quota");
    const now = Date.now();
    // Another agent on the sign-in hits a transient throttle, ending well before the reset.
    const stored = ledger.record("shared:codex", { attempts: 3, reason: "rate_limited", untilMs: now + 200, providerLimitKind: "transient_rate_limit", recordedAtMs: now }, { host: "legacy", agentId: "legacy-agent" });
    assert.equal(stored.untilMs, Date.parse(resetsAt));
    assert.equal(stored.providerLimitKind, "quota_exhausted");
    assert.equal(stored.resetsAt, resetsAt);
    assert.equal(stored.attempts, 3, "the larger attempts");
    assert.equal(stored.recordedAtMs, now, "the latest hit");
    assert.deepEqual(ledger.get("shared:codex", Date.now()), stored);
    await h.host.deliverMessage("agent-2", message("m-2"));
    await sleep(400);
    assert.equal(turnInputs.get("agent-2")?.length, 1, "still held past the throttle's end");
  } finally {
    await h.cleanup();
  }
});

test("oarFailureProviderLimit: quota, rate_limited, overloaded and an unknown failure's usage-limit text, nothing else", () => {
  const failed = (failure: FailureClass, extra: Record<string, unknown> = {}) => ({ kind: "failed", failure, reason: "boom", ...extra }) as FailedTurn;
  assert.deepEqual(oarFailureProviderLimit("quota", failed("quota", { resetsAt: "2026-11-05T12:00:00.000Z" })), { kind: "quota_exhausted", resetsAt: "2026-11-05T12:00:00.000Z", source: "structured" });
  assert.deepEqual(oarFailureProviderLimit("rate_limited", failed("rate_limited")), { kind: "transient_rate_limit", source: "structured" });
  assert.deepEqual(oarFailureProviderLimit("overloaded", failed("overloaded")), { kind: "transient_rate_limit", source: "structured" });
  assert.deepEqual(oarFailureProviderLimit("unknown", { kind: "failed", failure: "unknown", reason: QUOTA_TEXT }), { kind: "quota_exhausted", source: "text" });
  assert.equal(oarFailureProviderLimit("unknown", failed("unknown")), null);
  assert.equal(oarFailureProviderLimit("provider", failed("provider")), null);
  assert.equal(oarFailureProviderLimit("billing", failed("billing")), null);
});

test("every OAR launch bounds the records OAR keeps, unless the launch set its own bound", () => {
  const launch = { runtimeId: "grok", installation: { kind: "available", via: "executable", command: "/opt/grok" }, options: { cwd: "/work/agent-1" } } as never;
  assert.equal(withOarRecordRetention(launch).options.retainedBytes, OAR_RETAINED_BYTES);
  assert.equal((launch as { options: { retainedBytes?: number } }).options.retainedBytes, undefined, "the prepared launch is not mutated");
  const own = { ...(launch as object), options: { cwd: "/work/agent-1", retainedBytes: 1024 } } as never;
  assert.equal(withOarRecordRetention(own).options.retainedBytes, 1024);
});

// Reconciler step 4a follow-up (Tenny's release condition): an OAR agent held
// for an invalid credential another agent reported, on either host, shows why
// as its idle status: the reporting agent's copy plus where it came from, no
// `runtimeError` (no `requiredAction` for the server's wake block), not the
// `runtime_error` detail kind. Once per record; a release shows "Idle" again.
const HELD_NOTE = "(Reported by another agent on the same sign-in.)";
// Notices shown, not re-stated: a probe reply repeats the current one.
const heldNotices = (h: Harness, agentId: string) => h.framesOf("agent:activity")
  .filter((frame) => frame.agentId === agentId && frame.detail.includes(HELD_NOTE) && !frame.probeId);
const noticeEvents = (h: Harness, agentId: string) => h.events
  .filter((event) => event.name === "daemon.agent.credential_invalid.notice" && event.attrs.agentId === agentId);

function assertHeldNoticeFrame(frame: { detail: string; detailKind?: string; runtimeError?: unknown; credentialHold?: unknown } | undefined, copy: RegExp, reason: string): void {
  assert.ok(frame, "a held notice");
  assert.match(frame.detail, copy);
  assert.ok(frame.detail.endsWith(HELD_NOTE));
  assert.equal(frame.detailKind, "idle", "not runtime_error: the server would store it as the agent's runtime error");
  assert.equal(frame.runtimeError, undefined, "no requiredAction (or AuthError class) for the server's wake block");
  // Step 4b: the reason rides typed, so the web never reads the text.
  assert.deepEqual(frame.credentialHold, { reason }, "the held notice carries its reason typed");
}

test("4a: an OAR auth failure on shared:codex shows the held notice on the other OAR agent on it, once, without requiredAction; an own-CODEX_HOME agent shows nothing", async () => {
  const { h, ledger, turnInputs } = await limitHarness("auth", { failing: ["agent-1"] });
  try {
    await h.host.start(startRequest("agent-2", codexShared()));
    await h.host.start(startRequest("agent-3", codexOwnHome()));
    await until(() => (turnInputs.get("agent-2")?.length ?? 0) === 1 && (turnInputs.get("agent-3")?.length ?? 0) === 1, "first turns");
    const lastFrame = (agentId: string) => h.framesOf("agent:activity").filter((frame) => frame.agentId === agentId).at(-1);
    await until(() => lastFrame("agent-2")?.detailKind === "idle" && lastFrame("agent-3")?.detailKind === "idle", "idle");
    const ownFrames = h.framesOf("agent:activity").filter((frame) => frame.agentId === "agent-3").length;

    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => h.events.some((event) => event.name === "daemon.agent.credential_invalid.recorded"), "the invalid credential");
    assert.equal(lastFrame("agent-1")?.detailKind, "runtime_error", "the reporting agent shows its own error");
    assert.equal(heldNotices(h, "agent-1").length, 0);
    assert.equal(heldNotices(h, "agent-2").length, 1);
    assertHeldNoticeFrame(heldNotices(h, "agent-2")[0], /not logged in/, "user_reauth");
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.agentId === "agent-3").length, ownFrames, "agent-3 is on its own credential");
    assert.deepEqual(noticeEvents(h, "agent-2").map((event) => event.attrs), [{
      agentId: "agent-2", runtime: "codex", launchId: "launch-agent-2", notice: "shown", visible: true, trigger: "recorded",
      credential_invalid_reason: "user_reauth", credential_key_kind: "shared", host: "oar",
    }]);

    // The same rejection recorded again: no second notice.
    ledger.recordInvalid("shared:codex", { invalidReason: "user_reauth", recordedAtMs: Date.now() }, { host: "legacy", agentId: "legacy-agent" });
    assert.equal(heldNotices(h, "agent-2").length, 1);
    assert.equal(noticeEvents(h, "agent-2").length, 1);

    // Step 4b: a probe reply re-states the held notice with its reason; the
    // reporting agent never carries one.
    h.host.respondToActivityProbe("agent-2", "probe-held");
    const probed = lastFrame("agent-2");
    assert.equal(probed?.probeId, "probe-held");
    assert.deepEqual(probed?.credentialHold, { reason: "user_reauth" });
    assert.ok(!h.framesOf("agent:activity").some((frame) => frame.agentId === "agent-1" && frame.credentialHold), "the reporting agent shows its own error");
  } finally {
    await h.cleanup();
  }
});

test("4a: an invalid credential the legacy host records shows the held notice on an OAR agent on the sign-in, and on one started while it holds; its release shows them Idle", async () => {
  const { h, ledger, turnInputs } = await limitHarness("auth", { failing: [] });
  try {
    await h.host.start(startRequest("agent-1", codexShared({ model: "gpt-x" })));
    await until(() => (turnInputs.get("agent-1")?.length ?? 0) === 1, "first turn");
    await until(() => h.framesOf("agent:activity").filter((frame) => frame.agentId === "agent-1").at(-1)?.detailKind === "idle", "idle");

    ledger.recordInvalid("shared:codex", { invalidReason: "user_model_access", model: "gpt-x", recordedAtMs: Date.now() }, { host: "legacy", agentId: "legacy-agent" });
    assert.equal(heldNotices(h, "agent-1").length, 1);
    assertHeldNoticeFrame(heldNotices(h, "agent-1")[0], /does not include access to the configured model \(gpt-x\)/, "user_model_access");

    // Started while the record holds it: its first input is held, and its idle status says why.
    await h.host.start(startRequest("agent-2", codexShared({ model: "gpt-x" })));
    await until(() => heldNotices(h, "agent-2").length > 0, "agent-2's held notice");
    assertHeldNoticeFrame(heldNotices(h, "agent-2")[0], /does not include access to the configured model \(gpt-x\)/, "user_model_access");
    assert.equal(noticeEvents(h, "agent-2")[0]?.attrs.trigger, "idle");

    ledger.releaseInvalid("shared:codex", "credentials_changed", { host: "legacy" });
    const cleared = h.framesOf("agent:activity").filter((frame) => frame.agentId === "agent-1").at(-1);
    assert.equal(cleared?.detailKind, "idle");
    assert.equal(cleared?.detail, "Idle");
    assert.equal(cleared?.credentialHold, undefined, "released: the idle frame carries no reason");
    h.host.respondToActivityProbe("agent-1", "probe-released");
    const probed = h.framesOf("agent:activity").filter((frame) => frame.agentId === "agent-1").at(-1);
    assert.equal(probed?.probeId, "probe-released");
    assert.equal(probed?.credentialHold, undefined, "released: nor does a probe reply");
    assert.equal(noticeEvents(h, "agent-1").at(-1)?.attrs.notice, "cleared");
    assert.equal(noticeEvents(h, "agent-1").at(-1)?.attrs.release_cause, "credentials_changed");
    assert.equal(heldNotices(h, "agent-1").length, 1);
  } finally {
    await h.cleanup();
  }
});

// #proj-raft-computer:#48, reconciler step 4b: as on the legacy host, a
// release of the record tells the server for each OAR agent that showed it
// (its own runtime error, or the held notice), with the reason it showed and
// the release cause; the server lifts only a wake block of that reason.
test("4b: a release reports the OAR agent that showed the error and the one shown the notice; an own-CODEX_HOME agent and another host's agent are not reported here", async () => {
  const { h, ledger, turnInputs } = await limitHarness("auth", { failing: ["agent-1"] });
  try {
    await h.host.start(startRequest("agent-2", codexShared()));
    await h.host.start(startRequest("agent-3", codexOwnHome()));
    await until(() => (turnInputs.get("agent-2")?.length ?? 0) === 1 && (turnInputs.get("agent-3")?.length ?? 0) === 1, "first turns");
    const lastFrame = (agentId: string) => h.framesOf("agent:activity").filter((frame) => frame.agentId === agentId).at(-1);
    await until(() => lastFrame("agent-2")?.detailKind === "idle" && lastFrame("agent-3")?.detailKind === "idle", "idle");

    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => heldNotices(h, "agent-2").length === 1, "agent-2's held notice");
    assert.equal(lastFrame("agent-1")?.detailKind, "runtime_error", "agent-1 shows its own error (the server may block its wakes for it)");
    // The legacy host records the same rejection for one of its agents: it reports that one itself.
    ledger.recordInvalid("shared:codex", { invalidReason: "user_reauth", recordedAtMs: Date.now() }, { host: "legacy", agentId: "legacy-agent" });
    assert.deepEqual(h.framesOf("agent:credential:restored"), [], "nothing before the release");

    ledger.releaseInvalid("shared:codex", "model_output", { host: "legacy", agentId: "legacy-agent" });

    assert.deepEqual(
      h.framesOf("agent:credential:restored").sort((left, right) => left.agentId.localeCompare(right.agentId)),
      [
        { type: "agent:credential:restored", agentId: "agent-1", reason: "user_reauth", releaseCause: "model_output", launchId: "launch-agent-1" },
        { type: "agent:credential:restored", agentId: "agent-2", reason: "user_reauth", releaseCause: "model_output", launchId: "launch-agent-2" },
      ],
    );
    const reported = h.events.filter((event) => event.name === "daemon.agent.credential_invalid.restored_reported");
    assert.deepEqual(reported.map((event) => [event.attrs.agentId, event.attrs.shown_as, event.attrs.host]).sort(), [
      ["agent-1", "own_error", "oar"],
      ["agent-2", "notice", "oar"],
    ]);
  } finally {
    await h.cleanup();
  }
});

test("reconciler step 5: OAR's own kill grace is the daemon's one stop grace (10 s)", async () => {
  // OAR does not export it publicly: read the constant from the installed
  // package, so an OAR upgrade that changes it fails here.
  const signals = await readFile(new URL("../../node_modules/@botiverse/oar/dist/shared/executable/process-signals.js", import.meta.url), "utf8");
  const match = /export const KILL_GRACE_MS = ([\d_]+);/.exec(signals);
  assert.ok(match, "OAR still declares KILL_GRACE_MS");
  assert.equal(Number(match[1]!.replaceAll("_", "")), AGENT_STOP_KILL_GRACE_MS);
});

test("reconciler step 5: an OAR dispose that never finishes is traced as escalated at the grace, given up as kill_unconfirmed after the window, and the agent is released", async () => {
  const hung = (session: Session): Session => new Proxy(session, {
    get(target, property, receiver) {
      if (property === "dispose") return () => new Promise<void>(() => {});
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const h = await harness({ wrapSession: hung, deps: { stopKill: { graceMs: 30, confirmMs: 60 } } });
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-1") })), { kind: "started" });
    await until(() => h.framesOf("agent:turn:ended").length > 0, "turn ended");
    const startedAt = Date.now();
    await h.host.stopAgent("agent-1", { wait: true });

    assert.ok(Date.now() - startedAt >= 30 + 60 - 5, "the stop waited the grace and the confirmation window");
    const escalated = h.events.find((event) => event.name === "daemon.agent.stop.escalated");
    assert.equal(escalated?.attrs.path, "oar_explicit_stop");
    assert.equal(escalated?.attrs.grace_ms, 30);
    const unconfirmed = h.events.find((event) => event.name === "daemon.agent.stop.kill_unconfirmed");
    assert.equal(unconfirmed?.attrs.path, "oar_explicit_stop");
    await until(() => !h.host.isUnwinding("agent-1"), "released: a later start does not wait forever", 500);
  } finally {
    await h.cleanup();
  }
});

test("reconciler step 5: a dispose that finishes within the grace records no escalation", async () => {
  const h = await harness({ deps: { stopKill: { graceMs: 2_000, confirmMs: 60 } } });
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-1") })), { kind: "started" });
    await until(() => h.framesOf("agent:turn:ended").length > 0, "turn ended");
    await h.host.stopAgent("agent-1", { wait: true });
    assert.equal(h.events.some((event) => event.name === "daemon.agent.stop.escalated" || event.name === "daemon.agent.stop.kill_unconfirmed"), false);
  } finally {
    await h.cleanup();
  }
});

test("reconciler step 5: an OAR launch waits for the agent's stopped legacy process to exit", async () => {
  const legacyExit = deferred();
  const waitedFor: string[] = [];
  const h = await harness({
    deps: {
      legacyRuntimeExited: (agentId) => {
        waitedFor.push(agentId);
        return legacyExit.promise;
      },
    },
  });
  try {
    const started = h.host.start(request({ wakeMessage: message("m-1") }));
    await until(() => waitedFor.length === 1, "the launch asks for the legacy exit");
    await sleep(30);
    assert.equal(h.opened.length, 0, "no OAR runtime while the legacy process is still exiting");
    legacyExit.resolve();
    assert.deepEqual(await started, { kind: "started" });
    assert.equal(h.opened.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("reconciler step 5: the OAR host reports each opened session (its runtime is recorded) and each disposed one", async () => {
  const calls: string[] = [];
  const h = await harness({
    deps: {
      runtimeProcesses: {
        opened: (agentId, launchId) => calls.push(`opened:${agentId}:${launchId}`),
        closed: (agentId) => calls.push(`closed:${agentId}`),
      },
    },
  });
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-1") })), { kind: "started" });
    assert.deepEqual(calls, ["opened:agent-1:launch-1"]);
    await h.host.stopAgent("agent-1", { wait: true });
    assert.deepEqual(calls, ["opened:agent-1:launch-1", "closed:agent-1"]);
  } finally {
    await h.cleanup();
  }
});

// Reconciler step 6, row A2: server features on the OAR host. A session that
// started on other values (for a change its runtime renders) is ended once it
// is idle, the way a stop that keeps the session ends it (no status, no
// activity), and the Server's next start carries the new values. Busy, it is
// left alone until its turn end. RED proof: drop the router's hand-over or
// `applyServerFeatures` here and nothing stops; drop the turn-end call and the
// busy session survives its turn; drop the idle check and it stops mid-turn.
const featuresStops = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);

test("server features: an idle OAR session that drifted is ended, keeping its session; a change it does not render, or one undone, ends nothing", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
    await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");

    // agentContextView changes nothing in the session.
    h.host.applyServerFeatures({ agentContextView: true });
    // A change and its undo before any decision could stop it.
    h.host.applyServerFeatures({ enabledApps: [] });
    assert.equal(h.host.owns("agent-1"), true);
    assert.deepEqual(featuresStops(h), []);

    h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
    assert.deepEqual(featuresStops(h), [{
      agentId: "agent-1",
      launchId: "launch-1",
      session_id: h.sessions[0]!.id,
      drift: "features",
      changed_keys: "enabledApps",
      trigger: "signal",
      host: "oar",
    }]);
    assert.equal(h.host.owns("agent-1"), false, "the agent left the host: the next delivery asks the Server for a start");
    await h.host.unwound("agent-1");
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active"], "a stop on purpose: never reported inactive");
    assert.notEqual(h.framesOf("agent:activity").at(-1)!.detailKind, "stopped");
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.held_dropped"), false, "nothing was held");
  } finally {
    await h.cleanup();
  }
});

test("server features: a busy OAR session is ended only at its turn end, with that trigger", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.sessions[0]?.status().value.kind === "running", "the first turn running");
    h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
    await sleep(20);
    assert.equal(h.host.owns("agent-1"), true, "not under a running turn");
    assert.deepEqual(featuresStops(h), []);

    release.resolve();
    await until(() => featuresStops(h).length > 0, "the stop at the turn end");
    assert.equal(featuresStops(h)[0]!.trigger, "turn_end");
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

test("server features: an OAR session whose idle edge was missed is ended by the sweep", async () => {
  let reportRunning = false;
  const h = await harness({
    deps: { featuresSweepMs: 20 },
    wrapSession: (session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "status") {
          return () => {
            const status = target.status();
            return reportRunning ? { ...status, value: { ...status.value, kind: "running" } } : status;
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
    reportRunning = true;
    h.host.applyServerFeatures({ enabledApps: ["artifacts"] });
    await sleep(60);
    assert.equal(h.host.owns("agent-1"), true, "held while it reads as running");
    reportRunning = false;
    await until(() => featuresStops(h).length > 0, "the sweep's stop");
    assert.equal(featuresStops(h)[0]!.trigger, "sweep");
  } finally {
    await h.cleanup();
  }
});

// #wg-ax:#3 A6/A7/A10: Codex telemetry on the OAR host carries the legacy host's event names.

/** A session whose raw record observers the test can also feed frames, as OAR would from codex. */
type FrameSink = {
  emit?: (type: string, native: Record<string, unknown>, sessionId?: string) => void;
  /** Text events carry this message id, so a frame can give the message a phase. */
  textMessageId?: string;
};

function withFrames(session: Session, sink: FrameSink): Session {
  const observers: Array<(record: unknown) => void> = [];
  let seq = 1_000_000;
  sink.emit = (type, native, sessionId = session.id) => {
    seq += 1;
    for (const observer of observers) observer({ kind: "frame", sessionId, agentPath: [], seq, receivedAt: seq, body: { type, native, events: [] } });
  };
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "rawEvents") {
        return (observer: (record: unknown) => void, options?: unknown) => {
          observers.push(observer);
          return (target.rawEvents as (observer: unknown, options?: unknown) => unknown)(observer, options);
        };
      }
      if (property === "events") {
        return (observer: EventObserver, options?: EventsOptions) => target.events((event: Event) => {
          observer(event.kind === "text_delta" && sink.textMessageId ? { ...event, messageId: sink.textMessageId } : event);
        }, options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const telemetryFrame = {
  tokenUsage: { total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 4000 }, last: { totalTokens: 500 }, modelContextWindow: 1000 },
};
const gapEvents = (h: Harness) => h.events.filter((event) => event.name === "daemon.runtime.turn.communication_gap");

test("A6/A7: a Codex session's token usage and rate limits reach the legacy telemetry events, tagged with the host", async () => {
  const sink: FrameSink = {};
  const h = await harness({
    turn: (turn) => turn.say("ok"),
    wrapSession: (session) => withFrames(session, sink),
    deps: { daemonVersion: "1.0.99", computerVersion: "1.0.98" },
  });
  try {
    await h.host.start(startRequest("agent-1", codexShared({ model: "gpt-x" })));
    await until(() => h.sessions.length > 0 && sink.emit !== undefined, "the session open");
    await until(() => h.framesOf("agent:activity").length > 0, "the session subscribed");

    sink.emit!("thread/tokenUsage/updated", telemetryFrame);
    sink.emit!("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 12 } } });
    sink.emit!("thread/tokenUsage/updated", telemetryFrame, "another-thread");

    const usage = h.events.filter((event) => event.name === "daemon.runtime.telemetry.token_usage");
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.attrs.agentId, "agent-1");
    assert.equal(usage[0]!.attrs.runtime, "codex");
    assert.equal(usage[0]!.attrs.model, "gpt-x");
    assert.equal(usage[0]!.attrs.host, "oar");
    assert.equal(usage[0]!.attrs.telemetry_name, "token_usage");
    assert.equal(usage[0]!.attrs.usageKind, "cumulative_session");
    assert.equal(usage[0]!.attrs.source, "codex_thread_token_usage_updated");
    assert.equal(usage[0]!.attrs.totalTokens, 9000);
    assert.equal(usage[0]!.attrs.contextUtilization, 0.5);
    assert.equal(usage[0]!.attrs.daemon_version, "1.0.99");
    assert.equal(usage[0]!.attrs.computer_version, "1.0.98");
    assert.ok(usage[0]!.attrs.sessionId);
    const limits = h.events.filter((event) => event.name === "daemon.runtime.telemetry.rate_limits");
    assert.equal(limits.length, 1);
    assert.equal(limits[0]!.attrs.usedPercent, 12);
  } finally {
    await h.cleanup();
  }
});

// Reconciler step 7: a rebound start's config is the runtime spec the session
// should run with, decided by the same entry (reconcileSpec). RED proof: drop
// the reconcileSpec call in `rebind` and the idle session is never ended;
// drop the idle check and the busy one ends mid-turn; drop
// withoutSessionStartedOnOtherSpec and the next start resumes the old thread.
const specStops = featuresStops;

test("runtime spec: an idle OAR session rebound on another model is ended at once, keeping its session", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
    const sessionId = h.sessions[0]!.id;
    // Same spec, another description and workspace context: nothing.
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: makeConfig({ sessionId, description: "another role" }) })), { kind: "rebound" });
    assert.deepEqual(specStops(h), []);
    assert.equal(h.host.owns("agent-1"), true);

    assert.deepEqual(await h.host.start(request({ launchId: "launch-3", config: makeConfig({ sessionId, model: "grok-other" }) })), { kind: "rebound" });
    assert.deepEqual(specStops(h), [{ agentId: "agent-1", launchId: "launch-3", session_id: sessionId, drift: "model", trigger: "signal", host: "oar" }]);
    assert.equal(h.host.owns("agent-1"), false);
    await h.host.unwound("agent-1");
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    // The Server's next start resumes it: another grok model is the same session.
    assert.deepEqual(await h.host.start(request({ launchId: "launch-4", config: makeConfig({ sessionId, model: "grok-other" }) })), { kind: "started" });
    assert.equal(h.opened[1]!.options.resume, sessionId);
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.session_dropped_for_spec"), []);
  } finally {
    await h.cleanup();
  }
});

test("A6: another runtime's frames are not read as Codex telemetry", async () => {
  const sink: FrameSink = {};
  const h = await harness({ turn: (turn) => turn.say("ok"), wrapSession: (session) => withFrames(session, sink) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").length > 0 && sink.emit !== undefined, "the session subscribed");

    sink.emit!("thread/tokenUsage/updated", telemetryFrame);

    assert.equal(h.events.filter((event) => event.name.startsWith("daemon.runtime.telemetry.")).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("runtime spec: a busy OAR session rebound on another model is ended at its turn end", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.sessions[0]?.status().value.kind === "running", "the first turn running");
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: makeConfig({ model: "grok-other" }) })), { kind: "rebound" });
    await sleep(20);
    assert.equal(h.host.owns("agent-1"), true, "not under a running turn");
    assert.deepEqual(specStops(h), []);
    // The runtime profile still reads the launch's own config.
    assert.equal(h.host.hostedSession("agent-1")!.config.model, "default");

    release.resolve();
    await until(() => specStops(h).length > 0, "the stop at the turn end");
    assert.deepEqual(specStops(h).map((stop) => [stop.drift, stop.trigger]), [["model", "turn_end"]]);
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

test("A10: a Codex turn that showed text with no tool call is a communication gap; one with a tool call is not", async () => {
  const h = await harness({
    turn: async (turn) => {
      if (turn.input.includes("use-a-tool")) await turn.tool("shell", "raft message send --target x", () => "ok");
      turn.say("done");
    },
  });
  try {
    await h.host.start(startRequest("agent-1", codexShared({ model: "gpt-x" })));
    await until(() => gapEvents(h).length === 1, "the first turn's gap");
    assert.equal(gapEvents(h)[0]!.attrs.classification, "final_without_tool_or_raft_send");
    assert.equal(gapEvents(h)[0]!.attrs.zero_tool_zero_send, true);
    assert.equal(gapEvents(h)[0]!.attrs.runtime_tool_calls_count, 0);
    assert.equal(gapEvents(h)[0]!.attrs.host, "oar");
    assert.equal(gapEvents(h)[0]!.attrs.agent_id, "agent-1");
    assert.equal(gapEvents(h)[0]!.attrs.session_id_present, true);

    const turnsEnded = () => h.framesOf("agent:activity").filter((frame) => frame.detailKind === "idle").length;
    const before = turnsEnded();
    await h.host.deliverMessage("agent-1", message("m-tool", { content: "use-a-tool" }), { onMentionAck: () => {} });
    await until(() => h.inputs.some((input) => input.includes("use-a-tool")) && turnsEnded() > before, "the second turn's end");

    assert.equal(gapEvents(h).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("A10: a turn whose only tool call spawned a sub-agent, or whose text was all commentary, is no gap", async () => {
  const sink: FrameSink = {};
  const h = await harness({
    turn: async (turn) => {
      if (turn.input.includes("collab")) await turn.tool("collabAgentToolCall", JSON.stringify({ tool: "spawnAgent" }), () => "ok");
      turn.say("done");
    },
    wrapSession: (session) => withFrames(session, sink),
  });
  const turnsEnded = () => h.framesOf("agent:activity").filter((frame) => frame.detailKind === "idle").length;
  const runTurn = async (id: string) => {
    const before = turnsEnded();
    await h.host.deliverMessage("agent-1", message(id, { content: id }), { onMentionAck: () => {} });
    await until(() => turnsEnded() > before, `the ${id} turn's end`);
  };
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => gapEvents(h).length === 1 && turnsEnded() > 0, "the first turn's gap");

    await runTurn("collab");
    assert.equal(gapEvents(h).length, 1);

    sink.emit!("turn/started", { turn: { id: "t-commentary" } });
    sink.emit!("item/started", { item: { type: "agentMessage", id: "m-c", phase: "commentary" } });
    sink.textMessageId = "m-c";
    await runTurn("commentary");
    assert.equal(gapEvents(h).length, 1);

    // The checks above aren't vacuous: a plain turn after them still counts.
    sink.textMessageId = undefined;
    sink.emit!("turn/started", { turn: { id: "t-plain" } });
    await runTurn("plain");
    assert.equal(gapEvents(h).length, 2);
  } finally {
    await h.cleanup();
  }
});

test("A10: a failed turn is not a communication gap (`completed` turns only, unlike the legacy host)", async () => {
  const h = await harness({ turn: (turn) => { turn.say("partly"); throw new Error("boom"); } });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.turn_failed"), "the failed turn");

    assert.equal(gapEvents(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("A10: another runtime's turn is not a Codex communication gap", async () => {
  const h = await harness({ turn: (turn) => turn.say("done") });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").some((frame) => JSON.stringify(frame).includes("\"idle\"")), "the turn's end");

    assert.equal(gapEvents(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("runtime spec: another Codex model on OAR ends the session, and the next start naming its thread opens a new one", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.host.start(startRequest("agent-1", codexShared({ model: "gpt-5.5" }))), { kind: "started" });
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    const thread = h.sessions[0]!.id;
    await h.host.start(request({ launchId: "launch-2", config: codexShared({ model: "gpt-5.4", sessionId: thread }) }));
    assert.deepEqual(specStops(h).map((stop) => stop.drift), ["model"]);
    await h.host.unwound("agent-1");

    assert.deepEqual(await h.host.start(request({ launchId: "launch-3", config: codexShared({ model: "gpt-5.4", sessionId: thread }) })), { kind: "started" });
    assert.equal(h.opened[1]!.options.resume, undefined, "a new thread");
    assert.deepEqual(h.events.filter((event) => event.name === "daemon.agent.session_dropped_for_spec").map((event) => event.attrs), [
      { agentId: "agent-1", launchId: "launch-3", reason: "codex_model_changed", host: "oar" },
    ]);
  } finally {
    await h.cleanup();
  }
});

test("M2: on Linux a launch's executable raises its OOM score first; elsewhere it runs as prepared", async () => {
  const prepareLaunch: OarAgentHostDeps["prepareLaunch"] = async (ctx) => ({
    runtimeId: "grok",
    busyDelivery: "after_turn",
    installation: { kind: "available", via: "executable", command: "/usr/bin/grok" },
    options: { cwd: ctx.workingDirectory },
  });
  const linux = await harness({ turn: (turn) => turn.say("ok"), deps: { platform: "linux", prepareLaunch } });
  const darwin = await harness({ turn: (turn) => turn.say("ok"), deps: { platform: "darwin", prepareLaunch } });
  try {
    await linux.host.start(request());
    await darwin.host.start(request());
    await until(() => linux.opened.length === 1 && darwin.opened.length === 1, "both launches");

    const wrapped = (linux.opened[0]!.installation as { command: string }).command;
    assert.ok(wrapped.startsWith(path.join(linux.dataDir, "oar-launch")), wrapped);
    assert.match(await readFile(wrapped, "utf8"), /oom_score_adj[\s\S]*exec '\/usr\/bin\/grok' "\$@"/);
    assert.equal((darwin.opened[0]!.installation as { command: string }).command, "/usr/bin/grok");
  } finally {
    await linux.cleanup();
    await darwin.cleanup();
  }
});

test.each([["a reply after it", "The answer."], ["no reply after it", null]])("A9: a Codex reconnect shows the legacy activity and trace, and its text is never the turn's last text, with %s", async (_name, reply) => {
  const session = { emit: undefined as undefined | ((event: Record<string, unknown>) => void) };
  let release = () => {};
  let toolDone = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({
    turn: async (turn) => {
      await turn.tool("shell", "ls", () => "ok");
      toolDone = true;
      await held;
      if (reply) turn.say(reply);
    },
    wrapSession: (wrapped) => new Proxy(wrapped, {
      get(target, property, receiver) {
        if (property === "events") {
          return (observer: EventObserver, options?: EventsOptions) => {
            session.emit = (event) => observer({ sessionId: wrapped.id, agentPath: [], seq: 1_000_000, receivedAt: 1, ...event } as unknown as Event);
            return target.events(observer, options);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }),
  });
  try {
    await h.host.start({ ...startRequest("agent-1", codexShared({ model: "gpt-x" })), wakeMessage: message("m-1") });
    await until(() => session.emit !== undefined && toolDone, "the turn running, past its tool call");

    session.emit!({ kind: "retry", attempt: 2, reason: "Reconnecting... 2/5" });

    const frame = h.framesOf("agent:activity").find((each) => each.detailKind === "runtime_reconnecting");
    assert.equal(frame?.detail, "Codex reconnecting to provider…");
    const rows = (frame?.entries ?? []) as Array<{ kind: string; text?: string; detail?: string }>;
    assert.deepEqual(rows.map((row) => row.kind), ["text", "status"]);
    assert.equal(rows[0]!.text, "Reconnecting... 2/5");
    const traced = h.events.find((event) => event.name === "daemon.agent.provider_reconnect");
    assert.equal(traced?.attrs.attempt, 2);
    assert.equal(traced?.attrs.host, "oar");
    assert.equal(traced?.attrs.model, "gpt-x");

    release();
    const summary = () => h.framesOf("agent:activity").flatMap((each) => (each.entries ?? []) as Array<{ kind: string; summary?: { lastText?: unknown } }>).find((entry) => entry.kind === "turn_summary");
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the turn's end");
    await h.host.stopAll();
    assert.ok(summary());
    assert.equal(summary()?.summary?.lastText, reply ?? undefined);
  } finally {
    release();
    await h.cleanup();
  }
});

// RFC 081 D3/D16 on the OAR host: the app Inbox notice is the wake-up notice,
// the same text whether it starts a turn or waits for the running one to end;
// inbox items off, the count notice.
async function oarAppInboxNotice(mode: "idle" | "busy", config: Partial<AgentConfig>): Promise<string> {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1 && mode === "busy") await gate.promise;
      turn.say("done");
    },
    deps: { appInboxForAgent: () => store },
  });
  try {
    await h.host.start(request({ config: makeConfig(config) }));
    await until(() => h.inputs.length === 1, "first turn running");
    if (mode === "idle") await until(() => h.sessions[0]?.status().value.kind === "idle", "first turn ended");
    const minted = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: "1598ee1a-81c7-4aba-a76b-c75aab407097", revision: "1" },
      title: "查看「今日待办」页面有没有新评论",
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) return "";
    const accepted = h.host.notifyAgentAppInbox("agent-1", minted.item);
    gate.resolve();
    assert.equal(await accepted, true);
    await until(() => h.inputs.length === 2, "the notice's turn");
    return h.inputs[1]!;
  } finally {
    gate.resolve();
    await h.cleanup();
  }
}

const OAR_REMINDER_DAEMON_SECTION_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "",
  "App items: 1",
  "",
  "app=system.reminder · class=due · item=reminder · retention=until_explicit_ack · sourceRef=reminder:1598ee1a-81c7-4aba-a76b-c75aab407097:1 · action=raft reminder ack --id 1598ee1a --revision 1 · title=查看「今日待办」页面有没有新评论",
  "]",
].join("\n");

const OAR_REMINDER_ROW_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "reminder:1598ee1a · 1 fired, not acked · latest just now",
  "  \"查看「今日待办」页面有没有新评论\" (preview)",
  "  read: raft inbox read --target \"reminder:1598ee1a\"",
  "  ack: raft reminder ack --id 1598ee1a-81c7-4aba-a76b-c75aab407097 --revision 1",
  "]",
].join("\n");

test("RFC 081 inbox items: the OAR host's app Inbox notice is the wake-up notice, busy or idle (daemon section while the launch time is unknown)", async () => {
  const idle = await oarAppInboxNotice("idle", { inboxItems: true });
  const busy = await oarAppInboxNotice("busy", { inboxItems: true });
  assert.equal(busy, idle);
  assert.equal(idle, OAR_REMINDER_DAEMON_SECTION_NOTICE);
});

// RFC 081 D9: the launch time comes from the config (or the refreshed server
// features) the host reads `inboxItems` from (inboxItemsLaunchAtMs).
test("RFC 081 inbox items: on the OAR host a reminder fired after the inbox-items launch time is its reminder: row, busy or idle", async () => {
  const config = { inboxItems: true, inboxItemsLaunchAt: "2026-01-01T00:00:00.000Z" };
  const idle = await oarAppInboxNotice("idle", config);
  const busy = await oarAppInboxNotice("busy", config);
  assert.equal(busy, idle);
  assert.equal(idle, OAR_REMINDER_ROW_NOTICE);
});

test("RFC 081 inbox items: on the OAR host a reminder fired before the inbox-items launch time is in the daemon section", async () => {
  const config = { inboxItems: true, inboxItemsLaunchAt: "2999-01-01T00:00:00.000Z" };
  assert.equal(await oarAppInboxNotice("idle", config), OAR_REMINDER_DAEMON_SECTION_NOTICE);
  assert.equal(await oarAppInboxNotice("busy", config), OAR_REMINDER_DAEMON_SECTION_NOTICE);
});

test("RFC 081 inbox items off: the OAR host's app Inbox notice stays the count notice", async () => {
  assert.equal(await oarAppInboxNotice("idle", {}), "[Raft Inbox notice:\nApp items pending: 1\nRun `raft inbox check` to inspect them.]");
});

// A Computer-local item's id is stable per (app, class, source): a reminder
// the Cleaner mints again after its item was dismissed or withdrawn has the id
// of the one before. The launch's notice memo keeps the item's createdAtMs
// beside its id (appInboxItemNoticed), so the one that came back is announced;
// an item still pending is not announced twice, also when updated in place.
test("the OAR host announces an app Inbox item again once it was removed and minted again; a pending item is not announced twice", async () => {
  // Every mint is a minute after the one before, as the Cleaner's are hours apart.
  let now = Date.parse("2026-11-12T08:00:00.000Z");
  const store = createAgentAppInboxStore({
    registry: {
      ...REMINDER_AGENT_INBOX_REGISTRY,
      ...createSystemCleanerAppRegistry(() => ({ thresholdBytes: 1024, maximumThresholdBytes: 4096 })),
    },
    nowMs: () => now,
  });
  const mint = (summary: string) => {
    now += 60_000;
    const minted = store.mint({
      appId: "system.cleaner",
      notificationClass: "disk_space_hint",
      sourceRef: { kind: "backup_ignore_hint", agentId: "agent-1" },
      title: "Review .raftbackupignore",
      summary,
    });
    if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
    return minted.item;
  };
  const h = await harness({ turn: async (turn) => { turn.say("done"); }, deps: { appInboxForAgent: () => store } });
  const idle = () => until(() => h.sessions[0]?.status().value.kind === "idle", "the turn's end");
  try {
    await h.host.start(request({ config: makeConfig({ inboxItems: true }) }));
    await until(() => h.inputs.length === 1, "first turn running");
    await idle();

    const first = mint("first");
    assert.equal(await h.host.notifyAgentAppInbox("agent-1", first), true);
    await until(() => h.inputs.length === 2, "the notice's turn");
    assert.match(h.inputs[1]!, /summary=first/);
    assert.match(h.inputs[1]!, new RegExp(`\\n  dismiss: raft inbox dismiss --target "app:system\\.cleaner/${first.itemId.slice(0, 8)}"\\n`));
    await idle();

    // Still pending, and minted again as the same identity (an update): no second notice.
    const updated = mint("updated");
    assert.equal(updated.itemId, first.itemId);
    assert.equal(await h.host.notifyAgentAppInbox("agent-1", updated), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.inputs.length, 2, "one notice for an item that is still there");

    // Dismissed and minted again, with no read of the store by the host in between.
    assert.equal(store.dismiss(first.itemId), true);
    const again = mint("again");
    assert.equal(again.itemId, first.itemId, "the same id as the item before");
    assert.equal(await h.host.notifyAgentAppInbox("agent-1", again), true);
    await until(() => h.inputs.length === 3, "the notice of the item that came back");
    assert.match(h.inputs[2]!, /summary=again/);
    await idle();

    // And once only.
    assert.equal(await h.host.notifyAgentAppInbox("agent-1", again), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.inputs.length, 3);
  } finally {
    await h.cleanup();
  }
});
