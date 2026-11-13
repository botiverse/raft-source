// Agent-facing text for card messages (RFC 082): what a card update answers,
// and a card send that stored no card, one wording for the CLI (`raft message
// update-card`, `raft message send --card`) and the SDK (`messages.updateCard`
// and `messages.send` outcome text).

import { foldAgentOneLineText } from "../agentMessageText";

export interface AgentMessageCardUpdatedText {
  messageId: string;
  revision: number;
  /** The Server's "Updating notifies no one. …" (formatMessageCardUpdateNotice). */
  notice: string;
  /** The same card and text were already there (an earlier run's update landed): nothing changed now. */
  alreadyApplied?: boolean;
}

/**
 * `Card updated: message 1a2b3c4d is now at revision 3 (next update:
 * --expected-revision 3).` and, on the next
 * line, that nobody was told (naming each @mention of the new text).
 */
export function formatAgentMessageCardUpdated(input: AgentMessageCardUpdatedText): string {
  const short = input.messageId.slice(0, 8);
  const lead = input.alreadyApplied
    ? `Card already updated: message ${short} is at revision ${input.revision} with this card and text. An earlier run made the change; nothing changed now (next update: --expected-revision ${input.revision}).`
    : `Card updated: message ${short} is now at revision ${input.revision} (next update: --expected-revision ${input.revision}).`;
  return `${lead}\n${foldAgentOneLineText(input.notice)}`;
}

/**
 * A send with a card whose answer has no `messageCard`: the text was sent but
 * no card was stored (a Server older than card messages ignores `card` and
 * posts the text with the same success). Part of the success output, not an
 * error: the message went out.
 */
export const AGENT_MESSAGE_CARD_NOT_STORED_NOTICE =
  "Sent as text only: this Server stored no card (it may be older than card messages). The card wasn't shown; send it again where card messages are on.";
