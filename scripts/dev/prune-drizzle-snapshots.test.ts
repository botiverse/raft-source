// Which snapshots prune-drizzle-snapshots.ts deletes. Pure selection only; the
// drizzle-kit and journal checks run on a real checkout.
// Run: pnpm exec vitest run scripts/dev/prune-drizzle-snapshots.test.ts
import assert from "node:assert/strict";
import { test } from "vitest";

import { isSnapshotPrunable, SNAPSHOT_KEEP_DAYS, SNAPSHOT_KEEP_NEWEST } from "../ci/migration-snapshot-retention.mjs";
import { formatSize, lastTouchedFromGitLog, META_DIR, selectPrunable, type Snapshot } from "./prune-drizzle-snapshots";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-05T00:00:00Z");
const LATEST = 30;
const snapshots = (from: number, to: number): Snapshot[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, file: `${META_DIR}/${String(from + i).padStart(4, "0")}_snapshot.json`, bytes: 1024 * 1024 }));
const touchedDaysAgo = (days: (n: number) => number) => new Map(snapshots(0, LATEST).map((s) => [s.number, NOW - days(s.number) * DAY]));

test("keeps the newest SNAPSHOT_KEEP_NEWEST even when old", () => {
  const { prune, keep } = selectPrunable(snapshots(10, LATEST), LATEST, touchedDaysAgo(() => 365), NOW);
  assert.deepEqual(keep.map((s) => s.number), snapshots(LATEST - SNAPSHOT_KEEP_NEWEST + 1, LATEST).map((s) => s.number));
  assert.equal(prune[0].number, 10);
  assert.equal(prune.at(-1)?.number, LATEST - SNAPSHOT_KEEP_NEWEST);
});

test("keeps everything touched within SNAPSHOT_KEEP_DAYS, and all above it", () => {
  // 0010..0019 are old; 0020.. are recent.
  const touched = touchedDaysAgo((n) => (n < 20 ? SNAPSHOT_KEEP_DAYS + 1 : SNAPSHOT_KEEP_DAYS - 1));
  const { prune, keep } = selectPrunable(snapshots(10, LATEST), LATEST, touched, NOW);
  assert.deepEqual(prune.map((s) => s.number), snapshots(10, 19).map((s) => s.number));
  assert.equal(keep[0].number, 20);
  // A recently repaired old snapshot stops the prune there: only a prefix goes,
  // so check-migration-journal.sh sees no gap.
  touched.set(15, NOW - DAY);
  assert.deepEqual(selectPrunable(snapshots(10, LATEST), LATEST, touched, NOW).prune.map((s) => s.number), [10, 11, 12, 13, 14]);
});

test("a snapshot with no date on the ref is kept, and so is everything above it", () => {
  const touched = touchedDaysAgo(() => 365);
  touched.delete(12);
  assert.deepEqual(selectPrunable(snapshots(10, LATEST), LATEST, touched, NOW).prune.map((s) => s.number), [10, 11]);
});

test("the retention rule is the gate's (exactly at the boundaries)", () => {
  const edge = LATEST - SNAPSHOT_KEEP_NEWEST;
  const old = NOW - SNAPSHOT_KEEP_DAYS * DAY - 1;
  assert.equal(isSnapshotPrunable({ number: edge, latest: LATEST, touchedAt: old, now: NOW }), true);
  assert.equal(isSnapshotPrunable({ number: edge + 1, latest: LATEST, touchedAt: old, now: NOW }), false);
  assert.equal(isSnapshotPrunable({ number: edge, latest: LATEST, touchedAt: NOW - SNAPSHOT_KEEP_DAYS * DAY, now: NOW }), false);
  assert.equal(isSnapshotPrunable({ number: edge, latest: LATEST, touchedAt: undefined, now: NOW }), false);
});

test("dates come from the newest commit touching each snapshot", () => {
  const log = [
    "\u00002026-11-04T10:00:00Z", "", `${META_DIR}/0012_snapshot.json`, `${META_DIR}/_journal.json`,
    "\u00002026-10-01T10:00:00Z", "", `${META_DIR}/0012_snapshot.json`, `${META_DIR}/0011_snapshot.json`,
    "elsewhere/0010_snapshot.json",
  ].join("\n");
  assert.deepEqual([...lastTouchedFromGitLog(log)].sort(), [
    [11, Date.parse("2026-10-01T10:00:00Z")],
    [12, Date.parse("2026-11-04T10:00:00Z")],
  ]);
});

test("sizes", () => {
  assert.equal(formatSize(snapshots(1, 3)), "3 files, 3.0 MB");
});
