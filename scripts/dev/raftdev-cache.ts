// Where local dev caches and test temp files go (#triage:#155).
//
// On some hosts /tmp is tmpfs (RAM): the Node compile cache and the temp files
// of local Vitest / Playwright runs piled up there and added to memory
// pressure. The tool entry points use this module to put them on disk instead:
//
// - Shared, regenerable caches per Unix user, never per agent workspace:
//   `${XDG_CACHE_HOME:-$HOME/.cache}/raft-dev/node-compile-cache` is
//   NODE_COMPILE_CACHE. Playwright browsers stay at Playwright's own default
//   (`${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright`, which install and run
//   both use) and the pnpm store stays wherever pnpm resolves it; both are only
//   checked and reported (`./raftdev cache status`), never moved.
// - Per run temp: `<root>/j/<agent-key>/<run-id>/tmp` is TMPDIR for the test
//   run and everything under it (agent-key: 8 hex of sha256(agent id); run-id:
//   6 base36 chars). Kept short because tests and browsers put AF_UNIX sockets
//   (108-byte path limit) under TMPDIR. The run removes its directory when it
//   ends; a leftover of a crashed run is removed only once its owner.json says
//   it is older than 24h and its process is gone.
// - A candidate on tmpfs/ramfs (checked with statfs on the real path, or on its
//   nearest existing parent) is skipped for the next one ($HOME/.cache). With
//   none on disk nothing is moved and a warning says the caches stay in RAM.
// - Explicit configuration wins: TMPDIR, NODE_COMPILE_CACHE,
//   PLAYWRIGHT_BROWSERS_PATH already set, RAFT_DEV_CACHE_DIR for the root.
//   RAFT_DEV_CACHE=0 turns this off. CI (CI=true/1, GITHUB_ACTIONS=true) and
//   non-Linux hosts are left exactly as before.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCi } from "../vitest/localRunLimits";
import { isRecordedProcessAlive, liveStarttime, parsePreviewState, readProcStat, type PreviewProcess } from "./raftdev-preview";

export const TMPFS_MAGIC = 0x01021994;
export const RAMFS_MAGIC = 0x858458f6;
export const STALE_RUN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Longest per-run TMPDIR used: leaves 40 of AF_UNIX's 108 bytes for what a
 * test or browser creates under it (e.g. `raft-nginx-XXXXXX/http.sock`).
 */
export const MAX_RUN_TMPDIR_BYTES = 68;
export const JOBS_DIR = "j";
const AGENT_KEY_RE = /^[0-9a-f]{8}$/;
const RUN_ID_RE = /^[0-9a-z]{6}$/;
/** Env marking a run dir created by a parent launcher; nested launchers reuse it. */
export const RUN_DIR_ENV = "RAFT_DEV_RUN_DIR";
const WARN_PREFIX = "raft-dev-cache:";

export interface StatFs {
  /** fs.realpathSync: throws when the path does not exist. */
  realpath(p: string): string;
  /** statfs(2) f_type of an existing path. */
  statfsType(p: string): number;
}

export const realStatFs: StatFs = {
  realpath: (p) => fs.realpathSync(p),
  statfsType: (p) => fs.statfsSync(p).type,
};

export type Medium = "disk" | "ram" | "unknown";

/**
 * Whether `target` lives in RAM. Follows symlinks; a path that doesn't exist
 * yet is judged by its nearest existing parent (where it would be created).
 */
export function storageMedium(target: string, sfs: StatFs = realStatFs): { medium: Medium; checked: string | null } {
  let current = path.resolve(target);
  for (;;) {
    let real: string | null = null;
    try {
      real = sfs.realpath(current);
    } catch {
      // Missing (or a dangling symlink): try the parent.
    }
    if (real !== null) {
      try {
        const type = sfs.statfsType(real);
        return { medium: type === TMPFS_MAGIC || type === RAMFS_MAGIC ? "ram" : "disk", checked: real };
      } catch {
        return { medium: "unknown", checked: real };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { medium: "unknown", checked: null };
    current = parent;
  }
}

export interface ResolveInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  username?: string;
  statfs?: StatFs;
}

export interface DevCachePaths {
  /** False in CI, on non-Linux hosts, with RAFT_DEV_CACHE=0, or when no on-disk root exists. */
  active: boolean;
  /** Why nothing is applied (when !active). */
  inactiveReason: string | null;
  /** `<root>`: raft-dev cache root on disk, or null. */
  root: string | null;
  agentId: string;
  /** Short path segment for the agent: 8 hex of sha256(agentId). */
  agentKey: string;
  /** Value to give NODE_COMPILE_CACHE, and where it came from. */
  nodeCompileCache: { path: string | null; source: "env" | "raft-dev" | "none" };
  /** Whether a run should create its own TMPDIR ("raft-dev"), keep the caller's ("env"), or reuse the parent run's ("parent-run"). */
  tmp: { source: "raft-dev" | "env" | "parent-run" | "none"; path: string | null };
  /** Playwright browsers: never redirected, only checked. */
  playwrightBrowsers: { path: string; source: "env" | "default" };
  warnings: string[];
}

/** Raft agent id (the daemon sets SLOCK_AGENT_ID), else the user name. */
export function agentIdFor(env: NodeJS.ProcessEnv, username: string): string {
  return env.RAFT_AGENT_ID || env.SLOCK_AGENT_ID || username || "user";
}

/** The agent's path segment: short (socket paths), stable, path-safe. */
export function agentKeyFor(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 8);
}

function userCacheBases(env: NodeJS.ProcessEnv, home: string): string[] {
  const xdg = env.XDG_CACHE_HOME;
  const bases = xdg && path.isAbsolute(xdg) ? [xdg, path.join(home, ".cache")] : [path.join(home, ".cache")];
  return [...new Set(bases.map((b) => path.resolve(b)))];
}

function ramWarning(what: string, where: string, fix: string): string {
  return `${WARN_PREFIX} ${what} ${where} is on tmpfs; it stays in RAM. ${fix}`;
}

/** Pure path resolution: reads only env and statfs, writes nothing. */
export function resolveDevCachePaths(input: ResolveInput = {}): DevCachePaths {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.homedir ?? os.homedir();
  const username = input.username ?? safeUsername(env);
  const sfs = input.statfs ?? realStatFs;
  const agentId = agentIdFor(env, username);
  const agentKey = agentKeyFor(agentId);
  const warnings: string[] = [];

  const bases = userCacheBases(env, home);
  const browsersFromEnv = env.PLAYWRIGHT_BROWSERS_PATH;
  const playwrightBrowsers = browsersFromEnv
    ? { path: browsersFromEnv, source: "env" as const }
    : { path: path.join(bases[0], "ms-playwright"), source: "default" as const };

  const inactive = (reason: string): DevCachePaths => ({
    active: false,
    inactiveReason: reason,
    root: null,
    agentId,
    agentKey,
    nodeCompileCache: { path: env.NODE_COMPILE_CACHE || null, source: env.NODE_COMPILE_CACHE ? "env" : "none" },
    tmp: { source: env.TMPDIR ? "env" : "none", path: env.TMPDIR || null },
    playwrightBrowsers,
    warnings,
  });

  if (isCi(env)) return inactive("CI: paths unchanged");
  if (platform !== "linux") return inactive(`${platform}: paths unchanged (Linux only)`);
  if (env.RAFT_DEV_CACHE === "0") return inactive("RAFT_DEV_CACHE=0");

  // Playwright's browsers: checked, never moved (install and run must agree).
  if (storageMedium(playwrightBrowsers.path, sfs).medium === "ram") {
    warnings.push(ramWarning("Playwright browsers path", playwrightBrowsers.path,
      "Set PLAYWRIGHT_BROWSERS_PATH to an on-disk directory for both `playwright install` and the test run."));
  }

  // The root: explicit RAFT_DEV_CACHE_DIR wins (even on tmpfs, with a warning);
  // else the first candidate verified to be on disk.
  let root: string | null = null;
  const explicitRoot = env.RAFT_DEV_CACHE_DIR;
  if (explicitRoot) {
    root = path.resolve(explicitRoot);
    if (storageMedium(root, sfs).medium === "ram") {
      warnings.push(ramWarning("RAFT_DEV_CACHE_DIR", root, "It is used as set."));
    }
  } else {
    const candidates = bases.map((b) => path.join(b, "raft-dev"));
    root = candidates.find((c) => storageMedium(c, sfs).medium === "disk") ?? null;
    if (root === null) {
      warnings.push(`${WARN_PREFIX} WARNING: no on-disk location verified for dev caches and test temp files `
        + `(${candidates.join(", ")} on tmpfs or unknown); NOT migrated, they stay where they were (in RAM if /tmp is tmpfs). `
        + `Set RAFT_DEV_CACHE_DIR to an on-disk directory.`);
      return inactive("no on-disk cache root");
    }
  }

  let nodeCompileCache: DevCachePaths["nodeCompileCache"];
  if (env.NODE_COMPILE_CACHE) {
    nodeCompileCache = { path: env.NODE_COMPILE_CACHE, source: "env" };
    if (storageMedium(env.NODE_COMPILE_CACHE, sfs).medium === "ram") {
      warnings.push(ramWarning("NODE_COMPILE_CACHE", env.NODE_COMPILE_CACHE, `Unset it to use ${path.join(root, "node-compile-cache")}.`));
    }
  } else {
    nodeCompileCache = { path: path.join(root, "node-compile-cache"), source: "raft-dev" };
  }

  let tmp: DevCachePaths["tmp"];
  const parentRun = env[RUN_DIR_ENV];
  if (parentRun && env.TMPDIR === path.join(parentRun, "tmp")) {
    tmp = { source: "parent-run", path: env.TMPDIR };
  } else if (env.TMPDIR) {
    tmp = { source: "env", path: env.TMPDIR };
    if (storageMedium(env.TMPDIR, sfs).medium === "ram") {
      warnings.push(ramWarning("TMPDIR", env.TMPDIR, `Unset it to use ${path.join(root, JOBS_DIR)}.`));
    }
  } else {
    tmp = { source: "raft-dev", path: null };
  }

  return { active: true, inactiveReason: null, root, agentId, agentKey, nodeCompileCache, tmp, playwrightBrowsers, warnings };
}

function safeUsername(env: NodeJS.ProcessEnv): string {
  try {
    return os.userInfo().username;
  } catch {
    return env.USER || env.LOGNAME || "user";
  }
}

// ───────────────── per-run directories ─────────────────

export interface RunOwner {
  pid: number;
  hostname: string;
  bootId: string | null;
  startedAt: number;
}

export function currentBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type EntryKind = "dir" | "file" | "symlink" | "other";

export interface SweepFs {
  readdir(dir: string): string[];
  /** lstat kind (symlinks are not followed), null when missing. */
  kind(p: string): EntryKind | null;
  /** owner.json of a run dir (a regular file only), null when missing or invalid. */
  readOwner(runDir: string): RunOwner | null;
  remove(runDir: string): void;
}

function lstatKind(p: string): EntryKind | null {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

export const realSweepFs: SweepFs = {
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  kind: lstatKind,
  readOwner: (runDir) => {
    const file = path.join(runDir, "owner.json");
    if (lstatKind(file) !== "file") return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunOwner>;
      if (typeof raw.pid !== "number" || typeof raw.hostname !== "string" || typeof raw.startedAt !== "number") return null;
      return { pid: raw.pid, hostname: raw.hostname, bootId: typeof raw.bootId === "string" ? raw.bootId : null, startedAt: raw.startedAt };
    } catch {
      return null;
    }
  },
  remove: (runDir) => fs.rmSync(runDir, { recursive: true, force: true }),
};

export interface SweepContext {
  now: number;
  hostname: string;
  bootId: string | null;
  isPidAlive: (pid: number) => boolean;
  maxAgeMs?: number;
}

/**
 * Whether a run dir left behind may be removed: its owner.json says it started
 * more than 24h ago AND no live process holds it (pid gone, or recorded in an
 * earlier boot). Without an owner record, or recorded on another host (a
 * shared home), it is never removed.
 */
export function isStaleRun(owner: RunOwner | null, ctx: SweepContext): boolean {
  if (!owner) return false;
  if (ctx.now - owner.startedAt < (ctx.maxAgeMs ?? STALE_RUN_AGE_MS)) return false;
  if (owner.hostname !== ctx.hostname) return false;
  if (owner.bootId && ctx.bootId && owner.bootId !== ctx.bootId) return true;
  return !ctx.isPidAlive(owner.pid);
}

/**
 * Removes stale run dirs under `<jobs>/<agent-key>/` (one agent, or all with
 * agentKey=null). Only real directories (never a symlink, which would point
 * elsewhere) named like this module's agent keys and run ids are considered.
 * Returns the removed paths.
 */
export function sweepStaleRuns(jobsDir: string, agentKey: string | null, ctx: SweepContext, sfs: SweepFs = realSweepFs): string[] {
  const removed: string[] = [];
  if (sfs.kind(jobsDir) !== "dir") return removed;
  const agents = agentKey === null ? sfs.readdir(jobsDir) : [agentKey];
  for (const a of agents) {
    const agentDir = path.join(jobsDir, a);
    if (!AGENT_KEY_RE.test(a) || sfs.kind(agentDir) !== "dir") continue;
    for (const run of sfs.readdir(agentDir)) {
      const runDir = path.join(agentDir, run);
      if (!RUN_ID_RE.test(run) || sfs.kind(runDir) !== "dir") continue;
      if (!isStaleRun(sfs.readOwner(runDir), ctx)) continue;
      try {
        sfs.remove(runDir);
        removed.push(runDir);
      } catch {
        // Someone else removed it, or it isn't ours: leave it.
      }
    }
  }
  return removed;
}

export interface DevRun {
  /** Env to add for the run's processes (empty when nothing applies). */
  env: Record<string, string>;
  /** The run directory this launcher owns, or null. */
  runDir: string | null;
  paths: DevCachePaths;
  /** Removes the run directory (idempotent). */
  cleanup(): void;
}

function newRunId(): string {
  return (randomBytes(4).readUInt32BE() % 36 ** 6).toString(36).padStart(6, "0");
}

/**
 * Starts a run: resolves paths, creates `<root>/j/<agent-key>/<run-id>/tmp`
 * with an owner.json, sweeps this agent's stale runs, and returns the env to
 * give the run's processes. Never throws: on any error the run goes ahead with
 * the env it had (and a warning).
 */
export function startDevRun(
  input: ResolveInput & { pid?: number; now?: number; warn?: (msg: string) => void; maxTmpdirBytes?: number } = {},
): DevRun {
  const warn = input.warn ?? ((msg: string) => console.error(msg));
  const paths = resolveDevCachePaths(input);
  // Under a parent run the parent already printed them.
  if (paths.tmp.source !== "parent-run") for (const w of paths.warnings) warn(w);
  const noop: DevRun = { env: {}, runDir: null, paths, cleanup: () => {} };
  if (!paths.active || paths.root === null) return noop;

  const env: Record<string, string> = {};
  if (paths.nodeCompileCache.source === "raft-dev" && paths.nodeCompileCache.path) {
    env.NODE_COMPILE_CACHE = paths.nodeCompileCache.path;
  }
  if (paths.tmp.source !== "raft-dev") return { ...noop, env };

  const pid = input.pid ?? process.pid;
  const now = input.now ?? Date.now();
  const jobsDir = path.join(paths.root, JOBS_DIR);
  const hostname = os.hostname();
  const bootId = currentBootId();
  // Checked before anything is written: sockets under a longer TMPDIR would
  // exceed AF_UNIX's 108 bytes, so such a host keeps its TMPDIR.
  const sampleTmp = path.join(jobsDir, paths.agentKey, "x".repeat(6), "tmp");
  const maxBytes = input.maxTmpdirBytes ?? MAX_RUN_TMPDIR_BYTES;
  if (Buffer.byteLength(sampleTmp) > maxBytes) {
    warn(`${WARN_PREFIX} the run TMPDIR (${sampleTmp}) would be ${Buffer.byteLength(sampleTmp)} bytes, over ${maxBytes} `
      + "(AF_UNIX socket paths under it could exceed 108 bytes); TMPDIR unchanged. Set RAFT_DEV_CACHE_DIR to a shorter on-disk path.");
    return { ...noop, env };
  }
  try {
    fs.mkdirSync(path.join(jobsDir, paths.agentKey), { recursive: true, mode: 0o700 });
    sweepStaleRuns(jobsDir, paths.agentKey, { now, hostname, bootId, isPidAlive });
    let runDir = "";
    for (let attempt = 0; ; attempt++) {
      runDir = path.join(jobsDir, paths.agentKey, newRunId());
      try {
        fs.mkdirSync(runDir, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) throw error;
      }
    }
    fs.mkdirSync(path.join(runDir, "tmp"), { mode: 0o700 });
    const owner: RunOwner = { pid, hostname, bootId, startedAt: now };
    fs.writeFileSync(path.join(runDir, "owner.json"), JSON.stringify(owner));
    env.TMPDIR = path.join(runDir, "tmp");
    env[RUN_DIR_ENV] = runDir;
    let cleaned = false;
    return {
      env,
      runDir,
      paths,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          fs.rmSync(runDir, { recursive: true, force: true });
        } catch {
          // A leftover is swept once stale.
        }
      },
    };
  } catch (error) {
    warn(`${WARN_PREFIX} could not create a run temp dir under ${jobsDir} (${(error as Error).message}); TMPDIR unchanged.`);
    return { ...noop, env };
  }
}

/**
 * For a test runner's own process (Vitest / Playwright config): applies the
 * run's env to `env` (process.env by default) so the workers and browsers it
 * starts inherit it, and removes the run dir when this process exits. A
 * runner started under a launcher that already made a run dir reuses it.
 */
export function useDevRunEnv(env: NodeJS.ProcessEnv = process.env): DevRun {
  const run = startDevRun({ env });
  Object.assign(env, run.env);
  // Vitest and Playwright end through process.exit on SIGINT/SIGTERM too; a
  // SIGKILL leaves the dir for the stale sweep.
  if (run.runDir) process.once("exit", run.cleanup);
  return run;
}

// ───────────────── per-environment directories (./raftdev start) ─────────────────
//
// The long-lived services of a dev environment (server, Vite, daemon, ...)
// get TMPDIR=`<root>/env/<env-key>/tmp`, and the cloudflared log goes to
// `<root>/env/<env-key>/cloudflared.log`. env-key: 8 hex of sha256 of the
// environment's unique id (its state dir, `<project>/.slockdev/<name>`, so the
// same name in two worktrees gets two dirs). One fixed dir per environment, not
// per start: `start` creates it with an owner.json, `stop` removes it only once
// the environment's processes are confirmed gone; when unsure it stays.

export const ENVS_DIR = "env";
export const ENV_OWNER_FILE = "owner.json";
const ENV_KEY_RE = /^[0-9a-f]{8}$/;

export function envKeyFor(envId: string): string {
  return createHash("sha256").update(envId).digest("hex").slice(0, 8);
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface DevEnvDir {
  /** "raft-dev": services get `tmpdir`; "env": the caller's TMPDIR is kept; "none": nothing changes. */
  source: "raft-dev" | "env" | "none";
  envId: string;
  envKey: string;
  /** `<root>/env/<env-key>` (null unless source is "raft-dev"). */
  dir: string | null;
  /** `<dir>/tmp` (null unless source is "raft-dev"). */
  tmpdir: string | null;
  reason: string | null;
  warnings: string[];
}

/**
 * Pure: where the services of the environment `envId` put their temp files.
 * An explicit TMPDIR wins, except one inherited from another raftdev
 * environment's services (a shell left in its tmux pane). CI, non-Linux,
 * RAFT_DEV_CACHE=0 and no on-disk root change nothing; neither does a dir that
 * would leave too little of AF_UNIX's 108 bytes for sockets under it.
 */
export function resolveDevEnvDir(envId: string, input: ResolveInput & { maxTmpdirBytes?: number } = {}): DevEnvDir {
  const env = input.env ?? process.env;
  const envKey = envKeyFor(envId);
  const paths = resolveDevCachePaths(input);
  const base = { envId, envKey, dir: null, tmpdir: null };
  if (!paths.active || paths.root === null) {
    return { ...base, source: "none", reason: paths.inactiveReason, warnings: paths.warnings };
  }
  const envsDir = path.join(paths.root, ENVS_DIR);
  const inherited = env.TMPDIR !== undefined && env.TMPDIR !== "" && isUnder(env.TMPDIR, envsDir);
  if (env.TMPDIR && !inherited) {
    return { ...base, source: "env", reason: `TMPDIR is set (${env.TMPDIR})`, warnings: paths.warnings };
  }
  const warnings = paths.warnings.filter((w) => !w.includes(" TMPDIR "));
  const dir = path.join(envsDir, envKey);
  const tmp = path.join(dir, "tmp");
  const maxBytes = input.maxTmpdirBytes ?? MAX_RUN_TMPDIR_BYTES;
  if (Buffer.byteLength(tmp) > maxBytes) {
    warnings.push(`${WARN_PREFIX} the environment TMPDIR (${tmp}) would be ${Buffer.byteLength(tmp)} bytes, over ${maxBytes} `
      + "(AF_UNIX socket paths under it could exceed 108 bytes); TMPDIR unchanged. Set RAFT_DEV_CACHE_DIR to a shorter on-disk path.");
    return { ...base, source: "none", reason: "TMPDIR path too long for sockets", warnings };
  }
  return { ...base, source: "raft-dev", dir, tmpdir: tmp, reason: null, warnings };
}

export interface EnvOwner {
  /** The environment's unique id (guards against an env-key collision). */
  envId: string;
  hostname: string;
  bootId: string | null;
  startedAt: number;
  /** raftdev start, tmux panes and cloudflared: pid + /proc starttime (+ bootId) is the identity, as for previews. */
  processes: PreviewProcess[];
}

/** A live process's /proc/<pid>/stat starttime, else null. */
export const procStarttime = (pid: number): string | null => liveStarttime(readProcStat(pid));

function isRecordedProcess(p: unknown): p is PreviewProcess {
  const r = p as Partial<PreviewProcess> | null;
  return typeof r === "object" && r !== null && Number.isInteger(r.pid) && (r.pid as number) > 0
    && typeof r.starttime === "string" && typeof r.role === "string";
}

function readEnvOwnerFile(dir: string): EnvOwner | null {
  const file = path.join(dir, ENV_OWNER_FILE);
  if (lstatKind(file) !== "file") return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EnvOwner>;
    if (typeof raw.envId !== "string" || typeof raw.hostname !== "string" || typeof raw.startedAt !== "number"
      || !Array.isArray(raw.processes) || !raw.processes.every(isRecordedProcess)) return null;
    return { envId: raw.envId, hostname: raw.hostname, bootId: typeof raw.bootId === "string" ? raw.bootId : null, startedAt: raw.startedAt, processes: raw.processes };
  } catch {
    return null;
  }
}

function recordedProcesses(pids: Array<{ pid: number; role: string }>, starttimeOf: (pid: number) => string | null): PreviewProcess[] {
  const result: PreviewProcess[] = [];
  for (const { pid, role } of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // A pid whose starttime can't be read is already gone: nothing to record.
    const starttime = starttimeOf(pid);
    if (starttime !== null) result.push({ pid, starttime, role });
  }
  return result;
}

/**
 * `start`: writes owner.json (this start's pid + starttime, a fresh
 * startedAt) and then creates `<dir>/tmp`. The record comes first so a
 * concurrent `cache prune` sees this start's live process and keeps the dir.
 * The dir is reused across starts of the same environment. Returns false
 * (with a warning) when it can't, so the caller keeps its TMPDIR.
 */
export function prepareDevEnvDir(
  resolved: DevEnvDir,
  opts: {
    pid?: number; now?: number; hostname?: string; bootId?: string | null; warn?: (msg: string) => void;
    starttimeOf?: (pid: number) => string | null;
  } = {},
): boolean {
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  if (resolved.source !== "raft-dev" || !resolved.dir || !resolved.tmpdir) return false;
  try {
    fs.mkdirSync(path.dirname(resolved.dir), { recursive: true, mode: 0o700 });
    const kind = lstatKind(resolved.dir);
    if (kind !== null && kind !== "dir") throw new Error(`${resolved.dir} exists and is not a directory`);
    const previous = kind === "dir" ? readEnvOwnerFile(resolved.dir) : null;
    if (previous && previous.envId !== resolved.envId) throw new Error(`${resolved.dir} belongs to ${previous.envId}`);
    if (kind === null) fs.mkdirSync(resolved.dir, { mode: 0o700 });
    const owner: EnvOwner = {
      envId: resolved.envId,
      hostname: opts.hostname ?? os.hostname(),
      bootId: opts.bootId === undefined ? currentBootId() : opts.bootId,
      startedAt: opts.now ?? Date.now(),
      processes: recordedProcesses([{ pid: opts.pid ?? process.pid, role: "raftdev-start" }], opts.starttimeOf ?? procStarttime),
    };
    fs.writeFileSync(path.join(resolved.dir, ENV_OWNER_FILE), JSON.stringify(owner));
    fs.mkdirSync(resolved.tmpdir, { recursive: true, mode: 0o700 });
    return true;
  } catch (error) {
    warn(`${WARN_PREFIX} could not prepare the environment temp dir ${resolved.dir} (${(error as Error).message}); TMPDIR unchanged.`);
    return false;
  }
}

/** Adds processes (tmux panes, cloudflared) to the environment's owner.json, with their starttime. Best effort. */
export function recordDevEnvProcesses(
  dir: string,
  pids: Array<{ pid: number; role: string }>,
  starttimeOf: (pid: number) => string | null = procStarttime,
): void {
  const owner = readEnvOwnerFile(dir);
  if (!owner) return;
  const merged = [...owner.processes];
  for (const p of recordedProcesses(pids, starttimeOf)) {
    if (!merged.some((m) => m.pid === p.pid && m.starttime === p.starttime)) merged.push(p);
  }
  try {
    fs.writeFileSync(path.join(dir, ENV_OWNER_FILE), JSON.stringify({ ...owner, processes: merged }));
  } catch {
    // Without them, stop still checks the session and every process's TMPDIR.
  }
}

export interface EnvDirFs {
  readdir(dir: string): string[];
  kind(p: string): EntryKind | null;
  readOwner(dir: string): EnvOwner | null;
  /** Pids of live processes whose TMPDIR is `tmp` or under it; null when that can't be checked. */
  processesUsingTmpdir(tmp: string): number[] | null;
  remove(dir: string): void;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Scans /proc/<pid>/environ (own processes; others' are unreadable and
 * skipped). Paths are compared after realpath, so a TMPDIR reaching the dir
 * through a symlink counts.
 */
export function processesUsingTmpdir(tmp: string, procDir = "/proc"): number[] | null {
  const target = realOrResolved(tmp);
  const seen = new Map<string, string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return null;
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let environ: string;
    try {
      environ = fs.readFileSync(path.join(procDir, entry, "environ"), "latin1");
    } catch {
      continue; // gone, or another user's
    }
    for (const kv of environ.split("\0")) {
      if (!kv.startsWith("TMPDIR=")) continue;
      const value = kv.slice("TMPDIR=".length);
      if (!value) break;
      let real = seen.get(value);
      if (real === undefined) {
        real = realOrResolved(value);
        seen.set(value, real);
      }
      if (real === target || isUnder(real, target)) found.push(Number(entry));
      break;
    }
  }
  return found;
}

export const realEnvDirFs: EnvDirFs = {
  readdir: realSweepFs.readdir,
  kind: lstatKind,
  readOwner: readEnvOwnerFile,
  processesUsingTmpdir: (tmp) => processesUsingTmpdir(tmp),
  remove: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
};

export interface EnvTeardownContext {
  /**
   * The environment being stopped. null (`cache prune`): the one owner.json
   * names, which must hash to the dir's name.
   */
  envId: string | null;
  hostname: string;
  bootId: string | null;
  /** /proc starttime of a live pid, else null (procStarttime). */
  starttimeOf: (pid: number) => string | null;
  /** This process (a `stop` the janitor started inherits the env's TMPDIR). */
  selfPid: number;
  /** Whether the environment's tmux session still exists; null when that can't be checked. */
  sessionAlive: (envId: string) => boolean | null;
}

export interface EnvTeardownResult {
  removed: boolean;
  reason: string;
  /** Kept because processes of the environment are still alive (worth waiting for). */
  liveProcesses: boolean;
}

/**
 * `stop` and `cache prune`: removes `<dir>` only when it is a real directory
 * named like an env key with this environment's owner.json from this host,
 * the tmux session is gone, no recorded process is alive (pid + starttime +
 * boot), and no process has its TMPDIR there. Anything else leaves it. Age is
 * never a reason.
 */
export function removeDevEnvDir(dir: string, ctx: EnvTeardownContext, efs: EnvDirFs = realEnvDirFs): EnvTeardownResult {
  const keep = (reason: string, liveProcesses = false): EnvTeardownResult => ({ removed: false, reason, liveProcesses });
  const kind = efs.kind(dir);
  if (kind === null) return keep("absent");
  if (kind === "symlink") return keep("a symlink, not a directory (not followed)");
  if (kind !== "dir") return keep("not a directory");
  if (!ENV_KEY_RE.test(path.basename(dir))) return keep("not an environment dir");
  const owner = efs.readOwner(dir);
  if (!owner) return keep("no valid owner record");
  if (ctx.envId === null ? envKeyFor(owner.envId) !== path.basename(dir) : owner.envId !== ctx.envId) {
    return keep(`owned by ${owner.envId}`);
  }
  if (owner.hostname !== ctx.hostname) return keep(`owned by host ${owner.hostname}`);
  const session = ctx.sessionAlive(owner.envId);
  if (session === null) return keep("could not check the tmux session");
  if (session) return keep("tmux session still running");
  // Same identity rule as previews: alive only with the recorded boot and
  // starttime, so a reused pid or a reboot is the old process gone. With a
  // boot id unknown on either side, the starttime alone decides.
  const recordBoot = owner.bootId ?? ctx.bootId ?? "";
  const nowBoot = ctx.bootId ?? owner.bootId ?? "";
  const alive = owner.processes
    .filter((p) => p.pid !== ctx.selfPid && isRecordedProcessAlive(p, recordBoot, nowBoot, ctx.starttimeOf))
    .map((p) => p.pid);
  if (alive.length > 0) return keep(`recorded process(es) still alive: ${alive.join(", ")}`, true);
  const users = efs.processesUsingTmpdir(path.join(dir, "tmp"));
  if (users === null) return keep("could not check processes");
  const others = users.filter((p) => p !== ctx.selfPid);
  if (others.length > 0) return keep(`process(es) still using it: ${others.join(", ")}`, true);
  // A `start` that rewrote the record meanwhile (prune vs a concurrent start).
  if (JSON.stringify(efs.readOwner(dir)) !== JSON.stringify(owner)) return keep("owner record changed while checking");
  try {
    efs.remove(dir);
  } catch (error) {
    return keep((error as Error).message);
  }
  return { removed: true, reason: "removed", liveProcesses: false };
}

/** tmux session of the environment with state dir `envId` (raftdev.ts: `slock-<name>`). */
export function devEnvSessionName(envId: string): string {
  return `slock-${path.basename(envId)}`;
}

/**
 * Whether the tmux session exists (exit 0; 1 is no session or no server) on
 * the default server, or on `-L <socket>`. Prefix matching only makes it keep
 * more. null when tmux can't be run.
 */
export function tmuxSessionAlive(session: string, socket: string | null): boolean | null {
  const r = spawnSync("tmux", [...(socket ? ["-L", socket] : []), "has-session", "-t", session], { stdio: "ignore" });
  if (r.error || r.status === null) return null;
  return r.status === 0;
}

export type TmuxSessionCheck = (session: string, socket: string | null) => boolean | null;

/**
 * Whether the environment with state dir `envId` still has its tmux session:
 * on the default server, and for a preview (`<envId>/preview.json`) on its own
 * `-L raft-preview-<id>` server too (as raftdev.ts previewTmuxSocketArgs).
 * Preview metadata present but unreadable or invalid: unknown (null).
 */
export function devEnvSessionAlive(envId: string, tmux: TmuxSessionCheck = tmuxSessionAlive): boolean | null {
  const session = devEnvSessionName(envId);
  const checks: Array<boolean | null> = [tmux(session, null)];
  const previewFile = path.join(envId, "preview.json");
  let previewPresent = true;
  try {
    fs.lstatSync(previewFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") previewPresent = false;
  }
  if (previewPresent) {
    let state = null;
    try {
      state = parsePreviewState(fs.readFileSync(previewFile, "utf8"));
    } catch {
      // unreadable: unknown
    }
    checks.push(state ? tmux(session, state.tmuxSocket) : null);
  }
  if (checks.includes(true)) return true;
  return checks.includes(null) ? null : false;
}

/**
 * `cache prune`: every entry of `<root>/env/` through removeDevEnvDir (the
 * same predicate as stop, with the env id taken from each owner.json), so an
 * environment never stopped (e.g. its worktree deleted) doesn't keep its dir.
 */
export function sweepDevEnvDirs(
  envsDir: string,
  ctx: Omit<EnvTeardownContext, "envId">,
  efs: EnvDirFs = realEnvDirFs,
): Array<{ dir: string; result: EnvTeardownResult }> {
  if (efs.kind(envsDir) !== "dir") return [];
  return efs.readdir(envsDir).sort().map((name) => {
    const dir = path.join(envsDir, name);
    return { dir, result: removeDevEnvDir(dir, { ...ctx, envId: null }, efs) };
  });
}

// ───────────────── ./raftdev cache ─────────────────

export interface CacheCliDeps {
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** `pnpm <args>` (stdout, status). */
  pnpm?: (args: string[]) => { stdout: string; status: number | null };
  statfs?: StatFs;
  sweepFs?: SweepFs;
  now?: number;
  /** `<root>/env/` sweep: its filesystem and the teardown checks (defaults: real host). */
  envDirFs?: EnvDirFs;
  envCtx?: Partial<Omit<EnvTeardownContext, "envId">>;
  /** tmux has-session on the default server or `-L <socket>` (default: runs tmux). */
  tmux?: TmuxSessionCheck;
}

const realPnpm = (args: string[]) => {
  const r = spawnSync("pnpm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return { stdout: r.stdout ?? "", status: r.error ? null : r.status };
};

export function cacheUsage(): string {
  return `Usage: ./raftdev cache <status|prune>
  status   Print where dev caches and test temp files go, and whether each is on tmpfs (writes nothing)
  prune    Remove leftover run temp dirs (older than 24h, owner process gone) of every agent of
           this user; remove the \`raftdev start\` environment dirs (<root>/env/<env-key>) whose
           environment is fully gone (owner record from this host, tmux session gone, no recorded
           process alive, no process with its TMPDIR there; anything uncertain is kept, with why);
           clear the Node compile cache (it regenerates), then run \`pnpm store prune\`.
           The pnpm store is shared by every agent of this Unix user: pruning it affects them
           all; do not run it while any of them installs packages.`;
}

export function runCacheCli(args: string[], deps: CacheCliDeps): number {
  const env = deps.env ?? process.env;
  const sfs = deps.statfs ?? realStatFs;
  const pnpm = deps.pnpm ?? realPnpm;
  const sweepFs = deps.sweepFs ?? realSweepFs;
  const { out } = deps;
  const sub = args[0];
  if (sub !== "status" && sub !== "prune") {
    out(cacheUsage());
    return sub === undefined || sub === "--help" || sub === "-h" ? 0 : 1;
  }
  const paths = resolveDevCachePaths({ env, statfs: sfs });
  const medium = (p: string | null) => (p ? storageMedium(p, sfs).medium : "n/a");

  if (sub === "status") {
    const store = pnpm(["store", "path"]);
    const storePath = store.status === 0 ? store.stdout.trim() : null;
    out(`/tmp:                     ${medium("/tmp")}`);
    out(`active:                   ${paths.active ? "yes" : `no (${paths.inactiveReason})`}`);
    out(`root:                     ${paths.root ?? "-"}${paths.root ? ` [${medium(paths.root)}]` : ""}`);
    out(`agent id:                 ${paths.agentId} (dir ${paths.agentKey})`);
    out(`NODE_COMPILE_CACHE:       ${paths.nodeCompileCache.path ?? "-"} (${paths.nodeCompileCache.source}) [${medium(paths.nodeCompileCache.path)}]`);
    out(`test TMPDIR:              ${paths.tmp.source === "raft-dev" && paths.root ? `${path.join(paths.root, JOBS_DIR, paths.agentKey)}/<run-id>/tmp` : paths.tmp.path ?? "-"} (${paths.tmp.source})`);
    // Same resolution as `./raftdev start` (the env key doesn't change the answer).
    const service = resolveDevEnvDir("", { env, statfs: sfs });
    out(`raftdev services TMPDIR:  ${service.source === "raft-dev" && paths.root
      ? `${path.join(paths.root, ENVS_DIR)}/<env-key>/tmp (raft-dev; cloudflared log in <env-key>/; removed by stop, or by prune once the env is gone)`
      : `${env.TMPDIR || "-"} (${service.source})`}`);
    out(`Playwright browsers:      ${paths.playwrightBrowsers.path} (${paths.playwrightBrowsers.source}) [${medium(paths.playwrightBrowsers.path)}]`);
    out(`pnpm store:               ${storePath ?? "(pnpm store path failed)"}${storePath ? ` [${medium(storePath)}]` : ""}`);
    if (storePath && medium(storePath) === "ram") {
      const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
      const suggestion = path.join(dataHome, "pnpm", "store");
      out(`${WARN_PREFIX} WARNING: the pnpm store is on tmpfs and was NOT moved. `
        + (medium(suggestion) === "disk"
          ? `To move it: pnpm config set store-dir ${suggestion} --location=global (the next install re-downloads packages).`
          : "No on-disk location was verified; set store-dir to an on-disk directory."));
    }
    for (const w of paths.warnings) out(w);
    return 0;
  }

  // prune
  if (paths.root) {
    const jobsDir = path.join(paths.root, JOBS_DIR);
    const removed = sweepStaleRuns(jobsDir, null, {
      now: deps.now ?? Date.now(), hostname: os.hostname(), bootId: currentBootId(), isPidAlive,
    }, sweepFs);
    out(`Removed ${removed.length} stale run dir(s) under ${jobsDir}.`);
    for (const r of removed) out(`  ${r}`);
    const envsDir = path.join(paths.root, ENVS_DIR);
    const envResults = sweepDevEnvDirs(envsDir, {
      hostname: os.hostname(),
      bootId: currentBootId(),
      starttimeOf: procStarttime,
      // None: a prune run whose own TMPDIR is in an env dir keeps that dir.
      selfPid: 0,
      sessionAlive: (envId) => devEnvSessionAlive(envId, deps.tmux ?? tmuxSessionAlive),
      ...deps.envCtx,
    }, deps.envDirFs ?? realEnvDirFs);
    const envRemoved = envResults.filter((r) => r.result.removed);
    out(`Removed ${envRemoved.length} environment dir(s) under ${envsDir}.`);
    for (const r of envResults) {
      if (r.result.removed) out(`  ${r.dir}`);
      else if (r.result.reason !== "absent") out(`  kept ${r.dir}: ${r.result.reason}`);
    }
    // Ours only (an explicit NODE_COMPILE_CACHE is the user's), and a real
    // directory, not a symlink's target.
    const ncc = paths.nodeCompileCache;
    if (ncc.source === "raft-dev" && ncc.path && sweepFs.kind(ncc.path) === "dir") {
      sweepFs.remove(ncc.path);
      out(`Cleared the Node compile cache ${ncc.path} (it regenerates).`);
    }
  } else {
    out(`No raft-dev cache root (${paths.inactiveReason}); no run or environment dirs to prune.`);
  }
  out("Running pnpm store prune (shared by every agent of this Unix user)...");
  const prune = pnpm(["store", "prune"]);
  if (prune.stdout) out(prune.stdout.trimEnd());
  return prune.status === 0 ? 0 : 1;
}
