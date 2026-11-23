// What the contract cases (contract-cases/activity-row/) do not cover: the
// row's read seq outside a case's acts (Mark as Unread, late read acks).
import assert from "node:assert/strict";

import { activityRowFromAnswer, reduceActivityRow, type ActivityRowAnswer, type ActivityRowState } from "./activityRowPosition";

const answer = (unreadCount: number, position: string): ActivityRowAnswer => ({ unreadCount, hasMention: false, position, mentionOnly: false });
const step = (row: ActivityRowState, event: Parameters<typeof reduceActivityRow>[1]) => reduceActivityRow(row, event).row;

test("a read raises the read seq and a late, older read ack does not lower it", () => {
  let row = activityRowFromAnswer(answer(2, "101"));
  row = step(row, { type: "read", seq: "101" });
  assert.equal(row.readSeq, "101");
  row = step(row, { type: "read", seq: "99" });
  assert.equal(row.readSeq, "101");
  row = step(row, { type: "answer", row: answer(2, "101") });
  assert.equal(row.unreadCount, 0);
});

test("Mark as Unread clears the read seq: the next answer's unread stands", () => {
  let row = activityRowFromAnswer(answer(1, "101"));
  row = step(row, { type: "read", seq: "101" });
  row = step(row, { type: "markUnread" });
  assert.equal(row.readSeq, undefined);
  row = step(row, { type: "answer", row: answer(1, "101") });
  assert.equal(row.unreadCount, 1);
});

test("after Mark as Unread a read at or below the ceiling does not raise the read seq; one above it lifts the ceiling", () => {
  let row = step(activityRowFromAnswer(answer(1, "101")), { type: "read", seq: "101" });
  row = step(row, { type: "markUnread" });
  assert.equal(row.readSeqCeiling, "101");
  row = step(row, { type: "read", seq: "100" });
  assert.equal(row.readSeq, undefined);
  row = step(row, { type: "read", seq: "102" });
  assert.equal(row.readSeq, "102");
  assert.equal(row.readSeqCeiling, undefined);
  assert.equal(step(row, { type: "answer", row: answer(1, "102") }).unreadCount, 0);
});

test("a second Mark as Unread keeps the higher ceiling", () => {
  let row = step(activityRowFromAnswer(answer(1, "101")), { type: "read", seq: "101" });
  row = step(step(row, { type: "markUnread" }), { type: "markUnread" });
  assert.equal(row.readSeqCeiling, "101");
});

test("the read seq survives an answer with no position", () => {
  let row = step(activityRowFromAnswer(answer(1, "101")), { type: "read", seq: "101" });
  row = step(row, { type: "answer", row: { ...answer(1, "101"), position: null } });
  assert.equal(row.readSeq, "101");
  assert.equal(row.unreadCount, 1);
});
