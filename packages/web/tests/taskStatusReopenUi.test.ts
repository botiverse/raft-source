import assert from "node:assert/strict";
import test from "node:test";

import type { Task } from "../src/store/taskStore.js";
import { getTaskStatusOptions } from "../src/components/task/taskStatusUi.js";

const closedTask: Task = {
  id: "task-85",
  messageId: "task-85",
  channelId: "channel-1",
  taskNumber: 85,
  title: "Closed task",
  status: "closed",
  claimedByType: "user",
  claimedById: "user-1",
  createdById: "user-1",
  createdByType: "user",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

test("closed task status menus let the assignee either reconsider or resume directly", () => {
  assert.deepEqual(
    getTaskStatusOptions(closedTask, "user-1", false),
    [
      { id: "closed", labelId: "task.status.closed" },
      { id: "todo", labelId: "task.status.reopenToTodo" },
      { id: "in_progress", labelId: "task.status.inProgress" },
    ],
  );
});

test("admin status menus keep force overrides while naming the semantic reopen action", () => {
  assert.deepEqual(
    getTaskStatusOptions(closedTask, "admin-1", true),
    [
      { id: "todo", labelId: "task.status.reopenToTodo" },
      { id: "in_progress", labelId: "task.status.inProgress" },
      { id: "in_review", labelId: "task.status.inReview" },
      { id: "done", labelId: "task.status.done" },
      { id: "closed", labelId: "task.status.closed" },
    ],
  );
});
