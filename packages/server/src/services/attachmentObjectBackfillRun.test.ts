import assert from "node:assert/strict";
import { test } from "vitest";
import { runAttachmentObjectBackfill } from "./attachmentObjectBackfillService.js";
import type { AttachmentObjectParityReport } from "./attachmentObjectBackfillService.js";

// task #79, entry-level teeth. These drive the RUN SEQUENCE, not the decision
// helpers: the contract here is the ORDER of the steps, and an earlier revision
// tested the classification in isolation while the entry point put the
// completion gate back in front of it — reachable defect, green teeth.

const report = (over: Partial<AttachmentObjectParityReport> = {}): AttachmentObjectParityReport => ({
  totalProjections: 10,
  nullObjectIds: 0,
  orphanNullObjectIds: 0,
  objectRows: 10,
  danglingObjectIds: 0,
  metadataMismatches: 0,
  detachedObjects: 0,
  duplicateStorageKeyGroups: 0,
  objectBackedPendingWithoutReservation: 0,
  pendingFoundationMismatches: 0,
  orphanPendingReservations: 0,
  ...over,
});

/** A backlog larger than any segment we ask for: every batch claims its full limit. */
function harness(input: {
  maxRows: number | null; backlog: number; batchSize?: number; fleetReadyEnv?: string;
}) {
  let remaining = input.backlog;
  const logs: Record<string, unknown>[] = [];
  const batchLimits: number[] = [];
  return {
    logs,
    batchLimits,
    get processedTotal() { return input.backlog - remaining; },
    run: () => runAttachmentObjectBackfill({
      options: { apply: true, batchSize: input.batchSize ?? 100, maxRows: input.maxRows },
      // "fleetReadyEnv" in input distinguishes "not specified by the test" from
      // "explicitly unset", which a ?? default would collapse into the same thing.
      fleetReadyEnv: "fleetReadyEnv" in input ? input.fleetReadyEnv : "true",
      serverExists: async () => true,
      readParity: async () => report({ nullObjectIds: remaining }),
      runBatch: async (limit) => {
        batchLimits.push(limit);
        const claimed = Math.min(limit, remaining);
        remaining -= claimed;
        return { claimed, completed: claimed };
      },
      log: (record) => logs.push(record),
    }),
  };
}

test("a backlog larger than --max-rows processes exactly N and is never a completion", async () => {
  const h = harness({ maxRows: 40, backlog: 500, batchSize: 25 });

  await assert.rejects(h.run(), /NOT a completion receipt/, "a segment must not end as success");

  assert.equal(h.processedTotal, 40, "exactly --max-rows rows are processed, not the whole backlog");
  const segmented = h.logs.find((l) => l.phase === "segmented");
  assert.ok(segmented, "the segmented label must be emitted");
  assert.match(String(segmented.note), /feature flag/, "it must say what it may not be cited for");
});

test("the segmented label is emitted even though the parity gate would also have failed", async () => {
  // The ordering tooth. This run leaves 460 null projections behind, so the
  // completion gate would throw if it ran first — and the segmented label would
  // never appear. Moving the gate back in front of the classification makes
  // this fail on the message, which is exactly the regression under guard.
  const h = harness({ maxRows: 40, backlog: 500, batchSize: 25 });

  await assert.rejects(h.run(), (err: Error) => {
    assert.match(err.message, /Segmented run/, "a segment must fail AS a segment");
    assert.doesNotMatch(err.message, /parity gate failed/, "the generic gate must not preempt the label");
    return true;
  });

  assert.ok(h.logs.some((l) => l.phase === "segmented"), "segmented label must survive the failure path");
});

test("a full run with a clean sheet completes", async () => {
  const h = harness({ maxRows: null, backlog: 30, batchSize: 25 });

  const result = await h.run();

  assert.equal(result.outcome, "complete");
  assert.equal(result.completed, 30);
  assert.ok(!h.logs.some((l) => l.phase === "segmented"), "a full run carries no segment label");
});

test("a full projection backfill completes independently of detached-object remediation", async () => {
  let remaining = 2;
  const result = await runAttachmentObjectBackfill({
    options: { apply: true, batchSize: 100, maxRows: null },
    fleetReadyEnv: "true",
    readParity: async () => report({ nullObjectIds: remaining, detachedObjects: 965 }),
    runBatch: async () => {
      const claimed = remaining;
      remaining = 0;
      return { claimed, completed: claimed };
    },
    log: () => {},
  });
  assert.deepEqual(result, { completed: 2, outcome: "complete" });
});

test("a dry run reads parity and writes nothing", async () => {
  const batches: number[] = [];
  const result = await runAttachmentObjectBackfill({
    options: { apply: false, batchSize: 100, maxRows: null },
    fleetReadyEnv: undefined,
    readParity: async () => report({ nullObjectIds: 500 }),
    runBatch: async (limit) => { batches.push(limit); return { claimed: 0, completed: 0 }; },
    log: () => {},
  });

  assert.equal(result.outcome, "dry_run");
  assert.deepEqual(batches, [], "a dry run must never claim a batch");
});

test("orphaned projections stop the run before any batch is claimed", async () => {
  const batches: number[] = [];
  await assert.rejects(
    runAttachmentObjectBackfill({
      options: { apply: true, batchSize: 100, maxRows: null },
      fleetReadyEnv: "true",
      readParity: async () => report({ nullObjectIds: 5, orphanNullObjectIds: 5 }),
      runBatch: async (limit) => { batches.push(limit); return { claimed: 0, completed: 0 }; },
      log: () => {},
    }),
    /Preflight failed/,
  );

  assert.deepEqual(batches, [], "preflight must run before any write, not after");
});

test("--apply refuses to write when the fleet-ready gate is unset", async () => {
  // Restored after an extraction dropped it (task #79 review RED, @kingwl):
  // moving the sequence out of the entry point silently lost this guard, so
  // unset/false would have written. Writing while a replica still single-writes
  // creates new NULL projections behind the migration.
  const h = harness({ maxRows: null, backlog: 500, fleetReadyEnv: undefined });

  await assert.rejects(h.run(), /ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY=true is required/);
  assert.equal(h.processedTotal, 0, "no batch may be claimed without the fleet guarantee");
  assert.deepEqual(h.batchLimits, [], "zero batches, not merely zero completions");
});

test("anything other than the exact string \"true\" fails closed", async () => {
  for (const value of ["false", "TRUE", "1", "yes", ""]) {
    const h = harness({ maxRows: null, backlog: 10, fleetReadyEnv: value });
    await assert.rejects(h.run(), /is required with --apply/, `value ${JSON.stringify(value)}`);
    assert.deepEqual(h.batchLimits, [], `value ${JSON.stringify(value)} must claim nothing`);
  }
});

test("a dry run is not blocked by the fleet gate", async () => {
  // Reading the backlog needs no fleet guarantee, and blocking dry runs would
  // remove the only safe way to inspect it.
  const batches: number[] = [];
  const result = await runAttachmentObjectBackfill({
    options: { apply: false, batchSize: 100, maxRows: null },
    fleetReadyEnv: undefined,
    readParity: async () => report({ nullObjectIds: 500 }),
    runBatch: async (limit) => { batches.push(limit); return { claimed: 0, completed: 0 }; },
    log: () => {},
  });

  assert.equal(result.outcome, "dry_run");
  assert.deepEqual(batches, []);
});

// --- task #103: server-scoped canary -----------------------------------

test("a display name is refused as a server identity", async () => {
  // `artea-in-raft` is a human label. Binding execution to it — or to anything
  // resolved by matching — is how a canary silently targets the wrong rows.
  await assert.rejects(
    runAttachmentObjectBackfill({
      options: { apply: true, batchSize: 100, maxRows: null, serverId: "artea-in-raft" },
      fleetReadyEnv: "true",
      readParity: async () => report(),
      runBatch: async () => ({ claimed: 0, completed: 0 }),
      log: () => {},
    }),
    /must be a canonical UUID/,
  );
});

test("a non-target orphan stops the scoped canary before any batch", async () => {
  // Orphan-null is NOT work scope. It is evidence the database's FK/NOT NULL
  // guarantees have failed, and those are database-wide — so another server's
  // orphan must block this canary. Letting it through is the defect
  // (@kingwl, confirmed by @Tenny).
  const batches: number[] = [];
  await assert.rejects(
    runAttachmentObjectBackfill({
      options: { apply: true, batchSize: 100, maxRows: null, serverId: "11111111-2222-4333-8444-555555555555" },
      fleetReadyEnv: "true",
      serverExists: async () => true,
      // Target is clean; the orphan belongs to some other server.
      readParity: async () => report({ nullObjectIds: 0, orphanNullObjectIds: 3 }),
      runBatch: async (limit) => { batches.push(limit); return { claimed: 0, completed: 0 }; },
      log: () => {},
    }),
    /Preflight failed/,
  );
  assert.deepEqual(batches, [], "zero batches — a broken structural guarantee blocks every scope");
});

test("a scoped run completes when the target reaches zero, whatever the rest of the database holds", async () => {
  // The other half: scoped work must NOT be held open by rows outside it.
  // `readParity` here is the scoped reader, so nullObjectIds is the target's.
  const result = await runAttachmentObjectBackfill({
    options: { apply: true, batchSize: 100, maxRows: null, serverId: "11111111-2222-4333-8444-555555555555" },
    fleetReadyEnv: "true",
    serverExists: async () => true,
    readParity: async () => report({ nullObjectIds: 0, orphanNullObjectIds: 0 }),
    runBatch: async () => ({ claimed: 0, completed: 0 }),
    log: () => {},
  });

  assert.equal(result.outcome, "complete");
});

test("a canonical UUID naming no server is 0 batch / 0 write, not a completed canary", async () => {
  // The review finding: format validation alone let a typo through. The UUID is
  // well-formed, so it passed; it matched nothing, so the scoped backlog read
  // zero; and zero remaining looked exactly like success.
  const batches: number[] = [];
  await assert.rejects(
    runAttachmentObjectBackfill({
      options: { apply: true, batchSize: 100, maxRows: null, serverId: "99999999-8888-4777-8666-555555555555" },
      fleetReadyEnv: "true",
      serverExists: async () => false,
      readParity: async () => report({ nullObjectIds: 0 }),
      runBatch: async (limit) => { batches.push(limit); return { claimed: 0, completed: 0 }; },
      log: () => {},
    }),
    /does not exist/,
  );
  assert.deepEqual(batches, [], "zero batches — a typo must never read as a finished canary");
});

test("a scoped run refuses to proceed without an existence check at all", async () => {
  await assert.rejects(
    runAttachmentObjectBackfill({
      options: { apply: true, batchSize: 100, maxRows: null, serverId: "11111111-2222-4333-8444-555555555555" },
      fleetReadyEnv: "true",
      readParity: async () => report(),
      runBatch: async () => ({ claimed: 0, completed: 0 }),
      log: () => {},
    }),
    /requires a server existence check/,
  );
});
