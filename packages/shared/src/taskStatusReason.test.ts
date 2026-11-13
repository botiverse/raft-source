import assert from "node:assert/strict";

import { checkTaskStatusReason, TASK_BACKLOG_REASON_MAX_LENGTH, TASK_STATUS_REASON_INVALID } from "./taskStatusReason";

test("a move into backlog takes a reason, folded to one line", () => {
  assert.deepEqual(
    checkTaskStatusReason("backlog", "  waits for the\nserver-side record\u0085 "),
    { reason: "waits for the server-side record", refusal: null },
  );
  assert.deepEqual(checkTaskStatusReason("backlog", "x".repeat(TASK_BACKLOG_REASON_MAX_LENGTH)).refusal, null);
});

test("no reason, or a blank one, moves the task without one, whatever the status", () => {
  for (const status of ["backlog", "todo", "done"]) {
    for (const reason of [undefined, null, "", "  \n "]) {
      assert.deepEqual(checkTaskStatusReason(status, reason), { reason: undefined, refusal: null });
    }
  }
});

test("a reason is refused with any other status, not dropped", () => {
  for (const status of ["todo", "in_progress", "in_review", "done", "closed"]) {
    const { reason, refusal } = checkTaskStatusReason(status, "waits for the server-side record");
    assert.equal(reason, undefined);
    assert.equal(refusal?.code, TASK_STATUS_REASON_INVALID);
    assert.match(refusal?.message ?? "", /only for moving a task to backlog/);
  }
});

test("a reason that isn't a string, or is too long, is refused", () => {
  assert.equal(checkTaskStatusReason("backlog", 7).refusal?.code, TASK_STATUS_REASON_INVALID);
  const long = checkTaskStatusReason("backlog", "x".repeat(TASK_BACKLOG_REASON_MAX_LENGTH + 1));
  assert.equal(long.refusal?.code, TASK_STATUS_REASON_INVALID);
  assert.match(long.refusal?.message ?? "", new RegExp(`at most ${TASK_BACKLOG_REASON_MAX_LENGTH}`));
});
