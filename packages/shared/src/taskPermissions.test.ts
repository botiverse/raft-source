import assert from "node:assert/strict";
import test from "node:test";
import { TASK_ACTIONS, authorizeTaskAction } from "./taskPermissions.js";

test("Guest task access is read-only even in a joined writable channel", () => {
  for (const action of TASK_ACTIONS) {
    assert.equal(authorizeTaskAction({
      action,
      serverRole: "guest",
      canReadChannel: true,
      canWriteChannel: true,
      isCreator: true,
      isAssignee: true,
      hasAssignTasks: true,
      hasDeleteAnyTask: true,
    }), action === "read", action);
  }
});

test("task admission preserves existing non-Guest route/service authorization", () => {
  assert.equal(authorizeTaskAction({ action: "read", serverRole: "member", canReadChannel: false, canWriteChannel: true }), false);
  assert.equal(authorizeTaskAction({ action: "create", serverRole: "member", canReadChannel: true, canWriteChannel: false }), false);
  assert.equal(authorizeTaskAction({ action: "claim", serverRole: "member", canReadChannel: true, canWriteChannel: true }), true);
  assert.equal(authorizeTaskAction({ action: "unclaim", serverRole: "member", canReadChannel: true, canWriteChannel: true, isAssignee: false }), true);
  assert.equal(authorizeTaskAction({ action: "unclaim", serverRole: "member", canReadChannel: true, canWriteChannel: true, isAssignee: true }), true);
  assert.equal(authorizeTaskAction({ action: "assign", serverRole: "member", canReadChannel: true, canWriteChannel: true, hasAssignTasks: false }), true);
  assert.equal(authorizeTaskAction({ action: "assign", serverRole: "member", canReadChannel: true, canWriteChannel: true, hasAssignTasks: true }), true);
  assert.equal(authorizeTaskAction({ action: "change_status", serverRole: "admin", canReadChannel: true, canWriteChannel: true, hasDeleteAnyTask: true }), true);
  assert.equal(authorizeTaskAction({ action: "delete", serverRole: "member", canReadChannel: true, canWriteChannel: true, isCreator: true }), true);
});
