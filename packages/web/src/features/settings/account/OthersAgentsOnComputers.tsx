/**
 * Delete Account's Needs action group "Others' agents on your computers"
 * (#triage:d10ace06): another member's agent bound to one of the person's
 * computers. The request revokes the computer's keys at once, so the agent
 * has to leave first, and only its owner can move it. The person's one
 * action is Notify Owner to Move It: Raft sends the owner a system message
 * (POST notify-agent-owners; the person sends nothing themselves), once per
 * agent per 24 hours. A row goes once GET stops listing the agent (it moved).
 * If the owner never does, the row says who else can act (Warden, RBAC): for
 * an ordinary agent, that server's owner or an admin can delete it, or on Pro
 * move it; another member's personal assistant only its owner can move (an
 * admin can only stop it), and once that owner has left an admin can delete
 * it. With `owner: null` nobody is notified: the button stays off and only
 * that line shows.
 */
import { Button } from "@botiverse/raft-ui";
import { Bot, Send } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";

import { AgentOwnerNotifyActions } from "../../computer/AgentOwnerNotifyActions";
import { canNotifyNow, ownerNow, useAgentOwnerNotify } from "../../computer/useAgentOwnerNotify";
import type { AgentOwnerNotifyState } from "../../computer/useAgentOwnerNotify";
import { notifyAgentOwners } from "./accountDeletionApi";
import type { OthersAgentOnComputer } from "./accountDeletionApi";
import { AccountDeletionChecklistRow } from "./AccountDeletionChecklistRow";

function OthersAgentRow({ agent, state, onNotify }: {
  agent: OthersAgentOnComputer;
  state: AgentOwnerNotifyState;
  onNotify: (agentIds: string[]) => void;
}) {
  const { formatMessage } = useIntl();
  const owner = ownerNow(state, agent);
  const where = { serverName: agent.server.name, computerName: agent.computer.name };

  return (
    <AccountDeletionChecklistRow
      icon={<Bot />}
      tone="todo"
      testId={`account-deletion-others-agent-${agent.id}`}
      name={agent.name}
      detail={owner
        ? formatMessage({ id: "accountDeletion.othersAgentDetail" }, { ownerName: owner.name, ...where })
        : formatMessage({ id: "accountDeletion.othersAgentDetailNoOwner" }, where)}
      outcome={formatMessage({ id: "accountDeletion.othersAgentMustMove" })}
    >
      <AgentOwnerNotifyActions agent={agent} state={state} onNotify={onNotify} testIdPrefix="account-deletion" />
    </AccountDeletionChecklistRow>
  );
}

export function OthersAgentsOnComputers({ agents, onChanged }: {
  /** The agents still on the person's computers: GET's, or the 409's until the next read. */
  agents: OthersAgentOnComputer[];
  /** A notify call settled: read the list again. */
  onChanged: () => void;
}) {
  const { formatMessage } = useIntl();
  const { state, notify } = useAgentOwnerNotify(notifyAgentOwners, onChanged);

  // Notify All: every row with an owner that may be reminded now.
  const notifiable = useMemo(() => agents.filter((agent) => canNotifyNow(state, agent)), [agents, state]);
  const withOwner = agents.filter((agent) => ownerNow(state, agent) !== null).length;
  const handleNotifyAll = useCallback(() => notify(notifiable.map((agent) => agent.id)), [notifiable, notify]);

  return (
    <section aria-labelledby="account-deletion-others-agents-title" data-testid="account-deletion-others-agents">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3">
        <h3 id="account-deletion-others-agents-title" className="m-0 text-footnote font-semibold text-foreground-muted">
          {formatMessage({ id: "accountDeletion.groupOthersAgents" }, { count: agents.length })}
        </h3>
        {withOwner > 1 ? (
          <Button
            type="button"
            variant="ghost"
            disabled={notifiable.length === 0}
            onClick={handleNotifyAll}
            data-testid="account-deletion-notify-all"
          >
            <Send size={14} />
            {formatMessage({ id: "accountDeletion.notifyAllOwners" })}
          </Button>
        ) : null}
      </div>
      <ul className="m-0 p-0">
        {agents.map((agent) => <OthersAgentRow key={agent.id} agent={agent} state={state} onNotify={notify} />)}
      </ul>
    </section>
  );
}
