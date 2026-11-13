import type { IntlShape } from "react-intl";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { MachineDiskStatus, MachineMemoryStatus } from "@botiverse/raft-shared";

/** What the picker knows of a computer's own state. */
export interface TargetComputerState {
  status: string;
  diskStatus?: MachineDiskStatus | null;
  memoryStatus?: MachineMemoryStatus | null;
}

/**
 * The disk report to show, only from an online computer. The server sends no
 * disk for an offline one; a value still in the store from before it went
 * offline is old, so it is not shown either.
 */
export function liveDiskStatus(machine: TargetComputerState): MachineDiskStatus | null {
  return machine.status === "online" ? readableDiskStatus(machine.diskStatus) : null;
}

/** The memory report to show, on the same terms as the disk: online only. */
export function liveMemoryStatus(machine: TargetComputerState): MachineMemoryStatus | null {
  return machine.status === "online" ? readableDiskStatus(machine.memoryStatus) : null;
}

/**
 * How long a computer has been offline, coarse like the app's relative times
 * ("3 hours", "离线 3 小时"): minutes under an hour, hours under a day, then
 * days. From when this tab saw it go offline, else its last heartbeat (which
 * is only as fresh as the last machine list load); null with neither.
 */
export function offlineDuration(
  offlineObservedAtMs: number | null,
  lastHeartbeat: string | null | undefined,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const since = offlineObservedAtMs ?? (lastHeartbeat ? new Date(lastHeartbeat).getTime() : Number.NaN);
  if (Number.isNaN(since)) return null;
  const elapsed = Math.max(0, currentTimeMs() - since);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < hour) {
    return formatMessage({ id: "agent.migration.target.durationMinutes" }, { count: Math.max(1, Math.round(elapsed / minute)) });
  }
  if (elapsed < day) {
    return formatMessage({ id: "agent.migration.target.durationHours" }, { count: Math.round(elapsed / hour) });
  }
  return formatMessage({ id: "agent.migration.target.durationDays" }, { count: Math.round(elapsed / day) });
}

/** A disk or memory report worth reading: a positive total and a free size within it. */
export function readableDiskStatus(disk: MachineDiskStatus | null | undefined): MachineDiskStatus | null {
  if (!disk || !Number.isFinite(disk.totalBytes) || disk.totalBytes <= 0) return null;
  if (!Number.isFinite(disk.availableBytes) || disk.availableBytes < 0 || disk.availableBytes > disk.totalBytes) return null;
  return disk;
}

/** How much of a disk or memory is used, in whole percent ("62% used"), as the Computers rack shows it. */
export function resourceUsedPercent(status: MachineDiskStatus): number {
  return Math.round((1 - status.availableBytes / status.totalBytes) * 100);
}

/**
 * The target picker's second line, about the computer itself: how many
 * agents already live on it first (what people compare computers by, so it
 * is never the part a narrow row cuts off), then how much of its memory is
 * used (whether another agent fits), then of its disk, which almost always
 * has room ("3 agents · RAM 62% used · Disk 88% used"): what is used, as the
 * Computers rack says it (stdrc, 2026-10-29); the details popover has the
 * free sizes. Older Computers
 * report no memory; that part is left out. An offline computer says so
 * first, with no memory or disk ("Offline · 3 agents"). A part the dialog
 * does not know is left out: no disk report, or the agent list not loaded
 * yet. Knowing nothing, there is no line.
 */
export function targetComputerInfoLine(
  machine: TargetComputerState,
  agentCount: number | null,
  formatMessage: IntlShape["formatMessage"],
): string | undefined {
  const parts: string[] = [];
  if (machine.status === "offline") parts.push(formatMessage({ id: "agent.migration.target.offline" }));
  if (agentCount !== null) {
    parts.push(formatMessage({ id: "agent.migration.target.agents" }, { count: agentCount }));
  }
  const memory = liveMemoryStatus(machine);
  if (memory) {
    parts.push(formatMessage({ id: "agent.migration.target.memoryUsed" }, { percent: resourceUsedPercent(memory) }));
  }
  const disk = liveDiskStatus(machine);
  if (disk) {
    parts.push(formatMessage({ id: "agent.migration.target.diskUsed" }, { percent: resourceUsedPercent(disk) }));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
