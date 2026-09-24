import assert from "node:assert/strict";
import { test } from "vitest";
import { assignOrphans } from "../scripts/runTestShard.js";

// assignOrphans must be a pure function of (manifest shards, sorted orphan
// paths, per-orphan estimate). Every shard runner computes the same Map
// independently, so the same orphan always lands on the same shard
// regardless of which shard is asking — this is the root invariant that
// replaces the old "dump everything onto shard 1" behavior.

const baseShards = [
  { shard: 1, expectedDurationMs: 50_000, files: [] },
  { shard: 2, expectedDurationMs: 60_000, files: [] },
  { shard: 3, expectedDurationMs: 40_000, files: [] },
  { shard: 4, expectedDurationMs: 70_000, files: [] },
];

test("places the first orphan on the currently lightest shard", () => {
  const result = assignOrphans(baseShards, ["src/new.test.ts"], 5_000);
  // shard 3 starts at 40_000ms, the minimum.
  assert.equal(result.get("src/new.test.ts"), 3);
});

test("balances multiple orphans LPT-greedy, breaking ties by path", () => {
  const result = assignOrphans(
    baseShards,
    [
      "src/c.test.ts",
      "src/a.test.ts",
      "src/b.test.ts",
      "src/d.test.ts",
    ],
    5_000,
  );
  // Sorted: a, b, c, d. Loads start: [50, 60, 40, 70] (k=ms).
  // a -> shard 3 (40)   loads [50, 60, 45, 70]
  // b -> shard 3 (45)   loads [50, 60, 50, 70]
  // c -> shard 1 (50, ties shard 3 but shard 1 has lower index)
  //                     loads [55, 60, 50, 70]
  // d -> shard 3 (50)   loads [55, 60, 55, 70]
  assert.equal(result.get("src/a.test.ts"), 3);
  assert.equal(result.get("src/b.test.ts"), 3);
  assert.equal(result.get("src/c.test.ts"), 1);
  assert.equal(result.get("src/d.test.ts"), 3);
});

test("is deterministic regardless of input orphan ordering", () => {
  const orphans = ["src/zebra.test.ts", "src/apple.test.ts", "src/mango.test.ts"];
  const a = assignOrphans(baseShards, orphans, 5_000);
  const b = assignOrphans(baseShards, [...orphans].reverse(), 5_000);
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("does not mutate the input shards", () => {
  const shards = baseShards.map((s) => ({ ...s }));
  const snapshot = JSON.stringify(shards);
  assignOrphans(shards, ["src/x.test.ts", "src/y.test.ts"], 5_000);
  assert.equal(JSON.stringify(shards), snapshot);
});

test("returns an empty assignment when there are no orphans", () => {
  const result = assignOrphans(baseShards, [], 5_000);
  assert.equal(result.size, 0);
});

test("does not dump every orphan onto shard 1 (regression for runTestShard:79)", () => {
  // Pre-fix behavior: shardIndex === 1 absorbed every orphan. After the
  // fix, even if shard 1 starts as the lightest, a non-trivial number of
  // orphans must spread to other shards once shard 1's load catches up.
  const evenShards = [
    { shard: 1, expectedDurationMs: 10_000, files: [] },
    { shard: 2, expectedDurationMs: 10_000, files: [] },
    { shard: 3, expectedDurationMs: 10_000, files: [] },
  ];
  const orphans = Array.from({ length: 6 }, (_, i) => `src/o${i}.test.ts`);
  const result = assignOrphans(evenShards, orphans, 5_000);
  const targets = new Set(result.values());
  assert.ok(targets.size >= 2, `expected orphans to spread across shards, got ${[...targets]}`);
});
