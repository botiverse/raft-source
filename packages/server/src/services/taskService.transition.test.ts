import assert from "node:assert/strict";

import { TASK_STATUSES } from "@botiverse/raft-shared";

import { getTaskStatusTransitionError } from "./taskService";

// stdrc 2026-10-31 (#wg-task-v2 msg=ad820421): no transition limits.
test("every status can move to every other status", () => {
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      if (from === to) continue;
      assert.equal(getTaskStatusTransitionError(from, to), null, `${from} -> ${to}`);
    }
  }
});

test("setting the status a task already has is refused as unchanged", () => {
  assert.equal(getTaskStatusTransitionError("closed", "closed"), "already closed");
  assert.equal(getTaskStatusTransitionError("todo", "todo"), "already todo");
});
