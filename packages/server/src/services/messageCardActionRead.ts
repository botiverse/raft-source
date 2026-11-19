// App-sent cards (RFC 086 §4.2): the batched link card read
// (`POST /api/messages/:messageId/link-cards/read`) for a card message. The
// card is the same for everyone and the client already has it; what the read
// adds is, for this viewer only, one signed handle per acting button they may
// press now, and why not when they may not: the card is for someone else
// (`waiting_for`), or the viewer hasn't agreed to this App learning who they
// are (`consent`, with the App's first-view prompt in `prompts`). Like the
// rest of the read it writes nothing: tickets and handles are signed, not
// stored.
//
// The read decides nothing itself: for each acting button it builds the
// claims it would sign and asks verifyMessageCardActionAgainstLiveState, the
// predicate prepare and execute ask of the same claims, so what the read
// hands out and what an action accepts can't drift apart.
//
// Step 2 (RFC 086 §5.2): a handle for a button whose form holds a SecretInput
// binds the `kid` of the App's card encryption key as Raft stores it, and the
// answer then carries that key (`app.encryption_key`) for the client to seal
// to; never a key from the card.

import { eq } from "drizzle-orm";
import {
  currentDate, messageCardForUser, type MessageCardActingButton, type MessageCardReadAnswer, type ServerId,
} from "@botiverse/raft-shared";
import type { AppCardEncryptionKey, AppLinkPreviewPrompt } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb } from "../db";
import { oauthAppLinkPreviews, users } from "../db/schema";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import type { LinkCardLiveState, LinkCardLiveStateFailure } from "./linkCardLiveState";
import { linkCardTicketClaims, type LinkCardReadRequest } from "./linkCardReadService";
import {
  linkCardMessageContentSha256, linkCardUrlSha256, signLinkCardHandle, signLinkCardReadTicket, type LinkCardHandleClaims, type LinkCardReadTicketClaims,
  type LinkCardViewBinding,
} from "./linkCardTokens";
import { messageCardSenderApp } from "./messageCardActionService";
import {
  messageCardBoundCapabilities, messageCardHandleEncryptionKid, storedActingButtons, verifyMessageCardActionAgainstLiveState, type MessageCardOnRead,
} from "./messageCardLiveState";

/** Who a card for one person is for, as the client says it ("Waiting for {name}"): their display name, else their handle. */
async function waitingFor(userId: string): Promise<MessageCardReadAnswer["waiting_for"]> {
  const [user] = await getDb().select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return { id: userId, name: user ? user.displayName || user.name : "" };
}

/** The read's answer for a card message: `message_card`, and the App's prompt when the viewer must first agree to it. */
export type MessageCardRead = { message_card: MessageCardReadAnswer; prompts: AppLinkPreviewPrompt[] };

/**
 * The read for a card message the route found readable by the viewer from
 * this Server. For each acting button: the claims of the handle it would
 * sign (the sender's App and installation, the registration revision, the
 * capabilities the client declared that a card message's buttons use, this
 * message's revision and content, the button), then the predicate. A handle
 * only where it passes; otherwise the predicate's reason says what the
 * client may draw: `consent` (the App's prompt) or `decline`. `waiting_for`
 * names the card's one person to anyone else, whatever else holds.
 */
export async function readMessageCardActions(input: {
  serverId: ServerId; viewerId: string; messageId: string; content: string; card: MessageCardOnRead; request: LinkCardReadRequest;
}): Promise<MessageCardRead> {
  const { metadata } = input.card;
  const answer: MessageCardReadAnswer = { card_revision: String(metadata.revision), actions: [] };
  const buttons = storedActingButtons(metadata);
  if (buttons.length === 0) return { message_card: answer, prompts: [] };
  const forUser = messageCardForUser(metadata);
  if (forUser !== null && forUser !== input.viewerId) answer.waiting_for = await waitingFor(forUser);
  // What the claims name: the sender's App, its installation and registration as they are now. The predicate decides whether they hold.
  const app = input.card.senderType === "agent" ? await messageCardSenderApp(input.card.senderId) : null;
  // RFC 086 §5.2: the App's card encryption key as Raft stores it, read with the revision: the kid a SecretInput button's handle binds and the key the answer carries are one row's.
  const [registration] = app
    ? await getDb().select({
      revision: oauthAppLinkPreviews.revision, cardEncryptionKey: oauthAppLinkPreviews.cardEncryptionKey, cardEncryptionKid: oauthAppLinkPreviews.cardEncryptionKid,
    }).from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, app.clientId)).limit(1)
    : [];
  if (!app || !registration) return { message_card: answer, prompts: [] };
  const capabilities = messageCardBoundCapabilities(input.request);
  const messageContentSha256 = linkCardMessageContentSha256(input.content);
  const readMessage = async () => ({ content: input.content, messageCard: input.card });
  // One view per fallback page: each is its own URL identity, as each link of a message is.
  const views = new Map<string, LinkCardReadTicketClaims>();
  const reasons: LinkCardLiveStateFailure[] = [];
  let basis: LinkCardLiveState["basis"] | null = null;
  let sealsTo: AppCardEncryptionKey | null = null;
  for (const button of buttons) {
    let view = views.get(button.url);
    if (!view) {
      const binding: LinkCardViewBinding = {
        viewerId: input.viewerId, serverId: input.serverId, providerKind: "app", providerKey: app.clientKey, installationKey: app.installId,
        messageId: input.messageId, urlSha256: linkCardUrlSha256(button.url), registrationRevision: registration.revision, capabilities,
      };
      view = linkCardTicketClaims({ url: button.url, request: input.request, binding });
      views.set(button.url, view);
    }
    const encryptionKid = messageCardHandleEncryptionKid(button, registration);
    const claims = handleClaims(view, button, answer.card_revision, messageContentSha256, encryptionKid);
    const checked = await verifyMessageCardActionAgainstLiveState({ viewerId: input.viewerId, serverId: input.serverId, claims, readMessage, now: currentDate() });
    if (!checked.ok) {
      reasons.push(checked.reason);
      continue;
    }
    basis = checked.live.basis;
    if (encryptionKid !== undefined && registration.cardEncryptionKey) sealsTo = registration.cardEncryptionKey;
    answer.actions.push({
      element_id: button.elementId, action_id: button.action.action_id, url: button.url, ticket: signLinkCardReadTicket(view), handle: signLinkCardHandle(claims),
      // RFC 086 §5.3: what the client puts in the sealed header's `exp`, which the App compares with the execute JWT's `handle_exp`.
      ...(encryptionKid !== undefined ? { handle_exp: claims.exp } : {}),
    });
  }
  const appView = { id: app.clientId, name: app.name, icon: app.icon };
  // The viewer's choice for this App, when it is all that stands between them and the buttons.
  const consent = answer.actions.length === 0 && reasons.includes("decline") ? "declined" as const
    : answer.actions.length === 0 && reasons.includes("consent") ? "needed" as const : null;
  if (answer.actions.length > 0) {
    answer.app = {
      ...appView, ...(basis !== null && basis !== "official" ? { reviewed: false as const } : {}),
      // RFC 086 §5.2: from Raft's registration of the App, never from the card; only beside a handle for a SecretInput button.
      ...(sealsTo ? { encryption_key: sealsTo, client_key: app.clientKey } : {}),
    };
  }
  if (consent) {
    answer.app = appView;
    answer.consent = consent;
  }
  // The App's first-view prompt, the link card read's own shape: the client runs it on the first press, then reads again.
  const prompts: AppLinkPreviewPrompt[] = consent === "needed" ? [{ url: buttons[0]!.url, app: appView }] : [];
  return { message_card: answer, prompts };
}

/** The claims of the handle for one acting button, in the view `view`; `encryptionKid` for a SecretInput button (RFC 086 §5.2). */
function handleClaims(
  view: LinkCardReadTicketClaims, button: MessageCardActingButton, cardRevision: string, messageContentSha256: string, encryptionKid: string | undefined,
): LinkCardHandleClaims {
  return {
    ...view, actionId: button.action.action_id, cardRevision, businessRevision: cardRevision,
    descriptorSha256: canonicalJsonSha256({ element_id: button.elementId, label: button.label, action: button.action }),
    messageContentSha256, requiresPrepare: "confirm" in button.action,
    messageCard: { elementId: button.elementId, ...(encryptionKid !== undefined ? { encryptionKid } : {}) },
  };
}
