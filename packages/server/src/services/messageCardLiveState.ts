// App-sent cards (RFC 086 §4.2): a card message's acting button compared with
// live state, for the handle read, prepare, execute (its admission and the
// re-check under its locks), receipts and the by-URL operation lookup. Part of
// the one live-state module (linkCardLiveState.ts branches here on the
// handle's `messageCard` claim, or on the message being a card message); the
// action and receipt services never compare anything themselves.
//
// What every point re-checks, now (§4.2): the App still has execute
// eligibility (messageCardAppEligibility, the decision RFC 076 makes); the
// viewer is a member of this Server who is not a guest and can read the
// conversation (the route's reader decides reading, as for link cards);
// when the card is for one person, the viewer is that person; and the viewer
// agreed, once, that this App learns who they are: the same per-App consent
// a link card needs (an active consent covering the preview scopes, no
// decline; Tenny, RFC 086 §4.2). One rule for both kinds of card: an App
// learns who someone is only after that person agreed once for that App.
// Not having handed a handle to someone else is never the check. The handle
// binds the message, its card revision and content, and the button: its
// element, its fallback page (the operation's URL identity) and its action
// (its form included). Step 2 (§5.1, §5.2): a button whose form holds a
// SecretInput acts only for an official App with a card encryption key, for a
// client that declared `card.form.v1` and `card.form.secret.v1`, and its
// handle binds the key's `kid`, which must still be the App's.
//
// The handle read asks the same predicate (verifyMessageCardActionAgainstLiveState)
// of the claims it would sign, so what the read hands out and what prepare
// and execute accept are one decision.

import { and, eq } from "drizzle-orm";
import {
  MESSAGE_CARD_EXECUTE_CAPABILITY, messageCardActingButtons, messageCardActionCapabilities, messageCardActionHasSecretInput, messageCardForUser, messageCardSchema,
  type MessageCardActingButton, type MessageCardMetadata,
} from "@botiverse/raft-shared";
import { EXECUTE_TOAST_CAPABILITY, UNREVIEWED_APP_CAPABILITY } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb, type DatabaseExecutor } from "../db";
import { oauthAppLinkPreviews, serverMembers } from "../db/schema";
import { LINK_PREVIEW_PROOF_HARD_TTL_MS, previewable, provenWithin, registeredApps } from "./appLinkPreviewService";
import type { LinkCardIdentityDomain, LinkCardLiveState, LinkCardLiveStateFailure, LinkCardMessageReader } from "./linkCardLiveState";
import { linkCardActionEndpointSha256, linkCardMessageContentSha256, linkCardUrlSha256, type LinkCardHandleClaims } from "./linkCardTokens";
import { messageCardAppEligibility, messageCardSenderApp, onAppLinkPreviewOrigin } from "./messageCardActionService";

/** A card message as the viewer may read it now (routes/messages.ts readCardActionMessage): what the checks need beyond its content. */
export type MessageCardOnRead = {
  metadata: MessageCardMetadata;
  senderType: string;
  senderId: string;
  /** Read through a Joint Channel or thread: no acting buttons there (RFC 086 §4.1). */
  joint: boolean;
};

/**
 * The capabilities a card message's handle binds, of those the client
 * declared on the read: `card.execute.v1` (needed), `card.form.v1` and
 * `card.form.secret.v1` (needed for a button whose form has fields of that
 * kind, RFC 086 §5.1), `unreviewed_app.v1` (needed for an own-Server App, RFC
 * 076 §17) and `execute.toast.v1` (the App's toast on execute's answer,
 * released only to a handle that carries it, as for a link card). The live
 * check needs the first four where they apply and accepts the last.
 */
export function messageCardBoundCapabilities(request: { messageCardCapabilities: readonly string[]; capabilities: readonly string[] }): string[] {
  return [
    ...request.messageCardCapabilities,
    ...[UNREVIEWED_APP_CAPABILITY, EXECUTE_TOAST_CAPABILITY].filter((capability) => request.capabilities.includes(capability)),
  ].sort();
}

/**
 * The `kid` a handle for this acting button binds (RFC 086 §5.2): the App's
 * card encryption key in force when the handle was issued, for a button whose
 * form holds a SecretInput; none for any other button. A handle whose bound
 * `kid` is no longer the App's fails closed (the person presses again).
 */
export function messageCardHandleEncryptionKid(
  button: Pick<MessageCardActingButton, "action">, registration: { cardEncryptionKey: unknown; cardEncryptionKid: string | null },
): string | undefined {
  if (!messageCardActionHasSecretInput(button.action)) return undefined;
  return registration.cardEncryptionKey && registration.cardEncryptionKid ? registration.cardEncryptionKid : undefined;
}

/**
 * The sealing side of a card message's handle (RFC 086 §5.1, §5.2), one rule
 * for the live check (read, prepare, execute admission) and execute's lock
 * (lockLinkCardActionEligibility, on the registration row it holds FOR
 * SHARE): a button whose form holds a SecretInput acts only for an official
 * App with a card encryption key (`eligibility`), and the `kid` the handle
 * bound must be the one the App's key has now, none on any other button
 * (`revision`: after a rotation the person presses again). Null when it holds.
 */
export function messageCardSealingFailure(input: {
  action: MessageCardActingButton["action"]; official: boolean;
  registration: { cardEncryptionKey: unknown; cardEncryptionKid: string | null }; claims: LinkCardHandleClaims;
}): "eligibility" | "revision" | null {
  const kidNow = messageCardHandleEncryptionKid({ action: input.action }, input.registration);
  if (messageCardActionHasSecretInput(input.action) && (!input.official || kidNow === undefined)) return "eligibility";
  return input.claims.messageCard?.encryptionKid !== kidNow ? "revision" : null;
}

/** The acting buttons of a card message as stored (its card read through the stored-card schema); none when the card doesn't read. */
export function storedActingButtons(metadata: MessageCardMetadata): MessageCardActingButton[] {
  const card = messageCardSchema.safeParse(metadata.card);
  return card.success ? messageCardActingButtons({ card: card.data, actions: metadata.actions }) : [];
}

/** Whether `viewerId` is a member of `serverId` who is not a guest; `forShare` locks the membership row, so a demotion or a leave is ordered with the caller's transaction. */
export async function messageCardViewerIsMember(executor: DatabaseExecutor, input: { viewerId: string; serverId: string; forShare?: boolean }): Promise<boolean> {
  const query = executor.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, input.viewerId)));
  const [member] = input.forShare ? await query.for("share") : await query.limit(1);
  return !!member && member.role !== "guest";
}

/**
 * The message's side of a handle: still a card message the viewer reads
 * through a conversation of this Server (not a joint), with the revision and
 * content the handle signed, still carrying this acting button with the same
 * fallback page and action, and, when it is for one person, for this viewer.
 */
function messageSideFailure(
  message: Awaited<ReturnType<LinkCardMessageReader>>, claims: LinkCardHandleClaims, viewerId: string,
): { failure: LinkCardLiveStateFailure } | { card: MessageCardOnRead; button: MessageCardActingButton } {
  const card = message?.messageCard;
  if (!message || !card || card.joint || card.senderType !== "agent") return { failure: "message" };
  if (linkCardMessageContentSha256(message.content) !== claims.messageContentSha256 || String(card.metadata.revision) !== claims.cardRevision) return { failure: "message" };
  const button = storedActingButtons(card.metadata).find((item) => item.elementId === claims.messageCard?.elementId);
  if (!button || linkCardUrlSha256(button.url) !== claims.binding.urlSha256) return { failure: "url" };
  if (button.action.action_id !== claims.actionId || ("confirm" in button.action) !== claims.requiresPrepare) return { failure: "url" };
  const forUser = messageCardForUser(card.metadata);
  if (forUser !== null && forUser !== viewerId) return { failure: "viewer" };
  return { card, button };
}

/**
 * verifyLinkCardActionAgainstLiveState for a card message's acting button
 * (the handle carries `messageCard`), and the handle read's decision for each
 * acting button it would sign: the message side above, the viewer a member
 * who is not a guest, the App the bot's (its key and installation as bound,
 * matched as a link card's provider is: enabled, actively installed, a
 * registration in force), eligible now with the registration revision bound,
 * the fallback page still on its verified origin, and, last, the viewer's
 * choice for this App: `decline` when they declined it, `consent` when they
 * never agreed (the read then answers the App's prompt). Writes nothing and
 * calls no App.
 */
export async function verifyMessageCardActionAgainstLiveState(input: {
  viewerId: string; serverId: string; claims: LinkCardHandleClaims; readMessage: LinkCardMessageReader; now: Date;
}): Promise<{ ok: true; live: LinkCardLiveState } | { ok: false; reason: LinkCardLiveStateFailure }> {
  const { binding } = input.claims;
  if (binding.providerKind !== "app") return { ok: false, reason: "provider" };
  if (!binding.capabilities.includes(MESSAGE_CARD_EXECUTE_CAPABILITY)) return { ok: false, reason: "capabilities" };
  const side = messageSideFailure(await input.readMessage(binding.messageId), input.claims, input.viewerId);
  if ("failure" in side) return { ok: false, reason: side.failure };
  if (!await messageCardViewerIsMember(getDb(), { viewerId: input.viewerId, serverId: input.serverId })) return { ok: false, reason: "viewer" };
  const app = await messageCardSenderApp(side.card.senderId);
  if (!app || app.clientKey !== binding.providerKey) return { ok: false, reason: "provider" };
  if (app.installId !== binding.installationKey) return { ok: false, reason: "installation" };
  const eligible = await messageCardAppEligibility(app, input.serverId, input.now);
  if (!eligible) return { ok: false, reason: "eligibility" };
  if (eligible.registration.revision !== binding.registrationRevision) return { ok: false, reason: "revision" };
  if (!onAppLinkPreviewOrigin(side.button.url, eligible.registration)) return { ok: false, reason: "url" };
  // RFC 076 §17: the acting buttons of an App that is not official only for a client that shows Raft's not-reviewed confirmation.
  if (eligible.basis !== "official" && !binding.capabilities.includes(UNREVIEWED_APP_CAPABILITY)) return { ok: false, reason: "capabilities" };
  // RFC 086 §5.1: a button with a form only for a client that draws it (and its SecretInputs).
  if (!messageCardActionCapabilities(side.button.action).every((capability) => binding.capabilities.includes(capability))) return { ok: false, reason: "capabilities" };
  const sealing = messageCardSealingFailure({ action: side.button.action, official: eligible.basis === "official", registration: eligible.registration, claims: input.claims });
  if (sealing !== null) return { ok: false, reason: sealing };
  const entry = (await registeredApps(input.serverId, input.viewerId, [eligible.registration.origin]))
    .find((row) => row.app.id === app.clientId && row.installationId === app.installId);
  if (!entry || entry.config.revision !== binding.registrationRevision || entry.config.actionEndpoint === null) return { ok: false, reason: "eligibility" };
  // RFC 086 §4.2 (Tenny): the per-App consent a link card needs, the same rows.
  if (entry.declineId !== null) return { ok: false, reason: "decline" };
  if (entry.consentId === null) return { ok: false, reason: "consent" };
  const actionEndpoint = entry.config.actionEndpoint;
  return {
    ok: true,
    live: {
      url: side.button.url, entry, actionEndpoint, actionEndpointSha256: linkCardActionEndpointSha256(actionEndpoint),
      basis: eligible.basis, messageCard: { elementId: side.button.elementId, action: side.button.action },
    },
  };
}

/**
 * The message side of recheckLinkCardViewerInTransaction for a card
 * message's acting button, after its consent and decline re-check: the
 * message read again through the same reader inside the transaction (still
 * readable by the viewer, same revision and content, the button still there,
 * still for this viewer). Its membership re-check (FOR SHARE) comes first, in
 * linkCardLiveState.ts; the App's eligibility under the same transaction,
 * with the sealing side (messageCardSealingFailure), is
 * lockLinkCardActionEligibility's.
 */
export async function recheckMessageCardMessageInTransaction(input: {
  viewerId: string; claims: LinkCardHandleClaims; readMessage: LinkCardMessageReader;
}): Promise<LinkCardLiveStateFailure | null> {
  const side = messageSideFailure(await input.readMessage(input.claims.binding.messageId), input.claims, input.viewerId);
  return "failure" in side ? side.failure : null;
}

/**
 * matchLinkCardUrlIdentity for a card message: the identity domain of the
 * App whose bot sent it, when `urlSha256` names one of its acting buttons'
 * fallback pages and that App is matched for this viewer as a link's
 * provider is (enabled, actively installed, consented and not declined, not
 * suspended, proven within HARD_TTL); null otherwise.
 */
export async function messageCardUrlIdentity(card: MessageCardOnRead, input: { viewerId: string; serverId: string; urlSha256: string; now: Date }): Promise<LinkCardIdentityDomain | null> {
  if (card.joint || card.senderType !== "agent") return null;
  if (!storedActingButtons(card.metadata).some((button) => linkCardUrlSha256(button.url) === input.urlSha256)) return null;
  const app = await messageCardSenderApp(card.senderId);
  if (!app) return null;
  const [registration] = await getDb().select({ origin: oauthAppLinkPreviews.origin }).from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, app.clientId)).limit(1);
  if (!registration) return null;
  const entry = (await registeredApps(input.serverId, input.viewerId, [registration.origin])).find((row) => row.app.id === app.clientId
    && row.installationId === app.installId && previewable(row) && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, input.now));
  return entry ? { providerKind: "app", providerKey: entry.app.key, installationKey: entry.installationId } : null;
}
