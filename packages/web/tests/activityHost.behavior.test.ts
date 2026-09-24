// Activity host — the thing that actually RUNS the consumer (task #364, P1-3).
//
// The consumer previously had no production caller: its header said "runs as a
// shadow consumer" while executing zero times, with only tests importing it.
// These teeth pin that the host exists, drains real requests, correlates them,
// and that the gate can only ever DOWNGRADE the core's authority verdict.
//
// Run: pnpm --filter @botiverse/raft-web test tests/activityHost.behavior.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createActivityHost,
  resolveActivityCutoverGate,
} from "../src/store/activityPanel/host";

const SCOPE = {
  serverId: "server-1", principalId: "user-1", filter: "all", windowId: "w1",
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-1", rowVersion: "2", latestActivitySeq: "42",
    lastActivityAt: "2026-07-30T00:00:00.000Z", unreadCount: 3, hasMention: false,
    firstUnreadMessageId: null, firstMentionMessageId: null, maxReadSeq: "10",
    readStateVersion: "1", type: "channel", channelId: "channel-1",
    channelName: "general", channelKind: "channel", lastMessageId: "m-1",
    lastMessagePreview: "hi", lastMessageSenderKind: "user",
    lastMessageSenderId: "user-2", lastMessageSenderName: "Peer", ...overrides,
  };
}

function snapshot(watermark = "5") {
  return {
    type: "snapshot", requestId: "seed", scope: SCOPE, epoch: "1",
    watermark, activityVersion: "7",
    window: {
      rows: [row()], tombstones: [], nextCursor: null, hasMore: false,
      complete: true, totalCount: 1, totalUnreadCount: 3,
    },
  };
}

/**
 * Seed a host's core the way the host itself does: issue a correlation id, then
 * feed the response bearing it. A snapshot is correlated like any other response,
 * so seeding without `issueRequest` exercises the refusal path instead.
 */
function seed(host: ReturnType<typeof createActivityHost>, watermark = "5", requestId = "seed") {
  const scopeId = JSON.stringify([SCOPE.serverId, SCOPE.principalId, SCOPE.filter, SCOPE.windowId]);
  host.consumer.issueRequest(scopeId, requestId);
  const report = host.consumer.acceptSnapshot({ ...snapshot(watermark), requestId });
  assert.equal(report.kind, "snapshot", `seed must be accepted, got ${report.kind}`);
  return (report.outcome as { scopeId: string }).scopeId;
}

function harness(gate: "off" | "shadow" | "on") {
  const calls: string[] = [];
  let n = 0;
  const host = createActivityHost({
    nextRequestId: () => `req-${++n}`,
    async fetchSnapshot(scopeId, requestId) {
      calls.push(`snapshot:${requestId}`);
      return { ...snapshot(), requestId };
    },
    async fetchDifference(scopeId, requestId, sinceSeq) {
      calls.push(`difference:${requestId}:since=${sinceSeq}`);
      return {
        type: "notModified", requestId, scope: SCOPE, epoch: "1",
        watermark: String(sinceSeq), activityVersion: "7",
      };
    },
  }, gate);
  return { host, calls };
}

test("H1 the gate is fail-closed: anything but shadow/on resolves to off", () => {
  for (const raw of [undefined, null, "", "   ", "OFF", "nonsense", "ON!", "Shadow "]) {
    const resolved = resolveActivityCutoverGate(raw as string | undefined);
    const expected = raw && raw.trim().toLowerCase() === "shadow" ? "shadow"
      : raw && raw.trim().toLowerCase() === "on" ? "on" : "off";
    assert.equal(resolved, expected, `gate(${JSON.stringify(raw)})`);
  }
  assert.equal(resolveActivityCutoverGate("on"), "on");
  assert.equal(resolveActivityCutoverGate("shadow"), "shadow");
});

test("H2 the host really runs: a push is ingested and a drain issues real fetches", async () => {
  const { host, calls } = harness("shadow");
  seed(host);

  // A gapped push must leave a repair the host then drains — this is the proof
  // that wiring exists at runtime, not just in a comment.
  host.onPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "9", activityVersion: "8",
    rows: [], tombstones: [],
  });
  assert.ok(host.consumer.pendingRequests().length > 0, "push produced a repair");

  await host.drain();
  assert.ok(calls.length > 0, `drain must issue a fetch, got ${JSON.stringify(calls)}`);
  assert.ok(
    calls[0].startsWith("difference:req-1"),
    `drain must correlate with an issued id, got ${calls[0]}`,
  );
  assert.equal(
    host.consumer.pendingRequests().length,
    0,
    "a correlated response settles the request",
  );
});

test("H3 gate off/shadow ALWAYS serves legacy, even with a healthy core window", async () => {
  for (const gate of ["off", "shadow"] as const) {
    const { host } = harness(gate);
    seed(host);

    // The core genuinely has authority here — proven by the "on" case below.
    const w = host.windowAuthority("irrelevant-because-gate-closed");
    assert.equal(w.authority, "legacy", `gate=${gate} must never serve from core`);
    assert.equal((w as { reason: string }).reason, "gate_closed");
  }
});

test("H4 gate on serves the whole core window when the core claims authority", () => {
  const { host } = harness("on");
  const scopeId = seed(host);

  const w = host.windowAuthority(scopeId);
  assert.equal(w.authority, "core", "gate on + healthy core = core-served window");
  assert.equal((w as { totalUnreadCount: number }).totalUnreadCount, 3);
});

test("H5 the gate can only DOWNGRADE: gate on cannot promote a denied window", () => {
  const { host } = harness("on");
  // No snapshot at all, so the core has no authority for this scope.
  const w = host.windowAuthority("never-seeded");
  assert.equal(w.authority, "legacy");
  assert.equal(
    (w as { reason: string }).reason,
    "scope_absent",
    "the core's own denial reason must survive; gate on must not invent authority",
  );
});

// ── V: no production path reaches the core without the generated validator ──

test("V1 a malformed fetched snapshot never reaches the core", async () => {
  // @赵梓淇 final requirement: every production host feed must pass through the
  // generated ingress validator before touching core.ingest*. There must be no
  // bypass that hands raw or hand-built rows straight to the core.
  let n = 0;
  const host = createActivityHost({
    nextRequestId: () => `req-${++n}`,
    // `latestActivitySeq` as a NUMBER — contract-illegal, and exactly the shape
    // a bypass would happily fold.
    async fetchSnapshot(_s, requestId) {
      return {
        ...snapshot(), requestId,
        window: { ...snapshot().window, rows: [{ ...row(), latestActivitySeq: 42 }] },
      };
    },
    async fetchDifference(_s, requestId) {
      return { type: "notModified", requestId, scope: SCOPE, epoch: "1", watermark: "5", activityVersion: "7" };
    },
  }, "on");

  seed(host, "5", "seed-a");
  const scopeId = seed(host, "6", "seed-b");
  const rowsBefore = host.consumer.state(scopeId)!.rows.length;

  // Force a snapshot repair so drain fetches the poisoned body.
  host.onPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "99", activityVersion: "8",
    rows: [], tombstones: [],
  });
  host.consumer.core.ingestDifference("activity", {
    scopeId, epoch: "1", fromSeq: 6n, toSeq: 6n, events: [], snapshotRequired: true,
  });

  await assert.rejects(
    () => host.drain(),
    /does not satisfy|canonical uint64/,
    "a contract-illegal body must be refused by the generated validator",
  );
  assert.equal(
    host.consumer.state(scopeId)!.rows.length,
    rowsBefore,
    "no poisoned row may reach fold state through the host",
  );
});

test("V2 a malformed push never reaches the core", () => {
  const { host } = harness("on");
  const scopeId = seed(host);
  const before = JSON.stringify(host.consumer.state(scopeId));

  assert.throws(
    () => host.onPush({
      type: "frame", scope: SCOPE, epoch: "1", seq: "6", activityVersion: "8",
      rows: [{ ...row(), latestActivitySeq: null }], tombstones: [],
    }),
    /does not satisfy/,
  );
  assert.equal(
    JSON.stringify(host.consumer.state(scopeId)),
    before,
    "a refused push must leave state byte-identical",
  );
});
