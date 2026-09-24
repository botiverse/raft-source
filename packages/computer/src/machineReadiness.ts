import type { MachineFacts, RunnerMachineFacts } from "./machineFacts.js";

export type MachineReadinessReasonCode =
  | "runner-not-managed"
  | "runner-absent"
  | "runner-unattested"
  | "runner-version-mismatch"
  | "runner-disconnected";

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
  | { readonly code: "runner-disconnected"; readonly serverId: string; readonly pid: number };

export interface MachineReadinessRequirement {
  readonly targetServerIds: readonly string[];
  readonly expectedVersion: string;
}

export interface MachineReadinessVerdict {
  readonly ready: boolean;
  /** Current ready subset, used by start timeout/abort reporting. */
  readonly runnerPids: ReadonlyMap<string, number>;
  readonly reasons: readonly MachineReadinessReason[];
}

type RunnerReadiness = MachineReadinessReason | { readonly pid: number };

function runnerReadiness(
  runner: RunnerMachineFacts | undefined,
  serverId: string,
  expectedVersion: string,
): RunnerReadiness {
  if (!runner || runner.pid === null || !runner.alive) {
    return { code: "runner-absent", serverId };
  }
  const evidence = runner.versionEvidence;
  if (
    !evidence ||
    evidence.pid !== runner.pid ||
    evidence.version === null ||
    evidence.installRoot.length === 0
  ) {
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
    const readiness = runnerReadiness(runners.get(serverId), serverId, requirement.expectedVersion);
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
