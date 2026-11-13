import type { AgentCreatedSummary, AgentDisplayState } from "../../store/agentStore";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useProfileStore } from "../../store/profileStore";

/**
 * One row in "Created agents". Split out so the row's click handler is bound
 * to its own agent id.
 */
export function CreatedAgentRow({
  createdAgent,
  displayState,
  activityText,
  onOpenProfile,
}: {
  createdAgent: AgentCreatedSummary;
  displayState: AgentDisplayState;
  activityText: string;
  onOpenProfile?: (type: "agent" | "human", id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const deprecatedHere = useRuntimeDeprecatedHere();
  const agentId = createdAgent.id;
  const handleClick = useCallback(() => {
    if (onOpenProfile) {
      onOpenProfile("agent", agentId);
      return;
    }
    useProfileStore.getState().openProfile("agent", agentId);
  }, [agentId, onOpenProfile]);

  return (
    <AvatarListRow
      avatar={
        <AvatarSlot
          context="list-row"
          type="agent"
          agentAvatarUrl={createdAgent.avatarUrl}
        />
      }
      name={createdAgent.displayName || createdAgent.name}
      subtitle={formatRuntimeLabelWithStatus(createdAgent.runtime, formatMessage, deprecatedHere(createdAgent.runtime))}
      rightContent={
        <StatusDot
          activity={displayState.activity}
          title={activityText}
        />
      }
      onClick={handleClick}
    />
  );
}
