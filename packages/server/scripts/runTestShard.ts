/**
 * Run server unit tests for a specific shard, using the assignment in
 * `test-shard-manifest.json`. Used by the unit-server CI job.
 *
 * Why this exists: generic index-based sharding produces a ~2.2x max/min
 * imbalance on this codebase. The manifest groups files into balanced buckets
 * by historical duration so each shard finishes in roughly the same wall-clock
 * time.
 *
 * Usage:
 *   tsx scripts/runTestShard.ts <shard-index>
 * Example:
 *   tsx scripts/runTestShard.ts 3        # run shard 3 from manifest
 *
 * Coverage safety: any `*.test.ts` file present on disk but absent from
 * the manifest (added since the manifest was last refreshed) is an
 * "orphan". Orphans are distributed across shards via LPT-greedy on the
 * shards' `expectedDurationMs` so they don't all pile onto shard 1.
 * Each shard runner computes the same assignment independently from
 * (manifest, sorted orphan paths) — a pure function — so no cross-shard
 * coordination is needed. This guarantees no test silently drops out
 * between manifest refreshes and prevents the daily-peak spike where
 * shard 1 absorbed every newly-added test.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ShardSummary {
  shard: number;
  expectedDurationMs: number;
  files: string[];
}

interface ShardManifest {
  generatedAt: string;
  shardCount: number;
  totalFiles: number;
  totalDurationMsLocal?: number;
  shards: ShardSummary[];
}

/**
 * Distribute orphan test files across shards via LPT-greedy on
 * `expectedDurationMs`. Mirrors the algorithm in
 * `scripts/perf/profileTestShards.ts` so a refresh that re-includes these
 * files lands in a similar place.
 *
 * Deterministic across all shard runners: same manifest + same on-disk
 * file set yields the same Map regardless of which shard calls it.
 *
 * Exported for unit tests.
 */
export function assignOrphans(
  shards: ShardSummary[],
  orphans: string[],
  estimatedOrphanDurationMs: number,
): Map<string, number> {
  const assignment = new Map<string, number>();
  const load = shards.map((s) => s.expectedDurationMs);
  // Sort by path so all shard runners process orphans in the same order
  // and break ties identically (cf. profileTestShards.ts lptAssign).
  const sorted = [...orphans].sort();
  for (const orphan of sorted) {
    let target = 0;
    for (let i = 1; i < load.length; i++) {
      if (load[i] < load[target]) target = i;
    }
    load[target] += estimatedOrphanDurationMs;
    assignment.set(orphan, shards[target].shard);
  }
  return assignment;
}

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(SERVER_DIR, "test-shard-manifest.json");
const VITEST_CLI = path.join(SERVER_DIR, "node_modules", "vitest", "vitest.mjs");

function toManifestPath(file: string): string {
  return file.split(path.sep).join("/");
}

async function listAllTestFiles(): Promise<string[]> {
  const out: string[] = [];
  const SRC_DIR = path.join(SERVER_DIR, "src");
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && p.endsWith(".test.ts")) {
        out.push(toManifestPath(path.relative(SERVER_DIR, p)));
      }
    }
  }
  await walk(SRC_DIR);
  return out;
}

async function main() {
  const arg = process.argv[2];
  const shardIndex = Number(arg);
  if (!Number.isInteger(shardIndex) || shardIndex < 1) {
    console.error("Usage: tsx scripts/runTestShard.ts <shard-index>");
    process.exit(2);
  }

  const manifest: ShardManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (shardIndex > manifest.shardCount) {
    console.error(`Shard ${shardIndex} out of range (manifest has ${manifest.shardCount}).`);
    process.exit(2);
  }

  const allOnDisk = new Set(await listAllTestFiles());
  const claimed = new Set<string>();
  for (const s of manifest.shards) for (const f of s.files) claimed.add(f);
  const orphans = [...allOnDisk].filter((f) => !claimed.has(f)).sort();

  const myShard = manifest.shards.find((s) => s.shard === shardIndex)!;
  const myFiles = [...myShard.files];
  if (orphans.length > 0) {
    // Per-orphan estimate: average file duration across the manifest. The
    // manifest doesn't record per-orphan timings (they're new files), so
    // we use the population mean as a conservative proxy. Falls back to
    // sum-of-shard-expected / totalFiles when totalDurationMsLocal is
    // absent (older manifests pre-schemaVersion=1).
    const totalMs =
      manifest.totalDurationMsLocal ??
      manifest.shards.reduce((a, s) => a + s.expectedDurationMs, 0);
    const totalFiles = manifest.totalFiles || manifest.shards.reduce((a, s) => a + s.files.length, 0);
    const avgFileMs = totalFiles > 0 ? Math.round(totalMs / totalFiles) : 0;
    const assignment = assignOrphans(manifest.shards, orphans, avgFileMs);
    const myOrphans = orphans.filter((f) => assignment.get(f) === shardIndex);
    if (shardIndex === 1) {
      // Log the full distribution from one shard so CI logs carry the
      // overview without each of the N shards spamming the same table.
      console.log(
        `[runTestShard] manifest is stale; ${orphans.length} test file(s) not in manifest, distributing across shards (avg=${avgFileMs}ms/file):`,
      );
      const perShard = new Map<number, string[]>();
      for (const [file, shard] of assignment) {
        if (!perShard.has(shard)) perShard.set(shard, []);
        perShard.get(shard)!.push(file);
      }
      for (const shard of [...perShard.keys()].sort((a, b) => a - b)) {
        for (const f of perShard.get(shard)!.sort()) {
          console.log(`   shard ${shard}: ${f}`);
        }
      }
    }
    if (myOrphans.length > 0) {
      console.log(`[runTestShard] shard ${shardIndex} picking up ${myOrphans.length} orphan(s)`);
      myFiles.push(...myOrphans);
    }
  }

  // Also detect files in the manifest that no longer exist on disk
  // (renamed / deleted). Drop them with a warning rather than asking
  // Vitest to read a missing file.
  const present = myFiles.filter((f) => allOnDisk.has(f));
  const missing = myFiles.filter((f) => !allOnDisk.has(f));
  if (missing.length > 0) {
    console.log(`[runTestShard] manifest references ${missing.length} missing file(s); skipping:`);
    for (const f of missing) console.log("  ", f);
  }

  console.log(
    `[runTestShard] shard ${shardIndex}/${manifest.shardCount}: ${present.length} files (expected ~${(myShard.expectedDurationMs / 1000).toFixed(1)}s)`,
  );

  const child = spawn(process.execPath, [VITEST_CLI, "run", ...present], {
    cwd: SERVER_DIR,
    env: { ...process.env, TZ: process.env.TZ || "Asia/Singapore" },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

// Only run main when invoked directly (tsx scripts/runTestShard.ts <n>),
// not when imported by a unit test that just wants `assignOrphans`.
const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
