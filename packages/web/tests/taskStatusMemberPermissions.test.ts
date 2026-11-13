import assert from "node:assert/strict";

import type { Task } from "../src/store/taskStore";
import { canEditTaskStatus, getTaskStatusOptions } from "../src/components/task/taskStatusUi";

/**
 * The browser half of @stdrc's 2026-08-03 ruling: only DELETE is
 * creator/admin-restricted; status is a member-level action ("你想象一个正常的
 * to-do list 管理软件，它没理由是只有 admin 能操作的").
 *
 * Before this, the dropdown was hidden unless you were the assignee, an admin,
 * or the task happened to sit in `in_review`. The server now accepts these
 * writes, so without this change the rule would have looked intact to every
 * human and only agents on the CLI would have seen the new behavior.
 *
 * `taskStatusReopenUi.test.ts` covers the assignee and admin menus; this file
 * covers the non-assignee member, who previously had no menu at all.
 */

const ASSIGNEE = "user-1";
const OTHER = "user-2";

function taskWith(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    messageId: "task-1",
    channelId: "channel-1",
    taskNumber: 1,
    title: "A task",
    status: "in_progress",
    claimedByType: "user",
    claimedById: ASSIGNEE,
    createdById: ASSIGNEE,
    createdByType: "user",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

test("a non-assignee member can edit status", () => {
  assert.equal(canEditTaskStatus(taskWith(), OTHER, false), true);
});

test("a Guest moves its own channel's tasks like a member (guest matrix §1); the board only holds those", () => {
  assert.equal(canEditTaskStatus(taskWith(), OTHER, false), true);
  assert.equal(canEditTaskStatus(taskWith(), ASSIGNEE, true), true);
  assert.equal(canEditTaskStatus(taskWith({ readOnlyReason: "historical_joint_task" }), OTHER, false), false);
});

test("a member can edit status on an unclaimed task", () => {
  assert.equal(
    canEditTaskStatus(taskWith({ claimedById: null, claimedByType: null }), OTHER, false),
    true,
  );
});

test("a non-assignee gets every status, not a menu of one", () => {
  // Previously a non-assignee outside `in_review` got `[current]` -- a dropdown
  // whose only entry was the status the task already had.
  const options = getTaskStatusOptions(taskWith({ status: "in_progress" }), OTHER, false, false).map((o) => o.id);
  assert.deepEqual(options, ["todo", "in_progress", "in_review", "done", "closed"]);
});

test("there are no transition limits: todo can go straight to done (stdrc 2026-10-31)", () => {
  const options = getTaskStatusOptions(taskWith({ status: "todo" }), OTHER, false, false).map((o) => o.id);
  assert.deepEqual(options, ["todo", "in_progress", "in_review", "done", "closed"]);
});

test("assignee and non-assignee now see identical menus", () => {
  for (const status of ["todo", "in_progress", "in_review", "done", "closed"] as const) {
    const mine = getTaskStatusOptions(taskWith({ status }), ASSIGNEE, false, false).map((o) => o.id);
    const theirs = getTaskStatusOptions(taskWith({ status }), OTHER, false, false).map((o) => o.id);
    assert.deepEqual(theirs, mine, `menus diverge at status=${status}`);
  }
});

test("the in_review carve-out is gone: a reviewer can send work back, not only approve", () => {
  const options = getTaskStatusOptions(taskWith({ status: "in_review" }), OTHER, false, false).map((o) => o.id);
  // The old rule granted a non-assignee exactly [in_review, done] here.
  assert.equal(options.includes("in_progress"), true, "sending it back must be offered too");
  assert.equal(options.includes("closed"), true);
});

test("closed work can be reopened by someone other than the original assignee", () => {
  const closed = taskWith({ status: "closed" });
  assert.equal(canEditTaskStatus(closed, OTHER, false), true);
  assert.deepEqual(
    getTaskStatusOptions(closed, OTHER, false, false).map((o) => o.id),
    ["todo", "in_progress", "in_review", "done", "closed"],
  );
});

test("backlog is offered on task v2 only, and a task already in it keeps it as its current option", () => {
  const options = (status: Task["status"], taskV2: boolean) => getTaskStatusOptions(taskWith({ status }), OTHER, false, taskV2).map((option) => option.id);
  assert.equal(options("todo", false).includes("backlog"), false);
  assert.equal(options("todo", true).includes("backlog"), true);
  assert.equal(options("backlog", false).includes("backlog"), true);
});
