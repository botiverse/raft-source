import assert from "node:assert/strict";

import {
  checkTaskAssignReason,
  TASK_ASSIGN_REASON_INVALID,
  TASK_ASSIGN_REASON_MAX_LENGTH,
  TASK_ASSIGN_REASON_REQUIRED_MESSAGE,
  TASK_ASSIGN_REASON_UNCHANGED_MESSAGE,
} from "./taskAssignReason";
import { refusalSentenceProblem } from "./refusal";

test("a hand-off takes a reason, folded to one line", () => {
  assert.deepEqual(
    checkTaskAssignReason("  waits on your call:\nship Friday or Monday?\u0085 ", true),
    { reason: "waits on your call: ship Friday or Monday?", refusal: null },
  );
  assert.deepEqual(checkTaskAssignReason("x".repeat(TASK_ASSIGN_REASON_MAX_LENGTH), true).refusal, null);
});

test("no reason, or a blank one, is no reason, whoever gets the task", () => {
  for (const handoff of [true, false]) {
    for (const reason of [undefined, null, "", "  \n "]) {
      assert.deepEqual(checkTaskAssignReason(reason, handoff), { reason: undefined, refusal: null });
    }
  }
});

test("a reason on taking the task yourself or clearing it is refused, not dropped", () => {
  const { reason, refusal } = checkTaskAssignReason("waits on the review", false);
  assert.equal(reason, undefined);
  assert.equal(refusal?.code, TASK_ASSIGN_REASON_INVALID);
  assert.match(refusal?.message ?? "", /only for handing a task to someone else/);
});

test("a reason that isn't a string, or is too long, is refused", () => {
  assert.equal(checkTaskAssignReason(7, true).refusal?.code, TASK_ASSIGN_REASON_INVALID);
  assert.match(
    checkTaskAssignReason("x".repeat(TASK_ASSIGN_REASON_MAX_LENGTH + 1), true).refusal?.message ?? "",
    new RegExp(`at most ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`),
  );
});

test("the refusal sentences say what is wrong and how to fix it, naming no command (the step is the refusal's `next`)", () => {
  for (const sentence of [TASK_ASSIGN_REASON_REQUIRED_MESSAGE, TASK_ASSIGN_REASON_UNCHANGED_MESSAGE]) {
    assert.equal(refusalSentenceProblem(sentence), null, sentence);
  }
});
