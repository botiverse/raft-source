import { getMachineRunLabelDescriptor } from "./machineRunLabel";
import type { MachineRunLabelDescriptor, MachineRunLabelInput } from "./machineRunLabel";

export function agentProfileMachineRunLabel(machine: MachineRunLabelInput): MachineRunLabelDescriptor {
  return getMachineRunLabelDescriptor(machine);
}
