// Who a question card (`question:ask`) asks, or who a request card
// (`request:prepare`, RFC 085) is for, as the frame names them: by the
// person's id, never by the handle the agent wrote (stored with the agent's
// capitalization). Either way only that person acts on the card.

import { useIntl } from "react-intl";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";

/**
 * The person a question card asks or a request card is for (lowercase id), or
 * null: anyone in the channel, another type, or not resolved yet.
 */
export function questionAddresseeId(metadata: ActionCardMetadata): string | null {
  const action = metadata.action;
  if (action.type === "request:prepare") return action.addressee.userId.toLowerCase();
  return action.type === "question:ask" && action.addressee?.kind === "user" ? action.addressee.userId.toLowerCase() : null;
}

/**
 * The name of the person a question card asks (or a request card is for), as this viewer knows them (a
 * member of the server, by id: never the handle the agent wrote, whose
 * capitalization is the agent's), else `fallback`, else "Someone". Null when
 * the card asks no one person.
 */
export function useQuestionAddresseeName(metadata: ActionCardMetadata, fallback?: string): string | null {
  const { formatMessage } = useIntl();
  const addresseeId = questionAddresseeId(metadata);
  const member = useServerStore((state) => addresseeId ? state.members.find((candidate) => candidate.userId.toLowerCase() === addresseeId) : undefined);
  if (!addresseeId) return null;
  return member?.displayName || member?.name || fallback || formatMessage({ id: "actionCard.person.someone" });
}
