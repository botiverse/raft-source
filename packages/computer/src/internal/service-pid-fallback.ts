// Shared "find live service pid" helper. Reads `servicePidReadFallback(slockHome)`
// — now the single canonical `run/service.pid`; the legacy multi-layout
// fallback chain (`service.pid` / `supervisor.pid`) was removed since those
// layouts only ever existed on pre-release dev machines (Computer is
// unreleased). Checks liveness inline, clears the pidfile if stale, returns
// the pid when alive. A live pid is not enough: it must not be another
// program that got a dead service's pid (recordedServicePidIsOtherProgram).
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
import { connect } from "node:net";
import { startedAfterRecord } from "@botiverse/raft-shared";
import {
  clearPidfileAt,
  isProcessAlive as defaultIsProcessAlive,
  readPidfileAt as defaultReadPidfileAt,
  readProcessStartTimeMs,
  readProcessStartTimeMsBeforeActing,
} from "./process-primitives";
import { servicePidReadFallback, serviceSocketPath, serviceVersionPath, serviceWindowsPipeName } from "../paths";
import { readProcessVersionEvidence } from "../versionEvidence";

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
  /** Set when a recorded pid is alive but is another program (its pid was
   *  reused): counted as stale, never as the service. */
  otherProgramPid?: number;
}

/** How a live recorded pid is told from the service; tests replace these instead of using real processes. */
export interface ServicePidIdentityDeps {
  /** Whether anything answers on this home's service IPC endpoint (default: a bare connect). */
  endpointAnswers?: (slockHome: string) => Promise<boolean>;
  /**
   * Whether the service answering on that endpoint reports this very pid.
   * Given by a caller that signals the pid (stop): for it, another service
   * answering there is no evidence about the recorded pid.
   */
  endpointReportsPid?: (slockHome: string, pid: number) => Promise<boolean>;
  /** When the process now holding `pid` started (epoch ms); undefined when unknown. */
  processStartTimeMs?: (pid: number) => Promise<number | undefined>;
}

const ENDPOINT_PROBE_TIMEOUT_MS = 1_000;

/** Whether anything listens on this home's service IPC endpoint: only a live service does. */
export function serviceEndpointAnswers(slockHome: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: process.platform === "win32" ? serviceWindowsPipeName(slockHome) : serviceSocketPath(slockHome) });
    const done = (answers: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answers);
    };
    const timer = setTimeout(() => done(false), ENDPOINT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether the live process holding the recorded service pid is another
 * program. A service that ends with its sign-in session (Windows sign-out, a
 * reboot) leaves run/service.pid behind, and the pid goes to an unrelated
 * program: `stop` would signal it and `start` would answer "already running".
 *
 * Cheapest evidence first. Nothing says when this pid's service started (no
 * service-version.json from it): unknown, as before. The service answers on
 * its IPC endpoint (for stop: and reports this pid): it is running, nothing
 * else is read. Otherwise the
 * machine lock's start-time rule: the service wrote that evidence after it
 * started, so a process that started later reused the pid. A start that
 * cannot be read (Linux: follow-up in process-primitives.ts) is not reuse.
 */
export async function recordedServicePidIsOtherProgram(
  slockHome: string,
  pid: number,
  deps: ServicePidIdentityDeps = {},
): Promise<boolean> {
  const evidence = await readProcessVersionEvidence(serviceVersionPath(slockHome));
  const recordedAtMs = evidence?.pid === pid ? Date.parse(evidence.writtenAt) : Number.NaN;
  if (!Number.isFinite(recordedAtMs)) return false;
  const answers = deps.endpointReportsPid
    ? await deps.endpointReportsPid(slockHome, pid)
    : await (deps.endpointAnswers ?? serviceEndpointAnswers)(slockHome);
  if (answers) return false;
  return startedAfterRecord(recordedAtMs, await (deps.processStartTimeMs ?? readProcessStartTimeMs)(pid));
}

export interface FindLiveServicePidDeps extends ServicePidIdentityDeps {
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
  // The callers act on the answer (stop signals, start does not start): a slow start read is waited for.
  return walkFallback(slockHome, readPidfile, isAlive, clearStale, {
    endpointAnswers: deps.endpointAnswers,
    endpointReportsPid: deps.endpointReportsPid,
    processStartTimeMs: deps.processStartTimeMs ?? readProcessStartTimeMsBeforeActing,
  });
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
  return walkFallback(slockHome, readPidfile, isAlive, async () => undefined, deps);
}

async function walkFallback(
  slockHome: string,
  readPidfile: typeof defaultReadPidfileAt,
  isAlive: typeof defaultIsProcessAlive,
  clearStale: (path: string) => Promise<void>,
  identity: ServicePidIdentityDeps,
): Promise<FindLiveServicePidResult> {
  const candidates = servicePidReadFallback(slockHome);
  let firstStalePidfile: string | null = null;
  let firstStalePid: number | null = null;
  let otherProgramPid: number | undefined;
  for (const candidate of candidates) {
    const candidatePid = await readPidfile(candidate);
    if (candidatePid === null) continue;
    if (isAlive(candidatePid)) {
      if (!(await recordedServicePidIsOtherProgram(slockHome, candidatePid, identity))) {
        return { pid: candidatePid, pidfilePath: candidate, firstStalePidfile, firstStalePid };
      }
      // Telling took seconds. A record written meanwhile is a service that
      // just started, not this stale one: it is never unlinked for a pid it
      // no longer names.
      const current = await readPidfile(candidate);
      if (current !== candidatePid) {
        if (current !== null && isAlive(current)) {
          return { pid: current, pidfilePath: candidate, firstStalePidfile, firstStalePid };
        }
        continue;
      }
      otherProgramPid ??= candidatePid;
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
    ...(otherProgramPid !== undefined ? { otherProgramPid } : {}),
  };
}
