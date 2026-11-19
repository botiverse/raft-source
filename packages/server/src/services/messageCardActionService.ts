// App-sent cards, step 1 (RFC 086 §4.1, §4.5): who may send a card message
// with acting buttons, and where. The card's own rules are the shared
// module's (messageCardActions.ts: keys naming Buttons, RFC 076 execute
// actions); this file decides what needs the database:
// - the sender is an App's bot (`agents.managed_by_app_install_id`), and that
//   App has execute eligibility on this Server now: the same decision RFC
//   076 makes at its three points (linkCardActionTier with
//   unreviewedActionsBasis, on the registration and the bot's installation
//   as they are now);
// - the target is not a joint channel or a thread in one;
// - each acting button's fallback page is https on the App's verified
//   link-preview origin;
// - `for`, if any, is a member of this Server (not a guest; a user, so not an
//   agent) who can read the target conversation now;
// - step 2 (§5.1, §5.2): a form holding a SecretInput only from an official
//   App (the eligibility's `official` basis: an approved official registry
//   entry from an official publisher), and only once the App registered its
//   card encryption key (else `message_card_encryption_key_required`); the
//   form's own rules (SecretInput only on a `confirm: "prepare"` button) are
//   the shared module's;
// - 30 sends with `actions` per App per Server a minute, across replicas.
// The per-viewer re-checks at read and execute are messageCardLiveState.ts.

import { and, eq, isNull } from "drizzle-orm";
import { MESSAGE_CARD_ERROR_CODES, messageCardActionHasSecretInput, type MessageCardActingButton, type ServerId } from "@botiverse/raft-shared";
import { publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, serverMembers, users } from "../db/schema";
import { LINK_PREVIEW_PROOF_HARD_TTL_MS, provenWithin } from "./appLinkPreviewService";
import { parseAppSubject, resolveAppSubjectToUserId } from "./appSubjectService";
import * as channelService from "./channelService";
import { createFixedWindowCounter, type FixedWindowAdmission } from "./fixedWindowRateLimit";
import { unreviewedActionsBasis, type UnreviewedActionsBasis } from "./linkCardExecuteEligibility";
import { linkCardActionTier } from "./linkCardReadService";
import { isApprovedOfficialAppClient } from "./officialAppAutoInstallService";
import { canView } from "./visibilityService";

/** The App an agent is the bot of, through the installation that manages it. */
export type MessageCardSenderApp = {
  installId: string;
  /** The Server the installation (and so the bot) is on. */
  installServerId: string;
  installActive: boolean;
  /** The installation's card-button state (RFC 076 §17; unreviewedActionsBasis). */
  installation: { allowedActionEndpoint: string | null; actionsOffAt: Date | null };
  /** `oauth_clients.id`. */
  clientId: string;
  /** `oauth_clients.client_id`: the App's key, as RFC 076's operations record it. */
  clientKey: string;
  name: string;
  icon: string | null;
  enabled: boolean;
  /** The App's own Server and distribution (RFC 076 §17). */
  appServerId: string;
  appType: "server_local" | "slock_builtin" | "third_party_global";
};

/** The App whose bot `agentId` is, or null for any other agent (or none). */
export async function messageCardSenderApp(agentId: string, executor: DatabaseExecutor = getDb()): Promise<MessageCardSenderApp | null> {
  const [row] = await executor.select({
    installId: oauthClientInstalls.id, installServerId: oauthClientInstalls.serverId, installStatus: oauthClientInstalls.status,
    installation: { allowedActionEndpoint: oauthClientInstalls.allowedActionEndpoint, actionsOffAt: oauthClientInstalls.actionsOffAt },
    clientId: oauthClients.id, clientKey: oauthClients.clientId, name: oauthClients.name, icon: oauthClients.logoUrl, enabled: oauthClients.enabled,
    appServerId: oauthClients.serverId, appType: oauthClients.appType,
  }).from(agents)
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, agents.managedByAppInstallId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!row) return null;
  const { installStatus, ...app } = row;
  return { ...app, installActive: installStatus === "active" };
}

export type MessageCardAppRegistration = typeof oauthAppLinkPreviews.$inferSelect;

/**
 * Whether the App may call its action endpoint for cards read on `serverId`
 * now, and on which basis (RFC 076 §4 and §17): enabled and actively
 * installed there, a registration proven within HARD_TTL, and the read's tier
 * function (linkCardActionTier) says `execute`: an approved official App with
 * an action endpoint in force and not suspended, or an App whose installation
 * here lets its card buttons act (unreviewedActionsBasis: its own Server's
 * default, or this Server's allow).
 */
export async function messageCardAppEligibility(app: MessageCardSenderApp, serverId: string, now: Date, executor: DatabaseExecutor = getDb()):
  Promise<{ basis: "official" | UnreviewedActionsBasis; registration: MessageCardAppRegistration } | null> {
  if (!app.enabled || !app.installActive || app.installServerId.toLowerCase() !== serverId.toLowerCase()) return null;
  const [registration] = await executor.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, app.clientId)).limit(1);
  if (!registration || !provenWithin(registration.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, now)) return null;
  const official = await isApprovedOfficialAppClient(app.clientId, executor);
  const unreviewed = official ? null
    : unreviewedActionsBasis({ app: { serverId: app.appServerId, appType: app.appType }, config: registration, installation: app.installation }, serverId);
  const tier = linkCardActionTier({ official, unreviewed: unreviewed !== null, actionEndpoint: registration.actionEndpoint, suspended: registration.suspendedAt !== null });
  if (tier !== "execute") return null;
  return { basis: unreviewed ?? "official", registration };
}

/** Whether an acting button's fallback page is a public https URL on the App's verified link-preview origin. */
export function onAppLinkPreviewOrigin(url: string, registration: Pick<MessageCardAppRegistration, "origin">): boolean {
  const parsed = publicPreviewUrl(url);
  if (!parsed) return false;
  try {
    return parsed.origin === new URL(registration.origin).origin;
  } catch {
    return false;
  }
}

/** Whether a conversation is a joint channel or a thread in one (its root, walked as the archive check walks it). Never throws. */
export async function isJointConversation(channelId: string): Promise<boolean> {
  return (await channelService.getConversationArchiveRoot(channelId)).rootType === "joint";
}

/**
 * Whether `userId` may be a card's `for` (RFC 086 §4.1), and whom an acting
 * button may serve at all (§4.2): a member of `serverId` who is not a guest
 * (a user, never an agent) and can read `channelId` now.
 */
export async function humanMemberCanRead(input: { userId: string; serverId: ServerId; channelId: string }, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [member] = await executor.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, input.userId))).limit(1);
  if (!member || member.role === "guest") return false;
  const [visible] = await canView({ type: "user", id: input.userId, serverId: input.serverId }, [{ kind: "conversation", channelId: input.channelId }], { executor });
  return visible === true;
}

/**
 * The handle (the `@name` a mention names) of a member of `serverId`, guests
 * included; null for anyone else. Looked up through this Server's members
 * only, so a `for` naming a person elsewhere gets the same answer as one
 * naming nobody.
 */
export async function messageCardMemberHandle(userId: string, serverId: string, executor: DatabaseExecutor = getDb()): Promise<string | null> {
  const [row] = await executor.select({ name: users.name }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))).limit(1);
  return row?.name ?? null;
}

/**
 * RFC 086 §4.1: the person an App's bot names as a card's `for`. An App
 * names a person by the App subject (`sub`) Raft gave it at Sign in with
 * Raft, so `for` is read as one and becomes a user id only through Raft's
 * subject mapping (resolveAppSubjectToUserId, as `dm:sub:<sub>` targets do),
 * never by comparing it with a user id. Then the person must be a member of
 * this Server (their handle names them in the fallback). Null for every miss
 * (a sender that is not an App's bot, a malformed subject, one that names no
 * one, a person who is not a member here), which the send answers alike.
 * Whether they may be `for` (not a guest, can read the conversation) is
 * assertMessageCardActionsAllowed's, on the user id returned here.
 */
export async function resolveMessageCardFor(input: { senderAgentId: string; serverId: string; raw: unknown }): Promise<{ id: string; handle: string } | null> {
  const sub = typeof input.raw === "string" ? parseAppSubject(input.raw) : null;
  if (!sub) return null;
  const app = await messageCardSenderApp(input.senderAgentId);
  if (!app) return null;
  const userId = await resolveAppSubjectToUserId({ clientId: app.clientId, sub });
  if (!userId) return null;
  const handle = await messageCardMemberHandle(userId, input.serverId);
  return handle ? { id: userId, handle } : null;
}

/**
 * Why a card's `actions` or `for` can't be stored (400): the sentence the
 * refusal says, and its code: `message_card_actions_not_allowed`, or
 * `message_card_encryption_key_required` for a SecretInput from an App
 * without a card encryption key (RFC 086 §5.2).
 */
export class MessageCardActionsRefusedError extends Error {
  constructor(
    message: string,
    readonly code: typeof MESSAGE_CARD_ERROR_CODES.actionsNotAllowed | typeof MESSAGE_CARD_ERROR_CODES.encryptionKeyRequired = MESSAGE_CARD_ERROR_CODES.actionsNotAllowed,
  ) {
    super(message);
    this.name = "MessageCardActionsRefusedError";
  }
}

/** RFC 086 §5.1 (hard rule): a SecretInput from an App Raft did not review as official. */
export const MESSAGE_CARD_SECRET_INPUT_NOT_OFFICIAL = "Only an official App can ask for a secret (SecretInput) on a card; this App can send forms with TextInput fields only.";
/** RFC 086 §5.2: a SecretInput from an App with no card encryption key registered. */
export const MESSAGE_CARD_SECRET_INPUT_NO_KEY = "A form with a SecretInput needs the App's card encryption key: register it on the App's link-preview registration first.";

/**
 * Every check of RFC 086 §4.1 that reads the database, for a send (in its
 * transaction: `executor`) or an update that carries `actions`: throws
 * MessageCardActionsRefusedError naming the first that fails.
 */
export async function assertMessageCardActionsAllowed(input: {
  senderAgentId: string;
  serverId: ServerId;
  /** The conversation the card is posted in (a send's target; an update's conversation). */
  channelId: string;
  buttons: readonly MessageCardActingButton[];
  forUserId: string | null;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<void> {
  const app = await messageCardSenderApp(input.senderAgentId, executor);
  if (!app) throw new MessageCardActionsRefusedError("Only an App's bot can send a card with acting buttons (actions).");
  const eligible = await messageCardAppEligibility(app, input.serverId, input.now ?? new Date(), executor);
  if (!eligible) {
    throw new MessageCardActionsRefusedError(
      `${app.name} can't run card actions on this Server now: it needs an approved action endpoint, or this Server's confirmation of its endpoint for an App made here.`,
    );
  }
  const root = await channelService.getConversationArchiveRoot(input.channelId);
  // Archived since the send's own archive check: the caller answers it as that check does (409 channel_archived).
  if (root.archived) throw new channelService.ChannelArchivedError(input.channelId);
  if (root.rootType === "joint") {
    throw new MessageCardActionsRefusedError("Acting buttons don't work in a joint channel or a thread in one yet.");
  }
  // RFC 086 §5.1, §5.2: a SecretInput only from an official App (never an App acting under a Server's confirmation, RFC 076 §17), and only once it registered the key its values are sealed to.
  if (input.buttons.some((button) => messageCardActionHasSecretInput(button.action))) {
    if (eligible.basis !== "official") throw new MessageCardActionsRefusedError(MESSAGE_CARD_SECRET_INPUT_NOT_OFFICIAL);
    if (!eligible.registration.cardEncryptionKey || !eligible.registration.cardEncryptionKid) {
      throw new MessageCardActionsRefusedError(MESSAGE_CARD_SECRET_INPUT_NO_KEY, MESSAGE_CARD_ERROR_CODES.encryptionKeyRequired);
    }
  }
  for (const button of input.buttons) {
    if (!onAppLinkPreviewOrigin(button.url, eligible.registration)) {
      throw new MessageCardActionsRefusedError(
        `The acting button ${button.elementId} needs a fallback page (its navigate URL) that is https on ${app.name}'s verified link-preview origin.`,
      );
    }
  }
  if (input.forUserId !== null && !await humanMemberCanRead({ userId: input.forUserId, serverId: input.serverId, channelId: input.channelId }, executor)) {
    throw new MessageCardActionsRefusedError(
      "for must name a person on this Server (not a guest, not an agent) who can read this conversation now.",
    );
  }
}

// RFC 086 §4.5: 30 card sends with `actions` per App per Server a minute, a
// fixed window counted across replicas (fixedWindowRateLimit.ts, as
// linkCardActionLimits.ts counts). No per-person cap in step 1.
export const MESSAGE_CARD_ACTIONS_SENDS_PER_MINUTE = 30;
const SEND_WINDOW_SECONDS = 60;
const sendBudgets = createFixedWindowCounter();
let sendLimitOverrideForTests: number | null = null;

/** Spends one unit of the App's budget of card sends with `actions` on this Server. */
export async function admitMessageCardActionsSend(input: { clientId: string; serverId: string }, nowMs = Date.now()):
  Promise<FixedWindowAdmission & { limit: number; windowSeconds: number }> {
  const limit = sendLimitOverrideForTests ?? MESSAGE_CARD_ACTIONS_SENDS_PER_MINUTE;
  const admission = await sendBudgets.admit(`slock:message-card-actions:send:${input.serverId}:${input.clientId}`, limit, SEND_WINDOW_SECONDS, nowMs);
  return { ...admission, limit, windowSeconds: SEND_WINDOW_SECONDS };
}

/** Tests only: a smaller limit (null restores RFC 086's) and an empty count in this process. */
export function __setMessageCardActionsSendLimitForTests(limit: number | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Message card action limit hooks are test-only");
  sendLimitOverrideForTests = limit;
  sendBudgets.clear();
}
