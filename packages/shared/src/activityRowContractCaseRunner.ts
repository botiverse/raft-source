// Test helper (not exported from the package): drives one Activity row
// contract case (contract-cases/activity-row/) through the shared rule and
// asserts its expectations. Only the keys a case lists are asserted.
import assert from "node:assert/strict";

import {
  activityRowDisplayPosition,
  activityRowFromAnswer,
  reduceActivityRow,
  type ActivityRowAnswer,
  type ActivityRowEvent,
  type ActivityRowState,
} from "./activityRowPosition";
import { activityLiveUnread, type ActivityUnreadMessage, type ActivityUnreadScope, type ActivityUnreadViewer } from "./activityUnreadPredicate";

type CaseRow = { unreadCount: number; hasMention: boolean; position: string | null; mentionOnly: boolean };
type CaseStep =
  | { act: "liveMessage"; seq: string; counts: boolean | null; mentionsViewer: boolean }
  | { act: "answer"; row: CaseRow }
  | { act: "read"; seq: string };
type RowExpectation = Partial<CaseRow>;
type Verdict = { counts: boolean | null; mention: boolean };

export type ActivityRowCase = {
  formatVersion: number;
  id: string;
  rule: "position" | "predicate";
  status: "agreed" | "pending-product-decision";
  given: { row?: CaseRow; viewer?: ActivityUnreadViewer; scope?: ActivityUnreadScope; message?: ActivityUnreadMessage };
  knownGaps?: { client: string; reason: string; followUp?: string }[];
  steps: CaseStep[];
  checkpoints?: { afterStep: number; row?: RowExpectation; reread?: boolean }[];
  expect?: { row?: RowExpectation; reread?: boolean; verdict?: Verdict };
  decision?: { question: string; candidates: { id: string; currentBehaviourOf: string[]; expect: { verdict?: Verdict } }[] };
};

/** Seqs stay decimal strings end to end: never through Number (64-bit seqs lose precision past 2^53). */
export function caseRowAnswer(row: CaseRow): ActivityRowAnswer {
  return { ...row };
}

export function caseStepEvent(step: CaseStep): ActivityRowEvent {
  switch (step.act) {
    case "liveMessage": return { type: "live", seq: step.seq, counts: step.counts, mentionsViewer: step.mentionsViewer };
    case "answer": return { type: "answer", row: caseRowAnswer(step.row) };
    case "read": return { type: "read", seq: step.seq };
  }
}

function shown(row: ActivityRowState): CaseRow {
  return { unreadCount: row.unreadCount, hasMention: row.hasMention, position: activityRowDisplayPosition(row), mentionOnly: row.mentionOnly };
}

function assertRow(actual: ActivityRowState, expected: RowExpectation | undefined, where: string): void {
  if (!expected) return;
  const state = shown(actual);
  const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, state[key as keyof CaseRow]]));
  assert.deepEqual(picked, expected, where);
}

export function runActivityRowCase(contractCase: ActivityRowCase): void {
  const expect = contractCase.expect;
  assert.ok(expect, `${contractCase.id}: an agreed case has expect`);
  if (contractCase.rule === "predicate") {
    const { viewer, scope, message } = contractCase.given;
    assert.ok(viewer && scope && message);
    assert.deepEqual(activityLiveUnread(message, viewer, scope), expect.verdict);
    return;
  }
  assert.ok(contractCase.given.row);
  let row = activityRowFromAnswer(caseRowAnswer(contractCase.given.row));
  let reread = false;
  contractCase.steps.forEach((step, index) => {
    const result = reduceActivityRow(row, caseStepEvent(step));
    row = result.row;
    reread ||= result.reread;
    for (const checkpoint of contractCase.checkpoints ?? []) {
      if (checkpoint.afterStep !== index + 1) continue;
      assertRow(row, checkpoint.row, `after step ${index + 1}`);
      if (checkpoint.reread !== undefined) assert.equal(reread, checkpoint.reread, `reread after step ${index + 1}`);
    }
  });
  assertRow(row, expect.row, "at the end");
  assert.equal(reread, expect.reread, "reread at the end");
}
