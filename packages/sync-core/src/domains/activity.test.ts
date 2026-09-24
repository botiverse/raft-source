import assert from "node:assert/strict";
import test from "node:test";
import { createSyncCore } from "../core.js";
import type { SyncDomainConfig } from "../types.js";
import {
  ACTIVITY_DOMAIN,
  compareUInt64String,
  createActivityDomain,
  encodeActivityScopeId,
  fingerprintActivityEvent,
  foldActivityEvent,
  initialActivityState,
  type ActivityDomainState,
} from "./activity.js";

const SCOPE = encodeActivityScopeId({
  serverId: "srv-1",
  principalId: "principal-1",
  filter: "all",
  windowId: "window-1",
});

function row(rowId: string, rowVersion: string, lastActivityAt: string, extra: Record<string, unknown> = {}) {
  return {
    rowId,
    rowVersion,
    lastActivityAt,
    unreadCount: 0,
    hasMention: false,
    maxReadSeq: "0",
    readStateVersion: "0",
    type: "channel",
    ...extra,
  };
}

function frame(rows: unknown[], tombstones: unknown[] = [], activityVersion?: string) {
  return { type: "frame", rows, tombstones, ...(activityVersion ? { activityVersion } : {}) };
}

function ids(state: ActivityDomainState) {
  return state.rows.map((r) => r.rowId);
}

// ---------------------------------------------------------------------------
// compareUInt64String — the primitive both obvious shortcuts get wrong
// ---------------------------------------------------------------------------

test("compareUInt64String orders by magnitude, not lexicographically", () => {
  // Plain string compare says "9" > "10". That is the bug this exists to avoid.
  assert.equal(compareUInt64String("9", "10"), -1);
  assert.equal(compareUInt64String("10", "9"), 1);
  assert.equal(compareUInt64String("100", "99"), 1);
});

test("compareUInt64String stays exact above 2^53", () => {
  const a = "9007199254740993"; // 2^53 + 1
  const b = "9007199254740992"; // 2^53
  // Number() collapses these to the same double — the precision loss that made
  // the wire format a decimal string in the first place.
  assert.equal(Number(a) === Number(b), true, "precondition: doubles cannot tell these apart");
  assert.equal(compareUInt64String(a, b), 1, "the comparator must still tell them apart");
  assert.equal(compareUInt64String(b, a), -1);
  assert.equal(compareUInt64String(a, a), 0);
});

test("compareUInt64String handles full uint64 range", () => {
  const max = "18446744073709551615";
  assert.equal(compareUInt64String(max, "18446744073709551614"), 1);
  assert.equal(compareUInt64String("0", max), -1);
});

// ---------------------------------------------------------------------------
// row merge — version monotonicity
// ---------------------------------------------------------------------------

test("a newer rowVersion replaces an older one", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "1", "2026-07-28T10:00:00Z", { unreadCount: 1 })]));
  state = foldActivityEvent(state, frame([row("r1", "2", "2026-07-28T10:00:00Z", { unreadCount: 5 })]));
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.unreadCount, 5);
});

test("an older rowVersion arriving late does NOT overwrite a newer row", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "7", "2026-07-28T10:00:00Z", { unreadCount: 5 })]));
  state = foldActivityEvent(state, frame([row("r1", "3", "2026-07-28T09:00:00Z", { unreadCount: 1 })]));
  assert.equal(state.rows[0]!.unreadCount, 5, "out-of-order delivery must not regress the row");
  assert.equal(state.rows[0]!.rowVersion, "7");
});

test("row version comparison is magnitude-based across digit lengths", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "9", "2026-07-28T10:00:00Z", { unreadCount: 1 })]));
  // "10" > "9" numerically but "10" < "9" lexicographically. A lexicographic
  // comparator would drop this legitimate update.
  state = foldActivityEvent(state, frame([row("r1", "10", "2026-07-28T10:00:00Z", { unreadCount: 2 })]));
  assert.equal(state.rows[0]!.unreadCount, 2);
});

// ---------------------------------------------------------------------------
// tombstones
// ---------------------------------------------------------------------------

test("a tombstone removes the row", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "1", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, frame([], [{ rowId: "r1", rowVersion: "2", reason: "done" }]));
  assert.deepEqual(ids(state), []);
});

test("a stale tombstone does NOT remove a newer row", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "9", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, frame([], [{ rowId: "r1", rowVersion: "4", reason: "done" }]));
  assert.deepEqual(ids(state), ["r1"], "a tombstone older than the live row is a stale echo");
});

test("a buried row is not resurrected by an older frame", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "5", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, frame([], [{ rowId: "r1", rowVersion: "6", reason: "deleted" }]));
  // A delayed frame carrying version 5 must not undo the version-6 delete.
  state = foldActivityEvent(state, frame([row("r1", "5", "2026-07-28T10:00:00Z")]));
  assert.deepEqual(ids(state), [], "out-of-order replay must not resurrect a deleted row");
});

test("a genuinely newer row DOES come back after a tombstone", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "5", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, frame([], [{ rowId: "r1", rowVersion: "6", reason: "outOfWindow" }]));
  state = foldActivityEvent(state, frame([row("r1", "7", "2026-07-28T11:00:00Z")]));
  assert.deepEqual(ids(state), ["r1"], "a row newer than its tombstone is a real re-entry");
});

// ---------------------------------------------------------------------------
// canonical order — the cross-platform digest depends on it being total
// ---------------------------------------------------------------------------

test("rows are ordered most-recent-first", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([
    row("a", "1", "2026-07-28T09:00:00Z"),
    row("b", "1", "2026-07-28T11:00:00Z"),
    row("c", "1", "2026-07-28T10:00:00Z"),
  ]));
  assert.deepEqual(ids(state), ["b", "c", "a"]);
});

test("equal timestamps break ties by rowId, so the order is total", () => {
  const sameTime = "2026-07-28T10:00:00Z";
  let forward = initialActivityState();
  forward = foldActivityEvent(forward, frame([row("a", "1", sameTime), row("b", "1", sameTime)]));
  let reverse = initialActivityState();
  reverse = foldActivityEvent(reverse, frame([row("b", "1", sameTime), row("a", "1", sameTime)]));
  // Same facts, different arrival order -> identical canonical order. Without a
  // tie-break the two runners could emit different sequences from the same
  // bytes and the cross-platform digest would disagree over nothing.
  assert.deepEqual(ids(forward), ["a", "b"]);
  assert.deepEqual(ids(reverse), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// activityVersion — monotonic register
// ---------------------------------------------------------------------------

test("activityVersion advances but never regresses", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([], [], "10"));
  assert.equal(state.activityVersion, "10");
  state = foldActivityEvent(state, frame([], [], "4"));
  assert.equal(state.activityVersion, "10", "a delayed duplicate must not drag the version back");
  state = foldActivityEvent(state, frame([], [], "11"));
  assert.equal(state.activityVersion, "11");
});

// ---------------------------------------------------------------------------
// readStateUpdated — versioned register per row
// ---------------------------------------------------------------------------

test("readStateUpdated advances a row's read state", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "1", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, {
    type: "readStateUpdated",
    updates: [{ scopeId: "r1", maxReadSeq: "42", readStateVersion: "3" }],
  });
  assert.equal(state.rows[0]!.maxReadSeq, "42");
  assert.equal(state.rows[0]!.readStateVersion, "3");
});

test("a stale readStateVersion is ignored", () => {
  let state = initialActivityState();
  state = foldActivityEvent(state, frame([row("r1", "1", "2026-07-28T10:00:00Z")]));
  state = foldActivityEvent(state, {
    type: "readStateUpdated",
    updates: [{ scopeId: "r1", maxReadSeq: "42", readStateVersion: "3" }],
  });
  state = foldActivityEvent(state, {
    type: "readStateUpdated",
    updates: [{ scopeId: "r1", maxReadSeq: "7", readStateVersion: "2" }],
  });
  assert.equal(state.rows[0]!.maxReadSeq, "42", "read state must not rewind on a stale echo");
});

// ---------------------------------------------------------------------------
// totality / purity
// ---------------------------------------------------------------------------

test("an unknown event type leaves state untouched and does not throw", () => {
  const before = foldActivityEvent(initialActivityState(), frame([row("r1", "1", "2026-07-28T10:00:00Z")]));
  const after = foldActivityEvent(before, { type: "somethingNobodyShipped", payload: 1 });
  assert.equal(after, before, "unknown events must be a no-op, by reference");
});

test("malformed rows are skipped rather than throwing", () => {
  const state = foldActivityEvent(initialActivityState(), frame([
    row("ok", "1", "2026-07-28T10:00:00Z"),
    { rowId: "bad", rowVersion: "not-a-number", lastActivityAt: "x", type: "channel" },
    null,
    { nope: true },
  ]));
  assert.deepEqual(ids(state), ["ok"]);
});

test("fold does not mutate the input state", () => {
  const before = foldActivityEvent(initialActivityState(), frame([row("r1", "1", "2026-07-28T10:00:00Z")]));
  const snapshotOfRows = [...before.rows];
  foldActivityEvent(before, frame([row("r2", "1", "2026-07-28T12:00:00Z")]));
  assert.deepEqual(before.rows, snapshotOfRows, "fold must be pure");
});

// ---------------------------------------------------------------------------
// wiring: the domain actually works inside the real core
// ---------------------------------------------------------------------------

test("a frame arriving before any baseline does not apply — contiguous scopes need a snapshot first", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });

  // A fresh contiguous scope has appliedSeq = null: there is no baseline, so
  // even seq 1 cannot be applied. Starting a contiguous domain from a live
  // frame would silently assume nothing preceded it.
  const outcome = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 1n,
    epoch: "1",
    event: frame([row("r1", "1", "2026-07-28T10:00:00Z")]),
  });
  assert.equal(outcome.kind, "gap_repair_requested");
  assert.deepEqual(
    ids(core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE) ?? initialActivityState()),
    [],
    "no baseline means the frame is not folded",
  );
  assert.equal(core.pendingRequests().length > 0, true, "the core must ask for repair");
});

test("after a snapshot baseline, frames apply in order and a gap stop-gates", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });

  core.ingestSnapshot(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    watermark: 1n,
    epoch: "1",
    state: {
      activityVersion: "1",
      window: { rows: [row("r1", "1", "2026-07-28T10:00:00Z")], tombstones: [], nextCursor: null, hasMore: false, complete: true },
    },
  });
  assert.deepEqual(ids(core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!), ["r1"]);

  const applied = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 2n,
    epoch: "1",
    event: frame([row("r2", "1", "2026-07-28T12:00:00Z")]),
  });
  assert.equal(applied.kind, "applied");
  assert.deepEqual(ids(core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!), ["r2", "r1"]);

  // seq 4 with seq 3 missing: contiguous density must stop-gate into repair
  // rather than apply out of order.
  const gapped = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 4n,
    epoch: "1",
    event: frame([row("r3", "1", "2026-07-28T13:00:00Z")]),
  });
  assert.equal(gapped.kind, "gap_repair_requested");
  assert.deepEqual(
    ids(core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!),
    ["r2", "r1"],
    "a gapped frame must not be applied",
  );
  assert.equal(core.pendingRequests().some((r) => r.kind === "difference"), true);
});

test("a snapshot rebaselines and drops carried tombstones", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });
  core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 1n,
    epoch: "1",
    event: frame([], [{ rowId: "gone", rowVersion: "9", reason: "deleted" }]),
  });

  core.ingestSnapshot(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    watermark: 5n,
    epoch: "1",
    state: {
      activityVersion: "5",
      window: { rows: [row("gone", "2", "2026-07-28T10:00:00Z")], tombstones: [], nextCursor: null, hasMore: false, complete: true },
    },
  });

  const state = core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!;
  // The server's snapshot is authoritative: a row it lists is present even if
  // a pre-snapshot tombstone had a higher version.
  assert.deepEqual(ids(state), ["gone"]);
  assert.deepEqual(state.tombstones, {});
  assert.equal(state.activityVersion, "5");
});

// ---------------------------------------------------------------------------
// P1 regressions (reviewer @赵梓淇, PR #5577 review of exact 5a06baf8)
// ---------------------------------------------------------------------------

test("#5577 P1 a snapshot's OWN tombstones survive and block a stale resurrection", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });

  // The snapshot is authoritative: it says row `a` is deleted at version 6.
  core.ingestSnapshot(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    watermark: 1n,
    epoch: "1",
    state: {
      activityVersion: "1",
      window: {
        rows: [],
        tombstones: [{ rowId: "a", rowVersion: "6", reason: "deleted" }],
        nextCursor: null,
        hasMore: false,
        complete: true,
      },
    },
  });

  // A delayed frame carrying the pre-delete row must NOT bring it back.
  // Clearing snapshot-provided tombstones (as the first implementation did)
  // made this frame apply and the row reappear.
  core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 2n,
    epoch: "1",
    event: frame([row("a", "5", "2026-07-28T10:00:00Z")]),
  });

  const state = core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!;
  assert.deepEqual(ids(state), [], "a snapshot's own tombstone must outlive the snapshot apply");
  assert.equal(state.tombstones.a, "6", "the authoritative tombstone is retained, not discarded");
});

test("#5577 P1 same-seq facts that differ only in payload are a conflict, not a duplicate", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });
  core.ingestSnapshot(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    watermark: 1n,
    epoch: "1",
    state: { activityVersion: "1", window: { rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true } },
  });

  const first = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 2n,
    epoch: "1",
    event: frame([row("a", "5", "2026-07-28T10:00:00Z", { unreadCount: 1 })], [], "2"),
  });
  assert.equal(first.kind, "applied");

  // Same seq, same rowId/rowVersion/activityVersion — but a DIFFERENT fact.
  // Fingerprinting only identity made this look like an idempotent replay, so
  // it was dropped silently with no violation: the exact producer conflict the
  // fingerprint exists to surface.
  const second = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: 2n,
    epoch: "1",
    event: frame([row("a", "5", "2026-07-28T10:00:00Z", { unreadCount: 99 })], [], "2"),
  });

  assert.notEqual(second.kind, "duplicate_dropped", "a different fact at the same seq is not a duplicate");
  assert.equal(core.violations().records.length > 0, true, "the conflict must be recorded");
  // And the accepted state must not have been mutated by the rejected fact.
  const state = core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!;
  assert.equal((state.rows[0] as { unreadCount: number }).unreadCount, 1, "a rejected conflict must not mutate accepted state");
});

test("each window metadata field participates in same-seq producer conflict detection", () => {
  const base = {
    type: "frame",
    rows: [],
    tombstones: [],
    activityVersion: "2",
    nextCursor: "100",
    hasMore: true,
    complete: false,
    totalCount: 101,
    totalUnreadCount: 7,
  } as const;
  const variants = [
    { field: "nextCursor", event: { ...base, nextCursor: null } },
    { field: "hasMore", event: { ...base, hasMore: false } },
    { field: "complete", event: { ...base, complete: true } },
    { field: "totalCount", event: { ...base, totalCount: 102 } },
    { field: "totalUnreadCount", event: { ...base, totalUnreadCount: 8 } },
  ] as const;

  for (const variant of variants) {
    const core = createSyncCore({
      domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>],
    });
    core.ingestSnapshot(ACTIVITY_DOMAIN, {
      scopeId: SCOPE,
      watermark: 1n,
      epoch: "1",
      state: {
        activityVersion: "1",
        window: {
          rows: [],
          tombstones: [],
          nextCursor: null,
          hasMore: false,
          complete: true,
          totalCount: 0,
          totalUnreadCount: 0,
        },
      },
    });
    assert.equal(core.ingestFrame(ACTIVITY_DOMAIN, {
      scopeId: SCOPE,
      seq: 2n,
      epoch: "1",
      event: base,
    }).kind, "applied");

    const conflict = core.ingestFrame(ACTIVITY_DOMAIN, {
      scopeId: SCOPE,
      seq: 2n,
      epoch: "1",
      event: variant.event,
    });
    assert.notEqual(conflict.kind, "duplicate_dropped", variant.field);
    assert.equal(core.violations().records.length > 0, true, variant.field);
    assert.deepEqual(
      {
        nextCursor: core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!.nextCursor,
        hasMore: core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!.hasMore,
        complete: core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!.complete,
        totalCount: core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!.totalCount,
        totalUnreadCount:
          core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!.totalUnreadCount,
      },
      {
        nextCursor: "100",
        hasMore: true,
        complete: false,
        totalCount: 101,
        totalUnreadCount: 7,
      },
      `${variant.field} conflict must not mutate accepted state`,
    );
  }
});

test("missing nextCursor and explicit null remain distinct accepted facts", () => {
  const missing = {
    type: "frame",
    rows: [],
    tombstones: [],
    activityVersion: "2",
  };
  const explicitNull = { ...missing, nextCursor: null };
  assert.notEqual(
    fingerprintActivityEvent(missing),
    fingerprintActivityEvent(explicitNull),
    "absence must not collapse into an explicit null in the fingerprint",
  );

  const prior = { ...initialActivityState(), nextCursor: "keep-me" };
  assert.equal(
    foldActivityEvent(prior, missing).nextCursor,
    "keep-me",
    "absence preserves the accepted cursor",
  );
  assert.equal(
    foldActivityEvent(prior, explicitNull).nextCursor,
    null,
    "explicit null clears the accepted cursor",
  );
});

test("#5577 P1 read-state updates participate in the fingerprint", () => {
  const a = fingerprintActivityEvent({
    type: "readStateUpdated",
    updates: [{ scopeId: "r1", maxReadSeq: "42", readStateVersion: "3" }],
  } as never);
  const b = fingerprintActivityEvent({
    type: "readStateUpdated",
    updates: [{ scopeId: "r1", maxReadSeq: "7", readStateVersion: "3" }],
  } as never);
  assert.notEqual(a, b, "distinct read-state facts must not collide in the fingerprint");
});

test("#5577 P1 sequences adjacent across 2^53 remain distinct positions end to end", () => {
  const core = createSyncCore({ domains: [createActivityDomain() as SyncDomainConfig<unknown, unknown>] });

  // 2^53 and 2^53+1 are the same IEEE-754 double. If any layer narrows the
  // sequence to `number`, these become one position: the frame is judged a
  // duplicate/conflict instead of the next contiguous position.
  const watermark = 9007199254740992n;
  const next = 9007199254740993n;
  assert.equal(Number(watermark) === Number(next), true, "precondition: doubles cannot separate these");

  core.ingestSnapshot(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    watermark,
    epoch: "1",
    state: { activityVersion: "1", window: { rows: [], tombstones: [], nextCursor: null, hasMore: false, complete: true } },
  });

  const outcome = core.ingestFrame(ACTIVITY_DOMAIN, {
    scopeId: SCOPE,
    seq: next,
    epoch: "1",
    event: frame([row("a", "1", "2026-07-28T10:00:00Z")], [], "2"),
  });

  assert.equal(outcome.kind, "applied", "2^53+1 is the position after 2^53, not a replay of it");
  assert.deepEqual(ids(core.state<ActivityDomainState>(ACTIVITY_DOMAIN, SCOPE)!), ["a"]);
  assert.equal(core.scopeSyncState(ACTIVITY_DOMAIN, SCOPE)?.appliedSeq, next);
  assert.deepEqual(core.violations().records, [], "no conflict may be reported for a legitimate next position");
});

test("a row missing any required UInt64String field is skipped, and the fold stays total", () => {
  // The existing "malformed rows skipped" case only used an INVALID rowVersion,
  // so it never reached the fields the fold dereferences later. A partial row
  // that satisfied the four checked fields was admitted, and the next
  // legitimate readStateUpdated threw on `undefined.length` — a reducer
  // declared pure/total/never-throw actually crashing on well-formed input.
  const required = ["rowVersion", "maxReadSeq", "readStateVersion"] as const;
  for (const missing of required) {
    const row: Record<string, unknown> = {
      rowId: "r1",
      rowVersion: "5",
      maxReadSeq: "1",
      readStateVersion: "1",
      lastActivityAt: "2026-07-28T00:00:00.000Z",
      type: "channel",
    };
    delete row[missing];

    const admitted = foldActivityEvent(initialActivityState(), {
      type: "frame",
      rows: [row],
      tombstones: [],
    });
    assert.equal(admitted.rows.length, 0, `a row missing ${missing} must not enter state`);

    // Totality: the very next legitimate event must not throw, whatever landed.
    assert.doesNotThrow(() => {
      foldActivityEvent(admitted, {
        type: "readStateUpdated",
        updates: [{ scopeId: "r1", rowId: "r1", maxReadSeq: "9", readStateVersion: "9" }],
      });
    }, `readStateUpdated must stay total after a row missing ${missing}`);
  }
});
