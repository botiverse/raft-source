// The wiring of "On this computer" checks (README.md): a server's
// `computer:checks:config` and `computer:checks:refresh`, answered by
// `computer:checks:report`.
//
// A Computer runs one runner (daemon process) per connected server, all on one
// RAFT_HOME. One round of checks serves every runner: the round runs under a
// lock file, the union of what any runner's server enabled, and is kept in
// `computer/checks-round.json` for 30 s; a refresh in that time (from any
// runner) is answered from it. Each runner then sends its server only what
// that server enabled, with the owner's switch re-read for every answer (it
// wins: a switched-off check is listed `disabledByOwner`, never its rows).
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMPUTER_CHECK_IDS,
  COMPUTER_CHECKS_REFRESH_INTERVAL_MS,
  isCheckItemStatus,
  isCheckPluginError,
  isCheckUnconfirmedReason,
  isComputerCheckId,
  parseComputerChecksReport,
} from "@botiverse/raft-shared";
import { logger } from "../logger";
import { writeJsonAtomic } from "./atomicFile";
import { readRegularFile } from "./declaredFile";
import { isDisabledByOwner, observeOwnerChecksSwitch, readOwnerChecksSwitch, type OwnerChecksSwitch } from "./ownerSwitch";
import { isStoredPluginValid } from "./storedRows";
import { CHECK_ROUND_BUDGET_MS, checksWorkDir, runComputerChecks, type RunComputerChecksDeps } from "./runner";
import type { ComputerCheckId, ComputerCheckPluginReport, ComputerChecksEnabled, ComputerChecksReport } from "./types";

/** The last round, shared by the Computer's runners. */
export const CHECK_ROUND_FILE = path.join("computer", "checks-round.json");
/** Held while a round runs; one round at a time across the runners. */
export const CHECK_ROUND_LOCK_FILE = path.join("computer", "checks-round.lock");
/** Each runner's server's switches (`<runner>.json`), so a round runs what any server enabled. */
export const CHECK_SERVER_CONFIG_DIR = path.join("computer", "checks-servers");
/** A lock older than this is left behind by a runner that died mid-round. */
export const CHECK_ROUND_LOCK_STALE_MS = 3 * CHECK_ROUND_BUDGET_MS;
/** How long a refresh waits for another runner's round before running its own (without the lock). */
export const CHECK_ROUND_LOCK_WAIT_MS = CHECK_ROUND_BUDGET_MS + 10_000;
/**
 * A round in flight is given up after this (the lock wait, the round's own
 * budget and a margin), so a refresh never joins a round that hangs.
 */
export const CHECK_ROUND_HARD_LIMIT_MS = CHECK_ROUND_LOCK_WAIT_MS + CHECK_ROUND_BUDGET_MS + 10_000;
const CHECK_ROUND_LOCK_POLL_MS = 250;
/** Another runner's switches count for this long after it last wrote them (it rewrites them on every config and refresh). */
export const CHECK_SERVER_CONFIG_FRESH_MS = 24 * 60 * 60_000;
const CHECK_ROUND_FILE_MAX_BYTES = 64 * 1024;
const CHECK_SERVER_CONFIG_MAX_BYTES = 4 * 1024;
const RUNNER_KEY = /^[A-Za-z0-9_-]{1,128}$/;

interface RoundRecord {
  startedAtMs: number;
  report: ComputerChecksReport;
}

/** Rounds of this process, by RAFT_HOME: a refresh during a round joins it. */
const roundsInFlight = new Map<string, Promise<ComputerChecksReport>>();

export interface ComputerChecksServiceDeps {
  raftHome: string;
  /** This runner's name among the Computer's runners (its machine id); null until known. */
  runnerKey: () => string | null;
  /** Sends `computer:checks:report` to this runner's server. */
  send: (report: ComputerChecksReport) => void;
  /** Trace without content: names and counts only. */
  trace?: (name: string, attrs: Record<string, string | number | boolean>) => void;
  /** Tests substitute the round; production runs `runComputerChecks`. */
  run?: typeof runComputerChecks;
  /** Tests shorten the lock wait and the in-flight limit. */
  lockWaitMs?: number;
  roundHardLimitMs?: number;
  /** Extra runner deps for tests (checks, spawn, clock). */
  runDeps?: Partial<RunComputerChecksDeps>;
  /** The Computer user's own home, `os.userInfo().homedir` (never `HOME` or `os.homedir()`). */
  homeDir?: () => string;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

/** Only known ids with a boolean; anything else in a config is ignored. */
export function sanitizeChecksEnabled(raw: unknown): ComputerChecksEnabled {
  const enabled: ComputerChecksEnabled = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return enabled;
  for (const id of COMPUTER_CHECK_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (typeof value === "boolean") enabled[id] = value;
  }
  return enabled;
}

function enabledIds(enabled: ComputerChecksEnabled): ComputerCheckId[] {
  return COMPUTER_CHECK_IDS.filter((id) => enabled[id] === true);
}

/** A round file read back: the shared wire schema, then only values this Computer knows (it may have been edited locally). */
function asLocalReport(value: unknown): ComputerChecksReport | null {
  const wire = parseComputerChecksReport(value);
  if (!wire) return null;
  const seen = new Set<string>();
  for (const plugin of wire.plugins) {
    if (!isComputerCheckId(plugin.id) || seen.has(plugin.id)) return null;
    seen.add(plugin.id);
    if (plugin.error !== undefined && !isCheckPluginError(plugin.error)) return null;
    for (const item of plugin.items) {
      if (!isCheckItemStatus(item.status)) return null;
      if (item.reason !== undefined && !isCheckUnconfirmedReason(item.reason)) return null;
    }
  }
  const switchIdsKnown = (disabled: "all" | string[] | undefined) => disabled === undefined || disabled === "all" || disabled.every(isComputerCheckId);
  if (wire.ownerSwitch && (!switchIdsKnown(wire.ownerSwitch.disabled) || !switchIdsKnown(wire.ownerSwitch.previous))) return null;
  const report = wire as ComputerChecksReport;
  // Each row through the same per-check shapes the checks use (storedRows.ts):
  // a forged file cannot put free text in a structured row.
  return report.plugins.every(isStoredPluginValid) ? report : null;
}

async function readJson(filePath: string, maxBytes: number): Promise<unknown> {
  const read = await readRegularFile(filePath, maxBytes);
  if (!("text" in read)) return undefined;
  try {
    return JSON.parse(read.text) as unknown;
  } catch {
    return undefined;
  }
}

/** Started within the refresh interval and not in the future. */
function isFreshStart(startedAtMs: number, now: number): boolean {
  const age = now - startedAtMs;
  return age >= 0 && age < COMPUTER_CHECKS_REFRESH_INTERVAL_MS;
}

/**
 * The last round in the shared file if it is fresh, and its `checkedAt` lies
 * inside the round it claims (no earlier than its start, no later than now):
 * a forged file cannot carry a `checkedAt` the server would keep in place of
 * later rounds.
 */
async function readFreshRoundFile(raftHome: string, now: number): Promise<RoundRecord | null> {
  const raw = await readJson(path.join(raftHome, CHECK_ROUND_FILE), CHECK_ROUND_FILE_MAX_BYTES);
  if (typeof raw !== "object" || raw === null) return null;
  const { startedAtMs, report } = raw as { startedAtMs?: unknown; report?: unknown };
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || !isFreshStart(startedAtMs, now)) return null;
  const local = asLocalReport(report);
  if (!local) return null;
  const checkedAtMs = Date.parse(local.checkedAt);
  if (!(checkedAtMs >= startedAtMs && checkedAtMs <= now)) return null;
  return { startedAtMs, report: local };
}

/**
 * The last round this process ran, by RAFT_HOME: deleting the shared file
 * does not lift the 30 s limit for this runner.
 */
const lastRounds = new Map<string, RoundRecord>();

/** The newest fresh round (the shared file or this process's own) that covers what this server wants; null: run one. */
async function freshCoveringRound(raftHome: string, now: number, own: readonly ComputerCheckId[], owner: OwnerChecksSwitch): Promise<RoundRecord | null> {
  const remembered = lastRounds.get(raftHome);
  const candidates = [await readFreshRoundFile(raftHome, now), remembered && isFreshStart(remembered.startedAtMs, now) ? remembered : null]
    .filter((round): round is RoundRecord => round !== null && roundCovers(round.report, own, owner));
  return candidates.sort((a, b) => b.startedAtMs - a.startedAtMs)[0] ?? null;
}

interface LockFile {
  pid: number;
  at: number;
  /** Random per lock: a file that reuses a freed inode number is still not this runner's lock. */
  nonce: string;
}

const LOCK_FILE_READ_LIMIT = 1024;

/**
 * Whether the file at `filePath` is the lock this runner wrote: the same
 * regular file (dev and inode, checked on the opened descriptor, a symlink
 * never followed) and its own nonce. A file system can hand a freed inode
 * number to the next file at once, so dev and inode alone may name another
 * runner's newer lock. Opened non-blocking and read only after fstat says it
 * is a regular file, at most 1 KB: a FIFO or a device swapped in cannot
 * block or flood the release.
 */
async function isOwnLockFile(filePath: string, identity: FileIdentity, nonce: string): Promise<boolean> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
    const buffer = Buffer.alloc(LOCK_FILE_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, LOCK_FILE_READ_LIMIT, 0);
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as Partial<LockFile>).nonce === nonce;
  } finally {
    await handle.close();
  }
}

/** The identity of a lock file (dev and inode); a stale lock is judged by it, never by what is in it (the path is agent-writable). */
interface FileIdentity {
  dev: number;
  ino: number;
}

/** Only a regular file that is the very file `identity` names (lstat: a symlink is never followed). */
async function isSameRegularFile(filePath: string, identity: FileIdentity & { mtimeMs?: number }): Promise<boolean> {
  const stat = await lstat(filePath);
  return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && (identity.mtimeMs === undefined || stat.mtimeMs === identity.mtimeMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Moves the lock at `lockPath` aside and removes it only if `keep(moved)`
 * says it is the one meant; a lock
 * someone else took meanwhile is linked back (never over a newer one). The
 * rename is atomic, so two runners never both remove the same lock, and a
 * runner never removes a lock another runner holds. False when nothing was
 * removed (a failure counts as held).
 */
async function removeLockIf(lockPath: string, keep: (movedPath: string) => Promise<boolean>): Promise<boolean> {
  const moved = `${lockPath}.${randomUUID()}.gone`;
  try {
    await rename(lockPath, moved);
  } catch {
    return false;
  }
  let ours = false;
  try {
    ours = await keep(moved);
  } catch {
    ours = false;
  }
  if (!ours) {
    // Not the lock meant: put it back unless a new one is already there.
    await link(moved, lockPath).catch(() => {});
  }
  await unlink(moved).catch(() => {});
  return ours;
}

/**
 * A stale lock (a runner died mid-round) is removed, once, by whoever moves
 * it aside first, and only if it is still the very file seen stale. Anything
 * that is not a regular file (a symlink, a directory) or cannot be removed
 * counts as held.
 */
async function removeStaleLock(lockPath: string): Promise<boolean> {
  let seen;
  try {
    seen = await lstat(lockPath);
  } catch {
    // Gone meanwhile: try to take it at once.
    return true;
  }
  if (!seen.isFile() || Date.now() - seen.mtimeMs <= CHECK_ROUND_LOCK_STALE_MS) return false;
  return removeLockIf(lockPath, (movedPath) => isSameRegularFile(movedPath, seen));
}

/**
 * Takes the round lock, waiting for another runner's round. Every path
 * waits 250 ms between tries and stops at the deadline; null then (or when
 * the lock cannot be made at all): the round runs without it.
 */
async function acquireRoundLock(raftHome: string, waitMs: number): Promise<(() => Promise<void>) | null> {
  const lockPath = path.join(raftHome, CHECK_ROUND_LOCK_FILE);
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let identity: FileIdentity;
      const nonce = randomUUID();
      try {
        const stat = await handle.stat();
        identity = { dev: stat.dev, ino: stat.ino };
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), nonce } satisfies LockFile));
      } finally {
        await handle.close();
      }
      // Removed only while it is still the file this runner created and wrote
      // (see isOwnLockFile): never another runner's lock, even one that got
      // the same inode number after a stale take-over.
      return async () => {
        await removeLockIf(lockPath, (movedPath) => isOwnLockFile(movedPath, identity, nonce));
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    const removed = await removeStaleLock(lockPath);
    if (Date.now() >= deadline) return null;
    if (!removed) await sleep(CHECK_ROUND_LOCK_POLL_MS);
  }
}

/** `promise`, or a rejection after `ms`: a round in flight is never waited on for ever. */
function withHardLimit<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("computer checks round over its hard limit")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Whether a round has run (not just listed as switched off) every check this server wants and the owner allows now. */
function roundCovers(round: ComputerChecksReport, own: readonly ComputerCheckId[], owner: OwnerChecksSwitch): boolean {
  return own.every((id) => isDisabledByOwner(owner, id) || round.plugins.some((plugin) => plugin.id === id && !plugin.disabledByOwner));
}

/** What any runner's server enabled lately, with this runner's own. */
async function enabledUnion(raftHome: string, own: readonly ComputerCheckId[], now: number): Promise<ComputerChecksEnabled> {
  const ids = new Set<ComputerCheckId>(own);
  const dir = path.join(raftHome, CHECK_SERVER_CONFIG_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).slice(0, 64);
  } catch {
    // No other runner wrote one.
  }
  for (const name of names) {
    const raw = await readJson(path.join(dir, name), CHECK_SERVER_CONFIG_MAX_BYTES);
    if (typeof raw !== "object" || raw === null) continue;
    const { enabled, writtenAtMs } = raw as { enabled?: unknown; writtenAtMs?: unknown };
    if (typeof writtenAtMs !== "number" || now - writtenAtMs > CHECK_SERVER_CONFIG_FRESH_MS) continue;
    if (Array.isArray(enabled)) for (const id of enabled) if (isComputerCheckId(id)) ids.add(id);
  }
  return Object.fromEntries([...ids].map((id) => [id, true]));
}

/**
 * One server's report from a round: only the checks it enabled, in a fixed
 * order. The owner's switch, as just read, wins: a check it switched off is
 * listed `disabledByOwner` without rows even if the round ran it. A check the
 * round did not cover (enabled after it ran, within the refresh interval) is
 * left out until the next round.
 */
export function reportForServer(
  round: ComputerChecksReport,
  enabled: ComputerChecksEnabled,
  owner: OwnerChecksSwitch,
  ownerSwitch: ComputerChecksReport["ownerSwitch"],
): ComputerChecksReport {
  const plugins: ComputerCheckPluginReport[] = [];
  for (const id of enabledIds(enabled)) {
    if (isDisabledByOwner(owner, id)) {
      plugins.push({ id, items: [], durationMs: 0, disabledByOwner: true });
      continue;
    }
    const ran = round.plugins.find((plugin) => plugin.id === id);
    if (ran && !ran.disabledByOwner) plugins.push(ran);
  }
  return {
    schemaVersion: 1,
    checkedAt: round.checkedAt,
    plugins,
    ...(ownerSwitch ? { ownerSwitch } : {}),
    ...(round.truncated && plugins.some((plugin) => plugin.truncated) ? { truncated: true as const } : {}),
  };
}

export class ComputerChecksService {
  /** This server's switches; null until it sent a config (an older server never does, and never gets a report). */
  private enabled: ComputerChecksEnabled | null = null;

  constructor(private readonly deps: ComputerChecksServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Never throws: refresh() runs unawaited, so a throwing tracer must not become an unhandled rejection. */
  private trace(name: string, attrs: Record<string, string | number | boolean>): void {
    try {
      this.deps.trace?.(name, attrs);
    } catch {
      // Tracing is best effort.
    }
  }

  /** A new connection: its server sends its own config first. */
  reset(): void {
    this.enabled = null;
  }

  /** `computer:checks:config`. Never runs anything by itself. */
  async setConfig(raw: unknown): Promise<void> {
    this.enabled = sanitizeChecksEnabled(raw);
    this.trace("daemon.computer_checks.config", { enabled_count: enabledIds(this.enabled).length });
    await this.recordOwnConfig();
  }

  private async recordOwnConfig(): Promise<void> {
    const key = this.deps.runnerKey();
    if (!this.enabled || !key || !RUNNER_KEY.test(key)) return;
    try {
      await writeJsonAtomic(path.join(this.deps.raftHome, CHECK_SERVER_CONFIG_DIR, `${key}.json`), {
        enabled: enabledIds(this.enabled),
        writtenAtMs: this.now(),
      });
    } catch {
      logger.warn("[computer-checks] could not record this server's check switches");
    }
  }

  /**
   * `computer:checks:refresh`: answers with this server's part of a round
   * (a shared one within 30 s, else a new one); nothing before a config.
   * Never rejects.
   */
  async refresh(): Promise<void> {
    const enabled = this.enabled;
    if (!enabled) {
      this.trace("daemon.computer_checks.refresh", { outcome: "no_config" });
      return;
    }
    try {
      await this.recordOwnConfig();
      const round = await this.obtainRound(enabledIds(enabled), await readOwnerChecksSwitch(this.deps.raftHome));
      // Re-read after the round, for every answer: the owner's switch wins over a shared round.
      const owner = await readOwnerChecksSwitch(this.deps.raftHome);
      const ownerSwitch = await observeOwnerChecksSwitch(this.deps.raftHome, owner, () => this.now());
      // The config may have changed while the round ran: the latest one decides.
      const report = reportForServer(round, this.enabled ?? enabled, owner, ownerSwitch);
      if (!this.enabled) return;
      this.deps.send(report);
      this.trace("daemon.computer_checks.refresh", { outcome: "sent", plugin_count: report.plugins.length });
    } catch {
      // Nothing of the round is logged: it may quote what a check read.
      logger.warn("[computer-checks] a round of checks failed");
      this.trace("daemon.computer_checks.refresh", { outcome: "failed" });
    }
  }

  private async obtainRound(own: readonly ComputerCheckId[], owner: OwnerChecksSwitch): Promise<ComputerChecksReport> {
    const raftHome = this.deps.raftHome;
    // A fresh round that lacks a check this server enabled (and the owner allows) is not enough.
    const fresh = await freshCoveringRound(raftHome, this.now(), own, owner);
    if (fresh) {
      this.trace("daemon.computer_checks.round", { outcome: "shared" });
      return fresh.report;
    }
    const inFlight = roundsInFlight.get(raftHome);
    if (inFlight) {
      this.trace("daemon.computer_checks.round", { outcome: "joined" });
      return inFlight;
    }
    const round = withHardLimit(this.runLockedRound(own, owner), this.deps.roundHardLimitMs ?? CHECK_ROUND_HARD_LIMIT_MS);
    roundsInFlight.set(raftHome, round);
    try {
      return await round;
    } finally {
      if (roundsInFlight.get(raftHome) === round) roundsInFlight.delete(raftHome);
    }
  }

  private async runLockedRound(own: readonly ComputerCheckId[], owner: OwnerChecksSwitch): Promise<ComputerChecksReport> {
    const raftHome = this.deps.raftHome;
    const release = await acquireRoundLock(raftHome, this.deps.lockWaitMs ?? CHECK_ROUND_LOCK_WAIT_MS);
    try {
      // Another runner may have finished a round while this one waited.
      const fresh = await freshCoveringRound(raftHome, this.now(), own, owner);
      if (fresh) {
        this.trace("daemon.computer_checks.round", { outcome: "shared" });
        return fresh.report;
      }
      const startedAtMs = this.now();
      const enabled = await enabledUnion(raftHome, own, startedAtMs);
      // Read again under the lock: the switch as it is when the round runs.
      const ownerNow = await readOwnerChecksSwitch(raftHome);
      const run = this.deps.run ?? runComputerChecks;
      const report = await run(enabled, {
        homeDir: (this.deps.homeDir ?? (() => os.userInfo().homedir))(),
        workDir: checksWorkDir(raftHome),
        parentEnv: this.deps.parentEnv ?? process.env,
        owner: ownerNow,
        now: () => this.now(),
        ...this.deps.runDeps,
      });
      lastRounds.set(raftHome, { startedAtMs, report });
      try {
        await writeJsonAtomic(path.join(raftHome, CHECK_ROUND_FILE), { startedAtMs, report } satisfies RoundRecord);
      } catch {
        logger.warn("[computer-checks] could not keep the round for the other runners");
      }
      this.trace("daemon.computer_checks.round", { outcome: release ? "ran" : "ran_unlocked", plugin_count: report.plugins.length });
      return report;
    } finally {
      await release?.();
    }
  }
}
