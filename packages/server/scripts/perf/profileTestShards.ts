/**
 * Profile server unit-test files individually, then bin-pack them into N
 * shards via LPT-greedy so each CI shard finishes in roughly the same time.
 * Without this manifest, index-based slicing over the sorted file list yields
 * a ~2.2x max/min imbalance on this codebase — one shard runs ~520s while the
 * fastest finishes ~240s.
 *
 * Run: pnpm --filter @botiverse/raft-server tsx scripts/perf/profileTestShards.ts
 *
 * Output: writes `packages/server/test-shard-manifest.json` next to the
 * server package. The workflow reads that file to drive the matrix.
 *
 * Shard count is NOT hard-coded — it is conservatively recommended from the
 * work weights:
 *   N* = clamp(ceil(T_total / T_max_file), MIN_SHARDS, MAX_SHARDS)
 * T_max_file remains a hard floor because a file cannot be subdivided. Vitest
 * also parallelizes files inside a shard, so this ratio is now an upper-bound
 * heuristic rather than an exact wall-clock optimum; the explicit policy cap
 * is what normally binds. The clamp guards against transient outliers and
 * GitHub's concurrent-runner cap.
 *
 * Cadence: a scheduled GitHub Actions job re-runs this daily and opens a
 * PR if the assignment drifts (new tests added, durations shifted, or N*
 * changed). Manual runs are also fine when you want to refresh before
 * adding heavy tests.
 *
 * Notes:
 * - Vitest executes files in parallel inside each shard. Profile the corpus in
 *   one Vitest process and use its per-file test durations, matching the metric
 *   printed by the real shard jobs. Starting a fresh Vitest process per file
 *   would charge runner startup 476 times even though CI pays it once per
 *   shard, distorting both the weights and the calibration baseline.
 * - Per-file durations vary run-to-run by a few %, but the bin-pack is
 *   robust to that noise — sorting by historical duration descending then
 *   placing each file on the currently shortest shard converges to a
 *   near-optimal partition for any reasonable variance.
 * - Manifest carries per-file timings (`fileTimings`) so future refresh
 *   logic / N-recomputation can reason about the data without re-profiling.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCalibrationGate,
  loadBaseline,
  type CalibrationBaseline,
} from "./manifestCalibration.js";

// Bump when the manifest shape changes in a way that callers must adapt to.
// Today: runTestShard.ts + .github/workflows/test.yml read .shardCount and
// .shards[].files; refresh-test-shard-manifest.yml reads .totalDurationMsLocal
// and .maxFileDurationMsLocal for the PR body. A consumer pinning to
// schemaVersion = 1 should be safe across daily refreshes that only
// re-balance files or change shardCount.
const MANIFEST_SCHEMA_VERSION = 1;

// Bounds for the recommended-N computation. With Vitest's in-shard file
// parallelism, `ceil(T_total / T_max_file)` is a conservative work-based
// heuristic rather than a wall-clock optimum. The bounds are the actual
// cost/concurrency POLICY:
//   - MIN guards against transient outliers from collapsing N below a useful
//     parallelism level (e.g. one slow file dragging the recommendation to
//     N=2 for a day).
//   - MAX is a deliberate COST CAP at the billing knee. Each shard bills as its
//     own job: a fixed ~28-31s checkout+install overhead (measured across two
//     CI runs) on top of test work, and GitHub rounds every job UP to the whole
//     minute. So total billed-min = N * ceil((T_total/N + setup)/60) is
//     NON-monotonic in N, with rounding cliffs — fewer shards is NOT simply
//     cheaper. Measured curve (T_total ~1647s, setup ~28s):
//       N=10 -> 39 billed / 3.5min wall  (the unclamped math optimum: channels.api
//              ~178s forces ceil(T_total/T_max_file) ~10)
//       N=9  -> 36 billed / 3.5min
//       N=8  -> ~32 but KNIFE-EDGE (234s/shard is only 6s under the 240s=4min
//              boundary; per-run jitter spills some shards to 5min)
//       N=7  -> reliably 35 billed / 4.4min  (263s/shard sits mid-band [240,300])
//       N=6  -> 36 billed / 5.0min  (DOMINATED: 302s/shard barely crosses into
//              the 6th billed minute, so it costs the same as N=9 but is slower)
//     N=7 is the robust knee: ~35 billed (saves ~4/run ~240/day vs N=10) for
//     +51s wall. It also keeps the matrix clear of GitHub's ~20-concurrent cap
//     against e2e + unit-fast + typecheck + the daemon contract jobs.
// Set per stdrc's CI-cost directive 2026-05-31 (#proj-dx); billed(N) curve
// modeled by skyzh (per-job-ceil), cross-checked firsthand by Noel (setup
// ~28-31s over runs 26699641213 + 26713334053). Revisit after a week of CI
// data; an 8-shard trial run could confirm whether N=8 holds <240s/shard
// (would save ~420/day instead) — until then N=8's nominal win is unreliable.
const MIN_SHARDS = 4;
const MAX_SHARDS = 7;
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_DIR = path.join(SERVER_DIR, "src");
const MANIFEST_PATH = path.join(SERVER_DIR, "test-shard-manifest.json");
const VITEST_CLI = path.join(SERVER_DIR, "node_modules", "vitest", "vitest.mjs");
const CALIBRATION_BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "calibration-baseline.json",
);

function recommendShardCount(totalMs: number, maxFileMs: number): number {
  if (maxFileMs <= 0) return MIN_SHARDS;
  const ideal = Math.ceil(totalMs / maxFileMs);
  return Math.max(MIN_SHARDS, Math.min(MAX_SHARDS, ideal));
}

// All file paths emitted into the manifest are POSIX-style ('/'-separated),
// relative to packages/server. This keeps daily refresh diffs stable even if
// a future refresh happens to run on a Windows runner — the alternative
// (mixed '\' and '/' separators) would make the diff look like every file
// was renamed.
function toManifestPath(absPath: string): string {
  return path.relative(SERVER_DIR, absPath).split(path.sep).join("/");
}

async function listTestFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile() && p.endsWith(".test.ts")) {
        out.push(toManifestPath(p));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

function tryGitHeadCommit(): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: SERVER_DIR, encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    // Non-fatal: a manifest without sourceCommit is still usable.
  }
  return null;
}

interface VitestJsonResult {
  name: string;
  status: "passed" | "failed" | "pending";
  startTime: number;
  endTime: number;
}

interface VitestJsonReport {
  testResults?: VitestJsonResult[];
}

function profileFiles(files: string[]): Array<{ file: string; durationMs: number; ok: boolean }> {
  const outputDir = mkdtempSync(path.join(tmpdir(), "server-vitest-profile-"));
  const outputPath = path.join(outputDir, "report.json");
  try {
    const run = spawnSync(
      "node",
      [VITEST_CLI, "run", ...files, "--reporter=json", `--outputFile=${outputPath}`],
      {
        cwd: SERVER_DIR,
        env: { ...process.env, TZ: "Asia/Singapore" },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    if (run.error) throw run.error;

    let report: VitestJsonReport;
    try {
      report = JSON.parse(readFileSync(outputPath, "utf8")) as VitestJsonReport;
    } catch (error) {
      throw new Error(
        `Vitest did not produce a readable JSON profile (exit ${String(run.status)}): ${String(error)}`,
      );
    }

    const byFile = new Map<string, VitestJsonResult>();
    for (const result of report.testResults ?? []) {
      byFile.set(toManifestPath(path.resolve(result.name)), result);
    }
    if (run.status !== 0 && ![...byFile.values()].some((result) => result.status === "failed")) {
      throw new Error(`Vitest profile exited ${String(run.status)} without a failed file result`);
    }

    return files.map((file) => {
      const result = byFile.get(file);
      if (!result) return { file, durationMs: 0, ok: false };
      const elapsedMs = result.endTime - result.startTime;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        return { file, durationMs: 0, ok: false };
      }
      return {
        file,
        // Entirely skipped files report zero elapsed time. Keep a positive
        // weight so LPT and manifest diagnostics never see a zero-cost file.
        durationMs: Math.max(1, Math.round(elapsedMs)),
        ok: result.status !== "failed",
      };
    });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function lptAssign(timings: Array<{ file: string; durationMs: number }>, shardCount: number) {
  const shards = Array.from({ length: shardCount }, () => ({ totalMs: 0, files: [] as string[] }));
  // Tie-breaker by path keeps assignment deterministic across V8 versions /
  // refresh runs when two files have equal (or near-equal, post-rounding)
  // durations — avoids spurious diff churn in the daily refresh PR.
  for (const r of [...timings].sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))) {
    let target = 0;
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].totalMs < shards[target].totalMs) target = i;
    }
    shards[target].totalMs += r.durationMs;
    shards[target].files.push(r.file);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

function ensureDepsInstalled() {
  // A stale node_modules masks as test failures (e.g. ERR_MODULE_NOT_FOUND
  // for a dep added by a recent merge). Profile bails with "Refusing to
  // write manifest from a partial / failing profile" after ~10 min, when
  // a 1.8s `pnpm install --frozen-lockfile` up-front would have caught it.
  // Frozen-lockfile is intentional: this script must never mutate the
  // lockfile — if pnpm-lock.yaml drifted on disk, the daily refresh PR
  // should fail loud rather than silently rewrite locks.
  const repoRoot = path.resolve(SERVER_DIR, "../..");
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("pnpm install --frozen-lockfile failed; aborting profile.");
    process.exit(1);
  }
}

async function main() {
  ensureDepsInstalled();
  const files = await listTestFiles(SRC_DIR);
  if (files.length === 0) {
    console.error("No *.test.ts files found under", SRC_DIR);
    process.exit(1);
  }
  console.log(`Profiling ${files.length} test files in one Vitest run...`);
  const tStart = performance.now();
  const timings = profileFiles(files);
  console.log(`Vitest profile completed in ${((performance.now() - tStart) / 1000).toFixed(1)}s.`);

  const failed = timings.filter((t) => !t.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} test file(s) failed during profiling:`);
    for (const f of failed) console.error("  ", f.file);
    console.error("Refusing to write manifest from a partial / failing profile.");
    process.exit(1);
  }

  const totalMs = timings.reduce((a, r) => a + r.durationMs, 0);
  const maxFileMs = Math.max(...timings.map((t) => t.durationMs));
  const shardCount = recommendShardCount(totalMs, maxFileMs);

  const shards = lptAssign(timings, shardCount);

  // Guard the write against a uniformly slow, non-representative profiler.
  // The baseline is intentionally separate from the live manifest: a degraded
  // manifest must not become its own calibration reference. Missing baselines
  // preserve the original #2279 bootstrap policy (write, but stamp absent), and
  // an explicit override is permanently visible as calibration.bypass=true.
  let calibrationBaseline: CalibrationBaseline | null = null;
  let calibrationBaselineError: unknown;
  try {
    calibrationBaseline = loadBaseline(CALIBRATION_BASELINE_PATH);
  } catch (err) {
    calibrationBaselineError = err;
  }
  const calibrationGate = evaluateCalibrationGate(timings, calibrationBaseline, {
    allowUncalibrated: process.argv.includes("--allow-uncalibrated"),
    baselineError: calibrationBaselineError,
  });
  for (const line of calibrationGate.diagnostics.info) console.log(line);
  for (const line of calibrationGate.diagnostics.warnings) console.warn(line);
  for (const line of calibrationGate.diagnostics.errors) console.error(line);
  if (!calibrationGate.writeAllowed) {
    process.exit(calibrationGate.exitCode ?? 1);
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceCommit: tryGitHeadCommit(),
    nodeVersion: process.version,
    shardCount,
    totalFiles: timings.length,
    totalDurationMsLocal: totalMs,
    maxFileDurationMsLocal: maxFileMs,
    // Self-describing instrument verdict: reviewers can distinguish a verified
    // profile from a degraded, bypassed, or baseline-absent write directly from
    // the manifest bytes.
    calibration: calibrationGate.provenance,
    // Per-file timings retained so the next refresh can re-derive shardCount
    // without re-profiling, and so PR reviewers can see which files dominate.
    fileTimings: [...timings]
      .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))
      .map((t) => ({ file: t.file, durationMs: t.durationMs })),
    shards: shards.map((s, i) => ({
      shard: i + 1,
      expectedDurationMs: s.totalMs,
      files: s.files,
    })),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const max = Math.max(...shards.map((s) => s.totalMs));
  const min = Math.min(...shards.map((s) => s.totalMs));
  console.log("\nWrote", MANIFEST_PATH);
  console.log(
    `Summary: T_total ${(totalMs / 1000).toFixed(1)}s  T_max_file ${(maxFileMs / 1000).toFixed(1)}s  ` +
      `N* ${shardCount} (clamped to [${MIN_SHARDS}, ${MAX_SHARDS}], raw ceil=${Math.ceil(totalMs / maxFileMs)})  ` +
      `max ${(max / 1000).toFixed(1)}s  min ${(min / 1000).toFixed(1)}s  max/min ${(max / min).toFixed(2)}x`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
