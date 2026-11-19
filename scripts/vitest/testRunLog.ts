// The host's local test-run log: one JSON line per local test run that went
// through the test-slot queue (testSlot.ts), appended when the run ends
// (passed, failed or cancelled), so the time spent waiting for a slot and
// running tests is measured rather than self-reported. Summed per branch by
// test-run-report.ts.
//
// - One file per Unix user in a directory for the whole machine:
//   /var/tmp/raft-tests/runs.<uid>.jsonl (mode 0644). RAFT_TEST_RUN_LOG_DIR
//   moves the directory, RAFT_TEST_NO_RUN_LOG=1 turns the log off. Nothing in
//   CI (as the slot queue).
// - The directory is shared, so the file is opened O_NOFOLLOW and used only if
//   it is a regular file of our own uid with one link; anything else (a
//   symlink, hard link or FIFO planted by another user; opened non-blocking)
//   is skipped, and nothing is ever chmod-ed after opening.
// - Each line is one write(2) on an O_APPEND descriptor, at most 4096 bytes
//   (PIPE_BUF; trailing test args are dropped to fit, else the line is
//   skipped), so lines of concurrent runs never interleave. Over 50 MB the
//   file is renamed to runs.<uid>.<ms>.<pid>.jsonl, and only the newest 3 of
//   those are kept.
// - Recorded: times, exit code, package, the test files/patterns given
//   (repo-relative, no `..`), branch (null when detached) and full HEAD at the
//   start, worktree basename and a hash of its path, USER and SLOCK_AGENT_ID.
//   Strings are capped at 256 characters. No test output, file contents or
//   other environment.
// - Never fails or slows a run: every step is in try/catch, the one git call
//   has a short timeout, and there is no network.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VITEST_VALUE_FLAGS, isDottedValueFlag } from "./vitestArgs";

export const RUN_LOG_SCHEMA_VERSION = 1;
export const MACHINE_RUN_LOG_DIR = "/var/tmp/raft-tests";
export const RUN_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const RUN_LOG_KEEP_ROTATED = 3;
/** PIPE_BUF: an O_APPEND write of at most this many bytes is atomic. */
export const MAX_LINE_BYTES = 4096;
export const MAX_STRING_CHARS = 256;
const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

export type RunVia = "runInTestSlot" | "holdTestSlotForThisRun";

/** One line of runs.<uid>.jsonl (schema v1). */
export interface TestRunLine {
  v: 1;
  via: RunVia;
  startedAt: string;
  endedAt: string;
  /** From the first attempt to take a slot until one was held; 0 when one was free or none was needed. */
  lockWaitMs: number;
  /** From holding the slot until the run exited. */
  runMs: number;
  /** null when the run ended by a signal or its status is unknown. */
  exitCode: number | null;
  signal: string | null;
  /** Whether the run went through the slot queue (false: RAFT_TEST_NO_SLOT=1 or no flock). */
  queued: boolean;
  /** "web", "server", "daemon", ... (packages/<name>), or "root". */
  package: string | null;
  /** Test files or patterns given, relative to the repo root; [] = the package's default set. */
  args: string[];
  argsDropped?: number;
  /** null on a detached HEAD or outside git. */
  branch: string | null;
  /** Full 40-hex HEAD of the worktree when the run started. */
  head: string | null;
  worktree: string | null;
  /** First 12 hex of sha256(absolute worktree path): tells worktrees with the same basename apart. */
  worktreeHash: string | null;
  user: string | null;
  agentId: string | null;
}

export function isCiEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.GITHUB_ACTIONS === "true";
}

export function runLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isCiEnv(env) && env.RAFT_TEST_NO_RUN_LOG !== "1" && typeof process.getuid === "function";
}

export function runLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAFT_TEST_RUN_LOG_DIR || MACHINE_RUN_LOG_DIR;
}

/** This user's live log file. */
export function runLogFile(dir: string, uid: number): string {
  return join(dir, `runs.${uid}.jsonl`);
}

/** runs.<uid>.jsonl (live) or runs.<uid>.<ms>.<pid>.jsonl (rotated). */
export const RUN_LOG_NAME = /^runs\.(\d+)(?:\.(\d+)\.(\d+))?\.jsonl$/;

export interface GitInfo {
  toplevel: string | null;
  branch: string | null;
  head: string | null;
}

/** The worktree, HEAD and branch at `cwd` (one `git rev-parse`, 2 s timeout); nulls on any error. */
export function gitInfo(cwd: string): GitInfo {
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.status !== 0 || typeof out.stdout !== "string") return { toplevel: null, branch: null, head: null };
    const [toplevel, head, branch] = out.stdout.trim().split("\n");
    return {
      toplevel: toplevel || null,
      head: head && /^[0-9a-f]{40}$/.test(head) ? head : null,
      // `--abbrev-ref HEAD` prints "HEAD" when detached.
      branch: branch && branch !== "HEAD" ? branch : null,
    };
  } catch {
    return { toplevel: null, branch: null, head: null };
  }
}

function packageOf(cwd: string, toplevel: string | null): string | null {
  if (!toplevel) return null;
  const rel = relative(toplevel, cwd);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === "packages" && parts[1]) return parts[1];
  return "root";
}

const SUBCOMMANDS = new Set(["run", "related", "bench", "watch", "dev", "list"]);

/**
 * The test files or patterns among a test command's args (given relative to
 * `cwd`, or absolute): no flags, flag values or subcommands; each made
 * relative to the repo root; dropped when outside it or containing `..`.
 */
export function testArgsOf(args: readonly string[], toplevel: string | null, cwd: string = process.cwd()): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (VITEST_VALUE_FLAGS.has(arg) || isDottedValueFlag(arg)) i += 1;
      continue;
    }
    if (out.length === 0 && SUBCOMMANDS.has(arg)) continue;
    if (arg.includes("..") || !toplevel) continue;
    const rel = relative(toplevel, resolve(cwd, arg));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.push(rel.split(sep).join("/"));
  }
  return out;
}

export interface RunLogInput {
  via: RunVia;
  /** ms epoch: the first attempt to take a slot (or the start, unqueued). */
  startedAt: number;
  /** ms epoch: the slot was held (or the run started, unqueued); null if it never was. */
  heldAt: number | null;
  /** ms epoch: the run exited. */
  endedAt: number;
  exitCode: number | null;
  signal?: string | null;
  queued: boolean;
  cwd: string;
  /** The test command's args (sanitised by testArgsOf) unless `files` is given. */
  args?: readonly string[];
  /** Test files/patterns as the runner resolved them (relative to cwd), instead of `args`. */
  files?: readonly string[];
  /** Package name from the runner; else from cwd. */
  package?: string;
  /** gitInfo(cwd) taken when the run started (else taken now). */
  git?: GitInfo;
}

const cap = (value: string | null | undefined): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, MAX_STRING_CHARS) : null;

export function buildRunLine(input: RunLogInput, env: NodeJS.ProcessEnv = process.env): TestRunLine {
  const git = input.git ?? gitInfo(input.cwd);
  const held = input.heldAt ?? input.endedAt;
  const args = testArgsOf(input.files ?? input.args ?? [], git.toplevel, input.cwd).map((arg) => arg.slice(0, MAX_STRING_CHARS));
  const agentId = env.SLOCK_AGENT_ID;
  return {
    v: RUN_LOG_SCHEMA_VERSION,
    via: input.via,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    lockWaitMs: Math.max(0, Math.round(held - input.startedAt)),
    runMs: input.heldAt === null ? 0 : Math.max(0, Math.round(input.endedAt - input.heldAt)),
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
    signal: cap(input.signal),
    queued: input.queued,
    package: cap(input.package ?? packageOf(input.cwd, git.toplevel)),
    args,
    branch: cap(git.branch),
    head: git.head,
    worktree: cap(git.toplevel ? basename(git.toplevel) : null),
    worktreeHash: git.toplevel ? createHash("sha256").update(git.toplevel).digest("hex").slice(0, 12) : null,
    user: cap(env.USER || env.LOGNAME),
    agentId: agentId && AGENT_ID.test(agentId) ? agentId : null,
  };
}

/** The line as one JSON text of at most MAX_LINE_BYTES, dropping trailing args to fit; null if it can't fit. */
export function serializeRunLine(line: TestRunLine): string | null {
  let text = `${JSON.stringify(line)}\n`;
  const args = [...line.args];
  let dropped = line.argsDropped ?? 0;
  while (Buffer.byteLength(text) > MAX_LINE_BYTES) {
    if (args.length === 0) return null;
    args.pop();
    dropped += 1;
    text = `${JSON.stringify({ ...line, args, argsDropped: dropped })}\n`;
  }
  return text;
}

function ensureDir(dir: string, machineWide: boolean, uid: number) {
  mkdirSync(dir, { recursive: true });
  // Every user on the host writes their own file here. The directory may have
  // been made 0755 by the slot queue (mkdir of slots/): opened up by its owner
  // when it is a real directory (never through a symlink), a no-op otherwise.
  if (!machineWide) return;
  try {
    const st = lstatSync(dir);
    if (st.isDirectory() && st.uid === uid && (st.mode & 0o1777) !== 0o1777) chmodSync(dir, 0o1777);
  } catch {
    // Someone else's: it keeps its mode.
  }
}

/** Renames this user's file aside when over maxBytes, keeping the newest RUN_LOG_KEEP_ROTATED. */
function rotate(dir: string, file: string, uid: number, maxBytes: number) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== uid || st.size <= maxBytes) return;
    // A unique name: two runs rotating at once don't overwrite each other.
    renameSync(file, join(dir, `runs.${uid}.${Date.now()}.${process.pid}.jsonl`));
  } catch {
    return;
  }
  try {
    const rotated = readdirSync(dir)
      .map((name) => ({ name, match: RUN_LOG_NAME.exec(name) }))
      .filter(({ match }) => match && match[1] === String(uid) && match[2] !== undefined)
      .sort((a, b) => Number(b.match![2]) - Number(a.match![2]) || Number(b.match![3]) - Number(a.match![3]));
    for (const { name } of rotated.slice(RUN_LOG_KEEP_ROTATED)) {
      try {
        const path = join(dir, name);
        if (lstatSync(path).uid === uid) unlinkSync(path);
      } catch {
        // Pruned by a concurrent run.
      }
    }
  } catch {
    // Pruning is best effort.
  }
}

let warned = false;

/**
 * One stderr line per process when a run could not be recorded, so missing
 * data is visible (a host whose /var/tmp/raft-tests another user owns at 0775
 * otherwise records nothing for everyone else). Never throws.
 */
function warnNotRecorded(dir: string, reason: string): void {
  if (warned) return;
  warned = true;
  try {
    process.stderr.write(`raft test-run log: this run was not recorded (${reason}) in ${dir}; see docs/development/README.md "Test-run time log"\n`);
  } catch {
    // Diagnostic only.
  }
}

/** For this module's tests. */
export function __resetRunLogWarningForTest(): void {
  warned = false;
}

/** Appends one line (single O_APPEND write) to this user's file. Returns false on any error or refusal, with one stderr warning per process. */
export function appendRunLine(
  line: TestRunLine,
  { env = process.env, maxBytes = RUN_LOG_MAX_BYTES }: { env?: NodeJS.ProcessEnv; maxBytes?: number } = {},
): boolean {
  let dir = "";
  try {
    if (!runLogEnabled(env)) return false;
    const text = serializeRunLine(line);
    if (text === null) return false;
    const uid = process.getuid!();
    dir = resolve(runLogDir(env));
    ensureDir(dir, dir === MACHINE_RUN_LOG_DIR, uid);
    const file = runLogFile(dir, uid);
    rotate(dir, file, uid, maxBytes);
    // O_NOFOLLOW: a symlink planted at our name fails to open (ELOOP).
    // O_NONBLOCK: a FIFO planted there fails at once (ENXIO) instead of
    // blocking this exit handler, and the run with its slot, for a reader;
    // one that has a reader fails the regular-file check below.
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fd = openSync(file, flags, 0o644);
    try {
      // Ours, regular and not a hard link to some other file of ours.
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1) {
        warnNotRecorded(dir, "the log file is not a regular file of ours");
        return false;
      }
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    // The log must never fail a test run, but missing data must be visible.
    warnNotRecorded(dir || "(unknown dir)", (error as NodeJS.ErrnoException | null)?.code ?? "error");
    return false;
  }
}

/** Builds and appends the line for a finished run; never throws. */
export function recordTestRun(input: RunLogInput, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!runLogEnabled(env)) return false;
    return appendRunLine(buildRunLine(input, env), { env });
  } catch {
    return false;
  }
}
