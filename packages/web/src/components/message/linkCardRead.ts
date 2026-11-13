import { parseLinkCardReadAnswer } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardCapability, LinkCardReadAnswerItem, LinkCardReadAnswerTicket } from "@botiverse/raft-shared/src/appLinkPreview";
import api from "../../api/client";

// The transport under useAppLinkPreviews for interactive link cards (RFC 076
// §6.1; protocol v3.2.3 §4.1, §7.1): the batched read of one message's App
// links, or the GET where the Server's flag is off.
// docs/development/app-link-previews.md, "Web display".

/**
 * What this client declares (protocol §11.2, RFC 076 §6.6): version 2 cards,
 * their inline titles and the inline badge's card tones (`inline.tone.v2`),
 * the cards' buttons with Raft's confirm dialog and undo window, and version 3
 * items (`preview.v3`, RFC 076 §14), which the web draws in full: the chip,
 * the hover card and the block card after the link's paragraph
 * (AppLinkBlockCard.tsx). With `preview.v3` Raft sends only version 3, so
 * `block.v1` changes nothing Raft sends this client; it is declared because
 * the web draws block cards, so an App that checks it before asking for one
 * gets it (raft-design Navigation › What an app's answer lists).
 *
 * Every device declares the same list, a touch-only one too (RFC 076 §13,
 * AppFather): a block card's buttons work by keyboard and touch, on desktop
 * and phone. Only the hover card stays read-only on touch, where it doesn't
 * open (LinkCardActions); the handles it isn't used for are harmless.
 */
export const LINK_CARD_READ_CAPABILITIES: readonly LinkCardCapability[] = ["card.v2", "inline.v1", "inline.tone.v2", "button.v1", "confirm.v1", "undo.v1", "block.v1", "preview.v3"];

/**
 * A touch-only device: it can tap (`any-pointer: coarse`, the query the chip
 * shows its domain by) and nothing it has can hover, so no hover card opens
 * and the hover card draws no buttons (LinkCardActions). A touch laptop has a
 * hover-capable pointer.
 */
export const LINK_CARD_COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const LINK_CARD_HOVER_QUERY = "(any-hover: hover)";

export function linkCardReadCapabilities(): readonly LinkCardCapability[] {
  return LINK_CARD_READ_CAPABILITIES;
}

/**
 * One mounted message view (protocol §7.1): the id Raft binds its tickets to,
 * the count of reads it has sent (only the latest one's answer is taken), and
 * the ticket Raft gave it per link, sent back on its next read.
 */
export type LinkCardView = { id: string; seq: number; tickets: Map<string, LinkCardReadAnswerTicket> };

/** A new view, or null where the browser can't make a UUID (the GET reads instead). */
export function newLinkCardView(): LinkCardView | null {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? { id: uuid, seq: 0, tickets: new Map() } : null;
}

/**
 * Execute X is being sent (protocol §7.1): the view's count moves on, so a read
 * sent before X is no longer the latest and its answer is dropped.
 */
export function bumpLinkCardViewSeq(view: LinkCardView) {
  view.seq += 1;
}

export type MessageLinksRead =
  | { batched: true; items: LinkCardReadAnswerItem[]; data: unknown }
  | { batched: false; data: unknown };

/**
 * One read of a message's App links. With a view (the flag is on): the batched
 * read, with this client's capabilities, the UI's language, the view's tickets
 * and, to read some links again, `urls`. Tickets in the answer replace the
 * view's. An answer to a request that is no longer the view's latest is null.
 * Without a view: the GET (a re-read of some links has no GET form, and is
 * null). A 404 is the message not being previewable, and fails like any error.
 */
export async function readMessageLinks({ messageId, view, locale, urls, signal }: {
  messageId: string;
  view: LinkCardView | null;
  locale: string;
  urls?: string[];
  signal: AbortSignal;
}): Promise<MessageLinksRead | null> {
  const get = async (): Promise<MessageLinksRead> => ({ batched: false, data: (await api.get(`/messages/${messageId}/app-link-previews`, { signal })).data });
  if (!view) return urls ? null : get();
  const seq = ++view.seq;
  const tickets = Object.fromEntries([...view.tickets].filter(([url]) => !urls || urls.includes(url)));
  const { data } = await api.post(`/messages/${messageId}/link-cards/read`, {
    view_instance_id: view.id,
    capabilities: linkCardReadCapabilities(),
    locale,
    ...(urls ? { urls } : {}),
    ...(Object.keys(tickets).length ? { tickets } : {}),
  }, { signal });
  if (seq !== view.seq) return null;
  const items = parseLinkCardReadAnswer(data);
  for (const item of items) {
    if (item.kind !== "v2" && item.kind !== "v3") continue;
    if (item.ticket) view.tickets.set(item.url, item.ticket);
    else view.tickets.delete(item.url);
  }
  return { batched: true, items, data };
}
