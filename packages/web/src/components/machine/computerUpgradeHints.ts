import { compareComputerVersions, isComputerSemver } from "@botiverse/raft-shared";
import type { ComputerUpgradeUnitFailureHint } from "@botiverse/raft-shared";
import type { MachineUpgradeRequest } from "../../store/machineStore";

/**
 * The last request's outcome only while the Computer is still below that
 * request's target: a later manual upgrade makes a failure / no-response
 * line stale.
 */
export function upgradeRequestOutcomeStillTrue(upgradeRequest: MachineUpgradeRequest | null | undefined, computerVersion: string | null | undefined): boolean {
  return Boolean(
    upgradeRequest
    && (upgradeRequest.state === "failed" || upgradeRequest.state === "no_response")
    && computerVersion
    && isComputerSemver(computerVersion)
    && isComputerSemver(upgradeRequest.targetVersion)
    && compareComputerVersions(computerVersion, upgradeRequest.targetVersion) < 0,
  );
}

export interface ComputerUpgradeHints {
  /** Steps around the systemd unit the last web upgrade failed on. */
  upgradeFailureHint: ComputerUpgradeUnitFailureHint | null;
  /** Recommend the install command (the repair) over the offered one-click Upgrade, which stays. */
  recommendRepair: boolean;
}

/**
 * Which advice the Upgrade card and the rack row show beside an offered
 * one-click Upgrade. The last web upgrade's failure hint counts only while
 * that failed request is the latest, its outcome still true, and the
 * Computer still runs the version it failed on. `earlier_recovery_pending`
 * (the installer refused behind an unfinished earlier installation) is the
 * same advice as the installer state's own repair hint (#proj-raft-computer
 * task #34): the repair banner and install command.
 */
export function computerUpgradeHints(input: {
  oneClick: boolean;
  upgradeRequest: MachineUpgradeRequest | null | undefined;
  computerVersion: string | null | undefined;
  installerRepairHint: boolean;
}): ComputerUpgradeHints {
  if (!input.oneClick) return { upgradeFailureHint: null, recommendRepair: false };
  const request = input.upgradeRequest;
  const failureHint = request
    && request.state === "failed"
    && upgradeRequestOutcomeStillTrue(request, input.computerVersion)
    && (request.observedVersion === null || request.observedVersion === input.computerVersion)
    ? request.failureHint ?? null
    : null;
  if (!failureHint) return { upgradeFailureHint: null, recommendRepair: input.installerRepairHint };
  switch (failureHint.reason) {
    case "earlier_recovery_pending":
      return { upgradeFailureHint: null, recommendRepair: true };
    case "unsafe_kill_mode":
    case "installation_held":
      return { upgradeFailureHint: failureHint, recommendRepair: input.installerRepairHint };
    default: {
      const unknown: never = failureHint;
      return unknown;
    }
  }
}
