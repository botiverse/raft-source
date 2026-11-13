import { Badge } from "@botiverse/raft-ui";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import ConfirmDialog from "../ConfirmDialog";
import { AppGrantAbilities } from "./AppGrantAbilities";
import type { AgentIntegrationItem, RevokeGrantFailure } from "./agentAppGrants";

/** Close on the confirm: every failure was refused, so there is nothing to try again. */
const CLOSE_ONLY = () => {};

/** Why one grant didn't revoke, under it: a refusal says retrying won't help; the rest say try again. */
function FailureReason({ failure }: { failure: RevokeGrantFailure }) {
  const { formatMessage } = useIntl();
  const lines = failure.kind === "unknown"
    ? [formatMessage({ id: "agent.apps.revokeNoAnswer" })]
    : [
      formatMessage({ id: failure.kind === "refused" ? "agent.apps.revokeRefusedLine" : "agent.apps.revokeServerFailed" }),
      ...(failure.reason ? [formatMessage({ id: "agent.apps.revokeServerSaid" }, { reason: failure.reason })] : []),
    ];
  return (
    <div className="text-footnote text-foreground-muted" data-testid="agent-app-revoke-reason">
      {lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  );
}

/**
 * Confirming an ordinary App's Revoke: every grant it takes, in plain words with the raw scopes
 * in small text. `whole` is the App's Revoke access (all its grants); otherwise one grant from
 * the App's details. Revoking can't be undone (tokens stop working and the App has to ask again),
 * so it asks first (Raft DS › Feedback, "Confirming"; a Dialog at size sm, red confirm).
 *
 * After a try where some grants didn't revoke, `failures` holds why for each, and the list holds
 * only those (the revoked ones are gone), each marked with its reason. Try again retries the ones
 * a retry can help; when every one was refused (403), the dialog only closes. Nothing is retried
 * without that press, so a write whose outcome is unknown is never repeated on its own.
 *
 * `finalFocus`: where focus goes when it closes after a revoke took the control that opened it.
 */
export function RevokeAppGrantsDialog({
  appName,
  whole,
  grants,
  failures,
  finalFocus,
  onConfirm,
  onClose,
}: {
  appName: string;
  whole: boolean;
  grants: readonly AgentIntegrationItem[];
  failures: Readonly<Record<string, RevokeGrantFailure>> | null;
  finalFocus: RefObject<HTMLElement | null>;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  // Some failed, and none of them is worth retrying: nothing left to do but read why and close.
  const onlyRefused = failures !== null && grants.length > 0 && grants.every((grant) => failures[grant.id]?.kind === "refused");
  return (
    <ConfirmDialog
      title={formatMessage({ id: whole ? "agent.apps.revokeConfirmTitle" : "agent.apps.revokeGrantConfirmTitle" })}
      plainMessage
      message={(
        <div className="stack-y-3">
          <Banner intent="destructive" withIcon role="note">
            {formatMessage({ id: whole ? "agent.apps.revokeConfirmMessage" : "agent.apps.revokeGrantConfirmMessage" }, { app: appName })}
          </Banner>
          {failures ? (
            <Banner intent="warning" data-testid="agent-app-revoke-partial-failure">
              {formatMessage({ id: "agent.apps.revokePartialFailed" }, { count: grants.length })}
            </Banner>
          ) : null}
          <ul
            className="m-0 list-none stack-y-2 p-0"
            aria-label={formatMessage({ id: "agent.apps.revokeListLabel" })}
            data-testid="agent-app-revoke-list"
          >
            {grants.map((grant) => {
              const failure = failures?.[grant.id];
              return (
                <li key={grant.id} className="stack-y-1" data-testid={`agent-app-revoke-item-${grant.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <AppGrantAbilities scopes={grant.scopes} />
                    {failure ? (
                      <Badge appearance="soft" variant="warning" className="shrink-0">
                        {formatMessage({ id: failure.kind === "refused" ? "agent.apps.revokeNotAllowed" : "agent.apps.revokeNotRevoked" })}
                      </Badge>
                    ) : null}
                  </div>
                  {failure ? <FailureReason failure={failure} /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      confirmLabel={formatMessage({ id: onlyRefused ? "common.close" : failures ? "agent.apps.revokeRetry" : "agent.apps.revokeConfirmLabel" })}
      confirmVariant={onlyRefused ? "outline" : "danger"}
      hideCancel={onlyRefused}
      loadingLabel={formatMessage({ id: "agent.apps.revoking" })}
      confirmTestId="agent-app-revoke-confirm"
      analyticsDialog="agent_app_revoke"
      closeOnConfirm={onlyRefused}
      onConfirm={onlyRefused ? CLOSE_ONLY : onConfirm}
      onClose={onClose}
      finalFocus={finalFocus}
    />
  );
}
