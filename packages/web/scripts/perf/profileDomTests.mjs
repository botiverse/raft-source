#!/usr/bin/env node

/**
 * Profile the web jsdom/RTL corpus one file at a time.
 *
 * Each file runs in its own Node test process so a leaked handle or hung file
 * cannot hide every other timing. The profiler is intentionally serial: the
 * output is for attribution, not minimum wall-clock time.
 *
 * Run from the repository root:
 *
 *   node packages/web/scripts/perf/profileDomTests.mjs
 *   node --test packages/web/scripts/perf/profileDomTests.test.mjs
 *
 * A checkpoint is written under artifacts/perf by default. Re-running the
 * same command resumes pending files. A different revision, environment,
 * selection, or runner configuration fails closed; use --restart only when
 * intentionally replacing the checkpoint.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_KIND = "slock-web-jsdom-per-file-profile";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WEB_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const TESTS_ROOT = path.join(WEB_ROOT, "tests");
const DOM_SETUP = path.join(TESTS_ROOT, "helpers/domSetup.ts");
const TEST_TSCONFIG = path.join(TESTS_ROOT, "tsconfig.json");

const DEFAULT_PER_FILE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_BYTES = 32 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

const TERMINAL_FILE_STATUSES = new Set([
  "passed",
  "failed",
  "timed_out",
  "signaled",
  "spawn_error",
]);
const ATTEMPT_STATUSES = new Set([
  ...TERMINAL_FILE_STATUSES,
  "total_timeout",
  "interrupted",
]);

const HELP = `Usage:
  node packages/web/scripts/perf/profileDomTests.mjs [options]

Options:
  --checkpoint <path>            Atomic JSON checkpoint/output path.
                                 Default: artifacts/perf/web-jsdom-<sha>.json
  --file <path>                  Profile one test file; repeat for a subset.
                                 Default: every packages/web/tests/**/*.test.tsx
  --per-file-timeout-ms <ms>     File wall deadline. Default: 60000
  --total-timeout-ms <ms>        Per-invocation wall deadline. Default: 900000
  --kill-grace-ms <ms>           SIGTERM to SIGKILL grace. Default: 2000
  --test-timeout-ms <ms>         Node per-test timeout. Default: 30000
  --max-files <count>            Bound files attempted per invocation. The same
                                 command can be rerun to resume the next batch.
  --restart                      Explicitly replace an existing checkpoint.
  --allow-dirty                  Allow a fresh dirty-tree profile. Dirty
                                 checkpoints are deliberately not resumable.
  --help                         Show this help.

Exit codes:
  0  complete; every file passed
  1  complete; one or more files failed/timed out/signaled/spawn-failed
  2  incomplete; total deadline, max-files limit, or interrupt left work pending
  3  invalid arguments, stale/incompatible checkpoint, or profiler failure
`;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveInteger(value, flag, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    checkpoint: null,
    files: [],
    perFileTimeoutMs: DEFAULT_PER_FILE_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
    maxFiles: null,
    restart: false,
    allowDirty: false,
    help: false,
  };

  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--checkpoint":
        options.checkpoint = valueFor(index, arg);
        index += 1;
        break;
      case "--file":
        options.files.push(valueFor(index, arg));
        index += 1;
        break;
      case "--per-file-timeout-ms":
        options.perFileTimeoutMs = assertPositiveInteger(Number(valueFor(index, arg)), arg);
        index += 1;
        break;
      case "--total-timeout-ms":
        options.totalTimeoutMs = assertPositiveInteger(Number(valueFor(index, arg)), arg);
        index += 1;
        break;
      case "--kill-grace-ms":
        options.killGraceMs = assertPositiveInteger(Number(valueFor(index, arg)), arg, { allowZero: true });
        index += 1;
        break;
      case "--test-timeout-ms":
        options.testTimeoutMs = assertPositiveInteger(Number(valueFor(index, arg)), arg);
        index += 1;
        break;
      case "--max-files":
        options.maxFiles = assertPositiveInteger(Number(valueFor(index, arg)), arg);
        index += 1;
        break;
      case "--restart":
        options.restart = true;
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeRequestedFile(input, callerCwd) {
  const candidates = path.isAbsolute(input)
    ? [input]
    : [path.resolve(callerCwd, input), path.resolve(REPO_ROOT, input), path.resolve(WEB_ROOT, input)];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const absolute = realpathSync(candidate);
    if (!pathInside(TESTS_ROOT, absolute)) {
      throw new Error(`Test file must be under packages/web/tests: ${input}`);
    }
    if (!absolute.endsWith(".test.tsx") || !lstatSync(absolute).isFile()) {
      throw new Error(`DOM profile inputs must be *.test.tsx files: ${input}`);
    }
    return toPosix(path.relative(WEB_ROOT, absolute));
  }

  throw new Error(`Test file does not exist: ${input}`);
}

export async function discoverDomTestFiles(root = TESTS_ROOT) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".test.tsx")) {
        files.push(toPosix(path.relative(WEB_ROOT, absolute)));
      }
    }
  }
  await walk(root);
  files.sort();
  return files;
}

async function resolveSelection(requestedFiles, callerCwd) {
  if (requestedFiles.length === 0) return discoverDomTestFiles();
  const normalized = requestedFiles.map((file) => normalizeRequestedFile(file, callerCwd));
  const unique = [];
  const seen = new Set();
  for (const file of normalized) {
    if (seen.has(file)) throw new Error(`Duplicate --file after normalization: ${file}`);
    seen.add(file);
    unique.push(file);
  }
  return unique;
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export function readSourceState() {
  const commit = runGit(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid git HEAD: ${commit}`);

  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const branchResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const dirty = status.length > 0;
  return {
    commit,
    branch: branchResult.status === 0 ? branchResult.stdout.trim() : null,
    dirty,
    dirtyStatusSha256: dirty ? createHash("sha256").update(status).digest("hex") : null,
    resumeSafe: !dirty,
  };
}

function readEnvironment(effectiveTz, effectiveChildEnvironment) {
  const cpu = os.cpus()[0];
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    execPath: process.execPath,
    cpuModel: cpu?.model ?? null,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    effectiveTZ: effectiveTz,
    effectiveChildEnvironmentSha256: digestEnvironment(effectiveChildEnvironment),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashCompatibility(compatibility) {
  return createHash("sha256").update(canonicalJson(compatibility)).digest("hex");
}

export function digestEnvironment(environment) {
  const entries = Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(`entries:${entries.length}\0`);
  for (const [key, value] of entries) {
    const keyBytes = Buffer.from(key, "utf8");
    const valueBytes = Buffer.from(String(value), "utf8");
    hash.update(`key:${keyBytes.length}\0`);
    hash.update(keyBytes);
    hash.update(`value:${valueBytes.length}\0`);
    hash.update(valueBytes);
  }
  return hash.digest("hex");
}

function buildRunnerConfiguration(options, effectiveTz) {
  const argsTemplate = [
    "--import",
    "tsx",
    "--import",
    pathToFileURL(DOM_SETUP).href,
    "--test",
    "--test-concurrency=1",
    `--test-timeout=${options.testTimeoutMs}`,
    "{file}",
  ];
  return {
    serial: true,
    cwd: WEB_ROOT,
    executable: process.execPath,
    argsTemplate,
    environment: {
      TZ: effectiveTz,
      TSX_TSCONFIG_PATH: TEST_TSCONFIG,
    },
    perFileTimeoutMs: options.perFileTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    killGraceMs: options.killGraceMs,
    testTimeoutMs: options.testTimeoutMs,
    maxFilesPerInvocation: options.maxFiles,
  };
}

export function createCheckpoint({ compatibility, compatibilityHash, createdAt = new Date().toISOString() }) {
  return sealCheckpoint({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: CHECKPOINT_KIND,
    compatibilityHash,
    compatibility,
    sourceRevision: compatibility.source.commit,
    environment: compatibility.environment,
    command: compatibility.runner,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    invocations: [],
    files: compatibility.selection.files.map((file) => ({
      file,
      status: "pending",
      durationMs: null,
      exitCode: null,
      signal: null,
      command: null,
      attempts: [],
    })),
    summary: {
      total: compatibility.selection.files.length,
      pending: compatibility.selection.files.length,
      passed: 0,
      failed: 0,
      timed_out: 0,
      signaled: 0,
      spawn_error: 0,
    },
  });
}

function checkpointIntegrity(checkpoint) {
  const { integritySha256: _integritySha256, ...payload } = checkpoint;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function sealCheckpoint(checkpoint) {
  checkpoint.integritySha256 = checkpointIntegrity(checkpoint);
  return checkpoint;
}

function validateAttempt(attempt, file, index) {
  if (!isPlainObject(attempt) || !ATTEMPT_STATUSES.has(attempt.status)) {
    throw new Error(`Checkpoint has an invalid attempt for ${file}`);
  }
  if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt !== index + 1) {
    throw new Error(`Checkpoint has an invalid attempt ordinal for ${file}`);
  }
  if (typeof attempt.startedAt !== "string" || typeof attempt.finishedAt !== "string") {
    throw new Error(`Checkpoint has invalid attempt timestamps for ${file}`);
  }
  if (!Number.isFinite(attempt.durationMs) || attempt.durationMs < 0) {
    throw new Error(`Checkpoint has an invalid attempt duration for ${file}`);
  }
  if (attempt.exitCode !== null && !Number.isInteger(attempt.exitCode)) {
    throw new Error(`Checkpoint has an invalid attempt exit code for ${file}`);
  }
  if (attempt.signal !== null && typeof attempt.signal !== "string") {
    throw new Error(`Checkpoint has an invalid attempt signal for ${file}`);
  }
  if (attempt.interruptSignal !== null && typeof attempt.interruptSignal !== "string") {
    throw new Error(`Checkpoint has an invalid attempt interrupt signal for ${file}`);
  }
  if (typeof attempt.termSent !== "boolean" || typeof attempt.killSent !== "boolean") {
    throw new Error(`Checkpoint has invalid attempt termination flags for ${file}`);
  }
  if (attempt.spawnError !== null && typeof attempt.spawnError !== "string") {
    throw new Error(`Checkpoint has an invalid attempt spawn error for ${file}`);
  }
  if (typeof attempt.stdoutTail !== "string" || typeof attempt.stderrTail !== "string") {
    throw new Error(`Checkpoint has invalid attempt output tails for ${file}`);
  }
  if (
    !Array.isArray(attempt.command) ||
    attempt.command.length === 0 ||
    attempt.command.some((part) => typeof part !== "string")
  ) {
    throw new Error(`Checkpoint has an invalid attempt command for ${file}`);
  }
  if (typeof attempt.cwd !== "string") {
    throw new Error(`Checkpoint has an invalid attempt cwd for ${file}`);
  }
  if (
    (attempt.status === "passed" &&
      (attempt.exitCode !== 0 || attempt.signal !== null || attempt.spawnError !== null)) ||
    (attempt.status === "failed" &&
      (!Number.isInteger(attempt.exitCode) ||
        attempt.exitCode === 0 ||
        attempt.signal !== null ||
        attempt.spawnError !== null)) ||
    (attempt.status === "signaled" &&
      (typeof attempt.signal !== "string" || attempt.signal.length === 0 || attempt.spawnError !== null)) ||
    (attempt.status === "spawn_error" &&
      (typeof attempt.spawnError !== "string" || attempt.spawnError.length === 0))
  ) {
    throw new Error(`Checkpoint has an impossible attempt outcome for ${file}`);
  }
}

export function validateCheckpointShape(checkpoint) {
  if (!isPlainObject(checkpoint)) throw new Error("Checkpoint root must be an object");
  if (!/^[0-9a-f]{64}$/.test(checkpoint.integritySha256 ?? "")) {
    throw new Error("Checkpoint is missing its full-ledger integrity seal");
  }
  if (checkpointIntegrity(checkpoint) !== checkpoint.integritySha256) {
    throw new Error("Checkpoint full-ledger integrity seal disagrees; refusing to resume");
  }
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || checkpoint.kind !== CHECKPOINT_KIND) {
    throw new Error(
      `Incompatible checkpoint schema/kind (expected ${CHECKPOINT_KIND} v${CHECKPOINT_SCHEMA_VERSION})`,
    );
  }
  if (!isPlainObject(checkpoint.compatibility) || typeof checkpoint.compatibilityHash !== "string") {
    throw new Error("Checkpoint is missing compatibility metadata");
  }
  const storedHash = hashCompatibility(checkpoint.compatibility);
  if (storedHash !== checkpoint.compatibilityHash) {
    throw new Error("Checkpoint compatibility metadata/hash disagree; refusing to resume");
  }
  const selectedFiles = checkpoint.compatibility.selection?.files;
  if (!Array.isArray(selectedFiles) || !Array.isArray(checkpoint.files)) {
    throw new Error("Checkpoint is missing its selected file inventory");
  }
  if (checkpoint.files.length !== selectedFiles.length) {
    throw new Error("Checkpoint file inventory length differs from its selection");
  }
  const seen = new Set();
  checkpoint.files.forEach((record, index) => {
    const expectedFile = selectedFiles[index];
    if (!isPlainObject(record) || record.file !== expectedFile || seen.has(record.file)) {
      throw new Error(`Checkpoint file inventory is reordered, duplicated, or invalid at index ${index}`);
    }
    seen.add(record.file);
    if (record.status !== "pending" && !TERMINAL_FILE_STATUSES.has(record.status)) {
      throw new Error(`Checkpoint has invalid file status for ${record.file}`);
    }
    if (!Array.isArray(record.attempts)) {
      throw new Error(`Checkpoint has no attempt ledger for ${record.file}`);
    }
    record.attempts.forEach((attempt, attemptIndex) => validateAttempt(attempt, record.file, attemptIndex));
    const lastAttempt = record.attempts.at(-1);
    if (TERMINAL_FILE_STATUSES.has(record.status)) {
      if (!lastAttempt || lastAttempt.status !== record.status) {
        throw new Error(`Checkpoint terminal status/attempt disagree for ${record.file}`);
      }
      if (
        record.durationMs !== lastAttempt.durationMs ||
        record.exitCode !== lastAttempt.exitCode ||
        record.signal !== lastAttempt.signal ||
        canonicalJson(record.command) !== canonicalJson(lastAttempt.command)
      ) {
        throw new Error(`Checkpoint terminal summary/attempt disagree for ${record.file}`);
      }
    } else if (lastAttempt && TERMINAL_FILE_STATUSES.has(lastAttempt.status)) {
      throw new Error(`Checkpoint leaves a terminal attempt pending for ${record.file}`);
    }
  });
  if (!Array.isArray(checkpoint.invocations)) throw new Error("Checkpoint invocation ledger must be an array");
  if (checkpoint.sourceRevision !== checkpoint.compatibility.source.commit) {
    throw new Error("Checkpoint source revision disagrees with compatibility metadata");
  }
  if (canonicalJson(checkpoint.environment) !== canonicalJson(checkpoint.compatibility.environment)) {
    throw new Error("Checkpoint environment disagrees with compatibility metadata");
  }
  if (canonicalJson(checkpoint.command) !== canonicalJson(checkpoint.compatibility.runner)) {
    throw new Error("Checkpoint command disagrees with compatibility metadata");
  }

  const expectedSummary = {
    total: checkpoint.files.length,
    pending: 0,
    passed: 0,
    failed: 0,
    timed_out: 0,
    signaled: 0,
    spawn_error: 0,
  };
  for (const record of checkpoint.files) expectedSummary[record.status] += 1;
  if (canonicalJson(checkpoint.summary) !== canonicalJson(expectedSummary)) {
    throw new Error("Checkpoint summary disagrees with its file ledger");
  }
  if ((expectedSummary.pending === 0) !== (typeof checkpoint.completedAt === "string")) {
    throw new Error("Checkpoint completion marker disagrees with its pending file count");
  }
  return checkpoint;
}

export function readCheckpoint(checkpointPath) {
  const info = lstatSync(checkpointPath);
  if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) {
    throw new Error(`Checkpoint must be a regular JSON file <= ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(`Checkpoint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCheckpointShape(parsed);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!error || !["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Write JSON through an exclusive same-directory temporary file, fsync it,
 * rename over the old checkpoint, then fsync the directory. `beforeRename`
 * exists only so the contract test can prove a failed write leaves the old
 * checkpoint intact.
 */
export function atomicWriteJson(filePath, value, { beforeRename } = {}) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeRename?.(temporary);
    renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!cleanupError || cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function writeCheckpoint(checkpointPath, checkpoint) {
  sealCheckpoint(checkpoint);
  validateCheckpointShape(checkpoint);
  atomicWriteJson(checkpointPath, checkpoint);
}

export function loadOrCreateCheckpoint({ checkpointPath, compatibility, restart = false }) {
  const compatibilityHash = hashCompatibility(compatibility);
  if (!existsSync(checkpointPath) || restart) {
    const checkpoint = createCheckpoint({ compatibility, compatibilityHash });
    writeCheckpoint(checkpointPath, checkpoint);
    return { checkpoint, resumed: false };
  }

  const checkpoint = readCheckpoint(checkpointPath);
  if (checkpoint.compatibilityHash !== compatibilityHash) {
    throw new Error(
      "Checkpoint is stale or incompatible with this revision/environment/selection/command; " +
        "refusing to resume (choose another --checkpoint or pass --restart explicitly)",
    );
  }
  if (!checkpoint.compatibility.source.resumeSafe) {
    throw new Error("Dirty-source checkpoints are not resumable; pass --restart for an explicit fresh run");
  }
  return { checkpoint, resumed: true };
}

function appendTail(previous, chunk, maximumBytes) {
  const next = Buffer.concat([previous, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length <= maximumBytes ? next : next.subarray(next.length - maximumBytes);
}

function processGroupExists(processGroupId) {
  if (process.platform === "win32" || !processGroupId) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code === "EPERM") return true;
    throw error;
  }
}

function sendSignal(child, processGroupId, signal) {
  try {
    if (process.platform !== "win32" && processGroupId) {
      process.kill(-processGroupId, signal);
      return true;
    } else {
      return child.kill(signal);
    }
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}

export function runCommandWithDeadline({
  executable,
  args,
  cwd,
  env,
  timeoutMs,
  deadlineKind,
  killGraceMs,
  abortSignal,
  outputTailBytes = OUTPUT_TAIL_BYTES,
}) {
  if (!["per_file", "total"].includes(deadlineKind)) {
    throw new Error(`Invalid deadline kind: ${deadlineKind}`);
  }
  assertPositiveInteger(timeoutMs, "timeoutMs");
  assertPositiveInteger(killGraceMs, "killGraceMs", { allowZero: true });

  return new Promise((resolvePromise) => {
    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let terminationReason = null;
    let interruptSignal = null;
    let termSent = false;
    let killSent = false;
    let settled = false;
    let killTimer = null;
    let leaderResult = null;

    const child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const processGroupId = process.platform === "win32" ? null : child.pid;

    child.stdout?.on("data", (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk, outputTailBytes);
    });
    child.stderr?.on("data", (chunk) => {
      stderrTail = appendTail(stderrTail, chunk, outputTailBytes);
    });

    const finish = ({ exitCode, signal, spawnError = null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
      let status;
      if (terminationReason === "per_file") status = "timed_out";
      else if (terminationReason === "total") status = "total_timeout";
      else if (terminationReason === "interrupted") status = "interrupted";
      else if (spawnError) status = "spawn_error";
      else if (signal) status = "signaled";
      else status = exitCode === 0 ? "passed" : "failed";
      resolvePromise({
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(durationMs * 1000) / 1000,
        exitCode,
        signal,
        interruptSignal,
        termSent,
        killSent,
        spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
        stdoutTail: stdoutTail.toString("utf8"),
        stderrTail: stderrTail.toString("utf8"),
        command: [executable, ...args],
        cwd,
      });
    };

    const requestTermination = (reason, signalName = null) => {
      if (terminationReason !== null) return;
      terminationReason = reason;
      interruptSignal = signalName === null ? null : String(signalName);
      termSent = sendSignal(child, processGroupId, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        if (settled) return;
        killSent = sendSignal(child, processGroupId, "SIGKILL");
        if (leaderResult !== null) finish(leaderResult);
      }, killGraceMs);
    };

    const deadlineTimer = setTimeout(() => requestTermination(deadlineKind), timeoutMs);
    deadlineTimer.unref?.();
    const onAbort = () => requestTermination("interrupted", abortSignal?.reason ?? null);
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.once("error", (error) => finish({ exitCode: null, signal: null, spawnError: error }));
    child.once("close", (exitCode, signal) => {
      leaderResult = { exitCode, signal };
      if (
        terminationReason === null ||
        process.platform === "win32" ||
        killSent ||
        !processGroupExists(processGroupId)
      ) {
        finish(leaderResult);
      }
    });
  });
}

export function updateSummary(checkpoint) {
  const summary = {
    total: checkpoint.files.length,
    pending: 0,
    passed: 0,
    failed: 0,
    timed_out: 0,
    signaled: 0,
    spawn_error: 0,
  };
  for (const file of checkpoint.files) summary[file.status] += 1;
  checkpoint.summary = summary;
  checkpoint.completedAt = summary.pending === 0 ? new Date().toISOString() : null;
  return summary;
}

function copyTerminalOutcome(record, attempt) {
  record.status = attempt.status;
  record.durationMs = attempt.durationMs;
  record.exitCode = attempt.exitCode;
  record.signal = attempt.signal;
  record.command = attempt.command;
}

export async function runProfileInvocation({
  checkpoint,
  checkpointPath,
  runFile,
  totalTimeoutMs,
  perFileTimeoutMs,
  maxFiles,
  abortController,
  argv = process.argv,
  callerCwd = process.cwd(),
}) {
  const startedNs = process.hrtime.bigint();
  const invocation = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    stopReason: null,
    command: [...argv],
    cwd: callerCwd,
    totalTimeoutMs,
    maxFiles,
    processedFiles: [],
    hostLoadAverageAtStart: os.loadavg(),
    freeMemoryBytesAtStart: os.freemem(),
  };
  for (const previous of checkpoint.invocations) {
    if (previous.status === "running") {
      previous.status = "abandoned";
      previous.stopReason = "resumed_after_unclosed_invocation";
      previous.recoveredAt = invocation.startedAt;
    }
  }
  checkpoint.invocations.push(invocation);
  checkpoint.updatedAt = invocation.startedAt;
  writeCheckpoint(checkpointPath, checkpoint);

  let processed = 0;
  let stopReason = null;
  for (const record of checkpoint.files) {
    if (record.status !== "pending") continue;
    if (maxFiles !== null && processed >= maxFiles) {
      stopReason = "max_files";
      break;
    }
    if (abortController.signal.aborted) {
      stopReason = "interrupted";
      break;
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    const remainingTotalMs = totalTimeoutMs - elapsedMs;
    if (remainingTotalMs <= 0) {
      stopReason = "total_deadline";
      break;
    }
    const deadlineKind = remainingTotalMs < perFileTimeoutMs ? "total" : "per_file";
    const timeoutMs = Math.max(1, Math.floor(Math.min(remainingTotalMs, perFileTimeoutMs)));

    const outcome = await runFile(record.file, {
      timeoutMs,
      deadlineKind,
      abortSignal: abortController.signal,
    });
    const attempt = {
      attempt: record.attempts.length + 1,
      ...outcome,
    };
    validateAttempt(attempt, record.file, record.attempts.length);
    record.attempts.push(attempt);
    if (TERMINAL_FILE_STATUSES.has(attempt.status)) copyTerminalOutcome(record, attempt);
    invocation.processedFiles.push({ file: record.file, attempt: attempt.attempt, status: attempt.status });
    processed += 1;

    if (attempt.status === "total_timeout") stopReason = "total_deadline";
    if (attempt.status === "interrupted") stopReason = "interrupted";
    checkpoint.updatedAt = new Date().toISOString();
    updateSummary(checkpoint);
    writeCheckpoint(checkpointPath, checkpoint);
    if (stopReason) break;
  }

  const summary = updateSummary(checkpoint);
  if (!stopReason) {
    if (summary.pending === 0) stopReason = "complete";
    else if (maxFiles !== null && processed >= maxFiles) stopReason = "max_files";
    else stopReason = "pending";
  }
  invocation.finishedAt = new Date().toISOString();
  invocation.status = stopReason === "complete" ? "complete" : "incomplete";
  invocation.stopReason = stopReason;
  invocation.hostLoadAverageAtEnd = os.loadavg();
  invocation.freeMemoryBytesAtEnd = os.freemem();
  checkpoint.updatedAt = invocation.finishedAt;
  writeCheckpoint(checkpointPath, checkpoint);

  return { checkpoint, summary, stopReason, processed };
}

function exitCodeFor(summary) {
  if (summary.pending > 0) return 2;
  return summary.failed + summary.timed_out + summary.signaled + summary.spawn_error > 0 ? 1 : 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(HELP);
    process.exitCode = 3;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  const callerCwd = process.cwd();
  const source = readSourceState();
  if (source.dirty && !options.allowDirty) {
    throw new Error("Refusing to profile a dirty worktree; commit/stash it or pass --allow-dirty for a non-resumable run");
  }
  const effectiveTz = process.env.TZ || "Asia/Singapore";
  const files = await resolveSelection(options.files, callerCwd);
  if (files.length === 0) throw new Error("No web *.test.tsx files were selected");

  const runner = buildRunnerConfiguration(options, effectiveTz);
  const effectiveChildEnvironment = {
    ...process.env,
    ...runner.environment,
  };
  const environment = readEnvironment(effectiveTz, effectiveChildEnvironment);
  const compatibility = {
    source,
    environment,
    selection: {
      root: toPosix(path.relative(REPO_ROOT, TESTS_ROOT)),
      pattern: "**/*.test.tsx",
      files,
      count: files.length,
    },
    runner,
  };
  const checkpointPath = options.checkpoint
    ? path.resolve(callerCwd, options.checkpoint)
    : path.join(REPO_ROOT, `artifacts/perf/web-jsdom-${source.commit.slice(0, 12)}.json`);
  const { checkpoint, resumed } = loadOrCreateCheckpoint({
    checkpointPath,
    compatibility,
    restart: options.restart,
  });

  const abortController = new AbortController();
  const onSigint = () => abortController.abort("SIGINT");
  const onSigterm = () => abortController.abort("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  console.error(
    `${resumed ? "Resuming" : "Starting"} ${files.length}-file serial jsdom profile at ${source.commit.slice(0, 12)}.`,
  );
  console.error(`Checkpoint: ${checkpointPath}`);

  const runFile = async (file, deadline) => {
    const args = runner.argsTemplate.map((arg) => (arg === "{file}" ? file : arg));
    console.error(`\n[${file}] deadline=${deadline.timeoutMs}ms (${deadline.deadlineKind})`);
    const outcome = await runCommandWithDeadline({
      executable: runner.executable,
      args,
      cwd: runner.cwd,
      env: effectiveChildEnvironment,
      timeoutMs: deadline.timeoutMs,
      deadlineKind: deadline.deadlineKind,
      killGraceMs: runner.killGraceMs,
      abortSignal: deadline.abortSignal,
    });
    console.error(
      `[${file}] ${outcome.status} ${outcome.durationMs.toFixed(1)}ms` +
        ` exit=${outcome.exitCode ?? "null"} signal=${outcome.signal ?? "null"}`,
    );
    if (outcome.status !== "passed") {
      if (outcome.stdoutTail) console.error(`--- stdout tail ---\n${outcome.stdoutTail}`);
      if (outcome.stderrTail) console.error(`--- stderr tail ---\n${outcome.stderrTail}`);
    }
    return outcome;
  };

  try {
    const result = await runProfileInvocation({
      checkpoint,
      checkpointPath,
      runFile,
      totalTimeoutMs: runner.totalTimeoutMs,
      perFileTimeoutMs: runner.perFileTimeoutMs,
      maxFiles: runner.maxFilesPerInvocation,
      abortController,
      argv: [process.execPath, ...process.argv.slice(1)],
      callerCwd,
    });
    console.error(`\nStop reason: ${result.stopReason}`);
    console.error(`Summary: ${JSON.stringify(result.summary)}`);
    process.exitCode = exitCodeFor(result.summary);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((error) => {
    console.error(`Profiler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 3;
  });
}
