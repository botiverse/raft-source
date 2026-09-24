// Computer-side residue cleanup (RFC v0.8 contract v6 §3.1 / PR-H).
//
// Five categories, each a pure function returning a structured report:
//   1. Stale pidfile — pidfile exists but pid is dead
//   2. Orphan child process — process running but no managed.flag + attachment
//   3. Power-loss partial state — file present but contents invalid / inconsistent
//   4. Tmp file cleanup — upgrade-staging/ or upgrade-snapshot.json older than 24h
//   5. Stale .lock — proper-lockfile residue from crashed CLI/service
//
// Used by:
//   - Service startup recovery pass (silent self-heal, breadcrumbs to stderr)
//   - `raft-computer doctor [--cleanup]` (user-facing report + interactive consent)
//
// Production-grade invariant: every cleanup action emits a structured log
// line; no silent state mutation.

import lockfile from "proper-lockfile";
import { readdir, stat, unlink, rm, rmdir, rename, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  computerDir,
  servicePidPath,
  serverRunnerPidPath,
  serversDir,
  isValidServerId,
} from "./paths.js";
import {
  listAttachedServerIds,
  listManagedServerIds,
  readServerAttachment,
} from "./serverState.js";
import { readPidfileAt, isProcessAlive } from "./internal/process-primitives.js";

export interface CleanupReport {
  stalePidfiles: string[];      // absolute paths cleaned
  orphanProcesses: number[];    // pids signaled (SIGTERM)
  powerLossRecovered: string[]; // serverIds whose partial state was repaired
  tmpFilesCleared: string[];    // absolute paths removed
  staleLocks: string[];         // absolute paths ownership-safely reclaimed
  /** Was any cleanup actually performed? false = clean baseline. */
  anyAction: boolean;
}

export function emptyCleanupReport(): CleanupReport {
  return {
    stalePidfiles: [],
    orphanProcesses: [],
    powerLossRecovered: [],
    tmpFilesCleared: [],
    staleLocks: [],
    anyAction: false,
  };
}

// ---------- category 1: stale pidfile ----------

/** Check one pidfile path; if its pid is dead, unlink it. Returns true iff acted. */
export async function cleanupStalePidfile(
  pidfilePath: string,
): Promise<boolean> {
  const pid = await readPidfileAt(pidfilePath);
  if (pid === null) return false;
  if (isProcessAlive(pid)) return false;
  try {
    await unlink(pidfilePath);
    return true;
  } catch {
    return false;
  }
}

/** Walk all known pidfile locations (service + per-server) and clean stale ones. */
export async function cleanupAllStalePidfiles(slockHome: string): Promise<string[]> {
  const cleaned: string[] = [];
  // Service
  if (await cleanupStalePidfile(servicePidPath(slockHome))) {
    cleaned.push(servicePidPath(slockHome));
  }
  // Per-server
  const attached = await listAttachedServerIds(slockHome);
  for (const sid of attached) {
    const p = serverRunnerPidPath(slockHome, sid);
    if (await cleanupStalePidfile(p)) cleaned.push(p);
  }
  return cleaned;
}

// ---------- category 2: orphan child process ----------

interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
}

/**
 * Run `ps -o pid,ppid,comm -A` and parse to row list. Best-effort: on
 * any failure (spawn error, non-zero exit, parse error) returns [].
 *
 * Test-injectable via the `psSpawn` callback parameter for deterministic
 * mock output.
 */
async function readPsTable(
  psSpawn: () => Promise<{ stdout: string; exitCode: number }> = defaultPsSpawn,
): Promise<PsRow[]> {
  try {
    const { stdout, exitCode } = await psSpawn();
    if (exitCode !== 0) return [];
    const rows: PsRow[] = [];
    const lines = stdout.split("\n");
    // First line is header (PID PPID COMM); skip.
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const comm = parts.slice(2).join(" ");
      rows.push({ pid, ppid, comm });
    }
    return rows;
  } catch {
    return [];
  }
}

function defaultPsSpawn(): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "pid,ppid,comm", "-A"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve({ stdout: "", exitCode: 1 }));
    child.on("close", (code) => resolve({ stdout: out, exitCode: code ?? 1 }));
  });
}

/**
 * Find child processes running under SLOCK_HOME that are NOT in the
 * managed-and-attached set. Walks `ps -o pid,ppid,comm -A`, finds rows
 * whose ppid matches the service pid AND whose comm starts with
 * `slock-` (filter to our process family), then excludes rows already
 * accounted for by pidfile-tracked managed pids. The remainder are
 * orphans → SIGTERM them.
 *
 * Skips on Windows (no portable ps surface for v1) — returns []. Per
 * RFC v0.1 §3.1 #2 contract: Windows fallback is best-effort no-op,
 * not an error.
 *
 * Returns the list of pids actually SIGTERMed.
 */
export async function cleanupOrphanProcesses(
  slockHome: string,
  psSpawn?: () => Promise<{ stdout: string; exitCode: number }>,
): Promise<number[]> {
  if (process.platform === "win32") return []; // ps walk not portable on Windows v1
  const managed = new Set(await listManagedServerIds(slockHome));
  const signaled: number[] = [];

  // Read all known server-runner.pid contents → set of managed pids
  const knownPids = new Set<number>();
  const supPid = await readPidfileAt(servicePidPath(slockHome));
  if (supPid !== null) knownPids.add(supPid);
  for (const sid of managed) {
    const pid = await readPidfileAt(serverRunnerPidPath(slockHome, sid));
    if (pid !== null) knownPids.add(pid);
  }

  // No service running → no orphan-detection baseline; nothing to do.
  // (Future: when adopting a stricter "any slock-named process not in
  // knownPids is orphan" policy, drop this guard. For v1 we anchor on
  // the service as the canonical parent.)
  if (supPid === null) return signaled;

  const psRows = await readPsTable(psSpawn);
  for (const row of psRows) {
    // Only consider direct children of the running service. Multi-level
    // descendant detection is deferred — v1 keeps semantics simple: the
    // service restarts its direct children every reconcile tick, so
    // direct-child orphans are the realistic recovery target.
    if (row.ppid !== supPid) continue;
    // Filter to our process family (raft-computer, slock-daemon, etc.).
    if (!row.comm.startsWith("slock-")) continue;
    if (knownPids.has(row.pid)) continue;

    // Orphan — SIGTERM. Best-effort: kill() throws if the process died
    // between ps scan and signal; we accept that and don't count it.
    try {
      process.kill(row.pid, "SIGTERM");
      signaled.push(row.pid);
    } catch {
      /* race with process exit; ignore */
    }
  }

  return signaled;
}

// ---------- category 3: power-loss partial state ----------

function quarantineDir(slockHome: string): string {
  return join(computerDir(slockHome), ".quarantine");
}

/**
 * Move a per-server subdir into `~/.slock/computer/.quarantine/<timestamp>/`
 * for forensic recovery. Never deletes — per v6 contract §10 "Invalid-by-
 * schema state must be quarantined, not silently deleted". Returns the
 * absolute quarantine destination path.
 *
 * @liuliu PR-H commit 1/n NIT 1 (msg=12f93b88) — was "only report" in
 * commit 1; this commit fulfills the v6 §10 quarantine contract.
 */
async function quarantineServerSubtree(
  slockHome: string,
  serverId: string,
): Promise<string> {
  const src = join(serversDir(slockHome), serverId);
  // Use ISO-like timestamp with `:` → `-` to keep it filesystem-safe on
  // Windows. The directory name doubles as the recovery hint surface.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(quarantineDir(slockHome), `${stamp}-${serverId}`);
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
  return dest;
}

function dirname(p: string): string {
  // Avoid an extra import; node:path's dirname is required upstream.
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "/";
}

/**
 * Walk all servers/<id>/ directories and validate state.
 * Repairs:
 *   - runner.state.json missing/corrupt → quarantine the whole serverDir
 *     into `.quarantine/<timestamp>-<serverId>/`. Per v6 §10: forensic
 *     recoverable, never silently deleted.
 *   - server-runner.pid points to dead pid → unlink (covered by category 1 too)
 *
 * Returns list of serverIds whose state was repaired (now correspond to
 * actually-moved subtrees, not just "would have been moved").
 */
export async function cleanupPowerLossPartialState(slockHome: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(serversDir(slockHome));
  } catch {
    return [];
  }
  const repaired: string[] = [];
  for (const name of entries) {
    if (!isValidServerId(name)) continue;
    const attachment = await readServerAttachment(slockHome, name);
    if (!attachment) {
      // runner.state.json missing or corrupt — move the whole serverId
      // subdir to `.quarantine/<timestamp>-<serverId>/`. Best-effort:
      // failures (rename across filesystems, permissions) emit a stderr
      // breadcrumb but do not abort the cleanup pass.
      try {
        await quarantineServerSubtree(slockHome, name);
        repaired.push(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `Warning: failed to quarantine partial state for server ${name}: ${msg}. ` +
            `Subtree left in place; rerun \`raft-computer doctor --fix\` after resolving.\n`,
        );
      }
    }
  }
  return repaired;
}

// ---------- category 4: tmp file cleanup ----------

const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Clear upgrade-staging/* dirs and upgrade-snapshot.json older than 24h.
 * Returns absolute paths removed.
 */
export async function cleanupTmpFiles(slockHome: string): Promise<string[]> {
  const removed: string[] = [];
  const cdir = computerDir(slockHome);

  // upgrade-staging/<version>/
  const stagingDir = join(cdir, "upgrade-staging");
  try {
    const versions = await readdir(stagingDir);
    for (const v of versions) {
      const vdir = join(stagingDir, v);
      try {
        const s = await stat(vdir);
        if (Date.now() - s.mtimeMs > TMP_MAX_AGE_MS) {
          await rm(vdir, { recursive: true, force: true });
          removed.push(vdir);
        }
      } catch {
        /* ignore */
      }
    }
    // If staging dir is now empty, remove it.
    try {
      const remaining = await readdir(stagingDir);
      if (remaining.length === 0) await rmdir(stagingDir);
    } catch {
      /* ignore */
    }
  } catch {
    /* no staging dir = nothing to do */
  }

  // upgrade-snapshot.json
  const snap = join(cdir, "upgrade-snapshot.json");
  try {
    const s = await stat(snap);
    if (Date.now() - s.mtimeMs > TMP_MAX_AGE_MS) {
      await unlink(snap);
      removed.push(snap);
    }
  } catch {
    /* not present = nothing to do */
  }

  return removed;
}

// ---------- category 5: stale .lock ----------

/**
 * Age-conditional stale-lock cleanup. Conservative threshold (60s) for
 * callers that can't safely assume the lock holder is gone (e.g. doctor
 * --fix running while another CLI is mid-mutate elsewhere).
 *
 * Every caller uses this ownership-aware reclaim. A starting service is not
 * proof that no CLI mutator is mid-flight: OS supervisors start out of
 * process and cannot inherit the caller's env marker.
 *
 * Lowered from 5min → 60s per @liuliu Note (msg=12f93b88): the 5s CLI
 * acquire timeout vs 5min cleanup threshold gap meant repeated CLI
 * failures before doctor --fix would help. 60s is still safely
 * past the largest realistic mid-mutate window (network roundtrip +
 * argon2 verify ≪ 60s).
 */
export async function cleanupStaleLock(slockHome: string): Promise<string[]> {
  const lockTarget = computerDir(slockHome);
  const lockDir = join(computerDir(slockHome), ".lock");
  try {
    const s = await stat(lockDir);
    if (Date.now() - s.mtimeMs > 60 * 1000) {
      // Never rm another process's mutex directly. Re-enter through the same
      // proper-lockfile protocol: it atomically rechecks staleness, acquires
      // ownership, and only then lets this process release the directory.
      // If a live owner refreshed between stat() and lock(), acquisition
      // returns ELOCKED and cleanup becomes a no-op.
      let compromised = false;
      const release = await lockfile.lock(lockTarget, {
        lockfilePath: lockDir,
        stale: 60_000,
        retries: 0,
        realpath: false,
        onCompromised: () => {
          compromised = true;
        },
      });
      try {
        await release();
        return compromised ? [] : [lockDir];
      } catch {
        return [];
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCKED") return [];
    /* no lock = nothing to do */
  }
  return [];
}

// ---------- orchestrator: full cleanup pass ----------

/**
 * Run all 5 cleanup categories. Used by:
 *   - Service startup recovery pass (silent self-heal)
 *   - `raft-computer doctor --fix` (user-facing report)
 *
 * Production-grade invariant: every cleanup action contributes to the
 * structured report; callers decide whether to print breadcrumbs (silent
 * recovery) or full report (doctor surface).
 *
 * `skipLockCleanup`: when true, the entire `.lock` cleanup category is
 * skipped — no age-gated reclaim is attempted. The caller is asserting
 * that a parent process holds the mutation lock legitimately (e.g.
 * service spawned by a CLI under `withMutationLock`). Without this
 * skip, a long-running upgrade (>60s) would let stale reclaim compete for
 * the parent's still-valid lock, opening a serialization hole. See Dayu
 * blocker (#wg-raft-computer:b43b36fb msg=29336624).
 */
export async function runFullCleanup(
  slockHome: string,
  options: { skipLockCleanup?: boolean } = {},
): Promise<CleanupReport> {
  const r = emptyCleanupReport();
  r.stalePidfiles = await cleanupAllStalePidfiles(slockHome);
  r.orphanProcesses = await cleanupOrphanProcesses(slockHome);
  r.powerLossRecovered = await cleanupPowerLossPartialState(slockHome);
  r.tmpFilesCleared = await cleanupTmpFiles(slockHome);
  if (!options.skipLockCleanup) {
    r.staleLocks = await cleanupStaleLock(slockHome);
  }
  r.anyAction =
    r.stalePidfiles.length > 0 ||
    r.orphanProcesses.length > 0 ||
    r.powerLossRecovered.length > 0 ||
    r.tmpFilesCleared.length > 0 ||
    r.staleLocks.length > 0;
  return r;
}
