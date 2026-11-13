import { useIntl } from "react-intl";
import { useAgentCurrentActivityState, useAgentDisplayState } from "../../store/agentStore";
import StatusDot from "../../components/ui/StatusDot";
import Tooltip from "../../components/ui/Tooltip";
import { formatAgentDisplayStateText } from "../../utils/activity";
import { useToolStuckText, visibleToolStuck } from "../../components/agent/AgentToolStuckNotice";
import { AgentComputerOfflineStatusLink } from "../../components/agent/AgentComputerOfflineStatusLink";

// Isolated component — subscribes to a single agent's activity to avoid
// re-rendering the entire ChatPanel on any agent status change.
export function AgentDMStatus({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId);
  // task #25: stuck on one tool call reads as that, not as a plain "busy".
  const toolStuckText = useToolStuckText(visibleToolStuck(useAgentCurrentActivityState(agentId)?.toolStuck, displayState));
  const activityText = toolStuckText ?? formatAgentDisplayStateText(intl, displayState);
  return (
    <>
      <StatusDot activity={displayState.activity} external={displayState.isExternal && !displayState.isOnline} title={activityText} />
      {/* Computer offline (#triage:#206) or Computer update required: the words open that Computer. */}
      <Tooltip content={activityText}>
      {!toolStuckText && (displayState.blocked === "computer_offline" || displayState.blocked === "computer_too_old") ? (
        <AgentComputerOfflineStatusLink agentId={agentId} className="min-w-0 max-w-fit truncate font-mono text-mono-meta" testId={displayState.blocked === "computer_offline" ? "agent-dm-status-computer-offline" : "agent-dm-status-computer-too-old"}>
          {activityText}
        </AgentComputerOfflineStatusLink>
      ) : (
      <span
        className={`min-w-0 flex-1 max-w-fit truncate font-mono text-mono-meta ${toolStuckText ? "text-warning-strong" : "text-foreground-hint"}`}
        data-testid={toolStuckText ? "agent-dm-status-tool-stuck" : undefined}
      >
        {activityText}
      </span>
      )}
      </Tooltip>
    </>
  );
}
