/**
 * External channel invites (#wg-rbac:#16): a host Server's owner or admin
 * invites people outside the Server to one of its channels by email. This
 * module owns the invite record (send, list, resend, revoke; P2a-1) and the
 * invitee's side: the invite page and accepting as a Guest (P2a-2).
 * Accepting by connecting a Server is externalInviteConnectService (P2a-3).
 * Every route is gated on external_channels_v1 for the host Server, except the
 * host's list and revoke, which keep working with the flag off (plan §2a).
 *
 * A pending invite past `expires_at` is expired whatever its status says:
 * reads filter on the time, and writers that need the (channel, email) slot
 * mark such rows expired first.
 */
import { isAgentLoungeChannel } from "./agentLoungeService";
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, validateEmailAddress } from "@botiverse/raft-shared";
import { resolveJointHumanMembershipScopes } from "./jointHumanMembershipAccess";
import { JointActorUnavailableError, lockJointActorFirst } from "./jointHumanMembershipMirror";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channelConversionJobs, channelExternalInvites, channelHumans, channelServerConnectRequests, channels, jointChannels, jointChannelServers, serverMembers, servers, users } from "../db/schema";
import { normalizeEmail } from "./emailNormalization";
import { sendExternalChannelInviteEmail } from "./emailService";
import { addHuman, canUserAccessChannel, getChannel, isAllSystemChannel, isChannelHuman, revokeChannelAccessAfterUpdate, updateChannel } from "./channelService";
import { withChannelWriterFence } from "./channelConversionFenceService";
import { acquireServerAdmissionLocks, acquireServerLock, EXTERNAL_INVITE_DAILY_CAP_LOCK_NAMESPACE } from "./planService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { addMember, lockServerMembershipsAfterChannel } from "./serverService";
import { isCommunityServerSlug } from "./inviteService";
import { actorRoleHasServerCapability, serverRolesWithCapability } from "../lib/actorPermissions";
import {
  assertCanAdmitExternalGuest,
  assertCanSendExternalInvites,
  countChannelParties,
  EXTERNAL_CHANNEL_MAX_SLOTS,
  ExternalChannelLimitError,
  externalInviteFreeLimitReached,
  externalInviteSlotsLeft,
  FREE_SEND_LIMIT_MESSAGE,
  hasOtherExternalChannel,
  NO_CHANNEL,
  OPEN_EXTERNAL_INVITE_STATUSES,
  isReservationStatus,
  RESERVATION_STATUSES,
} from "./externalChannelLimitService";
import { freeServerIds } from "./jointChannelLimitService";
import { reconcileServerExternalFreeze } from "./externalChannelFreezeService";

export const EXTERNAL_INVITE_MAX_ENTRIES = 20;
export const EXTERNAL_INVITE_DAILY_CAP = 100;
export const EXTERNAL_INVITE_EXPIRY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ExternalInviteErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "channel_not_invitable"
  | "channel_archived"
  | "make_private_required"
  | "channel_membership_required"
  | "invite_not_pending"
  | "connecting"
  | "daily_cap"
  | "invite_open";

export class ExternalInviteError extends Error {
  constructor(readonly code: ExternalInviteErrorCode, message: string) {
    super(message);
    this.name = "ExternalInviteError";
  }
}

export interface ExternalInviteClassification {
  valid: string[];
  duplicates: string[];
  invalid: string[];
  alreadyPending: string[];
  /** Members of the host Server (not Guests) who are not in the channel yet: a send adds them to it (design A2). */
  alreadyMembers: string[];
  /** People already in the channel (a member, or its own Guest): nothing to do. */
  alreadyInChannel: string[];
  /**
   * Guests of another channel of the host Server, who can't be invited (a
   * Guest belongs to one channel): the channel is named only when the
   * inviter can see it (matrix §2), else null.
   */
  guestsElsewhere: Array<{ email: string; channelName: string | null }>;
}

export interface ExternalInvitePreview extends ExternalInviteClassification {
  /**
   * How many people the channel can still be invited (externalInviteSlotsLeft:
   * its 30 slots less its parties and open invites), before these: the
   * review's "You can invite N more", and the send refuses past it.
   */
  slotsLeft: number;
}

export interface SentExternalInvite {
  id: string;
  email: string;
  expiresAt: Date;
}

export interface SendExternalInvitesResult {
  sent: SentExternalInvite[];
  skipped: Omit<ExternalInviteClassification, "valid">;
  /**
   * The host Server's members among the addresses (`skipped.alreadyMembers`),
   * for the caller to add to the channel as the inviter (the add-member path,
   * with its permission check).
   */
  membersToAdd: Array<{ userId: string; email: string }>;
  /** Set when the send turned the channel private: the committed row, for the caller to publish. */
  madePrivate: typeof channels.$inferSelect | null;
}

export interface ListedExternalInvite {
  id: string;
  email: string;
  awaitingApproval: boolean;
  /** A server is being connected with it (P2a-3); revocable once the channel's conversion committed. */
  connecting: boolean;
  /** Which step of the connection a `connecting` invite is in; null otherwise. */
  connectPhase: "conversion" | "connection" | null;
  /** Whether revokeExternalInvite would end it now: false only while its conversion job is queued or running. */
  revocable: boolean;
  invitedBy: { id: string; name: string } | null;
  createdAt: Date;
  expiresAt: Date;
}

type Channel = typeof channels.$inferSelect;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(now: Date): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + EXTERNAL_INVITE_EXPIRY_DAYS * DAY_MS) };
}

/** Only the host Server's owner or admin manages external invites (channel admins and members do not). */
async function assertHostAdmin(serverId: string, userId: string, executor: DatabaseExecutor): Promise<void> {
  const [member] = await executor
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  if (member?.role !== "owner" && member?.role !== "admin") {
    throw new ExternalInviteError("forbidden", "Only server owners and admins can invite people outside the server");
  }
}

/**
 * A live, top-level channel people outside the server can be invited to: an
 * ordinary one (not a DM, thread, task or #all), or the host's own projection
 * of a joint channel (its jointChannelServers row is the host's, as the
 * channel's `jointRole` tells the web). Another server's projection of a joint
 * is refused like any channel that can't take invites: its outside parties
 * are the host's to invite.
 */
async function assertInvitableChannel(channel: Channel, executor: DatabaseExecutor): Promise<void> {
  if (channel.deletedAt) throw new ExternalInviteError("not_found", "Channel not found");
  const invitable = channel.type === "joint"
    ? await isHostJointProjection(executor, channel)
    : (channel.type === "channel" || channel.type === "private") && !isAllSystemChannel(channel);
  if (!invitable) {
    throw new ExternalInviteError("channel_not_invitable", "People outside the server can be invited only to ordinary channels and the joint channels it hosts");
  }
  if (channel.archivedAt) throw new ExternalInviteError("channel_archived", "This channel is archived");
}

/** Whether the channel is its server's host projection of an active joint channel. */
async function isHostJointProjection(executor: DatabaseExecutor, channel: Pick<Channel, "id" | "serverId">): Promise<boolean> {
  const [projection] = await executor.select({ role: jointChannelServers.role }).from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channel.id),
      eq(jointChannelServers.serverId, channel.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ));
  return projection?.role === "host";
}

/** The actor's users row first (lockJointActorFirst); retired or being deleted: refused as an actor who may not manage the channel's invites. */
async function lockActorFirstOrForbidden(tx: DatabaseExecutor, actorUserId: string): Promise<void> {
  await lockJointActorFirst(tx, actorUserId).catch((err: unknown) => {
    if (err instanceof JointActorUnavailableError) throw new ExternalInviteError("forbidden", "Only server owners and admins can invite people outside the server");
    throw err;
  });
}

/** The channel, once the actor is known to be a host owner/admin (so 403 comes before 400/409). */
async function loadManagedChannel(channelId: string, actorUserId: string, executor: DatabaseExecutor): Promise<Channel> {
  const channel = await getChannel(channelId, { executor });
  if (!channel) throw new ExternalInviteError("not_found", "Channel not found");
  await assertHostAdmin(channel.serverId, actorUserId, executor);
  return channel;
}

/** Splits raw entries (already one address each) into normalized valid addresses, duplicates and invalid ones. */
function classifyEntries(emails: readonly string[]): { valid: string[]; duplicates: string[]; invalid: string[] } {
  if (emails.length > EXTERNAL_INVITE_MAX_ENTRIES) {
    throw new ExternalInviteError("invalid_input", `At most ${EXTERNAL_INVITE_MAX_ENTRIES} emails at a time`);
  }
  const valid: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const entry = raw.trim();
    if (validateEmailAddress(entry) !== null) {
      invalid.push(entry);
      continue;
    }
    const email = normalizeEmail(entry);
    if (seen.has(email)) {
      duplicates.push(email);
      continue;
    }
    seen.add(email);
    valid.push(email);
  }
  return { valid, duplicates, invalid };
}

type ExternalInviteStatus = typeof channelExternalInvites.$inferSelect.status;
/** Statuses of an invite that is still open: listed, holding its (channel, email) slot. */
export const OPEN_INVITE_STATUSES: readonly ExternalInviteStatus[] = OPEN_EXTERNAL_INVITE_STATUSES;

/**
 * The full classification against the channel's live pending invites and the
 * host Server's people. `channelId` null: a channel about to be created
 * (Create Channel's External), which has no invites or members yet. Guests
 * of another channel are named by that channel only where `actorUserId` can
 * see it. `memberUserIds`: the user id of each `alreadyMembers` address.
 */
async function classifyAgainstState(
  target: { serverId: string; channelId: string | null },
  actorUserId: string,
  emails: readonly string[],
  now: Date,
  executor: DatabaseExecutor,
): Promise<{ preview: ExternalInviteClassification; memberUserIds: Map<string, string> }> {
  const { valid, duplicates, invalid } = classifyEntries(emails);
  const memberUserIds = new Map<string, string>();
  const empty = { alreadyPending: [], alreadyMembers: [], alreadyInChannel: [], guestsElsewhere: [] };
  if (valid.length === 0) return { preview: { valid, duplicates, invalid, ...empty }, memberUserIds };
  const { channelId } = target;
  const [pendingRows, memberRows] = await Promise.all([
    channelId === null ? Promise.resolve([]) : executor
      .select({ email: channelExternalInvites.email })
      .from(channelExternalInvites)
      .where(and(
        eq(channelExternalInvites.channelId, channelId),
        inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES),
        gt(channelExternalInvites.expiresAt, now),
        inArray(channelExternalInvites.email, valid),
      )),
    executor
      .select({
        userId: users.id,
        email: users.email,
        role: serverMembers.role,
        guestChannelId: serverMembers.guestChannelId,
        guestChannelName: channels.name,
        inChannel: channelId === null ? sql<boolean>`false` : sql<boolean>`exists (
          select 1 from ${channelHumans}
          where ${channelHumans.channelId} = ${channelId} and ${channelHumans.userId} = ${users.id}
        )`,
      })
      .from(users)
      .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, target.serverId)))
      .leftJoin(channels, eq(channels.id, serverMembers.guestChannelId))
      .where(inArray(users.email, valid)),
  ]);
  const pending = new Set(pendingRows.map((row) => row.email));
  const people = new Map(memberRows.map((row) => [normalizeEmail(row.email), row]));
  // One visibility check per distinct Guest channel, in turn: at most 20 addresses (EXTERNAL_INVITE_MAX_ENTRIES).
  const visibleGuestChannels = new Set<string>();
  const guestChannelIds = [...new Set(memberRows.flatMap((row) => (
    row.role === "guest" && row.guestChannelId && row.guestChannelId !== channelId ? [row.guestChannelId] : []
  )))];
  for (const guestChannelId of guestChannelIds) {
    if (await canUserAccessChannel(guestChannelId, actorUserId, asServerId(target.serverId), { executor })) {
      visibleGuestChannels.add(guestChannelId);
    }
  }
  const preview: ExternalInviteClassification = { valid: [], duplicates, invalid, alreadyPending: [], alreadyMembers: [], alreadyInChannel: [], guestsElsewhere: [] };
  for (const email of valid) {
    const person = people.get(email);
    if (pending.has(email)) {
      preview.alreadyPending.push(email);
    } else if (!person) {
      preview.valid.push(email);
    } else if (person.inChannel || (person.role === "guest" && channelId !== null && person.guestChannelId === channelId)) {
      preview.alreadyInChannel.push(email);
    } else if (person.role === "guest") {
      // A Guest of another channel (or a legacy Guest bound to none).
      const named = person.guestChannelId !== null && visibleGuestChannels.has(person.guestChannelId);
      preview.guestsElsewhere.push({ email, channelName: named ? person.guestChannelName : null });
    } else {
      preview.alreadyMembers.push(email);
      memberUserIds.set(email, person.userId);
    }
  }
  return { preview, memberUserIds };
}

/** Holds the host's cap lock through commit and refuses when `adding` more sends would pass the daily cap. */
async function assertDailyCap(tx: DatabaseExecutor, hostServerId: string, adding: number, now: Date): Promise<void> {
  if (adding === 0) return;
  await acquireServerLock(tx, hostServerId, EXTERNAL_INVITE_DAILY_CAP_LOCK_NAMESPACE);
  const [row] = await tx
    .select({ n: count() })
    .from(channelExternalInvites)
    .where(and(
      eq(channelExternalInvites.hostServerId, hostServerId),
      gt(channelExternalInvites.createdAt, new Date(now.getTime() - DAY_MS)),
    ));
  if ((row?.n ?? 0) + adding > EXTERNAL_INVITE_DAILY_CAP) {
    throw new ExternalInviteError("daily_cap", `A server can send at most ${EXTERNAL_INVITE_DAILY_CAP} external invites a day`);
  }
}

/**
 * Frees the (channel, email) open slot of invites that ran out (a connection
 * under way stops with it): each as lapsedInviteState, its pending requests
 * expired.
 */
async function expireLapsedInvites(tx: DatabaseExecutor, channelId: string, now: Date): Promise<void> {
  const lapsed = and(
    eq(channelExternalInvites.channelId, channelId),
    inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES),
    lte(channelExternalInvites.expiresAt, now),
    // A newer release's row is left as it is (it keeps its slot until that release ends it).
    knownInviteOriginSql(),
  );
  await tx.update(channelExternalInvites).set(lapsedInviteState({ acceptedServerId: "connected" }, now))
    .where(and(lapsed, isNotNull(channelExternalInvites.acceptedServerId)));
  await tx.update(channelExternalInvites).set(lapsedInviteState({ acceptedServerId: null }, now))
    .where(and(lapsed, isNull(channelExternalInvites.acceptedServerId)));
  await tx.update(channelServerConnectRequests).set({ status: "expired", decidedAt: now })
    .where(and(
      eq(channelServerConnectRequests.channelId, channelId),
      eq(channelServerConnectRequests.status, "pending"),
      lte(channelServerConnectRequests.expiresAt, now),
    ));
}

/**
 * How a send's invite emails fared with the mail provider, for the caller's
 * product event (`external_invite_email_sent`): counts only, and the host
 * server they are counted for. Never an address, an invite or the channel.
 */
export interface InviteEmailOutcomes {
  hostServerId: string;
  sent: number;
  failed: number;
}

/** Told once per send or resend that attempted an email, after the provider answered; never for a refused one. */
export type InviteEmailObserver = (outcomes: InviteEmailOutcomes) => void;

async function sendInviteEmails(
  channelId: string,
  hostServerId: string,
  inviterUserId: string,
  invites: readonly { email: string; token: string }[],
  onEmails: InviteEmailObserver | undefined,
): Promise<void> {
  if (invites.length === 0) return;
  const db = getDb();
  const [context] = await db
    .select({ channelName: channels.name, serverName: servers.name })
    .from(channels)
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(eq(channels.id, channelId));
  const [inviter] = await db
    .select({ name: users.name, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, inviterUserId));
  // The rows are committed: a failed delivery is logged, never rolled back,
  // and the admin can resend from the pending list.
  // fanout-ok: at most 20 invites per send (EXTERNAL_INVITE_MAX_ENTRIES); each item sends one email and runs no query.
  const results = await Promise.allSettled(invites.map((invite) => sendExternalChannelInviteEmail(invite.email, {
    inviterName: inviter?.displayName || inviter?.name || "Someone",
    channelName: context?.channelName ?? "a channel",
    serverName: context?.serverName ?? "a server",
    token: invite.token,
    expiresInDays: EXTERNAL_INVITE_EXPIRY_DAYS,
  })));
  let failed = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      console.error("external invite: failed to send email:", result.reason);
    }
  }
  try {
    onEmails?.({ hostServerId, sent: results.length - failed, failed });
  } catch {
    // an observer (analytics) never fails the send
  }
}

/**
 * What a send would make of the entries, and the slots left. A free host
 * that may not invite to this channel (externalInviteFreeLimitReached) is
 * refused here already, as the send would be.
 */
export async function previewExternalInvites(
  channelId: string,
  actorUserId: string,
  emails: readonly string[],
): Promise<ExternalInvitePreview> {
  const db = getDb();
  const channel = await loadManagedChannel(channelId, actorUserId, db);
  await assertInvitableChannel(channel, db);
  // Outside any transaction: the refresh may call the billing provider.
  await refreshSubscriptionForServerIfStale(channel.serverId);
  const now = new Date();
  if (await externalInviteFreeLimitReached(db, { serverId: channel.serverId, channelId: channel.id, now })) {
    throw new ExternalChannelLimitError("free_external_limit", FREE_SEND_LIMIT_MESSAGE, "host", channel.serverId);
  }
  const { preview } = await classifyAgainstState({ serverId: channel.serverId, channelId: channel.id }, actorUserId, emails, now, db);
  return { ...preview, slotsLeft: await externalInviteSlotsLeft(db, channel, now) };
}

/**
 * The review for a channel not created yet (Create Channel's External, design
 * E1: the review comes before the create): what a send right after the create
 * would make of the entries. A host owner or admin only, as for any preview.
 * The same limits as a send to a channel that is not external yet: a free
 * host with another external channel (or open invites to one) is refused,
 * and the slots are a new channel's (the host only).
 */
export async function previewExternalInvitesForNewChannel(
  serverId: string,
  actorUserId: string,
  emails: readonly string[],
): Promise<ExternalInvitePreview> {
  const db = getDb();
  await assertHostAdmin(serverId, actorUserId, db);
  // Outside any transaction: the refresh may call the billing provider.
  await refreshSubscriptionForServerIfStale(serverId);
  const now = new Date();
  if (await externalInviteFreeLimitReached(db, { serverId, channelId: NO_CHANNEL, now })) {
    throw new ExternalChannelLimitError("free_external_limit", FREE_SEND_LIMIT_MESSAGE, "host", serverId);
  }
  const { preview } = await classifyAgainstState({ serverId, channelId: null }, actorUserId, emails, now, db);
  return { ...preview, slotsLeft: await externalInviteSlotsLeft(db, { id: NO_CHANNEL, serverId, type: "private" }, now) };
}

/** Which creation path made an invite: every new row names one (channel_external_invites.origin). */
export type ExternalInviteOrigin = NonNullable<typeof channelExternalInvites.$inferInsert.origin>;

/** A new invite row: `origin` required, so a creation path that forgets it does not compile. */
export type NewExternalInvite = Omit<typeof channelExternalInvites.$inferInsert, "origin"> & { origin: ExternalInviteOrigin };

/**
 * The one way to create external invites: every path names its origin (NULL
 * is only an older node's row, from before the column). Returns the insert,
 * for the caller's conflict handling and returning(); `rows` not empty.
 */
export function insertExternalInvites(executor: DatabaseExecutor, rows: readonly NewExternalInvite[]) {
  return executor.insert(channelExternalInvites).values([...rows]);
}

/**
 * What this release does with an invite, by its origin (the creation path,
 * channel_external_invites.origin). Never an authorization input: it only
 * adds checks. NULL (made before the column, or by an older node during a
 * rolling deploy): exactly as it always did. self_connect: a channel member's
 * own operation (jointMemberConnectService), with its identity checks. Any
 * other value is a newer release's: null, and every reader refuses it (no
 * write, no answer but the neutral one).
 */
export type InviteFlow = "legacy" | "external_invite" | "host_direct" | "self_connect";

export function inviteFlow(origin: string | null): InviteFlow | null {
  switch (origin) {
    case null: return "legacy";
    case "external_invite": return "external_invite";
    case "host_direct": return "host_direct";
    case "self_connect": return "self_connect";
    default: return null;
  }
}

/**
 * Whether the invite's link may be used (the invite page, the Guest accept,
 * the invitee's connect, approval and cancel surfaces, the approver's request
 * page): an emailed or legacy invite, and a host owner/admin's own direct
 * connect as before (its token is thrown away). Never a self_connect
 * operation (it has no invitee and no link; its own route is
 * POST /channels/:id/connect-my-servers), never an origin this release does
 * not know.
 */
export function isTokenUsable(origin: string | null): boolean {
  const flow = inviteFlow(origin);
  switch (flow) {
    case "legacy":
    case "external_invite":
    case "host_direct": return true;
    case "self_connect":
    case null: return false;
  }
}

/** Rows whose origin this release knows (inviteFlow not null): bulk writers never touch another release's rows. */
export function knownInviteOriginSql(): SQL {
  return or(isNull(channelExternalInvites.origin), inArray(channelExternalInvites.origin, ["external_invite", "host_direct", "self_connect"]))!;
}

/**
 * The channel row (FOR UPDATE, under the caller's writer fence) of a channel
 * its host's owner or admin shares outside the server: a channel people
 * outside can be invited to (assertInvitableChannel; not a lounge), and when public, made
 * private only with `makePrivate` and by someone in it.
 */
async function lockChannelToShare(tx: DatabaseExecutor, channelId: string, actorUserId: string, options: { makePrivate?: boolean }): Promise<Channel> {
  const [locked] = await tx.select().from(channels).where(eq(channels.id, channelId)).for("update");
  if (!locked) throw new ExternalInviteError("not_found", "Channel not found");
  await assertHostAdmin(locked.serverId, actorUserId, tx);
  await assertInvitableChannel(locked, tx);
  if (await isAgentLoungeChannel(locked.id, tx)) {
    throw new ExternalInviteError("channel_not_invitable", "People outside the server cannot be invited to an agent's lounge");
  }
  if (locked.type === "channel") {
    if (!options.makePrivate) {
      throw new ExternalInviteError("make_private_required", "Make the channel private to invite people outside the server");
    }
    // As in PATCH /channels/:id: whoever turns a channel private must be in it,
    // or the change would lock them out of the channel they just invited to.
    if (!await isChannelHuman(locked.id, actorUserId, tx)) {
      throw new ExternalInviteError("channel_membership_required", "You must be a member of this channel to make it private");
    }
  }
  return locked;
}

/**
 * Before its host's owner or admin connects servers of theirs to a channel
 * (connectOwnServersToChannel, design "Your servers"; a joint channel it
 * hosts takes more servers the same way): the same checks as a send (lockChannelToShare), a public
 * channel made private as a send makes it, and the invite the connection
 * runs on. That invite is addressed to the actor and never emailed (its
 * token is thrown away): it carries the connection through the channel's
 * conversion exactly as an invitee's would (reservation, worker, revoke,
 * archive), with the actor as inviter, joiner and authorizer. In the
 * channel's open invites while a server is being connected with it.
 */
export async function createDirectConnectInvite(
  channelId: string,
  actorUserId: string,
  options: { makePrivate?: boolean },
): Promise<{ invite: InviteRow; channel: Channel; madePrivate: Channel | null; replaced: string | null }> {
  const committed = await withChannelWriterFence(channelId, async (tx) => {
    // The actor's users row first (the row this invite names), before the
    // channel row; retired or being deleted: as an actor who is gone (below).
    await lockActorFirstOrForbidden(tx, actorUserId);
    const locked = await lockChannelToShare(tx, channelId, actorUserId, options);
    const now = new Date();
    await expireLapsedInvites(tx, locked.id, now);
    const [actor] = await tx.select({ email: users.email }).from(users).where(eq(users.id, actorUserId));
    if (!actor) throw new ExternalInviteError("forbidden", "Only server owners and admins can invite people outside the server");
    const madePrivate = locked.type === "channel" ? await updateChannel(locked.id, { type: "private" }, tx) : null;
    const { tokenHash, expiresAt } = newInviteToken(now);
    const row = {
      channelId: locked.id,
      hostServerId: locked.serverId,
      email: normalizeEmail(actor.email),
      tokenHash,
      invitedByUserId: actorUserId,
      expiresAt,
      origin: "host_direct" as const,
    };
    const [invite] = await insertExternalInvites(tx, [row]).onConflictDoNothing().returning();
    if (invite) return { invite, channel: madePrivate ?? locked, madePrivate, replaced: null };
    // The (channel, email) slot is taken by an open invite to their own
    // address: one with a connection or approval under way is not theirs to
    // use. One left pending (nothing under way) of their own direct connects
    // (host_direct) is; an emailed or legacy (NULL-origin) one is not
    // relabelled (Tenny d47d7933): it is revoked as revokeExternalInvite
    // revokes it, which frees the slot, and a fresh host_direct invite takes it.
    const [open] = await tx.select().from(channelExternalInvites)
      .where(and(
        eq(channelExternalInvites.channelId, locked.id),
        eq(channelExternalInvites.email, row.email),
        inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES),
      ))
      .for("update");
    if (!open) {
      // The open invite the insert met was ended (revoked, expired) and
      // committed while this waited for its row: the slot is free now.
      const [retried] = await insertExternalInvites(tx, [row]).onConflictDoNothing().returning();
      if (retried) return { invite: retried, channel: madePrivate ?? locked, madePrivate, replaced: null };
    }
    // A self_connect operation of theirs (a member connecting their own
    // server) or an origin this release does not know is not theirs to
    // relabel or revoke here: refused as a connection under way.
    if (open?.status !== "pending" || open.origin === "self_connect" || inviteFlow(open.origin) === null) {
      throw new ExternalInviteError("connecting", "A server is already being connected to this channel. Try again once it's done.");
    }
    if (open.origin === "host_direct") return { invite: open, channel: madePrivate ?? locked, madePrivate, replaced: null };
    await revokeLockedInvite(tx, open, actorUserId, now);
    const [fresh] = await insertExternalInvites(tx, [row]).returning();
    return { invite: fresh!, channel: madePrivate ?? locked, madePrivate, replaced: open.id };
  });
  if (committed.madePrivate) await revokeChannelAccessAfterUpdate({ type: "private" }, committed.madePrivate);
  return committed;
}

/**
 * The operation a channel member's own connect runs on (self_connect,
 * jointMemberConnectService): an invite row addressed to them, never emailed
 * (its token is thrown away), carrying the connection exactly as a direct
 * connect's (reservation, worker, revoke, archive) with them as inviter,
 * joiner and authorizer. `jointGeneration`: on a joint channel, the
 * membership the operation starts from (member_at_start: each server it
 * connects is a source of exactly that one; never a first join). On a
 * private channel the reservation binds the membership (reserveConnection).
 * The caller has checked the actor (assertChannelMemberActor); the connection
 * re-checks everything under its own locks.
 *
 * An open invite to their address on this channel: their own pending
 * self_connect of the same membership is reused (two of their requests share
 * it, as Your servers does); one of an older membership is revoked (it is
 * theirs, and could only ever be refused); an emailed or legacy one is the
 * host's invitation and stays (invite_open); anything under way is refused.
 */
export async function createSelfConnectInvite(
  hostChannelId: string,
  actorUserId: string,
  jointGeneration: number | null,
): Promise<InviteRow> {
  return withChannelWriterFence(hostChannelId, async (tx) => {
    // The actor's users row first (the row this invite names), before the channel row.
    await lockJointActorFirst(tx, actorUserId).catch((err: unknown) => {
      if (err instanceof JointActorUnavailableError) throw new ExternalInviteError("not_found", "Channel not found");
      throw err;
    });
    const [kind] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, hostChannelId));
    // As the Guest accept and the joint archive take a joint copy's row: FOR NO KEY UPDATE.
    const [locked] = await tx.select().from(channels).where(eq(channels.id, hostChannelId))
      .for(kind?.type === "joint" ? "no key update" : "update");
    if (!locked || !isInvitableChannelOf(locked, locked.serverId)) throw new ExternalInviteError("not_found", "Channel not found");
    if (locked.archivedAt) throw new ExternalInviteError("channel_archived", "This channel is archived");
    const now = new Date();
    await expireLapsedInvites(tx, locked.id, now);
    const [actor] = await tx.select({ email: users.email }).from(users).where(eq(users.id, actorUserId));
    if (!actor) throw new ExternalInviteError("not_found", "Channel not found");
    const { tokenHash, expiresAt } = newInviteToken(now);
    const row: NewExternalInvite = {
      channelId: locked.id,
      hostServerId: locked.serverId,
      email: normalizeEmail(actor.email),
      tokenHash,
      invitedByUserId: actorUserId,
      expiresAt,
      origin: "self_connect",
      ...(jointGeneration === null ? {} : { sourceState: "member_at_start" as const, sourceGeneration: jointGeneration }),
    };
    const [invite] = await insertExternalInvites(tx, [row]).onConflictDoNothing().returning();
    if (invite) return invite;
    const [open] = await tx.select().from(channelExternalInvites)
      .where(and(
        eq(channelExternalInvites.channelId, locked.id),
        eq(channelExternalInvites.email, row.email),
        inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES),
      ))
      .for("update");
    if (!open) {
      // Ended (and committed) while this waited for its row: the slot is free now.
      const [retried] = await insertExternalInvites(tx, [row]).onConflictDoNothing().returning();
      if (retried) return retried;
      throw new ExternalInviteError("connecting", "A server is already being connected to this channel. Try again once it's done.");
    }
    if (open.status === "pending" && open.origin === "self_connect") {
      if (open.sourceGeneration === (jointGeneration ?? null) && open.sourceState === (jointGeneration === null ? null : "member_at_start")) return open;
      await revokeLockedInvite(tx, open, actorUserId, now);
      const [fresh] = await insertExternalInvites(tx, [row]).returning();
      return fresh!;
    }
    if (open.status === "pending" && (open.origin === null || open.origin === "external_invite")) {
      throw new ExternalInviteError("invite_open", "An invitation to this channel is open for your address. Use it from your email, or ask the channel's admins to revoke it.");
    }
    throw new ExternalInviteError("connecting", "A server is already being connected to this channel. Try again once it's done.");
  });
}

export async function sendExternalInvites(
  channelId: string,
  actorUserId: string,
  emails: readonly string[],
  options: { makePrivate?: boolean; onEmails?: InviteEmailObserver } = {},
): Promise<SendExternalInvitesResult> {
  // Outside the transaction: the refresh may call the billing provider. The
  // channel's server is read again under the lock.
  const unlocked = await getChannel(channelId);
  if (unlocked) await refreshSubscriptionForServerIfStale(unlocked.serverId);
  const committed = await withChannelWriterFence(channelId, async (tx) => {
    // The actor's users row first (the only person the invites name, as their
    // inviter), before the channel, server and daily-cap locks; retired or
    // being deleted: as an actor who is gone, as createDirectConnectInvite.
    await lockActorFirstOrForbidden(tx, actorUserId);
    const locked = await lockChannelToShare(tx, channelId, actorUserId, options);
    const now = new Date();
    await expireLapsedInvites(tx, locked.id, now);
    const { preview, memberUserIds } = await classifyAgainstState({ serverId: locked.serverId, channelId: locked.id }, actorUserId, emails, now, tx);
    // Only a send that invites someone turns the channel private.
    const madePrivate = locked.type === "channel" && preview.valid.length > 0
      ? await updateChannel(locked.id, { type: "private" }, tx)
      : null;
    await assertDailyCap(tx, locked.serverId, preview.valid.length, now);
    // Under the host's daily-cap lock (taken when anything is sent), so sends
    // to two of its channels at once see each other's invites.
    await assertCanSendExternalInvites(tx, { channel: locked, adding: preview.valid.length, now });
    const tokens = preview.valid.map((email) => ({ email, ...newInviteToken(now) }));
    const rows = tokens.length === 0 ? [] : await insertExternalInvites(tx, tokens.map((invite) => ({
      channelId: locked.id,
      hostServerId: locked.serverId,
      email: invite.email,
      tokenHash: invite.tokenHash,
      invitedByUserId: actorUserId,
      expiresAt: invite.expiresAt,
      origin: "external_invite",
    }))).returning({ id: channelExternalInvites.id, email: channelExternalInvites.email, expiresAt: channelExternalInvites.expiresAt });
    const { valid: _valid, ...skipped } = preview;
    const membersToAdd = [...memberUserIds].map(([email, userId]) => ({ userId, email }));
    return { rows, tokens, skipped, madePrivate, membersToAdd, hostServerId: locked.serverId };
  });
  // Post-commit, as updateChannel's own fenced path does: drop the sockets that lost read access.
  if (committed.madePrivate) await revokeChannelAccessAfterUpdate({ type: "private" }, committed.madePrivate);
  await sendInviteEmails(channelId, committed.hostServerId, actorUserId, committed.tokens, options.onEmails);
  return { sent: committed.rows, skipped: committed.skipped, madePrivate: committed.madePrivate, membersToAdd: committed.membersToAdd };
}

/**
 * Whether the server's owner/admin may start another external channel
 * (Create Channel's External, design E1): false when the free plan's one
 * external channel is taken (externalInviteFreeLimitReached for a channel
 * not created yet). The server's own plan, told to its owners and admins only.
 */
export async function getExternalChannelAvailability(serverId: string, actorUserId: string): Promise<{ freeLimitReached: boolean }> {
  const db = getDb();
  await assertHostAdmin(serverId, actorUserId, db);
  await refreshSubscriptionForServerIfStale(serverId);
  return { freeLimitReached: await externalInviteFreeLimitReached(db, { serverId, channelId: NO_CHANNEL, now: new Date() }) };
}

/**
 * The channel's open invites, newest first, and how many more people it can
 * be invited (externalInviteSlotsLeft, as the preview answers it): Invite
 * People Outside says so under the emails while they are typed (design E2).
 */
export async function listChannelExternalInvites(channelId: string, actorUserId: string): Promise<{ invites: ListedExternalInvite[]; slotsLeft: number }> {
  const db = getDb();
  const channel = await loadManagedChannel(channelId, actorUserId, db);
  const now = new Date();
  const rows = await db
    .select({
      id: channelExternalInvites.id,
      email: channelExternalInvites.email,
      status: channelExternalInvites.status,
      connectPhase: channelExternalInvites.connectPhase,
      conversionJobStatus: channelConversionJobs.status,
      invitedById: users.id,
      invitedByName: users.name,
      createdAt: channelExternalInvites.createdAt,
      expiresAt: channelExternalInvites.expiresAt,
    })
    .from(channelExternalInvites)
    .leftJoin(users, eq(users.id, channelExternalInvites.invitedByUserId))
    .leftJoin(channelConversionJobs, eq(channelConversionJobs.id, channelExternalInvites.connectConversionJobId))
    .where(and(
      eq(channelExternalInvites.channelId, channelId),
      inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES),
      gt(channelExternalInvites.expiresAt, now),
      // Invitations only: an emailed or legacy invite and a host owner/admin's
      // own direct connect. A member's self_connect operation is not an
      // invitation (it never names an address to the host; it holds a slot
      // while it runs, counted in slotsLeft), and an origin this release does
      // not know is not listed.
      or(isNull(channelExternalInvites.origin), inArray(channelExternalInvites.origin, ["external_invite", "host_direct"])),
    ))
    .orderBy(sql`${channelExternalInvites.createdAt} desc`, channelExternalInvites.id);
  const invites = rows.map((row) => ({
    id: row.id,
    email: row.email,
    awaitingApproval: row.status === "awaiting_approval",
    connecting: row.status === "connecting",
    connectPhase: row.status === "connecting" ? row.connectPhase : null,
    revocable: !conversionBlocksRevoke(row.status, row.connectPhase, row.conversionJobStatus),
    invitedBy: row.invitedById && row.invitedByName ? { id: row.invitedById, name: row.invitedByName } : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
  return { invites, slotsLeft: await externalInviteSlotsLeft(db, channel, now) };
}

/**
 * Locks an open invite of this channel in one of `statuses`, or refuses (404
 * for another channel's or a missing invite). Callers have already locked the
 * channel: the order is channel -> server -> invite.
 */
async function lockOpenInvite(tx: DatabaseExecutor, channelId: string, inviteId: string, now: Date, statuses: readonly ExternalInviteStatus[]) {
  const [invite] = await tx.select().from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.id, inviteId), eq(channelExternalInvites.channelId, channelId)))
    .for("update");
  if (!invite) throw new ExternalInviteError("not_found", "Invite not found");
  if (!statuses.includes(invite.status) || invite.expiresAt <= now) {
    throw new ExternalInviteError("invite_not_pending", "This invite is no longer pending");
  }
  // Another release's row: never written here.
  if (inviteFlow(invite.origin) === null) throw new ExternalInviteError("invite_not_pending", "This invite is no longer pending");
  return invite;
}

/**
 * A resend is a new send: the old row is retired as expired (its link stops
 * working) and a new pending row carries the new token and a fresh 14 days.
 * Being a row of its own, it counts toward the host's daily cap.
 */
export async function resendExternalInvite(
  channelId: string,
  inviteId: string,
  actorUserId: string,
  options: { onEmails?: InviteEmailObserver } = {},
): Promise<SentExternalInvite> {
  const committed = await getDb().transaction(async (tx) => {
    // The actor's users row first (the new row names them as its inviter),
    // before the member, invite and daily-cap locks; retired or being
    // deleted: as an actor who is gone, as sendExternalInvites.
    await lockActorFirstOrForbidden(tx, actorUserId);
    const now = new Date();
    const channel = await loadManagedChannel(channelId, actorUserId, tx);
    await assertInvitableChannel(channel, tx);
    // Only a plain pending invite: an approval in progress belongs to this one.
    const invite = await lockOpenInvite(tx, channelId, inviteId, now, ["pending"]);
    // A member's self_connect operation is no invitation to resend.
    if (invite.origin === "self_connect") throw new ExternalInviteError("invite_not_pending", "This invite is no longer pending");
    await assertDailyCap(tx, channel.serverId, 1, now);
    await tx.update(channelExternalInvites)
      .set({ status: "expired", decidedAt: now })
      .where(eq(channelExternalInvites.id, invite.id));
    const fresh = newInviteToken(now);
    // An email invite from now on, whatever the old row was: the resend emails its link.
    const [row] = await insertExternalInvites(tx, [{
      channelId,
      hostServerId: channel.serverId,
      email: invite.email,
      tokenHash: fresh.tokenHash,
      invitedByUserId: actorUserId,
      expiresAt: fresh.expiresAt,
      origin: "external_invite",
    }]).returning({ id: channelExternalInvites.id, email: channelExternalInvites.email, expiresAt: channelExternalInvites.expiresAt });
    return { row: row!, token: fresh.token, hostServerId: channel.serverId };
  });
  await sendInviteEmails(channelId, committed.hostServerId, actorUserId, [{ email: committed.row.email, token: committed.token }], options.onEmails);
  return committed.row;
}

/** The one rule for when revoking is refused (revokeExternalInvite) and listed as not revocable. */
function conversionBlocksRevoke(
  status: ExternalInviteStatus,
  connectPhase: typeof channelExternalInvites.$inferSelect.connectPhase,
  jobStatus: typeof channelConversionJobs.$inferSelect.status | null,
): boolean {
  return isReservationStatus(status) && connectPhase === "conversion" && (jobStatus === "pending" || jobStatus === "running");
}

/**
 * Ends an open invite. Refused only while the conversion job a connection
 * started is still queued or running, which cannot be interrupted (Cody,
 * Tenny 02a8b5b6). Once that job is terminal (done, failed restored or not,
 * cancelled, gone) revoking ends the reservation: the worker matches the
 * reservation's generation and never connects or resets a revoked one. The
 * channel and the job are left as they are; a job that did not end cleanly is
 * logged for repair. A pending approval request ends with the invite. Lock
 * order: the invite row, then its request row (as approve and reject).
 */
export async function revokeExternalInvite(channelId: string, inviteId: string, actorUserId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    // The actor's users row first (the invite names them as its revoker),
    // before the member and invite rows; retired or being deleted: as an
    // actor who is gone, as sendExternalInvites.
    await lockActorFirstOrForbidden(tx, actorUserId);
    await loadManagedChannel(channelId, actorUserId, tx);
    const now = new Date();
    const invite = await lockOpenInvite(tx, channelId, inviteId, now, OPEN_INVITE_STATUSES);
    await revokeLockedInvite(tx, invite, actorUserId, now);
  });
}

/**
 * revokeExternalInvite's writes, on an open invite whose row the caller
 * locked (FOR UPDATE): refused while its connection's conversion runs;
 * otherwise revoked by `actorUserId`, its connect state cleared and its
 * pending approval requests cancelled (the invite row, then its request rows).
 */
async function revokeLockedInvite(tx: DatabaseExecutor, invite: InviteRow, actorUserId: string, now: Date): Promise<void> {
  const channelId = invite.channelId;
  if (isReservationStatus(invite.status) && invite.connectPhase === "conversion") {
    const [job] = invite.connectConversionJobId
      ? await tx.select({ status: channelConversionJobs.status, progress: channelConversionJobs.progress }).from(channelConversionJobs)
        .where(eq(channelConversionJobs.id, invite.connectConversionJobId))
      : [];
    if (conversionBlocksRevoke(invite.status, invite.connectPhase, job?.status ?? null)) {
      throw new ExternalInviteError("connecting", "This invite is connecting a server and can't be revoked until the channel's conversion has finished");
    }
    const restored = job?.status === "failed" && (job.progress as { rollbackState?: unknown }).rollbackState === "restored";
    if (!job || (job.status === "failed" && !restored)) {
      console.error("[ExternalInvites] revoked an invite whose conversion did not end cleanly; channel and job left for repair", {
        inviteId: invite.id, jobId: invite.connectConversionJobId, jobStatus: job?.status ?? null, channelId,
      });
    }
  }
  await tx.update(channelExternalInvites)
    .set({ ...CLEARED_CONNECT_STATE, status: "revoked", decidedAt: now, revokedByUserId: actorUserId })
    .where(eq(channelExternalInvites.id, invite.id));
  await tx.update(channelServerConnectRequests)
    .set({ status: "cancelled", cancelReason: "invite_revoked", decidedAt: now })
    .where(and(eq(channelServerConnectRequests.inviteId, invite.id), eq(channelServerConnectRequests.status, "pending")));
}

/**
 * Archiving a channel ends its open invites and their pending approval
 * requests, in the archive's transaction (plan §8): unarchiving revives none,
 * so an old link stays invalid and the people need new invites. An invite
 * whose connection's conversion job is still running is left to finish, as a
 * manual revoke is refused then. Lock order: the channel (held by the caller),
 * the invite rows, then their request rows (as revokeExternalInvite).
 */
export async function revokeOpenInvitesForArchivedChannel(
  tx: DatabaseExecutor,
  channelId: string,
  actorUserId: string | null,
): Promise<number> {
  const open = await tx.select().from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, channelId), inArray(channelExternalInvites.status, OPEN_INVITE_STATUSES)))
    .orderBy(channelExternalInvites.id)
    .for("update");
  const now = new Date();
  let revoked = 0;
  for (const invite of open) {
    // Another release's row: left for it (logged), never written here.
    if (inviteFlow(invite.origin) === null) {
      console.error("[ExternalInvites] archive left an open invite of an origin this release does not know", { inviteId: invite.id, origin: invite.origin });
      continue;
    }
    if (isReservationStatus(invite.status) && invite.connectPhase === "conversion" && invite.connectConversionJobId) {
      const [job] = await tx.select({ status: channelConversionJobs.status }).from(channelConversionJobs)
        .where(eq(channelConversionJobs.id, invite.connectConversionJobId));
      if (conversionBlocksRevoke(invite.status, invite.connectPhase, job?.status ?? null)) continue;
    }
    await tx.update(channelExternalInvites)
      .set({ ...CLEARED_CONNECT_STATE, status: "revoked", decidedAt: now, revokedByUserId: actorUserId })
      .where(eq(channelExternalInvites.id, invite.id));
    await tx.update(channelServerConnectRequests)
      .set({ status: "cancelled", cancelReason: "invite_revoked", decidedAt: now })
      .where(and(eq(channelServerConnectRequests.inviteId, invite.id), eq(channelServerConnectRequests.status, "pending")));
    revoked += 1;
  }
  return revoked;
}

/** An invite leaving `connecting` drops its reservation (the CHECK ties connect_phase to that status). */
export const CLEARED_CONNECT_STATE = {
  connectPhase: null,
  connectServerId: null,
  connectJoinerUserId: null,
  connectAuthorizerUserId: null,
  connectConversionJobId: null,
  connectGeneration: null,
  connectOutcome: null,
  connectAttempts: 0,
  connectNextAttemptAt: null,
  connectLastError: null,
  connectQueuedServerIds: [] as string[],
} as const;

/**
 * An open invite whose time ran out: accepted when a server was connected
 * with it already (it connects several; the ones still waiting lapse), else
 * expired. Its pending approval requests expire with it (the caller's write).
 */
export function lapsedInviteState(invite: Pick<typeof channelExternalInvites.$inferSelect, "acceptedServerId">, now: Date) {
  return invite.acceptedServerId
    ? { ...CLEARED_CONNECT_STATE, status: "accepted" as const, outcome: "server" as const, decidedAt: now }
    : { ...CLEARED_CONNECT_STATE, status: "expired" as const, decidedAt: now };
}

/**
 * What an open invite becomes once nothing is being connected with it, read
 * under its row lock: awaiting_approval while a request of it waits for its
 * approver, else accepted once a server was connected with it (`outcome`:
 * how that one came), else pending for the invitee to choose again. An
 * invite connects several servers, so it stays open until every one chosen
 * is done.
 */
export async function restingInviteState(
  tx: DatabaseExecutor,
  invite: Pick<InviteRow, "id" | "acceptedServerId"> & Partial<Pick<InviteRow, "origin" | "invitedByUserId">>,
  now: Date,
  outcome: "server" | "new_server" = "server",
) {
  const [waiting] = await tx.select({ id: channelServerConnectRequests.id }).from(channelServerConnectRequests)
    .where(and(
      eq(channelServerConnectRequests.inviteId, invite.id),
      eq(channelServerConnectRequests.status, "pending"),
      gt(channelServerConnectRequests.expiresAt, now),
    ))
    .limit(1);
  if (waiting) return { ...CLEARED_CONNECT_STATE, status: "awaiting_approval" as const };
  if (invite.acceptedServerId) return { ...CLEARED_CONNECT_STATE, status: "accepted" as const, outcome, decidedAt: now };
  // A self_connect operation has nobody to choose again: one that connected
  // nothing ends (withdrawn by its actor), freeing its slot.
  if (invite.origin === "self_connect") {
    return { ...CLEARED_CONNECT_STATE, status: "revoked" as const, decidedAt: now, revokedByUserId: invite.invitedByUserId ?? null };
  }
  return { ...CLEARED_CONNECT_STATE, status: "pending" as const };
}

// ── The invitee's side (P2a-2) ──
// The invitee is not a member of the host Server yet, so these are reached by
// token, not through the channel. Every invite the caller may not use gets
// the same answer (Tenny): an unknown token, one no longer open, one for
// another address, a channel gone, moved or no longer invitable, the flag off
// on the host. Nothing tells whether an invite exists or to whom.

export type ExternalInviteAcceptErrorCode =
  | "invalid"
  | "approval_in_progress"
  | "connect_in_progress"
  | "guest_unavailable"
  | "channel_archived"
  | "already_member"
  | "guest_elsewhere";

export class ExternalInviteAcceptError extends Error {
  constructor(readonly code: ExternalInviteAcceptErrorCode, message: string) {
    super(message);
    this.name = "ExternalInviteAcceptError";
  }
}

export const INVALID_EXTERNAL_INVITE_MESSAGE = "This invite link is not valid";

export function invalidInvite(): ExternalInviteAcceptError {
  return new ExternalInviteAcceptError("invalid", INVALID_EXTERNAL_INVITE_MESSAGE);
}

export interface ConnectableServer {
  id: string;
  name: string;
  /** As the caller's own server list has them (GET /api/servers): its slug and tile. */
  slug: string;
  avatarUrl: string | null;
  /** They own or administer it: connecting needs nobody's approval. */
  canConnectDirectly: boolean;
  /** A member only: an owner or admin of it must approve. */
  needsApproval: boolean;
  /** Who can approve, when it needs approval: its owners and admins. */
  approvers: { id: string; name: string; avatarUrl: string | null }[];
  /**
   * The free plan's one external channel keeps it from connecting: a free
   * server already in an external channel (the connect would answer
   * free_external_limit for it). Listed, not chosen.
   */
  atLimit: boolean;
  /**
   * At its limit, and the caller may pay for it (manageBilling: an owner),
   * so upgrading it is theirs. An admin or member reads false (they ask an
   * owner: `owners`).
   */
  canUpgrade: boolean;
  /**
   * At its limit: who can upgrade it (its members with manageBilling, its
   * owners), by name, for "Ask an owner". Only of a server the caller is a
   * member of (this list is their own servers); empty when not at its limit.
   */
  owners: ServerBillingOwner[];
}

/** A member of a server who may pay for it (manageBilling). */
export interface ServerBillingOwner {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** The caller's pending request for this invite (they asked an owner/admin of `serverId` to approve). */
export interface PendingConnectRequest {
  id: string;
  serverId: string;
  serverName: string;
  approverUserId: string;
  approverName: string;
  expiresAt: Date;
}

/** The caller's most recent request for this invite, when it ended without connecting. */
export interface EndedConnectRequest {
  status: "rejected" | "cancelled";
  decidedAt: Date | null;
  serverName: string;
  cancelReason: typeof channelServerConnectRequests.$inferSelect.cancelReason;
}

/**
 * One of the invitee's servers and where it stands with this invite (an
 * invite connects several): connected with it (not their servers that joined
 * the channel another way), being connected (the
 * reservation's server and the ones queued after it), or waiting for the
 * owner or admin they asked. To the invitee only.
 */
export interface InviteServerProgress {
  serverId: string;
  serverName: string;
  state: "connected" | "connecting" | "awaiting_approval";
  /** awaiting_approval: their request, and whom they asked. */
  requestId?: string;
  approverName?: string;
}

/** Where the invite's accepted invitee landed: the host channel (guest), or its projection on their server. */
export interface AcceptedExternalInvite {
  outcome: "guest" | "server" | "new_server";
  serverId: string;
  channelId: string;
  /** That channel's name where they landed (a projection may be named differently from the host's channel). */
  channelName: string;
}

export interface ExternalInviteForInvitee {
  channelName: string;
  serverName: string;
  inviterName: string;
  expiresAt: Date;
  /**
   * awaiting_approval or connecting: a connection with this invite is under
   * way. accepted: shown only to the person who accepted it (see `accepted`).
   */
  status: "pending" | "awaiting_approval" | "connecting" | "accepted";
  /** A connecting invite, to the invitee only: which step the connection is in. */
  connectPhase?: "conversion" | "connection";
  /** A connecting invite, to the invitee only: the server being connected (theirs), for the page to open. */
  connectServerId?: string;
  /** To the requester only, while their request waits for approval (the first, when several do). */
  pendingRequest?: PendingConnectRequest;
  /** To the requester only: every request of theirs waiting for approval (one per server). */
  pendingRequests?: PendingConnectRequest[];
  /** To the invitee only: their servers this invite connected, is connecting, or waits on (InviteServerProgress). */
  servers?: InviteServerProgress[];
  /** To the requester only: their latest request for this invite was declined or cancelled. */
  lastRequest?: EndedConnectRequest;
  /** An accepted invite, to the person who accepted it: where to go. */
  accepted?: AcceptedExternalInvite;
  /**
   * Whether the invite was sent to the caller's verified address (the check
   * every accept makes: assertInviteAddressedTo), so the page can say "not for
   * this account" on load rather than after a refused action.
   */
  addressedToYou: boolean;
  /**
   * What the invitee may do with it now. Joining as a Guest is off once the
   * channel is joint or a server is connecting to it (Guests in joint
   * channels come with P3). `connect.servers`: the servers they belong to
   * (not as a Guest) that could connect, while the invite is pending.
   * `newServer`: they may create a server and connect it
   * (POST .../connect-new-server), while the invite is pending, no server
   * is connecting to the channel and no Guest is bound to it (the connect
   * would refuse: offered only where it can go through).
   * `connect.slotsLeft`, with servers to connect: how many of them the
   * channel can still take (externalInviteSlotsLeft, this invite's own slot
   * given back: what it holds is what its connections fill).
   */
  options: { guest: boolean; connect: { servers: ConnectableServer[]; slotsLeft?: number }; newServer: boolean };
  /**
   * The channel has no slot left (EXTERNAL_CHANNEL_MAX_SLOTS outside
   * parties, the host one of them), so every way in would be refused: the
   * options are all off. Says nothing about any server's plan.
   */
  channelFull: boolean;
}

export interface ExternalGuestAcceptance {
  serverId: string;
  channelId: string;
  /** False for an idempotent retry: they were already this channel's Guest. */
  joined: boolean;
}

/**
 * The invite's channel is still where it was invited to: live, top-level, in
 * the host Server, and private (sending an invite makes it private, and a
 * channel with an external relation stays so: updateChannel), or joint once a
 * server has been connected with one of its invites (the host keeps its own
 * channel as its projection). A channel public anyway is refused like any
 * other unusable invite (Tenny).
 */
export function isInvitableChannelOf(channel: Channel | null | undefined, hostServerId: string): channel is Channel {
  return !!channel
    && !channel.deletedAt
    && channel.serverId === hostServerId
    && (channel.type === "private" || channel.type === "joint")
    && !isAllSystemChannel(channel);
}

/**
 * Whether a server is being connected to the channel with any of its invites
 * (one at a time): a reservation in connecting, or a self_connect operation's
 * in self_connecting, of any origin (one of another release holds the channel too).
 */
export async function channelHasConnectingInvite(executor: DatabaseExecutor, channelId: string, exceptInviteId?: string): Promise<boolean> {
  const rows = await executor.select({ id: channelExternalInvites.id }).from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, channelId), inArray(channelExternalInvites.status, RESERVATION_STATUSES)));
  return rows.some((row) => row.id !== exceptInviteId);
}

/** Whether the person is a Guest of the channel's server bound to another channel (or to none, a legacy Guest). */
async function isGuestElsewhere(executor: DatabaseExecutor, channel: Channel, userId: string): Promise<boolean> {
  const [row] = await executor.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  return row?.role === "guest" && row.guestChannelId !== channel.id;
}

/** Whether a Guest is bound to the channel (with the host flag off one blocks it becoming joint: boundGuestsBlockJoint). */
export async function hasBoundGuests(executor: DatabaseExecutor, channel: Pick<Channel, "id" | "serverId">): Promise<boolean> {
  const [row] = await executor.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.role, "guest"), eq(serverMembers.guestChannelId, channel.id)))
    .limit(1);
  return !!row;
}

/**
 * Whether bound Guests still keep the channel from becoming joint: only while
 * the host's external_channels_v1 is off. With it on (P3, #wg-rbac:#25) the
 * Guests are carried into the joint channel through the host projection.
 */
export async function boundGuestsBlockJoint(executor: DatabaseExecutor, channel: Pick<Channel, "id" | "serverId">): Promise<boolean> {
  if (!await hasBoundGuests(executor, channel)) return false;
  return !(await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: channel.serverId, userId: null }, executor)).enabled;
}

/**
 * Whether a joint channel refuses Guests (P3): unless it is the HOST's own
 * projection and the host's external_channels_v1 is on, the joint guest
 * rule (jointEntryIdentitySql) would never let one in.
 */
async function boundGuestsBlockJointEntry(executor: DatabaseExecutor, channel: Pick<Channel, "id" | "serverId">): Promise<boolean> {
  const scope = (await resolveJointHumanMembershipScopes({ serverId: asServerId(channel.serverId), localChannelIds: [channel.id] }, executor)).get(channel.id);
  return !scope || scope.entryServerId !== scope.hostServerId || !scope.guestEntryEnabled;
}

export async function externalChannelsEnabled(hostServerId: string, userId: string | null): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: hostServerId, userId })).enabled;
}

/**
 * The invite page: whoever holds the link sees where it leads, whichever
 * account they are signed in with (they may not be signed in as the invited
 * address yet), and never the invited address: a caller it isn't addressed to
 * is told so (`addressedToYou`) with the address masked. Null for any invite
 * that cannot be accepted now.
 */
/** The invite page for an account it wasn't sent to (a forwarded link): which address it was for, masked, and nothing else. */
export interface ExternalInviteNotAddressed {
  addressedToYou: false;
  invitedEmailMasked: string;
}

export async function getExternalInviteForInvitee(token: string, userId: string): Promise<ExternalInviteForInvitee | ExternalInviteNotAddressed | null> {
  return (await getExternalInvitePageForInvitee(token, userId))?.page ?? null;
}

/**
 * The invite page (getExternalInviteForInvitee) with the id of the invite it
 * is of and its host server, for the route's once-a-day page view event: never
 * answered or recorded (the route hashes the id into its dedupe key, and
 * reads the host's product analytics switch).
 */
export async function getExternalInvitePageForInvitee(
  token: string,
  userId: string,
): Promise<{ inviteId: string; hostServerId: string; page: ExternalInviteForInvitee | ExternalInviteNotAddressed } | null> {
  const db = getDb();
  const [invite] = await db.select().from(channelExternalInvites).where(eq(channelExternalInvites.tokenHash, hashToken(token)));
  // A self_connect operation has no link, and another release's invite is not read here.
  if (!invite || !isTokenUsable(invite.origin)) return null;
  const page = await inviteePageOf(invite, userId, db);
  return page ? { inviteId: invite.id, hostServerId: invite.hostServerId, page } : null;
}

async function inviteePageOf(invite: InviteRow, userId: string, db: ReturnType<typeof getDb>): Promise<ExternalInviteForInvitee | ExternalInviteNotAddressed | null> {
  if (invite.status === "accepted") return getAcceptedInviteForInvitee(invite, userId);
  // Ran out while a server it connected was in already (the ones still
  // waiting lapse with it): read as accepted, as a sweep would mark it
  // (lapsedInviteState).
  if (invite && OPEN_INVITE_STATUSES.includes(invite.status) && invite.expiresAt <= new Date() && invite.acceptedServerId) {
    return getAcceptedInviteForInvitee({ ...invite, ...lapsedInviteState(invite, invite.expiresAt) }, userId);
  }
  if (!invite || !OPEN_INVITE_STATUSES.includes(invite.status) || invite.expiresAt <= new Date()) return null;
  const channel = await getChannel(invite.channelId, { executor: db });
  if (!isInvitableChannelOf(channel, invite.hostServerId) || channel.archivedAt) return null;
  const [server] = await db.select({ name: servers.name, deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, invite.hostServerId));
  if (!server || server.deletedAt) return null;
  if (!await externalChannelsEnabled(invite.hostServerId, userId)) return null;
  // A full channel takes nobody: every way in needs a slot (the accept checks it again).
  const channelFull = invite.status === "pending" && await countChannelParties(db, channel) >= EXTERNAL_CHANNEL_MAX_SLOTS;
  const pending = invite.status === "pending" && !channelFull;
  const connectingHere = await channelHasConnectingInvite(db, channel.id);
  // The rest of the page is the link holder's; how their connection goes is the invitee's alone.
  const invitee = await isAddressedTo(invite, userId, db);
  // Another account holding the link (a forwarded email): only that it isn't
  // theirs and which address it was for, masked. Nothing of the channel, the
  // server or the inviter (cindyz #wg-rbac:5433e81b).
  if (!invitee) return { addressedToYou: false, invitedEmailMasked: maskInviteEmail(invite.email) };
  // A Guest belongs to one channel: one of another channel here (or a legacy
  // Guest bound to none) is not offered to join as a guest (matrix §3).
  const guestElsewhere = pending && await isGuestElsewhere(db, channel, userId);
  const connectable = pending ? await listConnectableServers(channel, userId) : [];
  // The invite is open and unexpired here, so externalInviteSlotsLeft counted it: its slot is the invitee's to fill.
  const connect = connectable.length > 0
    ? { servers: connectable, slotsLeft: await externalInviteSlotsLeft(db, channel, new Date(), 1) }
    : { servers: connectable };
  return {
    ...await inviteHeader(invite, channel.name, server.name, db),
    status: invite.status as ExternalInviteForInvitee["status"],
    addressedToYou: true,
    ...(invite.status === "connecting" && invite.connectPhase ? { connectPhase: invite.connectPhase } : {}),
    ...(invite.status === "connecting" && invite.connectServerId ? { connectServerId: invite.connectServerId } : {}),
    ...await inviteeProgress(invite, channel, userId, db),
    options: {
      // An approval or a connection under way holds the invite; a joint
      // channel, or one a server is connecting to, takes no Guests yet.
      guest: pending && (channel.type === "private" || (channel.type === "joint" && !await boundGuestsBlockJointEntry(db, channel)))
        && !connectingHere && !guestElsewhere,
      connect,
      newServer: pending && !connectingHere && !await boundGuestsBlockJoint(db, channel),
    },
    channelFull,
  };
}

/**
 * What a signed-out holder of an invite link may see (#wg-rbac:#39): that the
 * link is usable and which address it was sent to, masked, so they know which
 * address to sign in or sign up with. Nothing of the channel, the server or
 * who invited them (cindyz #wg-rbac:5433e81b): the email already said so to its
 * recipient, and a forwarded link shows no one else.
 */
export interface ExternalInviteLinkPreview {
  status: "valid";
  invitedEmailMasked: string;
}

/**
 * The signed-out landing page of an invite link: only that it is usable and
 * the invited address masked (ExternalInviteLinkPreview). Null for any invite
 * that cannot be accepted now (unknown, expired, revoked, used, archived
 * channel, deleted server, flag off): the route answers all of them with the
 * one invalid-invite body, so a link holder can't tell them apart. With it,
 * the id of the invite and its host server, for the route's once-a-day
 * `external_invite_link_opened`: never answered or recorded (the route hashes
 * the id into its dedupe key), and the host's product analytics switch, from
 * the same read of the host.
 */
export async function getExternalInviteLinkPreviewOf(token: string): Promise<{ inviteId: string; hostRecordsInviteEvents: boolean; preview: ExternalInviteLinkPreview } | null> {
  const db = getDb();
  const [invite] = await db.select().from(channelExternalInvites).where(eq(channelExternalInvites.tokenHash, hashToken(token)));
  // Link invites only (isTokenUsable): a self_connect operation has no link, and another release's invite is not read here.
  if (!invite || !isTokenUsable(invite.origin)) return null;
  if (!OPEN_INVITE_STATUSES.includes(invite.status) || invite.expiresAt <= new Date()) return null;
  const channel = await getChannel(invite.channelId, { executor: db });
  if (!isInvitableChannelOf(channel, invite.hostServerId) || channel.archivedAt) return null;
  const [server] = await db.select({ name: servers.name, deletedAt: servers.deletedAt, productAnalyticsEnabled: servers.productAnalyticsEnabled }).from(servers).where(eq(servers.id, invite.hostServerId));
  if (!server || server.deletedAt) return null;
  if (!await externalChannelsEnabled(invite.hostServerId, null)) return null;
  return { inviteId: invite.id, hostRecordsInviteEvents: server.productAnalyticsEnabled, preview: { status: "valid", invitedEmailMasked: maskInviteEmail(invite.email) } };
}

type InviteRow = typeof channelExternalInvites.$inferSelect;

async function inviteHeader(invite: InviteRow, channelName: string, serverName: string, db: DatabaseExecutor) {
  const [inviter] = invite.invitedByUserId
    ? await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, invite.invitedByUserId))
    : [];
  return { channelName, serverName, inviterName: inviter?.displayName || inviter?.name || "Someone", expiresAt: invite.expiresAt };
}

/**
 * The invited address as a link holder it isn't addressed to may see it: the
 * local part's first character, then "•••", then the domain as is
 * ("lena@contoso.com" -> "l•••@contoso.com"). Enough to recognise which of
 * one's addresses to sign in with, not to read the address off the link.
 */
export function maskInviteEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  // A local part of one or two characters would be fully shown by its first
  // character, so it is masked whole.
  if (at <= 2) return `•••${email.slice(at)}`;
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/** The invite was sent to this person's verified address. */
async function isAddressedTo(invite: InviteRow, userId: string, db: DatabaseExecutor): Promise<boolean> {
  const [user] = await db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId));
  return !!user?.emailVerified && normalizeEmail(user.email) === invite.email;
}

/**
 * The caller's approval requests for this invite (one per server: every
 * pending one, and the latest ended without connecting, declined or
 * cancelled) and their servers' progress (InviteServerProgress). Nothing
 * about anyone else's requests.
 */
async function inviteeProgress(
  invite: InviteRow,
  channel: Channel,
  userId: string,
  db: DatabaseExecutor,
): Promise<Pick<ExternalInviteForInvitee, "pendingRequest" | "pendingRequests" | "lastRequest" | "servers">> {
  const requests = await db
    .select({
      id: channelServerConnectRequests.id,
      status: channelServerConnectRequests.status,
      cancelReason: channelServerConnectRequests.cancelReason,
      serverId: channelServerConnectRequests.targetServerId,
      serverName: servers.name,
      approverUserId: channelServerConnectRequests.approverUserId,
      approverName: users.name,
      approverDisplayName: users.displayName,
      expiresAt: channelServerConnectRequests.expiresAt,
      decidedAt: channelServerConnectRequests.decidedAt,
    })
    .from(channelServerConnectRequests)
    .innerJoin(servers, eq(servers.id, channelServerConnectRequests.targetServerId))
    .innerJoin(users, eq(users.id, channelServerConnectRequests.approverUserId))
    .where(and(eq(channelServerConnectRequests.inviteId, invite.id), eq(channelServerConnectRequests.requesterUserId, userId)))
    .orderBy(sql`${channelServerConnectRequests.createdAt} desc`, sql`${channelServerConnectRequests.id} desc`);
  const now = new Date();
  const open = OPEN_INVITE_STATUSES.includes(invite.status);
  const pendingRequests: PendingConnectRequest[] = requests
    .filter((request) => open && request.status === "pending" && request.expiresAt > now)
    .reverse()
    .map((request) => ({
      id: request.id,
      serverId: request.serverId,
      serverName: request.serverName,
      approverUserId: request.approverUserId,
      approverName: request.approverDisplayName || request.approverName,
      expiresAt: request.expiresAt,
    }));
  const latest = requests[0];
  const lastRequest = latest && (latest.status === "rejected" || latest.status === "cancelled")
    ? { lastRequest: { status: latest.status, decidedAt: latest.decidedAt, serverName: latest.serverName, cancelReason: latest.cancelReason } }
    : {};
  const connected = await serversConnectedWith(invite, channel, userId, db);
  const connecting = invite.status === "connecting" && invite.connectServerId
    ? [invite.connectServerId, ...invite.connectQueuedServerIds].filter((id) => !connected.some((server) => server.id === id))
    : [];
  const connectingNames = connecting.length === 0 ? [] : await db.select({ id: servers.id, name: servers.name }).from(servers).where(inArray(servers.id, connecting));
  const progress: InviteServerProgress[] = [
    ...connected.map((server) => ({ serverId: server.id, serverName: server.name, state: "connected" as const })),
    ...connecting.map((id) => ({ serverId: id, serverName: connectingNames.find((row) => row.id === id)?.name ?? "", state: "connecting" as const })),
    ...pendingRequests.map((request) => ({
      serverId: request.serverId, serverName: request.serverName, state: "awaiting_approval" as const, requestId: request.id, approverName: request.approverName,
    })),
  ];
  return {
    ...(invite.status === "awaiting_approval" && pendingRequests[0] ? { pendingRequest: pendingRequests[0] } : {}),
    ...(pendingRequests.length > 0 ? { pendingRequests } : {}),
    ...lastRequest,
    ...(progress.length > 0 ? { servers: progress } : {}),
  };
}

/**
 * The servers this invite connected (connected_server_ids; accepted_server_id
 * for an invite connected before that was recorded) that are still active in
 * the channel's joint and that the caller still belongs to (not as a Guest).
 * Never their other servers that joined the channel another way.
 */
async function serversConnectedWith(invite: InviteRow, channel: Channel, userId: string, db: DatabaseExecutor): Promise<Array<{ id: string; name: string }>> {
  const ids = [...new Set([...(invite.acceptedServerId ? [invite.acceptedServerId] : []), ...invite.connectedServerIds])];
  if (channel.type !== "joint" || ids.length === 0) return [];
  const rows = await db
    .select({ id: servers.id, name: servers.name })
    .from(jointChannelServers)
    .innerJoin(servers, eq(servers.id, jointChannelServers.serverId))
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, servers.id), eq(serverMembers.userId, userId)))
    .where(and(
      inArray(servers.id, ids),
      eq(jointChannelServers.status, "active"),
      sql`${serverMembers.role} <> 'guest'`,
      sql`${jointChannelServers.jointChannelId} IN (
        SELECT ${jointChannelServers.jointChannelId} FROM ${jointChannelServers}
        WHERE ${jointChannelServers.localChannelId} = ${channel.id} AND ${jointChannelServers.serverId} = ${channel.serverId}
          AND ${jointChannelServers.status} = 'active'
      )`,
    ));
  // In the order connected.
  return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

/**
 * An accepted invite, to the person who accepted it only (signed in as the
 * invited verified address): where they landed, for the page that waited on
 * a 202. Anyone else, and an accepted invite whose host is gone, whose flag is
 * off or whose landing channel is gone, gets the neutral answer (null). It is
 * shown past the invite's expiry: it was accepted before then.
 */
async function getAcceptedInviteForInvitee(invite: InviteRow, userId: string): Promise<ExternalInviteForInvitee | null> {
  if (invite.acceptedUserId !== userId || !invite.outcome) return null;
  const db = getDb();
  if (!await isAddressedTo(invite, userId, db)) return null;
  const channel = await getChannel(invite.channelId, { executor: db });
  if (!isInvitableChannelOf(channel, invite.hostServerId)) return null;
  const [server] = await db.select({ name: servers.name, deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, invite.hostServerId));
  if (!server || server.deletedAt) return null;
  if (!await externalChannelsEnabled(invite.hostServerId, userId)) return null;
  let landing: { serverId: string; channelId: string; channelName: string } | null;
  if (invite.outcome === "guest") {
    landing = { serverId: channel.serverId, channelId: channel.id, channelName: channel.name };
  } else {
    // Their server's projection of the joint the host channel projects, while active.
    const [projection] = !invite.acceptedServerId ? [] : await db
      .select({ channelId: channels.id, channelName: channels.name, deletedAt: channels.deletedAt })
      .from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.serverId, invite.acceptedServerId),
        eq(jointChannelServers.status, "active"),
        sql`${jointChannelServers.jointChannelId} IN (
          SELECT ${jointChannelServers.jointChannelId} FROM ${jointChannelServers}
          WHERE ${jointChannelServers.localChannelId} = ${channel.id} AND ${jointChannelServers.serverId} = ${channel.serverId}
            AND ${jointChannelServers.status} = 'active'
        )`,
      ));
    landing = projection && !projection.deletedAt && invite.acceptedServerId
      ? { serverId: invite.acceptedServerId, channelId: projection.channelId, channelName: projection.channelName }
      : null;
  }
  if (!landing) return null;
  // A receipt survives token expiry and archiving, not loss of membership.
  // Revalidate before returning current private names or a landing target.
  const [member] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
    .from(serverMembers).innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.serverId, landing.serverId), eq(serverMembers.userId, userId), isNull(servers.deletedAt)));
  if (!member) return null;
  if (member.role === "guest") {
    // A still-bound Guest may see its archived receipt, while the ordinary
    // channel read stays denied. A stale binding alone grants nothing.
    if (invite.outcome !== "guest" || member.guestChannelId !== landing.channelId) return null;
    if (channel.type === "joint") {
      // P3: a joint Guest's receipt follows its live joint entry.
      if (!await canUserAccessChannel(landing.channelId, userId, asServerId(landing.serverId), { executor: db })) return null;
    } else if (channel.type !== "private" || !await isChannelHuman(landing.channelId, userId, db)) return null;
  } else if (!await canUserAccessChannel(landing.channelId, userId, asServerId(landing.serverId), { executor: db })) {
    return null;
  }
  return {
    ...await inviteHeader(invite, channel.name, server.name, db),
    status: "accepted",
    // Only the person who accepted it, at the invited verified address, gets here.
    addressedToYou: true,
    accepted: { outcome: invite.outcome, ...landing },
    ...(invite.outcome === "guest" ? {} : { servers: (await inviteeProgress(invite, channel, userId, db)).servers }),
    options: { guest: false, connect: { servers: [] }, newServer: false },
    channelFull: false,
  };
}

/**
 * The caller's servers that could connect to the channel: those they belong
 * to other than as a Guest, other than the host, the community servers
 * (/community, /community-cn: cindyz) and any already connected,
 * each with whether its own limit keeps it out (`atLimit`: the connecting
 * server's half of assertCanConnectExternalServer). The host's limit is not
 * the invitee's to know, and is not told here.
 */
export async function listConnectableServers(channel: Pick<Channel, "id" | "serverId" | "type">, userId: string): Promise<ConnectableServer[]> {
  const db = getDb();
  const rows = await db
    .select({ id: servers.id, name: servers.name, slug: servers.slug, avatarUrl: servers.avatarUrl, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(
      eq(serverMembers.userId, userId),
      sql`${serverMembers.role} <> 'guest'`,
      eq(servers.kind, "normal"),
      sql`${servers.deletedAt} IS NULL`,
      sql`${servers.id} <> ${channel.serverId}`,
    ))
    .orderBy(servers.name, servers.id);
  const connected = channel.type === "joint" ? new Set((await db
    .select({ serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.status, "active"),
      sql`${jointChannelServers.jointChannelId} IN (
        SELECT ${jointChannelServers.jointChannelId} FROM ${jointChannelServers}
        WHERE ${jointChannelServers.localChannelId} = ${channel.id} AND ${jointChannelServers.serverId} = ${channel.serverId}
      )`,
    ))).map((row) => row.serverId)) : new Set<string>();
  const connectable = rows.filter((row) => !connected.has(row.id) && !isCommunityServerSlug(row.slug));
  const approvalServerIds = connectable.filter((row) => row.role !== "owner" && row.role !== "admin").map((row) => row.id);
  const approverRows = approvalServerIds.length === 0 ? [] : await db
    .select({ serverId: serverMembers.serverId, id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(inArray(serverMembers.serverId, approvalServerIds), inArray(serverMembers.role, ["owner", "admin"])))
    .orderBy(users.name, users.id);
  const atLimit = await serversAtExternalLimit(db, connectable.map((row) => row.id));
  const owners = await billingOwnersOf(db, [...atLimit]);
  return connectable.map((row) => {
    const canConnectDirectly = row.role === "owner" || row.role === "admin";
    const approvers = canConnectDirectly ? [] : approverRows
      .filter((approver) => approver.serverId === row.id)
      .map((approver) => ({ id: approver.id, name: approver.displayName || approver.name, avatarUrl: approver.avatarUrl }));
    const limited = atLimit.has(row.id);
    return {
      id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl, canConnectDirectly, needsApproval: !canConnectDirectly, approvers,
      atLimit: limited,
      canUpgrade: limited && actorRoleHasServerCapability(row.role, "manageBilling"),
      owners: limited ? owners.get(row.id) ?? [] : [],
    };
  });
}

/**
 * The members of these servers who may pay for them (manageBilling), by
 * name, in one read. Only for servers the caller is a member of: their own
 * server's roster.
 */
export async function billingOwnersOf(db: DatabaseExecutor, serverIds: readonly string[]): Promise<Map<string, ServerBillingOwner[]>> {
  const byServer = new Map<string, ServerBillingOwner[]>();
  if (serverIds.length === 0) return byServer;
  const rows = await db
    .select({ serverId: serverMembers.serverId, id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(inArray(serverMembers.serverId, [...serverIds]), inArray(serverMembers.role, serverRolesWithCapability("manageBilling"))))
    .orderBy(users.name, users.id);
  for (const row of rows) {
    const list = byServer.get(row.serverId) ?? [];
    list.push({ id: row.id, name: row.displayName || row.name, avatarUrl: row.avatarUrl });
    byServer.set(row.serverId, list);
  }
  return byServer;
}

/**
 * "Your servers" (Create Channel's External and Invite People Outside): the
 * servers a host owner or admin owns or administers, other than the host,
 * that could connect to a channel of it, by the same rule as the invite
 * page's (listConnectableServers: ordinary servers only, and no community
 * one). Not read against a channel: for a joint channel the host invites
 * from, the web leaves out the servers already in it (and a connect to one
 * is refused as already_connected). The host's own owners and admins only.
 */
export async function listOwnConnectableServers(hostServerId: string, actorUserId: string): Promise<ConnectableServer[]> {
  await assertHostAdmin(hostServerId, actorUserId, getDb());
  await refreshSubscriptionForServerIfStale(hostServerId);
  const listed = await listConnectableServers({ id: NO_CHANNEL, serverId: hostServerId, type: "private" }, actorUserId);
  return listed.filter((server) => server.canConnectDirectly);
}

/**
 * The free ones among these servers that are already in an external channel:
 * a channel new to them would be a second (assertCanConnectExternalServer's
 * connecting half). One read per free server, in turn: the caller's own
 * servers, a short list.
 */
export async function serversAtExternalLimit(db: DatabaseExecutor, serverIds: readonly string[]): Promise<Set<string>> {
  const free = await freeServerIds(db, serverIds, new Date());
  const limited = new Set<string>();
  for (const serverId of free) {
    if (await hasOtherExternalChannel(db, serverId, NO_CHANNEL)) limited.add(serverId);
  }
  return limited;
}

/**
 * Accepts an external invite as a Guest of its channel: one transaction that
 * binds the person to the channel (server_members role guest with
 * guest_channel_id), adds them to it and marks the invite accepted.
 *
 * Lock order (ADMISSION_LOCK_ORDER in planService): the channel's conversion
 * writer fence (when it has one), the host's
 * SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE lock (the person may have no
 * server_members row to lock yet), the channel row, the server row (FOR
 * SHARE) and their server_members row, then the invite row; never the invite
 * first. Whether they may use the invite (open, unexpired, sent to their
 * verified address) is decided before any answer other than the neutral one.
 *
 * The caller owes the post-commit effects when `joined`.
 */
export async function acceptExternalInviteAsGuest(token: string, userId: string): Promise<ExternalGuestAcceptance> {
  const tokenHash = hashToken(token);
  // Unlocked: only to find the channel to lock first. Everything is re-read under the locks.
  const [found] = await getDb()
    .select({ channelId: channelExternalInvites.channelId, hostServerId: channelExternalInvites.hostServerId, status: channelExternalInvites.status })
    .from(channelExternalInvites)
    .where(eq(channelExternalInvites.tokenHash, tokenHash));
  if (!found || found.status === "revoked" || found.status === "expired") throw invalidInvite();
  if (!await externalChannelsEnabled(found.hostServerId, userId)) throw invalidInvite();
  // Outside the transaction: the refresh may call the billing provider.
  await refreshSubscriptionForServerIfStale(found.hostServerId);
  // The writer fence answers a conversion under way before any lock: only to
  // someone this invite is for (re-checked under the locks below).
  await assertInviteAddressedTo(tokenHash, userId);

  return withChannelWriterFence(found.channelId, async (tx) => {
    // The Guest's users row first (lockJointActorFirst: the membership, the
    // channel membership and the invite's acceptance name them), before the
    // admission lock; retired or being deleted: the neutral refusal.
    await lockJointActorFirst(tx, userId).catch((err: unknown) => {
      if (err instanceof JointActorUnavailableError) throw invalidInvite();
      throw err;
    });
    // The host's admission lock before the channel row; the channel must be
    // the host's (isInvitableChannelOf), so it is the channel server's lock.
    await acquireServerAdmissionLocks(tx, [found.hostServerId]);
    const now = new Date();
    // A joint projection is locked FOR NO KEY UPDATE (P3, Cody on PR #13205):
    // an admitted Guest's retry must not hold it against FOR KEY SHARE while
    // its own read mutation holds its member row; admissions and the archive
    // (also FOR NO KEY UPDATE) still serialize on it. The type read is
    // unlocked: only a conversion changes it, which the writer fence excludes.
    const [kind] = await tx.select({ type: channels.type }).from(channels).where(eq(channels.id, found.channelId));
    const [channel] = await tx.select().from(channels).where(eq(channels.id, found.channelId))
      .for(kind?.type === "joint" ? "no key update" : "update");
    if (!isInvitableChannelOf(channel, found.hostServerId)) throw invalidInvite();

    await lockServerMembershipsAfterChannel(tx, channel.serverId, [userId]);
    const [host] = await tx.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, channel.serverId));
    if (!host || host.deletedAt) throw invalidInvite();
    const [membership] = await tx
      .select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));

    const [invite] = await tx.select().from(channelExternalInvites)
      .where(and(eq(channelExternalInvites.tokenHash, tokenHash), eq(channelExternalInvites.channelId, channel.id)))
      .for("update");
    const [user] = await tx.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId));
    if (!invite || !user?.emailVerified || normalizeEmail(user.email) !== invite.email) throw invalidInvite();
    // A self_connect operation is never accepted as a Guest (it has no
    // link), and another release's invite is not used here.
    if (!isTokenUsable(invite.origin)) throw invalidInvite();

    const guestHere = membership?.role === "guest" && membership.guestChannelId === channel.id;
    // A server connecting with any of the channel's invites holds it: no
    // Guest until it is done (Guests in joint channels come with P3). Read
    // under the channel row, which the connection's reservation also holds.
    if (isReservationStatus(invite.status) || (invite.status === "pending" && await channelHasConnectingInvite(tx, channel.id))) {
      throw new ExternalInviteAcceptError("connect_in_progress", "A server is being connected to this channel. Try again once it's done.");
    }
    if (invite.status === "accepted") {
      // A retry of their own acceptance answers as the first did.
      if (invite.outcome === "guest" && invite.acceptedUserId === userId && guestHere) {
        return { serverId: channel.serverId, channelId: channel.id, joined: false };
      }
      throw invalidInvite();
    }
    if (invite.status === "awaiting_approval") {
      throw new ExternalInviteAcceptError("approval_in_progress", "A request to connect a server with this invite is waiting for approval.");
    }
    if (invite.status !== "pending" || invite.expiresAt <= now) throw invalidInvite();

    if (channel.archivedAt) throw new ExternalInviteAcceptError("channel_archived", "This channel is archived.");
    // P3: a joint channel takes Guests (bound to the host's projection, this
    // channel) while the host's external_channels_v1 is on, as the joint
    // guest rule reads it; otherwise as before.
    if (channel.type === "joint" && await boundGuestsBlockJointEntry(tx, channel)) {
      throw new ExternalInviteAcceptError("guest_unavailable", "This channel is shared with other servers, so it can't take guests yet. Connect a server to join it.");
    }
    if (membership && membership.role !== "guest") {
      throw new ExternalInviteAcceptError("already_member", "You're already a member of this server. Ask an admin to add you to the channel.");
    }
    // A Guest belongs to one channel (a legacy Guest, bound to none, too).
    if (membership && !guestHere) throw new ExternalInviteAcceptError("guest_elsewhere", "You can't join this channel as a guest.");

    if (!guestHere) {
      await assertCanAdmitExternalGuest(tx, { serverId: channel.serverId, channelId: channel.id, now });
      await addMember(channel.serverId, userId, "guest", { executor: tx, guestChannelId: channel.id });
    }
    // A joint channel's membership is admitted by the host, through the projection the Guest is bound to.
    await addHuman(channel.id, userId, { executor: tx, ...(channel.type === "joint" ? { boundGuest: true, actorUserId: userId } : {}) });
    await tx.update(channelExternalInvites)
      .set({ status: "accepted", outcome: "guest", acceptedUserId: userId, decidedAt: now })
      .where(eq(channelExternalInvites.id, invite.id));
    // The channel may have just become external: the free plan's freeze
    // follows in this commit, after the membership locks (ADMISSION_LOCK_ORDER rule 4).
    if (!guestHere) await reconcileServerExternalFreeze(tx, channel.serverId, now);
    return { serverId: channel.serverId, channelId: channel.id, joined: !guestHere };
  });
}

/** The invite behind this token is open and for this person's verified address, or the neutral refusal. */
export async function assertInviteAddressedTo(tokenHash: string, userId: string, executor: DatabaseExecutor = getDb()): Promise<void> {
  const [invite] = await executor.select({ email: channelExternalInvites.email }).from(channelExternalInvites)
    .where(eq(channelExternalInvites.tokenHash, tokenHash));
  const [user] = await executor.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId));
  if (!invite || !user?.emailVerified || normalizeEmail(user.email) !== invite.email) throw invalidInvite();
}
