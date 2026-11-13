// A card prepared more than ACTION_CARD_EXPIRY_MS ago (30 days,
// #proj-apps:#40) can no longer be completed by a press that causes the
// effect: execute and its forms, a feedback card's send, and reconfirm refuse
// it with 409 ACTION_CARD_EXPIRED before anything is written or sent.
// mark-executed is never refused: it records what a dialog already did with
// the clicker's own permissions. Reads serve the deadline (`expiresAt`) on
// every prepared card, and `state: "expired"` once a 30-day card is past it;
// nothing is stored, the row stays `prepared`. An exempt type keeps its own
// rule (shared isActionCardExpiryExempt). Its own module so actionCardsService
// and actionCardConversionService can both use it without importing each
// other.

import {
  ACTION_CARD_EXPIRED_ERROR_CODE,
  ACTION_CARD_EXPIRY_MS,
  actionCardExpiresAt,
  isActionCardExpiryExempt,
  isActionCardPastExpiry,
} from "@botiverse/raft-shared";

/** "2026-10-31 09:30 UTC": the server knows no viewer's time zone or locale. */
function expiryForMessage(expiresAt: string): string {
  return `${expiresAt.slice(0, 10)} ${expiresAt.slice(11, 16)} UTC`;
}

/** 409 ACTION_CARD_EXPIRED; the routes send `{ error, errorCode }`, as for every card refusal. */
export class ActionCardExpiredError extends Error {
  readonly status = 409 as const;
  readonly code = ACTION_CARD_EXPIRED_ERROR_CODE;

  constructor(readonly expiresAt: string) {
    super(`This request expired on ${expiryForMessage(expiresAt)}. Ask the agent to send a new request.`);
    this.name = "ActionCardExpiredError";
  }
}

/** Throws ActionCardExpiredError for a card past its 30 days; `createdAt` is action_cards.created_at, when it was prepared. */
export function assertActionCardNotExpired(card: { actionType: string; createdAt: Date }): void {
  if (!isActionCardPastExpiry(card)) return;
  throw new ActionCardExpiredError(new Date(card.createdAt.getTime() + ACTION_CARD_EXPIRY_MS).toISOString());
}

/** What a read knows of a card's row: when it was prepared, and who asked (a person's plan:upgrade has its own deadline). */
export interface ActionCardPreparedFacts {
  createdAt: Date;
  requesterUserId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Action-card metadata as a client is served it: a `prepared` card with its
 * deadline (`expiresAt`, shared actionCardExpiresAt), and a 30-day card past
 * it as `expired`. Only for responses and broadcasts, never for what is
 * stored: reconfirm stores what withStoredActionCardSpec returns, so this is
 * applied after that, where a card is served. Pure; anything else, or no
 * `card`, is returned as is.
 */
export function servedActionCardMetadata<T>(metadata: T, card: ActionCardPreparedFacts | undefined, now: number = Date.now()): T {
  if (!card || !isRecord(metadata) || metadata.kind !== "action-card" || metadata.state !== "prepared") return metadata;
  const action = metadata.action;
  if (!isRecord(action) || typeof action.type !== "string") return metadata;
  const type = action.type;
  const expiresAt = actionCardExpiresAt({ action: { ...action, type }, requesterUserId: card.requesterUserId, createdAt: card.createdAt });
  if (!expiresAt) return metadata;
  const expired = !isActionCardExpiryExempt(type) && now > Date.parse(expiresAt);
  return { ...metadata, expiresAt, ...(expired ? { state: "expired" } : {}) };
}
