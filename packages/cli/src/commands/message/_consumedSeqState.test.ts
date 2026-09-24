import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getMostRecentConsumedThreadForParent, getConsumedSeq, recordConsumedSeqs } from "./_consumedSeqState.js";

// FH-EXT-001 local-cursor unit gates (task #70). Gate numbers reference
// Kai's conformance list in #wg-external-agent:0afd19eb.

function freshStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = dir;
  return dir;
}

test("consumed cursor is strictly per-target — no cross-target leakage (gate 3)", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#busy-channel": 500 });
  assert.equal(getConsumedSeq("agent-1", "#busy-channel"), 500);
  // Channel B was never consumed: a high seq in A must prove nothing for B.
  assert.equal(getConsumedSeq("agent-1", "#quiet-channel"), undefined);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), undefined);
});

test("consumed cursor merges monotonically per target", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room": 10, "dm:@peer": 7 });
  recordConsumedSeqs("agent-1", { "#room": 8 });   // stale write must not regress
  recordConsumedSeqs("agent-1", { "#room": 12 });
  assert.equal(getConsumedSeq("agent-1", "#room"), 12);
  assert.equal(getConsumedSeq("agent-1", "dm:@peer"), 7);
});

test("absent or junk cursors resolve to undefined (omit → server fail-closed hold)", () => {
  freshStateDir();
  assert.equal(getConsumedSeq("agent-1", "#never-read"), undefined);
  recordConsumedSeqs("agent-1", { "#room": Number.NaN, "": 9, "#zero": 0 });
  assert.equal(getConsumedSeq("agent-1", "#room"), undefined);
  assert.equal(getConsumedSeq("agent-1", "#zero"), undefined);
});

test("cursors are per-agent isolated", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room": 30 });
  assert.equal(getConsumedSeq("agent-2", "#room"), undefined);
});

test("most recent thread context follows local read order, not global message seq", () => {
  freshStateDir();
  recordConsumedSeqs("agent-1", { "#room:older-read-high-seq": 200 });
  recordConsumedSeqs("agent-1", { "#room:newer-read-low-seq": 150 });

  assert.deepEqual(
    getMostRecentConsumedThreadForParent("agent-1", "#room"),
    { target: "#room:newer-read-low-seq", seq: 150, readOrder: 2 },
  );
});
