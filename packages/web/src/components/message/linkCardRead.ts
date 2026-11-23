import { z } from "zod";
import { MESSAGE_CARD_EXECUTE_CAPABILITY, MESSAGE_CARD_FORM_CAPABILITY, MESSAGE_CARD_LIMITS, MESSAGE_CARD_SECRET_INPUT_CAPABILITY } from "@botiverse/raft-shared";
import type { MessageCardCapability, MessageCardReadAnswer } from "@botiverse/raft-shared";
import { appCardEncryptionKeySchema, LINK_CARD_ACTION_ID, LINK_CARD_CHANGED_CAPABILITY, parseLinkCardReadAnswer, publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
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
 * `unreviewed_app.v1` (RFC 076 §17): before every acting button of an item
 * whose `app.reviewed` is `false` (an App made on this Server, acting here
 * under its admins' confirmation), Raft's confirm dialog says who runs it and
 * that Raft hasn't reviewed it, undo-window buttons included
 * (linkCardExecute.tsx, LinkCardConfirmDialog).
 * `badge.color.v1` (RFC 076 §15): the block card and the hover card draw a
 * card Badge in the App's `color` (CardBadge's `fill`).
 * `execute.toast.v1` (RFC 076 §6.3): an operation that ends at execute's
 * answer shows the App's toast from it, as one that ends at a status does
 * (linkCardExecute.tsx).
 * `card.execute.v1` (RFC 086 §4.4): the web draws a card message's acting
 * buttons (MessageCardActingButtons.tsx), so Raft answers `message_card` with a
 * handle for each one this viewer may press. Declared only with that drawing.
 * `card.form.v1` (RFC 086 §5.1): Raft's dialog draws a button's form and
 * execute sends its TextInput values (LinkCardFormFields.tsx).
 * `card.form.secret.v1` (RFC 086 §5.3): a SecretInput's value is sealed on
 * this device to the App's key from this read (linkCardSeal.ts) and sent
 * only in execute's `sealed_inputs`.
 * `card.changed.v1` (link_card.changed): Raft puts `object_key_sha256` on a
 * card whose App named its object, and a `link_card.changed` nudge with the
 * same digest reads that card again (linkCardChangedRereads.ts).
 *
 * Every device declares the same list, a touch-only one too (RFC 076 §13,
 * AppFather): a block card's buttons work by keyboard and touch, on desktop
 * and phone. Only the hover card stays read-only on touch, where it doesn't
 * open (LinkCardActions); the handles it isn't used for are harmless.
 */
export const LINK_CARD_READ_CAPABILITIES: readonly (LinkCardCapability | MessageCardCapability)[] = [
  "card.v2", "inline.v1", "inline.tone.v2", "button.v1", "confirm.v1", "undo.v1", "block.v1", "preview.v3", "unreviewed_app.v1", "badge.color.v1", "execute.toast.v1",
  LINK_CARD_CHANGED_CAPABILITY, MESSAGE_CARD_EXECUTE_CAPABILITY, MESSAGE_CARD_FORM_CAPABILITY, MESSAGE_CARD_SECRET_INPUT_CAPABILITY,
];

/**
 * A touch-only device: it can tap (`any-pointer: coarse`, the query the chip
 * shows its domain by) and nothing it has can hover, so no hover card opens
 * and the hover card draws no buttons (LinkCardActions). A touch laptop has a
 * hover-capable pointer.
 */
export const LINK_CARD_COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const LINK_CARD_HOVER_QUERY = "(any-hover: hover)";

export function linkCardReadCapabilities(): typeof LINK_CARD_READ_CAPABILITIES {
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
  | { batched: true; items: LinkCardReadAnswerItem[]; data: unknown; messageCard: MessageCardRead | null }
  | { batched: false; data: unknown };

// What a SecretInput is sealed to (RFC 086 §5.3): one that doesn't read is no key, so only its buttons are unavailable.
const messageCardAppSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(300), icon: z.string().max(2000).nullable(), reviewed: z.literal(false).optional(),
  encryption_key: appCardEncryptionKeySchema.optional().catch(undefined), client_key: z.string().min(1).max(200).optional().catch(undefined),
});
const messageCardAnswerSchema = z.object({
  card_revision: z.string().min(1).max(64),
  app: messageCardAppSchema.optional(),
  actions: z.array(z.object({
    element_id: z.string().min(1).max(64),
    action_id: z.string().regex(LINK_CARD_ACTION_ID),
    url: z.string().max(2000).refine((value) => !!publicPreviewUrl(value)),
    ticket: z.string().min(1).max(4096).brand<"LinkCardReadTicket">(),
    handle: z.string().min(1).max(4096).brand<"LinkCardHandle">(),
    handle_exp: z.number().int().positive().optional().catch(undefined),
  })).max(MESSAGE_CARD_LIMITS.maxButtons),
  waiting_for: z.object({ id: z.string().min(1).max(200), name: z.string().max(300) }).optional(),
  consent: z.enum(["needed", "declined"]).optional(),
});

type MessageCardReadAction = Omit<MessageCardReadAnswer["actions"][number], "ticket" | "handle"> & z.infer<typeof messageCardAnswerSchema>["actions"][number];
/** The shared MessageCardReadAnswer as this client reads it: its tickets and handles the branded strings a link card's are. */
export type MessageCardRead = Omit<MessageCardReadAnswer, "actions"> & { actions: MessageCardReadAction[] };

/**
 * A batched read's `message_card` (RFC 086 §4.2; the shared
 * MessageCardReadAnswer): what a card message's acting buttons are for this
 * viewer. Null when the answer has none (not a card message, a Server older
 * than RFC 086) or one this client can't read: the card then draws its
 * buttons as unavailable, never with a handle it didn't check.
 */
export function parseMessageCardReadAnswer(data: unknown): MessageCardRead | null {
  const parsed = messageCardAnswerSchema.safeParse((data as { message_card?: unknown } | null)?.message_card);
  if (!parsed.success) return null;
  const { app, waiting_for: waitingFor, consent, ...rest } = parsed.data;
  return {
    ...rest,
    ...(app ? {
      app: {
        id: app.id, name: app.name, icon: app.icon, ...(app.reviewed === false ? { reviewed: false as const } : {}),
        ...(app.encryption_key && app.client_key ? { encryption_key: app.encryption_key, client_key: app.client_key } : {}),
      },
    } : {}),
    ...(waitingFor ? { waiting_for: waitingFor } : {}),
    ...(consent ? { consent } : {}),
  };
}

/**
 * One read of a message's App links. With a view (the flag is on): the batched
 * read, with this client's capabilities, the UI's language, the view's tickets
 * and, to read some links again, `urls`. Tickets in the answer replace the
 * view's. A card message's answer brings `message_card` instead of items. An answer to a request that is no longer the view's latest is null.
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
  // A card message's handles come with the ticket of each fallback page's view, kept like a link's.
  const messageCard = parseMessageCardReadAnswer(data);
  for (const action of messageCard?.actions ?? []) view.tickets.set(action.url, action.ticket);
  return { batched: true, items, data, messageCard };
}
