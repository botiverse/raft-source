// task #1228 ①: the server records each feedback transcript request and its
// outcome as spans, including results that arrive after the 30 s wait. The
// late-result correlation map is bounded (cap + TTL), checks that the late
// result comes from the machine/agent/report it was asked of, and dedupes.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator";
import type { ReplicaStateStore } from "./replicaStateStore";

const MACHINE = "machine-outcome-1";
const OTHER_MACHINE = "machine-outcome-2";
const AGENT = "agent-outcome-1";
const REPORT = "report-outcome-1";

afterEach(async () => {
  vi.useRealTimers();
  await closeTestDatabase();
});

function replicaStore(): ReplicaStateStore {
  let v = 0;
  return {
    isAvailable: () => true,
    registerMachineReplica: async () => "gen",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => {},
    hasMachineReplica: async () => true,
    getMachineReplicaOwner: async () => "replica",
    bumpMachineStatusVersion: async () => ++v,
    getMachineStatusVersion: async () => v,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    getWakeCrashLoopState: async () => null,
    compareAndSetWakeCrashLoopState: async () => true,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setAgentContextViewAvailability: async () => {},
    getAgentContextViewAvailability: async () => null,
    clearAgentContextViewAvailability: async () => {},
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  } as ReplicaStateStore;
}

function setup(options: { machine?: string | null; sendFails?: boolean } = {}) {
  const sink = new MemoryTraceSink();
  const clock = {
    now: () => Date.now(),
    scheduleRepeated: (fn: () => void, ms: number) => setInterval(fn, ms),
    cancelRepeated: (t: unknown) => clearInterval(t as ReturnType<typeof setInterval>),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const orch = new AgentOrchestrator(replicaStore(), clock as never, new BasicTracer({ sink }));
  const sent: Array<Record<string, unknown>> = [];
  const machine = options.machine === undefined ? MACHINE : options.machine;
  (orch as any).getMachineForAgent = async () => (machine ? { machineId: machine, conn: {} } : null);
  (orch as any).sendRequiredToMachine = async (_machineId: string, msg: Record<string, unknown>) => {
    if (options.sendFails) throw new Error("ws not ready");
    sent.push(msg);
  };
  const request = () => orch.collectFeedbackTranscript(AGENT, REPORT, { reportGeneratedAt: new Date().toISOString(), reportTimeSource: "server_request_received" });
  // The same path a daemon frame takes after the WebSocket layer.
  const deliver = (machineId: string, msg: Record<string, unknown>) => orch.handleMachineMessage(machineId, msg as never);
  const spans = (name: string) => sink.getAllSpans().filter((s) => s.name === name);
  return { orch, sink, sent, request, deliver, spans };
}

function typedResult(requestId: string, overrides: Record<string, unknown> = {}): MachineToServerMessage {
  return {
    type: "agent:diagnostic:feedback_transcript_result",
    agentId: AGENT,
    feedbackReportId: REPORT,
    requestId,
    reachable: false,
    fallbackReason: "native session file not found",
    outcomeVersion: 1,
    lookup: {
      reachable: false, content: "placeholder", reasonCode: "native_session_file_not_found", runtime: "claude",
      lookupMethod: "claude_jsonl", workspaceDirPresent: null,
      sourceBytes: null, transcriptBytes: null, selectionBasis: "lookup_time",
    },
    upload: { status: "not_attempted", reason: "lookup_failed", stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null },
    outcomeObject: "attempt_after_result",
    ...overrides,
  } as unknown as MachineToServerMessage;
}

test("O1 an in-time typed result ends the request span with the typed outcome; the outcome object's fate is 'unknown'", async () => {
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const requestId = String(h.sent[0]!.requestId);
  await h.deliver(MACHINE, typedResult(requestId) as never);
  const outcome = await pending as any;
  assert.equal(outcome.lookup?.reasonCode, "native_session_file_not_found", "ORCH forwards the typed fields");
  assert.equal(outcome.upload?.status, "not_attempted");
  const [span] = h.spans("server.feedback_transcript.request");
  assert.ok(span, "request span recorded");
  assert.equal(span.attrs?.state, "result");
  assert.equal(span.attrs?.request_id, requestId);
  assert.equal(span.attrs?.feedback_report_id, REPORT);
  assert.equal(span.attrs?.machine_id, MACHINE);
  assert.equal(span.attrs?.daemon_typed, true);
  assert.equal(span.attrs?.lookup_reason, "native_session_file_not_found");
  assert.equal(span.attrs?.transcript_content, "placeholder");
  assert.equal(span.attrs?.upload_status, "not_attempted");
  assert.equal(span.attrs?.outcome_object, "unknown");
});

test("O2 an old daemon's untyped frame is recorded as daemon_typed=false; 'stored' is never inferred from reachable", async () => {
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const requestId = String(h.sent[0]!.requestId);
  await h.deliver(MACHINE, { type: "agent:diagnostic:feedback_transcript_result", agentId: AGENT, feedbackReportId: REPORT, requestId, reachable: true, traceBundleId: "bundle-1" });
  await pending;
  const [span] = h.spans("server.feedback_transcript.request");
  assert.equal(span?.attrs?.daemon_typed, false);
  assert.equal(span?.attrs?.upload_status, "unknown");
  assert.equal(span?.attrs?.legacy_reachable, true);
});

test("O3 no connected machine / send failure are recorded as their own states", async () => {
  const none = setup({ machine: null });
  await assert.rejects(none.request());
  assert.equal(none.spans("server.feedback_transcript.request")[0]?.attrs?.state, "machine_not_connected");

  const failing = setup({ sendFails: true });
  await assert.rejects(failing.request());
  assert.equal(failing.spans("server.feedback_transcript.request")[0]?.attrs?.state, "send_failed");
});

test("O4 timeout, then a late result from the asked machine → outcome span late=true, accepted ONCE (duplicates dropped)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const requestId = String(h.sent[0]!.requestId);
  const rejected = assert.rejects(pending, /timed out/);
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  assert.equal(h.spans("server.feedback_transcript.request")[0]?.attrs?.state, "daemon_timeout");

  await vi.advanceTimersByTimeAsync(1_000);
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
  const late = h.spans("server.feedback_transcript.outcome");
  assert.equal(late.length, 1, "deduped");
  assert.equal(late[0]?.attrs?.late, true);
  assert.equal(late[0]?.attrs?.request_id, requestId);
  assert.equal(late[0]?.attrs?.lookup_reason, "native_session_file_not_found");
});

test("O5 a late result is accepted only from the machine, agent and report it was asked of", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const requestId = String(h.sent[0]!.requestId);
  const rejected = assert.rejects(pending);
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;

  await h.orch.handleMachineMessage(OTHER_MACHINE, typedResult(requestId));
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId, { agentId: "someone-else" }));
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId, { feedbackReportId: "other-report" }));
  assert.equal(h.spans("server.feedback_transcript.outcome").length, 0, "no impostor accepted");
  // The genuine one is still accepted afterwards (a rejection does not consume the entry).
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
  assert.equal(h.spans("server.feedback_transcript.outcome").length, 1);
});

test("O6 a late result after the TTL is not accepted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const { FEEDBACK_TRANSCRIPT_LATE_RESULT_TTL_MS } = await import("./feedbackTranscriptLateResults") as any;
  assert.equal(typeof FEEDBACK_TRANSCRIPT_LATE_RESULT_TTL_MS, "number");
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const requestId = String(h.sent[0]!.requestId);
  const rejected = assert.rejects(pending);
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  await vi.advanceTimersByTimeAsync(FEEDBACK_TRANSCRIPT_LATE_RESULT_TTL_MS + 1);
  await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
  assert.equal(h.spans("server.feedback_transcript.outcome").length, 0);
});

test("O7 the late-result map is capped: the oldest pending entry is evicted, newer ones still resolve", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const { FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES } = await import("./feedbackTranscriptLateResults") as any;
  assert.equal(typeof FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES, "number");
  const h = setup();
  const pendings: Promise<unknown>[] = [];
  for (let i = 0; i <= FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES; i += 1) {
    pendings.push(h.request().catch(() => undefined));
    await vi.advanceTimersByTimeAsync(1);
  }
  await vi.waitFor(() => assert.equal(h.sent.length, FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES + 1));
  await vi.advanceTimersByTimeAsync(30_001);
  await Promise.all(pendings);
  assert.ok((h.orch as any).feedbackTranscriptLateResults.size() <= FEEDBACK_TRANSCRIPT_LATE_RESULT_MAX_ENTRIES);
  const first = String(h.sent[0]!.requestId);
  const last = String(h.sent.at(-1)!.requestId);
  await h.orch.handleMachineMessage(MACHINE, typedResult(first));
  assert.equal(h.spans("server.feedback_transcript.outcome").length, 0, "evicted");
  await h.orch.handleMachineMessage(MACHINE, typedResult(last));
  assert.equal(h.spans("server.feedback_transcript.outcome").length, 1);
});

test("O8 server spans never carry searched paths, even when a frame's lookup still has them (on-time and late)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const withPaths = (requestId: string) => {
    const msg = typedResult(requestId) as any;
    msg.lookup = { ...msg.lookup, searchedPaths: ["/srv/custom-private-workspace/agent/x", "~/.claude/projects"] };
    return msg;
  };
  const assertNoPathAttrs = (attrs: Record<string, unknown> | undefined, label: string) => {
    assert.ok(attrs, label);
    for (const [key, value] of Object.entries(attrs)) {
      assert.ok(!/searched|path/i.test(key), `${label}: path attribute ${key}`);
      if (typeof value === "string") assert.ok(!value.includes("/srv/") && !value.includes("~/"), `${label}: ${key}=${value}`);
    }
  };
  const h = setup();
  const onTime = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  await h.deliver(MACHINE, withPaths(String(h.sent[0]!.requestId)));
  await onTime;
  assertNoPathAttrs(h.spans("server.feedback_transcript.request")[0]?.attrs, "request span");

  const late = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 2));
  const lateId = String(h.sent[1]!.requestId);
  const rejected = assert.rejects(late, /timed out/);
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  await h.orch.handleMachineMessage(MACHINE, withPaths(lateId));
  for (const name of ["server.feedback_transcript.outcome", "server.feedback_transcript.late_result_rejected"]) {
    for (const span of h.spans(name)) assertNoPathAttrs(span.attrs, name);
  }
});

// ---------------------------------------------------------------------------
// Malformed typed fields (reviewer blocker 2). The WebSocket layer only
// JSON.parses, so every new diagnostic field is runtime-validated here.
// Malformed data is recorded as invalid and NEVER prevents the request from
// completing, and a malformed LATE frame never consumes the correlation entry.
// ---------------------------------------------------------------------------
const VALID_LOOKUP = (typedResult("x") as any).lookup as Record<string, unknown>;
const VALID_UPLOAD = (typedResult("x") as any).upload as Record<string, unknown>;
const MALFORMED: Array<[string, Record<string, unknown>]> = [
  ["missing fields (reviewer repro)", { outcomeVersion: 1, lookup: { reachable: false }, upload: { status: "not_attempted" } }],
  ["missing lookup", { lookup: undefined }],
  ["missing upload", { upload: undefined }],
  ["lookup not an object", { lookup: "native_session_file_not_found" }],
  ["lookup is an array", { lookup: [VALID_LOOKUP] }],
  ["lookup null", { lookup: null }],
  ["upload null", { upload: null }],
  ["wrong lookup enum", { lookup: { ...VALID_LOOKUP, content: "conversation_maybe" } }],
  ["wrong reason enum", { lookup: { ...VALID_LOOKUP, reasonCode: "agent_not_on_this_machine" } }],
  ["wrong upload enum", { upload: { ...VALID_UPLOAD, status: "uploaded_maybe" } }],
  ["extra lookup key (searchedPaths)", { lookup: { ...VALID_LOOKUP, searchedPaths: ["/srv/custom-private-workspace/agent/x"] } }],
  ["extra upload key", { upload: { ...VALID_UPLOAD, note: "free text" } }],
  ["huge string", { lookup: { ...VALID_LOOKUP, runtime: "x".repeat(200_000) } }],
  ["wrong type: reachable", { lookup: { ...VALID_LOOKUP, reachable: "yes" } }],
  ["wrong type: httpStatus", { upload: { ...VALID_UPLOAD, httpStatus: "500" } }],
  ["wrong type: sourceBytes", { lookup: { ...VALID_LOOKUP, sourceBytes: -1 } }],
  ["unknown outcomeVersion", { outcomeVersion: 2 }],
  ["typed fields without outcomeVersion", { outcomeVersion: undefined }],
  ["bad outcomeObject", { outcomeObject: "stored" }],
];

function malformed(requestId: string, shape: Record<string, unknown>): MachineToServerMessage {
  const msg = { ...(typedResult(requestId) as any), ...shape };
  for (const [k, v] of Object.entries(shape)) if (v === undefined) delete msg[k];
  return msg as MachineToServerMessage;
}

test("O9 on-time malformed typed fields: the request still resolves (legacy-compatible), the span marks the outcome invalid", async () => {
  for (const [name, shape] of MALFORMED) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const h = setup();
    let settled: { value?: any; error?: unknown } | null = null;
    h.request().then((value) => { settled = { value }; }, (error) => { settled = { error }; });
    await vi.waitFor(() => assert.equal(h.sent.length, 1));
    const requestId = String(h.sent[0]!.requestId);
    await h.deliver(MACHINE, malformed(requestId, shape) as never); // must not throw
    await vi.advanceTimersByTimeAsync(0);
    assert.ok(settled, `${name}: the request never completed`);
    const done = settled as { value?: any; error?: unknown };
    assert.equal(done.error, undefined, `${name}: rejected ${String(done.error)}`);
    assert.equal(done.value.reachable, false, name);
    assert.equal(done.value.fallbackReason, "native session file not found", name);
    for (const key of ["outcomeVersion", "lookup", "upload", "outcomeObject"]) {
      assert.equal(key in done.value, false, `${name}: unvalidated ${key} forwarded`);
    }
    const [span] = h.spans("server.feedback_transcript.request");
    assert.equal(span?.attrs?.state, "result", name);
    assert.equal(span?.attrs?.daemon_outcome, "invalid", name);
    assert.equal(span?.attrs?.daemon_typed, false, name);
    assert.equal(span?.attrs?.upload_status, "unknown", name);
    assert.equal(typeof span?.attrs?.daemon_outcome_invalid_reason, "string", name);
    assert.ok(String(span?.attrs?.daemon_outcome_invalid_reason).length <= 120, name);
    assert.equal(span?.attrs?.lookup_reason, undefined, name);
    for (const value of Object.values(span?.attrs ?? {})) {
      if (typeof value === "string") assert.ok(value.length <= 700 && !value.includes("/srv/"), `${name}: ${value.slice(0, 80)}`);
    }
    vi.useRealTimers();
  }
});

test("O10 on-time valid frame forwards only the validated projection; untyped legacy frame stays untyped", async () => {
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  await h.deliver(MACHINE, typedResult(String(h.sent[0]!.requestId)) as never);
  const outcome = await pending as any;
  assert.deepEqual(outcome.lookup, VALID_LOOKUP);
  assert.deepEqual(outcome.upload, VALID_UPLOAD);
  assert.equal(outcome.outcomeVersion, 1);
  assert.equal(outcome.outcomeObject, "attempt_after_result");
  assert.equal(h.spans("server.feedback_transcript.request")[0]?.attrs?.daemon_outcome, "typed");

  const legacy = setup();
  const legacyPending = legacy.request();
  await vi.waitFor(() => assert.equal(legacy.sent.length, 1));
  await legacy.deliver(MACHINE, { type: "agent:diagnostic:feedback_transcript_result", agentId: AGENT, feedbackReportId: REPORT, requestId: String(legacy.sent[0]!.requestId), reachable: true, traceBundleId: "b" });
  await legacyPending;
  assert.equal(legacy.spans("server.feedback_transcript.request")[0]?.attrs?.daemon_outcome, "untyped");
});

test("O11 late malformed frame: no throw, recorded invalid, correlation entry NOT consumed; a later valid frame is accepted once", async () => {
  for (const [name, shape] of MALFORMED) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const h = setup();
    const pending = h.request();
    await vi.waitFor(() => assert.equal(h.sent.length, 1));
    const requestId = String(h.sent[0]!.requestId);
    const rejected = assert.rejects(pending, /timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    assert.equal((h.orch as any).feedbackTranscriptLateResults.size(), 1, name);

    await h.orch.handleMachineMessage(MACHINE, malformed(requestId, shape)); // must not throw
    assert.equal(h.spans("server.feedback_transcript.outcome").length, 0, `${name}: invalid frame accepted`);
    const [rej] = h.spans("server.feedback_transcript.late_result_rejected");
    assert.equal(rej?.attrs?.reason, "invalid_outcome", name);
    assert.equal(typeof rej?.attrs?.daemon_outcome_invalid_reason, "string", name);
    assert.equal((h.orch as any).feedbackTranscriptLateResults.size(), 1, `${name}: correlation entry lost`);

    await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
    await h.orch.handleMachineMessage(MACHINE, typedResult(requestId));
    const accepted = h.spans("server.feedback_transcript.outcome");
    assert.equal(accepted.length, 1, `${name}: valid late frame not accepted exactly once`);
    assert.equal(accepted[0]?.attrs?.daemon_outcome, "typed", name);
    assert.equal(accepted[0]?.attrs?.lookup_reason, "native_session_file_not_found", name);
    vi.useRealTimers();
  }
});

test("O12 a malformed frame for an unrelated request never breaks message handling for the pending one", async () => {
  const h = setup();
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  await h.deliver(MACHINE, malformed("some-other-request", MALFORMED[0]![1]) as never);
  await h.deliver(MACHINE, typedResult(String(h.sent[0]!.requestId)) as never);
  const outcome = await pending as any;
  assert.equal(outcome.lookup?.reasonCode, "native_session_file_not_found");
});

// The daemon keeps an agent's config and session id in memory only. The
// request carries the launch fields and the session id the server stores for
// the agent, so a daemon that holds nothing (after its restart, or the
// agent's terminal failure) can still find the session file.
test("C1 the request carries the agent's runtime, model, session-home env var and stored session id; no other env var, no runtime settings, nothing else of its config", async () => {
  const h = setup();
  const envVars = { CODEX_HOME: "/srv/codex", ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-openai-secret", GROK_HOME: "/srv/grok" };
  (h.orch as any).loadAgentForDelivery = async (agentId: string) => (agentId === AGENT
    ? { id: AGENT, name: "secret-name", runtime: "codex", model: "gpt-5.6", runtimeConfig: { envVars: { ANTHROPIC_API_KEY: "sk-ant-in-runtime-config" } }, reasoningEffort: null, envVars, sessionId: "session-stored-on-server", serverId: "server-1", machineId: MACHINE }
    : null);
  const pending = h.request();
  await vi.waitFor(() => assert.equal(h.sent.length, 1));
  const lookup = h.sent[0]!.sessionLookup as Record<string, unknown>;
  assert.equal(lookup.runtime, "codex");
  assert.equal(lookup.model, "gpt-5.6");
  assert.deepEqual(lookup.sessionHomeEnv, { CODEX_HOME: "/srv/codex" }, "only what the Codex session directory depends on");
  assert.equal(lookup.sessionId, "session-stored-on-server");
  assert.deepEqual(Object.keys(lookup).sort(), ["model", "runtime", "sessionHomeEnv", "sessionId"]);
  // An agent's env vars are where API keys live: none of them is anywhere in the frame.
  const frame = JSON.stringify(h.sent[0]);
  for (const secret of ["sk-ant-secret", "sk-ant-in-runtime-config", "sk-openai-secret", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "secret-name", "/srv/grok"]) {
    assert.equal(frame.includes(secret), false, secret);
  }
  await h.deliver(MACHINE, typedResult(String(h.sent[0]!.requestId)) as never);
  await pending;
});

test("C2 a lookup that cannot be built never fails the request: it is sent without one", async () => {
  for (const failure of ["missing", "throws"] as const) {
    const h = setup();
    (h.orch as any).loadAgentForDelivery = async () => {
      if (failure === "throws") throw new Error("db unavailable");
      return null;
    };
    const pending = h.request();
    await vi.waitFor(() => assert.equal(h.sent.length, 1));
    assert.equal("sessionLookup" in h.sent[0]!, false, failure);
    await h.deliver(MACHINE, typedResult(String(h.sent[0]!.requestId)) as never);
    await pending;
  }
});
