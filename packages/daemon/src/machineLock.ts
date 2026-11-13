import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ProcessStartIdentity,
  readProcessStartIdentity,
  readProcessStartIdentitySync,
  readProcessStartTimeMsSync,
  startIdentityReadSpawns,
} from "./drivers/processTree";
import { resolveRaftHomePath } from "./raftHome";
import { PID_REUSE_TOLERANCE_MS, startedAfterRecord } from "@botiverse/raft-shared";

const INCOMPLETE_LOCK_STALE_MS = 30_000;

/**
 * How much later than the lock's `startedAt` the process holding the owner
 * pid may have started and still be taken for the owner. The owner writes
 * `startedAt` after its process starts, so the real owner always started
 * at or before it; the slack only absorbs how the start is measured (Linux
 * derives it from the boot time, `ps lstart` has whole seconds) and small
 * clock adjustments. A process that started later than this reused the pid.
 * The rule and its slack are shared with the Computer's commands
 * (`startedAfterRecord`, packages/shared/src/processStartTime.ts).
 */
export const MACHINE_LOCK_PID_REUSE_TOLERANCE_MS = PID_REUSE_TOLERANCE_MS;

/** How the lock looks at the owner pid; tests replace it instead of using real processes. */
export interface MachineLockProcessProbe {
  isAlive: (pid: number) => boolean;
  /** When the process now holding `pid` started (epoch ms); undefined when unknown. */
  startTimeMs: (pid: number) => number | undefined;
  /**
   * How the OS identifies the start of the process now holding `pid`
   * (readProcessStartIdentitySync); undefined when unknown. Read for the
   * owner pid on a conflict. Absent: never known.
   */
  startIdentity?: (pid: number) => ProcessStartIdentity | undefined;
  /**
   * This daemon's own start identity where reading it spawns nothing
   * (Linux: file reads), taken synchronously with the lock.
   */
  selfStartIdentitySync?: () => ProcessStartIdentity | undefined;
  /**
   * This daemon's own start identity where reading it spawns a process
   * (Windows PowerShell, `ps`): read after the lock is taken, never on the
   * startup path, then added to owner.json. Must not reject.
   */
  selfStartIdentityAsync?: () => Promise<ProcessStartIdentity | undefined>;
}

/** Why a daemon took over a lock another owner left behind. */
export type MachineLockReclaimReason = "owner_dead" | "pid_reused" | "incomplete";

/**
 * The stale lock this daemon took over, for the `daemon.machine_lock.reclaimed`
 * event. `identitySource` says how a reused pid was told apart: the start
 * identity the owner recorded, or its start time against `startedAt`.
 * A lock released cleanly (pid 0) is not a reclaim.
 */
export interface MachineLockReclaim {
  reason: MachineLockReclaimReason;
  platform: NodeJS.Platform;
  identitySource?: "recorded" | "start_time";
}

interface MachineLockOwnerBase {
  pid: number;
  token: string;
  hostname: string;
  startedAt: string;
  serverUrl: string;
  apiKeyFingerprint: string;
  /**
   * Optional, additive (schemaVersion stays 2): the owner's own process
   * start as the OS reports it, so a later daemon can tell it exactly from a
   * process that reused its pid. Absent from locks written by older daemons
   * or when it could not be read.
   */
  processStart?: ProcessStartIdentity;
}

export type DaemonMachineOwnerProvenance =
  | { kind: "legacy_raw_daemon" }
  | {
      kind: "managed_computer_runner";
      serverId: string;
      serverMachineId: string;
    };

type MachineLockOwner = MachineLockOwnerBase & (
  | { schemaVersion: 2; kind: "legacy_raw_daemon" }
  | {
      schemaVersion: 2;
      kind: "managed_computer_runner";
      serverId: string;
      serverMachineId: string;
    }
);

export interface DaemonMachineLockHandle {
  lockId: string;
  machineDir: string;
  lockDir: string;
  /** Set when this acquisition took over a stale lock. */
  reclaimed?: MachineLockReclaim;
  /**
   * Settles once this daemon's start identity is in owner.json (true) or
   * will not be (false: unreadable, or the lock is no longer ours). Never
   * rejects; nothing waits on it but tests.
   */
  processStartRecorded: Promise<boolean>;
  release: () => void;
}

export class DaemonMachineLockConflictError extends Error {
  readonly code = "DAEMON_MACHINE_LOCK_HELD";

  /**
   * Whether the owner pid's start could be read and compared (false: the
   * lock is held only because it could not be; null: not judged).
   */
  readonly ownerStartReadable: boolean | null;

  constructor(lockDir: string, owner: MachineLockOwner | null, ownerStartReadable: boolean | null = null) {
    const startText = ownerStartReadable === null ? "" : `, ownerStart=${ownerStartReadable ? "readable" : "unreadable"}`;
    const ownerText = owner ? `pid=${owner.pid}, startedAt=${owner.startedAt}, host=${owner.hostname}${startText}` : "unknown owner";
    super(
      `Another Slock daemon is already running for this machine key (${ownerText}). ` +
        `Lock: ${lockDir}. Stop the existing daemon first, or use a different machine key/state directory.`,
    );
    this.name = "DaemonMachineLockConflictError";
    this.ownerStartReadable = ownerStartReadable;
  }
}

function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function getDaemonMachineLockId(apiKey: string): string {
  return `machine-${apiKeyFingerprint(apiKey).slice(0, 16)}`;
}

export function resolveDefaultMachineStateRoot(): string {
  return resolveRaftHomePath("machines");
}

function ownerPath(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function readOwner(lockDir: string): MachineLockOwner | null {
  try {
    return JSON.parse(readFileSync(ownerPath(lockDir), "utf8")) as MachineLockOwner;
  } catch {
    return null;
  }
}

function lockAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? (err as { code?: string }).code : undefined;
    return code !== "ESRCH";
  }
}

const defaultProcessProbe: MachineLockProcessProbe = {
  isAlive: isProcessAlive,
  // Linux derives a start time from the current boot time, so a clock stepped
  // forward after boot (no RTC, late NTP) would make a live owner look newer
  // than its lock and hand the lock to a second daemon. On Linux only the
  // recorded start identity (boot id + starttime ticks, no clock involved)
  // can tell a reused pid; Windows and macOS report absolute start times.
  startTimeMs: (pid) => (process.platform === "linux" ? undefined : readProcessStartTimeMsSync(pid)),
  startIdentity: (pid) => readProcessStartIdentitySync(pid),
  // A PowerShell cold start is 0.5-2 s (up to its 5 s timeout), on every
  // runner start: only Linux reads its own identity synchronously.
  selfStartIdentitySync: () => (startIdentityReadSpawns() ? undefined : readProcessStartIdentitySync(process.pid)),
  selfStartIdentityAsync: () => (startIdentityReadSpawns() ? readProcessStartIdentity(process.pid) : Promise.resolve(undefined)),
};

function writeOwnerAtomically(lockDir: string, owner: MachineLockOwner): void {
  const target = ownerPath(lockDir);
  const temp = `${target}.${owner.token}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Add this daemon's start identity to owner.json once read, only while the
 * lock is still this daemon's (its pid and token, as release checks). A
 * conflict reader before then finds no identity and uses the startedAt
 * check. Never throws.
 */
async function recordProcessStartLater(
  lockDir: string,
  token: string,
  read: () => Promise<ProcessStartIdentity | undefined>,
): Promise<boolean> {
  try {
    const processStart = await read();
    if (!processStart) return false;
    const current = readOwner(lockDir);
    if (current?.pid !== process.pid || current.token !== token) return false;
    writeOwnerAtomically(lockDir, { ...current, processStart });
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The owner record's start identity, if it holds a well-formed one. */
function recordedProcessStart(owner: MachineLockOwner): ProcessStartIdentity | undefined {
  const recorded = owner.processStart as Partial<ProcessStartIdentity> | undefined;
  if (!recorded || typeof recorded !== "object") return undefined;
  if (!nonEmptyString(recorded.platform) || !nonEmptyString(recorded.value)) return undefined;
  if (recorded.platform === "linux") {
    const linux = recorded as Partial<Extract<ProcessStartIdentity, { platform: "linux" }>>;
    if (!nonEmptyString(linux.bootId)) return undefined;
    if (linux.pidNamespace !== undefined && !nonEmptyString(linux.pidNamespace)) return undefined;
    if (linux.timeNamespace !== undefined && !nonEmptyString(linux.timeNamespace)) return undefined;
  }
  return recorded as ProcessStartIdentity;
}

/**
 * Whether `current` is the very process `recorded` was taken from: true,
 * false (a different process holds the pid), or undefined (they cannot be
 * compared). Exact: both come from the same OS read.
 */
function sameProcessStart(recorded: ProcessStartIdentity, current: ProcessStartIdentity): boolean | undefined {
  if (recorded.platform !== current.platform) return undefined;
  if (recorded.platform === "linux" && current.platform === "linux") {
    // No process outlives a reboot.
    if (recorded.bootId !== current.bootId) return false;
    // A pid read in another pid namespace (another container sharing this
    // state directory) names a different process space: not comparable.
    if ((recorded.pidNamespace ?? null) !== (current.pidNamespace ?? null)) return undefined;
    // starttime is shifted by the reader's time namespace boot offset
    // (unshare --time, CRIU restore, some LXC): ticks read in another one
    // differ for the same process. Kernels without time namespaces have
    // the link on neither side, and nothing can be shifted.
    if ((recorded.timeNamespace ?? null) !== (current.timeNamespace ?? null)) return undefined;
  }
  return recorded.value === current.value;
}

type OwnerVerdict =
  | { held: true; startReadable: boolean }
  | { held: false; reason: "owner_dead" | "pid_reused"; identitySource?: "recorded" | "start_time" };

/**
 * Whether the owner recorded in the lock still holds it. A live pid is not
 * enough: Windows reuses pids freely, so a daemon that died without
 * releasing would block every later start whenever an unrelated program
 * happens to get its pid. When the owner recorded its process start
 * identity, the process now holding the pid must have exactly that one.
 * Otherwise (a lock from an older daemon), a process that demonstrably
 * started after the owner wrote the lock reused the pid; on Linux that
 * clock-based check is off, so such a lock stays held. Anything that
 * cannot be read keeps the lock held: never reclaim on uncertainty.
 */
function judgeOwner(owner: MachineLockOwner, probe: MachineLockProcessProbe): OwnerVerdict {
  if (!probe.isAlive(owner.pid)) return { held: false, reason: "owner_dead" };
  const recorded = recordedProcessStart(owner);
  if (recorded) {
    const current = probe.startIdentity?.(owner.pid);
    const same = current ? sameProcessStart(recorded, current) : undefined;
    if (same === undefined) return { held: true, startReadable: false };
    return same ? { held: true, startReadable: true } : { held: false, reason: "pid_reused", identitySource: "recorded" };
  }
  const lockStartedAtMs = Date.parse(owner.startedAt);
  if (!Number.isFinite(lockStartedAtMs)) return { held: true, startReadable: false };
  const processStartedAtMs = probe.startTimeMs(owner.pid);
  if (processStartedAtMs === undefined || !Number.isFinite(processStartedAtMs)) return { held: true, startReadable: false };
  return !startedAfterRecord(lockStartedAtMs, processStartedAtMs)
    ? { held: true, startReadable: true }
    : { held: false, reason: "pid_reused", identitySource: "start_time" };
}

export function acquireDaemonMachineLock(options: {
  apiKey: string;
  serverUrl: string;
  rootDir?: string;
  ownerProvenance?: DaemonMachineOwnerProvenance;
  /** Tests only: how the owner pid is checked. */
  processProbe?: MachineLockProcessProbe;
}): DaemonMachineLockHandle {
  const processProbe = options.processProbe ?? defaultProcessProbe;
  const rootDir = options.rootDir ?? resolveDefaultMachineStateRoot();
  const fingerprint = apiKeyFingerprint(options.apiKey);
  const lockId = getDaemonMachineLockId(options.apiKey);
  const machineDir = path.join(rootDir, lockId);
  const lockDir = path.join(machineDir, "daemon.lock");
  const token = randomUUID();
  // Only a read that spawns nothing (Linux) happens here; elsewhere the
  // identity is added after the lock is taken. Unreadable: omitted.
  const processStart = processProbe.selfStartIdentitySync?.();
  let reclaimed: MachineLockReclaim | undefined;

  mkdirSync(machineDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      const owner: MachineLockOwner = {
        pid: process.pid,
        token,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        serverUrl: options.serverUrl,
        apiKeyFingerprint: fingerprint.slice(0, 16),
        ...(processStart ? { processStart } : {}),
        schemaVersion: 2,
        ...(options.ownerProvenance ?? { kind: "legacy_raw_daemon" }),
      };
      try {
        writeFileSync(ownerPath(lockDir), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        rmSync(lockDir, { recursive: true, force: true });
        throw err;
      }
      const readLater = processStart ? undefined : processProbe.selfStartIdentityAsync;
      const processStartRecorded = readLater
        ? recordProcessStartLater(lockDir, token, readLater)
        : Promise.resolve(processStart !== undefined);
      return {
        lockId,
        machineDir,
        lockDir,
        ...(reclaimed ? { reclaimed } : {}),
        processStartRecorded,
        release: () => {
          const currentOwner = readOwner(lockDir);
          if (currentOwner?.pid === process.pid && currentOwner.token === token) {
            // Preserve the machine identity (apiKeyFingerprint) across a
            // clean shutdown instead of deleting it with the lock. The
            // canonical Computer upgrade journey is "legacy daemon
            // running -> Ctrl-C -> run `raft-computer setup`", and
            // removing owner.json here made the stopped daemon invisible
            // to migration discovery (which scans
            // machine-*/daemon.lock/owner.json), silently fresh-attaching
            // a duplicate machine. We relinquish the lock by neutralizing
            // the live-pid claim (pid 0) rather than removing the file: a
            // later acquire sees a dead-pid owner and reclaims
            // immediately, and pid 0 can never collide with a recycled
            // live pid.
            const released: MachineLockOwner = { ...currentOwner, pid: 0 };
            try {
              writeFileSync(ownerPath(lockDir), `${JSON.stringify(released, null, 2)}\n`, {
                mode: 0o600,
              });
            } catch {
              // Best-effort: if the identity rewrite fails, fall back to
              // the previous behavior so we never leave a live-pid lock
              // dangling.
              rmSync(lockDir, { recursive: true, force: true });
            }
          }
        },
      };
    } catch (err) {
      const code = typeof err === "object" && err && "code" in err ? (err as { code?: string }).code : undefined;
      if (code !== "EEXIST") throw err;

      const owner = readOwner(lockDir);
      let reclaim: MachineLockReclaim | undefined;
      if (owner?.pid) {
        const verdict = judgeOwner(owner, processProbe);
        if (verdict.held) throw new DaemonMachineLockConflictError(lockDir, owner, verdict.startReadable);
        reclaim = {
          reason: verdict.reason,
          platform: process.platform,
          ...(verdict.identitySource ? { identitySource: verdict.identitySource } : {}),
        };
      }
      if (!owner) {
        const ageMs = lockAgeMs(lockDir);
        if (ageMs === null || ageMs < INCOMPLETE_LOCK_STALE_MS) {
          throw new DaemonMachineLockConflictError(lockDir, null);
        }
        reclaim = { reason: "incomplete", platform: process.platform };
      }

      // Reading the owner's start time can take seconds (PowerShell, ps). If
      // another daemon reclaimed the same stale lock meanwhile, the lock now
      // holds its fresh owner: removing it would leave two daemons running.
      // Remove only the owner judged above.
      const current = readOwner(lockDir);
      if (owner ? current?.token !== owner.token || current?.pid !== owner.pid : current !== null) {
        throw new DaemonMachineLockConflictError(lockDir, current);
      }
      rmSync(lockDir, { recursive: true, force: true });
      reclaimed = reclaim;
    }
  }

  throw new DaemonMachineLockConflictError(lockDir, readOwner(lockDir));
}
