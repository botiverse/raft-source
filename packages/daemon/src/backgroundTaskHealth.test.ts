import assert from "node:assert/strict";
import {
  BACKGROUND_TASK_KEPT_RETRACE_MS,
  BACKGROUND_TASK_SILENT_MS,
  BACKGROUND_TASK_START_SLACK_MS,
  backgroundTaskForSubagentRow,
  readDescendantEvidence,
  shouldTraceKeptCandidate,
  silentBackgroundTasks,
  silentTaskVerdict,
} from "./backgroundTaskHealth";

const MIN = 60_000;

test("a task is silent once no event has named it for the threshold, the longest silence first", () => {
  const tasks = new Map([
    ["fresh", { startedAtMs: 0, lastEventAtMs: 50 * MIN }],
    ["quiet", { startedAtMs: 0, lastEventAtMs: 0 }],
    ["edge", { startedAtMs: 5 * MIN, lastEventAtMs: 10 * MIN }],
  ]);
  const now = 10 * MIN + BACKGROUND_TASK_SILENT_MS;
  assert.deepEqual(silentBackgroundTasks(tasks, now).map((entry) => [entry.taskId, entry.silentMs]), [
    ["quiet", now],
    ["edge", BACKGROUND_TASK_SILENT_MS],
  ]);
  assert.deepEqual(silentBackgroundTasks(tasks, now - 1).map((entry) => entry.taskId), ["quiet"], "an event at minute 10 keeps it alive until minute 70");
});

test("a silent task is removed only from a readable tree with no live process started since it did", () => {
  const task = { startedAtMs: 100 * MIN };
  const before = { pid: 2, pgid: 2, startedAtMs: 10 * MIN }; // an MCP server from the session's start
  const during = { pid: 3, pgid: 3, startedAtMs: 101 * MIN }; // the task's own build
  const justBefore = { pid: 4, pgid: 4, startedAtMs: task.startedAtMs - BACKGROUND_TASK_START_SLACK_MS }; // spawned just before `started` was read
  const unknownStart = { pid: 5, pgid: 5 }; // no /proc start time (ps)

  assert.deepEqual(silentTaskVerdict(task, { treeUnreadable: false, descendants: [] }), { remove: true, descendantsAlive: 0, treeUnreadable: false });
  assert.deepEqual(silentTaskVerdict(task, { treeUnreadable: false, descendants: [before] }), { remove: true, descendantsAlive: 0, treeUnreadable: false }, "only pre-start descendants");
  assert.deepEqual(silentTaskVerdict(task, { treeUnreadable: false, descendants: [before, during] }), { remove: false, descendantsAlive: 1, treeUnreadable: false });
  assert.equal(silentTaskVerdict(task, { treeUnreadable: false, descendants: [justBefore] }).remove, false, "within the start slack");
  assert.equal(silentTaskVerdict(task, { treeUnreadable: false, descendants: [unknownStart] }).remove, false, "an unknown start may be the task's");
  assert.deepEqual(silentTaskVerdict(task, { treeUnreadable: true }), { remove: false, descendantsAlive: null, treeUnreadable: true });
});

test("the tree read: no pid, a null answer, or a throw is unreadable", async () => {
  assert.deepEqual(await readDescendantEvidence(undefined, async () => []), { treeUnreadable: true });
  assert.deepEqual(await readDescendantEvidence(42, async () => null), { treeUnreadable: true });
  assert.deepEqual(await readDescendantEvidence(42, async () => { throw new Error("ps failed"); }), { treeUnreadable: true });
  assert.deepEqual(await readDescendantEvidence(42, async (pid) => [{ pid: pid + 1, pgid: 1 }]), { treeUnreadable: false, descendants: [{ pid: 43, pgid: 1 }] });
});

test("a kept candidate is traced at once, then at most once per hour", () => {
  assert.equal(shouldTraceKeptCandidate({}, 0), true);
  assert.equal(shouldTraceKeptCandidate({ presumedEndedTracedAtMs: 0 }, BACKGROUND_TASK_KEPT_RETRACE_MS - 1), false);
  assert.equal(shouldTraceKeptCandidate({ presumedEndedTracedAtMs: 0 }, BACKGROUND_TASK_KEPT_RETRACE_MS), true);
});

test("a sub-agent's row belongs to a task by its own id, else by its call when exactly one task has that call", () => {
  const tasks = new Map<string, { parentToolUseId?: string }>([
    ["task_a", { parentToolUseId: "toolu_a" }],
    ["thread_b", { parentToolUseId: "call_swarm" }],
    ["thread_c", { parentToolUseId: "call_swarm" }],
    ["task_d", {}],
  ]);
  assert.equal(backgroundTaskForSubagentRow(tasks, { parentToolUseId: "toolu_a" }), "task_a", "Claude's inner row: the call only");
  assert.equal(backgroundTaskForSubagentRow(tasks, { taskId: "thread_b", parentToolUseId: "call_swarm" }), "thread_b");
  assert.equal(backgroundTaskForSubagentRow(tasks, { parentToolUseId: "call_swarm" }), null, "two tasks share the call: no guess");
  assert.equal(backgroundTaskForSubagentRow(tasks, { taskId: "gone", parentToolUseId: "toolu_a" }), null, "a named task that is not here is not another one");
  assert.equal(backgroundTaskForSubagentRow(tasks, { parentToolUseId: "toolu_unknown" }), null);
  assert.equal(backgroundTaskForSubagentRow(tasks, {}), null);
});
