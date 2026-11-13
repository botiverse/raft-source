/**
 * Force-unbinding other people's agents from the person's computers: the
 * confirmation (#triage:d10ace06, Tenny and Archer). The agents are
 * unbound, not deleted: their workspaces on those computers are lost, the
 * agents keep their messages and settings, and each owner gets a system
 * notice. Lists every affected agent with its owner ("No owner" when no
 * person created it) and computer, so the caller sends exactly this list.
 *
 * Delete Account uses it (Force Unbind and Request Deletion, the request's
 * `forceAgentIds`), and so does deleting a computer the person attached
 * (Force Unbind and Delete, the revoke's `forceAgentIds`; DeleteComputerDialog).
 * The shared destructive confirm at the confirmation width (ConfirmDialog, red
 * confirm button, the consequence in its danger banner). An `onConfirm` that
 * rejects keeps it open with the reason in an orange banner: a newer list
 * (more agents arrived) comes back as new `agents` with that rejection.
 */
import { Bot } from "lucide-react";
import { useIntl } from "react-intl";

import Banner from "../../components/ui/Banner";
import ConfirmDialog from "../../components/ConfirmDialog";

export interface ForceUnbindAgent {
  id: string;
  name: string;
  owner: { id: string; name: string } | null;
  computer: { id: string; name: string };
}

export function ForceUnbindAgentsDialog({ agents, confirmLabel, onConfirm, onClose }: {
  /** Every agent the confirm unbinds, in the order shown. */
  agents: ForceUnbindAgent[];
  /** The caller's action, as on the button that opened it. */
  confirmLabel: string;
  /** Rejects with the failure to show; resolves to close. */
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "machine.forceUnbind.title" }, { count: agents.length })}
      plainMessage
      message={(
        <div className="stack-y-3" data-testid="force-unbind-dialog-body">
          <Banner intent="destructive" withIcon role="note">
            {formatMessage({ id: "machine.forceUnbind.message" })}
          </Banner>
          <ul className="m-0 stack-y-2 p-0" aria-label={formatMessage({ id: "machine.forceUnbind.listLabel" })}>
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-start gap-2.5" data-testid={`force-unbind-agent-${agent.id}`}>
                <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
                <div className="min-w-0 wrap-break-word">
                  <div className="text-body font-semibold text-foreground">{agent.name}</div>
                  <div className="text-callout text-foreground-muted">
                    {agent.owner
                      ? formatMessage({ id: "machine.forceUnbind.agentMeta" }, { ownerName: agent.owner.name, computerName: agent.computer.name })
                      : formatMessage({ id: "machine.forceUnbind.agentMetaNoOwner" }, { computerName: agent.computer.name })}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      confirmLabel={confirmLabel}
      confirmVariant="danger"
      loadingLabel={formatMessage({ id: "machine.forceUnbind.unbinding" })}
      confirmTestId="force-unbind-confirm"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
