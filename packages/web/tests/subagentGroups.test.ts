import assert from "node:assert/strict";
import { groupSubagents, subagentRowPresence } from "../src/components/agent/subagentGroups";
import type { TrajectoryLogEntry } from "../src/store/agentStore";

// #proj-runtime:#41: the Sub-agents view is folded only from explicit lineage markers.
const at = (s: number) => Date.UTC(2026, 10, 3, 18, 0, s);
const row = (s: number, entry: object): TrajectoryLogEntry => ({ timestamp: at(s), entry } as TrajectoryLogEntry);

test("Claude: the Agent row titles it, inner rows count as its steps, the end marker says how it ended", () => {
  const sub = { parentToolUseId: "toolu_a", subagentType: "Explore" };
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "Agent", toolInput: "Find stale call sites", callId: "toolu_a" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started (Explore)", detailKind: "subagent_activity", subagent: { ...sub, taskId: "task-1", phase: "started" } }),
    row(2, { kind: "tool_start", toolName: "Grep", toolInput: "isSecondaryThreadId", callId: "toolu_g", subagent: sub }),
    row(3, { kind: "text", text: "found 3", subagent: sub }),
    row(4, { kind: "text", text: "the agent's own text" }),
    row(9, { kind: "status", activity: "working", detail: "Subagent completed (Explore)", detailKind: "subagent_activity", subagent: { ...sub, taskId: "task-1", phase: "notification", outcome: "done" } }),
  ]);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group!.title, "Find stale call sites");
  assert.equal(group!.subagentType, "Explore");
  assert.equal(group!.state, "done");
  assert.equal(group!.steps, 1);
  assert.equal(group!.lastToolName, "Grep");
  assert.equal(group!.startedAt, at(0));
  assert.equal(group!.endedAt, at(9));
  assert.deepEqual(group!.items.map((item) => item.entry.kind), ["tool_start", "text"], "its own rows, not the lifecycle or the agent's");
  assert.equal((group!.items[0]!.entry as { subagent?: unknown }).subagent, undefined, "the view is already this sub-agent's");
});

test("Codex: the spawn row's operation is dropped from the title; a running one sorts first; a follow-up turn reopens it", () => {
  const a = { parentToolUseId: "call_a", taskId: "thread-a" };
  const b = { parentToolUseId: "call_b", taskId: "thread-b" };
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "collab_tool_call", toolInput: "spawnAgent: Run the daemon tests", callId: "call_a" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...a, phase: "started" } }),
    row(2, { kind: "status", activity: "working", detail: "Subagent completed", detailKind: "subagent_activity", subagent: { ...a, phase: "notification", outcome: "done" } }),
    row(3, { kind: "tool_start", toolName: "collab_tool_call", toolInput: "spawnAgent: Check the schema", callId: "call_b" }),
    row(4, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...b, phase: "started" } }),
    row(5, { kind: "status", activity: "working", detail: "Subagent failed", detailKind: "subagent_activity", subagent: { ...b, phase: "notification", outcome: "failed" } }),
    row(6, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...a, phase: "started" } }),
  ]);
  assert.deepEqual(groups.map((g) => [g.title, g.state]), [["Run the daemon tests", "running"], ["Check the schema", "failed"]]);
  assert.equal(groups[0]!.endedAt, undefined);
});

test("an older daemon: no title and no outcome, so it reads as ended with the type", () => {
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "Agent", toolInput: "", callId: "toolu_old" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { parentToolUseId: "toolu_old", subagentType: "Plan", phase: "started" } }),
    row(2, { kind: "status", activity: "working", detail: "Subagent completed (Plan)", detailKind: "subagent_activity", subagent: { parentToolUseId: "toolu_old", subagentType: "Plan", phase: "notification" } }),
  ]);
  assert.equal(groups[0]!.title, undefined);
  assert.equal(groups[0]!.state, "ended");
});

test("rows without a lineage marker make no sub-agent", () => {
  assert.deepEqual(groupSubagents([row(0, { kind: "tool_start", toolName: "Agent", toolInput: "x", callId: "toolu_x" }), row(1, { kind: "text", text: "Subagent completed" })]), []);
});

test("a hosted agent: its system rows are the lifecycle, its tool ends (phase active) are not", () => {
  const sub = { parentToolUseId: "send_1", taskId: "send_1" };
  const groups = groupSubagents([
    row(0, { kind: "system", title: "Subagent started", text: "worker", subagent: { ...sub, phase: "started" } }),
    row(1, { kind: "tool_start", toolName: "Bash", toolInput: "ls", subagent: { ...sub, phase: "active" } }),
    row(2, { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", subagent: { ...sub, phase: "active" } }),
    row(5, { kind: "system", title: "Subagent finished", text: "ceiling", subagent: { ...sub, phase: "ended", outcome: "ceiling", reportChars: 10 } }),
  ]);
  assert.equal(groups[0]!.state, "ceiling");
  assert.equal(groups[0]!.endedAt, at(5));
  assert.equal(groups[0]!.steps, 1);
});

test("a sub-agent whose start scrolled out of the loaded activity reads as ended at its last row", () => {
  const sub = { parentToolUseId: "toolu_old" };
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "Grep", toolInput: "x", subagent: sub }),
    row(7, { kind: "text", text: "done looking", subagent: sub }),
  ]);
  assert.equal(groups[0]!.state, "ended");
  assert.equal(groups[0]!.endedAt, at(7), "a fixed end, not a duration that keeps growing");
});

test("a Codex spawn without a prompt has no title, not the operation's name", () => {
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "collab_tool_call", toolInput: "spawnAgent", callId: "call_x" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { parentToolUseId: "call_x", taskId: "t", phase: "started" } }),
  ]);
  assert.equal(groups[0]!.title, undefined);
});

test("one call that starts several subagents (a Kimi AgentSwarm, a Codex spawn naming threads) gives each its own row, all titled by that call", () => {
  const a = { parentToolUseId: "call_swarm", taskId: "sub-a" };
  const b = { parentToolUseId: "call_swarm", taskId: "sub-b" };
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "Agent", toolInput: "Review both halves", callId: "call_swarm" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...a, phase: "started" } }),
    row(2, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...b, phase: "started" } }),
    row(3, { kind: "text", text: "left half ok", subagent: a }),
    row(4, { kind: "status", activity: "working", detail: "Subagent completed", detailKind: "subagent_activity", subagent: { ...a, phase: "notification", outcome: "done" } }),
  ]);
  assert.deepEqual(groups.map((g) => [g.taskId, g.title, g.state, g.items.length]), [
    ["sub-b", "Review both halves", "running", 0],
    ["sub-a", "Review both halves", "done", 1],
  ]);
});

test("Claude: inner rows that carry only the call join that call's one task", () => {
  const groups = groupSubagents([
    row(0, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { parentToolUseId: "toolu_1", taskId: "task-1", phase: "started" } }),
    row(1, { kind: "tool_start", toolName: "Grep", toolInput: "x", subagent: { parentToolUseId: "toolu_1" } }),
  ]);
  assert.deepEqual(groups.map((g) => [g.taskId, g.parentToolUseId, g.steps]), [["task-1", "toolu_1", 1]]);
});

test("a Kimi resume (the same subagent under a new call) is its own run, with its own title", () => {
  const first = { parentToolUseId: "call_1", taskId: "sub-1" };
  const resumed = { parentToolUseId: "call_2", taskId: "sub-1" };
  const groups = groupSubagents([
    row(0, { kind: "tool_start", toolName: "Agent", toolInput: "Write the parser", callId: "call_1" }),
    row(1, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...first, phase: "started" } }),
    row(2, { kind: "status", activity: "working", detail: "Subagent completed", detailKind: "subagent_activity", subagent: { ...first, phase: "notification", outcome: "done" } }),
    row(30, { kind: "tool_start", toolName: "Agent", toolInput: "Now add the tests", callId: "call_2" }),
    row(31, { kind: "status", activity: "working", detail: "Subagent started", detailKind: "subagent_activity", subagent: { ...resumed, phase: "started" } }),
    row(32, { kind: "text", text: "adding tests", subagent: resumed }),
  ]);
  assert.deepEqual(groups.map((g) => [g.parentToolUseId, g.title, g.state, g.startedAt]), [
    ["call_2", "Now add the tests", "running", at(30)],
    ["call_1", "Write the parser", "done", at(0)],
  ]);
});

describe("subagentRowPresence", () => {
  it("reads as the sub-agent's state", () => {
    expect(subagentRowPresence({ taskId: "t", phase: "started" })).toBe("busy");
    expect(subagentRowPresence({ taskId: "t", phase: "progress" })).toBe("busy");
    expect(subagentRowPresence({ taskId: "t", phase: "notification", outcome: "done" })).toBe("online");
    expect(subagentRowPresence({ taskId: "t", phase: "notification", outcome: "stopped" })).toBe("online");
    expect(subagentRowPresence({ taskId: "t", phase: "notification", outcome: "failed" })).toBe("error");
  });

  it("leaves other system rows to their error light", () => {
    expect(subagentRowPresence(undefined)).toBeNull();
    expect(subagentRowPresence({ taskId: "t" })).toBeNull();
  });
});
