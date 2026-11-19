import { currentTimeMs } from "@botiverse/raft-shared";
import type { MachineFacts, RunnerMachineFacts } from "./machineFacts";

/**
 * How long a spawned runner that never connected must have stayed alive
 * before it counts as `runner-disconnected` rather than `runner-absent`.
 * The runner attests its version as soon as it holds the machine lock, before
 * connecting, so a runner that crashes on the handshake (or any time after
 * the lock) looks attested and alive for a moment, and the service respawns
 * it after 2 s (service.ts CHILD_RESTART_BACKOFF_MS): a crash loop always
 * has a fresh spawn alive. 10 s is five backoffs: a runner crashing within
 * seconds of its spawn never gets that old, while one that is only kept off
 * an unreachable server keeps reconnecting and passes it well inside the
 * start wait (15 s default, 30 s under the installer), whose partial-ready
 * decision is read at the end of the wait.
 */
export const SPAWNED_RUNNER_MIN_ALIVE_MS = 10_000;

export type MachineReadinessReasonCode =
  | "runner-not-managed"
  | "runner-absent"
  | "runner-unattested"
  | "runner-version-mismatch"
  | "runner-disconnected"
  | "runner-lock-conflict";

export type MachineReadinessReason =
  | { readonly code: "runner-not-managed"; readonly serverId: string }
  | { readonly code: "runner-absent"; readonly serverId: string }
  | { readonly code: "runner-unattested"; readonly serverId: string; readonly pid: number }
  | {
      readonly code: "runner-version-mismatch";
      readonly serverId: string;
      readonly pid: number;
      readonly expectedVersion: string;
      readonly actualVersion: string;
    }
  | { readonly code: "runner-disconnected"; readonly serverId: string; readonly pid: number }
  /**
   * The runner exited on the daemon machine lock and the service deferred to
   * the lock's owner (`ownerPid`, which never attested as this server's
   * runner) or could not name one (`ownerPid: null`). It will not become
   * ready on its own.
   */
  | {
      readonly code: "runner-lock-conflict";
      readonly serverId: string;
      readonly ownerPid: number | null;
      readonly lockPath: string | null;
    };

export interface MachineReadinessRequirement {
  readonly targetServerIds: readonly string[];
  readonly expectedVersion: string;
  /**
   * The live service whose lock-conflict records count. Unset: none do (a
   * record is only current for the service that wrote it). Also the service
   * whose spawn records count; unset, any service's does (its pid is still
   * bound to the runner's own version evidence, see spawnedRunnerReadiness).
   */
  readonly servicePid?: number;
  /** When the verdict is read (epoch ms), for the spawned runner's age. Default: now. */
  readonly nowMs?: number;
}

export interface MachineReadinessVerdict {
  readonly ready: boolean;
  /** Current ready subset, used by start timeout/abort reporting. */
  readonly runnerPids: ReadonlyMap<string, number>;
  readonly reasons: readonly MachineReadinessReason[];
}

/**
 * What a start's readiness wait saw, as counts and closed-set codes only (no
 * server ids, paths or error text), so it can leave the machine in the upgrade
 * trace (remoteUpgradeTrace.ts `start_command`). Lives here, below both the
 * start service and the trace, so neither imports the other.
 */
export interface StartReadinessReport {
  /** Runners this start waited for (unlinked attachments excluded). */
  targets: number;
  ready: number;
  /** Runners not ready at the wait's last read, counted by reason: the read a failed start times out on. */
  notReady: Partial<Record<MachineReadinessReasonCode, number>>;
  /**
   * The start succeeded with some runners not ready (`acceptPartialReady`).
   * Decided on a read just after the wait's last, so a runner changing state
   * in between can make it disagree with `notReady`.
   */
  partial: boolean;
  /** Attachments skipped because the server unlinked them. */
  unlinked: number;
  waitedMs: number;
}

type RunnerReadiness = MachineReadinessReason | { readonly pid: number };

/**
 * A runner with no live `runner.pid` (the service writes it only once the
 * runner has connected) that the service spawned and that is still alive.
 * It counts as a runner only when the runner's own version evidence names the
 * spawned pid: the runner writes that evidence once it holds the machine lock,
 * right after it starts connecting and before any connection exists, so a
 * child that lost the lock, has not got that far, or a pid reused by another
 * program stays `runner-absent`, and so does one younger than
 * SPAWNED_RUNNER_MIN_ALIVE_MS (a crash loop's latest spawn). Never ready: readiness from a spawn record
 * stops at `runner-disconnected`, and the service's own `runner.pid` is what
 * says connected.
 */
function spawnedRunnerReadiness(
  runner: RunnerMachineFacts | undefined,
  serverId: string,
  expectedVersion: string,
  servicePid: number | undefined,
  nowMs: number,
): MachineReadinessReason | null {
  const spawned = runner?.spawned;
  if (!spawned || !spawned.alive) return null;
  if (nowMs - spawned.spawnedAt < SPAWNED_RUNNER_MIN_ALIVE_MS) return null;
  if (servicePid !== undefined && spawned.servicePid !== servicePid) return null;
  const evidence = runner.versionEvidence;
  if (!evidence || evidence.pid !== spawned.pid || evidence.version === null || evidence.installRoot.length === 0) {
    return null;
  }
  if (evidence.version !== expectedVersion) {
    return {
      code: "runner-version-mismatch",
      serverId,
      pid: spawned.pid,
      expectedVersion,
      actualVersion: evidence.version,
    };
  }
  return { code: "runner-disconnected", serverId, pid: spawned.pid };
}

function runnerReadiness(
  runner: RunnerMachineFacts | undefined,
  serverId: string,
  expectedVersion: string,
  servicePid: number | undefined,
  nowMs: number,
): RunnerReadiness {
  const conflict =
    servicePid !== undefined && runner?.lockConflict?.servicePid === servicePid ? runner.lockConflict : null;
  const lockConflict = (): RunnerReadiness => ({
    code: "runner-lock-conflict",
    serverId,
    ownerPid: conflict?.ownerPid ?? null,
    lockPath: conflict?.lockPath ?? null,
  });
  if (!runner || runner.pid === null || !runner.alive) {
    // Parked: the service could not name a live lock owner and does not retry.
    if (conflict && conflict.ownerPid === null) return lockConflict();
    return spawnedRunnerReadiness(runner, serverId, expectedVersion, servicePid, nowMs) ?? { code: "runner-absent", serverId };
  }
  const evidence = runner.versionEvidence;
  if (
    !evidence ||
    evidence.pid !== runner.pid ||
    evidence.version === null ||
    evidence.installRoot.length === 0
  ) {
    // The service adopted the lock owner as this runner, but that process
    // never attested as one.
    if (conflict && conflict.ownerPid === runner.pid) return lockConflict();
    return { code: "runner-unattested", serverId, pid: runner.pid };
  }
  if (evidence.version !== expectedVersion) {
    return {
      code: "runner-version-mismatch",
      serverId,
      pid: runner.pid,
      expectedVersion,
      actualVersion: evidence.version,
    };
  }
  if (runner.connectionEvidence?.pid !== runner.pid) {
    return { code: "runner-disconnected", serverId, pid: runner.pid };
  }
  return { pid: runner.pid };
}

/** Pure, deterministic start-completion gate over raw machine facts. */
export function machineReadiness(
  facts: MachineFacts,
  requirement: MachineReadinessRequirement,
): MachineReadinessVerdict {
  const managed = new Set(facts.managedServerIds);
  const runners = new Map(facts.runners.map((runner) => [runner.serverId, runner]));
  const targetServerIds = [...new Set(requirement.targetServerIds)].sort();
  const runnerPids = new Map<string, number>();
  const reasons: MachineReadinessReason[] = [];
  const nowMs = requirement.nowMs ?? currentTimeMs();

  for (const serverId of targetServerIds) {
    if (!managed.has(serverId)) {
      reasons.push({ code: "runner-not-managed", serverId });
      continue;
    }
    const readiness = runnerReadiness(runners.get(serverId), serverId, requirement.expectedVersion, requirement.servicePid, nowMs);
    if ("code" in readiness) {
      reasons.push(readiness);
      continue;
    }
    runnerPids.set(serverId, readiness.pid);
  }

  return {
    ready: reasons.length === 0,
    runnerPids,
    reasons,
  };
}
