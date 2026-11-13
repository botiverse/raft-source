// Card messages (RFC 082 §5): which messages the web draws as a card. The
// card is `actionMetadata.card` of a message whose kind is `message-card`,
// read through the shared stored-card schema (messageCard.ts) every time it
// arrives: the list, `message:updated`, the sync log's `message` entity. A
// message this client cannot draw (another kind, a card it can't read, a
// revision it doesn't understand) is drawn as its `content`, the fallback
// text, like any message: never a blank card, never Raft's action card.

import { isMessageCardMetadata, messageCardSchema } from "@botiverse/raft-shared";
import type { MessageCard } from "@botiverse/raft-shared";

export interface ReadMessageCard {
  card: MessageCard;
  revision: number;
  /** ISO UTC; when the card was posted or last replaced. Null: not a time this client can read. */
  updatedAt: string | null;
}

// By the metadata object: a message's row keeps its object until it changes.
const cache = new WeakMap<object, ReadMessageCard | null>();

/** The card to draw for a message's `actionMetadata`; null: draw its `content`. */
export function readMessageCard(actionMetadata: unknown): ReadMessageCard | null {
  if (!actionMetadata || typeof actionMetadata !== "object") return null;
  if (cache.has(actionMetadata)) return cache.get(actionMetadata) ?? null;
  let read: ReadMessageCard | null = null;
  if (isMessageCardMetadata(actionMetadata)) {
    const parsed = messageCardSchema.safeParse(actionMetadata.card);
    const updatedAt = typeof actionMetadata.updatedAt === "string" && Number.isFinite(Date.parse(actionMetadata.updatedAt))
      ? actionMetadata.updatedAt
      : null;
    if (parsed.success) read = { card: parsed.data, revision: actionMetadata.revision, updatedAt };
  }
  cache.set(actionMetadata, read);
  return read;
}

/** Whether the card says when it was last updated: once it has been replaced (RFC 082 §5). */
export function messageCardShowsUpdated(read: ReadMessageCard): read is ReadMessageCard & { updatedAt: string } {
  return read.revision > 1 && read.updatedAt !== null;
}

