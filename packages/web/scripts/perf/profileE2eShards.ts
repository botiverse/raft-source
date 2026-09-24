/**
 * Profile Playwright e2e specs individually, then bin-pack them into N shards
 * via LPT-greedy so each CI shard finishes in roughly the same time. Without
 * this manifest, Playwright's built-in `--shard=I/N` slices by spec id; on
 * this codebase that produced an uneven distribution and e2e shard 4 became
 * the post-PR-#2192 wall-clock long pole (~285s vs unit-server max ~224s).
 *
 * Run: pnpm --filter @botiverse/raft-web tsx scripts/perf/profileE2eShards.ts
 *
 * Output: writes `packages/web/e2e-shard-manifest.json`. The workflow's
 * `compute-e2e-shard-matrix` job reads that file to drive the e2e matrix.
 *
 * Why one Playwright invocation (not per-spec) — globalSetup runs once per
 * `playwright test` call. Per-spec invocation would inflate every spec's
 * measured time by globalSetup cost (~few seconds), which biases LPT toward
 * fewer/larger shards via the recommendShardCount formula. One invocation
 * with `--workers=1 --reporter=json` gives a single globalSetup amortized
 * across the whole run and per-spec timings derived from playwright's own
 * per-test results.
 *
 * Shard count is NOT hard-coded — recommended from the data:
 *   N* = clamp(ceil(T_total / T_max_spec), MIN_SHARDS, MAX_SHARDS)
 * Bounds [2, 6] reflect e2e specs being thicker per-file than server-unit
 * tests + the workflow's broader concurrent-runner pressure (unit-server
 * already drives N≈11; e2e is the cousin matrix).
 *
 * Manifest carries per-file timings (`fileTimings`) so future refresh logic
 * can re-derive shardCount without re-profiling, and PR reviewers can see
 * which specs dominate.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bump when the manifest shape changes in a way that callers must adapt to.
// Today: runE2eShard.ts + .github/workflows/test.yml read .shardCount and
// .shards[].files. A consumer pinning to schemaVersion = 1 should be safe
// across refreshes that only re-balance files or change shardCount.
const MANIFEST_SCHEMA_VERSION = 1;

// E2e bounds policy:
//   MIN guards against transient outliers from collapsing N to 1.
//   MAX guards against the e2e matrix consuming too many runners stacked
//   against unit-server (N≈11) + unit-fast + typecheck + the two daemon
//   contract jobs. Per-shard globalSetup + browser+server warmup is a
//   fixed cost (~10-20s), so beyond N≈6 the warmup share starts eating
//   the wall-clock savings.
// Revisit after a week of CI data.
const MIN_SHARDS = 2;
const MAX_SHARDS = 6;

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPECS_DIR = path.join(WEB_DIR, "tests/e2e/tests");
const MANIFEST_PATH = path.join(WEB_DIR, "e2e-shard-manifest.json");

function recommendShardCount(totalMs: number, maxFileMs: number): number {
  if (maxFileMs <= 0) return MIN_SHARDS;
  const ideal = Math.ceil(totalMs / maxFileMs);
  return Math.max(MIN_SHARDS, Math.min(MAX_SHARDS, ideal));
}

// All file paths emitted into the manifest are POSIX-style ('/'-separated),
// relative to packages/web. Keeps diffs stable across runner OSes.
function toManifestPath(absPath: string): string {
  return path.relative(WEB_DIR, absPath).split(path.sep).join("/");
}

async function listSpecFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile() && p.endsWith(".spec.ts")) {
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
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: WEB_DIR, encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {}
  return null;
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function resolveSourceCommit(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readGitHead: () => string | null = tryGitHeadCommit,
): string {
  const explicit = env.E2E_PROFILE_SOURCE_COMMIT?.trim();
  const githubSha = env.GITHUB_SHA?.trim();

  if (env.GITHUB_ACTIONS === "true" && (!explicit || !githubSha)) {
    throw new Error("GitHub Actions profiling requires E2E_PROFILE_SOURCE_COMMIT and GITHUB_SHA");
  }

  const sourceCommit = explicit || readGitHead()?.trim();
  if (!sourceCommit || !FULL_COMMIT_SHA.test(sourceCommit)) {
    throw new Error("E2E profile source commit must be a lowercase 40-character Git SHA");
  }
  if (githubSha) {
    if (!FULL_COMMIT_SHA.test(githubSha)) {
      throw new Error("GITHUB_SHA must be a lowercase 40-character Git SHA");
    }
    if (sourceCommit !== githubSha) {
      throw new Error(`E2E profile source commit ${sourceCommit} does not match GITHUB_SHA ${githubSha}`);
    }
  }
  return sourceCommit;
}

export interface PlaywrightSpec {
  file?: string;
  specs?: Array<{
    file?: string;
    tests?: Array<{
      results?: Array<{ duration?: number; status?: string }>;
    }>;
  }>;
  suites?: PlaywrightSpec[];
}

export interface PlaywrightJsonReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  errors?: unknown[];
  suites?: PlaywrightSpec[];
}

export type ProfileProcessOutcome = "zero" | "nonzero" | "signal" | "spawn_failed";
export type ProfileFailureReason =
  | "failed_spec"
  | "process_nonzero"
  | "process_signal"
  | "process_spawn_failed"
  | "global_error"
  | "unexpected_tests";

export function classifyProfileVerdict(
  failedTimedFiles: string[],
  report: PlaywrightJsonReport,
  processOutcome: ProfileProcessOutcome,
): { verdict: "passed" | "failed_but_timed"; reasons: ProfileFailureReason[]; globalErrorCount: number } {
  const reasons: ProfileFailureReason[] = [];
  if (failedTimedFiles.length > 0) reasons.push("failed_spec");
  if (processOutcome === "nonzero") reasons.push("process_nonzero");
  if (processOutcome === "signal") reasons.push("process_signal");
  if (processOutcome === "spawn_failed") reasons.push("process_spawn_failed");

  const globalErrorCount = report.errors?.length ?? 0;
  if (globalErrorCount > 0) reasons.push("global_error");
  if ((report.stats?.unexpected ?? 0) > 0) reasons.push("unexpected_tests");

  return {
    verdict: reasons.length > 0 ? "failed_but_timed" : "passed",
    reasons,
    globalErrorCount,
  };
}

export function normalizeReportFile(file: string): string {
  const normalized = file.split(path.sep).join("/").replace(/\\/g, "/");
  const manifestRoot = "tests/e2e/tests/";
  const embeddedRoot = normalized.indexOf(manifestRoot);
  if (embeddedRoot >= 0) return normalized.slice(embeddedRoot);

  // Playwright JSON reports files relative to config.testDir/rootDir. Our
  // manifest namespace is packages/web-relative, so rootDir-relative paths
  // such as `agents/foo.spec.ts` need the stable manifest prefix.
  return `${manifestRoot}${normalized.replace(/^\.\//, "")}`;
}

// Walk the nested suites tree and aggregate per-file totals.
export function aggregateByFile(report: PlaywrightJsonReport): Map<string, { durationMs: number; ok: boolean }> {
  const byFile = new Map<string, { durationMs: number; ok: boolean }>();
  function visitSpec(spec: PlaywrightSpec) {
    if (spec.specs) {
      for (const s of spec.specs) {
        // Playwright reports a `file` field per spec under nested suites.
        const reportedFile = s.file ?? spec.file;
        const file = reportedFile ? normalizeReportFile(reportedFile) : undefined;
        if (file && s.tests) {
          for (const t of s.tests) {
            if (!t.results) continue;
            for (const r of t.results) {
              const cur = byFile.get(file) ?? { durationMs: 0, ok: true };
              cur.durationMs += r.duration ?? 0;
              if (r.status !== undefined && r.status !== "passed" && r.status !== "skipped") {
                cur.ok = false;
              }
              byFile.set(file, cur);
            }
          }
        }
      }
    }
    if (spec.suites) for (const sub of spec.suites) visitSpec(sub);
  }
  if (report.suites) for (const top of report.suites) visitSpec(top);
  return byFile;
}

export interface ProfileTiming {
  file: string;
  durationMs: number;
  profileStatus: "passed" | "failed";
}

export function classifyProfileTimings(
  specsOnDisk: string[],
  byFile: Map<string, { durationMs: number; ok: boolean }>,
): { timings: ProfileTiming[]; failedTimedFiles: string[]; missingTimingFiles: string[] } {
  const timings: ProfileTiming[] = [];
  const failedTimedFiles: string[] = [];
  const missingTimingFiles: string[] = [];

  for (const specPosix of specsOnDisk) {
    const entry = byFile.get(specPosix);
    if (!entry || entry.durationMs <= 0) {
      missingTimingFiles.push(specPosix);
      continue;
    }

    const profileStatus = entry.ok ? "passed" : "failed";
    timings.push({
      file: specPosix,
      durationMs: Math.round(entry.durationMs),
      profileStatus,
    });
    if (profileStatus === "failed") failedTimedFiles.push(specPosix);
  }

  return { timings, failedTimedFiles, missingTimingFiles };
}

function lptAssign(timings: Array<{ file: string; durationMs: number }>, shardCount: number) {
  const shards = Array.from({ length: shardCount }, () => ({ totalMs: 0, files: [] as string[] }));
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
  // Matches profileTestShards.ts — frozen-lockfile catches stale node_modules
  // up-front rather than after a 20+ min profile run failure. Must never
  // mutate the lockfile.
  const repoRoot = path.resolve(WEB_DIR, "../..");
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("pnpm install --frozen-lockfile failed; aborting profile.");
    process.exit(1);
  }
}

function runPlaywrightProfile(reportPath: string): { reportProduced: boolean; processOutcome: ProfileProcessOutcome } {
  // ONE invocation, --workers=1 for intrinsic serial timings, JSON reporter
  // captures per-test durations to file via PLAYWRIGHT_JSON_OUTPUT_NAME.
  // We let Playwright's webServer config start vite + the test API server
  // (reuseExistingServer=true locally so reruns of this script are cheap);
  // CI shards each get their own server.
  console.log("Running Playwright (1 invocation, --workers=1) — this may take ~20-30 min serially...\n");
  const r = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", "--workers=1", "--reporter=json"],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        TZ: "Asia/Singapore",
        // Playwright webServer health checks 127.0.0.1; http_proxy / https_proxy
        // routes those probes through the proxy and the wait-for-200 never
        // resolves. Force-bypass loopback per memory/feedback_playwright_no_proxy.
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      },
      stdio: "inherit",
    },
  );
  // We accept non-zero exit if some tests fail BUT the JSON file exists —
  // bin-packing on the passing+failed-but-timed corpus is still useful; we
  // refuse the manifest only if no JSON was produced or no specs were timed.
  const processOutcome: ProfileProcessOutcome = r.error
    ? "spawn_failed"
    : r.signal
      ? "signal"
      : r.status === 0
        ? "zero"
        : "nonzero";
  return { reportProduced: existsSync(reportPath), processOutcome };
}

async function main() {
  ensureDepsInstalled();

  // Agent VMs default to NODE_ENV=production; slockdev → Vite child processes
  // inherit it, and the React deps bundle resolves to react.production.js.
  // dev-only paths (StrictMode, hydration warnings, __DEV__ branches) get
  // skipped, which produces a class of selector / state-initialization races
  // in our e2e specs (timeouts on waitForRequest, element-not-found). Refuse
  // to profile from a production-mode bundle so we never silently emit a
  // manifest from a degraded local run.
  //
  // Anchor: agent-VM default + slockdev inheritance discussion 2026-05-28
  // (#proj-frontend Bugen PR #2253 / #engineering task #450 fixes the
  // slockdev side). When that lands, this preflight stays as belt-and-
  // suspenders against future env regressions.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "NODE_ENV=production detected; refusing to profile. Set NODE_ENV=development " +
        "before re-running (and verify your slockdev/Vite chain does not re-export production).",
    );
    process.exit(1);
  }

  // Resolve provenance before the expensive serial profile. CI must provide
  // and corroborate the exact workflow head; local runs may use git HEAD.
  const sourceCommit = resolveSourceCommit();

  const specsOnDisk = await listSpecFiles(SPECS_DIR);
  if (specsOnDisk.length === 0) {
    console.error("No *.spec.ts files found under", SPECS_DIR);
    process.exit(1);
  }
  console.log(`Discovered ${specsOnDisk.length} spec files under tests/e2e/tests.`);

  const tmpReport = path.join(tmpdir(), `playwright-profile-${Date.now()}.json`);
  const profileProcess = runPlaywrightProfile(tmpReport);
  if (!profileProcess.reportProduced) {
    console.error("Playwright did not produce a JSON report; aborting.");
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(tmpReport, "utf8")) as PlaywrightJsonReport;
  try { rmSync(tmpReport); } catch {}

  const byFile = aggregateByFile(report);
  if (byFile.size === 0) {
    console.error("Parsed Playwright report but found no per-spec timings. Aborting.");
    process.exit(1);
  }

  const { timings, failedTimedFiles, missingTimingFiles } = classifyProfileTimings(specsOnDisk, byFile);
  if (missingTimingFiles.length > 0) {
    console.error(`\n${missingTimingFiles.length} spec file(s) were missing a usable timing:`);
    for (const file of missingTimingFiles) console.error("  ", file);
    console.error("Refusing to write manifest with missing profile coverage.");
    process.exit(1);
  }
  if (failedTimedFiles.length > 0) {
    console.warn(`\n${failedTimedFiles.length} spec file(s) failed but produced usable timings:`);
    for (const file of failedTimedFiles) console.warn("  ", file);
    console.warn("Writing a timing-complete manifest; the failed profile remains explicit and does not make e2e green.");
  }
  const profileVerdict = classifyProfileVerdict(failedTimedFiles, report, profileProcess.processOutcome);

  const totalMs = timings.reduce((a, r) => a + r.durationMs, 0);
  const maxFileMs = Math.max(...timings.map((t) => t.durationMs));
  const shardCount = recommendShardCount(totalMs, maxFileMs);

  const shards = lptAssign(timings, shardCount);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceCommit,
    nodeVersion: process.version,
    shardCount,
    totalFiles: timings.length,
    totalDurationMsLocal: totalMs,
    maxFileDurationMsLocal: maxFileMs,
    profileVerdict: profileVerdict.verdict,
    profileFailureReasons: profileVerdict.reasons,
    profileProcessOutcome: profileProcess.processOutcome,
    profileGlobalErrorCount: profileVerdict.globalErrorCount,
    profileStats: report.stats ?? null,
    failedProfileFiles: failedTimedFiles,
    fileTimings: [...timings]
      .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))
      .map((t) => ({ file: t.file, durationMs: t.durationMs, profileStatus: t.profileStatus })),
    shards: shards.map((s, i) => ({
      shard: i + 1,
      expectedDurationMs: s.totalMs,
      files: s.files,
    })),
  };
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const max = Math.max(...shards.map((s) => s.totalMs));
  const min = Math.min(...shards.map((s) => s.totalMs));
  console.log("\nWrote", MANIFEST_PATH);
  console.log(
    `Summary: T_total ${(totalMs / 1000).toFixed(1)}s  T_max_spec ${(maxFileMs / 1000).toFixed(1)}s  ` +
      `N* ${shardCount} (clamped to [${MIN_SHARDS}, ${MAX_SHARDS}], raw ceil=${Math.ceil(totalMs / maxFileMs)})  ` +
      `max ${(max / 1000).toFixed(1)}s  min ${(min / 1000).toFixed(1)}s  max/min ${(max / min).toFixed(2)}x`,
  );
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
