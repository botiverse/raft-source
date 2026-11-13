import type { Machine } from "../../store/machineStore";
import { isMyComputer } from "../../components/layout/sidebarMachineOrder";
import { bothComputerVersionsKnown, isDaemonOutdated } from "@botiverse/raft-shared";

export function machineMeetsDaemonRequirement(
  machine: Machine | undefined,
  minimumDaemonVersion: string | undefined,
): boolean {
  return !!machine
    && (
      !minimumDaemonVersion
      || (
        bothComputerVersionsKnown(machine.daemonVersion, minimumDaemonVersion)
        && !isDaemonOutdated(machine.daemonVersion, minimumDaemonVersion)
      )
    );
}

/**
 * Fallback computer when nothing more specific (a prefill, the caller's
 * default, the remembered last choice) applies: the person creating the agent
 * usually means their own computer, so an online Computer of theirs (attached
 * or owned: isMyComputer) comes before any other online machine (bug-triage
 * task #23, julie).
 */
export function pickFallbackMachine(
  machines: readonly Machine[],
  minimumDaemonVersion: string | undefined,
  userId: string | null | undefined,
): Machine | undefined {
  const usable = machines.filter((m) => m.status === "online" && machineMeetsDaemonRequirement(m, minimumDaemonVersion));
  return usable.find((m) => isMyComputer(m, userId)) ?? usable[0];
}
