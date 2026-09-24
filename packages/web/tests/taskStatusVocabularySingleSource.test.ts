import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// The task-status vocabulary (Todo / In Progress / In Review / Done / Closed)
// existed in FOUR places before it was centralised on TASK_STATUS_UI:
// TaskBoard, LegacyTaskPanel and TasksPanel each redeclared the table, and
// TaskFilterSegmentedControl held a fifth-column copy for the filter tabs.
// The last one was missed on the first pass (@Wug caught it) precisely because
// it has a DIFFERENT SHAPE — `{ key, label }`, not `Record<TaskStatus, …>` —
// so a search for the table shape could not see it.
//
// This guard therefore matches the WORDS, not the shape, and derives the file
// list by walking the directory: a hand-written list is what let the fourth
// copy survive.

const TASK_DIR = resolve(import.meta.dirname, "../src/components/task");
const STATUS_WORDS = ["Todo", "In Progress", "In Review", "Done", "Closed"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test("the task-status vocabulary has exactly one source, and it holds ids", () => {
  const files = sourceFiles(TASK_DIR);
  assert.ok(files.length >= 5, `expected the task component dir, found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    for (const word of STATUS_WORDS) {
      // any property assigning the bare status word as a value
      const re = new RegExp(`\\b(label|title|name|text)\\s*:\\s*"${word}"`);
      if (re.test(src)) offenders.push(`${file.split("/").pop()}: ${word}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "task-status words must come from TASK_STATUS_UI[status].labelId, not a local copy:\n"
      + offenders.join("\n"),
  );
});
