// Shared "find live service pid" helper. Reads `servicePidReadFallback(slockHome)`
// — now the single canonical `run/service.pid`; the legacy multi-layout
// fallback chain (`service.pid` / `supervisor.pid`) was removed since those
// layouts only ever existed on pre-release dev machines (Computer is
// unreleased). Checks liveness inline, clears the pidfile if stale, returns
// the pid when alive.
//
// (Kept as a candidate-walk rather than a bare read so the read-write vs
// read-only stale-clear split below stays one code path; the walk simply
// iterates a single candidate today, and the shape extends cheaply if a
// future layout migration reintroduces a chain.)
//
// Two variants:
//   - `findLiveServicePid` (read-write) — clears the pidfile in place if
//     stale so it does not haunt subsequent reads. Used by `stop`,
//     `upgrade`, `start` (call sites with write authority over the pidfile).
//   - `findLiveServicePidReadOnly` — same walk, no cleanup. Used by
//     `status`, which is read-only and secret-free by §3.3.1.
//
// Package-private: lives under `src/internal/` so it is NOT re-exported
// from `@botiverse/raft-computer/lib` (RFC v9 §3 export gate).
import {
  clearPidfileAt,
  isProcessAlive as defaultIsProcessAlive,
  readPidfileAt as defaultReadPidfileAt,
} from "./process-primitives.js";
import { servicePidReadFallback } from "../paths.js";

export interface FindLiveServicePidResult {
  /** First live pid encountered in the fallback walk, or null when the
   *  walk found no live service. */
  pid: number | null;
  /** Pidfile path the live pid was read from. When `pid === null`,
   *  falls back to `candidates[0]` (the current write target) so the
   *  caller has a stable path to render in user-visible output. */
  pidfilePath: string;
  /** First readable-but-dead candidate observed during the walk. Stop
   *  uses this to render its canonical `stale_pidfile_cleared` line on
   *  the "all candidates stale" path; other callers can ignore it. */
  firstStalePidfile: string | null;
  firstStalePid: number | null;
}

export interface FindLiveServicePidDeps {
  readPidfile?: typeof defaultReadPidfileAt;
  isProcessAlive?: typeof defaultIsProcessAlive;
  /** Read-write helper only. Defaults to `clearPidfileAt`. The read-only
   *  variant ignores this entirely (no writes). */
  clearPidfile?: (path: string) => Promise<void>;
}

/**
 * Walk the service-pid fallback chain by liveness. Stale candidates
 * encountered during the walk are cleared in place. Returns the first
 * live pid or `{ pid: null, ... }` when none of the candidates is alive.
 */
export async function findLiveServicePid(
  slockHome: string,
  deps: FindLiveServicePidDeps = {},
): Promise<FindLiveServicePidResult> {
  const readPidfile = deps.readPidfile ?? defaultReadPidfileAt;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const clearStale = deps.clearPidfile ?? clearPidfileAt;
  return walkFallback(slockHome, readPidfile, isAlive, clearStale);
}

/**
 * Read-only fallback walk: same liveness-first selection, but never
 * unlinks a stale candidate. Used by `status` (§3.3.1 read-only +
 * secret-free invariant) so a running legacy service is surfaced
 * without taking write actions.
 */
export async function findLiveServicePidReadOnly(
  slockHome: string,
  deps: Omit<FindLiveServicePidDeps, "clearPidfile"> = {},
): Promise<FindLiveServicePidResult> {
  const readPidfile = deps.readPidfile ?? defaultReadPidfileAt;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  // No-op clear: read-only.
  return walkFallback(slockHome, readPidfile, isAlive, async () => undefined);
}

async function walkFallback(
  slockHome: string,
  readPidfile: typeof defaultReadPidfileAt,
  isAlive: typeof defaultIsProcessAlive,
  clearStale: (path: string) => Promise<void>,
): Promise<FindLiveServicePidResult> {
  const candidates = servicePidReadFallback(slockHome);
  let firstStalePidfile: string | null = null;
  let firstStalePid: number | null = null;
  for (const candidate of candidates) {
    const candidatePid = await readPidfile(candidate);
    if (candidatePid === null) continue;
    if (isAlive(candidatePid)) {
      return {
        pid: candidatePid,
        pidfilePath: candidate,
        firstStalePidfile,
        firstStalePid,
      };
    }
    await clearStale(candidate);
    if (firstStalePidfile === null) {
      firstStalePidfile = candidate;
      firstStalePid = candidatePid;
    }
  }
  return {
    pid: null,
    pidfilePath: candidates[0]!,
    firstStalePidfile,
    firstStalePid,
  };
}
