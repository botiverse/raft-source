import { useMemo } from "react";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";

/** Live (not archived) agents per computer, in the agent list's order. */
export function useAgentsByMachine(): Map<string, Agent[]> {
  const agents = useAgentStore((s) => s.agents);
  return useMemo(() => {
    const byMachine = new Map<string, Agent[]>();
    for (const agent of agents) {
      if (agent.deletedAt || !agent.machineId) continue;
      const list = byMachine.get(agent.machineId);
      if (list) list.push(agent);
      else byMachine.set(agent.machineId, [agent]);
    }
    return byMachine;
  }, [agents]);
}
