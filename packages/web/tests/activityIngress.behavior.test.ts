// Activity panel ingress — raw server payload → generated validator → sync core fold.
//
// Why this file exists, stated as the failure it is built to catch:
//
// An earlier version of this seam fed SNAPSHOTS to `foldActivityEvent`. Snapshots
// are not domain events, so every one fell through the reducer's `default:` and
// returned state untouched — a permanently empty panel. Seven tests passed,
// because not one of them called the fold. The rule that came out of it: an
// ingress test that does not run the real reducer over the real payload is not
// testing ingress.
//
// So every tooth below goes RAW PAYLOAD -> ingress -> real core -> observed state.
// None of them assert on the ingress return value alone.
//
// Run: pnpm --filter @botiverse/raft-web test tests/activityIngress.behavior.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSyncCore,
  createActivityDomain,
} from "@botiverse/raft-sync-core";
import type {
  ActivityDomainState,
} from "@botiverse/raft-sync-core";
import schemaBundle from
  "@botiverse/raft-sync-core/contracts/activity-v1/generated/json-schema/activity-sync.schema.json" with { type: "json" };
import Ajv2020 from "ajv/dist/2020.js";
import {
  ACTIVITY_WINDOW_FACTS,
  ActivityIngressError,
  SnapshotRequiredError,
  UnsupportedActivityIngressKind,
  differenceFromResponse,
  frameFromPushEvent,
  snapshotFromResponse,
} from "../src/store/activityPanel/ingress";

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
    lastActivityAt: "2026-07-29T00:00:00.000Z",
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
    latestActivitySeq: "1",
    lastMessagePreview: "hi",
    lastMessageSenderKind: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "Peer",
    ...overrides,
  };
}

function differencePayload(overrides: Record<string, unknown> = {}) {
  const merged: Record<string, unknown> = {
    type: "difference",
    requestId: "req-1",
    scope: SCOPE,
    epoch: "1",
    fromSeq: "0",
    toSeq: "5",
    activityVersion: "7",
    rows: [row()],
    tombstones: [],
    nextCursor: null,
    hasMore: false,
    complete: true,
    totalCount: 1,
    totalUnreadCount: 3,
    ...overrides,
  };
  // A COMPLETE (non-slice) response reports nextFromSeq == toSeq. Pinning the
  // default to a literal would silently turn every toSeq override into a slice
  // — which is what happened the first time and made two unrelated teeth fail.
  // Tests that want a slice pass nextFromSeq explicitly.
  if (!("nextFromSeq" in overrides)) merged.nextFromSeq = merged.toSeq;
  return merged;
}

function snapshotPayload(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function freshCore() {
  const core = createSyncCore({ domains: [createActivityDomain()] });
  return core;
}

/**
 * Unwrap a difference PLAN into the core response.
 *
 * `differenceFromResponse` returns a discriminated plan because the 200 body is
 * `DifferenceIngress | NotModifiedIngress`; a notModified is a normal empty
 * poll, not a wire error and not an empty frame. Asserting the arm here means a
 * plan that silently becomes notModified fails loudly instead of quietly
 * ingesting nothing.
 */
function asDifference(plan: ReturnType<typeof differenceFromResponse>) {
  assert.equal(plan.kind, "difference", "expected a difference plan");
  return (plan as Extract<typeof plan, { kind: "difference" }>).response;
}

function stateOf(core: ReturnType<typeof freshCore>): ActivityDomainState {
  const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;
  const state = core.state<ActivityDomainState>("activity", scopeId);
  assert.ok(state, "scope must exist in the core");
  return state;
}

// ── T1: anti-drift gate (relationship-keyed, not a remembered list) ─────────

test("T1 every DifferenceIngress field is either forwarded or explicitly excluded", () => {
  // Fields the translator deliberately does NOT forward into the fold event,
  // each with the reason it is out of scope. This is the decision record — a
  // NEW contract field belongs to neither set and fails this test, forcing an
  // explicit choice instead of a silent drop. That silent drop is exactly the
  // defect this file was written for.
  const NOT_FORWARDED = new Set([
    "type", // discriminator, re-derived as the fold event's own type
    "requestId", // request correlation, not state
    "scope", // becomes scopeId on the response envelope
    "epoch", // transport envelope
    "fromSeq", // transport envelope
    "toSeq", // transport envelope, also the synthetic event's seq
    "nextFromSeq", // becomes `partial` on the envelope
  ]);
  const FORWARDED = new Set<string>([
    "rows",
    "tombstones",
    "activityVersion",
    ...ACTIVITY_WINDOW_FACTS,
  ]);

  const required = findSchema(schemaBundle, "DifferenceIngress.json")?.required as string[];
  assert.ok(Array.isArray(required) && required.length > 0, "schema must expose a required list");

  for (const field of required) {
    assert.ok(
      FORWARDED.has(field) !== NOT_FORWARDED.has(field),
      `contract field "${field}" is in neither (or both) of forwarded/excluded — decide explicitly`,
    );
  }
  for (const field of [...FORWARDED, ...NOT_FORWARDED]) {
    assert.ok(required.includes(field), `"${field}" is no longer a DifferenceIngress field`);
  }
});

function findSchema(node: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findSchema(item, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (obj.$id === id) return obj;
  for (const value of Object.values(obj)) {
    const hit = findSchema(value, id);
    if (hit) return hit;
  }
  return null;
}

// ── T2: the defect this file was written for ───────────────────────────────

test("T2 a difference that clears the unread total actually clears it", () => {
  const core = freshCore();
  // Seed a window that says 42 unread across 1 row.
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({
    window: { ...snapshotPayload().window, totalUnreadCount: 42, hasMore: true, totalCount: 9 },
  })));
  assert.equal(stateOf(core).totalUnreadCount, 42, "precondition: badge shows 42");

  // The user reads everything; the server's next difference says zero.
  core.ingestDifference("activity", asDifference(differenceFromResponse(differencePayload({
    fromSeq: "5",
    toSeq: "6",
    totalUnreadCount: 0,
    totalCount: 1,
    hasMore: false,
    rows: [row({ rowVersion: "3", unreadCount: 0 })],
  }))));

  // `acceptedActivityFrameWindowFact` PRESERVES absent fields rather than
  // resetting them, so a translator that drops totalUnreadCount leaves this at
  // 42 forever: rows correct, nothing thrown, badge permanently wrong.
  assert.equal(stateOf(core).totalUnreadCount, 0, "unread badge must clear");
  assert.equal(stateOf(core).hasMore, false);
  assert.equal(stateOf(core).totalCount, 1);
});

test("T3 all five window facts reach the fold", () => {
  const core = freshCore();
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload()));
  core.ingestDifference("activity", asDifference(differenceFromResponse(differencePayload({
    fromSeq: "5",
    toSeq: "6",
    nextCursor: "cursor-9",
    hasMore: true,
    complete: false,
    totalCount: 17,
    totalUnreadCount: 5,
    nextFromSeq: "6",
  }))));

  const state = stateOf(core);
  assert.equal(state.nextCursor, "cursor-9");
  assert.equal(state.hasMore, true);
  assert.equal(state.complete, false);
  assert.equal(state.totalCount, 17);
  assert.equal(state.totalUnreadCount, 5);
});

// ── T4: snapshot activityVersion (second defect found in review) ────────────

test("T4 a snapshot's activityVersion survives translation", () => {
  const core = freshCore();
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({ activityVersion: "77" })));
  // `stateFromSnapshot` reads activityVersion off the OUTER object but rows off
  // `.window`. Passing the bare window folds the version to null while rows
  // still land — so a rows-only assertion cannot catch this.
  assert.equal(stateOf(core).activityVersion, "77");
});

test("T4b a snapshot carries its OUTER epoch and watermark, not the window's", () => {
  // @赵梓淇: `snapshot 不是 event` must be proven by behavior, not by a header
  // comment. A snapshot is whole-window authority/rebaseline — the outer
  // envelope's epoch and watermark are the authority, and the inner `window`
  // is the state. Reading either from the wrong level is the failure mode.
  const core = freshCore();
  const translated = snapshotFromResponse(snapshotPayload({ epoch: "3", watermark: "42" }));

  assert.equal(translated.epoch, "3", "epoch is the canonical string, from the envelope");
  assert.equal(translated.watermark, 42n, "watermark is the ordered bigint, from the envelope");

  core.ingestSnapshot("activity", translated);
  const sync = core.scopeSyncState("activity", translated.scopeId);
  assert.equal(sync?.epoch, "3");
  assert.equal(sync?.appliedSeq, 42n, "snapshot rebaselines appliedSeq to its watermark");
});

test("T4c a snapshot REBASELINES the window rather than merging into it", () => {
  const core = freshCore();
  // First snapshot: one row, totals say 9.
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({
    window: { ...snapshotPayload().window, totalCount: 9, totalUnreadCount: 9 },
  })));
  assert.equal(stateOf(core).rows.length, 1);

  // Second snapshot at a higher watermark carries a DIFFERENT row and totals.
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({
    epoch: "1",
    watermark: "9",
    window: {
      rows: [row({ rowId: "row-9", channelId: "channel-9", rowVersion: "1" })],
      tombstones: [],
      nextCursor: null,
      hasMore: false,
      complete: true,
      totalCount: 1,
      totalUnreadCount: 0,
    },
  })));

  const state = stateOf(core);
  assert.equal(state.rows.length, 1, "the old row must not survive a rebaseline");
  assert.equal(state.rows[0].rowId, "row-9");
  assert.equal(state.totalCount, 1);
  assert.equal(state.totalUnreadCount, 0);
});

// ── T5: rows land, and a real follow-up readStateUpdated does not throw ─────

test("T5 rows land and a following readStateUpdated folds without throwing", () => {
  const core = freshCore();
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload()));
  assert.equal(stateOf(core).rows.length, 1, "snapshot rows must reach state");
  assert.equal(stateOf(core).rows[0].rowId, "row-1");

  // The reducer dereferences maxReadSeq/readStateVersion here. A row admitted
  // with either field missing threw a TypeError at exactly this step.
  core.ingestFrame("activity", frameFromPushEvent({
    type: "readStateUpdated",
    scope: SCOPE,
    epoch: "1",
    seq: "6",
    activityVersion: "8",
    updates: [{
      scopeId: "row-1",
      channelId: "channel-1",
      maxReadSeq: "99",
      readStateVersion: "2",
    }],
  }));

  assert.equal(stateOf(core).rows.length, 1, "row must survive the read update");
  assert.equal(stateOf(core).activityVersion, "8");
});

// ── T6: live push frames ───────────────────────────────────────────────────

test("T6 a pushed frame adds its row and preserves window totals", () => {
  const core = freshCore();
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({
    window: { ...snapshotPayload().window, totalUnreadCount: 4, totalCount: 1 },
  })));

  core.ingestFrame("activity", frameFromPushEvent({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "6",
    activityVersion: "8",
    rows: [row({ rowId: "row-2", channelId: "channel-2", rowVersion: "1" })],
    tombstones: [],
  }));

  const state = stateOf(core);
  assert.equal(state.rows.length, 2, "pushed row must land");
  // A push is a delta, not a new window: totals carry over untouched. This is
  // the flip side of T2 — same preservation rule, opposite correct outcome.
  assert.equal(state.totalUnreadCount, 4);
  assert.equal(state.totalCount, 1);
});

// ── T6b/T6c: command results are contract-legal but MUST NOT reach the fold ──
//
// @赵梓淇's contract verdict: commandReceipt / commandRejected are command-result
// facts, not Activity window state. They must produce zero folds, zero projection
// mutation and no legacy fallback — and must not be silently ignored either.
// Each kind gets its own tooth; one covering both would let a regression on the
// uncovered kind hide behind the covered one.

/** A core whose Activity fold counts its own invocations. */
function countingCore() {
  const base = createActivityDomain();
  let folds = 0;
  const core = createSyncCore({
    domains: [{
      ...base,
      fold: (state: unknown, event: unknown) => {
        folds += 1;
        return base.fold(state as never, event as never);
      },
    } as never],
  });
  return { core, foldCount: () => folds };
}

const COMMAND_RECEIPT = {
  type: "commandReceipt",
  scope: SCOPE,
  receipt: {
    commandId: "cmd-1",
    applied: true,
    activityVersion: "8",
    affectedScopes: [],
    tombstones: [],
  },
};

const COMMAND_REJECTED = {
  type: "commandRejected",
  scope: SCOPE,
  commandId: "cmd-1",
  activityVersion: "8",
  error: { code: "conflict", message: "stale", retryable: false },
};

for (const [label, payload] of [
  ["commandReceipt", COMMAND_RECEIPT],
  ["commandRejected", COMMAND_REJECTED],
] as const) {
  test(`T6b ${label} is refused with a typed kind error and never folds`, () => {
    const { core, foldCount } = countingCore();
    core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload()));
    const foldsAfterSeed = foldCount();
    const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;
    const before = JSON.stringify(core.state("activity", scopeId));

    let thrown: unknown;
    try {
      frameFromPushEvent(payload);
      assert.fail(`${label} must not be accepted`);
    } catch (error) {
      thrown = error;
    }

    // Typed, not generic: the payload is WELL-FORMED, it simply is not window
    // state. A generic ActivityIngressError would tell the caller "bad wire".
    assert.ok(
      thrown instanceof UnsupportedActivityIngressKind,
      `expected UnsupportedActivityIngressKind, got ${(thrown as Error)?.name}`,
    );
    assert.equal((thrown as UnsupportedActivityIngressKind).kind, label);
    // Not merely "did not throw something else" — nothing reached the reducer,
    // and the projection is byte-identical afterwards (0 fold / 0 mutation).
    assert.equal(foldCount(), foldsAfterSeed, "no fold may run for a command result");
    assert.equal(
      JSON.stringify(core.state("activity", scopeId)),
      before,
      "state must be byte-identical after an excluded kind",
    );
  });
}

test("T6e a MALFORMED command result is a validation error, not 'valid-but-unsupported'", () => {
  // @赵梓淇: the two outcomes must stay distinguishable. If an excluded kind
  // short-circuited on the discriminator before validating, a malformed receipt
  // would be misreported as valid-but-unsupported and contract drift on these
  // shapes would go unguarded forever. Validating the envelope against the
  // whole `ActivityIngress` union first is what keeps them apart.
  for (const [label, broken] of [
    ["commandReceipt", { ...COMMAND_RECEIPT, receipt: { commandId: "cmd-1" } }],
    ["commandRejected", { ...COMMAND_REJECTED, error: { code: "nope", message: 1 } }],
  ] as const) {
    let thrown: unknown;
    try {
      frameFromPushEvent(broken);
      assert.fail(`malformed ${label} must not be accepted`);
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown instanceof ActivityIngressError,
      `malformed ${label} must raise a generated-validation error, got ${(thrown as Error)?.name}`,
    );
    assert.ok(
      !(thrown instanceof UnsupportedActivityIngressKind),
      `malformed ${label} must NOT be reported as valid-but-unsupported`,
    );
  }
});

// ── T10/T11: differenceSlice delivery boundary (P1, @HanXin / @赵梓淇) ────────

test("T10 a real slice stops at nextFromSeq and continues from there", () => {
  const core = freshCore();
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({ watermark: "5" })));
  const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;

  // Server delivered only through seq 7 of a requested range ending at 20.
  core.ingestDifference("activity", asDifference(differenceFromResponse(differencePayload({
    // Real server semantics: a difference after watermark W starts at W+1,
    // so the snapshot at watermark 5 is followed by fromSeq=6 — NOT 5. The
    // earlier fixture used 5 and disagreed with the server's own tooth.
    fromSeq: "6",
    toSeq: "20",
    nextFromSeq: "7",
    rows: [row({ rowId: "row-a", rowVersion: "3" })],
    totalCount: 2,
    totalUnreadCount: 2,
  }))));

  // Stamping the envelope at the wire `toSeq` would push appliedSeq to 20 and
  // the rows in (7, 20] would never be requested again — silent data loss.
  assert.equal(
    core.scopeSyncState("activity", scopeId)?.appliedSeq,
    7n,
    "appliedSeq must stop at the DELIVERED boundary, not the requested target",
  );

  const continuation = core.pendingRequests()
    .find((r) => r.kind === "difference" && r.scopeId === scopeId);
  assert.ok(continuation, "a slice must leave a difference continuation pending");
  assert.equal(
    (continuation as { sinceSeq: bigint }).sinceSeq,
    7n,
    "continuation must resume from the delivered boundary, not the requested target",
  );

  // The tail arrives; state must complete rather than stay truncated.
  core.ingestDifference("activity", asDifference(differenceFromResponse(differencePayload({
    // Continuation resumes AFTER the delivered boundary: delivered through 7,
    // so the tail page starts at 8.
    fromSeq: "8",
    toSeq: "20",
    nextFromSeq: "20",
    rows: [row({ rowId: "row-b", channelId: "channel-b", rowVersion: "1" })],
    totalCount: 2,
    totalUnreadCount: 2,
  }))));

  assert.equal(core.scopeSyncState("activity", scopeId)?.appliedSeq, 20n);
  // Name the rows rather than count them: the seed snapshot also contributes
  // one, so a bare count passes for the wrong reason if a slice is dropped.
  const ids = new Set(stateOf(core).rows.map((r) => r.rowId));
  assert.ok(ids.has("row-a"), "the first slice's row must survive the continuation");
  assert.ok(ids.has("row-b"), "the tail slice's row must land");
});

test("T11 a delivery boundary outside [fromSeq, toSeq] is refused fail-closed", () => {
  // BOTH directions. Guarding only the upper bound let an inverted envelope
  // through (livelock); guarding only the derived boundary let the over-large
  // cursor through unexamined, because isSlice goes false and deliveredThrough
  // harmlessly falls back to toSeq.
  assert.throws(
    () => differenceFromResponse(differencePayload({ fromSeq: "0", toSeq: "5", nextFromSeq: "9" })),
    ActivityIngressError,
    "nextFromSeq above toSeq",
  );
  assert.throws(
    () => differenceFromResponse(differencePayload({ fromSeq: "5", toSeq: "20", nextFromSeq: "4" })),
    ActivityIngressError,
    "nextFromSeq below fromSeq (inverted envelope -> livelock)",
  );
  assert.throws(
    () => differenceFromResponse(differencePayload({ fromSeq: "9", toSeq: "5", nextFromSeq: "5" })),
    ActivityIngressError,
    "inverted range",
  );
  // `nextFromSeq` is required-NULLABLE, so a null cursor skips the cursor guard
  // entirely. Without this case the inverted-range check has no tooth of its
  // own — verified: deleting that check left the suite green until this case
  // existed.
  assert.throws(
    () => differenceFromResponse(differencePayload({ fromSeq: "9", toSeq: "5", nextFromSeq: null })),
    ActivityIngressError,
    "inverted range with a null cursor",
  );
});

test("T6d the command-result payloads used above are contract-LEGAL", () => {
  // Without this, T6b/T6c would pass just as happily against a malformed
  // fixture rejected by the validator for the wrong reason — proving nothing
  // about the kind boundary. This pins that the rejection is a KIND decision,
  // not a shape failure.
  const validateUnion = new Ajv2020({ strict: false, allErrors: true });
  validateUnion.addSchema(schemaBundle as object, "activity-sync.schema.json");
  const check = validateUnion.getSchema("ActivityIngress.json");
  assert.ok(check, "union schema must exist");
  for (const payload of [COMMAND_RECEIPT, COMMAND_REJECTED]) {
    assert.ok(
      check(payload),
      `fixture must satisfy ActivityIngress: ${JSON.stringify(check.errors)}`,
    );
  }
});

// ── T7: uint64 precision ───────────────────────────────────────────────────

test("T7 a seq beyond 2^53 survives as an exact bigint", () => {
  // 9007199254740993 = 2^53 + 1. Number() rounds this to ...992.
  const big = "9007199254740993";
  const response = asDifference(differenceFromResponse(differencePayload({ fromSeq: "0", toSeq: big })));
  assert.equal(response.toSeq, 9007199254740993n);
  assert.equal(response.toSeq.toString(), big, "must not round-trip through Number");
});

// ── T8/T9: the validator actually runs ─────────────────────────────────────

test("T8 a VALID snapshotRequired body throws the typed error", () => {
  assert.throws(
    () => differenceFromResponse({
      snapshotRequired: true,
      requestId: "req-9",
      scope: SCOPE,
      epoch: "1",
      watermark: "5",
      activityVersion: "7",
    }),
    SnapshotRequiredError,
  );
});

test("T8b a BARE {snapshotRequired:true} is a validation error, not the typed one", () => {
  // Same raw-first principle as the command results: the discriminant may pick
  // the schema, but the generated validator decides. `SnapshotRequiredBody`
  // also requires requestId/scope/epoch/watermark/activityVersion, so a bare
  // flag is malformed — and short-circuiting on it made a malformed 409 and a
  // valid one indistinguishable. (@赵梓淇 P1.)
  let thrown: unknown;
  try {
    differenceFromResponse({ snapshotRequired: true });
    assert.fail("bare snapshotRequired must not be accepted");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ActivityIngressError, "must be a validation error");
  assert.ok(!(thrown instanceof SnapshotRequiredError), "must NOT be the typed snapshot-required");
});

test("T9 a payload violating the generated schema is refused", () => {
  // int64 as a JSON number is the precision defect the string encoding exists
  // to prevent; the schema pins it, so this must not reach the fold.
  assert.throws(
    () => differenceFromResponse(differencePayload({ toSeq: 5 })),
    ActivityIngressError,
  );
  // A row missing readStateVersion is the partial-row shape that threw a
  // TypeError inside the reducer once it was admitted to state.
  const partial = row();
  delete (partial as Record<string, unknown>).readStateVersion;
  assert.throws(
    () => differenceFromResponse(differencePayload({ rows: [partial] })),
    ActivityIngressError,
  );
});

// ── T12: the contiguous gap stop-gate (P1, @赵梓淇 / @HanXin) ────────────────

test("T12 a pushed frame with a gap stop-gates instead of applying out of order", () => {
  const core = freshCore();
  const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({ watermark: "5" })));

  // Snapshot is at seq 5; the next contiguous frame would be 6. This one is 7.
  const outcome = core.ingestFrame("activity", frameFromPushEvent({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "7",
    activityVersion: "8",
    rows: [row({ rowId: "gap-row", rowVersion: "9" })],
    tombstones: [],
  }));

  // The whole point of `density: "contiguous"`. Routing this push through
  // `ingestDifference` (as a fabricated one-event range) instead measured:
  //   applied / appliedSeq=7 / repairPending=false / pending=0 / row LANDED
  // — seq 6 skipped permanently with nothing recording it.
  assert.equal(outcome.kind, "gap_repair_requested");
  assert.equal(core.scopeSyncState("activity", scopeId)?.appliedSeq, 5n, "must NOT advance");
  assert.equal(core.scopeSyncState("activity", scopeId)?.repairPending, true);
  assert.ok(core.pendingRequests().length > 0, "must request repair");
  assert.ok(
    !stateOf(core).rows.some((r) => r.rowId === "gap-row"),
    "the gapped row must NOT land until a difference redelivers it in order",
  );

  // After the repair difference covers (5, 7], the row is present.
  core.ingestDifference("activity", asDifference(differenceFromResponse(differencePayload({
    fromSeq: "6",
    toSeq: "7",
    rows: [row({ rowId: "gap-row", rowVersion: "9" })],
  }))));
  assert.ok(
    stateOf(core).rows.some((r) => r.rowId === "gap-row"),
    "the row lands once delivered in order",
  );
});

test("T12b a contiguous pushed frame applies normally", () => {
  // Guards the obvious over-correction: stop-gating everything would also be
  // "no out-of-order apply", and T12 alone cannot tell the two apart.
  const core = freshCore();
  const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({ watermark: "5" })));

  const outcome = core.ingestFrame("activity", frameFromPushEvent({
    type: "frame",
    scope: SCOPE,
    epoch: "1",
    seq: "6",
    activityVersion: "8",
    rows: [row({ rowId: "next-row", rowVersion: "1" })],
    tombstones: [],
  }));

  assert.equal(outcome.kind, "applied");
  assert.equal(core.scopeSyncState("activity", scopeId)?.appliedSeq, 6n);
  assert.ok(stateOf(core).rows.some((r) => r.rowId === "next-row"));
});

// ── T13: notModified is a normal 200, not a wire error ──────────────────────

test("T13 a notModified difference is a typed no-op, not an error and not a frame", () => {
  const core = freshCore();
  const scopeId = snapshotFromResponse(snapshotPayload()).scopeId;
  core.ingestSnapshot("activity", snapshotFromResponse(snapshotPayload({ watermark: "5" })));
  const before = JSON.stringify(core.state("activity", scopeId));

  // The route body is `DifferenceIngress | NotModifiedIngress`; the server
  // returns this arm whenever `after === watermark`. Validating only against
  // DifferenceIngress made an ordinary empty poll throw ActivityIngressError.
  const plan = differenceFromResponse({
    type: "notModified",
    requestId: "req-9",
    scope: SCOPE,
    epoch: "1",
    watermark: "5",
    activityVersion: "7",
  });

  assert.equal(plan.kind, "notModified");
  assert.equal((plan as { watermark: bigint }).watermark, 5n);
  assert.equal((plan as { epoch: string }).epoch, "1");

  // Fabricating an empty frame for it would be worse than throwing: an empty
  // frame is a real fold input and would advance appliedSeq.
  assert.equal(
    JSON.stringify(core.state("activity", scopeId)),
    before,
    "a notModified must not mutate projected state",
  );
  assert.equal(core.scopeSyncState("activity", scopeId)?.appliedSeq, 5n, "must not advance");
});

test("T13b a malformed notModified is still a validation error", () => {
  assert.throws(
    () => differenceFromResponse({ type: "notModified", scope: SCOPE }),
    ActivityIngressError,
  );
});
