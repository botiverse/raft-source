import { useIntl } from "react-intl";
import { useAgentCurrentActivityState, useAgentDisplayState } from "../../store/agentStore";
import StatusDot from "../../components/ui/StatusDot";
import Tooltip from "../../components/ui/Tooltip";
import { formatAgentDisplayStateText } from "../../utils/activity";
import { useToolStuckText, visibleToolStuck } from "../../components/agent/AgentToolStuckNotice";
import { AgentComputerOfflineStatusLink } from "../../components/agent/AgentComputerOfflineStatusLink";
import { useAgentRuntimeSignInNeeded } from "../../components/agent/useAgentRuntimeSignInNeeded";
import { RuntimeSignInAction } from "../../components/machine/RuntimeSignInAction";
import { useMediaQuery } from "../../hooks/effectPrimitives";

// Isolated component — subscribes to a single agent's activity to avoid
// re-rendering the entire ChatPanel on any agent status change.
export function AgentDMStatus({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId);
  // task #25: stuck on one tool call reads as that, not as a plain "busy".
  const toolStuckText = useToolStuckText(visibleToolStuck(useAgentCurrentActivityState(agentId)?.toolStuck, displayState));
  const activityText = toolStuckText ?? formatAgentDisplayStateText(intl, displayState);
  // #triage:#494: a start waiting for the runtime's sign-in: the error light,
  // "Sign-in needed for <runtime>" ("Sign-in needed" on a phone) with the sentence on hover in place of the
  // daemon's, and Sign in for whoever can act on the agent's Computer.
  const signIn = useAgentRuntimeSignInNeeded(agentId, displayState);
  // A phone's header (below md) has room only for "Sign-in needed"; the
  // runtime is named in the sentence on hover/press (Cat, PR #15282).
  const wide = useMediaQuery("(min-width: 768px)", true);
  if (signIn && !toolStuckText) {
    return (
      <>
        <StatusDot presence="error" title={signIn.detail} />
        <Tooltip content={signIn.detail}>
          <span className="min-w-0 flex-1 max-w-fit truncate font-mono text-mono-meta text-foreground-hint" data-testid="agent-dm-status-sign-in-needed">
            {wide ? signIn.fullText : signIn.shortText}
          </span>
        </Tooltip>
        {/* The sentence for a screen reader and the keyboard (the tooltip is hover only). */}
        <span className="sr-only" data-testid="agent-dm-status-sign-in-detail">{signIn.detail}</span>
        <RuntimeSignInAction machineId={signIn.machineId} runtimeId={signIn.runtimeId} testId="agent-dm-status-sign-in" />
      </>
    );
  }
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
