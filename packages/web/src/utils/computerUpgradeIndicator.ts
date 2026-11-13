import { createIntl, createIntlCache } from "react-intl";
import type { IntlShape } from "react-intl";
import type { Presence } from "@botiverse/raft-ui";
import { enFallbackMessages } from "../i18n/messages/enFallback";

const enComputerIntl = createIntl(
  { locale: "en", defaultLocale: "en", messages: enFallbackMessages },
  createIntlCache(),
);

export function shouldShowComputerUpgradeIndicator(machine: {
  isComputer?: boolean;
  computerUpgradeAvailable?: boolean | null;
}): boolean {
  return machine.isComputer === true && machine.computerUpgradeAvailable === true;
}

export type ComputerAttentionStatus = "upgrade" | "offline" | "none";
export type ComputerRowDotStatus = "upgrade" | "offline" | "online";

export interface ComputerAttentionMachine {
  id: string;
  name?: string | null;
  status?: string | null;
  isComputer?: boolean;
  daemonVersion?: string | null;
  computerUpgradeAvailable?: boolean | null;
  /** The server's "needs attention" summary (#68); absent from older servers. */
  attention?: { count: number } | null;
}

/**
 * #68: the server's "needs attention" verdict, when it sent one: true when a
 * person must act on this Computer. Undefined from an older server (the
 * callers keep their own rule).
 */
export function serverNeedsAttention(machine: { attention?: { count: number } | null }): boolean | undefined {
  return machine.attention ? machine.attention.count > 0 : undefined;
}

export interface ComputerAttentionSummary<T extends ComputerAttentionMachine = ComputerAttentionMachine> {
  status: ComputerAttentionStatus;
  upgradeCount: number;
  offlineCount: number;
  problemComputers: T[];
}

export function getComputerAttentionStatus(machine: ComputerAttentionMachine): ComputerAttentionStatus {
  if (machine.isComputer !== true) return "none";
  if (machine.computerUpgradeAvailable === true) return "upgrade";
  if (machine.status === "offline") return "offline";
  return "none";
}

export function summarizeComputerAttention<T extends ComputerAttentionMachine>(
  machines: readonly T[],
): ComputerAttentionSummary<T> {
  let upgradeCount = 0;
  let offlineCount = 0;
  const problemComputers: T[] = [];

  for (const machine of machines) {
    const status = getComputerAttentionStatus(machine);
    if (status === "none") continue;
    problemComputers.push(machine);
    if (status === "upgrade") upgradeCount += 1;
    if (status === "offline") offlineCount += 1;
  }

  return {
    status: upgradeCount > 0 ? "upgrade" : offlineCount > 0 ? "offline" : "none",
    upgradeCount,
    offlineCount,
    problemComputers,
  };
}

export function countMachinesNeedingAttention(
  machines: readonly ComputerAttentionMachine[],
): number {
  let count = 0;
  for (const machine of machines) {
    // Only managed Computers have an upgrade signal; the standalone daemon has
    // no release line of its own any more.
    if (serverNeedsAttention(machine) ?? (shouldShowComputerUpgradeIndicator(machine) || machine.status === "offline")) count += 1;
  }
  return count;
}

// Raft DS colours: an update (available or required) needs handling, so it is
// orange, the error light; pink is only for unread / new. Presence lights are
// fixed (online lime, offline stone).
export function getComputerAttentionDotTone(status: ComputerAttentionStatus): string | undefined {
  if (status === "upgrade") return "bg-presence-error";
  if (status === "offline") return "bg-presence-offline";
  return undefined;
}

/**
 * A Computer list row owns exactly one status dot on the machine icon. Unlike
 * the aggregate attention state above, this row state always has a visible
 * value so healthy online machines keep their existing lime presence signal.
 * Managed Computer upgrades outrank liveness color; raw legacy daemons never
 * enter the upgrade state.
 */
export function getComputerRowDotStatus(
  machine: ComputerAttentionMachine,
  // The row's own answer to "is there a newer version" (getComputerAvailableVersion:
  // the web's version comparison, independent of whether web upgrade is on).
  // Omitted: fall back to the server's broadcast projection.
  availableVersion?: string | null,
  // Below the version floor (useComputerVersionTier is not "none"): the row's
  // "Update required" fact. Orange too, even with no newer version to
  // name (a Computer that does not report its version).
  belowVersionFloor = false,
): ComputerRowDotStatus {
  const upgrade = availableVersion === undefined
    ? shouldShowComputerUpgradeIndicator(machine)
    : machine.isComputer === true && availableVersion !== null;
  if (upgrade || (machine.isComputer === true && belowVersionFloor)) return "upgrade";
  return machine.status === "online" ? "online" : "offline";
}

/**
 * The row dot's light, as StatusDot props: liveness is a fixed presence light
 * (raft-ui `Status presence`: online lime, offline stone); an update waiting
 * for you (available or required) needs handling: the orange error light.
 * Pink is only for unread / new.
 */
export function getComputerRowDotLight(
  status: ComputerRowDotStatus,
): { presence: Presence; tone?: undefined } | { presence?: undefined; tone: string } {
  if (status === "upgrade") return { presence: "error" };
  return { presence: status };
}

export type ComputerRowDotTitleDescriptor =
  | { id: "machine.attention.upgradeAvailableOfflineWithVersion"; values: { version: string } }
  | { id: "machine.attention.upgradeAvailableOffline"; values?: undefined }
  | { id: "machine.attention.upgradeAvailableWithVersion"; values: { version: string } }
  | { id: "machine.attention.upgradeAvailable"; values?: undefined }
  | { id: "activity.status.online"; values?: undefined }
  | { id: "activity.status.offline"; values?: undefined };

export function getComputerRowDotTitleDescriptor(
  status: ComputerRowDotStatus,
  machineStatus?: string | null,
  latestComputerVersion?: string | null,
): ComputerRowDotTitleDescriptor {
  if (status === "upgrade" && machineStatus === "offline") {
    return latestComputerVersion
      ? { id: "machine.attention.upgradeAvailableOfflineWithVersion", values: { version: latestComputerVersion } }
      : { id: "machine.attention.upgradeAvailableOffline" };
  }
  if (status === "upgrade") {
    return latestComputerVersion
      ? { id: "machine.attention.upgradeAvailableWithVersion", values: { version: latestComputerVersion } }
      : { id: "machine.attention.upgradeAvailable" };
  }
  if (status === "online") return { id: "activity.status.online" };
  return { id: "activity.status.offline" };
}

export function formatComputerAttentionCounts(
  summary: Pick<ComputerAttentionSummary, "upgradeCount" | "offlineCount">,
  formatMessage?: IntlShape["formatMessage"],
): string {
  const parts: string[] = [];
  if (summary.upgradeCount > 0) {
    parts.push(formatMessage
      ? formatMessage({ id: "layout.systemNotifications.computerAttentionUpgradeCount" }, { count: summary.upgradeCount })
      : `${summary.upgradeCount} ${summary.upgradeCount === 1 ? "needs" : "need"} upgrade`);
  }
  if (summary.offlineCount > 0) {
    parts.push(formatMessage
      ? formatMessage({ id: "layout.systemNotifications.computerAttentionOfflineCount" }, { count: summary.offlineCount })
      : `${summary.offlineCount} offline`);
  }
  return parts.join(" · ");
}

export type ComputerAttentionTitleDescriptor =
  | { id: "machine.attention.upgradeAvailableWithVersion"; values: { version: string } }
  | { id: "machine.attention.upgradeAvailable"; values?: undefined }
  | { id: "machine.attention.offline"; values?: undefined }
  | { id: "machine.attention.status"; values?: undefined };

export function getComputerAttentionTitleDescriptor(
  status: ComputerAttentionStatus,
  latestComputerVersion?: string | null,
): ComputerAttentionTitleDescriptor {
  if (status === "upgrade") {
    return latestComputerVersion
      ? { id: "machine.attention.upgradeAvailableWithVersion", values: { version: latestComputerVersion } }
      : { id: "machine.attention.upgradeAvailable" };
  }
  if (status === "offline") return { id: "machine.attention.offline" };
  return { id: "machine.attention.status" };
}

/**
 * English-catalog title for non-React call sites. Prefer
 * `getComputerAttentionTitleDescriptor` + formatMessage in UI.
 */
export function getComputerAttentionTitle(
  status: ComputerAttentionStatus,
  latestComputerVersion?: string | null,
): string {
  const descriptor = getComputerAttentionTitleDescriptor(status, latestComputerVersion);
  return String(enComputerIntl.formatMessage({ id: descriptor.id }, descriptor.values));
}

export function formatComputerAttentionTitle(
  formatMessage: IntlShape["formatMessage"],
  status: ComputerAttentionStatus,
  latestComputerVersion?: string | null,
): string {
  const descriptor = getComputerAttentionTitleDescriptor(status, latestComputerVersion);
  return String(formatMessage({ id: descriptor.id }, descriptor.values));
}
