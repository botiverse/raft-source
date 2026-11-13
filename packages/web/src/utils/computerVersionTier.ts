import {
  COMPUTER_REMOTE_UPGRADE_MIN_VERSION,
  COMPUTER_VERSION_FLOOR,
  compareComputerVersions,
  getComputerVersionFloorStanding,
  isComputerSemver,
} from "@botiverse/raft-shared";
import type { ComputerVersionGate, ComputerVersionGateReason } from "@botiverse/raft-shared";
import type { Machine } from "../store/machineStore";

/**
 * What a Computer card says about the Computer's version against the version
 * floor, on every surface (detail page, sidebar row, phone list), so they
 * cannot disagree.
 *
 * Source: the server's per-machine `versionGate` (#10343) when the server sends
 * the field (null = not gated: no notice). Older servers that do not send it:
 * the same judgement on the client against COMPUTER_VERSION_FLOOR (never
 * enforced, since only the server holds agents).
 *
 * - `none`: no gate, not a managed Computer, or no verdict (offline with no
 *   version: the server sends no version for an offline Computer, so its gate
 *   would say "unknown" for every offline row).
 * - `upgrade`: below the floor but at or above the web's one-click minimum
 *   (COMPUTER_REMOTE_UPGRADE_MIN_VERSION).
 * - `reinstall`: below the one-click minimum (computer_version_unsupported), or
 *   a version that is not SemVer (computer_version_unknown).
 * - `unreported`: online with no version yet (computer_version_unknown).
 *   Usually it is a moment away (the online event lands before the Computer's
 *   `ready`), so cards wait UNREPORTED_VERSION_GRACE_MS before treating it as
 *   `reinstall` (useComputerVersionTier).
 */
export type ComputerVersionTier =
  | { kind: "none" }
  | {
    kind: "upgrade" | "reinstall" | "unreported";
    /** The server's `versionGate.reason`: too old, or no (SemVer) version reported. */
    reason: ComputerVersionGateReason;
    minVersion: string;
    enforced: boolean;
    enforcedAt: string | null;
  };

/** How long an online Computer may go without a version before the cards say
 *  it needs a reinstall. */
export const UNREPORTED_VERSION_GRACE_MS = 20 * 1000;

const NONE: ComputerVersionTier = { kind: "none" };

/** The client-side gate for servers that do not send `versionGate`. */
function fallbackGate(version: string | null | undefined): ComputerVersionGate | null {
  const standing = getComputerVersionFloorStanding(version);
  if (standing === "current") return null;
  return {
    reason: standing === "upgrade" || standing === "reinstall" ? "computer_version_unsupported" : "computer_version_unknown",
    minVersion: COMPUTER_VERSION_FLOOR.minVersion,
    enforcedAt: COMPUTER_VERSION_FLOOR.enforcedAt,
    enforced: false,
  };
}

export function computerVersionTier(
  machine: Pick<Machine, "isComputer" | "status" | "computerVersion" | "versionGate">,
): ComputerVersionTier {
  if (machine.isComputer !== true) return NONE;
  const gate = machine.versionGate !== undefined ? machine.versionGate : fallbackGate(machine.computerVersion);
  if (!gate) return NONE;
  const version = machine.computerVersion?.trim() || null;
  const facts = { reason: gate.reason, minVersion: gate.minVersion, enforced: gate.enforced, enforcedAt: gate.enforcedAt };
  if (!version) return machine.status === "online" ? { kind: "unreported", ...facts, reason: "computer_version_unknown" } : NONE;
  // Reinstall or upgrade is about what the web can do for this version: it
  // drives an upgrade from COMPUTER_REMOTE_UPGRADE_MIN_VERSION on.
  const webCanUpgrade = isComputerSemver(version) && compareComputerVersions(version, COMPUTER_REMOTE_UPGRADE_MIN_VERSION) >= 0;
  return { kind: webCanUpgrade ? "upgrade" : "reinstall", ...facts };
}
