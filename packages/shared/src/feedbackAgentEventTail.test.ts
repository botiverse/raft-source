// task #1230: the agent_event_tail attachment contract. One strict parser is
// the only definition of a readable object; the projection/bounding helpers
// are tested against it, and the Lens reader rules (correlation, download,
// empty-list wording) are pure functions over parsed values.
import assert from "node:assert/strict";
import {
  AgentEventTailAccumulator,
  FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS,
  FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES,
  FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS,
  buildBoundedFeedbackAgentEventTail,
  buildFailedFeedbackAgentEventTail,
  classifyFeedbackReportLedgerEntry,
  describeAgentEventTailEvents,
  parseFeedbackAgentEventTail,
  parseFeedbackAgentEventTailJson,
  readAgentEventTailAttachment,
  type FeedbackAgentEventTail,
  type FeedbackAgentEventTailOk,
  type FeedbackAgentEventTailScan,
} from "./index";

function asOk(p: FeedbackAgentEventTail): FeedbackAgentEventTailOk {
  if (p.collection.status !== "ok") assert.fail(`expected ok, got ${JSON.stringify(p.collection)}`);
  return p as FeedbackAgentEventTailOk;
}

const REPORT = "6f1c2a52-0d4e-4c8b-9a51-3e2f7b9d1c40";
const AGENT = "0b7e4f9a-5c21-4d36-8e1f-a2c94d7b6e15";
const OTHER_AGENT = "11111111-2222-4333-8444-555555555555";
const REQUEST = "req-1";
const WINDOW = { requestedFrom: "2026-10-08T03:15:00.000Z", requestedTo: "2026-10-08T03:30:00.000Z" };
const SERVER = "a0a0a0a0-0000-4000-8000-000000000001";
const MACHINE = "b0b0b0b0-0000-4000-8000-000000000002";
const COMPLETE_SCAN: FeedbackAgentEventTailScan = {
  status: "complete", stopReason: null, filesListed: 2, filesScanned: 2, filesUnreadable: 0, bytesScanned: 4096, maxFiles: 16, maxBytes: 33554432,
};

function at(minute: number, second = 0): string {
  return new Date(Date.parse(WINDOW.requestedFrom) + minute * 60_000 + second * 1000).toISOString();
}

function event(name: string, time: string, attrs: Record<string, unknown>) {
  return { type: "event", schema_version: 1, name, surface: "daemon", time, attrs: { agentId: AGENT, agent_id: AGENT, ...attrs } };
}

function build(records: unknown[], opts: { scan?: FeedbackAgentEventTailScan; maxBytes?: number; agentId?: string } = {}) {
  const acc = new AgentEventTailAccumulator({ agentId: opts.agentId ?? AGENT, window: WINDOW });
  for (const r of records) acc.addRecord(r);
  return buildBoundedFeedbackAgentEventTail({
    feedbackReportId: REPORT, agentId: opts.agentId ?? AGENT, requestId: REQUEST, window: WINDOW,
    scan: opts.scan ?? COMPLETE_SCAN, accumulator: acc, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
  });
}

function okEnvelope() {
  const built = build([event("daemon.agent.inbox.dropped_on_exit", at(1), { exit_reason: "silent_stop", dropped_count: 2, expected: true, launchId: "launch-1" })]);
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return JSON.parse(built.json) as Record<string, any>;
}

// --- whitelist / projection ---------------------------------------------------

test("T2 field whitelist: sentinels in non-whitelisted keys and out-of-enum values never reach the serialized object", () => {
  const SENTINELS = ["SENTINEL_TARGETS", "SENTINEL_MODEL", "SENTINEL_RUNTIME", "SENTINEL_PRIOR", "SENTINEL_CAUSE", "/Users/alice/secret", "SENTINEL_TOKEN", "SENTINEL_SOURCE", "SENTINEL_EXIT"];
  const built = build([
    event("daemon.agent.inbox.visible_consumed", at(1), { source: "SENTINEL_SOURCE", targets: ["SENTINEL_TARGETS"], messages_count: 1, suppressed_pending_count: 0, token: "SENTINEL_TOKEN" }),
    event("daemon.agent.spawn.started", at(2), { model: "SENTINEL_MODEL", runtime: "SENTINEL_RUNTIME", wake_message_present: true, launchId: "launch-1", cwd: "/Users/alice/secret" }),
    event("daemon.agent.wake_recycle", at(3), { reason: "cold_gap_large_context", prior_session_id: "SENTINEL_PRIOR" }),
    event("daemon.runtime.process.exit", at(4), { exit_code: 1, exit_signal: "SIGTERM", cause: "SENTINEL_CAUSE", launch_id: "launch-1" }),
    event("daemon.agent.inbox.dropped_on_exit", at(5), { exit_reason: "SENTINEL_EXIT", dropped_count: 1, expected: false }),
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  for (const s of SENTINELS) assert.ok(!built.json.includes(s), `sentinel ${s} leaked`);
  const parsed = asOk(parseFeedbackAgentEventTailJson(built.json));
  for (const e of parsed.events) {
    assert.deepEqual(Object.keys(e.attrs).sort(), Object.keys(FEEDBACK_AGENT_EVENT_TAIL_EVENT_SPECS[e.name].attrs).sort(), e.name);
  }
  const consumed = parsed.events.find((e) => e.name === "daemon.agent.inbox.visible_consumed")!;
  assert.equal(consumed.attrs.source, "other", "an open-family enum folds unknown values into `other`");
  const dropped = parsed.events.find((e) => e.name === "daemon.agent.inbox.dropped_on_exit")!;
  assert.equal(dropped.attrs.exit_reason, null, "a closed enum withholds an unknown value");
  assert.equal(parsed.counts.attrInvalidValues, 1);
  assert.equal(parsed.counts.eventsWithInvalidAttrs, 1);
  const exit = parsed.events.find((e) => e.name === "daemon.runtime.process.exit")!;
  assert.equal(exit.attrs.launchId, "launch-1", "launch_id spelling is read into launchId");
});

test("T3/T4 names and agent scope: daemon-level and other-agent records are counted, never emitted", () => {
  const built = build([
    { type: "event", name: "daemon.agent.stop_all", time: at(1), attrs: { agent_count: 3 } },
    { type: "event", name: "daemon.lifecycle.start", time: at(1), attrs: {} },
    { type: "event", name: "daemon.agent.inbox.dropped_on_exit", time: at(2), attrs: { exit_reason: "silent_stop", dropped_count: 1, expected: true } },
    event("daemon.agent.inbox.dropped_on_exit", at(3), { agentId: OTHER_AGENT, agent_id: OTHER_AGENT, exit_reason: "silent_stop", dropped_count: 1, expected: true }),
    event("daemon.agent.inbox.dropped_on_exit", at(4), { exit_reason: "silent_stop", dropped_count: 2, expected: true }),
    event("daemon.agent.inbox.dropped_on_exit", "2026-10-08T02:00:00.000Z", { exit_reason: "silent_stop", dropped_count: 2, expected: true }),
    { type: "event", name: "daemon.agent.inbox.dropped_on_exit", attrs: { agentId: AGENT } },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const p = asOk(parseFeedbackAgentEventTailJson(built.json));
  assert.deepEqual(p.events.map((e) => e.at), [at(4)]);
  assert.equal(p.counts.notWhitelisted, 2);
  assert.equal(p.counts.unattributed, 1);
  assert.equal(p.counts.otherAgent, 1);
  assert.equal(p.counts.outsideWindow, 1);
  assert.equal(p.counts.undatable, 1);
  assert.equal(p.counts.recordsRead, 7);
});

test("T5 bounds: count cap keeps the newest 200; byte cap measured on the whole object; zero-event overflow is a failure object, never an empty one", () => {
  const many = Array.from({ length: 1000 }, (_, i) => event("daemon.agent.model_seen.reported", at(0, i % 900), { conversations_count: 1, messages_count: i, launchId: "launch-1" }));
  const built = build(many);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const p = asOk(parseFeedbackAgentEventTailJson(built.json));
  assert.ok(p.counts.emitted <= FEEDBACK_AGENT_EVENT_TAIL_MAX_EVENTS);
  assert.equal(p.counts.overCount, 800);
  assert.equal(p.counts.matched, p.counts.emitted + p.counts.overCount + p.counts.overBytes);
  assert.equal(p.truncated, true);
  assert.ok(new TextEncoder().encode(built.json).byteLength <= FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES);
  assert.ok(p.events.at(-1)!.at >= p.events[0]!.at, "oldest→newest");

  const small = build(many.slice(0, 50), { maxBytes: 2500 });
  assert.equal(small.ok, true);
  if (!small.ok) return;
  const sp = asOk(parseFeedbackAgentEventTail(JSON.parse(small.json), { maxBytes: 2500 }));
  assert.ok(sp.counts.overBytes > 0);
  assert.ok(small.bytes <= 2500);

  const none = build(many.slice(0, 5), { maxBytes: 600 });
  assert.equal(none.ok, true);
  if (!none.ok) return;
  const np = parseFeedbackAgentEventTail(JSON.parse(none.json), { maxBytes: 600 });
  assert.deepEqual(np.collection, { status: "failed", failure: "over_byte_cap" });
  assert.equal("events" in np, false);
  assert.equal("counts" in np, false);
});

// --- parser invariants: each one has a violating fixture -------------------------

const VIOLATIONS: Array<[string, (o: Record<string, any>) => void]> = [
  ["ok with a failure", (o) => { o.collection.failure = "corpus_unreadable"; }],
  ["failed without a failure", (o) => { o.collection = { status: "failed", failure: null }; delete o.scan; delete o.counts; delete o.truncated; delete o.events; }],
  ["failed still carrying result fields", (o) => { o.collection = { status: "failed", failure: "projection_error" }; }],
  ["window out of order", (o) => { o.window = { requestedFrom: WINDOW.requestedTo, requestedTo: WINDOW.requestedFrom }; }],
  ["non-canonical timestamp", (o) => { o.window.requestedFrom = "2026-10-08T03:15:00Z"; }],
  ["coverage other than unknown", (o) => { o.coverage.status = "complete_with_evidence"; }],
  ["coveredFrom non-null", (o) => { o.coverage.coveredFrom = WINDOW.requestedFrom; }],
  ["eventsWithInvalidAttrs > emitted", (o) => { o.counts.eventsWithInvalidAttrs = 2; o.counts.attrInvalidValues = 2; }],
  ["attrInvalidValues < eventsWithInvalidAttrs", (o) => { o.counts.eventsWithInvalidAttrs = 1; o.counts.attrInvalidValues = 0; }],
  ["matched ≠ emitted+overCount+overBytes", (o) => { o.counts.matched = 5; o.counts.recordsRead += 4; }],
  ["recordsRead ≠ buckets", (o) => { o.counts.recordsRead += 1; }],
  ["overCount not the count-cap remainder", (o) => { o.counts.overCount = 1; o.counts.matched += 1; o.counts.recordsRead += 1; o.truncated = true; }],
  ["truncated disagrees with counters", (o) => { o.truncated = true; }],
  ["emitted ≠ events.length", (o) => { o.counts.emitted = 0; o.counts.overBytes = 1; o.truncated = true; }],
  ["unknown top-level key", (o) => { o.extra = 1; }],
  ["free-form attr", (o) => { o.events[0].attrs.note = "x"; }],
  ["missing attr key", (o) => { delete o.events[0].attrs.expected; }],
  ["enum value outside table", (o) => { o.events[0].attrs.exit_reason = "made_up"; }],
  ["invalid id", (o) => { o.events[0].attrs.launchId = "has space"; }],
  ["event outside window", (o) => { o.events[0].at = "2026-10-08T04:00:00.000Z"; }],
  ["unknown event name", (o) => { o.events[0].name = "daemon.agent.stop_all"; }],
  ["requestId missing", (o) => { o.requestId = null; }],
  ["agentId not a uuid", (o) => { o.agentId = "agent-1"; }],
  ["scan complete but stopped", (o) => { o.scan.stopReason = "max_files"; }],
  ["scan incomplete without a reason", (o) => { o.scan.status = "incomplete"; }],
  ["scan stop reason outside enum", (o) => { o.scan = { ...o.scan, status: "incomplete", stopReason: "cancelled" }; }],
  ["scan read more files than listed", (o) => { o.scan.filesScanned = 3; }],
  ["schema_version 2", (o) => { o.schema_version = 2; }],
  ["window not 15 minutes", (o) => { o.window.requestedFrom = "2026-10-08T03:14:00.000Z"; }],
  ["records read with no file scanned", (o) => { o.scan = { ...o.scan, status: "incomplete", stopReason: "busy", filesScanned: 0, bytesScanned: 0 }; }],
];

test("busy is a valid scan stop reason (single-flight scan) and scopes zero matches to the scanned part", () => {
  const busy = build([], { scan: { ...COMPLETE_SCAN, status: "incomplete", stopReason: "busy", filesScanned: 0, bytesScanned: 0 } });
  if (!busy.ok) assert.fail();
  assert.deepEqual(describeAgentEventTailEvents(parseFeedbackAgentEventTailJson(busy.json)), { kind: "no_matching_events", scope: "scanned_part_only" });
});

for (const [name, mutate] of VIOLATIONS) {
  test(`parser rejects: ${name}`, () => {
    const o = okEnvelope();
    parseFeedbackAgentEventTail(structuredClone(o));
    mutate(o);
    assert.throws(() => parseFeedbackAgentEventTail(o));
  });
}

test("parser rejects any decompressed JSON over 32 KiB, metadata included", () => {
  const o = okEnvelope();
  const text = JSON.stringify(o) + " ".repeat(FEEDBACK_AGENT_EVENT_TAIL_MAX_BYTES);
  assert.throws(() => parseFeedbackAgentEventTailJson(text), /32768/);
});

// --- empty-list semantics (Lens B.1) -------------------------------------------

test("B.1 empty list: only matched=0 is 'no matching events'; matched>0 shown 0 says so; scan incomplete scopes zero to the scanned part", () => {
  const empty = build([]);
  if (!empty.ok) assert.fail();
  assert.deepEqual(describeAgentEventTailEvents(parseFeedbackAgentEventTailJson(empty.json)), { kind: "no_matching_events", scope: "all_listed_files" });

  const partial = build([], { scan: { ...COMPLETE_SCAN, status: "incomplete", stopReason: "max_bytes", filesScanned: 1 } });
  if (!partial.ok) assert.fail();
  assert.deepEqual(describeAgentEventTailEvents(parseFeedbackAgentEventTailJson(partial.json)), { kind: "no_matching_events", scope: "scanned_part_only" });

  // matched 3, shown 0: every matched event fell to the byte cap.
  const o = okEnvelope();
  o.events = [];
  o.counts = { ...o.counts, matched: 1, emitted: 0, overBytes: 1, attrInvalidValues: 0, eventsWithInvalidAttrs: 0 };
  o.truncated = true;
  assert.deepEqual(describeAgentEventTailEvents(parseFeedbackAgentEventTail(o)), { kind: "matched_none_shown", matched: 1, scope: "all_listed_files" });
});

// --- reader: correlation, unreadable, download (Lens B.4 / B.5) ---------------

function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "daemon_trace_upload",
    feedback_attachment_kind: "agent_event_tail",
    feedback_report_id: REPORT,
    agent_id: AGENT,
    request_id: REQUEST,
    server_id: SERVER,
    machine_id: MACHINE,
    object_key: `feedback-agent-event-tails/${SERVER}/${MACHINE}/c0c0c0c0-0000-4000-8000-000000000003.json.gz`,
    ...overrides,
  };
}
const report = { feedbackReportId: REPORT, agentId: AGENT, serverId: SERVER };

test("B.4 requestId rules: equal → verified; ledger without request_id → displayable but unverified; unequal → rejected, no download", () => {
  const text = JSON.stringify(okEnvelope());
  const ok = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "ok", text } });
  assert.equal(ok.state, "readable");
  if (ok.state === "readable") assert.deepEqual(ok.requestAssociation, { status: "verified", requestId: REQUEST });
  assert.equal(ok.downloadAllowed, true);

  const noLedgerRequest = readAgentEventTailAttachment({ report, ledger: ledger({ request_id: undefined }), object: { status: "ok", text } });
  assert.equal(noLedgerRequest.state, "readable");
  if (noLedgerRequest.state === "readable") assert.deepEqual(noLedgerRequest.requestAssociation, { status: "unverified", requestId: REQUEST });

  const mismatch = readAgentEventTailAttachment({ report, ledger: ledger({ request_id: "req-2" }), object: { status: "ok", text } });
  assert.equal(mismatch.state, "identity_mismatch");
  assert.equal(mismatch.downloadAllowed, false);
});

test("B.4 agent must equal the REPORT's agent, not only the ledger's", () => {
  const o = okEnvelope();
  o.agentId = OTHER_AGENT;
  const text = JSON.stringify(o);
  const both = readAgentEventTailAttachment({ report, ledger: ledger({ agent_id: OTHER_AGENT }), object: { status: "ok", text } });
  assert.equal(both.state, "identity_mismatch", "ledger and object agree with each other but not with the report");
  assert.equal(both.downloadAllowed, false);
  const objOnly = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "ok", text } });
  assert.equal(objOnly.state, "identity_mismatch");
  const otherReport = readAgentEventTailAttachment({ report, ledger: ledger({ feedback_report_id: OTHER_AGENT }), object: { status: "ok", text: JSON.stringify(okEnvelope()) } });
  assert.equal(otherReport.state, "identity_mismatch");
});

test("B.5 unreadable but correlated → download allowed; bad object prefix → no download; missing object → nothing to download", () => {
  const v2 = okEnvelope();
  v2.schema_version = 2;
  const unsupported = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "ok", text: JSON.stringify(v2) } });
  assert.equal(unsupported.state, "unreadable");
  assert.equal(unsupported.downloadAllowed, true);
  const garbage = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "decode_error" } });
  assert.equal(garbage.state, "unreadable");
  assert.equal(garbage.downloadAllowed, true);
  const missing = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "missing" } });
  assert.equal(missing.state, "unreadable");
  assert.equal(missing.downloadAllowed, false);
  for (const key of [`trace-bundles/${SERVER}/${MACHINE}/x.jsonl.gz`, `feedback-agent-event-tails/${OTHER_AGENT}/${MACHINE}/x.json.gz`, `feedback-agent-event-tails/${SERVER}/${MACHINE}/../x.json.gz`]) {
    const bad = readAgentEventTailAttachment({ report, ledger: ledger({ object_key: key }), object: { status: "ok", text: JSON.stringify(okEnvelope()) } });
    assert.equal(bad.state, "identity_mismatch", key);
    assert.equal(bad.downloadAllowed, false, key);
  }
  assert.equal(readAgentEventTailAttachment({ report, ledger: null, object: { status: "missing" } }).state, "absent");
});

test("failure objects build and parse; corpus unavailable is a collection failure, not an empty list", () => {
  const f = buildFailedFeedbackAgentEventTail({ feedbackReportId: REPORT, agentId: AGENT, requestId: REQUEST, window: WINDOW, failure: "corpus_unavailable" });
  assert.equal(f.ok, true);
  if (!f.ok) return;
  const p = parseFeedbackAgentEventTailJson(f.json);
  assert.deepEqual(p.collection, { status: "failed", failure: "corpus_unavailable" });
  assert.deepEqual(describeAgentEventTailEvents(p), { kind: "not_applicable" });
});

test("T15 ledger classifier: new kind recognised; an unknown kind keeps its raw string", () => {
  assert.equal(classifyFeedbackReportLedgerEntry({ feedback_attachment_kind: "agent_event_tail", request_id: REQUEST }).attachment, "agent_event_tail");
  const unknown = classifyFeedbackReportLedgerEntry({ feedback_attachment_kind: "future_kind" });
  assert.equal(unknown.attachment, "unknown");
  assert.equal(unknown.rawKind, "future_kind");
});

test("A.3 three-way identity: report serverId, ledger server_id and machine_id are required and must match the key; otherwise identity_mismatch and no download", () => {
  const text = JSON.stringify(okEnvelope());
  const baseline = readAgentEventTailAttachment({ report, ledger: ledger(), object: { status: "ok", text } });
  assert.equal(baseline.state, "readable");
  const cases: Array<[string, Record<string, unknown>, typeof report]> = [
    ["ledger server_id missing", ledger({ server_id: undefined }), report],
    ["ledger server_id null", ledger({ server_id: null }), report],
    ["ledger server_id number", ledger({ server_id: 7 }), report],
    ["ledger server_id other", ledger({ server_id: "other-server" }), report],
    ["ledger machine_id missing", ledger({ machine_id: undefined }), report],
    ["ledger machine_id null", ledger({ machine_id: null }), report],
    ["ledger machine_id number", ledger({ machine_id: 7 }), report],
    ["ledger machine_id other", ledger({ machine_id: "other-machine" }), report],
    ["report serverId other", ledger(), { ...report, serverId: "other-server" }],
    ["report serverId missing", ledger(), { ...report, serverId: undefined as unknown as string }],
  ];
  for (const [name, entry, r] of cases) {
    const read = readAgentEventTailAttachment({ report: r, ledger: entry, object: { status: "ok", text } });
    assert.equal(read.state, "identity_mismatch", name);
    if (read.state !== "identity_mismatch") continue;
    assert.equal(read.reason, "object_key", name);
    assert.equal(read.downloadAllowed, false, name);
  }
});

test("runtime_input_source accepts fresh_unread_summary, fresh_open_tasks, and constructed_* sources (#proj-runtime:#80)", () => {
  const sources = [
    "fresh_unread_summary",
    "fresh_open_tasks",
    "fresh_unread_summary_with_memory",
    "constructed_cold_start",
    "constructed_fresh_unread_summary",
    "constructed_fresh_open_tasks",
    "constructed_wake_inbox_update",
  ];
  for (const source of sources) {
    const built = build([
      {
        type: "span",
        schema_version: 1,
        name: "daemon.runtime.turn",
        surface: "daemon",
        start_time: at(1),
        duration_ms: 100,
        status: "ok",
        attrs: {
          agentId: AGENT,
          reason: "spawn",
          runtime_input_source: source,
        },
      },
    ]);
    assert.equal(built.ok, true, source);
    if (!built.ok) continue;
    const parsed = asOk(parseFeedbackAgentEventTailJson(built.json));
    assert.equal(parsed.events[0]?.attrs.runtime_input_source, source);
  }
});
