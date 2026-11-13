import assert from "node:assert/strict";
import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import { exampleMessage } from "../axExampleFixtures";
import type { AgentStartAcceptance } from "../agentStartDispatchProjection";
import { getDriver, registeredRuntimeIds } from "../drivers/index";
import { OarOnlyStartError, RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { classifySpawnFailure } from "../spawnFailureClassification";
import { AgentHostRouter, oarOpenFailureDetail } from "./agentHostRouter";
import type { AgentStartRequest, LegacyAgentHost } from "./agentLifecycleHost";
import { OAR_HOSTED_RUNTIMES, type HeldDelivery, type OarAgentHost, type OarHostSupport, type OarStartOutcome } from "./oarAgentHost";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "a", displayName: null, description: null, model: "default", runtime: "grok", reasoningEffort: null,
    envVars: null, sessionId: "grok-session-1", serverUrl: "http://localhost:3001", authToken: "", runtimeHost: "oar",
    ...overrides,
  };
}

class FakeLegacy {
  state: "none" | "idle" | "active" = "none";
  readonly calls: string[] = [];
  readonly starts: unknown[][] = [];
  readonly delivered: AgentMessage[] = [];
  agentHostState(): "none" | "idle" | "active" { return this.state; }
  readonly forgottenHandbacks: string[] = [];
  forgetSpecHandback(agentId: string): void { this.forgottenHandbacks.push(agentId); }
  async startAgent(...args: unknown[]): Promise<void> { this.calls.push("start"); this.starts.push(args); this.state = "active"; }
  getAgentStartAcceptance(): AgentStartAcceptance { return { queueState: "queued", queueDepth: 1, queueAgeMs: 0 }; }
  async stopAgent(_agentId: string, options?: { silent?: boolean }): Promise<void> { this.calls.push(`stop:${options?.silent ? "silent" : "loud"}`); this.state = "none"; }
  async stopAll(): Promise<void> {}
  deliverMessage(_agentId: string, message: AgentMessage): boolean { this.delivered.push(message); return true; }
  purgeInboxMessagesForChannels() { return { removedCount: 0 }; }
  respondToActivityProbe() {}
  async interruptTurn() { return { outcome: "not_running" as const }; }
  async notifyAgentAppInbox() { return true; }
  deliverRuntimeProfileNotification() { return true; }
  getRunningAgentIds() { return []; }
  heldCredentialIds: string[] = [];
  getHeldRunnerCredentialIds(): string[] { return this.heldCredentialIds; }
  getAgentSessionId() { return null; }
  getAgentLaunchId() { return null; }
  setTracer() {}
  setCliTransportTraceDir() {}
  setServerTurnEndedCapable() {}
  readonly features: unknown[] = [];
  applyServerFeatures(features: unknown): void { this.features.push(features); }
}

class FakeOar {
  owned = new Set<string>();
  support: OarHostSupport = { ok: true };
  outcome: OarStartOutcome = { kind: "started" };
  readonly started: AgentStartRequest[] = [];
  owns(agentId: string): boolean { return this.owned.has(agentId); }
  isUnwinding(): boolean { return false; }
  async unwound(): Promise<void> {}
  supports(): OarHostSupport { return this.support; }
  start(request: AgentStartRequest): Promise<OarStartOutcome> {
    this.started.push(request);
    this.owned.add(request.agentId);
    const outcome = this.outcome;
    if (outcome.kind === "fallback") this.owned.delete(request.agentId);
    return Promise.resolve(outcome);
  }
  getAgentStartAcceptance(): AgentStartAcceptance { return { queueState: "starting", queueDepth: 0, queueAgeMs: 0 }; }
  async stopAgent(agentId: string): Promise<void> { this.owned.delete(agentId); }
  async stopAll(): Promise<void> {}
  getRunningAgentIds(): string[] { return [...this.owned]; }
  heldCredentialIds: string[] = [];
  getHeldRunnerCredentialIds(): string[] { return this.heldCredentialIds; }
  setTracer() {}
  setCliTransportTraceDir() {}
  setServerTurnEndedCapable() {}
  readonly features: unknown[] = [];
  applyServerFeatures(features: unknown): void { this.features.push(features); }
}

function router() {
  const legacy = new FakeLegacy();
  const oar = new FakeOar();
  const traces: Array<Record<string, unknown>> = [];
  const released: string[] = [];
  const hosts = new AgentHostRouter(legacy as unknown as LegacyAgentHost, oar as unknown as OarAgentHost, {
    recordEvent: (name, attrs) => { if (name === "daemon.agent.host.selected") traces.push(attrs); },
    settleNotSpawned: () => {},
    releaseUnusedCredential: (agentId, config) => { released.push(`${agentId}:${config.agentCredentialId ?? ""}`); },
  });
  return { legacy, oar, traces, hosts, released };
}

test("no OAR request: the legacy host runs the start as before", async () => {
  const { legacy, oar, traces, hosts } = router();
  await hosts.startAgent("agent-1", config({ runtimeHost: undefined }), undefined, undefined, undefined, "launch-1");
  assert.deepEqual(legacy.calls, ["start"]);
  assert.equal(oar.started.length, 0);
  assert.deepEqual(traces.map((trace) => [trace.requested, trace.host]), [["legacy", "legacy"]]);
});

test("an OAR request the OAR host supports runs there; an idle legacy restart config is dropped first", async () => {
  const { legacy, oar, traces, hosts } = router();
  legacy.state = "idle";
  const started = hosts.startAgent("agent-1", config(), undefined, undefined, undefined, "launch-1");
  // Read synchronously by the core right after the call.
  assert.equal(hosts.getAgentStartAcceptance("agent-1").queueState, "starting");
  await started;
  assert.deepEqual(legacy.calls, ["stop:silent"]);
  assert.equal(oar.started[0]!.launchId, "launch-1");
  assert.deepEqual(traces.map((trace) => trace.host), ["oar"]);
});

test("step 11c: a start on the OAR host ends a legacy handback too (it never reaches the legacy host)", async () => {
  const { legacy, oar, hosts } = router();
  await hosts.startAgent("agent-1", config(), undefined, undefined, undefined, "launch-1");
  assert.equal(oar.started.length, 1);
  assert.deepEqual(legacy.calls, []);
  assert.deepEqual(legacy.forgottenHandbacks, ["agent-1"]);
});

test("an unsupported OAR request falls back to the legacy host with the reason traced", async () => {
  const { legacy, oar, traces, hosts } = router();
  oar.support = { ok: false, reason: "platform_unsupported" };
  await hosts.startAgent("agent-1", config(), undefined, undefined, undefined, "launch-1");
  assert.deepEqual(legacy.calls, ["start"]);
  assert.equal(traces[0]!.fallback_reason, "platform_unsupported");
});

test("a legacy process or start keeps the agent on the legacy host (never two runtimes)", async () => {
  const { legacy, oar, traces, hosts } = router();
  legacy.state = "active";
  await hosts.startAgent("agent-1", config(), undefined, undefined, undefined, "launch-2");
  assert.deepEqual(legacy.calls, ["start"]);
  assert.equal(oar.started.length, 0);
  assert.equal(traces[0]!.fallback_reason, "legacy_holds_agent");
});

test("an agent running on OAR stays there for a later start even when the flag went off", async () => {
  const { legacy, oar, traces, hosts } = router();
  oar.owned.add("agent-1");
  oar.outcome = { kind: "rebound" };
  await hosts.startAgent("agent-1", config({ runtimeHost: undefined }), undefined, undefined, undefined, "launch-2");
  assert.deepEqual(legacy.calls, []);
  assert.equal(oar.started[0]!.launchId, "launch-2");
  assert.equal(traces[0]!.fallback_reason, "oar_holds_agent");
});

test("a start the OAR host hands back runs on the legacy host with the same session and the held deliveries", async () => {
  const { legacy, oar, traces, hosts } = router();
  const held: AgentMessage = { ...exampleMessage, message_id: "held-1" };
  let settled: boolean | Promise<boolean> | undefined;
  const heldDelivery: HeldDelivery = { message: held, context: {}, settle: (accepted) => { settled = accepted; } };
  oar.outcome = {
    kind: "fallback",
    reason: "resume_failed:SessionNotFoundError",
    request: { agentId: "agent-1", config: config(), launchId: "launch-2", wakeMessageTransient: false, recoveryGrant: null, claimedConnectionEpochId: null },
    held: [heldDelivery],
  };
  await hosts.startAgent("agent-1", config(), undefined, undefined, undefined, "launch-1");
  assert.deepEqual(legacy.calls, ["start"]);
  assert.equal((legacy.starts[0]![1] as AgentConfig).sessionId, "grok-session-1", "the legacy host resumes the same session");
  assert.equal(legacy.starts[0]![5], "launch-2", "the newest launch the OAR start carried");
  assert.deepEqual(legacy.delivered, [held]);
  assert.equal(settled, true);
  assert.deepEqual(traces.map((trace) => [trace.host, trace.stage, trace.fallback_reason]), [
    ["oar", "start", undefined],
    ["legacy", "oar_fallback", "resume_failed:SessionNotFoundError"],
  ]);
});

test("lifecycle calls follow the agent's current host", async () => {
  const { legacy, oar, hosts } = router();
  oar.owned.add("agent-1");
  assert.equal(hosts.getAgentStartAcceptance("agent-1").queueState, "starting");
  assert.equal(hosts.getAgentStartAcceptance("agent-2").queueState, "queued");
  assert.deepEqual(hosts.getRunningAgentIds(), ["agent-1"]);
  await hosts.stopAgent("agent-1");
  assert.equal(oar.owns("agent-1"), false);
  assert.deepEqual(legacy.calls, [], "the legacy host held nothing for it");
});

// ── Runtimes with no legacy driver (RuntimeDriver.oarOnly: Qwen Code, Qoder) ──

function oarOnlyConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return config({ runtime: "qwen", sessionId: "qwen-session-1", runtimeHost: undefined, ...overrides });
}

function oarOnlyFallback(reason: string, extra: Partial<Extract<OarStartOutcome, { kind: "fallback" }>> = {}): { outcome: OarStartOutcome; settled: () => unknown } {
  let settled: unknown;
  const held: HeldDelivery = { message: { ...exampleMessage, message_id: "held-1" }, context: {}, settle: (accepted) => { settled = accepted; } };
  return {
    outcome: {
      kind: "fallback",
      reason,
      request: { agentId: "agent-1", config: oarOnlyConfig(), launchId: "launch-1", wakeMessageTransient: false, recoveryGrant: null, claimedConnectionEpochId: null },
      held: [held],
      ...extra,
    },
    settled: () => settled,
  };
}

async function rejectsOarOnly(promise: Promise<unknown>): Promise<OarOnlyStartError> {
  let thrown: unknown;
  await promise.catch((error: unknown) => { thrown = error; });
  assert.ok(thrown instanceof OarOnlyStartError, `expected OarOnlyStartError, got ${String(thrown)}`);
  return thrown;
}

test("structure: every OAR-only driver has an OAR launch, and its spawn is never a way to run it", () => {
  const oarOnly = registeredRuntimeIds().filter((id) => getDriver(id).oarOnly);
  assert.deepEqual(oarOnly.sort(), ["codebuddy", "qoder", "qwen"]);
  for (const id of oarOnly) {
    assert.ok(OAR_HOSTED_RUNTIMES.has(id), `${id} is launched by the OAR host`);
    assert.throws(() => getDriver(id).spawn({} as never), /runs only on the OAR host/);
  }
});

test("an OAR-only runtime runs on the OAR host even when the start did not ask for it", async () => {
  const { legacy, oar, traces, hosts } = router();
  await hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1");
  assert.deepEqual(legacy.calls, []);
  assert.equal(oar.started.length, 1);
  assert.deepEqual(traces.map((trace) => [trace.requested, trace.host]), [["oar", "oar"]]);
});

test("an OAR-only start the OAR host does not support fails instead of reaching the legacy host", async () => {
  const { legacy, oar, traces, hosts } = router();
  oar.support = { ok: false, reason: "platform_unsupported" };
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.deepEqual(legacy.calls, []);
  assert.equal(oar.started.length, 0);
  assert.equal(error.notSpawnedReason, "start_rejected");
  assert.match(classifySpawnFailure(error).userMessage, /Qwen Code does not run on Windows Computers yet/);
  assert.deepEqual(traces.map((trace) => [trace.host, trace.stage, trace.fallback_reason]), [["none", "oar_only_refused", "platform_unsupported"]]);
});

test("a legacy start holding the agent fails an OAR-only start rather than joining it", async () => {
  const { legacy, hosts } = router();
  legacy.state = "active";
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.equal(error.hostReason, "legacy_holds_agent");
  assert.deepEqual(legacy.calls, []);
});

test("an OAR-only start the OAR host hands back fails with the launch's own error; held deliveries are not taken", async () => {
  const { legacy, oar, traces, hosts } = router();
  const missing = oarOnlyFallback("error:RuntimeExecutableNotFoundError", {
    cause: new RuntimeExecutableNotFoundError({ runtimeId: "qwen", message: "Qwen Code CLI (qwen) was not found on this computer" }),
  });
  oar.outcome = missing.outcome;
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.deepEqual(legacy.calls, []);
  assert.deepEqual(legacy.delivered, []);
  assert.equal(missing.settled(), false);
  const classified = classifySpawnFailure(error);
  assert.equal(classified.reason, "runtime_not_found");
  assert.match(classified.userMessage, /Qwen Code is not installed on this Computer/);
  assert.deepEqual(traces.at(-1), {
    agentId: "agent-1", launchId: "launch-1", runtime: "qwen", requested: "oar", host: "none", stage: "oar_only_failed",
    session_id_present: true, fallback_reason: "error:RuntimeExecutableNotFoundError",
  });
});

test("an OAR-only start refused by the RFC 071 gate fails with the gate's own reason and sentence", async () => {
  const { oar, hosts } = router();
  oar.outcome = oarOnlyFallback("start_refused", { refusal: { reason: "terminal_failure_needs_manual", detail: "Start it by hand to recover." } }).outcome;
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.equal(error.notSpawnedReason, "terminal_failure_needs_manual");
  assert.equal(classifySpawnFailure(error).userMessage, "Start it by hand to recover.");
});

test("an OAR-only open that fails shows the runtime's own reason, not just the error class", async () => {
  // 10-29 (Carl, xxwork): Qoder reported a different model name than it was
  // asked for; the person saw only "open_failed:Error".
  const { oar, hosts } = router();
  oar.outcome = oarOnlyFallback("open_failed:Error", {
    cause: new Error("Qoder did not confirm model \"qfmodel\"; reported \"Qwen3.8-Flash\"\n    at open (session.js:32)"),
  }).outcome;
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.equal(error.hostReason, "open_failed:Error");
  assert.equal(
    classifySpawnFailure(error).userMessage,
    "Qwen Code failed to start on this Computer: Qoder did not confirm model \"qfmodel\"; reported \"Qwen3.8-Flash\". Check the Computer logs for details and retry.",
  );
});

test("oarOpenFailureDetail keeps one short line and masks credentials and URLs", () => {
  assert.equal(oarOpenFailureDetail("not an error"), undefined);
  assert.equal(oarOpenFailureDetail(new Error("   \nsecond line")), undefined);
  const detail = oarOpenFailureDetail(new Error("auth failed for https://api.example.com/v1?key=abc with Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"))!;
  assert.doesNotMatch(detail, /example\.com|sk-ant-api03/);
  assert.ok(Array.from(oarOpenFailureDetail(new Error("x".repeat(500)))!).length <= 200);
  // No emoji cut in half: a lone high surrogate would render as a broken character.
  assert.doesNotMatch(oarOpenFailureDetail(new Error("😀".repeat(300)))!, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("an OAR-only open that fails without an error message keeps the reason in the generic sentence", async () => {
  const { oar, hosts } = router();
  oar.outcome = oarOnlyFallback("stale_dispatch").outcome;
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  assert.equal(classifySpawnFailure(error).userMessage, "Qwen Code failed to start on this Computer (stale_dispatch). Check the Computer logs for details and retry.");
});

test("an OAR-only session that cannot be resumed asks for a session reset, never a fresh session", async () => {
  const { oar, hosts } = router();
  oar.outcome = oarOnlyFallback("resume_failed:SessionNotFoundError").outcome;
  const error = await rejectsOarOnly(hosts.startAgent("agent-1", oarOnlyConfig(), undefined, undefined, undefined, "launch-1"));
  const classified = classifySpawnFailure(error);
  assert.equal(classified.reason, "session_needs_reset");
  assert.match(classified.userMessage, /Reset the agent's session/);
});

// #wg-rbac:#27: an OAR-only start no host runs drops its config; the runner
// credential the core minted for it is released (revoked) once, not left valid.
// Teeth: drop releaseCredential in failOarOnly / failOarOnlyFallback -> RED.
test("an OAR-only start no host runs releases its runner credential once", async () => {
  const credentialed = oarOnlyConfig({ agentCredentialKey: "sk_agent_a", agentCredentialId: "cred-a" });
  {
    const { oar, hosts, released } = router();
    oar.support = { ok: false, reason: "platform_unsupported" };
    await rejectsOarOnly(hosts.startAgent("agent-1", credentialed, undefined, undefined, undefined, "launch-1"));
    assert.deepEqual(released, ["agent-1:cred-a"]);
  }
  {
    const { oar, hosts, released } = router();
    const fallback = oarOnlyFallback("open_failed:Error");
    oar.outcome = fallback.outcome.kind === "fallback"
      ? { ...fallback.outcome, request: { ...fallback.outcome.request, config: credentialed } }
      : fallback.outcome;
    await rejectsOarOnly(hosts.startAgent("agent-1", credentialed, undefined, undefined, undefined, "launch-1"));
    assert.deepEqual(released, ["agent-1:cred-a"]);
  }
});

test("holdsAgentStart: what the router would rebind onto", () => {
  const { legacy, oar, hosts } = router();
  assert.equal(hosts.holdsAgentStart("agent-1"), false);
  legacy.state = "idle";
  assert.equal(hosts.holdsAgentStart("agent-1"), false, "an idle restart config is not a rebind target");
  legacy.state = "active";
  assert.equal(hosts.holdsAgentStart("agent-1"), true);
  legacy.state = "none";
  oar.owned.add("agent-1");
  assert.equal(hosts.holdsAgentStart("agent-1"), true);
});

// #wg-rbac:#27: the daemon's ready lists every runner credential either host
// (or a start waiting here for an OAR unwind) holds, each id once.
// Teeth: drop either host's list, or the waiting starts', in the router -> RED.
test("getHeldRunnerCredentialIds: both hosts' credentials and a waiting start's, each once", async () => {
  const { legacy, oar, hosts } = router();
  assert.deepEqual(hosts.getHeldRunnerCredentialIds(), []);
  legacy.heldCredentialIds = ["cred-legacy", "cred-shared"];
  oar.heldCredentialIds = ["cred-oar", "cred-shared"];
  assert.deepEqual(hosts.getHeldRunnerCredentialIds().sort(), ["cred-legacy", "cred-oar", "cred-shared"]);

  let unwound!: () => void;
  oar.isUnwinding = () => true;
  oar.unwound = () => new Promise<void>((resolve) => { unwound = resolve; });
  const started = hosts.startAgent("agent-2", config({ runtimeHost: undefined, agentCredentialKey: "sk_agent_w", agentCredentialId: "cred-waiting" }), undefined, undefined, undefined, "launch-1");
  assert.deepEqual(hosts.getHeldRunnerCredentialIds().sort(), ["cred-legacy", "cred-oar", "cred-shared", "cred-waiting"]);
  unwound();
  await started;
  // Handed to the (fake) legacy host, which now answers for it.
  assert.deepEqual(hosts.getHeldRunnerCredentialIds().sort(), ["cred-legacy", "cred-oar", "cred-shared"]);
});

// Reconciler step 6: a server:features answer reaches both hosts (rows A1, A2).
test("applyServerFeatures: both hosts get the answer", () => {
  const { legacy, oar, hosts } = router();
  hosts.applyServerFeatures({ enabledApps: ["artifacts"] });
  assert.deepEqual(legacy.features, [{ enabledApps: ["artifacts"] }]);
  assert.deepEqual(oar.features, [{ enabledApps: ["artifacts"] }]);
});

// Reconciler step 13: a drain reaches both hosts with one clamped deadline;
// it is quiet only when both are, and the summary names both hosts' agents.
test("beginDrain: both hosts drain with the clamped deadline; the summary is the worse of the two", async () => {
  const { legacy, oar, hosts } = router();
  const asked: number[] = [];
  const ended: string[] = [];
  Object.assign(legacy, {
    beginDrain: async ({ deadlineMs }: { deadlineMs: number }) => {
      asked.push(deadlineMs);
      return { finished: "quiet", deadlineAtMs: 100, durationMs: 5, waitedFor: ["agent-l"], notQuiet: [], live: 2 };
    },
    endDrain: () => { ended.push("legacy"); },
  });
  Object.assign(oar, {
    beginDrain: async ({ deadlineMs }: { deadlineMs: number }) => {
      asked.push(deadlineMs);
      return { finished: "deadline", deadlineAtMs: 101, durationMs: 9, waitedFor: ["agent-o"], notQuiet: [{ agentId: "agent-o", reason: "agent_busy" }], live: 1 };
    },
    endDrain: () => { ended.push("oar"); },
  });
  const summary = await hosts.beginDrain({ deadlineMs: 60 * 60_000 });
  assert.deepEqual(asked, [600_000, 600_000], "clamped to 10 minutes for both hosts");
  assert.deepEqual(summary, {
    finished: "deadline",
    deadlineAtMs: 101,
    durationMs: 9,
    waitedFor: ["agent-l", "agent-o"],
    notQuiet: [{ agentId: "agent-o", reason: "agent_busy" }],
    notRunnable: [],
    live: 3,
  });
  hosts.endDrain();
  assert.deepEqual(ended.sort(), ["legacy", "oar"]);
});
