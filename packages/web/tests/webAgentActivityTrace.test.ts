import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWebTraceRecord,
  flushAuthTraces,
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace.ts";
import {
  traceAgentActivitySocketReceived,
  traceAgentActivityStoreDecision,
  traceAgentActivityStatusDotApplied,
  deriveActivityDecisionRelation,
} from "../src/utils/webAgentActivityTrace.ts";

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
  const batches: Array<{ records?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
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

test("buildWebTraceRecord accepts web agent activity events and keeps attrs bounded", () => {
  const record = buildWebTraceRecord("slock.agent_activity.socket_received", {
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

  assert.equal(record.type, "span");
  assert.equal(record.schema_version, 1);
  assert.equal(record.surface, "web");
  assert.equal(record.name, "slock.agent_activity.socket_received");
  assert.match(record.trace_id, /^[0-9a-f]{32}$/);
  assert.match(record.span_id, /^[0-9a-f]{16}$/);

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
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    restoreLocalStorage();
  }

  const records = batches.flatMap((batch) => batch.records ?? []);
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
