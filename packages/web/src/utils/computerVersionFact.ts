import { compareComputerVersions, isComputerSemver } from "@botiverse/raft-shared";
import type { Machine } from "../store/machineStore";

/**
 * What the web can say about a Computer's version, before any question of
 * whether web upgrade is switched on (computer-upgrade-copy-proposal §2.1).
 *
 * "Is it up to date" is the web's own comparison of the Computer's version
 * with the latest published Computer version. It does not depend on the
 * server's broadcast policy: with web upgrade switched off the policy stops at
 * its gate and never compares versions, which used to make an up-to-date
 * Computer read as "not eligible for an upgrade".
 *
 * - `unknown`: the Computer has not reported a version yet.
 * - `cannotCheck`: no answer right now, because no published version is known,
 *   a version is not SemVer, or the server could not look up a release for
 *   this machine (release service error, unknown platform, no artifact).
 * - `current`: on (or past) the latest published version.
 * - `outdated`: a newer version exists; `availableVersion` is the one to show.
 */
export type ComputerVersionFact =
  | { kind: "unknown" }
  | { kind: "cannotCheck" }
  | { kind: "current" }
  | { kind: "outdated"; availableVersion: string };

// Policy reason codes meaning "the server could not find a release for this
// machine". They only matter when the comparison says a newer version exists:
// then the web must not promise an install that may not exist for this OS/arch.
const RELEASE_LOOKUP_FAILED_REASON_CODES: ReadonlySet<string> = new Set([
  "source_unparseable",
  "platform_unknown",
  "hands_unavailable",
  "hands_response_invalid",
  "hands_artifact_missing",
]);

// Versions are full SemVer and ordered exactly as the server's upgrade policy
// orders them (its `already_current` check): a staging / rc build is a valid
// version, sorts below its release, and above every earlier release.
const isNewer = (candidate: string, version: string) => compareComputerVersions(candidate, version) > 0;

export function getComputerVersionFact(
  machine: Pick<Machine, "computerVersion" | "computerBroadcastPolicy">,
  latestComputerVersion: string | null | undefined,
): ComputerVersionFact {
  const version = machine.computerVersion?.trim() || null;
  if (!version) return { kind: "unknown" };
  if (!isComputerSemver(version)) return { kind: "cannotCheck" };

  const policy = machine.computerBroadcastPolicy ?? null;
  // An eligible policy names the exact target the Upgrade button will send;
  // show that one so the version row and the button never disagree.
  const policyTarget = policy?.eligibility === "eligible" && policy.targetVersion && isComputerSemver(policy.targetVersion)
    ? policy.targetVersion
    : null;
  if (policyTarget && isNewer(policyTarget, version)) {
    return { kind: "outdated", availableVersion: policyTarget };
  }

  const latest = latestComputerVersion?.trim() || null;
  if (!latest || !isComputerSemver(latest)) return { kind: "cannotCheck" };
  if (!isNewer(latest, version)) return { kind: "current" };
  if (policy && RELEASE_LOOKUP_FAILED_REASON_CODES.has(policy.reasonCode)) return { kind: "cannotCheck" };
  return { kind: "outdated", availableVersion: latest };
}

/**
 * The version a Computer list row points at (`→ v1.0.40`), or null: the web's
 * comparison, plus the server's own "eligible" verdict (which already implies
 * a newer version) for rows whose version the web has not received.
 */
export function getComputerAvailableVersion(
  machine: Pick<Machine, "isComputer" | "computerVersion" | "computerBroadcastPolicy" | "computerUpgradeAvailable">,
  latestComputerVersion: string | null | undefined,
): string | null {
  if (machine.isComputer !== true) return null;
  // Raft Desktop updates its bundled Computer itself: nothing for the row to
  // point at or mark as waiting for an upgrade.
  if (machine.computerBroadcastPolicy?.reasonCode === "managed_by_desktop") return null;
  const fact = getComputerVersionFact(machine, latestComputerVersion);
  if (fact.kind === "outdated") return fact.availableVersion;
  const policy = machine.computerBroadcastPolicy;
  if (fact.kind === "unknown" && machine.computerUpgradeAvailable === true && policy?.eligibility === "eligible" && policy.targetVersion) {
    return policy.targetVersion;
  }
  return null;
}
