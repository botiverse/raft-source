#!/usr/bin/env node
// Summary of the host's test-run log (testRunLog.ts) for one branch:
//
//   node --import @oxc-node/core/register scripts/vitest/test-run-report.ts \
//     [--branch NAME | --all] [--since ISO] [--all-users] [--json [--head SHA]] [--dir PATH]
//
// Reads every runs.<uid>.jsonl and rotated runs.<uid>.<ms>.<pid>.jsonl in the
// log directory (RAFT_TEST_RUN_LOG_DIR or --dir moves it). A run belongs to
// the uid that owns its file (a file whose owner isn't the uid in its name is
// skipped), never to fields in the line; by default only your own runs count,
// --all-users counts everyone's. Lines that don't parse or fail validation are
// dropped and counted on stderr. --branch defaults to the current branch
// (runs on a detached HEAD are "(detached)"); --since keeps runs started at
// or after it.
//
// Default output: a table per branch (runs, failures, total lock wait, total
// run time, distinct test files, first and last run); --all lists every branch.
//
// --json: the document Stamp takes (`stamp ci local-run --file`), version 1,
// printed as one compact line:
//   { version: 1, head_sha: <the pushed head>, branch,
//     runs: [{ started_at, duration_ms, lock_wait_ms, exit_code, head_sha, files }] }
// runs oldest first; at most the 50 most recent, 2,000 files in all and
// 256 KB of printed text, dropping the oldest runs (and then trailing files)
// to fit, said on stderr. exit_code is 128+signal for a run ended by a
// signal. No pass/fail counts: the slot doesn't see Vitest's.
//
// The document's head_sha is the head Stamp files it under (`stamp ci
// local-run --head` must equal it): --head SHA (40 hex) when given; else
// HEAD when --branch is the branch checked out here; else that local branch's
// tip; else null, said on stderr. After a squash merge the branch and its
// worktree are usually gone: pass the PR's last pushed head as --head.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RUN_LOG_NAME, runLogDir, type TestRunLine } from "./testRunLog";

export const STAMP_DOC_VERSION = 1;
export const STAMP_MAX_RUNS = 50;
export const STAMP_MAX_FILES = 2000;
export const STAMP_MAX_BYTES = 256 * 1024;
export const DETACHED = "(detached)";

/** A logged run and the uid that owns the file it came from. */
export type OwnedRun = TestRunLine & { uid: number };

export interface BranchSummary {
  branch: string;
  runs: number;
  /** Runs that exited non-zero, by a signal, or were cancelled. */
  failures: number;
  lockWaitMs: number;
  runMs: number;
  /** Distinct test files/patterns given across the runs; a run given none (the default set) counts as "<package>:*". */
  distinctFiles: number;
  firstRunAt: string;
  lastRunAt: string;
}

export interface StampRun {
  started_at: string;
  duration_ms: number;
  lock_wait_ms: number;
  exit_code: number;
  head_sha: string | null;
  files: string[];
}

export interface StampLocalRunDoc {
  version: 1;
  head_sha: string | null;
  branch: string;
  runs: StampRun[];
}

const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isOptString = (value: unknown) => value === null || typeof value === "string";

/** Whether a parsed line is a valid schema-v1 run. */
export function validRunLine(line: unknown): line is TestRunLine {
  if (!line || typeof line !== "object" || Array.isArray(line)) return false;
  const l = line as Record<string, unknown>;
  return (
    l.v === 1 &&
    (l.via === "runInTestSlot" || l.via === "holdTestSlotForThisRun") &&
    isDate(l.startedAt) &&
    isDate(l.endedAt) &&
    isCount(l.lockWaitMs) &&
    isCount(l.runMs) &&
    (l.exitCode === null || Number.isInteger(l.exitCode)) &&
    isOptString(l.signal) &&
    isOptString(l.package) &&
    isOptString(l.branch) &&
    (l.head === null || (typeof l.head === "string" && /^[0-9a-f]{40}$/.test(l.head))) &&
    Array.isArray(l.args) &&
    l.args.every((arg) => typeof arg === "string") &&
    (l.argsDropped === undefined || isCount(l.argsDropped))
  );
}

/** Valid lines of one file's text, and how many lines were dropped. */
export function parseRunLines(text: string): { lines: TestRunLine[]; invalid: number } {
  const lines: TestRunLine[] = [];
  let invalid = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line: unknown = JSON.parse(raw);
      if (validRunLine(line)) lines.push(line);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { lines, invalid };
}

/** Every run in the log directory, each owned by its file's uid. */
export function readRunLogs(dir: string): { runs: OwnedRun[]; invalid: number; skippedFiles: number } {
  const runs: OwnedRun[] = [];
  let invalid = 0;
  let skippedFiles = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { runs, invalid, skippedFiles };
  }
  for (const name of names) {
    const match = RUN_LOG_NAME.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      // A symlink, or a file planted under another uid's name.
      if (!st.isFile() || String(st.uid) !== match[1]) {
        skippedFiles += 1;
        continue;
      }
      const parsed = parseRunLines(readFileSync(path, "utf8"));
      invalid += parsed.invalid;
      for (const line of parsed.lines) runs.push({ ...line, uid: st.uid });
    } catch {
      // Rotated or pruned while reading.
    }
  }
  return { runs, invalid, skippedFiles };
}

export const branchOf = (line: TestRunLine) => line.branch ?? DETACHED;

export function filterRuns<T extends TestRunLine & { uid?: number }>(
  lines: readonly T[],
  { branch = null, since = null, uid = null }: { branch?: string | null; since?: string | null; uid?: number | null } = {},
): T[] {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  return lines.filter(
    (line) =>
      (branch === null || branchOf(line) === branch) &&
      (uid === null || line.uid === uid) &&
      (Number.isNaN(sinceMs) || Date.parse(line.startedAt) >= sinceMs),
  );
}

export function summarize(lines: readonly TestRunLine[]): BranchSummary[] {
  const byBranch = new Map<string, { summary: BranchSummary; files: Set<string> }>();
  for (const line of lines) {
    const name = branchOf(line);
    let entry = byBranch.get(name);
    if (!entry) {
      entry = {
        summary: { branch: name, runs: 0, failures: 0, lockWaitMs: 0, runMs: 0, distinctFiles: 0, firstRunAt: line.startedAt, lastRunAt: line.startedAt },
        files: new Set(),
      };
      byBranch.set(name, entry);
    }
    const s = entry.summary;
    s.runs += 1;
    if (line.exitCode !== 0) s.failures += 1;
    s.lockWaitMs += line.lockWaitMs;
    s.runMs += line.runMs;
    if (line.args.length === 0) entry.files.add(`${line.package ?? ""}:*`);
    for (const arg of line.args) entry.files.add(arg);
    if (line.startedAt < s.firstRunAt) s.firstRunAt = line.startedAt;
    if (line.startedAt > s.lastRunAt) s.lastRunAt = line.startedAt;
  }
  return [...byBranch.values()]
    .map(({ summary, files }) => ({ ...summary, distinctFiles: files.size }))
    .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt));
}

function exitCodeOf(line: TestRunLine): number {
  if (line.exitCode !== null) return line.exitCode;
  const signo = line.signal ? (constants.signals as Record<string, number>)[line.signal] : undefined;
  return signo ? 128 + signo : 1;
}

/**
 * The Stamp document for `branch`'s runs (already filtered) within Stamp's
 * limits, and its exact printed text (compact JSON and a newline); `notes`
 * says what was dropped.
 */
export function stampDocument(
  runs: readonly TestRunLine[],
  { branch, headSha }: { branch: string; headSha: string | null },
): { doc: StampLocalRunDoc; text: string; notes: string[] } {
  const notes: string[] = [];
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const kept = sorted.slice(-STAMP_MAX_RUNS);
  if (kept.length < sorted.length) notes.push(`dropped the ${sorted.length - kept.length} oldest runs (at most ${STAMP_MAX_RUNS})`);
  // Files: newest runs first get theirs, up to STAMP_MAX_FILES in all.
  let budget = STAMP_MAX_FILES;
  let filesDropped = 0;
  const out: StampRun[] = new Array(kept.length);
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const line = kept[i]!;
    const files = line.args.slice(0, Math.max(0, budget));
    budget -= files.length;
    filesDropped += line.args.length - files.length;
    out[i] = {
      started_at: line.startedAt,
      duration_ms: Math.round(line.runMs),
      lock_wait_ms: Math.round(line.lockWaitMs),
      exit_code: exitCodeOf(line),
      head_sha: line.head,
      files,
    };
  }
  if (filesDropped > 0) notes.push(`dropped ${filesDropped} file entries (at most ${STAMP_MAX_FILES} per document)`);
  const doc: StampLocalRunDoc = { version: STAMP_DOC_VERSION, head_sha: headSha, branch, runs: out };
  const print = () => `${JSON.stringify(doc)}\n`;
  let text = print();
  let bytesDropped = 0;
  while (doc.runs.length > 0 && Buffer.byteLength(text) > STAMP_MAX_BYTES) {
    doc.runs.shift();
    bytesDropped += 1;
    text = print();
  }
  if (bytesDropped > 0) notes.push(`dropped the ${bytesDropped} oldest runs more to stay under ${STAMP_MAX_BYTES} bytes`);
  return { doc, text, notes };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The head the Stamp document is filed under (see the header): `explicit`
 * (--head), else HEAD when `branch` is the one checked out, else `branch`'s
 * local tip (`tipOf`), else null with a note.
 */
export function resolveHeadSha(
  branch: string,
  { explicit, current, tipOf }: {
    explicit: string | null;
    current: { branch: string | null; head: string | null };
    tipOf: (branch: string) => string | null;
  },
): { headSha: string | null; note: string | null } {
  if (explicit !== null) return { headSha: explicit, note: null };
  if (current.branch === branch) return { headSha: current.head, note: null };
  const tip = tipOf(branch);
  if (tip !== null) return { headSha: tip, note: `head_sha is the local tip of ${branch} (${tip.slice(0, 12)}); pass --head if you pushed another` };
  return { headSha: null, note: `head_sha is null: ${branch} is not checked out here and has no local branch; pass --head with the pushed head` };
}

function localTip(branch: string): string | null {
  try {
    const out = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const sha = out.status === 0 ? out.stdout.trim() : "";
    return FULL_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function currentGit(): { branch: string | null; head: string | null } {
  try {
    const out = spawnSync("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (out.status !== 0) return { branch: null, head: null };
    const [head, branch] = out.stdout.trim().split("\n");
    return { head: head || null, branch: branch && branch !== "HEAD" ? branch : null };
  } catch {
    return { branch: null, head: null };
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatReport(branches: readonly BranchSummary[]): string {
  if (branches.length === 0) return "No local test runs recorded.\n";
  const header = ["branch", "runs", "failures", "lock wait", "run time", "files", "first run", "last run"];
  const rows = branches.map((b) => [
    b.branch,
    String(b.runs),
    String(b.failures),
    seconds(b.lockWaitMs),
    seconds(b.runMs),
    String(b.distinctFiles),
    b.firstRunAt,
    b.lastRunAt,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  return `${[fmt(header), ...rows.map(fmt)].join("\n")}\n`;
}

function parseArgs(argv: readonly string[]) {
  const opts = {
    branch: null as string | null,
    all: false,
    allUsers: false,
    since: null as string | null,
    json: false,
    dir: null as string | null,
    head: null as string | null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--all-users") opts.allUsers = true;
    else if (arg === "--branch") opts.branch = argv[++i] ?? null;
    else if (arg === "--since") opts.since = argv[++i] ?? null;
    else if (arg === "--dir") opts.dir = argv[++i] ?? null;
    else if (arg === "--head") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--head needs a commit sha");
      opts.head = value.toLowerCase();
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.since !== null && Number.isNaN(Date.parse(opts.since))) throw new Error(`--since is not a date: ${opts.since}`);
  if (opts.all && (opts.json || opts.branch !== null)) throw new Error("--all lists every branch: not with --json or --branch");
  if (opts.head !== null && !opts.json) throw new Error("--head names the Stamp document's head: only with --json");
  if (opts.head !== null && !FULL_SHA.test(opts.head)) throw new Error(`--head is not a full 40-hex commit sha: ${opts.head}`);
  return opts;
}

export function main(argv = process.argv.slice(2)): number {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`test-run-report: ${(error as Error).message}`);
    console.error("usage: test-run-report.ts [--branch NAME | --all] [--since ISO] [--all-users] [--json [--head SHA]] [--dir PATH]");
    return 2;
  }
  const git = currentGit();
  const branch = opts.all ? null : (opts.branch ?? git.branch);
  if (!opts.all && branch === null) {
    console.error("test-run-report: not on a branch; pass --branch NAME (or --all)");
    return 2;
  }
  const { runs: all, invalid, skippedFiles } = readRunLogs(opts.dir ?? runLogDir());
  if (invalid > 0) console.error(`test-run-report: dropped ${invalid} invalid lines`);
  if (skippedFiles > 0) console.error(`test-run-report: skipped ${skippedFiles} log files not owned by the uid they are named for`);
  const uid = opts.allUsers || typeof process.getuid !== "function" ? null : process.getuid();
  const runs = filterRuns(all, { branch, since: opts.since, uid });
  if (opts.json) {
    const head = resolveHeadSha(branch!, { explicit: opts.head, current: git, tipOf: localTip });
    if (head.note !== null) console.error(`test-run-report: ${head.note}`);
    const { text, notes } = stampDocument(runs, { branch: branch!, headSha: head.headSha });
    for (const note of notes) console.error(`test-run-report: ${note}`);
    process.stdout.write(text);
  } else {
    process.stdout.write(formatReport(summarize(runs)));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
