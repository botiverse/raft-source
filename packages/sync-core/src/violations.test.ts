import assert from "node:assert/strict";
import test from "node:test";
import { createSyncViolationBuffer } from "./violations.js";

test("violation buffer assigns monotonic indexes and drains from requested index", () => {
  const buffer = createSyncViolationBuffer({ capacity: 4 });

  assert.equal(
    buffer.push({ kind: "cross_epoch_arrival", domain: "messages", scopeId: "channel-1", epoch: "a" }).index,
    0,
  );
  assert.equal(
    buffer.push({ kind: "version_regression", domain: "messages", scopeId: "channel-1", seq: 2n }).index,
    1,
  );

  assert.deepEqual(buffer.drain(1), {
    records: [
      {
        index: 1,
        kind: "version_regression",
        domain: "messages",
        scopeId: "channel-1",
        seq: 2n,
      },
    ],
    droppedCount: 0,
    nextIndex: 2,
  });
});

test("violation buffer makes rollover visible with droppedCount and nextIndex", () => {
  const buffer = createSyncViolationBuffer({ capacity: 2 });

  for (const seq of [1n, 2n, 3n, 4n]) {
    buffer.push({ kind: "producer_seq_conflict", domain: "messages", scopeId: "channel-1", seq });
  }

  assert.deepEqual(buffer.drain(0), {
    records: [
      { index: 2, kind: "producer_seq_conflict", domain: "messages", scopeId: "channel-1", seq: 3n },
      { index: 3, kind: "producer_seq_conflict", domain: "messages", scopeId: "channel-1", seq: 4n },
    ],
    droppedCount: 2,
    nextIndex: 4,
  });
});

test("violation buffer doorbell receives the same indexed record as push", () => {
  const doorbellRecords: unknown[] = [];
  const buffer = createSyncViolationBuffer({
    capacity: 1,
    onViolation: (record) => doorbellRecords.push(record),
  });

  const pushed = buffer.push({
    kind: "producer_version_conflict",
    domain: "presence",
    scopeId: "agent-1",
    detail: { expectedVersion: 1, observedVersion: 0 },
  });

  assert.deepEqual(doorbellRecords, [pushed]);
  assert.deepEqual(buffer.drain(), { records: [pushed], droppedCount: 0, nextIndex: 1 });
});

test("violation buffer rejects invalid capacity and drain indexes", () => {
  assert.throws(() => createSyncViolationBuffer({ capacity: 0 }), /positive safe integer/);
  const buffer = createSyncViolationBuffer();
  assert.throws(() => buffer.drain(-1), /non-negative safe integer/);
});
