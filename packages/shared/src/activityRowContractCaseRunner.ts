// Test helper (not exported from the package): drives one Activity row
// contract case (contract-cases/activity-row/) through the shared rule and
// asserts its expectations. Only the keys a case lists are asserted.
import assert from "node:assert/strict";

import {
  activityRowDisplayPosition,
  activityRowFromAnswer,
  applySyncInboxRowChange,
  reduceActivityRow,
  type ActivityRowAnswer,
  type ActivityRowEvent,
  type ActivityRowState,
} from "./activityRowPosition";
import { activityLiveUnread, type ActivityUnreadMessage, type ActivityUnreadScope, type ActivityUnreadViewer } from "./activityUnreadPredicate";

type CaseRow = { unreadCount: number; hasMention: boolean; position: string | null; mentionOnly: boolean; readSeq?: string };
type CaseStep =
  | { act: "liveMessage"; seq: string; counts: boolean | null; mentionsViewer: boolean; moves?: boolean }
  | { act: "answer"; row: CaseRow }
  | { act: "read"; seq: string }
  | { act: "markUnread" }
  | { act: "syncDelete"; position: string | null; reason: "done" | "left" };
type RowExpectation = Partial<Omit<CaseRow, "readSeq">>;
type Verdict = { counts: boolean | null; mention: boolean; moves: boolean };

export type ActivityRowCase = {
  formatVersion: number;
  id: string;
  rule: "position" | "predicate" | "sync_inbox_row";
  status: "agreed" | "pending-product-decision";
  given: { row?: CaseRow; viewer?: ActivityUnreadViewer; scope?: ActivityUnreadScope; message?: ActivityUnreadMessage };
  knownGaps?: { client: string; reason: string; followUp?: string }[];
  steps: CaseStep[];
  checkpoints?: { afterStep: number; row?: RowExpectation; reread?: boolean; removed?: boolean }[];
  expect?: { row?: RowExpectation; reread?: boolean; removed?: boolean; verdict?: Verdict };
  decision?: { question: string; candidates: { id: string; currentBehaviourOf: string[]; expect: { verdict?: Verdict } }[] };
};

/** Seqs stay decimal strings end to end: never through Number (64-bit seqs lose precision past 2^53). */
export function caseRowAnswer(row: CaseRow): ActivityRowAnswer {
  return { ...row };
}

export function caseStepEvent(step: Exclude<CaseStep, { act: "syncDelete" }>): ActivityRowEvent {
  switch (step.act) {
    case "liveMessage": return { type: "live", seq: step.seq, counts: step.counts, mentionsViewer: step.mentionsViewer, ...(step.moves === undefined ? {} : { moves: step.moves }) };
    case "answer": return { type: "answer", row: caseRowAnswer(step.row) };
    case "read": return { type: "read", seq: step.seq };
    case "markUnread": return { type: "markUnread" };
  }
}

function shown(row: ActivityRowState): Required<RowExpectation> {
  return { unreadCount: row.unreadCount, hasMention: row.hasMention, position: activityRowDisplayPosition(row), mentionOnly: row.mentionOnly };
}

function assertRow(actual: ActivityRowState, expected: RowExpectation | undefined, where: string): void {
  if (!expected) return;
  const state = shown(actual);
  const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, state[key as keyof RowExpectation]]));
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
  // sync_inbox_row: an upsert is an `answer` (the same merge), a delete goes through applySyncInboxRowChange.
  let row: ActivityRowState | null = activityRowFromAnswer(caseRowAnswer(contractCase.given.row));
  let reread = false;
  contractCase.steps.forEach((step, index) => {
    if (step.act === "syncDelete") {
      assert.equal(contractCase.rule, "sync_inbox_row", "syncDelete is a sync_inbox_row act");
      row = applySyncInboxRowChange(row, { op: "delete", position: step.position }).row;
    } else {
      assert.ok(row, `step ${index + 1}: the row was removed by an earlier step`);
      const result = reduceActivityRow(row, caseStepEvent(step));
      row = result.row;
      reread ||= result.reread;
    }
    for (const checkpoint of contractCase.checkpoints ?? []) {
      if (checkpoint.afterStep !== index + 1) continue;
      assertHeld(row, checkpoint, `after step ${index + 1}`);
      if (checkpoint.reread !== undefined) assert.equal(reread, checkpoint.reread, `reread after step ${index + 1}`);
    }
  });
  assertHeld(row, expect, "at the end");
  assert.equal(reread, expect.reread, "reread at the end");
}

function assertHeld(row: ActivityRowState | null, expected: { row?: RowExpectation; removed?: boolean }, where: string): void {
  if (expected.removed !== undefined) assert.equal(row === null, expected.removed, `removed ${where}`);
  if (!expected.row) return;
  assert.ok(row, `${where}: the row is held`);
  assertRow(row, expected.row, where);
}
