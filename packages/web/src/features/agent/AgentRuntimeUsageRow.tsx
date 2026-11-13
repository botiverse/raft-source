import { useIntl } from "react-intl";
import { RuntimeUsageWindowList } from "../../components/machine/RuntimeUsageWindowList";
import { agentUsageWindows, useRuntimeUsageWindows } from "../../hooks/useRuntimeUsageWindows";
import { InfoRow } from "./InfoRow";

/**
 * Runtime config's Usage row: the windows of the runtime's account on the
 * agent's Computer that can hold this agent (for Antigravity, its model's
 * group's and the account's, `agentUsageWindows`); none while there is
 * nothing to show.
 */
export function AgentRuntimeUsageRow({ model, ...props }: { enabled: boolean; serverId: string | null; machineId: string; runtimeId: string; model: string | null | undefined }) {
  const { formatMessage } = useIntl();
  const windows = agentUsageWindows(useRuntimeUsageWindows(props), props.runtimeId, model);
  if (windows.length === 0) return null;
  return (
    <InfoRow label={formatMessage({ id: "agent.runtimeConfig.usage" })} testId="agent-runtime-usage">
      <RuntimeUsageWindowList windows={windows} />
    </InfoRow>
  );
}
