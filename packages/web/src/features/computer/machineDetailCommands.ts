import type { ComputerCommands } from "../../utils/computerSetupCommand";

/** The status / doctor commands the Computer page offers to copy, in order. */
export function terminalStatusCommandsFor(machineComputerCommands: ComputerCommands | null) {
  return machineComputerCommands
    ? [
        { command: machineComputerCommands.status, target: "terminal-status" as const },
        { command: machineComputerCommands.doctor, target: "terminal-doctor" as const },
      ]
    : [];
}
