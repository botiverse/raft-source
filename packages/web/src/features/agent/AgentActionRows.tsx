import { ListRow, ListRowBody, ListRowGroup, ListRowIcon, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Archive, Bug, Check, Copy, Play, RotateCcw, Square } from "lucide-react";
import CopyButton from "../../components/ui/CopyButton";
import type { CopyTextController } from "../../hooks/useCopyText";
import { useAgentStore, useAgentDisplayState } from "../../store/agentStore";
import { agentRuntimeControls, restartResetOffered } from "../../utils/agentBlockedState";

/**
 * The actions at the end of an agent's profile, for its managers: a card of
 * action rows with no heading, as at the end of a channel's details
 * (raft-design agent-profile.md "Actions", ListRow "An action's risk";
 * cindyz, #triage:f2e107f7). Only Archive agent, which can't be undone, is
 * red (`danger`); the others are ink. Stop agent and Restart / Reset interrupt
 * but can be undone, and warn in their confirmations.
 * Each keeps its confirmation, which the panel owns.
 */
export function AgentActionRows({
  agentId,
  isExternalAgent,
  canStopAgent,
  computerOffline,
  diagnosticCopyController,
  getDiagnosticInfo,
  onDiagnosticCopyError,
  onShowStopConfirm,
  onStartSettled,
  onShowResetDialog,
  onShowReportDialog,
  onShowArchiveConfirm,
}: {
  agentId: string;
  isExternalAgent: boolean;
  canStopAgent: boolean;
  computerOffline: boolean;
  diagnosticCopyController: CopyTextController;
  getDiagnosticInfo: () => string;
  onDiagnosticCopyError: () => void;
  onShowStopConfirm: () => void;
  onStartSettled: (error: unknown) => void;
  onShowResetDialog: () => void;
  /** Absent when issue reports aren't configured. */
  onShowReportDialog?: () => void;
  /** Absent for people who can't archive the agent. */
  onShowArchiveConfirm?: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ListRowGroup data-testid="agent-actions-group">
      {!isExternalAgent && (
        <>
          <AgentStartStopRow agentId={agentId} canStopAgent={canStopAgent} onShowStopConfirm={onShowStopConfirm} computerOffline={computerOffline} onStartSettled={onStartSettled} />
          {restartResetOffered(true, computerOffline) && (
            <ListRow variant="plain" onClick={onShowResetDialog} data-testid="agent-restart-reset-action">
              <ListRowIcon><RotateCcw /></ListRowIcon>
              <ListRowBody><ListRowTitle>{formatMessage({ id: "agent.detail.restartReset" })}</ListRowTitle></ListRowBody>
            </ListRow>
          )}
        </>
      )}
      <CopyButton controller={diagnosticCopyController} text={getDiagnosticInfo} onCopyError={onDiagnosticCopyError}>
        {({ copied, disabled, onClick, onMouseDown }) => (
          <ListRow variant="plain" onClick={onClick} onMouseDown={onMouseDown} disabled={disabled} data-testid="agent-copy-diagnostic-action">
            <ListRowIcon>{copied ? <Check /> : <Copy />}</ListRowIcon>
            <ListRowBody>
              <ListRowTitle>
                {formatMessage({ id: copied ? "agent.detail.diagnosticInfoCopied" : "agent.detail.copyDiagnosticInfo" })}
              </ListRowTitle>
            </ListRowBody>
          </ListRow>
        )}
      </CopyButton>
      {onShowReportDialog && (
        <ListRow variant="plain" onClick={onShowReportDialog} data-testid="agent-report-issue-action">
          <ListRowIcon><Bug /></ListRowIcon>
          <ListRowBody><ListRowTitle>{formatMessage({ id: "agent.reportIssue.title" })}</ListRowTitle></ListRowBody>
        </ListRow>
      )}
      {onShowArchiveConfirm && (
        <ListRow variant="plain" tone="danger" onClick={onShowArchiveConfirm} data-testid="agent-archive-button">
          <ListRowIcon><Archive /></ListRowIcon>
          <ListRowBody><ListRowTitle>{formatMessage({ id: "agent.detail.deleteAgent" })}</ListRowTitle></ListRowBody>
        </ListRow>
      )}
    </ListRowGroup>
  );
}

// Start or Stop agent; subscribes to this agent's activity only. No Start while the agent's Computer is offline
// (agentRuntimeControls, #triage:#206); a refusal goes to `onStartSettled`, as the profile header's Start does.
function AgentStartStopRow({ agentId, canStopAgent, onShowStopConfirm, computerOffline, onStartSettled }: {
  agentId: string;
  canStopAgent: boolean;
  onShowStopConfirm: () => void;
  computerOffline: boolean;
  onStartSettled: (error: unknown) => void;
}) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stoppedByPerson = useAgentStore((s) => s.agents.find((agent) => agent.id === agentId)?.status === "stopped");
  const handleStart = useCallback(() => {
    startAgent(agentId).then(() => onStartSettled(null), onStartSettled);
  }, [startAgent, agentId, onStartSettled]);
  const controls = agentRuntimeControls({ canControl: true, canStop: canStopAgent, isOnline: displayState.isOnline, computerOffline, stoppedByPerson });
  if (!controls.start && !controls.stop) return null;
  return controls.stop ? (
    <ListRow variant="plain" onClick={onShowStopConfirm} data-testid="agent-stop-action">
      <ListRowIcon><Square /></ListRowIcon>
      <ListRowBody><ListRowTitle>{formatMessage({ id: "agent.detail.stopAgent" })}</ListRowTitle></ListRowBody>
    </ListRow>
  ) : (
    <ListRow variant="plain" onClick={handleStart} data-testid="agent-start-action">
      <ListRowIcon><Play /></ListRowIcon>
      <ListRowBody><ListRowTitle>{formatMessage({ id: "agent.detail.startAgent" })}</ListRowTitle></ListRowBody>
    </ListRow>
  );
}
