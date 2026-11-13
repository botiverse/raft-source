// Raft's notes on where an agent-inbound app may send, as notices. A spec's
// ScopeList draws them just before its scope list (ActionCardSpecRenderer).

import { useIntl } from "react-intl";
import { MessageActionCardNotice } from "@botiverse/raft-ui";
import {
  AGENT_INBOUND_CANNOT_SUMMARY_ID,
  hasAgentInboundOAuthScope,
  normalizeVisibleOAuthScopes,
} from "../../lib/oauthScopePresentation";

/** Where an agent-inbound app may send, as notices that open the card. */
export function ActionCardScopeNotices({ scopes, agentName }: { scopes: readonly string[]; agentName?: string }) {
  const { formatMessage } = useIntl();
  if (!hasAgentInboundOAuthScope(normalizeVisibleOAuthScopes(scopes))) return null;
  return (
    <>
      {agentName ? (
        <MessageActionCardNotice>
          {formatMessage({ id: "actionCard.willSendTo" }, { agent: agentName })}
        </MessageActionCardNotice>
      ) : null}
      <MessageActionCardNotice>{formatMessage({ id: AGENT_INBOUND_CANNOT_SUMMARY_ID })}</MessageActionCardNotice>
    </>
  );
}
