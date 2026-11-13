import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSION_NEEDS_RESET_THRESHOLD, SessionCompactionFailureLedger } from "./sessionCompactionFailureLedger";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "compaction-ledger-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("three consecutive failures of one session refuse resuming it; the count survives a new ledger (restart)", () => {
  assert.equal(SESSION_NEEDS_RESET_THRESHOLD, 3);
  const ledger = new SessionCompactionFailureLedger(dir);
  assert.equal(ledger.recordFailure("agent-1", "session-a", "deepseek/v4"), 1);
  assert.equal(ledger.recordFailure("agent-1", "session-a", "deepseek/v4"), 2);
  assert.equal(ledger.needsReset("agent-1", "session-a", "deepseek/v4"), null, "two is not yet stuck");
  assert.equal(ledger.recordFailure("agent-1", "session-a", "deepseek/v4"), 3);
  const restarted = new SessionCompactionFailureLedger(dir);
  assert.equal(restarted.needsReset("agent-1", "session-a", "deepseek/v4"), 3, "kept on disk across a daemon restart");
  // Stored in the daemon's agent state beside the workspaces, ids and counts only.
  const stored = JSON.parse(readFileSync(path.join(dir, ".agent-state", "agent-1", "compaction-failures.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["count", "model", "sessionId", "updatedAtMs", "version"]);
});

test("a new session id (Reset Session), another model, or a successful compaction clears it", () => {
  const ledger = new SessionCompactionFailureLedger(dir);
  for (let i = 0; i < 3; i++) ledger.recordFailure("agent-1", "session-a", "m1");
  assert.equal(ledger.needsReset("agent-1", "session-b", "m1"), null, "a reset session is not refused");
  assert.equal(ledger.needsReset("agent-1", "session-a", "m2"), null, "another model may fit");
  assert.equal(ledger.recordFailure("agent-1", "session-b", "m1"), 1, "a different session starts over");
  for (let i = 0; i < 3; i++) ledger.recordFailure("agent-1", "session-b", "m1");
  ledger.clear("agent-1");
  assert.equal(ledger.needsReset("agent-1", "session-b", "m1"), null);
  ledger.clear("agent-1");
});

test("agents are independent and a damaged file reads as no record", () => {
  const ledger = new SessionCompactionFailureLedger(dir);
  for (let i = 0; i < 3; i++) ledger.recordFailure("agent-1", "s", null);
  assert.equal(ledger.needsReset("agent-2", "s", null), null);
  assert.equal(ledger.needsReset("agent-1", "s", null), 3);
});
