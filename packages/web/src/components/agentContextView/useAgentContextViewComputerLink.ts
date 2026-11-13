import { useCallback } from "react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAgentContextViewStore } from "../../store/agentContextViewStore";
import { useMachineStore } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";

/**
 * Opens the page of the Computer a view's refusal names (its `computer.id` is
 * the machine's id), as useOpenAgentComputer opens an agent's: closing the
 * profile and thread over it, and this view (on a phone it is a page over the
 * app). `open` is null where the viewer can't open that page: no Computer
 * named, no `viewMachines` (a guest), or a Computer not in the viewer's list.
 */
export function useAgentContextViewComputerLink(computerId: string | null): (() => void) | null {
  const nav = useAppNavigate();
  const { capabilities } = useServerPermissions();
  const listed = useMachineStore((s) => (computerId ? s.machines.some((machine) => machine.id === computerId) : false));
  const open = useCallback(() => {
    if (!computerId) return;
    useAgentContextViewStore.getState().close();
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    nav.toComputer(computerId);
  }, [computerId, nav]);
  return computerId && capabilities.viewMachines && listed ? open : null;
}
