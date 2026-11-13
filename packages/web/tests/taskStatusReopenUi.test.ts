import assert from "node:assert/strict";

import type { Task } from "../src/store/taskStore";
import { getTaskStatusOptions } from "../src/components/task/taskStatusUi";

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

test("a closed task's menu offers every status and names the reopen action", () => {
  const expected = [
    { id: "todo", labelId: "task.status.reopenToTodo" },
    { id: "in_progress", labelId: "task.status.inProgress" },
    { id: "in_review", labelId: "task.status.inReview" },
    { id: "done", labelId: "task.status.done" },
    { id: "closed", labelId: "task.status.closed" },
  ];
  // Members and admins get the same menu: there are no transition limits.
  assert.deepEqual(getTaskStatusOptions(closedTask, "user-1", false, false), expected);
  assert.deepEqual(getTaskStatusOptions(closedTask, "admin-1", true, false), expected);
});
