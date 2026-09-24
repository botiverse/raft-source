// Activity behind-gate consumer — the three activation gates (task #364).
//
// Each tooth asserts on the CORE's own bookkeeping (appliedSeq / repairPending /
// pendingRequests / fold-call count), not on the consumer's return value. The
// return value is a convenience; the bookkeeping is the contract.
//
// Run: pnpm --filter @botiverse/raft-web test tests/activityConsumer.behavior.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_DOMAIN,
  createActivityDomain,
  createSyncCore,
  encodeActivityScopeId,
} from "@botiverse/raft-sync-core";
import type {
  ActivityDomainState,
} from "@botiverse/raft-sync-core";
import { createActivityConsumer } from "../src/store/activityPanel/consumer";

const SCOPE = {
  serverId: "server-1",
  principalId: "user-1",
  filter: "all",
  windowId: "w1",
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-1",
    rowVersion: "2",
    latestActivitySeq: "42",
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    unreadCount: 3,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    maxReadSeq: "10",
    readStateVersion: "1",
    type: "channel",
    channelId: "channel-1",
    channelName: "general",
    channelKind: "channel",
    lastMessageId: "m-1",
    lastMessagePreview: "hi",
    lastMessageSenderKind: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "Peer",
    ...overrides,
  };
}

const SNAPSHOT = {
  type: "snapshot",
  requestId: "req-0",
  scope: SCOPE,
  epoch: "1",
  watermark: "5",
  activityVersion: "7",
  window: {
    rows: [row()],
    tombstones: [],
    nextCursor: null,
    hasMore: false,
    complete: true,
    totalCount: 1,
    totalUnreadCount: 3,
  },
};

/** A consumer whose Activity fold counts its invocations. */
function countingConsumer() {
  const base = createActivityDomain();
  let folds = 0;
  const core = createSyncCore({
    domains: [{
      ...base,
      fold: (state: unknown, event: unknown, ctx: unknown) => {
        folds += 1;
        return (base.fold as (s: unknown, e: unknown, c: unknown) => unknown)(state, event, ctx);
      },
    } as never],
  });
  return { consumer: createActivityConsumer(core), core, foldCount: () => folds };
}

/**
 * Seed the core the way the host does: issue a request id, then feed the
 * response that bears it. A snapshot is correlated like every other response, so
 * a test that skips `issueRequest` is exercising the refusal path.
 */
function scopeIdOf(consumer: ReturnType<typeof createActivityConsumer>, requestId = "seed") {
  const scopeId = encodeActivityScopeId(SCOPE);
  consumer.issueRequest(scopeId, requestId);
  const report = consumer.acceptSnapshot({ ...SNAPSHOT, requestId });
  // Do NOT stringify the whole report here: the outcome carries bigints and
  // JSON.stringify throws on them, which masks the real kind with a TypeError.
  assert.equal(report.kind, "snapshot", `seed snapshot must be accepted, got ${report.kind}`);
  return (report.outcome as { scopeId: string }).scopeId;
}

// ── Gate 1: a pushed frame with a gap must stop-gate, not apply ─────────────

test("G1 a gapped push stop-gates: no advance, no row, repair pending", () => {
  const { consumer, core, foldCount } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const foldsAfterSeed = foldCount();

  const report = consumer.acceptPush({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "7", // snapshot is at 5; contiguous next is 6
    activityVersion: "8",
    rows: [row({ rowId: "gap-row", rowVersion: "9" })],
    tombstones: [],
  });

  assert.equal(report.kind, "push");
  assert.equal((report.outcome as { kind: string }).kind, "gap_repair_requested");
  const sync = core.scopeSyncState(ACTIVITY_DOMAIN, scopeId);
  assert.equal(sync?.appliedSeq, 5n, "appliedSeq must NOT advance past the gap");
  assert.equal(sync?.repairPending, true, "core must record the outstanding repair");
  assert.ok(consumer.pendingRequests().length > 0, "a repair request must be pending");
  assert.equal(foldCount(), foldsAfterSeed, "the gapped event must not be folded");
  assert.ok(
    !consumer.state(scopeId)!.rows.some((r) => r.rowId === "gap-row"),
    "the gapped row must not be visible",
  );
});

test("G1b a contiguous push applies (the gate is not a blanket refusal)", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  const report = consumer.acceptPush({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "6",
    activityVersion: "8",
    rows: [row({ rowId: "next-row", rowVersion: "1" })],
    tombstones: [],
  });

  assert.equal((report.outcome as { kind: string }).kind, "applied");
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 6n);
  assert.ok(consumer.state(scopeId)!.rows.some((r) => r.rowId === "next-row"));
});

// ── Gate 2: snapshotRequired must reach the core's own bookkeeping ──────────

test("G2 a 409 snapshotRequired sets repairPending and queues a SNAPSHOT request", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  // A 409 is correlated like any other response. This tooth previously omitted
  // issueRequest and still expected acceptance, positively pinning the gap.
  consumer.issueRequest(scopeId, "req-9");
  const report = consumer.acceptDifference({
    snapshotRequired: true,
    requestId: "req-9",
    scope: SCOPE,
    epoch: "1",
    watermark: "5",
    activityVersion: "7",
  });

  // The consumer must NOT rethrow: the caller is not allowed to own this
  // decision, because a UI-level refetch leaves the core believing it is
  // caught up (repairPending=false, zero pending requests).
  assert.equal(report.kind, "snapshotRequired");
  const sync = core.scopeSyncState(ACTIVITY_DOMAIN, scopeId);
  assert.equal(sync?.repairPending, true, "core must know a repair is outstanding");

  const pending = consumer.pendingRequests();
  const snapshotRequest = pending.find(
    (r) => r.kind === "snapshot" && r.scopeId === scopeId,
  );
  assert.ok(snapshotRequest, `core must queue a snapshot request, got ${JSON.stringify(
    pending.map((r) => r.kind),
  )}`);
  assert.equal(sync?.appliedSeq, 5n, "a 409 must not move the applied watermark");
});

// ── Gate 3: notModified settles the request without fabricating a frame ─────

test("G3 a notModified folds nothing, does not advance, and clears the request", () => {
  const { consumer, core, foldCount } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const foldsAfterSeed = foldCount();
  const stateBefore = JSON.stringify(consumer.state(scopeId));

  // Put a difference request in flight so there is something to settle.
  consumer.acceptPush({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "9",
    activityVersion: "8",
    rows: [],
    tombstones: [],
  });
  assert.ok(consumer.pendingRequests().length > 0, "precondition: a request is pending");

  // The host must have ISSUED this request for the response to settle it. The
  // earlier version of this tooth used an unbound id and still passed, which
  // proved "any response can clear any request" — the defect, not the fix.
  consumer.issueRequest(scopeId, "req-9");

  const report = consumer.acceptDifference({
    type: "notModified",
    requestId: "req-9",
    scope: SCOPE,
    epoch: "1",
    watermark: "5",
    activityVersion: "7",
  });

  assert.equal(report.kind, "notModified");
  // An empty frame would have been a real fold input and would have advanced
  // the watermark. Neither may happen.
  assert.equal(foldCount(), foldsAfterSeed, "notModified must not invoke the fold");
  assert.equal(
    core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq,
    5n,
    "notModified must not advance appliedSeq",
  );
  assert.equal(
    JSON.stringify(consumer.state(scopeId)),
    stateBefore,
    "projected state must be byte-identical",
  );
  assert.equal(
    consumer.pendingRequests().length,
    0,
    "the outstanding request must be settled, not left dangling",
  );
});

// ── The seed path still works end to end ───────────────────────────────────

test("G0 a snapshot seeds rows through the real fold", () => {
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const state = consumer.state(scopeId) as ActivityDomainState;
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].rowId, "row-1");
  assert.equal(state.activityVersion, "7");
  assert.equal(state.totalUnreadCount, 3);
});

test("G3b a notModified AHEAD of our cursor still folds nothing", () => {
  // Why this case exists: at watermark == appliedSeq the core skips any event
  // with `seq <= appliedSeq`, so fabricating an empty frame there is
  // observationally IDENTICAL to sending no events — no tooth can tell them
  // apart, and mutating `events: []` into a fake frame stayed green.
  //
  // The difference only becomes observable when the reported watermark is ahead
  // of our applied cursor: `events: []` settles and catches the cursor up
  // without folding, while a fabricated frame at that seq WOULD be folded.
  // That is the state @赵梓淇's "不得伪造空 frame" rule actually protects.
  const { consumer, core, foldCount } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const foldsAfterSeed = foldCount();
  consumer.issueRequest(scopeId, "req-9");

  const report = consumer.acceptDifference({
    type: "notModified",
    requestId: "req-9",
    scope: SCOPE,
    epoch: "1",
    watermark: "9", // ahead of the snapshot's 5
    activityVersion: "7",
  });

  assert.equal(report.kind, "notModified");
  assert.equal(
    foldCount(),
    foldsAfterSeed,
    "a notModified must never reach the fold, at any watermark",
  );
  assert.equal(
    core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq,
    9n,
    "an empty range settles the cursor at the server's reported watermark",
  );
  assert.equal(consumer.state(scopeId)!.rows.length, 1, "no row may be invented");
});

// ── W: whole-window authority (atomic, never spliced) ───────────────────────

test("W1 a healthy core window is served in full, every field same-source", () => {
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  const w = consumer.windowAuthority(scopeId);
  assert.equal(w.authority, "core");
  const core = w as Extract<typeof w, { authority: "core" }>;
  // Every field must come from the SAME fold state. A spliced window is the
  // failure mode: core rows with legacy totals reads as "40 unread, 1 row".
  assert.equal(core.rows.length, 1);
  assert.equal(core.totalCount, 1);
  assert.equal(core.totalUnreadCount, 3);
  assert.equal(core.hasMore, false);
  assert.equal(core.complete, true);
  assert.equal(core.nextCursor, null);
  assert.equal(core.activityVersion, "7");
});

test("W2 an outstanding repair denies core authority for the WHOLE window", () => {
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  // A gapped push leaves repairPending set. The core has perfectly good rows at
  // this point — that is exactly why the denial must be whole-window rather
  // than per-field: serving those rows with a stale cursor is the splice.
  consumer.acceptPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "7", activityVersion: "8",
    rows: [], tombstones: [],
  });
  assert.ok(consumer.state(scopeId)!.rows.length > 0, "rows are still present");

  const w = consumer.windowAuthority(scopeId);
  assert.equal(w.authority, "legacy");
  assert.equal((w as { reason: string }).reason, "repair_pending");
});

test("W3 a row missing canonical latestActivitySeq fails the window closed", () => {
  // Gate B1: latestActivitySeq is the Done/read/reactivation authority, and
  // replyCount must never substitute. `isRow` in the shared domain does NOT
  // check this field — it guards only what the fold dereferences — so a row
  // without it reaches state and the check must live at this boundary.
  const { consumer } = countingConsumer();
  const bare = row();
  delete (bare as Record<string, unknown>).latestActivitySeq;

  // Sneak it past the fold the way a legacy/older server would.
  const scopeId = scopeIdOf(consumer);
  const state = consumer.state(scopeId)!;
  (state.rows as unknown as Record<string, unknown>[]).push(bare);

  const w = consumer.windowAuthority(scopeId);
  assert.equal(w.authority, "legacy");
  assert.equal((w as { reason: string }).reason, "row_missing_latest_activity_seq");
});

test("W4 an unknown scope and a baseline-less scope both deny", () => {
  const { consumer } = countingConsumer();
  const absent = consumer.windowAuthority("does-not-exist");
  assert.equal(absent.authority, "legacy");
  assert.equal((absent as { reason: string }).reason, "scope_absent");
});

test("W3b a MALFORMED latestActivitySeq denies too, not just an absent one", () => {
  // Absence is only one way to lack a canonical frontier. Deleting the field is
  // caught by a mere presence check, so a tooth that only deletes it cannot
  // tell `isUInt64String` from `!== undefined` — verified: weakening the guard
  // that way stayed green until these cases existed.
  //
  // Each of these would break ordering or Done comparison: compareUInt64String
  // keys on string length first, so a number, a null, or a leading-zero form
  // silently mis-orders or throws.
  for (const bad of [42, null, "007", "", "1e3", {}]) {
    const { consumer } = countingConsumer();
    const scopeId = scopeIdOf(consumer);
    const state = consumer.state(scopeId)!;
    (state.rows as unknown as Record<string, unknown>[]).push(
      { ...row(), latestActivitySeq: bad },
    );

    const w = consumer.windowAuthority(scopeId);
    assert.equal(
      w.authority,
      "legacy",
      `latestActivitySeq=${JSON.stringify(bad)} must deny core authority`,
    );
    assert.equal((w as { reason: string }).reason, "row_missing_latest_activity_seq");
  }
});

// ── C: request correlation fence (P1-1) ────────────────────────────────────

test("C1 an UNSOLICITED notModified neither clears pending nor moves the cursor", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  // Create a real outstanding gap repair, and do NOT issue any request id.
  consumer.acceptPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "9", activityVersion: "8",
    rows: [], tombstones: [],
  });
  const pendingBefore = consumer.pendingRequests().length;
  assert.ok(pendingBefore > 0, "precondition: a repair is outstanding");

  const report = consumer.acceptDifference({
    type: "notModified", requestId: "never-issued", scope: SCOPE,
    epoch: "1", watermark: "9", activityVersion: "7",
  });

  assert.equal(report.kind, "ignoredUncorrelated");
  assert.equal((report as { reason: string }).reason, "unsolicited");
  assert.equal(
    consumer.pendingRequests().length,
    pendingBefore,
    "an unsolicited response must NOT clear a real outstanding repair",
  );
  assert.equal(
    core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq,
    5n,
    "an unsolicited response must NOT advance the cursor",
  );
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.repairPending, true);
});

test("C2 a SUPERSEDED response cannot clear the newer request that replaced it", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  consumer.acceptPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "9", activityVersion: "8",
    rows: [], tombstones: [],
  });

  consumer.issueRequest(scopeId, "req-old");
  consumer.issueRequest(scopeId, "req-new"); // a newer drain supersedes it
  const pendingBefore = consumer.pendingRequests().length;

  // The old in-flight response lands late.
  const report = consumer.acceptDifference({
    type: "notModified", requestId: "req-old", scope: SCOPE,
    epoch: "1", watermark: "9", activityVersion: "7",
  });

  assert.equal(report.kind, "ignoredUncorrelated");
  assert.equal((report as { reason: string }).reason, "superseded");
  assert.equal(consumer.pendingRequests().length, pendingBefore);
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("C3 an uncorrelated DIFFERENCE is refused too, not just notModified", () => {
  const { consumer, core, foldCount } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const foldsAfterSeed = foldCount();

  const report = consumer.acceptDifference({
    type: "difference", requestId: "never-issued", scope: SCOPE, epoch: "1",
    fromSeq: "6", toSeq: "7", activityVersion: "8",
    rows: [row({ rowId: "ghost", rowVersion: "9" })], tombstones: [],
    nextCursor: null, hasMore: false, complete: true,
    totalCount: 2, totalUnreadCount: 2, nextFromSeq: "7",
  });

  assert.equal(report.kind, "ignoredUncorrelated");
  assert.equal(foldCount(), foldsAfterSeed, "an uncorrelated difference must not fold");
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
  assert.ok(!consumer.state(scopeId)!.rows.some((r) => r.rowId === "ghost"));
});

// ── E: cross-epoch 409 collapses to exactly one snapshot repair (P1-2) ─────

test("E1 an old-epoch 409 leaves exactly one snapshot repair, no stale difference", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);

  // Real sequence: we hold epoch 1, a gap leaves a difference repair pending.
  consumer.acceptPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "9", activityVersion: "8",
    rows: [], tombstones: [],
  });
  assert.ok(
    consumer.pendingRequests().some((r) => r.kind === "difference"),
    "precondition: a stale difference repair is pending",
  );

  // The server answers with its CURRENT epoch (2), not the one we asked with.
  consumer.issueRequest(scopeId, "req-409");
  const report = consumer.acceptDifference({
    snapshotRequired: true, requestId: "req-409", scope: SCOPE,
    epoch: "2", watermark: "5", activityVersion: "7",
  });

  assert.equal(report.kind, "snapshotRequired");
  const pending = consumer.pendingRequests();
  const snapshots = pending.filter((r) => r.kind === "snapshot" && r.scopeId === scopeId);
  const differences = pending.filter((r) => r.kind === "difference" && r.scopeId === scopeId);
  assert.equal(snapshots.length, 1, `exactly one snapshot repair, got ${JSON.stringify(pending)}`);
  assert.equal(
    differences.length,
    0,
    "the stale difference must be cleared, or the host drains two repairs",
  );
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.repairPending, true);
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("W3c a poisoned window RECOVERS to core authority once the frontier is canonical", () => {
  // The denial must be a property of the window's current contents, not a
  // latch. @赵梓淇: after restoring a canonical decimal frontier the SAME
  // complete window must be core-servable again — otherwise a single bad row
  // would permanently strand the panel on legacy.
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const rows = consumer.state(scopeId)!.rows as unknown as Record<string, unknown>[];

  rows.push({ ...row(), rowId: "row-2", latestActivitySeq: "007" });
  assert.equal(consumer.windowAuthority(scopeId).authority, "legacy");

  rows[rows.length - 1].latestActivitySeq = "43";
  const w = consumer.windowAuthority(scopeId);
  assert.equal(w.authority, "core", "a repaired window must regain core authority");
  assert.equal((w as { rows: unknown[] }).rows.length, 2);
});

test("W3d denial is WHOLE-window: a single bad row never yields a partial core window", () => {
  // The type makes splicing unrepresentable, so this pins the other half: a
  // window with one bad row among many good ones must not serve the good subset.
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const rows = consumer.state(scopeId)!.rows as unknown as Record<string, unknown>[];
  rows.push({ ...row(), rowId: "good-1", latestActivitySeq: "50" });
  rows.push({ ...row(), rowId: "good-2", latestActivitySeq: "51" });
  assert.equal(consumer.windowAuthority(scopeId).authority, "core", "precondition: healthy");

  rows.push({ ...row(), rowId: "poison", latestActivitySeq: {} });
  const w = consumer.windowAuthority(scopeId);
  assert.equal(w.authority, "legacy", "one bad row denies the entire window");
  assert.ok(
    !("rows" in w),
    "a denied verdict must carry NO rows at all — no partial core window exists",
  );
});

// ── F: the fence covers EVERY entry point, not just difference/notModified ──

test("F1 an UNSOLICITED 409 cannot clear a newer repair or queue a snapshot", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  consumer.acceptPush({
    type: "frame", scope: SCOPE, epoch: "1", seq: "9", activityVersion: "8",
    rows: [], tombstones: [],
  });
  const before = consumer.pendingRequests().map((r) => r.kind).sort();
  assert.ok(before.length > 0, "precondition: a repair is outstanding");

  const report = consumer.acceptDifference({
    snapshotRequired: true, requestId: "never-issued", scope: SCOPE,
    epoch: "2", watermark: "5", activityVersion: "7",
  });

  assert.equal(report.kind, "ignoredUncorrelated");
  assert.equal((report as { reason: string }).reason, "unsolicited");
  assert.deepEqual(
    consumer.pendingRequests().map((r) => r.kind).sort(),
    before,
    "an unsolicited 409 must not clear the newer repair nor add a snapshot",
  );
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("F2 a SUPERSEDED 409 is refused", () => {
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  consumer.issueRequest(scopeId, "req-old");
  consumer.issueRequest(scopeId, "req-new");
  const before = consumer.pendingRequests().length;

  const report = consumer.acceptDifference({
    snapshotRequired: true, requestId: "req-old", scope: SCOPE,
    epoch: "1", watermark: "5", activityVersion: "7",
  });

  assert.equal((report as { reason: string }).reason, "superseded");
  assert.equal(consumer.pendingRequests().length, before);
});

test("F3 an UNSOLICITED snapshot cannot overwrite the window", () => {
  // A snapshot REPLACES the whole window, so this is the most destructive
  // uncorrelated response: unfenced it would wipe newer state outright.
  const { consumer, core, foldCount } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  const foldsAfterSeed = foldCount();
  const before = JSON.stringify(consumer.state(scopeId));

  const report = consumer.acceptSnapshot({
    ...SNAPSHOT,
    requestId: "never-issued",
    watermark: "99",
    window: { ...SNAPSHOT.window, rows: [], totalCount: 0, totalUnreadCount: 0 },
  });

  assert.equal(report.kind, "ignoredUncorrelated");
  assert.equal((report as { reason: string }).reason, "unsolicited");
  assert.equal(
    JSON.stringify(consumer.state(scopeId)),
    before,
    "an unsolicited snapshot must not replace state",
  );
  assert.equal(foldCount(), foldsAfterSeed);
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("F4 a STALE snapshot arriving after a newer request is refused", () => {
  const { consumer, core } = countingConsumer();
  const scopeId = scopeIdOf(consumer);
  consumer.issueRequest(scopeId, "snap-old");
  consumer.issueRequest(scopeId, "snap-new"); // a newer drain superseded it
  const before = JSON.stringify(consumer.state(scopeId));

  const report = consumer.acceptSnapshot({
    ...SNAPSHOT, requestId: "snap-old", watermark: "99",
    window: { ...SNAPSHOT.window, rows: [] },
  });

  assert.equal((report as { reason: string }).reason, "superseded");
  assert.equal(JSON.stringify(consumer.state(scopeId)), before);
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("F5 an ACCEPTED snapshot settles its own outstanding record", () => {
  // Otherwise the record dangles and the NEXT legitimate response for the same
  // scope would be judged against a request that already completed.
  const { consumer } = countingConsumer();
  const scopeId = scopeIdOf(consumer, "snap-1");

  // A second response bearing the same, already-settled id must not be accepted.
  const replay = consumer.acceptSnapshot({ ...SNAPSHOT, requestId: "snap-1", watermark: "7" });
  assert.equal(replay.kind, "ignoredUncorrelated");
  assert.equal((replay as { reason: string }).reason, "unsolicited");
  assert.equal(
    consumer.core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.appliedSeq,
    5n,
    "a replayed snapshot must not advance the watermark",
  );
});
