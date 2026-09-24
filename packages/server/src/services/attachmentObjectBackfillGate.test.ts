import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyBackfillRunOutcome,
  evaluateAttachmentObjectCompletionGate,
  evaluateAttachmentObjectPreflight,
} from "./attachmentObjectBackfillService.js";
import type { AttachmentObjectParityReport } from "./attachmentObjectBackfillService.js";

// task #79. The gate decides whether a run may claim completion, and the
// preflight decides whether it may write at all. Both are pure so each can be
// exercised in both directions without a database.

const clean: AttachmentObjectParityReport = {
  totalProjections: 5,
  nullObjectIds: 0,
  orphanNullObjectIds: 0,
  objectRows: 5,
  danglingObjectIds: 0,
  metadataMismatches: 0,
  detachedObjects: 0,
  duplicateStorageKeyGroups: 0,
  objectBackedPendingWithoutReservation: 0,
  pendingFoundationMismatches: 0,
  orphanPendingReservations: 0,
};

test("a clean report completes", () => {
  const gate = evaluateAttachmentObjectCompletionGate(clean);
  assert.equal(gate.complete, true);
  assert.deepEqual(gate.failures, []);
});

test("leftover null projections block completion, whatever the run claimed", () => {
  // The case the whole card exists for: claimed reaches 0 and the run exits
  // normally, but rows remain unmigrated. "Finished executing" is not "done".
  const gate = evaluateAttachmentObjectCompletionGate({ ...clean, nullObjectIds: 3 });
  assert.equal(gate.complete, false);
  assert.ok(gate.failures.some((f) => f.startsWith("nullObjectIds=3")), "the failure must name the count");
});

test("each existing parity fault independently blocks completion", () => {
  for (const key of [
    "danglingObjectIds",
    "metadataMismatches",
    "objectBackedPendingWithoutReservation",
    "pendingFoundationMismatches",
    "orphanPendingReservations",
  ] as const) {
    const gate = evaluateAttachmentObjectCompletionGate({ ...clean, [key]: 1 });
    assert.equal(gate.complete, false, key);
    assert.ok(gate.failures.some((f) => f.startsWith(`${key}=1`)), key);
  }
});

test("detached residue is reported but does not belong to projection-backfill completion", () => {
  const gate = evaluateAttachmentObjectCompletionGate({ ...clean, detachedObjects: 7 });
  assert.equal(gate.complete, true);
  assert.deepEqual(gate.failures, []);
});

test("duplicate storage-key groups are diagnostic and must NOT block completion", () => {
  // Counter-evidence from @kingwl, frozen by @Tenny: the contract is one
  // deterministic object per legacy projection, keyed on projection id and
  // unrelated to storage key. Two projections sharing a physical key therefore
  // produce two objects and a non-zero group count — the specified outcome. A
  // zero-gate here would judge correct behaviour a failure.
  const gate = evaluateAttachmentObjectCompletionGate({ ...clean, duplicateStorageKeyGroups: 7 });
  assert.equal(gate.complete, true, "a computed field is not a field required to be zero");
  assert.deepEqual(gate.failures, []);
});

test("orphaned null projections stop the run before any write", () => {
  const preflight = evaluateAttachmentObjectPreflight({ ...clean, nullObjectIds: 2, orphanNullObjectIds: 2 });
  assert.equal(preflight.safeToApply, false);
  assert.match(String(preflight.reason), /2 attachment projection/);
  assert.match(String(preflight.reason), /neither claimed nor safely constructed/);
});

test("orphans are refused rather than repaired or excluded", () => {
  // Both tempting repairs are wrong: constructing an object would invent an
  // origin server the channel alone can authorise, and dropping these rows from
  // the completion criterion would report "done" over rows nobody examined.
  const withOrphans = { ...clean, nullObjectIds: 2, orphanNullObjectIds: 2 };

  assert.equal(evaluateAttachmentObjectPreflight(withOrphans).safeToApply, false, "must not write");
  assert.equal(
    evaluateAttachmentObjectCompletionGate(withOrphans).complete,
    false,
    "and must not be able to report completion either — excluding them is the other wrong repair",
  );
});

test("a non-orphaned backlog is safe to apply — the preflight blocks only the unclaimable", () => {
  const preflight = evaluateAttachmentObjectPreflight({ ...clean, nullObjectIds: 500, orphanNullObjectIds: 0 });
  assert.equal(preflight.safeToApply, true, "an ordinary migration backlog is exactly what --apply is for");
  assert.equal(preflight.reason, null);
});

test("repairable missing reservations and detached residue do not block projection backfill", () => {
  assert.equal(
    evaluateAttachmentObjectPreflight({ ...clean, objectBackedPendingWithoutReservation: 12 }).safeToApply,
    true,
    "the batch repairs this exact backlog",
  );
  assert.equal(
    evaluateAttachmentObjectPreflight({ ...clean, detachedObjects: 12 }).safeToApply,
    true,
    "detached residue is remediated separately and is not part of projection backfill",
  );
  for (const key of [
    "danglingObjectIds",
    "metadataMismatches",
    "pendingFoundationMismatches",
    "orphanPendingReservations",
  ] as const) {
    const preflight = evaluateAttachmentObjectPreflight({ ...clean, [key]: 1 });
    assert.equal(preflight.safeToApply, false, key);
    assert.match(String(preflight.reason), new RegExp(`${key}=1`), key);
  }
});

// --- run classification (review RED fix) -----------------------------------

test("a segmented run is never completion-eligible, and says so", () => {
  // The bug this replaces: the completion gate ran first, threw on the backlog
  // the run was explicitly told to leave, and the segmented label was never
  // reached — so the contract's required outcome was unreachable.
  const outcome = classifyBackfillRunOutcome({ maxRows: 100, processed: 100 });

  assert.equal(outcome.kind, "segmented");
  assert.equal(outcome.completionEligible, false);
  assert.match(String(outcome.note), /NOT a completion receipt/);
  assert.match(String(outcome.note), /feature flag/, "it must say what it may not be used for");
});

test("a segmented run stays non-completion even when it happens to drain the backlog", () => {
  // Processing every remaining row under --max-rows does not upgrade a segment
  // into a completion receipt: the operator asked for a bounded run, and the
  // receipt records what was asked for, not what luck produced.
  const outcome = classifyBackfillRunOutcome({ maxRows: 5, processed: 0 });

  assert.equal(outcome.completionEligible, false);
  assert.equal(outcome.kind, "segmented");
});

test("a full run is completion-eligible and adds no segment note", () => {
  const outcome = classifyBackfillRunOutcome({ maxRows: null, processed: 4210 });

  assert.equal(outcome.kind, "full");
  assert.equal(outcome.completionEligible, true);
  assert.equal(outcome.note, null);
});
