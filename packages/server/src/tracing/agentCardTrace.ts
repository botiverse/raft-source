import { agentRequestContextFromHeaders } from "./agentContextReturnTrace";
import { traceIdentityHash } from "./traceIdentity";

// Glimpse, the card check at send time: one event per card a send carries
// `seenCards.<card>` for (`agent_api_send.channel_card.evaluated`,
// `agent_api_send.peer_card.evaluated`); null (not seen) included.
// A card is held at most once per (agent, card, model context): the client
// records the card it was shown, and its next send there names that version.
// A second hold for the same key means the record did not happen, so the key
// is on the event: the card's conversation hashed (a thread's card is its
// parent channel's or DM's), the context as the daemon sent it, and whether
// the send named a version at all. The agent hash is on the request span.

export type CardEvaluationOutcome = "seen" | "changed" | "held" | "unseen_not_held";

export function cardEvaluatedAttrs(input: {
  outcome: CardEvaluationOutcome;
  targetType: string;
  /** The send's conversation (a thread is its own), as layer 1 hashes it. */
  channelId: string;
  /** The conversation the card belongs to; null when it was not looked up (a peer card the send named a version of) or there is none. */
  cardChannelId: string | null;
  headers: Record<string, unknown>;
  /** The send named a version this context saw (`seenCards.<card>` not null). */
  seenCardPresent: boolean;
}): Record<string, string | boolean> {
  const { contextId } = agentRequestContextFromHeaders(input.headers);
  const conversationIdHash = traceIdentityHash("conversation_id_hash", input.channelId);
  const cardConversationIdHash = input.cardChannelId ? traceIdentityHash("conversation_id_hash", input.cardChannelId) : null;
  return {
    outcome: input.outcome,
    target_type: input.targetType,
    seen_card_present: input.seenCardPresent,
    context_id_present: Boolean(contextId),
    ...(contextId ? { context_id: contextId } : {}),
    ...(conversationIdHash ? { conversation_id_hash: conversationIdHash } : {}),
    ...(cardConversationIdHash ? { card_conversation_id_hash: cardConversationIdHash } : {}),
  };
}
