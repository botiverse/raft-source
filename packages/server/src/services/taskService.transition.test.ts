import assert from "node:assert/strict";
import { test } from "vitest";

import { getTaskStatusTransitionError } from "./taskService.js";

test("closed tasks allow direct assignee resumption but not unrelated active states", () => {
  assert.equal(getTaskStatusTransitionError("closed", "in_progress"), null);
  assert.equal(
    getTaskStatusTransitionError("closed", "in_review"),
    "cannot transition from closed to in_review",
  );
});

test("closed tasks can reopen to todo while other transition errors stay generic", () => {
  assert.equal(getTaskStatusTransitionError("closed", "todo"), null);
  assert.equal(
    getTaskStatusTransitionError("todo", "done"),
    "cannot transition from todo to done",
  );
  assert.equal(
    getTaskStatusTransitionError("closed", "closed"),
    "cannot transition from closed to closed",
  );
});
