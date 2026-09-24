import { isDaemonOutdated } from "@botiverse/raft-shared";
import { createIntl, createIntlCache } from "react-intl";
import type { IntlShape } from "react-intl";
import { en } from "../i18n/messages/en";

const enComputerIntl = createIntl(
  { locale: "en", defaultLocale: "en", messages: en },
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
  latestDaemonVersion?: string | null,
): number {
  let count = 0;
  for (const machine of machines) {
    const hasUpdate = shouldShowComputerUpgradeIndicator(machine)
      || (machine.isComputer !== true && isDaemonOutdated(machine.daemonVersion, latestDaemonVersion));
    if (hasUpdate || machine.status === "offline") count += 1;
  }
  return count;
}

export function getComputerAttentionDotTone(status: ComputerAttentionStatus): string | undefined {
  if (status === "upgrade") return "bg-brutal-pink";
  if (status === "offline") return "bg-gray-400";
  return undefined;
}

/**
 * A Computer list row owns exactly one status dot on the machine icon. Unlike
 * the aggregate attention state above, this row state always has a visible
 * value so healthy online machines keep their existing lime presence signal.
 * Managed Computer upgrades outrank liveness color; raw legacy daemons never
 * enter the upgrade state.
 */
export function getComputerRowDotStatus(machine: ComputerAttentionMachine): ComputerRowDotStatus {
  if (shouldShowComputerUpgradeIndicator(machine)) return "upgrade";
  return machine.status === "online" ? "online" : "offline";
}

export function getComputerRowDotTone(status: ComputerRowDotStatus): string {
  if (status === "upgrade") return "bg-brutal-pink";
  if (status === "online") return "bg-brutal-lime";
  return "bg-gray-400";
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
