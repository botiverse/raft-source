import assert from "node:assert/strict";

import {
  buildWebEventRecord,
  flushAuthTraces,
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";
import {
  traceAgentActivitySocketReceived,
  traceAgentActivityStoreDecision,
  traceAgentActivityStatusDotApplied,
  deriveActivityDecisionRelation,
  ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE,
  setAgentActivityTraceRandomForTests,
  traceDetailKind,
} from "../src/utils/webAgentActivityTrace";
import { resetPrivacyModeForTests, setPrivacyMode } from "../src/store/privacyMode";

function installLocalStorageForTraceTest(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function captureWebTraceBatches() {
  const batches: Array<{ events?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-1");
  setAuthTracePrincipalIdGetter(() => "user-1");
  localStorage.setItem("slock_access_token", "token-1");
  setAuthTraceFetchForTest(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/scope-attestation")) {
      return new Response(JSON.stringify({ attestation: "attestation-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    batches.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  });
  return batches;
}

test("buildWebEventRecord accepts web agent activity events and keeps attrs bounded", () => {
  const record = buildWebEventRecord("slock.agent_activity.socket_received", {
    agent_id_present: true,
    activity: "working",
    detail_present: true,
    detail_length_bucket: "medium",
    launch_id_present: true,
    client_seq_present: true,
    probe_id_present: true,
    server_seq_present: true,
    join: { clientEventId: "client-event-1" },
    rawDetail: undefined,
  });

  assert.equal(record.type, "event");
  assert.equal(record.schema_version, 1);
  assert.equal(record.surface, "web");
  assert.equal(record.name, "slock.agent_activity.socket_received");
  assert.equal(typeof record.time, "string");

  const attrs = record.attrs ?? {};
  assert.equal(attrs.agent_id_present, true);
  assert.equal(attrs.activity, "working");
  assert.equal(attrs.detail_present, true);
  assert.equal(attrs.detail_length_bucket, "medium");
  assert.equal(attrs.launch_id_present, true);
  assert.equal(attrs.client_seq_present, true);
  assert.equal(attrs.probe_id_present, true);
  assert.equal(attrs.server_seq_present, true);
  assert.deepEqual(attrs.join, { clientEventId: "client-event-1" });
  assert.equal("client_event_id" in attrs, false);
  assert.ok(typeof attrs.tabId === "string" && (attrs.tabId as string).length > 0);
  assert.ok("releaseSha" in attrs);
  assert.ok("deploymentEnv" in attrs);
  assert.equal("rawDetail" in attrs, false);
});

test("agent activity trace wrappers are fire-and-forget no-ops when receiver is disabled", () => {
  __resetAuthTraceForTest();
  assert.doesNotThrow(() =>
    traceAgentActivitySocketReceived({
      agentId: "agent-abc",
      activity: "surprising-runtime-value",
      detail: "raw detail must not leave this helper",
      hasEntries: true,
      launchId: "launch-1",
      clientSeq: 7,
      probeId: "probe-1",
      serverSeq: 9,
      timestamp: Date.now(),
      join: { clientEventId: "client-event-1" },
    }),
  );
  assert.doesNotThrow(() =>
    traceAgentActivityStoreDecision({
      agentId: "agent-abc",
      activity: "working",
      detail: "",
      outcome: "applied",
      previousActivity: "online",
      nextActivity: "working",
      join: { clientEventId: "client-event-1" },
    }),
  );
  assert.doesNotThrow(() =>
    traceAgentActivityStatusDotApplied({
      agentId: "agent-abc",
      activity: "working",
      isOnline: true,
      isExternal: false,
      join: { clientEventId: "client-event-1" },
    }),
  );
});

test("agent activity trace wrappers preserve non-empty clientEventId only inside join", async () => {
  const restoreLocalStorage = installLocalStorageForTraceTest();
  const batches = captureWebTraceBatches();
  // The refresh-only push below is routine: sampled in for this test.
  setAgentActivityTraceRandomForTests(() => 0);

  try {
    traceAgentActivitySocketReceived({
      agentId: "agent-abc",
      activity: "working",
      detail: "bounded by helper",
      hasEntries: true,
      launchId: "launch-1",
      clientSeq: 7,
      probeId: "probe-1",
      serverSeq: 9,
      timestamp: 100,
      isHeartbeat: false,
      isRefreshOnly: true,
      join: { clientEventId: "client-event-1" },
    });
    traceAgentActivityStoreDecision({
      agentId: "agent-abc",
      activity: "working",
      outcome: "applied",
      previousActivity: "online",
      nextActivity: "working",
      join: { clientEventId: "" },
    });
    traceAgentActivityStatusDotApplied({
      agentId: "agent-abc",
      activity: "working",
      isOnline: true,
      isExternal: false,
      join: {},
    });
    await flushAuthTraces();
  } finally {
    setAgentActivityTraceRandomForTests(null);
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    restoreLocalStorage();
  }

  const records = batches.flatMap((batch) => batch.events ?? []);
  assert.equal(records[0].attrs?.sample_rate, ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE, "a sampled routine push says its rate");
  assert.equal("sample_rate" in (records[1].attrs ?? {}), false, "a display change is traced in full");
  assert.deepEqual(records.map((record) => record.name), [
    "slock.agent_activity.socket_received",
    "slock.agent_activity.store_decision",
    "slock.agent_activity.status_dot_applied",
  ]);
  assert.deepEqual(records[0].attrs?.join, { clientEventId: "client-event-1" });
  assert.equal(records[0].attrs?.is_heartbeat, false);
  assert.equal(records[0].attrs?.is_refresh_only, true);
  assert.equal("is_heartbeat" in (records[1].attrs ?? {}), false);
  assert.equal("is_refresh_only" in (records[1].attrs ?? {}), false);
  assert.equal("join" in (records[1].attrs ?? {}), false);
  assert.equal("join" in (records[2].attrs ?? {}), false);
  for (const record of records) {
    assert.equal("client_event_id" in (record.attrs ?? {}), false);
  }
});

test("deriveActivityDecisionRelation emits closed-set, value-free decision attrs (#161)", () => {
  // stale drop across a launch change (the reset-suspect case): serverSeq lte,
  // launch changed → readable without any raw id/seq.
  assert.deepEqual(
    deriveActivityDecisionRelation({ launchId: "B", lastLaunchId: "A", serverSeq: 1, lastServerSeq: 500 }),
    { last_launch_id_present: true, launch_changed: "true", same_launch: "false", seq_relation: "lte", dedup_scope: "server_seq" },
  );
  // within-launch out-of-order drop: same launch, seq lte.
  assert.deepEqual(
    deriveActivityDecisionRelation({ launchId: "A", lastLaunchId: "A", serverSeq: 3, lastServerSeq: 5 }),
    { last_launch_id_present: true, launch_changed: "false", same_launch: "true", seq_relation: "lte", dedup_scope: "server_seq" },
  );
  // normal applied: same launch, seq gt.
  assert.deepEqual(
    deriveActivityDecisionRelation({ launchId: "A", lastLaunchId: "A", serverSeq: 6, lastServerSeq: 5 }),
    { last_launch_id_present: true, launch_changed: "false", same_launch: "true", seq_relation: "gt", dedup_scope: "server_seq" },
  );
  // first push for an agent (no baseline launch): unknown launch relation.
  assert.deepEqual(
    deriveActivityDecisionRelation({ launchId: "A", lastLaunchId: undefined, serverSeq: 1, lastServerSeq: undefined }),
    { last_launch_id_present: false, launch_changed: "unknown", same_launch: "unknown", seq_relation: "absent", dedup_scope: "server_seq" },
  );
  // old server path (no serverSeq): dedup not applied, seq absent.
  assert.deepEqual(
    deriveActivityDecisionRelation({ launchId: undefined, lastLaunchId: undefined, serverSeq: undefined, lastServerSeq: undefined }),
    { last_launch_id_present: false, launch_changed: "unknown", same_launch: "unknown", seq_relation: "absent", dedup_scope: "none" },
  );

  // No raw ids/seqs leak: every value is a bounded enum/boolean.
  const rel = deriveActivityDecisionRelation({ launchId: "launch-secret", lastLaunchId: "launch-other", serverSeq: 12345, lastServerSeq: 99999 });
  for (const v of Object.values(rel)) {
    assert.ok(typeof v === "boolean" || ["true", "false", "unknown", "gt", "lte", "absent", "server_seq", "none"].includes(v as string));
  }
});

test("routine agent activity is traced at the sample rate; display changes and anomalies always", async () => {
  const restoreLocalStorage = installLocalStorageForTraceTest();
  const batches = captureWebTraceBatches();
  setAgentActivityTraceRandomForTests(() => 0.5);
  try {
    traceAgentActivitySocketReceived({ agentId: "a", activity: "online", isHeartbeat: true });
    traceAgentActivitySocketReceived({ agentId: "a", activity: "online", isRefreshOnly: true });
    traceAgentActivityStoreDecision({ agentId: "a", activity: "online", outcome: "applied", previousActivity: "online", nextActivity: "online" });
    // A detail-only change ("Running command" -> "Editing file") keeps the activity: routine too.
    traceAgentActivityStoreDecision({ agentId: "a", activity: "working", detail: "Editing file", outcome: "applied", previousActivity: "working", nextActivity: "working" });
    // Same activity as before (a detail-only push, most of real traffic): routine.
    traceAgentActivitySocketReceived({ agentId: "a", activity: "working", detail: "Subagent working…", previousActivity: "working" });
    // No previous activity known, or a different one: traced in full.
    traceAgentActivitySocketReceived({ agentId: "b", activity: "working" });
    // The store has nothing for it, but its last push had the same activity: routine.
    traceAgentActivitySocketReceived({ agentId: "b", activity: "working", detail: "Subagent working…", previousActivity: null });
    traceAgentActivitySocketReceived({ agentId: "b", activity: "working", detail: "Running command" });
    // The store knows a different activity (a snapshot set it offline): a real change, traced in full.
    traceAgentActivitySocketReceived({ agentId: "b", activity: "working", previousActivity: "offline" });
    traceAgentActivityStoreDecision({ agentId: "a", activity: "working", outcome: "applied", previousActivity: "online", nextActivity: "working" });
    traceAgentActivityStoreDecision({ agentId: "a", activity: "working", outcome: "stale_server_seq", previousActivity: "working", nextActivity: "working" });
    await flushAuthTraces();
  } finally {
    setAgentActivityTraceRandomForTests(null);
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    restoreLocalStorage();
  }
  const records = batches.flatMap((batch) => batch.events ?? []);
  assert.deepEqual(records.map((record) => [record.name, record.attrs?.outcome]), [
    ["slock.agent_activity.socket_received", "received"],
    ["slock.agent_activity.socket_received", "received"],
    ["slock.agent_activity.store_decision", "applied"],
    ["slock.agent_activity.store_decision", "stale_server_seq"],
  ], "heartbeat, refresh-only and unchanged-display pushes are left out above the sample rate");
  for (const record of records) assert.equal("sample_rate" in (record.attrs ?? {}), false);
});

// --- Q8 exception: launch_id + client_seq (and nothing else) go out raw ---

const LAUNCH_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
// Raw ids that must never leave the helper, whatever else is emitted.
const AGENT_ID = "agent-7d1e0c4a";
const PROBE_ID = "probe-55aa";
const DETAIL = "Running command in #secret-channel for alice@example.com";

type CapturedEvent = { name?: string; attrs?: Record<string, unknown> };

async function captureAgentActivityEvents(emit: () => void): Promise<CapturedEvent[]> {
  const restoreLocalStorage = installLocalStorageForTraceTest();
  const batches = captureWebTraceBatches();
  try {
    emit();
    await flushAuthTraces();
  } finally {
    setAgentActivityTraceRandomForTests(null);
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    restoreLocalStorage();
  }
  return batches.flatMap((batch) => batch.events ?? []);
}

function emitAllThree(launchId: unknown, clientSeq: unknown, agentId = AGENT_ID): void {
  traceAgentActivitySocketReceived({
    agentId, activity: "working", detail: DETAIL, detailKind: "running_command",
    launchId: launchId as string, clientSeq: clientSeq as number, probeId: PROBE_ID, serverSeq: 41, timestamp: 1_700_000_000_000,
    join: { clientEventId: "client-event-1" },
  });
  traceAgentActivityStoreDecision({
    agentId, activity: "working", detail: DETAIL, detailKind: "running_command",
    launchId: launchId as string, clientSeq: clientSeq as number, probeId: PROBE_ID, serverSeq: 41, lastServerSeq: 40,
    lastLaunchId: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
    outcome: "applied", previousActivity: "online", nextActivity: "working",
  });
  traceAgentActivityStatusDotApplied({ agentId, activity: "working", isOnline: true, isExternal: false, surface: "sidebar" });
}

test("socket_received and store_decision carry raw launch_id/client_seq; status_dot_applied does not", async () => {
  const records = await captureAgentActivityEvents(() => emitAllThree(LAUNCH_ID, 7));
  assert.deepEqual(records.map((r) => r.name), [
    "slock.agent_activity.socket_received",
    "slock.agent_activity.store_decision",
    "slock.agent_activity.status_dot_applied",
  ]);
  for (const record of records.slice(0, 2)) {
    assert.equal(record.attrs?.launch_id, LAUNCH_ID);
    assert.equal(record.attrs?.client_seq, 7);
    assert.equal(record.attrs?.launch_id_present, true, "the presence boolean stays");
    assert.equal(record.attrs?.client_seq_present, true, "the presence boolean stays");
  }
  assert.equal("launch_id" in (records[2].attrs ?? {}), false);
  assert.equal("client_seq" in (records[2].attrs ?? {}), false);
});

test("no raw id other than launch_id/client_seq leaks: agent id, probe id, server seq, baseline launch, detail, server/user id", async () => {
  const records = await captureAgentActivityEvents(() => emitAllThree(LAUNCH_ID, 7));
  assert.equal(records.length, 3);
  for (const record of records) {
    const attrs = record.attrs ?? {};
    const json = JSON.stringify(attrs);
    for (const forbidden of [AGENT_ID, PROBE_ID, "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a", DETAIL, "secret-channel", "alice@example.com", "server-1", "user-1"]) {
      assert.equal(json.includes(forbidden), false, `${record.name} leaks ${forbidden}`);
    }
    for (const key of ["agent_id", "agentId", "message_id", "messageId", "channel_id", "channelId", "server_id", "serverId",
      "user_id", "userId", "probe_id", "probeId", "server_seq", "serverSeq", "last_launch_id", "lastLaunchId", "launchId", "clientSeq", "detail"]) {
      assert.equal(key in attrs, false, `${record.name} has raw ${key}`);
    }
    // Every value is a boolean, a closed-set string, a bounded number, the join
    // object, or one of the two approved raw keys.
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "launch_id") assert.equal(value, LAUNCH_ID);
      if (key === "client_seq") assert.equal(value, 7);
      if (typeof value === "number") assert.ok(["client_seq", "sample_rate", "webAssetId"].includes(key), `${record.name}: unexpected number ${key}`);
    }
  }
});

test("a launch_id that is not a UUID or a client_seq that is not a non-negative safe integer falls back to the boolean only", async () => {
  const cases: Array<[unknown, unknown]> = [
    ["launch-1", 7],
    ["unbound:" + LAUNCH_ID, 7],
    [`${LAUNCH_ID} `, 7],
    [AGENT_ID, 7],
    [LAUNCH_ID, -1],
    [LAUNCH_ID, 1.5],
    [LAUNCH_ID, "7"],
    [LAUNCH_ID, Number.NaN],
    [LAUNCH_ID, Number.MAX_SAFE_INTEGER + 2],
  ];
  for (const [launchId, clientSeq] of cases) {
    const records = await captureAgentActivityEvents(() => emitAllThree(launchId, clientSeq));
    const label = `${String(launchId)} / ${String(clientSeq)}`;
    for (const record of records.slice(0, 2)) {
      const attrs = record.attrs ?? {};
      const launchOk = launchId === LAUNCH_ID;
      const seqOk = clientSeq === 7;
      assert.equal("launch_id" in attrs, launchOk, `${label}: launch_id emitted only when a UUID`);
      assert.equal("client_seq" in attrs, seqOk, `${label}: client_seq emitted only when a non-negative integer`);
      assert.equal(attrs.launch_id_present, true, `${label}: launch_id_present unchanged`);
      // client_seq_present stays as it always was: a number was given.
      assert.equal(attrs.client_seq_present, typeof clientSeq === "number", `${label}: client_seq_present unchanged`);
      assert.equal(JSON.stringify(attrs).includes(String(launchId)) && !launchOk, false, `${label}: bad launch id never passes through`);
    }
  }
  // Absent stays absent.
  const absent = await captureAgentActivityEvents(() => emitAllThree(undefined, undefined));
  for (const record of absent.slice(0, 2)) {
    assert.equal(record.attrs?.launch_id_present, false);
    assert.equal(record.attrs?.client_seq_present, false);
    assert.equal("launch_id" in (record.attrs ?? {}), false);
    assert.equal("client_seq" in (record.attrs ?? {}), false);
  }
  // client_seq 0 is a valid sequence number.
  const zero = await captureAgentActivityEvents(() => emitAllThree(LAUNCH_ID, 0));
  assert.equal(zero[0].attrs?.client_seq, 0);
});

test("launch_id and client_seq are exactly the server/daemon correlation_id parts", async () => {
  const clientSeq = 12;
  const records = await captureAgentActivityEvents(() => emitAllThree(LAUNCH_ID, clientSeq));
  // The synthetic key the server (agentOrchestrator.ts daemonActivityJoinTraceAttrs)
  // and the daemon (connection.ts, activity/activitySink.ts) put on their activity spans.
  const correlationId = `agent:${AGENT_ID}:daemonActivity:${LAUNCH_ID}:${clientSeq}`;
  const [, , kind, launchPart, seqPart] = correlationId.split(":");
  assert.equal(kind, "daemonActivity");
  for (const record of records.slice(0, 2)) {
    assert.equal(record.attrs?.launch_id, launchPart, `${record.name}: launch_id joins the server's launch_id`);
    assert.equal(String(record.attrs?.client_seq), seqPart, `${record.name}: client_seq joins the server's client_seq`);
  }
});

test("detail_kind is a closed set: a registered kind passes, an unregistered string becomes other, absent is unknown", async () => {
  assert.equal(traceDetailKind("running_command"), "running_command");
  assert.equal(traceDetailKind("none"), "none");
  assert.equal(traceDetailKind("other"), "other");
  assert.equal(traceDetailKind("display_text_changed"), "other");
  assert.equal(traceDetailKind("alice@example.com"), "other");
  assert.equal(traceDetailKind(""), "other");
  assert.equal(traceDetailKind(null), "unknown");
  assert.equal(traceDetailKind(undefined), "unknown");

  const records = await captureAgentActivityEvents(() => {
    traceAgentActivitySocketReceived({ agentId: "a", activity: "working", detailKind: "free text from somewhere" });
    traceAgentActivityStoreDecision({ agentId: "a", activity: "working", detailKind: "tool_started", outcome: "applied", previousActivity: "online", nextActivity: "working" });
    traceAgentActivityStatusDotApplied({ agentId: "a", activity: "working" });
  });
  assert.deepEqual(records.map((r) => r.attrs?.detail_kind), ["other", "tool_started", "unknown"]);
});

test("privacy mode on: agent activity events, join keys included, are never uploaded", async () => {
  const restoreLocalStorage = installLocalStorageForTraceTest();
  const batches = captureWebTraceBatches();
  resetPrivacyModeForTests();
  setPrivacyMode(true);
  try {
    emitAllThree(LAUNCH_ID, 7);
    await flushAuthTraces();
  } finally {
    resetPrivacyModeForTests();
    setPrivacyMode(false);
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    restoreLocalStorage();
  }
  assert.deepEqual(batches, []);
});
