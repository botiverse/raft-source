// Seat requests (task #10 #proj-commercial): a member or admin who runs out of
// Pro seats asks an owner for them with an action card in their DM, the same
// card system an agent's cards use. Only an owner adds the seats (in the
// add-seats dialog) and then completes it: invites and a Guest's promotion are
// done as the owner; an agent or assistant is left for the requester (for an
// agent, the owner may send back an ordinary agent:create card). Whoever asked
// is told how it ended in the card's thread (postActionCardResultReply). A
// request is open for SEAT_REQUEST_TTL_MS; what it holds (who to invite, the
// agent's name) is cleared once it is completed or expired. A member of a Free
// server asks for Pro the same way, with a `plan:upgrade` card. Someone a full
// join link turned away is let in the same way, by a `join` request
// (seatJoinBlockService.ts). Contract:
// docs/contracts/seat-limits.md.
import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  GENERAL_UPGRADE_GATE,
  PRO_SEAT_ADD_FEATURE_FLAG_KEY,
  SEAT_REQUEST_TTL_MS,
  asServerId,
  agentCreateOperationSchema,
  planUpgradeOperationSchema,
  seatRequestReadyOutcome,
  seatTenths,
  seatsAddPurposeSchema,
  seatsAddPurposeTenths,
  seatsShortFor,
  storedActionCardActionSchema,
  type ActionCardAction,
  type ActionCardMetadata,
  type AgentUpgradeCardGate,
  type SeatRequestOutcome,
  type SeatsAddAction,
  type SeatsAddPurpose,
  type ServerId,
  type StoredActionCardAction,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channelHumans, messages, serverMembers, servers, users } from "../db/schema";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { emitActionCardMessageUpdated, postActionCardResultReply, type ActionCardResultReplyOutcome } from "./actionCardsService";
import { actionCardPresentationFor, storedActionCardSpecNames } from "./actionCardPresentation";
import { isServerOnFreePlan } from "./agentUpgradeCardService";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { getServerBillingEntitlement, getServerBillingUsage } from "./planService";
import * as channelService from "./channelService";
import * as inviteService from "./inviteService";
import * as messageService from "./messageService";
import * as seatJoinBlockService from "./seatJoinBlockService";
import * as serverService from "./serverService";

type PlanUpgradeAction = Extract<ActionCardAction, { type: "plan:upgrade" }>;
type PersonCardAction = SeatsAddAction | PlanUpgradeAction;

/** Open requests one person may have in a server at once: enough for real work, not a flood of an owner's DMs. */
const MAX_OPEN_REQUESTS_PER_REQUESTER = 10;

export type SeatRequestErrorCode =
  | "FEATURE_DISABLED"
  | "NOT_PRO"
  | "NOT_A_MEMBER"
  | "OWNER_ADDS_SEATS"
  | "NOT_AN_OWNER"
  | "NOT_ALLOWED"
  | "NOT_A_GUEST"
  | "NOT_BLOCKED"
  | "TOO_MANY_OPEN"
  | "NOT_FOUND"
  | "NOT_SEAT_REQUEST"
  | "ALREADY_RESOLVED"
  | "EXPIRED"
  | "SEATS_STILL_SHORT"
  | "NOT_READY";

export class SeatRequestError extends Error {
  constructor(readonly status: number, readonly code: SeatRequestErrorCode, message: string) {
    super(message);
    this.name = "SeatRequestError";
  }
}

/** One open request per requester, owner and purpose: a repeat answers with the open card. Hashed, so a long invite list keeps the key short. */
function purposeKey(purpose: SeatsAddPurpose): string {
  const identity = (() => {
    switch (purpose.kind) {
      case "agent:create":
        return `agent:${purpose.name.toLowerCase()}`;
      case "assistant:create":
        return "assistant";
      case "invite":
        return `invite:${[...new Set(purpose.emails.map((email) => email.trim().toLowerCase()))].sort().join(",")}`;
      case "member:promote":
        return `promote:${purpose.userId}`;
      case "join":
        return `join:${purpose.userId}`;
    }
  })();
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

/** Whether the requester may do what the seats are for (checked when asking, and again before completing). */
async function requesterMayDo(serverId: string, userId: string, purpose: SeatsAddPurpose): Promise<boolean> {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role || role === "guest") return false;
  switch (purpose.kind) {
    case "agent:create":
      return actorHasServerCapabilityInServer(serverId, "user", userId, "createAgents");
    case "assistant:create":
      return true;
    case "invite":
      return actorHasServerCapabilityInServer(serverId, "user", userId, "inviteMembers");
    case "member:promote":
      return actorHasServerCapabilityInServer(serverId, "user", userId, "changeMemberRoles");
    case "join": {
      // Who sees the notice asks: an admin, or whoever made the link they opened.
      const block = await seatJoinBlockService.findWaitingSeatJoinBlock(serverId, purpose.userId);
      return block !== null && (role === "admin" || block.inviterUserId === userId);
    }
  }
}

/** Seats the server would need to add for `tenths` more, now (subscription refreshed first, as invites do); 0 when it fits. */
async function seatsShort(serverId: string, tenths: number): Promise<{ short: number; universal: boolean }> {
  await refreshSubscriptionForServerIfStale(serverId);
  const db = getDb();
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const seats = entitlement.capacity.maxUniversalSeats;
  if (seats === -1) return { short: 0, universal: false };
  const usage = await getServerBillingUsage(db, serverId);
  return { short: seatsShortFor({ seats, usedTenths: seatTenths(usage.humans, usage.agents), needTenths: tenths }), universal: true };
}

async function displayName(userId: string): Promise<string> {
  const [user] = await getDb().select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.displayName || user?.name || "Someone";
}

interface Asker {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
  serverId: ServerId;
  requesterUserId: string;
  /** The owner the requester chose; not read when the server picks (ownerToAsk). */
  ownerUserId?: string;
}

/** Every seat-request path is behind pro_seat_add: with it off, nothing is asked, completed or sent back. */
async function assertFlagOn(serverId: string, userId: string): Promise<void> {
  const flag = await evaluateFeatureFlag({ key: PRO_SEAT_ADD_FEATURE_FLAG_KEY, serverId, userId });
  if (!flag.enabled) throw new SeatRequestError(403, "FEATURE_DISABLED", "Requests to owners are not available on this server.");
}

/**
 * The owner a request goes to. A member the server hides its people from
 * (shouldHideHumanDirectoryFromRequester) doesn't choose: an id they send is
 * not read, so a request can't find out who is an owner, or open a DM with
 * someone they can't see (as POST /channels/dm refuses). The server picks an
 * owner they already have a DM with (the server's creator first, then the
 * most recent), else the creator. Anyone else chooses an owner.
 */
async function ownerToAsk(args: Asker): Promise<string> {
  if (await serverService.shouldHideHumanDirectoryFromRequester(args.serverId, args.requesterUserId)) {
    const owner = await ownerForHiddenRoster(args.serverId, args.requesterUserId);
    if (!owner) throw new SeatRequestError(409, "NOT_AN_OWNER", "This server has no owner to ask.");
    return owner;
  }
  const ownerRole = args.ownerUserId ? await getActorServerRoleInServer(args.serverId, "user", args.ownerUserId) : null;
  if (!args.ownerUserId || ownerRole !== "owner") throw new SeatRequestError(400, "NOT_AN_OWNER", "Requests go to an owner of this server.");
  return args.ownerUserId;
}

async function ownerForHiddenRoster(serverId: string, requesterUserId: string): Promise<string | null> {
  const db = getDb();
  const [owners, [server]] = await Promise.all([
    db.select({ userId: serverMembers.userId }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "owner")))
      .orderBy(asc(serverMembers.joinedAt), asc(serverMembers.userId)),
    db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId)).limit(1),
  ]);
  const ownerIds = new Set(owners.map((owner) => owner.userId));
  // The creator while still an owner, else the longest-standing one.
  const primary = server && ownerIds.has(server.ownerId) ? server.ownerId : owners[0]?.userId ?? null;
  // The DMs the DM route checks, most recent first.
  const talkedTo = (await channelService.listDMChannels(serverId, requesterUserId))
    .filter((dm) => dm.peerType === "user" && ownerIds.has(dm.peerId))
    .map((dm) => dm.peerId);
  return primary && talkedTo.includes(primary) ? primary : talkedTo[0] ?? primary;
}

/** Who may ask whom, the same for seats and for Pro: a member asks an owner. Answers with that owner. */
async function assertAsker(args: Asker): Promise<string> {
  await assertFlagOn(args.serverId, args.requesterUserId);
  const requesterRole = await getActorServerRoleInServer(args.serverId, "user", args.requesterUserId);
  if (!requesterRole || requesterRole === "guest") throw new SeatRequestError(403, "NOT_A_MEMBER", "Only members can ask an owner.");
  if (requesterRole === "owner") throw new SeatRequestError(409, "OWNER_ADDS_SEATS", "Owners do this themselves.");
  const ownerUserId = await ownerToAsk(args);
  const [open] = await getDb().select({ count: count() }).from(actionCards).where(and(
    eq(actionCards.serverId, args.serverId),
    eq(actionCards.requesterUserId, args.requesterUserId),
    eq(actionCards.state, "prepared"),
    // Requests only: an agent:create card an owner sent back isn't one.
    inArray(actionCards.actionType, ["seats:add", "plan:upgrade"]),
  ));
  if ((open?.count ?? 0) >= MAX_OPEN_REQUESTS_PER_REQUESTER) {
    throw new SeatRequestError(429, "TOO_MANY_OPEN", "You have too many requests waiting for an owner.");
  }
  return ownerUserId;
}

export interface RequestSeatsArgs extends Asker {
  purpose: SeatsAddPurpose;
  reason?: string;
}

/**
 * Posts a `seats:add` card from the requester to an owner in their DM (or
 * answers with the open one for the same purpose). The seat count is the
 * server's own: what the purpose needs beyond the seats bought, now.
 */
export async function requestSeats(args: RequestSeatsArgs): Promise<{ messageId: string; channelId: string; existing: boolean }> {
  const ownerUserId = await assertAsker(args);
  let purpose = seatsAddPurposeSchema.parse(args.purpose);
  if (purpose.kind === "member:promote") {
    // Who is promoted is the server's to say: the card shows their real name,
    // and only a Guest takes a seat by becoming a member.
    // No rollout flag: an existing Guest can always be promoted (#wg-rbac:#15).
    const targetRole = await getActorServerRoleInServer(args.serverId, "user", purpose.userId);
    if (targetRole !== "guest") throw new SeatRequestError(400, "NOT_A_GUEST", "Only a Guest takes a seat by becoming a member.");
    purpose = { ...purpose, name: await displayName(purpose.userId) };
  }
  if (purpose.kind === "join") {
    // Only someone a full link turned away here, under their real name.
    if (!await seatJoinBlockService.findWaitingSeatJoinBlock(args.serverId, purpose.userId)) {
      throw new SeatRequestError(400, "NOT_BLOCKED", "No one by that id is waiting to join this server.");
    }
    purpose = { ...purpose, name: await displayName(purpose.userId) };
  }
  if (!await requesterMayDo(args.serverId, args.requesterUserId, purpose)) {
    throw new SeatRequestError(403, "NOT_ALLOWED", "You can't do what these seats are for.");
  }
  const { short, universal } = await seatsShort(args.serverId, seatsAddPurposeTenths(purpose));
  if (!universal) throw new SeatRequestError(409, "NOT_PRO", "This server has no seats to add.");

  const action: SeatsAddAction = {
    type: "seats:add",
    seats: Math.max(1, short),
    purpose,
    ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    expiresAt: new Date(Date.now() + SEAT_REQUEST_TTL_MS).toISOString(),
  };
  return postPersonCard({ ...args, ownerUserId }, action, `seats:add:${args.serverId}:${args.requesterUserId}:${ownerUserId}:${purposeKey(purpose)}`,
    action.seats === 1 ? "Asked to add 1 seat" : `Asked to add ${action.seats} seats`);
}

export interface RequestUpgradeArgs extends Asker {
  gate?: AgentUpgradeCardGate;
  reason: string;
}

/**
 * A member or admin of a Free server asks an owner for Pro with the same card an
 * agent offers it with (`plan:upgrade`), from the upgrade dialog. The owner
 * opens the upgrade dialog from it; it ends done once the server leaves Free.
 */
export async function requestUpgrade(args: RequestUpgradeArgs): Promise<{ messageId: string; channelId: string; existing: boolean }> {
  const ownerUserId = await assertAsker(args);
  if (!await isServerOnFreePlan(args.serverId)) throw new SeatRequestError(409, "NOT_PRO", "This server is already on Pro.");
  const parsed = planUpgradeOperationSchema.safeParse({ type: "plan:upgrade", reason: args.reason, ...(args.gate ? { gate: args.gate } : {}) });
  if (!parsed.success) throw new SeatRequestError(400, "NOT_ALLOWED", parsed.error.issues[0]?.message ?? "The reason is not valid.");
  const gate = parsed.data.gate ?? GENERAL_UPGRADE_GATE;
  return postPersonCard({ ...args, ownerUserId }, parsed.data, `plan:upgrade:person:${args.serverId}:${args.requesterUserId}:${ownerUserId}:${gate}`, "Asked for Pro");
}

/** A person's card left open past its time: a seat request by its `expiresAt`, a Pro request by its age. */
function isStale(action: PersonCardAction, createdAt: Date, now = Date.now()): boolean {
  return action.type === "seats:add"
    ? Date.parse(action.expiresAt) <= now
    : createdAt.getTime() + SEAT_REQUEST_TTL_MS <= now;
}

/**
 * Posts a person's card from the requester to the owner in their DM, through
 * the DM's normal delivery (socket, inbox, the owner's notification), or
 * answers with the open card under the same dedupe key. An open card past its
 * time ends expired first, so it doesn't stand in for a new request.
 */
async function postPersonCard(args: Asker & { ownerUserId: string }, action: PersonCardAction, dedupeKey: string, content: string): Promise<{ messageId: string; channelId: string; existing: boolean }> {
  const dm = await channelService.findOrCreateUserDM(args.serverId, args.requesterUserId, args.ownerUserId, { hidePassivePeerOnCreate: true });
  if (!dm) throw new SeatRequestError(400, "NOT_AN_OWNER", "Couldn't open a direct message with that owner.");
  const server = await serverService.getServer(args.serverId);
  const requesterName = await displayName(args.requesterUserId);
  const metadata: ActionCardMetadata = {
    kind: "action-card",
    sourceServerId: args.serverId,
    targetServerName: server?.name ?? null,
    action,
    // The card as data (presentation.card), as an agent's card has it, so
    // every client draws a person's card with the same spec.
    presentation: actionCardPresentationFor(action, {
      serverName: server?.name ?? "",
      requesterUserId: args.requesterUserId,
      names: { users: { [args.requesterUserId]: requesterName } },
    }),
    state: "prepared",
    requesterUserId: args.requesterUserId,
    confirmationVersion: 1,
  };
  const out: Posted = await insertPersonCard(dm.id, args, action, dedupeKey, content, metadata);
  if (out.kind === "existing") return { messageId: out.messageId, channelId: dm.id, existing: true };
  if (out.expiredMessageId) await emitUpdated(args.io, out.expiredMessageId);
  if (args.io && args.orchestrator) {
    // slack-bridge-ordinary-message-producer: seat_request.person_card
    await messageService.broadcastAndDeliver(args.io, args.orchestrator, {
      channelId: dm.id,
      senderType: "user",
      senderId: args.requesterUserId,
      senderName: requesterName,
      content: out.message.content,
      actionMetadata: metadata,
      prePersisted: { message: out.message, replayed: false },
    });
  }
  return { messageId: out.message.id, channelId: dm.id, existing: false };
}

type Posted = { kind: "existing"; messageId: string } | { kind: "posted"; message: typeof messages.$inferSelect; expiredMessageId: string | null };

async function insertPersonCard(
  channelId: string,
  args: Asker,
  action: PersonCardAction,
  dedupeKey: string,
  content: string,
  metadata: ActionCardMetadata,
): Promise<Posted> {
  try {
    return await insertPersonCardOnce(channelId, args, action, dedupeKey, content, metadata);
  } catch (err) {
    // Belt and braces for the advisory lock: the partial unique index caught a
    // second open card for this key, so answer with the one that won.
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code !== "23505") throw err;
    const [open] = await getDb().select({ messageId: actionCards.messageId }).from(actionCards)
      .where(and(eq(actionCards.dedupeKey, dedupeKey), eq(actionCards.state, "prepared"))).limit(1);
    if (!open) throw err;
    return { kind: "existing", messageId: open.messageId };
  }
}

function insertPersonCardOnce(
  channelId: string,
  args: Asker,
  action: PersonCardAction,
  dedupeKey: string,
  content: string,
  metadata: ActionCardMetadata,
): Promise<Posted> {
  return getDb().transaction(async (tx): Promise<Posted> => {
    // Serializes asks with the same key: the partial unique index would
    // otherwise turn a double click into a 500.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`);
    const [open] = await tx.select({ id: actionCards.id, messageId: actionCards.messageId, payload: actionCards.payload, createdAt: actionCards.createdAt })
      .from(actionCards)
      .where(and(eq(actionCards.dedupeKey, dedupeKey), eq(actionCards.state, "prepared")))
      .limit(1);
    let expiredMessageId: string | null = null;
    if (open) {
      const openAction = storedActionCardActionSchema.safeParse(open.payload);
      const stale = openAction.success && (openAction.data.type === "seats:add" || openAction.data.type === "plan:upgrade")
        && isStale(openAction.data, open.createdAt);
      if (!stale) return { kind: "existing", messageId: open.messageId };
      await endInTransaction(tx, open.id, open.messageId, "expired", {}, null);
      expiredMessageId = open.messageId;
    }
    const [message] = await tx.insert(messages).values({
      channelId,
      senderType: "user",
      senderId: args.requesterUserId,
      content,
      messageType: "chat",
      randomId: randomUUID(),
      actionMetadata: metadata,
    }).returning();
    await tx.insert(actionCards).values({
      serverId: args.serverId,
      messageId: message!.id,
      requesterUserId: args.requesterUserId,
      actionType: action.type,
      payload: action,
      dedupeKey,
      state: "prepared",
    });
    return { kind: "posted", message: message!, expiredMessageId };
  });
}

interface LoadedRequest {
  cardId: string;
  messageId: string;
  serverId: ServerId;
  requesterUserId: string;
  state: string;
  action: PersonCardAction;
  createdAt: Date;
  executedAt: Date | null;
  /** What came of a completed seat request (seatOutcome). */
  result: unknown;
}

/** A person's card: a seat request, or a member asking for Pro. */
async function loadRequest(messageId: string): Promise<LoadedRequest> {
  const [row] = await getDb().select({
    cardId: actionCards.id,
    serverId: actionCards.serverId,
    requesterUserId: actionCards.requesterUserId,
    state: actionCards.state,
    payload: actionCards.payload,
    createdAt: actionCards.createdAt,
    executedAt: actionCards.executedAt,
    result: actionCards.result,
  }).from(actionCards)
    .where(eq(actionCards.messageId, messageId))
    .limit(1);
  if (!row) throw new SeatRequestError(404, "NOT_FOUND", "Request not found.");
  if (!row.requesterUserId) throw new SeatRequestError(409, "NOT_SEAT_REQUEST", "This card is not a person's request.");
  const parsed = storedActionCardActionSchema.parse(row.payload);
  if (parsed.type !== "seats:add" && parsed.type !== "plan:upgrade") throw new SeatRequestError(409, "NOT_SEAT_REQUEST", "This card is not a person's request.");
  return {
    cardId: row.cardId,
    messageId,
    serverId: asServerId(row.serverId),
    requesterUserId: row.requesterUserId,
    state: row.state,
    action: parsed,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
    result: row.result,
  };
}

async function assertOwner(serverId: string, userId: string): Promise<void> {
  if (!await actorHasServerCapabilityInServer(serverId, "user", userId, "manageBilling")) {
    throw new SeatRequestError(403, "NOT_AN_OWNER", "Only an owner can act on this request.");
  }
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Ends a prepared card in `state`, clearing what a seat request held, on the
 * card row and its message (the action and the card drawn from it) together.
 * Conditional on `prepared`, so two owners (or a click and the sweep) can't
 * both end it; null when it was already ended.
 */
async function endInTransaction(
  tx: Transaction,
  cardId: string,
  messageId: string,
  state: "executed" | "expired",
  patch: Partial<ActionCardMetadata>,
  actorUserId: string | null,
): Promise<ActionCardMetadata | null> {
  const now = new Date();
  const [row] = await tx.select({ payload: actionCards.payload, metadata: messages.actionMetadata })
    .from(actionCards).innerJoin(messages, eq(messages.id, actionCards.messageId))
    .where(eq(actionCards.id, cardId)).limit(1);
  if (!row) return null;
  const parsed = storedActionCardActionSchema.safeParse(row.payload);
  // What a seat request held goes; a Pro request holds only the requester's own sentence.
  const clearedAction: StoredActionCardAction | null = !parsed.success ? null : parsed.data.type === "seats:add"
    ? (({ reason: _reason, ...rest }) => ({ ...rest, purpose: null }))(parsed.data)
    : parsed.data;
  const cleared = clearedAction ?? row.payload;
  const [claimed] = await tx.update(actionCards)
    .set({
      state,
      payload: cleared,
      // Derived from what it held (emails): gone with it.
      dedupeKey: null,
      updatedAt: now,
      ...(state === "executed" ? { executedAt: now, executedByUserId: actorUserId } : {}),
    })
    .where(and(eq(actionCards.id, cardId), eq(actionCards.state, "prepared")))
    .returning({ id: actionCards.id });
  if (!claimed) return null;
  const stored = row.metadata as ActionCardMetadata;
  const metadata = {
    ...stored,
    ...patch,
    action: cleared,
    // The card drawn when it was asked showed the purpose and the reason (an
    // invite's addresses): drawn again from what is left.
    ...(clearedAction ? {
      presentation: actionCardPresentationFor(clearedAction, {
        names: storedActionCardSpecNames(stored.presentation),
        ...(stored.targetServerName ? { serverName: stored.targetServerName } : {}),
        ...(stored.requesterUserId ? { requesterUserId: stored.requesterUserId } : {}),
      }),
    } : {}),
    state,
  } as ActionCardMetadata;
  await tx.update(messages).set({ actionMetadata: metadata, updatedAt: now }).where(eq(messages.id, messageId));
  return metadata;
}

function endRequest(request: LoadedRequest, state: "executed" | "expired", patch: Partial<ActionCardMetadata>, actorUserId: string | null): Promise<ActionCardMetadata | null> {
  return getDb().transaction((tx) => endInTransaction(tx, request.cardId, request.messageId, state, patch, actorUserId));
}

async function emitUpdated(io: SocketServer | null | undefined, messageId: string): Promise<void> {
  if (io) await emitActionCardMessageUpdated(io, { id: messageId });
}

/** Tells the person who asked how their card ended, in its thread (best effort; it never fails the end). */
function replyToRequester(
  args: { io: SocketServer | null | undefined; orchestrator: AgentOrchestrator | null | undefined },
  messageId: string,
  confirmerUserId: string | null,
  outcome: ActionCardResultReplyOutcome,
): Promise<void> {
  return postActionCardResultReply({ io: args.io, orchestrator: args.orchestrator, messageId, confirmerUserId, outcome });
}

export interface ResolveSeatRequestArgs {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
  serverId: ServerId;
  userId: string;
  messageId: string;
}

/**
 * Whether what a request is for can still be done once the seats are there.
 * Invites and a promotion are the owner's to finish; an agent or assistant
 * waits on the requester still being able to (they may have left or lost the
 * right). For a `join` it means something else: whether the person a full
 * link turned away still needs a seat, whoever asked (not joined since; a
 * notice ended `room` or `expired` still needs one: stillNeedsSeatToJoin).
 */
async function requesterStillCan(serverId: string, requesterUserId: string, purpose: SeatsAddPurpose): Promise<boolean> {
  switch (purpose.kind) {
    case "invite":
    case "member:promote":
      return true;
    case "join":
      return seatJoinBlockService.stillNeedsSeatToJoin(serverId, purpose.userId);
    case "agent:create":
    case "assistant:create":
      return requesterMayDo(serverId, requesterUserId, purpose);
  }
}

/**
 * After the owner added the seats: ends the request done (claimed once),
 * finishes what the owner can (`finishAsOwner`), records the outcome on the
 * card for both and tells the requester in the card's thread what came of it.
 * Nothing is done as the requester. A request the requester can no longer use
 * ends at once (`requester_cannot`), with nothing to pay for: it isn't left
 * open to expire as if no owner had answered. So does a join for someone who
 * no longer needs a seat (`not_needed`: they joined); one whose notice ended
 * `room` or `expired` ends `ready` (they open the link again).
 */
export async function completeSeatRequest(args: ResolveSeatRequestArgs): Promise<{ metadata: ActionCardMetadata; outcome: SeatRequestOutcome }> {
  const request = await loadRequest(args.messageId);
  if (request.serverId !== args.serverId) throw new SeatRequestError(404, "NOT_FOUND", "Request not found.");
  await assertFlagOn(request.serverId, args.userId);
  await assertOwner(request.serverId, args.userId);
  if (request.action.type !== "seats:add") throw new SeatRequestError(409, "NOT_SEAT_REQUEST", "This card is not a seat request.");
  if (request.state !== "prepared") throw new SeatRequestError(409, "ALREADY_RESOLVED", "This request was already answered.");
  if (isStale(request.action, request.createdAt)) {
    if (await endRequest(request, "expired", {}, null)) {
      await emitUpdated(args.io, args.messageId);
      await replyToRequester(args, args.messageId, args.userId, { kind: "expired" });
    }
    throw new SeatRequestError(409, "EXPIRED", "This request expired.");
  }
  const purpose = request.action.purpose;
  if (!purpose) throw new SeatRequestError(409, "ALREADY_RESOLVED", "This request was already answered.");
  // Asked first: whether the requester still can decides whether seats are needed at all.
  const allowed = await requesterStillCan(request.serverId, request.requesterUserId, purpose);
  if (allowed) {
    const { short } = await seatsShort(request.serverId, seatsAddPurposeTenths(purpose));
    if (short > 0) throw new SeatRequestError(409, "SEATS_STILL_SHORT", "Add the seats first.");
  }

  const claimed = await endRequest(request, "executed", {
    executedAt: new Date().toISOString(),
    executedByUserId: args.userId,
    executedByUserName: await displayName(args.userId),
  }, args.userId);
  if (!claimed) throw new SeatRequestError(409, "ALREADY_RESOLVED", "This request was already answered.");

  const outcome = await finishAsOwner(args, request.serverId, purpose, allowed);
  // The outcome on the card, for the owner as well as the requester.
  const metadata: ActionCardMetadata = { ...claimed, seatOutcome: outcome };
  await getDb().transaction(async (tx) => {
    await tx.update(messages).set({ actionMetadata: metadata, updatedAt: new Date() }).where(eq(messages.id, args.messageId));
    await tx.update(actionCards).set({ result: outcome, updatedAt: new Date() }).where(eq(actionCards.id, request.cardId));
  });
  await emitUpdated(args.io, args.messageId);
  // What came of it, to the requester (counts and names, never an address).
  // A join's person is named in the reply only: the card no longer holds them.
  await replyToRequester(args, args.messageId, args.userId, {
    kind: "seats_added",
    outcome,
    seats: request.action.seats,
    ...(purpose.kind === "join" ? { joinName: purpose.name } : {}),
  });
  return { metadata, outcome };
}

/**
 * What the owner's Add Seats finishes (cindyz, 2026-10-27): the invites and a
 * Guest's promotion, as the owner, who saw exactly what on the card. An agent
 * or assistant is the requester's own: it ends ready for them, or says they
 * no longer can (for an agent, the owner may send back an agent:create card:
 * sendCreateAgentCard).
 */
async function finishAsOwner(args: ResolveSeatRequestArgs, serverId: string, purpose: SeatsAddPurpose, requesterAllowed: boolean): Promise<SeatRequestOutcome> {
  if (purpose.kind === "invite") {
    let sent = 0;
    let failed = 0;
    // Deduplicated as the seats were counted (seatsAddPurposeTenths): one invite per address, whatever its case.
    for (const email of new Set(purpose.emails.map((value) => value.trim().toLowerCase()))) {
      try {
        await inviteService.createInvite(serverId, email, args.userId, "member");
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { kind: "invites", sent, failed };
  }
  if (purpose.kind === "member:promote") {
    try {
      const result = await serverService.transitionMemberRole({
        serverId,
        actorUserId: args.userId,
        targetUserId: purpose.userId,
        nextRole: purpose.role,
      });
      if (result.changed) {
        args.io?.to(`server:${serverId}`).emit("server:member-updated", {
          serverId,
          userId: purpose.userId,
          previousRole: result.previousRole,
          role: result.nextRole,
        });
      }
      return { kind: "promoted", name: purpose.name, role: purpose.role };
    } catch {
      // Not a Guest any more, say: the seat is there, and it can be done by hand.
      return seatRequestReadyOutcome(purpose);
    }
  }
  if (purpose.kind === "join") {
    // They joined since (requesterStillCan): ended without seats.
    if (!requesterAllowed) return { kind: "not_needed" };
    // Nothing to do as the owner: they open the link again. Their notice goes
    // (best effort: with a seat free the list hides it anyway).
    try {
      await seatJoinBlockService.resolveSeatJoinBlock({ serverId, userId: purpose.userId, reason: "room" });
    } catch (err) {
      console.error("[seat-requests] could not end the join notice", err instanceof Error ? err.message : err);
    }
    return seatRequestReadyOutcome(purpose);
  }
  return requesterAllowed ? seatRequestReadyOutcome(purpose) : { kind: "requester_cannot" };
}

/**
 * What an owner needs before paying for a seat request: whether the requester
 * can still do it (they may have left or lost the right; if not, completing
 * it ends it without seats), and how many seats are short now (0: complete it
 * straight away). It changes nothing. For a `join`, `requesterAllowed` means
 * the person a full link turned away still needs a seat (requesterStillCan).
 */
export async function checkSeatRequest(args: ResolveSeatRequestArgs): Promise<{ requesterAllowed: boolean; seatsShort: number }> {
  const request = await loadRequest(args.messageId);
  if (request.serverId !== args.serverId) throw new SeatRequestError(404, "NOT_FOUND", "Request not found.");
  await assertFlagOn(request.serverId, args.userId);
  await assertOwner(request.serverId, args.userId);
  if (request.action.type !== "seats:add" || !request.action.purpose || request.state !== "prepared") {
    throw new SeatRequestError(409, "ALREADY_RESOLVED", "This request was already answered.");
  }
  const purpose = request.action.purpose;
  const [allowed, { short }] = await Promise.all([
    requesterStillCan(request.serverId, request.requesterUserId, purpose),
    seatsShort(request.serverId, seatsAddPurposeTenths(purpose)),
  ]);
  return { requesterAllowed: allowed, seatsShort: short };
}

/** How long after a seat request is completed its owner may still send back the card to create its agent. */
const SEND_BACK_WINDOW_MS = SEAT_REQUEST_TTL_MS;

/**
 * After an agent's seat request is done (outcome ready, `agent:create`): the
 * owner sends the requester an ordinary `agent:create` card in the same DM,
 * from the owner (`requester_user_id` = the owner), named only from the
 * outcome. The requester creates the agent from it as from any agent's card
 * (CreateAgentDialog, then mark-executed), and the owner is told in its
 * thread. At most one per seat request: a repeat answers with that card.
 * The route checks the request is visible to the caller first.
 */
export async function sendCreateAgentCard(args: ResolveSeatRequestArgs): Promise<{ messageId: string; channelId: string; existing: boolean }> {
  const request = await loadRequest(args.messageId);
  if (request.serverId !== args.serverId) throw new SeatRequestError(404, "NOT_FOUND", "Request not found.");
  await assertFlagOn(request.serverId, args.userId);
  await assertOwner(request.serverId, args.userId);
  if (request.action.type !== "seats:add") throw new SeatRequestError(409, "NOT_SEAT_REQUEST", "This card is not a seat request.");
  const outcome = request.result as SeatRequestOutcome | null;
  if (request.state !== "executed" || outcome?.kind !== "ready" || outcome.purpose !== "agent:create") {
    throw new SeatRequestError(409, "NOT_READY", "This request isn't an agent that's ready to create.");
  }
  if (!request.executedAt || request.executedAt.getTime() + SEND_BACK_WINDOW_MS <= Date.now()) {
    throw new SeatRequestError(409, "EXPIRED", "This request was completed too long ago.");
  }
  // The name is the outcome's, never the caller's.
  const action = agentCreateOperationSchema.safeParse({ type: "agent:create", name: outcome.name });
  if (!action.success) throw new SeatRequestError(409, "NOT_READY", "This request's agent name can't be used.");

  // Only the DM the request is in: where the requester and this owner are.
  const [original] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, args.messageId)).limit(1);
  if (!original) throw new SeatRequestError(404, "NOT_FOUND", "Request not found.");
  const dmChannelId = original.channelId;
  const dmHumans = (await getDb().select({ userId: channelHumans.userId }).from(channelHumans)
    .where(eq(channelHumans.channelId, dmChannelId))).map((human) => human.userId);
  const dedupeKey = `agent:create:seat-request:${args.messageId}`;
  const server = await serverService.getServer(request.serverId);
  const metadata: ActionCardMetadata = {
    kind: "action-card",
    sourceServerId: request.serverId,
    targetServerName: server?.name ?? null,
    action: action.data,
    presentation: actionCardPresentationFor(action.data, { serverName: server?.name ?? "" }),
    state: "prepared",
    requesterUserId: args.userId,
    confirmationVersion: 1,
  };
  const content = `Sent a card to create ${action.data.name}`;
  const out = await getDb().transaction(async (tx): Promise<Posted> => {
    // One per seat request: serialized on the key, and looked up in any
    // state (a created agent's card is executed). The sender can see the
    // request, so is one of the DM's people: the lookup is theirs.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dedupeKey}))`);
    const [sent] = dmHumans.length === 0 ? [] : await tx.select({ messageId: actionCards.messageId }).from(actionCards)
      .where(and(inArray(actionCards.requesterUserId, dmHumans), eq(actionCards.dedupeKey, dedupeKey)))
      .limit(1);
    if (sent) return { kind: "existing", messageId: sent.messageId };
    const [message] = await tx.insert(messages).values({
      channelId: dmChannelId,
      senderType: "user",
      senderId: args.userId,
      content,
      messageType: "chat",
      randomId: randomUUID(),
      actionMetadata: metadata,
    }).returning();
    await tx.insert(actionCards).values({
      serverId: request.serverId,
      messageId: message!.id,
      requesterUserId: args.userId,
      actionType: action.data.type,
      payload: action.data,
      dedupeKey,
      state: "prepared",
    });
    return { kind: "posted", message: message!, expiredMessageId: null };
  });
  if (out.kind === "existing") return { messageId: out.messageId, channelId: dmChannelId, existing: true };
  if (args.io && args.orchestrator) {
    // slack-bridge-ordinary-message-producer: seat_request.create_agent_card
    await messageService.broadcastAndDeliver(args.io, args.orchestrator, {
      channelId: dmChannelId,
      senderType: "user",
      senderId: args.userId,
      senderName: await displayName(args.userId),
      content,
      actionMetadata: metadata,
      prePersisted: { message: out.message, replayed: false },
    });
  }
  return { messageId: out.message.id, channelId: dmChannelId, existing: false };
}

/**
 * The server left Free: open Pro requests from its people are done (not left
 * to expire), and each requester is told. Called when the plan changes
 * (billingService).
 */
export async function completeUpgradeRequests(
  io: SocketServer | null | undefined,
  serverId: string,
  orchestrator: AgentOrchestrator | null | undefined = null,
): Promise<void> {
  if (await isServerOnFreePlan(serverId)) return;
  const open = await getDb().select({ messageId: actionCards.messageId }).from(actionCards).where(and(
    eq(actionCards.serverId, serverId),
    eq(actionCards.actionType, "plan:upgrade"),
    eq(actionCards.state, "prepared"),
    isNotNull(actionCards.requesterUserId),
  ));
  for (const { messageId } of open) {
    try {
      const request = await loadRequest(messageId);
      if (await endRequest(request, "executed", { executedAt: new Date().toISOString() }, null)) {
        await emitUpdated(io, messageId);
        await replyToRequester({ io, orchestrator }, messageId, null, { kind: "upgraded" });
      }
    } catch (err) {
      console.error("[seat-requests] could not complete upgrade request", messageId, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Ends person cards left open past their time (not actionable any more,
 * nothing held; each requester is told), and notices of a full join link as
 * old (seatJoinBlockService). Returns how many cards ended.
 */
export async function sweepExpiredSeatRequests(
  io: SocketServer | null | undefined,
  orchestrator: AgentOrchestrator | null | undefined = null,
): Promise<number> {
  try {
    await seatJoinBlockService.sweepSeatJoinBlocks();
  } catch (err) {
    console.error("[seat-requests] could not expire join notices", err instanceof Error ? err.message : err);
  }
  const open = await getDb().select({ messageId: actionCards.messageId })
    .from(actionCards)
    .where(and(
      eq(actionCards.state, "prepared"),
      isNotNull(actionCards.requesterUserId),
      or(
        and(eq(actionCards.actionType, "seats:add"), lt(sql`(${actionCards.payload} ->> 'expiresAt')::timestamptz`, sql`now()`)),
        and(eq(actionCards.actionType, "plan:upgrade"), lt(actionCards.createdAt, new Date(Date.now() - SEAT_REQUEST_TTL_MS))),
      ),
    ))
    // The longest overdue first, then by id: each batch is a stable, oldest
    // first slice, not whatever order the table returns.
    .orderBy(
      sql`case when ${actionCards.actionType} = 'seats:add' then (${actionCards.payload} ->> 'expiresAt')::timestamptz
        else ${actionCards.createdAt} + (${SEAT_REQUEST_TTL_MS}::double precision * interval '1 millisecond') end asc`,
      asc(actionCards.id),
    )
    .limit(200);
  let ended = 0;
  for (const { messageId } of open) {
    // One bad row doesn't stop the rest.
    try {
      const request = await loadRequest(messageId);
      if (await endRequest(request, "expired", {}, null)) {
        ended += 1;
        await emitUpdated(io, messageId);
        await replyToRequester({ io, orchestrator }, messageId, null, { kind: "expired" });
      }
    } catch (err) {
      console.error("[seat-requests] could not expire", messageId, err instanceof Error ? err.message : err);
    }
  }
  return ended;
}

/** Hourly (and once soon after start): ends person requests and join notices past their TTL. */
export function startSeatRequestExpiryWorker(
  io: SocketServer | null | undefined,
  orchestrator: AgentOrchestrator | null | undefined,
): { stop(): void } {
  const sweep = () => {
    void sweepExpiredSeatRequests(io, orchestrator)
      .catch((err) => console.error("[seat-requests] expiry sweep failed:", err instanceof Error ? err.message : err));
  };
  const first = setTimeout(sweep, 60_000);
  first.unref?.();
  const interval = setInterval(sweep, 60 * 60 * 1000);
  interval.unref?.();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
