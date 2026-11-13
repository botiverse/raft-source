import { readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { startedAfterRecord } from "@botiverse/raft-shared";
import { clearPidfileAt, isProcessAlive, readPidfileAt, readProcessStartTimeMs, writePidfileAt } from "./internal/process-primitives";
import {
  adoptExternalRunnerPid,
  RUNNER_TRIGGER,
  type RunnerRecord,
} from "./lib/runnerStateMachine";
import type { RunnerState } from "./lib/state";
import {
  serverConnectedMarkerPath,
  serverRunnerLockConflictPath,
  serverRunnerLockConflictReportPath,
  serverRunnerLogPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
} from "./paths";
import { readResidentConnectedMarker } from "./residentConnectionMarker";
import { listAttachedServerIds } from "./serverState";
import { readProcessVersionEvidence } from "./versionEvidence";

/**
 * A machine-lock conflict the service resolved without a runner of its own:
 * it deferred to the live lock owner (`ownerPid`) or could not name one
 * (`ownerPid: null`, the runner parked as degraded). Bound to the service that
 * wrote it, so a later service never reads an earlier one's conflict. Cleared
 * when the service spawns the runner again.
 */
export interface RunnerLockConflictMarker {
  readonly servicePid: number;
  readonly ownerPid: number | null;
  readonly lockPath: string | null;
  readonly recordedAt: number;
}

function positivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readRunnerLockConflictMarker(markerPath: string): RunnerLockConflictMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<RunnerLockConflictMarker>;
    const { servicePid, ownerPid, lockPath, recordedAt } = parsed;
    if (!positivePid(servicePid)) return null;
    if (ownerPid !== null && !positivePid(ownerPid)) return null;
    if (lockPath !== null && typeof lockPath !== "string") return null;
    if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt)) return null;
    return { servicePid, ownerPid, lockPath, recordedAt };
  } catch {
    return null;
  }
}

export async function writeRunnerLockConflictMarker(markerPath: string, marker: RunnerLockConflictMarker): Promise<void> {
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
}

export async function clearRunnerLockConflictMarker(markerPath: string): Promise<void> {
  await rm(markerPath, { force: true });
}

/** The command that shows what a pid is: on Windows it can belong to an unrelated program by now. */
export function lockOwnerCheckCommand(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `\`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Format-List ProcessId,Name,CreationDate,ExecutablePath\``
    : `\`ps -o pid,lstart,command -p ${pid}\``;
}

/** What a stop says about the lock owner it left alone. */
export function describeLockHolderNotStopped(pid: number, platform: NodeJS.Platform = process.platform): string {
  return (
    `Not stopped: pid ${pid} holds this machine's daemon lock and was not started by this Computer service, so it was not signalled. ` +
    `Check whether pid ${pid} is really a Raft daemon with ${lockOwnerCheckCommand(pid, platform)}. If it is, stop that daemon yourself.`
  );
}

/**
 * Who a lock owner the service deferred to is, by its own evidence. For
 * display and messages only: no value of it lets anything signal, wait for or
 * kill that process.
 *
 *  - "own-runner": runner-version.json names its pid, its start was read and
 *    is not later than that evidence. The runner an earlier service left.
 *  - "another-program": its start was read and is later than that evidence.
 *    The pid was reused.
 *  - "unread": runner-version.json names its pid but its start could not be
 *    read (always on Linux, a timeout elsewhere). Shown as before the start
 *    was ever read: an unreadable start changes nothing.
 *  - "unknown": no runner-version.json names its pid.
 */
export type DeferredOwnerIdentity = "own-runner" | "another-program" | "unread" | "unknown";

/** The lock owner the service deferred to for a server instead of running a runner. */
export interface DeferredLockOwner {
  pid: number;
  identity: DeferredOwnerIdentity;
  /** Its own connected marker names it: a separate question from who it is. */
  connected: boolean;
}

/**
 * The one answer to "who is the lock owner the service deferred to", for
 * status and doctor (what to show) and stop and detach (what to say). It never
 * authorises a signal: the service leaves every such owner alone.
 *
 * There is one while the conflict record's owner is alive and still the pid in
 * runner.pid: a record an earlier service left behind, whose pid is any
 * process by now, names nobody. Who it is is judged here, every time, from
 * runner-version.json and the owner's start. Nothing about it is kept in the
 * record: a record outlives its service (a power loss), and its pid can be
 * another program's by the next read.
 */
export async function deferredLockOwner(
  slockHome: string,
  serverId: string,
  deps: {
    isAlive?: (pid: number) => boolean;
    processStartTimeMs?: (pid: number) => Promise<number | undefined>;
  } = {},
): Promise<DeferredLockOwner | null> {
  const pid = readRunnerLockConflictMarker(serverRunnerLockConflictPath(slockHome, serverId))?.ownerPid ?? null;
  if (pid === null || !(deps.isAlive ?? isProcessAlive)(pid)) return null;
  if ((await readPidfileAt(serverRunnerPidPath(slockHome, serverId))) !== pid) return null;
  const connected = readResidentConnectedMarker(serverConnectedMarkerPath(slockHome, serverId))?.pid === pid;
  const evidence = await readProcessVersionEvidence(serverRunnerVersionPath(slockHome, serverId));
  if (evidence?.pid !== pid) return { pid, identity: "unknown", connected };
  const recordedAtMs = Date.parse(evidence.writtenAt);
  const startedAtMs = await (deps.processStartTimeMs ?? readProcessStartTimeMs)(pid);
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs) || !Number.isFinite(recordedAtMs)) {
    return { pid, identity: "unread", connected };
  }
  return { pid, identity: startedAfterRecord(recordedAtMs, startedAtMs) ? "another-program" : "own-runner", connected };
}

/** What a stop or a detach says about a deferred-to lock owner it left running. */
export function describeDeferredOwnerNotStopped(
  owner: Pick<DeferredLockOwner, "pid" | "identity">,
  platform: NodeJS.Platform = process.platform,
): string {
  switch (owner.identity) {
    case "own-runner":
      return (
        `this server's runner (pid ${owner.pid}), started by an earlier Computer service, is still running and was not stopped. ` +
        `Check it with ${lockOwnerCheckCommand(owner.pid, platform)}; ending that process stops it.`
      );
    // True of all three: nothing says what an unread or unknown pid is.
    case "another-program":
    case "unread":
    case "unknown":
      return describeLockHolderNotStopped(owner.pid, platform);
  }
}

/**
 * The server left the managed set (detach, sign-out) while its runner slot
 * holds the lock owner the service deferred to. The service signals only
 * processes it started: that pid came from a lock file and may be an
 * unrelated program by now (a SIGTERM ends it outright on Windows). Forget
 * it instead: the record, and the runner.pid and conflict marker this service
 * wrote for it.
 */
export async function releaseDeferredLockOwner({
  slockHome,
  rec,
  emitTransition,
  writeStderr,
}: {
  slockHome: string;
  rec: RunnerRecord;
  emitTransition: HandleRunnerLockConflictOptions["emitTransition"];
  writeStderr: (text: string) => void;
}): Promise<void> {
  const pid = rec.externalPid;
  if (pid === undefined) return;
  const prev = rec.lifecycle;
  rec.externalPid = undefined;
  rec.lifecycle = "stopped";
  rec.backoffUntil = undefined;
  await clearPidfileAt(serverRunnerPidPath(slockHome, rec.serverId));
  await clearRunnerLockConflictMarker(serverRunnerLockConflictPath(slockHome, rec.serverId)).catch(() => undefined);
  emitTransition(rec.serverId, prev, "stopped", RUNNER_TRIGGER.operatorStop);
  writeStderr(`Service: server ${rec.serverId} is no longer managed. ${describeLockHolderNotStopped(pid)}\n`);
}

/** How old the owner's lock was when the conflict was met, in coarse days. */
export type LockAgeDaysBucket = "lt_1" | "1_to_7" | "7_to_30" | "gt_30" | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;

export function lockAgeDaysBucket(ownerStartedAt: string | null, recordedAt: number): LockAgeDaysBucket {
  const startedAtMs = ownerStartedAt ? Date.parse(ownerStartedAt) : Number.NaN;
  const ageMs = recordedAt - startedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs < DAY_MS) return "lt_1";
  if (ageMs < 7 * DAY_MS) return "1_to_7";
  if (ageMs < 30 * DAY_MS) return "7_to_30";
  return "gt_30";
}

/**
 * A conflict waiting to be relayed as `daemon.machine_lock.conflict`. Coarse
 * facts only: whether the daemon could read the owner pid's start (null: its
 * error did not say) and the lock's age bucket.
 */
export interface RunnerLockConflictReport {
  readonly ownerStartReadable: boolean | null;
  readonly lockAgeDays: LockAgeDaysBucket;
}

const LOCK_AGE_BUCKETS: readonly LockAgeDaysBucket[] = ["lt_1", "1_to_7", "7_to_30", "gt_30", "unknown"];

async function claimReport(reportPath: string): Promise<RunnerLockConflictReport | null> {
  // The rename is the claim: of every runner flushing at once, one gets it.
  const claimed = `${reportPath}.${process.pid}.${Date.now()}.claimed`;
  try {
    await rename(reportPath, claimed);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(claimed, "utf8")) as Partial<RunnerLockConflictReport> | null;
    if (!parsed || !LOCK_AGE_BUCKETS.includes(parsed.lockAgeDays as LockAgeDaysBucket)) return null;
    return {
      ownerStartReadable: typeof parsed.ownerStartReadable === "boolean" ? parsed.ownerStartReadable : null,
      lockAgeDays: parsed.lockAgeDays as LockAgeDaysBucket,
    };
  } catch {
    return null;
  } finally {
    await rm(claimed, { force: true }).catch(() => undefined);
  }
}

/**
 * The lock conflicts of this Computer's servers not yet relayed, each
 * claimed: once returned, no other runner gets it. A runner whose own lock
 * conflicted exits at once, so another runner of the Computer (or this one,
 * once it gets through) relays it.
 */
export async function claimRunnerLockConflictReports(slockHome: string): Promise<RunnerLockConflictReport[]> {
  const reports: RunnerLockConflictReport[] = [];
  for (const serverId of await listAttachedServerIds(slockHome).catch(() => [])) {
    const report = await claimReport(serverRunnerLockConflictReportPath(slockHome, serverId));
    if (report) reports.push(report);
  }
  return reports;
}

async function recordConflict(
  slockHome: string,
  serverId: string,
  marker: RunnerLockConflictMarker | null,
  report?: RunnerLockConflictReport,
): Promise<void> {
  const markerPath = serverRunnerLockConflictPath(slockHome, serverId);
  try {
    if (marker) await writeRunnerLockConflictMarker(markerPath, marker);
    else await clearRunnerLockConflictMarker(markerPath);
  } catch {
    // Best-effort: `start` then reports the plain timeout, as before.
  }
  if (!report) return;
  try {
    // A newer conflict replaces one not relayed yet: at most one per server.
    // Written whole, then renamed into place, so a runner claiming it never
    // reads half a file (Tenny's review of #14393).
    const reportPath = serverRunnerLockConflictReportPath(slockHome, serverId);
    const tempPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(report), { mode: 0o600 });
      await rename(tempPath, reportPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch {
    // Telemetry only.
  }
}

export interface HandleRunnerLockConflictOptions {
  slockHome: string;
  serverId: string;
  rec: RunnerRecord;
  ownerPid: number | null;
  /** The lock directory the daemon named in its conflict error, when it did. */
  lockPath?: string | null;
  /** The owner's `startedAt` from the daemon's conflict error, when it named one. */
  ownerStartedAt?: string | null;
  /** Whether the daemon could read the owner pid's start (`ownerStart=`); null when it did not say. */
  ownerStartReadable?: boolean | null;
  /** The service resolving the conflict (default: this process). */
  servicePid?: number;
  isOwnerProcessAlive: (pid: number) => boolean;
  emitTransition: (
    serverId: string,
    from: RunnerState,
    to: RunnerState,
    trigger: string,
  ) => void;
  scheduleReconcile: (delayMs: number) => void;
  writeStderr: (text: string) => void;
  nowMs: () => number;
  retryDelayMs: number;
}

/** Resolve a daemon machine-lock loser without charging the crash budget. */
export async function handleRunnerLockConflict({
  slockHome,
  serverId,
  rec,
  ownerPid,
  lockPath = null,
  ownerStartedAt = null,
  ownerStartReadable = null,
  servicePid = process.pid,
  isOwnerProcessAlive,
  emitTransition,
  scheduleReconcile,
  writeStderr,
  nowMs,
  retryDelayMs,
}: HandleRunnerLockConflictOptions): Promise<void> {
  const prev = rec.lifecycle;
  const recordedAt = nowMs();
  const report: RunnerLockConflictReport = {
    ownerStartReadable,
    lockAgeDays: lockAgeDaysBucket(ownerStartedAt, recordedAt),
  };
  if (ownerPid !== null && isOwnerProcessAlive(ownerPid)) {
    adoptExternalRunnerPid(rec, ownerPid);
    await writePidfileAt(serverRunnerPidPath(slockHome, serverId), ownerPid);
    await recordConflict(slockHome, serverId, { servicePid, ownerPid, lockPath, recordedAt }, report);
    emitTransition(serverId, prev, "running", RUNNER_TRIGGER.exitAlreadyRunning);
    writeStderr(
      `Service: server ${serverId} found live daemon already holding the machine lock ` +
        `(pid ${ownerPid}); adopting/deferring to it instead of retrying.\n`,
    );
    return;
  }
  if (ownerPid !== null) {
    // Never delete daemon.lock from the Computer supervisor. Ownership can
    // change after this liveness read, so only the daemon's canonical lock
    // acquisition path may prove/reclaim the lock during the retry.
    await recordConflict(slockHome, serverId, null);
    rec.lifecycle = "stopped";
    rec.backoffUntil = recordedAt + retryDelayMs;
    emitTransition(serverId, prev, "stopped", RUNNER_TRIGGER.exitLockOwnerGone);
    scheduleReconcile(retryDelayMs);
    writeStderr(
      `Service: server ${serverId} lost the daemon machine-lock race to pid ${ownerPid}, ` +
        "but that owner exited during handoff; retrying once through the normal reconciler.\n",
    );
    return;
  }
  await recordConflict(slockHome, serverId, { servicePid, ownerPid: null, lockPath, recordedAt }, report);
  rec.lifecycle = "degraded";
  rec.backoffUntil = undefined;
  emitTransition(serverId, prev, "degraded", RUNNER_TRIGGER.exitAlreadyRunning);
  writeStderr(
    `Service: server ${serverId} hit daemon machine-lock conflict but could not verify a live owner; ` +
      `marked degraded and NOT auto-restarting. See ${serverRunnerLogPath(slockHome, serverId)}.\n`,
  );
}
