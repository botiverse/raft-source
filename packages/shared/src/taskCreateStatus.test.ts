import assert from "node:assert/strict";

import { TASK_STATUSES } from "./index";
import {
  checkTaskCreateStatus,
  isTaskCreateStatus,
  resolveTaskCreateStatus,
  TASK_CREATE_STATUS_NOT_ALLOWED,
  TASK_CREATE_STATUSES,
} from "./taskCreateStatus";

test("a task can be created as backlog, todo or in_progress, never as a status reached through work", () => {
  assert.deepEqual([...TASK_CREATE_STATUSES], ["backlog", "todo", "in_progress"]);
  for (const status of TASK_CREATE_STATUSES) assert.ok((TASK_STATUSES as readonly string[]).includes(status));
  for (const status of TASK_CREATE_STATUSES) assert.equal(checkTaskCreateStatus(status), null);
  assert.equal(checkTaskCreateStatus(undefined), null, "no status keeps the default");
  for (const status of ["in_review", "done", "closed", "", null, 3]) {
    assert.equal(isTaskCreateStatus(status), false);
    const refusal = checkTaskCreateStatus(status);
    assert.equal(refusal?.code, TASK_CREATE_STATUS_NOT_ALLOWED);
    assert.match(refusal?.message ?? "", /choose backlog, todo or in_progress/);
  }
});

test("backlog is task v2 only: a create that knows it isn't task v2 is refused like any other status", () => {
  assert.equal(checkTaskCreateStatus("backlog", { taskV2: true }), null);
  assert.equal(checkTaskCreateStatus("backlog"), null, "before the flag is read, the list alone");
  const refusal = checkTaskCreateStatus("backlog", { taskV2: false });
  assert.equal(refusal?.code, TASK_CREATE_STATUS_NOT_ALLOWED);
  assert.match(refusal?.message ?? "", /can't be created as backlog on a server without task conversations: choose todo or in_progress/);
  for (const status of ["todo", "in_progress", undefined]) assert.equal(checkTaskCreateStatus(status, { taskV2: false }), null);
});

test("without a status, a create starts as before; a chosen status always wins", () => {
  assert.equal(resolveTaskCreateStatus(undefined, "self"), "in_progress");
  assert.equal(resolveTaskCreateStatus(undefined, "other"), "todo");
  assert.equal(resolveTaskCreateStatus(undefined, "none"), "todo");
  assert.equal(resolveTaskCreateStatus("todo", "self"), "todo");
  assert.equal(resolveTaskCreateStatus("in_progress", "other"), "in_progress");
  assert.equal(resolveTaskCreateStatus("in_progress", "none"), "in_progress");
  assert.equal(resolveTaskCreateStatus("backlog", "self"), "backlog", "parking it for yourself does not start it");
});
