// RFC 082: a card message's copies carry the card's revision. The sync log's
// copy and the live update can cross, so every place that holds a card message
// (the conversation's rows, a thread's reply scope) keeps the newer revision:
// an older one never replaces it.

import { isMessageCardMetadata } from "@botiverse/raft-shared";

/** The card revision a message's actionMetadata carries, if it is a card message. */
export function messageCardRevision(actionMetadata: unknown): number | undefined {
  return isMessageCardMetadata(actionMetadata) ? actionMetadata.revision : undefined;
}

const TERMINAL_ACTION_CARD_STATES = new Set(["executed", "withdrawn", "expired"]);

function actionCardState(actionMetadata: unknown): string | undefined {
  if (!actionMetadata || typeof actionMetadata !== "object") return undefined;
  const candidate = actionMetadata as { kind?: unknown; state?: unknown };
  return candidate.kind === "action-card" && typeof candidate.state === "string" ? candidate.state : undefined;
}

/** True when `held` is an action card in a terminal state (`executed`, `withdrawn`, `expired`) and `incoming` would regress it to a non-terminal state. */
export function isRegressingActionCardState(held: unknown, incoming: unknown): boolean {
  const heldState = actionCardState(held);
  const incomingState = actionCardState(incoming);
  return heldState !== undefined
    && incomingState !== undefined
    && TERMINAL_ACTION_CARD_STATES.has(heldState)
    && !TERMINAL_ACTION_CARD_STATES.has(incomingState);
}

/** True when both copies are card revisions and the incoming one is older than the held one. */
export function isOlderCardRevision(held: number | undefined, incoming: number | undefined): boolean {
  return held !== undefined && incoming !== undefined && incoming < held;
}
