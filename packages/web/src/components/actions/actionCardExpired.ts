// When an action card is drawn expired, and the line under its title then
// (RFC 082 #proj-apps:#40: 30 days after it was prepared, or its type's own
// deadline). Display only: the server's 409 is the authority.

import { useIntl } from "react-intl";
import { isActionCardExpiryExempt } from "@botiverse/raft-shared";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";

/**
 * Whether the card is drawn expired: it ended `expired` (stored, or served so
 * once a card is past its 30 days), or it is still `prepared` past the
 * deadline the server served (`expiresAt`), as when it ran out while the page
 * was open. Evaluated on render, display only: it takes the buttons away, so
 * no dialog opens; the server's refusal is the authority, never this clock.
 */
export function isActionCardShownExpired(metadata: Pick<ActionCardMetadata, "state" | "expiresAt">, now: number = Date.now()): boolean {
  if (metadata.state === "expired") return true;
  if (metadata.state !== "prepared" || !metadata.expiresAt) return false;
  const at = Date.parse(metadata.expiresAt);
  return Number.isFinite(at) && now > at;
}

/**
 * The line under an expired card's title, but a question card's
 * (QuestionCardEndedLine):
 * - a person's request with its own deadline (a seat or Pro request) keeps
 *   its own line;
 * - a card a person sent under the 30-day rule (an owner's agent:create sent
 *   back after a seat request) says when it expired and to ask that person,
 *   by name (Kirby, #proj-apps:#40); to the person who sent it, to send a new
 *   one; if they are no longer a member here, it reads as an agent's card;
 * - any other card says when it expired and to ask the agent.
 * The time is written as the done line writes it (CommittedByLine). Null
 * without a date.
 */
export function useExpiredCardLine(metadata: ActionCardMetadata): string | null {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  const requester = useServerStore((state) => (
    metadata.requesterUserId ? state.members.find((member) => member.userId === metadata.requesterUserId) : undefined
  ));
  const viewerId = useAuthStore((state) => state.user?.id);
  if (metadata.requesterUserId && isActionCardExpiryExempt(metadata.action.type)) {
    return formatMessage({ id: "actionCard.person.expiredLine" });
  }
  // Served on a prepared card; a card stored expired keeps its own deadline in its action (assistant:owner_action).
  const own = (metadata.action as { expiresAt?: unknown }).expiresAt;
  const at = metadata.expiresAt ?? (typeof own === "string" ? own : null);
  if (!at) return null;
  const date = formatMessageTime(at);
  if (metadata.requesterUserId && metadata.requesterUserId === viewerId) {
    return formatMessage({ id: "actionCard.expiredLineOwn" }, { date });
  }
  if (metadata.requesterUserId && requester) {
    return formatMessage({ id: "actionCard.expiredLineFromPerson" }, { date, owner: requester.displayName || requester.name });
  }
  return formatMessage({ id: "actionCard.expiredLine" }, { date });
}
