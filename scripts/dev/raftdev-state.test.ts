/** Focused tests for raftdev trace-reader lifecycle state. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { markTraceReaderStateFileStoppedIfPresent } from "./raftdev.ts";

test("markTraceReaderStateFileStoppedIfPresent preserves run identity and stops valid state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raftdev-reader-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "demo", "traces", "reader-state.json");
  mkdirSync(join(root, "demo", "traces"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    mode: "local",
    status: "ready",
    startedAt: "2026-07-11T04:00:00.000Z",
  }));

  assert.equal(markTraceReaderStateFileStoppedIfPresent(statePath), true);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
    schemaVersion: 1,
    mode: "local",
    status: "stopped",
    startedAt: "2026-07-11T04:00:00.000Z",
  });
});

test("markTraceReaderStateFileStoppedIfPresent leaves absent state absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raftdev-reader-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "missing", "traces", "reader-state.json");

  assert.equal(markTraceReaderStateFileStoppedIfPresent(statePath), false);
});

test("markTraceReaderStateFileStoppedIfPresent refuses malformed or oversized state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raftdev-reader-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "demo", "traces", "reader-state.json");
  mkdirSync(join(root, "demo", "traces"), { recursive: true });
  const malformed = JSON.stringify({
    schemaVersion: 1,
    mode: "local",
    status: "ready",
    startedAt: "not-rfc3339",
  });
  writeFileSync(statePath, malformed);

  assert.equal(markTraceReaderStateFileStoppedIfPresent(statePath, () => {}), false);
  assert.equal(readFileSync(statePath, "utf8"), malformed);

  const oversized = " ".repeat(16 * 1024 + 1);
  writeFileSync(statePath, oversized);
  assert.equal(markTraceReaderStateFileStoppedIfPresent(statePath, () => {}), false);
  assert.equal(readFileSync(statePath, "utf8"), oversized);
});
