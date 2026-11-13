import { useIntl } from "react-intl";
import { useMachineStore } from "../../store/machineStore";
import { useAgentsByMachine } from "./useAgentsByMachine";

/** "15 computers · 13 online · 54 agents", in the header's machine type. */
export function ComputersRackCounts({ className = "" }: { className?: string }) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const agentsByMachine = useAgentsByMachine();
  const online = machines.filter((machine) => machine.status === "online").length;
  let agentCount = 0;
  for (const machine of machines) agentCount += agentsByMachine.get(machine.id)?.length ?? 0;
  // #68: the server's "needs attention" summary; an older server sends none, and nothing is added.
  const summarized = machines.some((machine) => machine.attention);
  const attention = machines.filter((machine) => (machine.attention?.count ?? 0) > 0).length;
  return (
    <span className={`truncate font-mono text-mono-meta text-foreground-hint ${className}`} data-testid="computers-rack-counts">
      {[
        formatMessage({ id: "machine.rack.computerCount" }, { count: machines.length }),
        formatMessage({ id: "machine.rack.onlineCount" }, { count: online }),
        formatMessage({ id: "machine.rack.agentCount" }, { count: agentCount }),
        ...(summarized && attention > 0 ? [formatMessage({ id: "readiness.attention.count" }, { count: attention })] : []),
      ].join(" · ")}
    </span>
  );
}
