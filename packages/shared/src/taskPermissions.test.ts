import assert from "node:assert/strict";
import { TASK_ACTIONS, authorizeTaskAction } from "./taskPermissions";

test("a Guest mutates tasks where it may write (its bound channel) and nowhere else", () => {
  for (const action of TASK_ACTIONS) {
    const base = { action, canReadChannel: true, isCreator: true, isAssignee: true };
    assert.equal(authorizeTaskAction({ ...base, canWriteChannel: true }), true, action);
    assert.equal(authorizeTaskAction({ ...base, canWriteChannel: false }), action === "read", action);
    assert.equal(authorizeTaskAction({ ...base, canWriteChannel: true, readOnlyReason: "historical_joint_task" }), action === "read", action);
  }
});

test("task admission preserves existing non-Guest route/service authorization", () => {
  assert.equal(authorizeTaskAction({ action: "read", canReadChannel: false, canWriteChannel: true }), false);
  assert.equal(authorizeTaskAction({ action: "create", canReadChannel: true, canWriteChannel: false }), false);
  assert.equal(authorizeTaskAction({ action: "claim", canReadChannel: true, canWriteChannel: true }), true);
  assert.equal(authorizeTaskAction({ action: "unclaim", canReadChannel: true, canWriteChannel: true, isAssignee: false }), true);
  assert.equal(authorizeTaskAction({ action: "unclaim", canReadChannel: true, canWriteChannel: true, isAssignee: true }), true);
  assert.equal(authorizeTaskAction({ action: "assign", canReadChannel: true, canWriteChannel: true, hasAssignTasks: false }), true);
  assert.equal(authorizeTaskAction({ action: "assign", canReadChannel: true, canWriteChannel: true, hasAssignTasks: true }), true);
  assert.equal(authorizeTaskAction({ action: "change_status", canReadChannel: true, canWriteChannel: true, hasDeleteAnyTask: true }), true);
  assert.equal(authorizeTaskAction({ action: "delete", canReadChannel: true, canWriteChannel: true, isCreator: true }), true);
  assert.equal(authorizeTaskAction({ action: "amend", canReadChannel: true, canWriteChannel: true }), true);
  assert.equal(authorizeTaskAction({ action: "amend", canReadChannel: true, canWriteChannel: false }), false);
  assert.equal(authorizeTaskAction({ action: "amend", canReadChannel: true, canWriteChannel: true, readOnlyReason: "historical_joint_task" }), false);
});
