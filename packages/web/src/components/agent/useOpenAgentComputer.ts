import { useCallback } from "react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useAgentStore } from "../../store/agentStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";

/**
 * Opens the page of the Computer an agent runs on, closing the profile and
 * thread over it. `open` is null when the agent has no Computer.
 */
export function useOpenAgentComputer(agentId: string): { machineId: string | null; open: (() => void) | null } {
  const nav = useAppNavigate();
  const machineId = useAgentStore((s) => s.agents.find((agent) => agent.id === agentId)?.machineId ?? null);
  const open = useCallback(() => {
    if (!machineId) return;
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
    nav.toComputer(machineId);
  }, [machineId, nav]);
  return { machineId, open: machineId ? open : null };
}
