// The `agent:start` `openTasks` as the daemon takes it in (core.ts): checked
// once, so the resume surfaces can trust the typed value.
import assert from "node:assert/strict";

import { MAX_AGENT_START_OPEN_TASKS, normalizeAgentStartOpenTasks } from "./startOpenTasks";

const task = { ref: "#proj:#7", title: "Ship it", status: "in_progress" };

test("a well-formed value passes through unchanged", () => {
  assert.deepEqual(normalizeAgentStartOpenTasks({ tasks: [task], more: 2 }), { tasks: [task], more: 2 });
});

test("absent or not an object with a task array: no open tasks (as from an older server)", () => {
  for (const value of [undefined, null, 7, "tasks", [], { tasks: null }, { tasks: "x" }, { more: 3 }]) {
    assert.equal(normalizeAgentStartOpenTasks(value), undefined, JSON.stringify(value));
  }
});

test("malformed entries are dropped; with none left there are no open tasks", () => {
  assert.deepEqual(normalizeAgentStartOpenTasks({
    tasks: [
      null,
      "#proj:#1",
      { ref: "", title: "empty ref", status: "todo" },
      { ref: "#proj:#2", title: 5, status: "todo" },
      { ref: "#proj:#3", title: "in review", status: "in_review" },
      { ref: "#proj:#4", title: "no status" },
      task,
    ],
    more: 0,
  }), { tasks: [task], more: 0 });
  assert.equal(normalizeAgentStartOpenTasks({ tasks: [null, { ref: 1 }], more: 4 }), undefined);
});

test("more becomes a non-negative integer", () => {
  for (const [more, expected] of [[3.7, 3], [-2, 0], [Number.NaN, 0], [Infinity, 0], ["4", 0], [undefined, 0]] as const) {
    assert.equal(normalizeAgentStartOpenTasks({ tasks: [task], more })?.more, expected, String(more));
  }
});

test("a list longer than the cap is cut, and the cut tasks are counted", () => {
  const tasks = Array.from({ length: MAX_AGENT_START_OPEN_TASKS + 3 }, (_, i) => ({ ...task, ref: `#proj:#${i + 1}` }));
  const normalized = normalizeAgentStartOpenTasks({ tasks, more: 1 });
  assert.equal(normalized?.tasks.length, MAX_AGENT_START_OPEN_TASKS);
  assert.equal(normalized?.more, 4);
});
