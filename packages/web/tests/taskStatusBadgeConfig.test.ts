/**
 * Task status → badge color is a single shared source (`TASK_STATUS_UI` in
 * components/task/taskStatusUi.ts). Every surface that shows a task-status badge
 * — the message footer, the Activity/inbox thread row, task cards — reads this
 * one map, so the same task renders the same color everywhere.
 *
 * This guards the semantic that has regressed twice: `closed` is a terminal but
 * REVERSIBLE state (closed → todo is a valid transition), not a destructive
 * action, so it uses the warm-neutral `brutal-stone` token — never
 * `brutal-red`. It was fixed in task #145, then re-broke when the Activity row
 * kept its own local `statusConfig` mapping closed → brutal-red (task #543).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  getTaskStatusBackgroundStyle,
  TASK_STATUS_UI,
  STATUS_BADGE_CONFIG,
  STATUS_STYLES,
} from "../src/components/task/taskStatusUi";

test("closed task badge is neutral stone, never destructive red", () => {
  assert.equal(TASK_STATUS_UI.closed.bg, "bg-brutal-stone");
  assert.notEqual(TASK_STATUS_UI.closed.bg, "bg-brutal-red");
});

test("every task status maps to its design-system color token", () => {
  assert.equal(TASK_STATUS_UI.todo.bg, "bg-brutal-orange");
  assert.equal(TASK_STATUS_UI.in_progress.bg, "bg-brutal-cyan");
  assert.equal(TASK_STATUS_UI.in_review.bg, "bg-brutal-lavender");
  assert.equal(TASK_STATUS_UI.done.bg, "bg-brutal-lime");
  assert.equal(TASK_STATUS_UI.closed.bg, "bg-brutal-stone");
});

test("STATUS_BADGE_CONFIG and STATUS_STYLES are the same source, not divergent copies", () => {
  // Callsites read these aliases; they must stay identical to TASK_STATUS_UI or
  // the same task renders different colors in different surfaces (the task #543
  // bug — a local per-surface copy is exactly what drifted).
  assert.equal(STATUS_BADGE_CONFIG, TASK_STATUS_UI);
  assert.equal(STATUS_STYLES, TASK_STATUS_UI);
});

test("canonical task backgrounds resolve to final CSS variables from the same SSOT", () => {
  assert.deepEqual(getTaskStatusBackgroundStyle("todo"), {
    backgroundColor: "var(--color-brutal-orange)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("in_progress"), {
    backgroundColor: "var(--color-brutal-cyan)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("in_review"), {
    backgroundColor: "var(--color-brutal-lavender)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("done"), {
    backgroundColor: "var(--color-brutal-lime)",
  });
  assert.deepEqual(getTaskStatusBackgroundStyle("closed"), {
    backgroundColor: "var(--color-brutal-stone)",
  });
});
