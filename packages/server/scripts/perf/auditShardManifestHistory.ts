/**
 * Retrospective audit: walk every commit that touched
 * `packages/server/test-shard-manifest.json` and grade each one against the
 * pinned `calibration-baseline.json` using the same `assessCalibration`
 * the refresh-time guard will use. Prints a table; exits 0 unconditionally
 * (this is a reporting tool, not a gate — the guard owns blocking writes).
 *
 * Concrete origin: on 2026-05-29 a manual cross-commit pairing surfaced two
 * silent-debt refreshes (a70d23d9, 0440c535) where a contended agent VM
 * wrote per-file timings ~1.8x baseline. The live manifest is still 0440c535
 * with N* clamped one shard below the clean baseline's recommendation. This
 * script automates that check so it can run pre-refresh and on demand —
 * known-history-of-silent-debt > theoretical-risk for cluster #13 anchor 5.
 *
 * Run: pnpm --filter @botiverse/raft-server tsx scripts/perf/auditShardManifestHistory.ts
 *
 * Options (env vars):
 *   AUDIT_BASELINE        — path to baseline JSON (default: ./calibration-baseline.json)
 *   AUDIT_HIGH_THRESHOLD  — override default 1.3
 *   AUDIT_LOW_THRESHOLD   — override default 0.77
 *   AUDIT_JSON            — set to "1" to emit JSON instead of the table
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCalibration,
  loadBaseline,
  type CalibrationResult,
  type FileTiming,
} from "./manifestCalibration.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(SERVER_DIR, "../..");
const MANIFEST_REL = "packages/server/test-shard-manifest.json";

interface CommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

interface ManifestSnapshot {
  sourceCommit?: string | null;
  generatedAt?: string | null;
  nodeVersion?: string | null;
  shardCount?: number | null;
  totalDurationMsLocal?: number | null;
  fileTimings?: FileTiming[];
}

function listManifestCommits(): CommitEntry[] {
  // `--all` walks every ref, not just HEAD — important on shallow clones
  // and for picking up squashed-out-of-staging refresh PRs that still live
  // on `noel/manifest-refresh-*` topic branches. Oldest → newest reads more
  // naturally in a history table.
  const r = spawnSync(
    "git",
    [
      "log",
      "--all",
      "--reverse",
      "--format=%H%x09%an%x09%ad%x09%s",
      "--date=short",
      "--",
      MANIFEST_REL,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`git log failed: ${r.stderr}`);
  }
  // De-duplicate by sha — `--all` can list the same commit once per ref
  // it's reachable from (e.g. a refresh commit on both its topic branch
  // and a merged-and-still-pinned PR ref).
  const seen = new Set<string>();
  const out: CommitEntry[] = [];
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const [sha, author, date, subject] = line.split("\t");
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push({ sha, shortSha: sha.slice(0, 8), author, date, subject });
  }
  return out;
}

function loadManifestAtCommit(sha: string): ManifestSnapshot | null {
  const r = spawnSync("git", ["show", `${sha}:${MANIFEST_REL}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as ManifestSnapshot;
  } catch {
    return null;
  }
}

function statusGlyph(status: CalibrationResult["status"]): string {
  return status === "verified" ? "OK " : status === "degraded" ? "DEG" : "BAD";
}

function pad(s: string, n: number, right = false): string {
  if (s.length >= n) return s.slice(0, n);
  const fill = " ".repeat(n - s.length);
  return right ? fill + s : s + fill;
}

function main() {
  const baselinePath =
    process.env.AUDIT_BASELINE ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "calibration-baseline.json");
  const baseline = loadBaseline(baselinePath);
  // Build opts by only setting properties that are actually overridden —
  // an explicit `undefined` would clobber the DEFAULTS via object spread,
  // silently disabling the thresholds.
  const opts: { highThreshold?: number; lowThreshold?: number } = {};
  if (process.env.AUDIT_HIGH_THRESHOLD) {
    opts.highThreshold = Number(process.env.AUDIT_HIGH_THRESHOLD);
  }
  if (process.env.AUDIT_LOW_THRESHOLD) {
    opts.lowThreshold = Number(process.env.AUDIT_LOW_THRESHOLD);
  }

  const commits = listManifestCommits();
  const rows: Array<{
    commit: CommitEntry;
    snapshot: ManifestSnapshot | null;
    result?: CalibrationResult;
    skip?: string;
  }> = [];

  for (const commit of commits) {
    const snap = loadManifestAtCommit(commit.sha);
    if (!snap) {
      rows.push({ commit, snapshot: null, skip: "manifest unparseable" });
      continue;
    }
    if (!Array.isArray(snap.fileTimings) || snap.fileTimings.length === 0) {
      // Pre-fileTimings schema (e.g. the first LPT rebalance commit). The
      // audit can't grade it, but the row still belongs in the history
      // table for context.
      rows.push({ commit, snapshot: snap, skip: "no fileTimings field" });
      continue;
    }
    const result = assessCalibration(snap.fileTimings, baseline, opts);
    rows.push({ commit, snapshot: snap, result });
  }

  if (process.env.AUDIT_JSON === "1") {
    console.log(
      JSON.stringify(
        {
          baseline: {
            sourceCommit: baseline.sourceCommit,
            runner: baseline.runner,
            recordedAt: baseline.recordedAt,
            nodeVersion: baseline.nodeVersion,
          },
          commits: rows.map((row) => ({
            sha: row.commit.sha,
            author: row.commit.author,
            date: row.commit.date,
            subject: row.commit.subject,
            tTotal: row.snapshot?.totalDurationMsLocal ?? null,
            shardCount: row.snapshot?.shardCount ?? null,
            nodeVersion: row.snapshot?.nodeVersion ?? null,
            skip: row.skip ?? null,
            status: row.result?.status ?? null,
            medianRatio: row.result?.medianRatio ?? null,
            n: row.result?.n ?? null,
            overlap: row.result?.overlap ?? null,
            reason: row.result?.reason ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `Calibration baseline: ${baseline.sourceCommit?.slice(0, 8) ?? "?"} ` +
      `(${baseline.runner}, ${baseline.nodeVersion}, recorded ${baseline.recordedAt})`,
  );
  console.log(
    `${rows.length} manifest commits, oldest first. Status: OK=verified, DEG=degraded (surface), BAD=invalid (slow machine).\n`,
  );

  const header =
    pad("sha", 9) +
    pad("date", 12) +
    pad("author", 18) +
    pad("T_total", 9, true) +
    pad("N*", 4, true) +
    pad("node", 8) +
    "  " +
    pad("st", 4) +
    pad("median", 9, true) +
    pad("n", 5, true) +
    pad("overlap", 9, true) +
    "  notes";
  console.log(header);
  console.log("-".repeat(header.length));

  let degraded = 0;
  let invalid = 0;
  for (const row of rows) {
    const tTotal = row.snapshot?.totalDurationMsLocal;
    const nStar = row.snapshot?.shardCount;
    const node = row.snapshot?.nodeVersion ?? "-";
    const st = row.result ? statusGlyph(row.result.status) : "—  ";
    if (row.result?.status === "degraded") degraded++;
    if (row.result?.status === "invalid") invalid++;

    const note = row.skip ?? row.result?.reason ?? "";
    console.log(
      pad(row.commit.shortSha, 9) +
        pad(row.commit.date, 12) +
        pad(row.commit.author, 18) +
        pad(tTotal != null ? String(tTotal) : "-", 9, true) +
        pad(nStar != null ? String(nStar) : "-", 4, true) +
        pad(node, 8) +
        "  " +
        pad(st, 4) +
        pad(row.result ? row.result.medianRatio.toFixed(2) : "-", 9, true) +
        pad(row.result ? String(row.result.n) : "-", 5, true) +
        pad(row.result ? (row.result.overlap * 100).toFixed(0) + "%" : "-", 9, true) +
        "  " +
        note,
    );
  }

  console.log(
    `\nSummary: ${rows.length} commits, ${degraded} degraded, ${invalid} invalid. ` +
      `Audit is reporting-only — refresh-time guard (separate workstream) owns the write-gate.`,
  );
}

main();
