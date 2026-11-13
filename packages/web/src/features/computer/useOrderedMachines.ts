import { useShallow } from "zustand/react/shallow";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { orderSidebarMachineIds } from "../../components/layout/sidebarMachineOrder";
import { useLocalComputerMachineId } from "../../components/machine/localComputer/localComputerStore";
import { useAuthStore } from "../../store/authStore";

/** The computers in the sidebar's order (this device, the viewer's own, the rest). */
export function useOrderedMachines(): Machine[] {
  const localMachineId = useLocalComputerMachineId();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  return useMachineStore(useShallow((s) => {
    const byId = new Map(s.machines.map((machine) => [machine.id, machine]));
    return orderSidebarMachineIds(s.machines, localMachineId, userId).map((id) => byId.get(id)!);
  }));
}
