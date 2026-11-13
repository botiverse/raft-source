/**
 * Under one of other people's agents on the person's computer
 * (#triage:d10ace06): Notify Owner to Move It (Raft sends the owner a system
 * message; the person sends nothing themselves), Remind Again after a reminder,
 * off until the once-a-day limit passes (`ownerNextNotifyAt`, or the call's
 * own `rate_limited`) with when they can remind again, a retry line when it
 * failed, and who else can act if the owner never does (Warden, RBAC): for an
 * ordinary agent, that server's owner or an admin can delete it, or on Pro move
 * it; another member's personal assistant only its owner can move (an admin
 * can only stop it), and once that owner has left an admin can delete it.
 * With no owner nobody is notified: the button stays off and only that line
 * shows. Delete Account's rows and the computer's own delete both draw it.
 */
import { Button } from "@botiverse/raft-ui";
import { Check, Send } from "lucide-react";
import { useCallback, useId } from "react";
import { useIntl } from "react-intl";

import type { MessageId } from "../../i18n/messages";
import { formatRelativeTime } from "../../utils/relativeTime";
import type { OthersAgent } from "./othersAgentsApi";
import { nextReminder, ownerNow } from "./useAgentOwnerNotify";
import type { AgentOwnerNotifyState } from "./useAgentOwnerNotify";

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

/** The last line: who can act if the owner never does. */
function whoElseCanAct(personalAssistant: boolean, hasOwner: boolean): MessageId {
  if (personalAssistant) return hasOwner ? "machine.othersAgents.assistantOwnerOnly" : "machine.othersAgents.assistantNoOwner";
  return hasOwner ? "machine.othersAgents.contactAdmin" : "machine.othersAgents.noOwnerContactAdmin";
}

export function AgentOwnerNotifyActions({ agent, state, onNotify, testIdPrefix }: {
  agent: OthersAgent;
  state: AgentOwnerNotifyState;
  onNotify: (agentIds: string[]) => void;
  /** The screen's test ids: `<prefix>-notify-<agentId>` and so on. */
  testIdPrefix: string;
}) {
  const { formatMessage, locale } = useIntl();
  const contactId = useId();
  const owner = ownerNow(state, agent);
  const notifiedAt = later(agent.ownerNotifiedAt, state.notifiedAt.get(agent.id) ?? null);
  const { limited, at: nextAllowedAt } = nextReminder(state, agent);
  const handleNotify = useCallback(() => onNotify([agent.id]), [agent.id, onNotify]);

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          type="button"
          variant="outline"
          loading={state.busy.has(agent.id)}
          loadingLabel={formatMessage({ id: "machine.othersAgents.notifyingOwner" })}
          disabled={!owner || limited}
          aria-describedby={owner ? undefined : contactId}
          onClick={handleNotify}
          data-testid={`${testIdPrefix}-notify-${agent.id}`}
        >
          <Send size={14} />
          {formatMessage({ id: notifiedAt && owner ? "machine.othersAgents.notifyOwnerAgain" : "machine.othersAgents.notifyOwner" })}
        </Button>
        {owner && notifiedAt ? (
          <span className="inline-flex items-center gap-1 text-callout text-foreground-muted" data-testid={`${testIdPrefix}-notified-${agent.id}`}>
            <Check aria-hidden className="size-4 shrink-0 text-success-strong" />
            {formatMessage({ id: "machine.othersAgents.ownerNotified" }, { time: formatRelativeTime(notifiedAt, locale) ?? "" })}
          </span>
        ) : null}
        {owner && limited ? (
          <span className="text-callout text-foreground-muted" data-testid={`${testIdPrefix}-next-reminder-${agent.id}`}>
            {nextAllowedAt
              ? formatMessage({ id: "machine.othersAgents.remindAgainAt" }, { time: formatRelativeTime(nextAllowedAt, locale) ?? "" })
              : formatMessage({ id: "machine.othersAgents.remindOncePerDay" })}
          </span>
        ) : null}
      </div>
      {state.failed.has(agent.id) || state.undelivered.has(agent.id) ? (
        <p className="m-0 text-callout text-foreground-muted">
          <span className="text-danger" role="alert">
            {formatMessage({ id: state.undelivered.has(agent.id) ? "machine.othersAgents.notifyNotDelivered" : "machine.othersAgents.notifyFailed" })}
          </span>
        </p>
      ) : null}
      <p id={contactId} className="m-0 mt-1 text-footnote text-foreground-hint" data-testid={`${testIdPrefix}-others-agent-contact-${agent.id}`}>
        {formatMessage({ id: whoElseCanAct(agent.personalAssistant, owner !== null) })}
      </p>
    </>
  );
}
