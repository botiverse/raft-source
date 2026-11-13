import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../store/machineStore";
import { canManageMachine } from "./canManageMachine";
import { computerVersionTier } from "./computerVersionTier";

type ReinstallMachine = Pick<Machine, "id" | "isComputer" | "status" | "computerVersion" | "versionGate" | "computerAttachedByCurrentUser" | "creator">;

/**
 * The Notification Center's `computer-reinstall` entry: machines in the
 * current server that the user manages and that cannot be brought up to date
 * from the web, so each needs a one-time step on the machine itself:
 * - a managed Computer whose version tier is `reinstall`. A Computer that has
 *   not reported a version yet (`unreported`) does not count: the cards wait
 *   UNREPORTED_VERSION_GRACE_MS before calling it a reinstall, and a notice
 *   that flashes on every reconnect is worse than one that misses those;
 * - a legacy standalone daemon (`isComputer !== true`), whose detail page
 *   shows the migrate-to-Computer commands.
 *
 * Any status: the dismissal fingerprint is built from this set, so a machine
 * going offline and back does not bring a dismissed entry back. The entry
 * itself lists only the online ones (machinesNeedingReinstall).
 */
export function machinesNeedingReinstallAnyStatus<T extends ReinstallMachine>(
  machines: readonly T[],
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): T[] {
  return machines.filter((machine) =>
    canManageMachine(machine, currentUserId, capabilities)
    && (machine.isComputer !== true || computerVersionTier(machine).kind === "reinstall"));
}

/** The machines the entry lists: the ones above that are online now. */
export function machinesNeedingReinstall<T extends ReinstallMachine>(
  machines: readonly T[],
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): T[] {
  return machinesNeedingReinstallAnyStatus(machines, currentUserId, capabilities)
    .filter((machine) => machine.status === "online");
}

/**
 * The Notification Center's `computer-upgrade-deadline` entry: managed
 * Computers the web can still upgrade (tier `upgrade`) whose floor has a
 * deadline that has not taken effect yet. Without a deadline the Computer
 * card's own notice is enough; with one, a user who never opens the card must
 * still learn the date (#proj-o11y:#19, the 1.0.53 floor). Any status, for the
 * same dismissal reason as above.
 */
export function machinesNeedingUpgradeByDeadlineAnyStatus<T extends ReinstallMachine>(
  machines: readonly T[],
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): T[] {
  return machines.filter((machine) => {
    if (!canManageMachine(machine, currentUserId, capabilities)) return false;
    const tier = computerVersionTier(machine);
    return tier.kind === "upgrade" && tier.enforcedAt !== null && !tier.enforced;
  });
}

/** The machines that entry lists: the ones above that are online now. */
export function machinesNeedingUpgradeByDeadline<T extends ReinstallMachine>(
  machines: readonly T[],
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): T[] {
  return machinesNeedingUpgradeByDeadlineAnyStatus(machines, currentUserId, capabilities)
    .filter((machine) => machine.status === "online");
}

/**
 * The earliest deadline among these machines that has not taken effect yet,
 * or null: what a notice about them says "by {date}" with.
 */
export function earliestVersionDeadline(machines: readonly Pick<Machine, "isComputer" | "status" | "computerVersion" | "versionGate">[]): string | null {
  let earliest: string | null = null;
  for (const machine of machines) {
    const tier = computerVersionTier(machine);
    if (tier.kind === "none" || tier.enforced || !tier.enforcedAt) continue;
    if (earliest === null || Date.parse(tier.enforcedAt) < Date.parse(earliest)) earliest = tier.enforcedAt;
  }
  return earliest;
}

export const REINSTALL_DISMISSAL_PREFIX = "computer-reinstall:";
const DISMISSAL_PREFIX = REINSTALL_DISMISSAL_PREFIX;
export const UPGRADE_DEADLINE_DISMISSAL_PREFIX = "computer-upgrade-deadline:";

/**
 * Dismissal fingerprint: the sorted ids of every machine that needs it,
 * online or not, so a connectivity flap does not change it. An offline
 * Computer counts only while the store still knows its version (the server
 * sends none for an offline Computer on a fresh load).
 *
 * The Notification Center hides an entry whose key is in the dismissed set
 * (exact match). So that fixing one machine does not bring the entry back for
 * the rest, an earlier dismissed key that already covers every current
 * machine is reused; only a machine no dismissal covered yields a new key.
 */
export function reinstallDismissalKey(
  candidates: readonly Pick<Machine, "id">[],
  dismissedKeys: ReadonlySet<string> = new Set(),
  prefix: string = DISMISSAL_PREFIX,
): string {
  const ids = candidates.map((m) => m.id).sort();
  for (const key of dismissedKeys) {
    if (!key.startsWith(prefix)) continue;
    const covered = new Set(key.slice(prefix.length).split(","));
    if (ids.every((id) => covered.has(id))) return key;
  }
  return `${prefix}${ids.join(",")}`;
}

/** What the listed machines need: a reinstall (Computers), a migration (legacy daemons), or both. */
export function reinstallNoticeKind(machines: readonly Pick<Machine, "isComputer">[]): "reinstall" | "migrate" | "mixed" {
  const legacy = machines.filter((machine) => machine.isComputer !== true).length;
  if (legacy === 0) return "reinstall";
  return legacy === machines.length ? "migrate" : "mixed";
}
