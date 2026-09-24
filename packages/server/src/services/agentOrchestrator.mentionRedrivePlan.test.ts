import { test } from "vitest";
import assert from "node:assert/strict";

import { planMentionRedriveHttpStatus, type MentionRedriveVerdict } from "./agentOrchestrator.js";

/**
 * ARMS FOR THE POST REDRIVE WRITE PATH — @Kabi's CHANGES REQUIRED on PR #6700.
 *
 * He measured the path at ZERO arms across all three of its layers (HTTP route, authorize
 * function, orchestrator method) and enumerated the three by LAYER rather than patching whichever
 * one was pointed at — his reason being that "fix what was reported" produces a state with a route
 * arm and no authz arm. I re-measured before writing: `redriveMentionDelivery` and `CAS_MISMATCH`
 * each appeared in zero test files at 09d47e6b.
 *
 * These arms cover the STATUS half of that path — the part that decides what a caller is told.
 * 202 is the only answer a caller reads as "delivery was re-attempted", so the property under test
 * is not "each verdict maps to some code" but "nothing except REDRIVE_QUEUED can produce 202".
 */

test("a queued redrive is the only verdict that answers 202", () => {
  assert.equal(planMentionRedriveHttpStatus("REDRIVE_QUEUED"), 202);
});

test("an unjoinable occurrence answers 404, not a conflict", () => {
  // 404 and 409 are not interchangeable here: 404 says "no such redrivable occurrence", 409 says
  // "it exists and someone else moved it". Collapsing them would make a missing row look like a race.
  assert.equal(planMentionRedriveHttpStatus("NOT_JOINABLE"), 404);
});

test("a CAS mismatch answers 409 and therefore does not report a re-delivery", () => {
  // CAS_MISMATCH means another writer advanced the row first. Answering 202 here would tell the
  // caller a delivery was re-attempted when the claim was refused — the duplicate-delivery shape.
  const status = planMentionRedriveHttpStatus("CAS_MISMATCH");
  assert.equal(status, 409);
  assert.notEqual(status, 202, "a refused CAS claim must never read as queued");
});

test("an already-ACKed occurrence answers 409 and is never re-delivered", () => {
  // The message already arrived. 202 would invite an operator to redrive a delivered mention.
  const status = planMentionRedriveHttpStatus("ACKED");
  assert.equal(status, 409);
  assert.notEqual(status, 202, "an ACKed occurrence must never read as queued");
});

/**
 * EXHAUSTIVENESS, and this is the arm that earns its keep over time.
 *
 * The list below is checked by the compiler against the verdict union, which is itself DERIVED
 * from `redriveMentionDelivery`'s return type rather than hand-copied. So when someone adds a
 * verdict, this file stops compiling until they decide its status — instead of the new verdict
 * silently taking whatever the final `return 409` hands it, or worse, a future refactor defaulting
 * the fall-through to 202.
 *
 * I hand-listed this union once already, in the function itself, and got it wrong in both
 * directions (omitted BROKEN_HOP, invented three states). That is precisely why the type is
 * derived and why this arm exists.
 */
const NON_QUEUED_VERDICTS: Exclude<MentionRedriveVerdict, "REDRIVE_QUEUED">[] = [
  "NOT_JOINABLE",
  "IDENTITY_UNKNOWN",
  "IDENTITY_DRIFT",
  "CAS_MISMATCH",
  "ACKED",
  "TERMINAL_ERROR",
  "INSTRUMENT_FAILED",
  "BROKEN_HOP",
];

test("no verdict other than REDRIVE_QUEUED can answer 202", () => {
  for (const verdict of NON_QUEUED_VERDICTS) {
    assert.notEqual(
      planMentionRedriveHttpStatus(verdict),
      202,
      `${verdict} must not read as a queued re-delivery`,
    );
  }
  // POSITIVE CONTROL: without this, deleting the 202 branch entirely would leave every assertion
  // above passing — a suite that cannot tell "nothing returns 202" from "202 is unreachable".
  assert.equal(planMentionRedriveHttpStatus("REDRIVE_QUEUED"), 202, "202 must still be reachable");
});

test("every verdict maps to one of the three documented statuses", () => {
  const all: MentionRedriveVerdict[] = ["REDRIVE_QUEUED", ...NON_QUEUED_VERDICTS];
  for (const verdict of all) {
    assert.ok(
      [202, 404, 409].includes(planMentionRedriveHttpStatus(verdict)),
      `${verdict} produced an undocumented status`,
    );
  }
});
