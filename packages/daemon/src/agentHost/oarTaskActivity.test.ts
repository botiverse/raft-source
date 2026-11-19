import assert from "node:assert/strict";
import { test } from "vitest";
import { OarTaskRows } from "./oarTaskActivity";
import { BACKGROUND_TASK_SILENT_MS } from "../backgroundTaskHealth";

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

test("#oar-raft:#18: a child session's steps belong to the running sub-agent it names, by task id or child session", () => {
  let now = 0;
  const rows = new OarTaskRows(() => now);
  rows.onTaskEvent({ kind: "task_started", taskId: "thread-1", taskType: "agent", toolCallId: "spawn-1" });
  rows.onTaskEvent({ kind: "task_started", taskId: "t2", taskType: "agent", childSessionId: "child-2", nativeType: "explorer" });
  assert.deepEqual(rows.childStepLineage({ sessionId: "thread-1", agentPath: [] }), { taskId: "thread-1", parentToolUseId: "spawn-1" });
  assert.deepEqual(rows.childStepLineage({ sessionId: "child-2", agentPath: [] }), { taskId: "t2", subagentType: "explorer" });
  assert.equal(rows.childStepLineage({ sessionId: "unknown", agentPath: [] }), null);
  // A step is word from it: a sub-agent at work is never read as silent.
  now = BACKGROUND_TASK_SILENT_MS - 1;
  rows.childStepLineage({ sessionId: "thread-1", agentPath: [] });
  now = BACKGROUND_TASK_SILENT_MS + 10;
  assert.equal(rows.runningCount(), 1, "only t2 went silent");
  rows.onTaskEvent({ kind: "task_ended", taskId: "thread-1", status: "completed" });
  assert.equal(rows.childStepLineage({ sessionId: "thread-1", agentPath: [] }), null, "an ended one has no steps");
});

test("#oar-raft:#18: an attributed child's steps belong to the task its agentPath's leaf spawned, from the same caller", () => {
  const rows = new OarTaskRows();
  // Claude: the native task id differs from the spawning Agent call's tool_use id.
  rows.onTaskEvent({ kind: "task_started", taskId: "native-1", taskType: "agent", toolCallId: "toolu_A", nativeType: "Explore", agentPath: [] });
  // A nested sub-agent its child started, with a call id that repeats at another level.
  rows.onTaskEvent({ kind: "task_started", taskId: "native-2", taskType: "agent", toolCallId: "toolu_B", agentPath: ["toolu_A"] });
  rows.onTaskEvent({ kind: "task_started", taskId: "native-3", taskType: "agent", agentPath: [] });
  assert.deepEqual(rows.childStepLineage({ sessionId: "root", agentPath: ["toolu_A"] }), { taskId: "native-1", parentToolUseId: "toolu_A", subagentType: "Explore" });
  assert.deepEqual(rows.childStepLineage({ sessionId: "root", agentPath: ["toolu_A", "toolu_B"] }), { taskId: "native-2", parentToolUseId: "toolu_B" });
  assert.equal(rows.childStepLineage({ sessionId: "root", agentPath: ["toolu_B"] }), null, "toolu_B was started by the child, not the root");
  assert.equal(rows.childStepLineage({ sessionId: "root", agentPath: ["native-3"] }), null, "a task without a call id gets no steps; no guessing by task id");
});

test("#proj-runtime:#58: an ended sub-agent whose child calls a tool again is found to reopen; a running one is not", () => {
  const rows = new OarTaskRows();
  rows.onTaskEvent({ kind: "task_started", taskId: "thread-1", taskType: "agent", toolCallId: "spawn-1" });
  assert.equal(rows.endedTaskAtWork({ sessionId: "thread-1", agentPath: [] }), null, "still running: nothing to reopen");
  rows.onTaskEvent({ kind: "task_ended", taskId: "thread-1", status: "completed" });
  assert.equal(rows.endedTaskAtWork({ sessionId: "thread-1", agentPath: [] }), "thread-1");
  assert.equal(rows.onTaskEvent({ kind: "task_updated", taskId: "thread-1", status: "running" })?.subagent.phase, "progress");
  assert.equal(rows.isRunning("thread-1"), true);
  // A stopped one stays stopped: a late call of its child doesn't revive it.
  rows.onTaskEvent({ kind: "task_ended", taskId: "thread-1", status: "stopped" });
  assert.equal(rows.endedTaskAtWork({ sessionId: "thread-1", agentPath: [] }), null);
});
