import assert from "node:assert/strict";
import { test } from "vitest";
import { OarTaskRows } from "./oarTaskActivity";

test("Codex: a stopped child's aborted turn ends its row, and only a stopped one's; more work reopens it", () => {
  const rows = new OarTaskRows();
  rows.onTaskEvent({ kind: "task_started", taskId: "t1", taskType: "agent", childSessionId: "child-1", toolCallId: "call-1", nativeType: "subAgent" });
  assert.equal(rows.onChildTurnAborted("child-1"), null, "no one asked: the parent may have aborted it, and the thread lives on");
  assert.equal(rows.isRunning("t1"), true);
  rows.noteStopRequested("t1", true);
  assert.equal(rows.onChildTurnAborted("another-child"), null);
  rows.noteStopRequested("t1", false);
  assert.equal(rows.onChildTurnAborted("child-1"), null, "a refused stop leaves nothing behind");
  rows.noteStopRequested("t1", true);
  assert.deepEqual(rows.onChildTurnAborted("child-1"), {
    detail: "Subagent stopped",
    subagent: { taskId: "t1", phase: "notification", parentToolUseId: "call-1", outcome: "stopped" },
  });
  assert.equal(rows.isRunning("t1"), false);
  assert.equal(rows.onTaskEvent({ kind: "task_ended", taskId: "t1", status: "stopped" }), null, "a late end doesn't repeat the row");
  assert.equal(rows.onTaskEvent({ kind: "task_updated", taskId: "t1", status: "completed" }), null);
  assert.equal(rows.onTaskEvent({ kind: "task_updated", taskId: "t1", status: "running" })?.subagent.phase, "progress");
  assert.equal(rows.isRunning("t1"), true);
  assert.equal(rows.onChildTurnAborted("child-1"), null, "the earlier stop doesn't carry over");
});

test("a role is shown only where the runtime names one", () => {
  const rows = new OarTaskRows();
  assert.equal(rows.onTaskEvent({ kind: "task_started", taskId: "q", taskType: "agent", nativeType: "local_agent" })?.subagent.subagentType, undefined);
  assert.deepEqual(rows.onTaskEvent({ kind: "task_started", taskId: "g", taskType: "agent", nativeType: "explorer" }), {
    detail: "Subagent started (explorer)",
    subagent: { taskId: "g", phase: "started", subagentType: "explorer" },
  });
  assert.equal(rows.onTaskEvent({ kind: "task_ended", taskId: "g", status: "failed" })?.detail, "Subagent failed (explorer)");
});

test("updates and ends of tasks it has no row for make none", () => {
  const rows = new OarTaskRows();
  assert.equal(rows.onTaskEvent({ kind: "task_started", taskId: "s", taskType: "shell" }), null);
  assert.equal(rows.onTaskEvent({ kind: "task_updated", taskId: "s" }), null);
  assert.equal(rows.onTaskEvent({ kind: "task_ended", taskId: "s", status: "completed" }), null);
  assert.equal(rows.isRunning("s"), false);
});

test("running subagents are counted until they end, and one silent past the bound is presumed ended", () => {
  let nowMs = 0;
  const rows = new OarTaskRows(() => nowMs);
  rows.onTaskEvent({ kind: "task_started", taskId: "a", taskType: "agent" });
  rows.onTaskEvent({ kind: "task_started", taskId: "b", taskType: "agent" });
  rows.onTaskEvent({ kind: "task_started", taskId: "s", taskType: "shell" });
  assert.equal(rows.runningCount(1000), 2, "only subagents");
  rows.onTaskEvent({ kind: "task_ended", taskId: "a", status: "completed" });
  assert.equal(rows.runningCount(1000), 1);
  nowMs = 999;
  rows.onTaskEvent({ kind: "task_updated", taskId: "b", status: "running" });
  nowMs = 1500;
  assert.equal(rows.runningCount(1000), 1, "an event restarts the silence");
  nowMs = 2000;
  assert.equal(rows.runningCount(1000), 0, "silent for the bound: its end was lost");
});
