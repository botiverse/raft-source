import type { MachineFacts, RunnerMachineFacts } from "./machineFacts";

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
   * record is only current for the service that wrote it).
   */
  readonly servicePid?: number;
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

function runnerReadiness(
  runner: RunnerMachineFacts | undefined,
  serverId: string,
  expectedVersion: string,
  servicePid: number | undefined,
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
    return conflict && conflict.ownerPid === null ? lockConflict() : { code: "runner-absent", serverId };
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

  for (const serverId of targetServerIds) {
    if (!managed.has(serverId)) {
      reasons.push({ code: "runner-not-managed", serverId });
      continue;
    }
    const readiness = runnerReadiness(runners.get(serverId), serverId, requirement.expectedVersion, requirement.servicePid);
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
