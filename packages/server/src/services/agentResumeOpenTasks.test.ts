// How the resume start's `openTasks` is built from the bounded read (no DB;
// the read itself is covered by agentResumeOpenTasks.db.test.ts).
import assert from "node:assert/strict";

import type { AgentTaskSurface } from "./agentAssignedTaskSurfaces";
import { toAgentStartOpenTasks } from "./agentResumeOpenTasks";

function surface(channelRef: string, id: string): AgentTaskSurface {
  return { channelRef, localChannel: { id, name: channelRef.replace(/^#/, ""), serverId: "server-1", type: "channel", deletedAt: null } };
}

const surfaces = new Map<string, AgentTaskSurface>([
  ["local-1", surface("#proj", "local-1")],
  ["storage-1", surface("#proj", "local-1")],
  ["dm-1", { channelRef: "dm:@ada", localChannel: { id: "dm-1", name: "dm", serverId: "server-1", type: "dm", deletedAt: null } }],
]);

test("each row is named by its agent-facing ref, in order, with its status; the rest of the total is `more`", () => {
  assert.deepEqual(
    toAgentStartOpenTasks([
      { taskNumber: 7, title: "Ship it", status: "in_progress", channelId: "storage-1" },
      { taskNumber: 3, title: "From the DM", status: "todo", channelId: "dm-1" },
    ], 5, surfaces),
    {
      tasks: [
        { ref: "#proj:#7", title: "Ship it", status: "in_progress" },
        { ref: "dm:@ada:#3", title: "From the DM", status: "todo" },
      ],
      more: 3,
    },
  );
});

test("a row without a surface, or of a status the agent need not act on, is not named but stays counted", () => {
  assert.deepEqual(
    toAgentStartOpenTasks([
      { taskNumber: 1, title: "Unknown surface", status: "todo", channelId: "gone" },
      { taskNumber: 2, title: "In review", status: "in_review", channelId: "local-1" },
      { taskNumber: 4, title: "Named", status: "todo", channelId: "local-1" },
    ], 3, surfaces),
    { tasks: [{ ref: "#proj:#4", title: "Named", status: "todo" }], more: 2 },
  );
});

test("nothing to name: null, so the start carries no openTasks", () => {
  assert.equal(toAgentStartOpenTasks([], 0, surfaces), null);
  assert.equal(toAgentStartOpenTasks([{ taskNumber: 1, title: "x", status: "todo", channelId: "gone" }], 4, surfaces), null);
});
