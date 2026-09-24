import type { Machine } from "../store/machineStore";

export function mergeMachineStatus(
  machine: Machine,
  status: "online" | "offline",
  statusVersion?: number,
): Machine {
  if (statusVersion !== undefined && statusVersion < machine.statusVersion) {
    return machine;
  }

  return {
    ...machine,
    status,
    statusVersion: statusVersion ?? machine.statusVersion,
  };
}

