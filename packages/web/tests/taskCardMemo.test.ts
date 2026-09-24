import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Render-perf contract (#proj-frontend:24c90895). 铁根's render-count found
// /tasks re-rendered 24–46 TaskCards per task:new (whole-board churn) because
// TaskCard was NOT memoized and every callsite passed an inline
// `onOpen={() => open(task)}` closure (a fresh ref each render that would break
// the memo even if it existed). updateTaskStatus rebuilds the tasks array on a
// single task change → TasksPanel re-renders → all cards re-render.
//
// This is the (a) source-contract layer of the two-layer methodology; 铁根's
// live render-count (24–46 → ~1) is the (b) layer. These assertions are RED on
// the pre-fix shape and GREEN once TaskCard is memoized + onOpen takes the task
// + the open handlers are stabilized with useCallback.

const repoRoot = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

test("TaskCard is memoized and its onOpen takes the task (stable-handler shape)", () => {
  const src = read("src/components/task/TaskCard.tsx");

  // Memoized — a single task update re-renders only the changed card.
  assert.match(src, /export default memo\(TaskCard\)/, "TaskCard must be exported wrapped in memo()");
  assert.match(src, /import \{ memo[,)]/, "memo must be imported from react");
  assert.doesNotMatch(src, /export default function TaskCard/, "TaskCard must not be a bare default-exported function (un-memoized)");

  // onOpen takes the task so callsites pass a STABLE handler instead of an
  // inline per-row closure. The per-card closure lives inside TaskCard (does
  // not affect TaskCard's own memo).
  assert.match(src, /onOpen: \(task: Task\) => void/, "onOpen must take the task: (task: Task) => void");
  assert.match(src, /onClick=\{\(\) => onOpen\(task\)\}/, "TaskCard calls onOpen(task) internally");
});

for (const rel of [
  "src/components/task/TasksPanel.tsx",
]) {
  test(`${rel}: no inline onOpen closure at TaskCard callsites + open handler is useCallback-stabilized`, () => {
    const src = read(rel);

    // RED on the old shape: `onOpen={() => onOpenTask(task)}` / `onOpen={() => openTask(task)}`.
    // The inline closure is a fresh ref every render → breaks TaskCard's memo for every row.
    assert.doesNotMatch(
      src,
      /onOpen=\{\(\) =>/,
      "callsites must pass a stable handler (onOpen={openTask}), not an inline closure",
    );

    // The open handler threaded into the rows must itself be stable.
    assert.match(
      src,
      /const openTask = useCallback\(/,
      "openTask must be wrapped in useCallback so the memoized rows hold",
    );
  });
}
