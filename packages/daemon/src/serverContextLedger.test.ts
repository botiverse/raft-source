import assert from "node:assert/strict";

import { ServerContextLedger } from "./serverContextLedger";

const facts = { id: "onboarding-owner-facts-server-1", body: "owner_name=Ada" };

test("task #26: held context reaches each process once, and a resumed session that had it is not given it again", () => {
  const ledger = new ServerContextLedger();
  assert.equal(ledger.pending("agent-1", { processInstanceId: "p1" }), null, "nothing held yet");
  assert.equal(ledger.hold("agent-1", facts), true);

  // A fresh start: no session id yet.
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p1" }), facts);
  ledger.noteWritten("agent-1", { processInstanceId: "p1" }, facts);
  assert.equal(ledger.pending("agent-1", { processInstanceId: "p1", sessionId: "s1" }), null, "the same process does not get it again");
  // A later write on that process learns its session.
  ledger.noteWritten("agent-1", { processInstanceId: "p1", sessionId: "s1" }, null);

  assert.equal(ledger.pending("agent-1", { processInstanceId: "p2", sessionId: "s1" }), null, "a resume of that session already has it");
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p3", sessionId: "s2" }), facts, "a different session does not");
});

test("task #26: a re-send of the same body changes nothing; a new body reaches everyone again", () => {
  const ledger = new ServerContextLedger();
  ledger.hold("agent-1", facts);
  ledger.noteWritten("agent-1", { processInstanceId: "p1", sessionId: "s1" }, facts);
  assert.equal(ledger.hold("agent-1", { ...facts }), false);
  assert.equal(ledger.pending("agent-1", { processInstanceId: "p1", sessionId: "s1" }), null);

  const renamed = { ...facts, body: "owner_name=Ada Lovelace" };
  assert.equal(ledger.hold("agent-1", renamed), true);
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p1", sessionId: "s1" }), renamed);
  ledger.noteWritten("agent-1", { processInstanceId: "p1", sessionId: "s1" }, facts);
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p1", sessionId: "s1" }), renamed, "a write that carried the old body does not count");
  assert.equal(ledger.pending("agent-2", { processInstanceId: "p9" }), null, "per agent");
});

test("task #26: a process that had the context learns its session; a rejected input gives the context again", () => {
  const ledger = new ServerContextLedger();
  ledger.hold("agent-1", facts);
  ledger.noteWritten("agent-1", { processInstanceId: "p1" }, facts);
  // One process per turn: the session id arrives with the turn's end.
  ledger.noteSession("agent-1", "p1", "s1");
  assert.equal(ledger.pending("agent-1", { processInstanceId: "p2", sessionId: "s1" }), null, "the next turn's process resumes s1 and has it");
  ledger.noteSession("agent-1", "p-other", "s9");
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p3", sessionId: "s9" }), facts, "a process that never had it teaches nothing");

  ledger.forgetReach("agent-1", { processInstanceId: "p1", sessionId: "s1" });
  assert.deepEqual(ledger.pending("agent-1", { processInstanceId: "p1", sessionId: "s1" }), facts);
});
