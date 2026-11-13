import { useMachineStore } from "../../store/machineStore";

/** The Computer's name as people know it, for the dialog copy. */
export function useComputerName(machineId: string): string | null {
  const machine = useMachineStore((s) => s.machines.find((m) => m.id === machineId));
  const name = machine?.name?.trim();
  return name || machine?.hostname?.trim() || null;
}
