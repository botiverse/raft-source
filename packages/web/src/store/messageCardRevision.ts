// RFC 082: a card message's copies carry the card's revision. The sync log's
// copy and the live update can cross, so every place that holds a card message
// (the conversation's rows, a thread's reply scope) keeps the newer revision:
// an older one never replaces it.

import { isMessageCardMetadata } from "@botiverse/raft-shared";

/** The card revision a message's actionMetadata carries, if it is a card message. */
export function messageCardRevision(actionMetadata: unknown): number | undefined {
  return isMessageCardMetadata(actionMetadata) ? actionMetadata.revision : undefined;
}

/** True when both copies are card revisions and the incoming one is older than the held one. */
export function isOlderCardRevision(held: number | undefined, incoming: number | undefined): boolean {
  return held !== undefined && incoming !== undefined && incoming < held;
}
