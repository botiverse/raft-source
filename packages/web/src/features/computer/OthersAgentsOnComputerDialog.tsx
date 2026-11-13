/**
 * Deleting a computer the person attached, while other people's agents are on
 * it (the revoke's 409 `others_agents_on_computer`, #triage:d10ace06): only
 * their owners can move them. Lists each with its owner (or No owner) and
 * Notify Owner to Move It (AgentOwnerNotifyActions, as on Delete Account), and
 * offers Force Unbind and Delete, which opens the destructive confirm
 * (ForceUnbindAgentsDialog). That button is outline: only the confirm's own
 * button is red (design-system owner on #12799). A list with a control per
 * row is a small task, not a confirmation: Dialog `md` (the force confirm
 * stays at the confirmation width).
 */
import { Bot } from "lucide-react";
import { useIntl } from "react-intl";

import ConfirmDialog from "../../components/ConfirmDialog";
import { AgentOwnerNotifyActions } from "./AgentOwnerNotifyActions";
import type { OthersAgent } from "./othersAgentsApi";
import { ownerNow } from "./useAgentOwnerNotify";
import type { AgentOwnerNotifyState } from "./useAgentOwnerNotify";

export function OthersAgentsOnComputerDialog({ agents, notifyState, onNotify, onForceUnbind, onClose }: {
  /** The 409's list, the newest one. */
  agents: OthersAgent[];
  notifyState: AgentOwnerNotifyState;
  onNotify: (agentIds: string[]) => void;
  /** Opens the force confirm for exactly `agents`. */
  onForceUnbind: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.othersAgents.title" })}
      size="md"
      plainMessage
      message={(
        <div className="stack-y-3" data-testid="computer-others-agents-dialog">
          <p className="m-0 text-subhead text-foreground-muted">{formatMessage({ id: "machine.othersAgents.message" })}</p>
          <ul className="m-0 stack-y-3 p-0" aria-label={formatMessage({ id: "machine.othersAgents.listLabel" })}>
            {agents.map((agent) => {
              const owner = ownerNow(notifyState, agent);
              return (
                <li key={agent.id} className="flex items-start gap-2.5" data-testid={`computer-others-agent-${agent.id}`}>
                  <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                  <div className="min-w-0 flex-1 wrap-break-word">
                    <div className="text-body font-semibold text-foreground">{agent.name}</div>
                    <div className="text-callout text-foreground-muted">
                      {owner
                        ? formatMessage({ id: "machine.othersAgents.owner" }, { ownerName: owner.name })
                        : formatMessage({ id: "machine.othersAgents.noOwner" })}
                    </div>
                    <AgentOwnerNotifyActions agent={agent} state={notifyState} onNotify={onNotify} testIdPrefix="computer" />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      confirmLabel={formatMessage({ id: "machine.othersAgents.forceUnbindAndDelete" })}
      confirmVariant="outline"
      confirmTestId="computer-others-agents-force"
      closeOnConfirm={false}
      onConfirm={onForceUnbind}
      onClose={onClose}
    />
  );
}
