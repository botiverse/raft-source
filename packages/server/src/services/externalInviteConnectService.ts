/**
 * Connecting a Server with an external channel invite (#wg-rbac:#16, P2a-3).
 *
 * The invitee connects a Server they own or administer, or asks one of its
 * owners/admins to approve (channel_server_connect_requests). The invite is
 * the authority for exactly this one connection of its channel (cindyz
 * 83bec5cb, Tenny 677dfdc6): its inviter is recorded, never re-checked, and
 * nothing here acts with the inviter's or the host's federation capability
 * beyond this connection. On the connecting Server two people are named and
 * each re-checked when connecting: the joiner (added to the channel there, a
 * current non-guest member) and the authorizer (a current owner/admin, who
 * connected or approved).
 *
 * A channel already joint is connected in one transaction that also marks the
 * invite accepted. A private channel first becomes joint through the existing
 * conversion job: connecting reserves the invite (status connecting, phase
 * conversion) in the transaction that starts the job; the job's finalize
 * moves it to phase connection in its own commit; the worker then connects the
 * Server and accepts the invite in one transaction, retrying until it does or
 * the invite ends (revoked, expired). A conversion rolled back returns the
 * invite to pending.
 *
 * Statuses: pending -> awaiting_approval (request) -> pending (rejected,
 * cancelled) | connecting / accepted (approved); pending -> connecting /
 * accepted (connect); connecting(conversion) -> connecting(connection) ->
 * accepted | pending (refused) | revoked | expired; connecting(conversion) ->
 * pending (conversion rolled back or cancelled).
 *
 * One invite connects several servers (connectSelectedServers: the invite
 * page's multi-select, and a host owner/admin's own servers): each server is
 * decided on its own, the invite open until every one is done. Each server
 * needing approval has its own request (one pending per invite and server);
 * the servers connected directly run one after another: on a joint channel
 * each in its own transaction, on a private one as one reservation whose
 * further servers wait in connect_queued_server_ids and each become
 * connect_server_id in turn (a fresh generation each), re-checked when
 * connecting. Whenever nothing is being connected, the invite rests
 * (restingInviteState): awaiting_approval while a request waits, accepted once
 * a server was connected with it, else pending. Running out, it is accepted
 * when it connected one, else expired; its waiting requests expire.
 *
 * Until Guests can be in joint channels (P3), a channel with a Guest bound to
 * it cannot be connected, and no Guest is let in while a connection is under
 * way: both are read under the channel row the other side also locks.
 *
 * Membership sources (joint membership):
 * the invite is one operation of its invitee's, and every server it connects
 * is a source of the one joint membership it started from or created
 * (source_state, set once by initializeInviteSources when the invitee first
 * uses it). connectJointChannel decides under the joint's membership lock
 * (planInviteSources): the first join admits the joiner only if their
 * membership counter is still what it was at the start; each later server
 * records a source only for that same membership (its generation); an
 * operation whose joiner left, or rejoined another way, is refused rather
 * than re-adding them or recording sources of a membership it never made.
 * Whether an operation by someone already a member records sources depends
 * on the invite's origin (inviteFlow): a host owner/admin's own "Your
 * servers" (host_direct) does, for the membership it started from; an
 * emailed or legacy (NULL) invite does not. An origin this release does not
 * connect is refused everywhere a connection starts, and the worker leaves it.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, MAX_JOINT_CHANNEL_SERVERS, type ServerRole } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  channelConversionJobs,
  channelExternalInvites,
  channelServerConnectRequests,
  channels,
  jointChannelServers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import {
  acceptJointChannelInviteInCallerTransaction,
  attachJointChannelMetadata,
  createExternalConnectJointInvite,
  getChannel,
  JointChannelArchivedError,
  JointInviteAccepterError,
} from "./channelService";
import {
  getChannelConversionJob,
  retryChannelConversionJob,
  revalidateExternalPrivacyBeforeConversion,
  startChannelToJointConversion,
  ChannelConversionBusyError,
  ChannelConversionError,
  type ChannelConversionPrivacyRevalidator,
} from "./channelConversionService";
import { lockChannelConversionResourceBoundedInTransaction } from "./channelConversionFenceService";
import { emitJointProjectionUpdates } from "./channelRealtimeEvents";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { broadcastSystemMessageToLocalSurfaces } from "./messageService";
import { sendExternalConnectResultEmail, sendServerConnectApprovalEmail, type ExternalConnectOutcome } from "./emailService";
import {
  assertInviteAddressedTo,
  channelHasConnectingInvite,
  CLEARED_CONNECT_STATE,
  createDirectConnectInvite,
  createSelfConnectInvite,
  lapsedInviteState,
  billingOwnersOf,
  listConnectableServers,
  restingInviteState,
  serversAtExternalLimit,
  type ServerBillingOwner,
  externalChannelsEnabled,
  boundGuestsBlockJoint,
  hashToken,
  invalidInvite,
  inviteFlow,
  isInvitableChannelOf,
  isTokenUsable,
  knownInviteOriginSql,
  type InviteFlow,
} from "./externalInviteService";
import { isCommunityServerSlug } from "./inviteService";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { acquireFeatureFlagReadLock, evaluateFeatureFlag } from "./featureFlagService";
import {
  checkFreeHostCanConnectFirstServer,
  checkJointAdmission,
  JointChannelLimitError,
  preflightFreeHostJointCapacity,
  refreshJointEntitlementsBeforeAdmission,
} from "./jointChannelLimitService";
import { resolveParentJointId } from "./jointChannelLimitState";
import {
  JointActorUnavailableError,
  JointLockSetChangedError,
  jointHumanMembershipMirrorJointIds,
  lockJointActorFirst,
  lockJointUsersFirst,
  jointUserUnavailable,
  lockJointHumanAdmissionSource,
  lockJointHumanMembershipChannel,
  lockJointHumanMembershipJoints,
  prepareJointHumanMembershipMirror,
} from "./jointHumanMembershipMirror";
import { recordOrdinaryJointAdmissions } from "./jointAdmissionKind";
import { jointMembershipRemovalPendingSql } from "./jointHumanMembershipAccess";
import { countLiveComputersAttachedBy, executeMemberRemoval, finishRemovedMember, lockServerMembershipsAfterChannel, prepareMemberRemoval, type RemovedMemberEffects } from "./serverService";
import { recordServerConnected } from "./jointMemberConnectEffects";
import { resolveSelfConnectCreation } from "./channelConversionAudience";
import { acquireServerAdmissionLocks, acquireServerLock } from "./planService";
import { lockJointLifecycle } from "./jointLifecycleLock";
import { assertCanConnectExternalServer, assertHostCanConnectExternalServer, AttributedJointChannelLimitError, attributeJointLimit, ExternalChannelLimitError, isReservationStatus, OPEN_EXTERNAL_INVITE_STATUSES, RESERVATION_STATUSES } from "./externalChannelLimitService";
import { recordWorkerConnectFinished, refusedOutcome, type ConnectFinishedOutcome } from "./externalConnectProductEvents";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { socketUserServerRoom } from "../socket/platformScope";
import { withChannelWriterFence } from "./channelConversionFenceService";
import { newAuditOperationId, recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";

export type ExternalConnectErrorCode =
  | "invalid_server"
  | "invalid_approver"
  | "server_admin_required"
  | "server_membership_required"
  | "approver_lost_role"
  | "request_not_found"
  | "guests_present"
  | "connect_in_progress"
  | "approval_in_progress"
  | "already_connected"
  | "channel_archived"
  | "request_not_pending"
  | "request_expired"
  | "requester_left"
  | "membership_changed"
  | "guest_has_computer"
  | "connect_unavailable";

export class ExternalConnectError extends Error {
  constructor(readonly code: ExternalConnectErrorCode, message: string) {
    super(message);
    this.name = "ExternalConnectError";
  }
}

/** The invite stopped being what this attempt started from (revoked, connected meanwhile, channel gone). */
class StaleInviteError extends Error {
  constructor() {
    super("The external invite changed while connecting");
    this.name = "StaleInviteError";
  }
}

/**
 * The invite's origin is not one this release connects (inviteFlow): a newer
 * release's, or self_connect, whose own checks are not here. Refused like a
 * stale invite: nothing written.
 */
class UnknownInviteOriginError extends StaleInviteError {
  constructor(readonly origin: string) {
    super();
    this.name = "UnknownInviteOriginError";
    this.message = `The external invite's origin is not one this release connects: ${origin}`;
  }
}

/**
 * A self_connect connection found its own precondition gone under the locks
 * (the channel no longer a projection of the joint): nothing written, refused
 * (connect_unavailable). external_channels_v1 off for the host is
 * ExternalChannelsOffError, answered the same way (selfConnectRefusal).
 */
class SelfConnectUnavailableError extends Error {
  constructor() {
    super("Connecting your own server to this channel is not available");
    this.name = "SelfConnectUnavailableError";
  }
}

/** A guess a self_connect made before its locks (its actor's Guest seat, the joints to lock) was wrong: the transaction restarts. */
class SelfConnectRestart extends Error {
  constructor() {
    super("The self_connect lock set changed while it prepared");
    this.name = "SelfConnectRestart";
  }
}

/** The invite ran out, judged by the time read after every lock. */
class InviteLapsedError extends Error {
  constructor() {
    super("The external invite expired while connecting");
    this.name = "InviteLapsedError";
  }
}

/** external_channels_v1 is off for the host (kill switch or rule), read under its flag lock. */
class ExternalChannelsOffError extends Error {
  constructor() {
    super("External channels are off for the host server");
    this.name = "ExternalChannelsOffError";
  }
}

type Invite = typeof channelExternalInvites.$inferSelect;
type Channel = typeof channels.$inferSelect;
type Request = typeof channelServerConnectRequests.$inferSelect;
type OpenStatus = "pending" | "awaiting_approval" | "connecting" | "self_connecting";
/**
 * What the invite row must still be when a connection writes it: open in one
 * of these statuses, or (the worker completing it) this very reservation.
 */
type OpenExpectation = { open: readonly OpenStatus[] };
type InviteExpectation = OpenExpectation | "reservation";
const FROM_PENDING: OpenExpectation = { open: ["pending"] };
/** A server chosen with others: an approval may already be waiting (or the invite rest open between them). */
const FROM_CHOOSING: OpenExpectation = { open: ["pending", "awaiting_approval"] };
/** An approval: the invite waits on it, or is connecting its other servers meanwhile. */
const FROM_APPROVAL: OpenExpectation = { open: ["awaiting_approval", "connecting"] };

function expects(expectation: InviteExpectation, status: string): boolean {
  return expectation === "reservation" ? isReservationStatus(status as Invite["status"]) : (expectation.open as readonly string[]).includes(status);
}

/** The connecting Server and the two people on it this connection names. */
interface ConnectionParties {
  targetServerId: string;
  joinerUserId: string;
  authorizerUserId: string;
  /** The reservation being completed (connecting only): connect_generation. */
  generation?: string | null;
}

export type ExternalConnectResult =
  | { state: "connected"; connection: ExternalConnection }
  | { state: "connecting"; conversionJobId: string };

/** A committed connection: what the realtime publish and the channel's system message need. */
export interface ExternalConnection {
  targetServerId: string;
  localChannelId: string;
  joinerUserId: string;
  /** Who connected it: the authorizer (the server's owner or admin who connected or approved); in a self_connect, the joiner. */
  actorUserId: string;
}

export interface ExternalConnectDeps {
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator;
}

const CONVERSION_POLL_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;

// ── Reading the invite and the people ──

/**
 * The invite behind this token as its invitee may use it: open, unexpired,
 * its channel live (private or joint) in a live host with the flag on, and
 * sent to the caller's verified address. Anything else is the neutral 404.
 */
async function resolveInviteForInvitee(token: string, userId: string): Promise<{ invite: Invite; channel: Channel }> {
  const tokenHash = hashToken(token);
  const db = getDb();
  const [invite] = await db.select().from(channelExternalInvites).where(eq(channelExternalInvites.tokenHash, tokenHash));
  if (!invite || invite.status === "accepted" || invite.status === "revoked" || invite.status === "expired" || invite.expiresAt <= new Date()) {
    throw invalidInvite();
  }
  // A self_connect operation has no link and no invitee; another release's invite is not used here.
  if (!isTokenUsable(invite.origin)) throw invalidInvite();
  const channel = await getChannel(invite.channelId, { executor: db });
  if (!isInvitableChannelOf(channel, invite.hostServerId)) throw invalidInvite();
  const [host] = await db.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, invite.hostServerId));
  if (!host || host.deletedAt) throw invalidInvite();
  if (!await externalChannelsEnabled(invite.hostServerId, userId)) throw invalidInvite();
  await assertInviteAddressedTo(tokenHash, userId, db);
  return { invite, channel };
}

async function rolesOn(executor: DatabaseExecutor, serverId: string, userIds: readonly string[]): Promise<Map<string, ServerRole>> {
  const rows = await executor.select({ userId: serverMembers.userId, role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.userId, [...new Set(userIds)])));
  return new Map(rows.map((row) => [row.userId, row.role]));
}

const isAdminRole = (role: string | undefined) => role === "owner" || role === "admin";
const isMemberRole = (role: string | undefined) => role !== undefined && role !== "guest";

/** A live ordinary server other than the host, which the caller belongs to (not as a Guest). */
/** A server that may be connected to an external channel: live, ordinary, and not a community server (/community, /community-cn: cindyz). */
function isConnectableKind(server: { kind: string; slug: string; deletedAt: Date | null }): boolean {
  return !server.deletedAt && server.kind === "normal" && !isCommunityServerSlug(server.slug);
}

async function assertConnectableServer(serverId: unknown, hostServerId: string, userId: string): Promise<{ id: string; role: string }> {
  if (typeof serverId !== "string" || !/^[0-9a-f-]{36}$/i.test(serverId) || serverId === hostServerId) {
    throw new ExternalConnectError("invalid_server", "Choose a server you belong to");
  }
  const [server] = await getDb().select({ kind: servers.kind, slug: servers.slug, deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, serverId));
  const role = (await rolesOn(getDb(), serverId, [userId])).get(userId);
  if (!server || !isConnectableKind(server) || !isMemberRole(role)) {
    throw new ExternalConnectError("invalid_server", "Choose a server you belong to");
  }
  return { id: serverId, role: role! };
}

/** The host side of a joint channel: the joint this channel is the host's projection of, while active. */
async function hostJointOf(executor: DatabaseExecutor, channel: Pick<Channel, "id" | "serverId">): Promise<string | null> {
  const [projection] = await executor.select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.localChannelId, channel.id),
      eq(jointChannelServers.serverId, channel.serverId),
      eq(jointChannelServers.status, "active"),
    ));
  return projection?.jointChannelId ?? null;
}

async function isConnectedTo(executor: DatabaseExecutor, jointChannelId: string, serverId: string): Promise<boolean> {
  const [row] = await executor.select({ serverId: jointChannelServers.serverId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, serverId), eq(jointChannelServers.status, "active")));
  return !!row;
}

const guestsPresent = () => new ExternalConnectError("guests_present", "This channel has guests, so a server can't be connected to it yet.");
const connectInProgress = () => new ExternalConnectError("connect_in_progress", "A server is already being connected to this channel. Try again once it's done.");

/**
 * Under the connecting server's row (FOR SHARE) and the two members' rows
 * (FOR KEY SHARE), as the joint accept takes them: the authorizer is an owner
 * or admin of it and the joiner a non-guest member.
 */
async function lockAndCheckParties(tx: DatabaseTransaction, parties: ConnectionParties): Promise<void> {
  await lockJointHumanAdmissionSource(tx, parties.targetServerId, [parties.authorizerUserId, parties.joinerUserId]);
  const [server] = await tx.select({ kind: servers.kind, slug: servers.slug, deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, parties.targetServerId));
  if (!server || !isConnectableKind(server)) throw new ExternalConnectError("invalid_server", "Choose a server you belong to");
  const roles = await rolesOn(tx, parties.targetServerId, [parties.authorizerUserId, parties.joinerUserId]);
  if (!isAdminRole(roles.get(parties.authorizerUserId))) {
    throw new JointInviteAccepterError("authorizer_not_admin", "Only target server admins can accept joint channel invites");
  }
  if (!isMemberRole(roles.get(parties.joinerUserId))) {
    throw new JointInviteAccepterError("joiner_not_member", "The person joining is no longer a member of the target server");
  }
}

/** The invite row, the last row lock: still as `from` expects (for the worker, this reservation). Expiry is revalidateUnderLocks'. */
async function lockInviteFrom(tx: DatabaseTransaction, inviteId: string, from: InviteExpectation, parties: ConnectionParties): Promise<Invite> {
  const [invite] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId)).for("update");
  if (!invite || !expects(from, invite.status)) throw new StaleInviteError();
  if (from === "reservation" && (invite.connectPhase !== "connection"
    || invite.connectGeneration !== parties.generation
    || invite.connectServerId !== parties.targetServerId
    || invite.connectJoinerUserId !== parties.joinerUserId
    || invite.connectAuthorizerUserId !== parties.authorizerUserId)) {
    throw new StaleInviteError();
  }
  return invite;
}

/**
 * The final protected boundary of every write this module makes on an invite:
 * called after all locks, the invite row included. A transaction may have
 * queued on any of them for a long time, so nothing read before counts here
 * (Cody): it pins external_channels_v1 with its shared flag lock, so a kill
 * switch or rule write serializes with it, then reads the host channel and
 * server and takes the time. Returns that time for the writes that follow.
 * external_channels_v1 is also what lets a write convert a private channel
 * (#wg-rbac:#50): there is no separate conversion flag.
 */
async function revalidateUnderLocks(tx: DatabaseTransaction, input: {
  invite: Invite;
  joinerUserId: string;
}): Promise<Date> {
  await acquireFeatureFlagReadLock(tx, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);
  const [channel] = await tx.select().from(channels).where(eq(channels.id, input.invite.channelId));
  if (!isInvitableChannelOf(channel, input.invite.hostServerId)) throw new StaleInviteError();
  const [host] = await tx.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, input.invite.hostServerId));
  if (!host || host.deletedAt) throw new StaleInviteError();
  if (channel.archivedAt) throw new ExternalConnectError("channel_archived", "This channel is archived.");
  const flag = { serverId: input.invite.hostServerId, userId: input.joinerUserId };
  if (!(await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, ...flag }, tx)).enabled) throw new ExternalChannelsOffError();
  // Time last: after every lock and read above.
  const now = new Date();
  const [current] = await tx.select({ expiresAt: channelExternalInvites.expiresAt }).from(channelExternalInvites)
    .where(eq(channelExternalInvites.id, input.invite.id));
  if (!current || current.expiresAt <= now) throw new InviteLapsedError();
  return now;
}

/**
 * Both servers' admission locks, in server-id order: the lock a Guest accept
 * and a joint invite accept take for their count, so a Guest into one
 * channel, an ordinary joint accept and a connection to another channel of
 * the same free server decide one after the other. Taken first
 * (ADMISSION_LOCK_ORDER in planService); the free-plan external-channel rule
 * (assertCanConnectExternalServer) is checked under them later.
 */
async function lockConnectionAdmissions(tx: DatabaseTransaction, input: { hostServerId: string; targetServerId: string }): Promise<void> {
  await acquireServerAdmissionLocks(tx, [input.hostServerId, input.targetServerId]);
}

/**
 * An open invite that ran out ends as lapsedInviteState (accepted when it
 * connected a server, else expired) and its waiting requests expire. Under
 * the invite row lock, which the caller holds.
 */
async function lapseInvite(tx: DatabaseTransaction, invite: Invite, now: Date): Promise<void> {
  await tx.update(channelExternalInvites).set(lapsedInviteState(invite, now)).where(eq(channelExternalInvites.id, invite.id));
  await tx.update(channelServerConnectRequests).set({ status: "expired", decidedAt: now })
    .where(and(eq(channelServerConnectRequests.inviteId, invite.id), eq(channelServerConnectRequests.status, "pending")));
}

/** An open invite that ran out is marked so (lapseInvite), after the refused transaction rolled back. */
async function markLapsed(inviteId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [invite] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId)).for("update");
    const now = new Date();
    if (!invite || invite.expiresAt > now || !OPEN_EXTERNAL_INVITE_STATUSES.includes(invite.status) || inviteFlow(invite.origin) === null) return;
    await lapseInvite(tx, invite, now);
  });
}

/** The approval request this connection came from, after the invite row and before the final checks: still pending. */
async function lockPendingRequestRow(tx: DatabaseTransaction, requestId: string | null): Promise<void> {
  if (!requestId) return;
  const [request] = await tx.select({ status: channelServerConnectRequests.status }).from(channelServerConnectRequests)
    .where(eq(channelServerConnectRequests.id, requestId)).for("update");
  if (request?.status !== "pending") throw new ExternalConnectError("request_not_pending", "This request has already been decided");
}

/**
 * The rows the writes after the final checks reference by foreign key (each
 * FK check takes FOR KEY SHARE on its row): taken before those checks, so a
 * holder of one of them (a server-invite admission holds its server FOR
 * UPDATE) is waited for here and not after them. Rows the transaction
 * already holds (the connecting server, the channel, the job) are not
 * repeated.
 */
async function lockReferencedRows(tx: DatabaseTransaction, input: { serverIds?: readonly string[]; userIds: readonly string[] }): Promise<void> {
  const serverIds = [...new Set(input.serverIds ?? [])].sort();
  if (serverIds.length) {
    await tx.execute(sql`SELECT id FROM servers WHERE id IN (${sql.join(serverIds.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id FOR KEY SHARE`);
  }
  const userIds = [...new Set(input.userIds)].sort();
  await tx.execute(sql`SELECT id FROM users WHERE id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)}) ORDER BY id FOR KEY SHARE`);
}

/** That request, now approved. Locked by lockPendingRequestRow before revalidateUnderLocks, so no lock wait follows the final checks. */
async function approveRequestRow(tx: DatabaseTransaction, requestId: string | null, now: Date): Promise<void> {
  if (!requestId) return;
  await tx.update(channelServerConnectRequests).set({ status: "approved", decidedAt: now }).where(eq(channelServerConnectRequests.id, requestId));
}

/** Who the conversion records as its creator: the inviter (audit), or the host's owner once their account is gone. */
async function conversionAttributionUserId(invite: Invite): Promise<string> {
  // A self_connect operation's actor is a channel member, not the host's
  // owner/admin: the joint (and its storage namespace) is the host's, as
  // when the inviter is gone.
  if (invite.invitedByUserId && invite.origin !== "self_connect") return invite.invitedByUserId;
  const [host] = await getDb().select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, invite.hostServerId));
  if (!host?.ownerId) throw invalidInvite();
  return host.ownerId;
}

// ── Origin ──

// What this release does with an invite, by its origin: inviteFlow
// (externalInviteService). Never an authorization input: it only adds checks.

/** Refuses (nothing written) an invite whose origin this release does not connect. */
function assertConnectableOrigin(invite: Pick<Invite, "origin">): void {
  if (inviteFlow(invite.origin) === null) throw new UnknownInviteOriginError(String(invite.origin));
}

/**
 * The flow of an invite a connection is about to write, refusing (nothing
 * written) one whose origin this release does not connect, and one the
 * caller's path is not for: a self_connect operation only through
 * connectSelfJointChannel and a self_connect reservation, every other origin
 * never through them.
 */
function assertFlowFor(invite: Pick<Invite, "origin">, path: "self" | "invite"): InviteFlow {
  const flow = inviteFlow(invite.origin);
  if (flow === null) throw new UnknownInviteOriginError(String(invite.origin));
  if ((flow === "self_connect") !== (path === "self")) throw new StaleInviteError();
  return flow;
}

/**
 * Whether an operation by someone already in the joint records each server
 * it connects as a source of that membership (cindyz c6f0faee, fb29b618):
 * a host owner/admin's own "Your servers" connect, and a channel member's
 * self_connect (jointMemberConnectService). A legacy (NULL) or emailed invite
 * records none (no_sources).
 */
function existingMemberIsSource(flow: InviteFlow): boolean {
  switch (flow) {
    case "host_direct":
    case "self_connect": return true;
    case "legacy":
    case "external_invite": return false;
  }
}

/** The status a reservation of this flow holds while connecting: a self_connect operation's is its own (design v3 §10). */
function reservationStatusOf(flow: InviteFlow): "connecting" | "self_connecting" {
  return flow === "self_connect" ? "self_connecting" : "connecting";
}

// ── Connecting ──

/** How the invite ends when this connection commits: a server the invitee had, or one created to connect. */
type ConnectOutcome = "server" | "new_server";

interface ConnectInput {
  invite: Invite;
  channel: Channel;
  parties: ConnectionParties;
  from: OpenExpectation;
  requestId: string | null;
  deps: ExternalConnectDeps;
  outcome: ConnectOutcome;
  /**
   * A private channel: more servers of the joiner's, connected after this one
   * once the conversion committed (they own or administer each, re-checked
   * then). Only a direct connect has them.
   */
  queue?: readonly string[];
  /** A joint channel, more servers chosen with this one still to come: the invite stays open (connectSelectedServers settles it). */
  holdOpen?: boolean;
  /** An approval: the approver (the authorizer) retired or being deleted is refused (AuthorizerUnavailableError). */
  refuseUnavailableAuthorizer?: boolean;
  /**
   * The caller is the host's own owner or admin connecting servers of theirs
   * from the host (connectOwnServersToChannel, nothing else): the host's
   * limit is told in full. Anyone else (an invitee, an approver, a member
   * connecting their own server) is another organisation and gets the neutral
   * sentence (#wg-rbac:#61). Never read from the invite's origin: a
   * host_direct invite's link is usable like any other.
   */
  actingAsHostAdmin?: boolean;
}

/**
 * The approver of a connect request has an account retired or being deleted
 * (checked under their users row, lockJointUsersFirst): their approval is
 * refused, the request left pending (Tenny; account deletion's own cleanup
 * ends it).
 */
class AuthorizerUnavailableError extends Error {
  constructor() {
    super("The approver's account is being deleted");
    this.name = "AuthorizerUnavailableError";
  }
}

/** Under the users rows (lockJointUsersFirst): an approval's approver retired or being deleted refuses it. */
async function assertAuthorizerAvailable(tx: DatabaseTransaction, input: { parties: ConnectionParties; refuseUnavailableAuthorizer?: boolean }): Promise<void> {
  if (input.refuseUnavailableAuthorizer && await jointUserUnavailable(tx, input.parties.authorizerUserId)) throw new AuthorizerUnavailableError();
}

async function connectOrReserve(input: ConnectInput): Promise<ExternalConnectResult> {
  if (input.channel.type === "private") {
    const reserved = await reserveConnection(input);
    if (reserved) return reserved;
  }
  const connection = await connectJointChannel(input);
  return { state: "connected", connection };
}

/**
 * The channel is not joint yet: in the transaction that starts its
 * conversion, reserve the invite for this connection. Lock order is the
 * conversion start's (the per-source conversion lock, the channel row, the
 * fence), then the connecting server and its two members, then the invite row
 * and its request. The reservation, the no-Guest check and the job are one
 * commit; any refusal rolls the job back with it. Null when the channel turned
 * joint meanwhile (connect it directly instead).
 */
async function reserveConnection(input: ConnectInput): Promise<ExternalConnectResult | null> {
  const { invite, channel, parties } = input;
  // Before anything starts: the origin is set at creation and never changes.
  assertConnectableOrigin(invite);
  const flow = inviteFlow(invite.origin)!;
  // Lock-free early answers; the accept that connects is the authoritative
  // limit check. external_channels_v1, which alone allows the conversion, is
  // revalidateUnderLocks' in the reservation below.
  await preflightFreeHostJointCapacity(channel.serverId, new Date(), {
    audience: input.actingAsHostAdmin ? "host" : "outsider",
    resumingConversionOfChannelId: channel.id,
  });
  await refreshSubscriptionForServerIfStale(parties.targetServerId);
  await revalidateExternalPrivacyBeforeConversion(input.deps.revalidateExternalPrivacy, channel.serverId, channel.id);
  const createdByUserId = await conversionAttributionUserId(invite);
  if (flow === "self_connect") await selfConnectHookForTests?.("before_reservation", { inviteId: invite.id, targetServerId: parties.targetServerId });
  try {
    const conversionJobId = await getDb().transaction(async (tx) => {
      // Every users row this reservation names, first (lockJointUsersFirst):
      // the joiner (the actor, refused when retired or being deleted), the
      // authorizer, and the conversion job's creator.
      await lockJointUsersFirst(tx, { actorUserId: parties.joinerUserId, userIds: [parties.authorizerUserId, createdByUserId] });
      await assertAuthorizerAvailable(tx, input);
      // ADMISSION_LOCK_ORDER: the conversion lock, then both admission locks, then everything else.
      // Bounded: a phase of a conversion under way holds it for its whole
      // transaction; past the wait this is the 409 "in progress" (nothing reserved).
      await lockChannelConversionResourceBoundedInTransaction(tx, channel.serverId, channel.id, (cause) => new ChannelConversionBusyError({ cause }));
      await lockConnectionAdmissions(tx, { hostServerId: channel.serverId, targetServerId: parties.targetServerId });
      // Under the conversion lock: a conversion already under way (another
      // invite's, or an admin's) is not this connection's to ride on. A
      // rolled-back one is restarted below, as a new start would.
      const active = await tx.select({ status: channelConversionJobs.status, progress: channelConversionJobs.progress }).from(channelConversionJobs)
        .where(and(eq(channelConversionJobs.sourceChannelId, channel.id), inArray(channelConversionJobs.status, ["pending", "running", "failed"])));
      if (active.some((job) => !(job.status === "failed" && (job.progress as { rollbackState?: unknown }).rollbackState === "restored"))) {
        throw connectInProgress();
      }
      let job = await startChannelToJointConversion({ serverId: channel.serverId, sourceChannelId: channel.id, createdByUserId, transaction: tx });
      if (job.status === "failed") job = await retryChannelConversionJob(job.id, tx);
      const generation = randomUUID();
      await tx.update(channelConversionJobs).set({ externalConnectGeneration: generation }).where(eq(channelConversionJobs.id, job.id));
      // The channel row is locked (FOR UPDATE, by the start, which also refused bound Guests) and fenced now.
      if (await channelHasConnectingInvite(tx, channel.id, invite.id)) throw connectInProgress();
      // Under the admission locks taken above.
      await assertCanConnectExternalServer(tx, { hostServerId: channel.serverId, hostChannelId: channel.id, targetServerId: parties.targetServerId, now: new Date() });
      await lockAndCheckParties(tx, parties);
      // A self_connect operation binds the actor's membership of the channel
      // now (design v3 §4): their channel_humans row, under the channel row
      // (FOR UPDATE, by the start) and the conversion fence the start just
      // published, which keeps anybody from being added to the channel until
      // the finalize makes the membership a joint one. Gone already: refused.
      const self = flow === "self_connect" ? await selfMembershipAtReservation(tx, channel, parties.joinerUserId) : null;
      // A reservation only starts on an invite nothing is being connected with.
      const locked = await lockInviteFrom(tx, invite.id, { open: input.from.open.filter((status) => !isReservationStatus(status)) }, parties);
      if (inviteFlow(locked.origin) !== flow) throw new StaleInviteError();
      await lockPendingRequestRow(tx, input.requestId);
      await lockReferencedRows(tx, { userIds: [parties.joinerUserId, parties.authorizerUserId] });
      const now = await revalidateUnderLocks(tx, { invite, joinerUserId: parties.joinerUserId });
      await approveRequestRow(tx, input.requestId, now);
      await tx.update(channelExternalInvites).set({
        ...CLEARED_CONNECT_STATE,
        status: reservationStatusOf(flow),
        ...(self ? self : {}),
        connectPhase: "conversion",
        connectServerId: parties.targetServerId,
        connectJoinerUserId: parties.joinerUserId,
        connectAuthorizerUserId: parties.authorizerUserId,
        connectConversionJobId: job.id,
        connectGeneration: generation,
        // How the invite ends when the worker connects it (completeConnection).
        connectOutcome: input.outcome,
        // The rest of the joiner's servers, each in turn once this one is connected.
        connectQueuedServerIds: [...(input.queue ?? [])],
      }).where(eq(channelExternalInvites.id, invite.id));
      return job.id;
    });
    return { state: "connecting", conversionJobId };
  } catch (err) {
    if (err instanceof ChannelConversionError && err.code === "guests_present") throw guestsPresent();
    if (err instanceof ChannelConversionError && (err.code === "unsupported_channel_type" || err.code === "channel_conversion_source_changed")) {
      const [current] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, channel.id));
      if (current?.type === "joint") return null;
    }
    throw err;
  }
}

/**
 * A self_connect reservation's binding of its actor's membership of the
 * private channel (design v3 §4): their channel_humans joined_at, which the
 * conversion's finalize carries onto their joint membership
 * (resolveSelfConnectCreation), and the operation's source state until then.
 * Not in the channel (left meanwhile): refused, nothing reserved.
 */
async function selfMembershipAtReservation(tx: DatabaseTransaction, channel: Channel, userId: string) {
  const channelId = channel.id;
  const [row] = (await tx.execute<{ joinedAt: string }>(sql`SELECT to_json(joined_at) #>> '{}' AS "joinedAt" FROM channel_humans
    WHERE channel_id = ${channelId}::uuid AND user_id = ${userId}::uuid`)).rows;
  if (!row) throw membershipChanged();
  // Still the host's member, or its Guest bound to this channel (assertChannelMemberActor's private rule).
  const [seat] = await tx.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  if (!seat || (seat.role === "guest" && seat.guestChannelId !== channelId)) throw membershipChanged();
  return {
    // Exactly as stored (microseconds): compared in SQL with the joint membership's.
    selfMemberJoinedAt: sql<Date>`${row.joinedAt}::timestamptz`,
    sourceState: "awaiting_joint_creation" as const,
    sourceStartGeneration: null,
    sourceGeneration: null,
  };
}

/**
 * Connects the server to the already-joint channel and marks the invite
 * accepted, in one transaction, in ADMISSION_LOCK_ORDER (planService): both
 * servers' admission locks, then the connecting server's ns-3 lock (taken
 * here so the joint invite is created under it), then the accept's own (its
 * prior local channel, the server and member rows, the membership mirror,
 * JOINT_HOST, the joint row), then the invite row and its request, re-read
 * under them.
 */
async function connectJointChannel(input: {
  invite: Invite;
  channel: Channel;
  parties: ConnectionParties;
  from: InviteExpectation;
  requestId: string | null;
  outcome: ConnectOutcome;
  holdOpen?: boolean;
  refuseUnavailableAuthorizer?: boolean;
}): Promise<ExternalConnection> {
  const { invite, channel, parties } = input;
  const jointChannelId = await hostJointOf(getDb(), channel);
  if (!jointChannelId) throw new StaleInviteError();
  // Outside the transaction: the refresh may call the billing provider.
  await refreshJointEntitlementsBeforeAdmission(jointChannelId, [parties.targetServerId], new Date());
  const limit = { hostServerId: channel.serverId, hostChannelId: channel.id, targetServerId: parties.targetServerId };
  return getDb().transaction(async (tx) => {
    // Every users row the writes below name, first (lockJointUsersFirst): the
    // joiner (the actor: refused when retired or being deleted), the
    // authorizer (the joint invite's and accept's) and the inviter (the joint
    // invite's), before any admission, server, channel or J lock.
    await lockJointUsersFirst(tx, { actorUserId: parties.joinerUserId, userIds: [parties.authorizerUserId, invite.invitedByUserId] });
    await assertAuthorizerAvailable(tx, input);
    // ADMISSION_LOCK_ORDER: both admission locks first, then the joint
    // accept's order (T's ns-3, then T's prior local channel row). The accept
    // re-takes T's admission, ns-3 and prior channel row re-entrantly.
    await lockConnectionAdmissions(tx, limit);
    await acquireServerLock(tx, parties.targetServerId, 3);
    // Before any channel row: an archive of the joint serializes with this
    // connection, and the final checks see its committed result.
    await lockJointLifecycle(tx, jointChannelId);
    const [prior] = await tx.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, parties.targetServerId)));
    if (prior) await lockJointHumanMembershipChannel(tx, prior.localChannelId);
    // The connecting server (FOR SHARE) and the two members, in the order the
    // joint invite below takes them: still a live ordinary server, the
    // authorizer its owner or admin, the joiner a member. A queued server is
    // checked here when its turn comes (deleted while it waited: refused).
    await lockAndCheckParties(tx, parties);
    // The host's server row (FOR KEY SHARE), with the connecting server's
    // (FOR SHARE, lockAndCheckParties) and before J: the joint invite below
    // (from_server_id) and a reopened source's audit event (server_id)
    // reference it by foreign key, whose KEY SHARE taken after J would close
    // a J <-> server cycle with deleteServer (server row FOR UPDATE, then J;
    // channelService.disconnectParticipantServerByHost, #13716/#13647).
    // KEY SHARE conflicts only with a server's own FOR UPDATE writers, which
    // take that row before any joint lock.
    await tx.execute(sql`SELECT id FROM servers WHERE id = ${channel.serverId}::uuid FOR KEY SHARE`);
    // Unlocked, after the ns-3 lock: a run that already connected it committed first.
    const [current] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id));
    if (!current || !expects(input.from, current.status)) throw new StaleInviteError();
    // Before any write (the origin never changes once set): never a self_connect operation (connectSelfJointChannel).
    const flow = assertFlowFor(current, "invite");
    if (await boundGuestsBlockJoint(tx, channel)) throw guestsPresent();
    if (await isConnectedTo(tx, jointChannelId, parties.targetServerId)) {
      throw new ExternalConnectError("already_connected", "This server is already connected to the channel. Ask one of its admins to add you.");
    }
    // Before the accept writes, so this channel's own state is read as it was.
    await assertCanConnectExternalServer(tx, { ...limit, now: new Date() });
    // The joint's membership lock (J), after the connecting server and its
    // two members (lockAndCheckParties) as the joint invite and the accept
    // below take them (re-entrant there), and before any member or source
    // write: the joiner's membership is read and written under it. Nothing
    // of another server is locked after it.
    const membership = await prepareJointHumanMembershipMirror(tx, { jointIds: [jointChannelId] }, "join");
    // Before the accept: a refusal writes nothing (no member, no source).
    const sources = membership.coversChannel(channel.id)
      ? await planInviteSources(tx, { invite: current, jointChannelId, joinerUserId: parties.joinerUserId })
      : null;
    const jointInvite = await createExternalConnectJointInvite(tx, {
      jointChannelId,
      fromServerId: channel.serverId,
      targetServerId: parties.targetServerId,
      authorizerUserId: parties.authorizerUserId,
      joinerUserId: parties.joinerUserId,
      inviterUserId: invite.invitedByUserId,
    });
    const local = await acceptJointChannelInviteInCallerTransaction({
      inviteId: jointInvite.id,
      targetServerId: parties.targetServerId,
      acceptedByUserId: parties.authorizerUserId,
      joinerUserId: parties.joinerUserId,
    }).catch((err: unknown) => {
      // The accept's own check under the lifecycle lock: the same answer as the final host check.
      if (err instanceof JointChannelArchivedError) throw new ExternalConnectError("channel_archived", "This channel is archived.");
      throw err;
    });
    const sourceState = sources
      ? await recordInviteSource(tx, sources, {
        jointChannelId,
        parties,
        // The person's own explicit connection of their server (assertConnectableOrigin above: a known flow).
        reopenOwnEnded: existingMemberIsSource(inviteFlow(current.origin)!) ? { hostServerId: channel.serverId, hostChannelId: channel.id } : null,
      })
      : {};
    const locked = await lockInviteFrom(tx, invite.id, input.from, parties);
    // Only an operation's start (initializeInviteSources, under this row)
    // changes it outside the J lock: decided on what it was, or not at all.
    if (sources && !sameSourceState(locked, current)) throw new StaleInviteError();
    await lockPendingRequestRow(tx, input.requestId);
    await lockReferencedRows(tx, { userIds: [parties.joinerUserId] });
    const now = await revalidateUnderLocks(tx, { invite, joinerUserId: parties.joinerUserId });
    await approveRequestRow(tx, input.requestId, now);
    // One event on the host (its server row is KEY SHARE-locked above, before J),
    // as a member's own connection writes (connectSelfJointChannel). An
    // authorizer other than the joiner is the approver of the joiner's request.
    await recordServerConnected(tx, {
      mode: flow === "host_direct" ? "host_direct" : parties.authorizerUserId === parties.joinerUserId ? "invite" : "approval",
      jointChannelId,
      hostServerId: channel.serverId,
      hostChannelId: channel.id,
      connectedServerId: parties.targetServerId,
      actorUserId: parties.authorizerUserId,
    });
    await tx.update(channelExternalInvites)
      .set({ ...await inviteAfterConnection(tx, locked, { ...input, now }), ...sourceState })
      .where(eq(channelExternalInvites.id, invite.id));
    return { targetServerId: parties.targetServerId, localChannelId: local.id, joinerUserId: parties.joinerUserId, actorUserId: parties.authorizerUserId };
  });
}

// ── A channel member's own server (self_connect, jointMemberConnectService) ──

/** What a self_connect transaction guesses before its locks, and checks under them (a wrong guess restarts it). */
interface SelfConnectGuess {
  /** The actor is a Guest of the host bound to the host's copy: their seat ends with this connection. */
  guest: boolean;
  /** Every joint whose membership lock (J) the transaction takes, sorted: the connection's J and, for a Guest, every J the seat's removal revalidates. */
  jointIds: string[];
}

async function selfConnectGuess(executor: DatabaseExecutor, channel: Channel, jointChannelId: string, userId: string): Promise<SelfConnectGuess> {
  const [seat] = await executor.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, userId)));
  const guest = seat?.role === "guest" && seat.guestChannelId === channel.id;
  const removalJoints = guest ? await jointHumanMembershipMirrorJointIds(executor, { serverId: channel.serverId, userId }) : [];
  return { guest, jointIds: [...new Set([...removalJoints, jointChannelId])].sort() };
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Connects server S of a channel member X (the joiner and authorizer both: X
 * owns or administers S) to the joint channel whose host copy is `channel`,
 * as a source of the membership the operation started from, and, when X is
 * the host's Guest bound to that copy, ends that Guest seat in the same
 * commit after the source is written (design v3 §1, §3; cindyz 60f86101).
 * The direct path (connectDirectServers) and the worker after a private
 * channel's conversion (completeConnection, `from: "reservation"`) both come
 * here. Post-commit: the seat removal's effects (finishRemovedMember), before
 * the connection is returned for its publish (publishExternalConnection: the
 * realtime events and the channel's system message).
 *
 * Lock order (Cody's five steps, design v3 §3), every one before the first J:
 * 1. Both servers' admission locks (server-id order), S's ns-3, J's lifecycle.
 * 2. Channel rows: the host's copy (FOR NO KEY UPDATE, as the Guest accept
 *    and the archive take it) when X's seat ends, then S's earlier copy of
 *    the joint (FOR UPDATE), if any.
 * 3. Server rows (H and S FOR SHARE, server-id order), then member rows: X's
 *    on H (FOR UPDATE: the seat the removal deletes, and the row a Computer's
 *    attach shares), then X's on S (FOR KEY SHARE, the joint accept's source
 *    fence, with the role checks).
 * 4. The source-exit flag's share lock and every J at once, sorted: the
 *    removal's (all joints X is in through H) and the connection's. A set
 *    that grew since the guess, or a seat that changed, restarts the
 *    transaction (SelfConnectRestart, JointLockSetChangedError): nothing is
 *    locked out of order.
 * 5. Under all of them, one transaction: the final checks, the connection and
 *    its source, the seat's removal, the audit event, the operation's row.
 *    Any failure rolls back everything (the seat is kept).
 */
async function connectSelfJointChannel(input: {
  invite: Invite;
  channel: Channel;
  parties: ConnectionParties;
  from: InviteExpectation;
  holdOpen?: boolean;
}): Promise<ExternalConnection> {
  const { channel, parties } = input;
  const jointChannelId = await hostJointOf(getDb(), channel);
  if (!jointChannelId) throw new StaleInviteError();
  // Outside the transaction: the refresh may call the billing provider.
  await refreshJointEntitlementsBeforeAdmission(jointChannelId, [parties.targetServerId], new Date());
  for (let attempt = 0; ; attempt += 1) {
    const guess = await selfConnectGuess(getDb(), channel, jointChannelId, parties.joinerUserId);
    await selfConnectHookForTests?.("guessed", { inviteId: input.invite.id, targetServerId: parties.targetServerId, attempt, jointIds: guess.jointIds });
    let committed: { connection: ExternalConnection; removal: RemovedMemberEffects | null };
    try {
      committed = await getDb().transaction((tx) => selfConnectInTransaction(tx, { ...input, jointChannelId, guess }));
    } catch (err) {
      if ((err instanceof SelfConnectRestart || err instanceof JointLockSetChangedError) && attempt < 3) continue;
      if (err instanceof SelfConnectRestart || err instanceof JointLockSetChangedError) throw membershipChanged();
      throw err;
    }
    // After commit: the ended seat's sockets, credentials and app delivery (as any removal).
    if (committed.removal) await finishRemovedMember(channel.serverId, parties.joinerUserId, committed.removal);
    return committed.connection;
  }
}

async function selfConnectInTransaction(tx: DatabaseTransaction, input: {
  invite: Invite;
  channel: Channel;
  parties: ConnectionParties;
  from: InviteExpectation;
  holdOpen?: boolean;
  jointChannelId: string;
  guess: SelfConnectGuess;
}) {
  const { invite, channel, parties, jointChannelId, guess } = input;
  const hostServerId = channel.serverId;
  const actorUserId = parties.joinerUserId;
  const limit = { hostServerId, hostChannelId: channel.id, targetServerId: parties.targetServerId };
  // 0. The actor's users row before anything else (joiner, authorizer,
  // inviter, the seat's departure and every audit row name only them).
  await lockJointActorFirst(tx, actorUserId);
  // 1.
  await lockConnectionAdmissions(tx, limit);
  await acquireServerLock(tx, parties.targetServerId, 3);
  await lockJointLifecycle(tx, jointChannelId);
  // 2.
  if (guess.guest) await lockJointHumanMembershipChannel(tx, channel.id, "no key update");
  const [prior] = await tx.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, parties.targetServerId)));
  if (prior) await lockJointHumanMembershipChannel(tx, prior.localChannelId);
  // 3. Both servers (FOR SHARE also covers the KEY SHARE the joint invite's,
  // the audit's and the notice's references take), then the member rows.
  await tx.execute(sql`SELECT id FROM servers WHERE id IN (${hostServerId}::uuid, ${parties.targetServerId}::uuid) ORDER BY id FOR SHARE`);
  if (guess.guest) await lockServerMembershipsAfterChannel(tx, hostServerId, [actorUserId]);
  await lockAndCheckParties(tx, parties);
  // The seat as it is under its lock.
  const [seat] = await tx.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, hostServerId), eq(serverMembers.userId, actorUserId)));
  const releasing = seat?.role === "guest" && seat.guestChannelId === channel.id;
  if (releasing !== guess.guest) throw new SelfConnectRestart();
  // A Computer attached on the host would be revoked with the seat: refused,
  // read under the member row a Computer's attach shares, so none can be
  // attached between this check and the commit.
  await selfConnectHookForTests?.("locked_members", { inviteId: invite.id, targetServerId: parties.targetServerId });
  if (releasing && await countLiveComputersAttachedBy(tx, hostServerId, actorUserId) > 0) {
    throw new ExternalConnectError("guest_has_computer", "You have a computer attached to this channel's host server. Disconnect it there first, then connect your server.");
  }
  // Unlocked, after the ns-3 lock: a run that already connected it committed first.
  const [current] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id));
  if (!current || !expects(input.from, current.status)) throw new StaleInviteError();
  assertFlowFor(current, "self");
  if (await isConnectedTo(tx, jointChannelId, parties.targetServerId)) {
    throw new ExternalConnectError("already_connected", "This server is already connected to the channel.");
  }
  await assertCanConnectExternalServer(tx, { ...limit, now: new Date() });
  // 4.
  const removalJoints = releasing ? await jointHumanMembershipMirrorJointIds(tx, { serverId: hostServerId, userId: actorUserId }) : [];
  const jointIds = [...new Set([...removalJoints, jointChannelId])].sort();
  if (!sameIds(jointIds, guess.jointIds)) throw new SelfConnectRestart();
  await lockJointHumanMembershipJoints(tx, jointIds);
  const removal = releasing ? await prepareMemberRemoval(tx, hostServerId, actorUserId, {
    onlyIfGuestBoundTo: channel.id,
    // Their own act: they leave the host as a Guest, and stay in the channel through S.
    reason: "left",
    actorUserId,
    channelAudit: { reason: "guest_converted", actor: { type: "human", id: actorUserId } },
    lockedJointIds: jointIds,
  }) : null;
  if (releasing && !removal) throw new SelfConnectRestart();
  const membership = await prepareJointHumanMembershipMirror(tx, { jointIds: [jointChannelId] }, "join");
  await selfConnectHookForTests?.("locked_joints", { inviteId: invite.id, targetServerId: parties.targetServerId });
  // 5. Final checks, under every lock. The feature's gate, the host's
  // external_channels_v1, is revalidateUnderLocks' below (its share lock last).
  if (!membership.coversChannel(channel.id)) throw new SelfConnectUnavailableError();
  // The membership the operation started from, still theirs (never a first join).
  const sources = await planInviteSources(tx, { invite: current, jointChannelId, joinerUserId: actorUserId });
  if (sources?.kind !== "record") throw membershipChanged();
  const [pending] = (await tx.execute<{ pending: boolean }>(sql`SELECT ${jointMembershipRemovalPendingSql(sql`${jointChannelId}::uuid`, "user", sql`${actorUserId}::uuid`)} AS pending`)).rows;
  if (pending?.pending) throw membershipChanged();
  const jointInvite = await createExternalConnectJointInvite(tx, {
    jointChannelId,
    fromServerId: hostServerId,
    targetServerId: parties.targetServerId,
    authorizerUserId: actorUserId,
    joinerUserId: actorUserId,
    inviterUserId: actorUserId,
  });
  // The seat ending in this commit is the connecting server's slot: the cap counts the two once.
  const local = await acceptJointChannelInviteInCallerTransaction({
    inviteId: jointInvite.id,
    targetServerId: parties.targetServerId,
    acceptedByUserId: actorUserId,
    joinerUserId: actorUserId,
  }, releasing ? { releasingGuest: { serverId: hostServerId, userId: actorUserId } } : {}).catch((err: unknown) => {
    if (err instanceof JointChannelArchivedError) throw new ExternalConnectError("channel_archived", "This channel is archived.");
    throw err;
  });
  // The new source first (the seat's removal below, with source exit on, keeps them only through a live one).
  await recordInviteSource(tx, sources, { jointChannelId, parties, reopenOwnEnded: { hostServerId, hostChannelId: channel.id } });
  const removed = removal ? await executeMemberRemoval(tx, removal) : null;
  await selfConnectHookForTests?.("released", { inviteId: invite.id, targetServerId: parties.targetServerId });
  // Still in the joint, the same membership, now through S.
  if (await memberGeneration(tx, jointChannelId, actorUserId, false) !== sources.generation) {
    throw new Error("self_connect: the actor's joint membership did not survive the Guest seat's end");
  }
  const locked = await lockInviteFrom(tx, invite.id, input.from, parties);
  if (!sameSourceState(locked, current)) throw new StaleInviteError();
  await lockReferencedRows(tx, { userIds: [actorUserId] });
  const now = await revalidateUnderLocks(tx, { invite, joinerUserId: actorUserId });
  await recordServerConnected(tx, {
    mode: "self_connect",
    jointChannelId,
    hostServerId,
    hostChannelId: channel.id,
    connectedServerId: parties.targetServerId,
    actorUserId,
    guestReleased: removed !== null,
  });
  await selfConnectHookForTests?.("audited", { inviteId: invite.id, targetServerId: parties.targetServerId });
  await tx.update(channelExternalInvites)
    .set({
      ...await inviteAfterConnection(tx, locked, { parties, from: input.from, outcome: "server", holdOpen: input.holdOpen, now }),
      ...(removed ? { selfGuestReleasedAt: now } : {}),
    })
    .where(eq(channelExternalInvites.id, invite.id));
  return {
    connection: { targetServerId: parties.targetServerId, localChannelId: local.id, joinerUserId: actorUserId, actorUserId },
    removal: removed,
  };
}

export type SelfConnectHookStage = "guessed" | "before_reservation" | "locked_members" | "locked_joints" | "released" | "audited";
let selfConnectHookForTests: ((stage: SelfConnectHookStage, at: { inviteId: string; targetServerId: string; attempt?: number; jointIds?: readonly string[] }) => Promise<void> | void) | null = null;
/**
 * Tests only: awaited inside a self_connect's transaction at each stage
 * (its member rows locked, every J locked, the Guest seat ended, the audit
 * written): a deterministic window for lock interleavings, and a failpoint
 * (throwing rolls the whole connection back).
 */
export function __setSelfConnectHookForTests(hook: typeof selfConnectHookForTests): void {
  selfConnectHookForTests = hook;
}

/**
 * A self_connect reservation whose conversion is done while it still waits in
 * phase conversion: an older release's finalize moved `connecting`
 * reservations only (design v3 §10 1b). Here, under the invite row, exactly
 * what the finalize would have done: phase connection and the actor's
 * membership resolved from what that conversion wrote
 * (resolveSelfConnectCreation). Unresolved, the reservation is refused
 * (settled; the actor's Guest seat kept): never presumed from the conversion
 * having finished, never a first join.
 */
async function recoverSelfConnectFinalize(invite: Invite): Promise<void> {
  const resolved = await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id)).for("update");
    if (!locked || locked.status !== "self_connecting" || locked.connectPhase !== "conversion" || locked.connectGeneration !== invite.connectGeneration) return null;
    const [job] = locked.connectConversionJobId
      ? await tx.select({ status: channelConversionJobs.status, generation: channelConversionJobs.externalConnectGeneration }).from(channelConversionJobs)
        .where(eq(channelConversionJobs.id, locked.connectConversionJobId))
      : [];
    if (job?.status !== "done" || job.generation !== locked.connectGeneration) return null;
    await tx.update(channelExternalInvites).set({ connectPhase: "connection", connectNextAttemptAt: null }).where(eq(channelExternalInvites.id, locked.id));
    return resolveSelfConnectCreation(tx, locked.id);
  });
  if (resolved === false) {
    const [moved] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id));
    // The worker refuses it as planInviteSources would: the actor's membership is not the one the reservation bound.
    if (moved && await settleConnecting(moved, "refused")) recordSettlement(moved, [moved.connectServerId], refusedOutcome("membership_changed"));
  }
}

/**
 * The invite once this connection commits (its row locked, its request
 * approved already): the first server connected with it is the one it is
 * accepted with. The worker's reservation moves on to its next queued server
 * (a fresh generation), or rests; another reservation of this invite under
 * way is left to run; otherwise it rests (restingInviteState), or with
 * `holdOpen` stays open for the servers chosen with this one.
 */
async function inviteAfterConnection(
  tx: DatabaseTransaction,
  locked: Invite,
  input: { parties: ConnectionParties; from: InviteExpectation; outcome: ConnectOutcome; holdOpen?: boolean; now: Date },
) {
  const accepted = {
    acceptedUserId: locked.acceptedUserId ?? input.parties.joinerUserId,
    acceptedServerId: locked.acceptedServerId ?? input.parties.targetServerId,
    // Under the invite row lock: what the invitee's page lists as connected by this invite.
    connectedServerIds: [...new Set([...locked.connectedServerIds, input.parties.targetServerId])],
  };
  if (input.from === "reservation") {
    const [next, ...rest] = locked.connectQueuedServerIds;
    if (next) return { ...accepted, ...nextQueuedServer(next, rest) };
  } else if (isReservationStatus(locked.status)) {
    return accepted;
  }
  const resting = await restingInviteState(tx, { id: locked.id, ...accepted }, input.now, input.outcome);
  if (input.holdOpen && resting.status === "accepted") return { ...accepted, ...CLEARED_CONNECT_STATE, status: "pending" as const };
  return { ...accepted, ...resting };
}

/** A reservation moving on to its next queued server: phase connection (the channel is joint), a fresh generation, attempts from zero. */
function nextQueuedServer(next: string, rest: readonly string[]) {
  return {
    connectPhase: "connection" as const,
    connectServerId: next,
    connectQueuedServerIds: [...rest],
    connectConversionJobId: null,
    connectGeneration: randomUUID(),
    connectAttempts: 0,
    connectNextAttemptAt: null,
    connectLastError: null,
  };
}

// ── Membership sources ──

type SourceColumns = Pick<Invite, "sourceState" | "sourceStartGeneration" | "sourceGeneration">;

const membershipChanged = () => new ExternalConnectError("membership_changed", "You joined or left this channel another way since you chose these servers.");

/**
 * When the invitee starts an operation on the invite (connect, connect a new
 * server, choose several, ask an approver; the actor's own servers on their
 * direct-connect invite, `direct`): what its connections will record as the
 * joiner's membership sources (source_state), once:
 * a state already set is the operation's for the invite's lifetime. Under
 * the invite row lock alone (the J lock comes after a server's locks, and
 * this names no server): the reads are the committed state, which the
 * connection re-checks under J and refuses when it moved.
 *
 * - The operation that creates the joint (`createsJoint`: the actor's own
 *   direct-connect invite on a channel not joint yet, so this operation's
 *   conversion makes the joint): awaiting_joint_creation. The conversion's
 *   finalize resolves it from the membership it actually wrote
 *   (resolveJointCreationSources): member_at_start at that generation, or
 *   awaiting_first_join for an actor it did not make a member. Left
 *   unresolved (another conversion made the joint first), it is an ordinary
 *   first join from before the joint existed (planInviteSources).
 * - Any other operation on a channel not joint yet: awaiting_first_join(0),
 *   exactly the counter of a joint that does not exist yet.
 * - On a joint channel, a member, by an operation whose origin records
 *   sources for an existing member (existingMemberIsSource: a host
 *   owner/admin's own "Your servers", host_direct; cindyz c6f0faee):
 *   member_at_start at their membership's generation now, so each server it
 *   connects is a source of exactly that membership; one who left or
 *   rejoined (a new generation) by then is refused (planInviteSources).
 * - On a joint channel, a member, any other origin (an emailed invite, or a
 *   legacy NULL one): no_sources, as before.
 * - On a joint channel, not a member: awaiting_first_join with their
 *   membership counter now (0 for none).
 * An origin this release does not connect (inviteFlow): nothing set.
 */
async function initializeInviteSources(inviteId: string, joinerUserId: string, kind: "external" | "direct"): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId)).for("update");
    if (!locked || locked.sourceState !== null || !OPEN_EXTERNAL_INVITE_STATUSES.includes(locked.status)) return;
    const flow = inviteFlow(locked.origin);
    // Another release's, or a self_connect operation (its state is set when it starts, createSelfConnectInvite / reserveConnection).
    if (!flow || flow === "self_connect") return;
    const [channel] = await tx.select().from(channels).where(eq(channels.id, locked.channelId));
    if (!channel) return;
    // Derived here, from the channel as it is now: never from the caller.
    const createsJoint = kind === "direct" && channel.type !== "joint";
    const jointChannelId = channel.type === "joint" ? await hostJointOf(tx, channel) : null;
    if (!jointChannelId && channel.type !== "private") return;
    let state: SourceColumns;
    if (!jointChannelId) {
      state = createsJoint
        ? { sourceState: "awaiting_joint_creation", sourceStartGeneration: null, sourceGeneration: null }
        : { sourceState: "awaiting_first_join", sourceStartGeneration: 0, sourceGeneration: null };
    } else {
      // Membership and counter in one statement, one snapshot: two reads could
      // see no member, then the counter of a join committed in between (and a
      // later connection would re-add them after they left). No J lock here:
      // connections take J before the invite row.
      await sourcesSnapshotBarrierForTests?.(inviteId);
      const [row] = (await tx.execute<{ generation: number | null; counter: number | null }>(sql`SELECT
          (SELECT generation FROM joint_channel_members WHERE joint_channel_id = ${jointChannelId}::uuid AND user_id = ${joinerUserId}::uuid) AS generation,
          (SELECT last_generation FROM joint_membership_generations WHERE joint_channel_id = ${jointChannelId}::uuid
            AND principal_kind = 'user' AND principal_id = ${joinerUserId}::uuid) AS counter`)).rows;
      if (row?.generation == null) {
        state = { sourceState: "awaiting_first_join", sourceStartGeneration: row?.counter == null ? 0 : Number(row.counter), sourceGeneration: null };
      } else if (existingMemberIsSource(flow)) {
        // The membership this operation starts from: each connection records
        // a source of exactly it (planInviteSources' member_at_start), as for
        // the actor the joint-creating conversion made a member.
        state = { sourceState: "member_at_start", sourceStartGeneration: null, sourceGeneration: Number(row.generation) };
      } else {
        state = { sourceState: "no_sources", sourceStartGeneration: null, sourceGeneration: null };
      }
    }
    await tx.update(channelExternalInvites).set(state).where(eq(channelExternalInvites.id, inviteId));
  });
  await sourcesStartedBarrierForTests?.(inviteId);
}

/** Tests only: a direct-connect operation starting on a channel that turned joint after its invite was made (the race connectOwnServersToChannel can meet). */
export const __initializeInviteSourcesForTests = initializeInviteSources;

let sourcesSnapshotBarrierForTests: ((inviteId: string) => Promise<void>) | null = null;
/** Tests only: awaited by initializeInviteSources on a joint channel, under the invite row lock, right before its membership snapshot (a deterministic window for a join committing meanwhile). */
export function __setInviteSourcesSnapshotBarrierForTests(barrier: ((inviteId: string) => Promise<void>) | null): void {
  sourcesSnapshotBarrierForTests = barrier;
}

let sourcesStartedBarrierForTests: ((inviteId: string) => Promise<void>) | null = null;
/**
 * Tests only: awaited by initializeInviteSources once its own transaction ended (committed, or returned with nothing
 * to write), before the operation's connection transaction starts. A race test parks the connection on its invite
 * row here: a hold taken before the operation started would stop it in this short transaction instead, holding nothing.
 */
export function __setInviteSourcesStartedBarrierForTests(barrier: ((inviteId: string) => Promise<void>) | null): void {
  sourcesStartedBarrierForTests = barrier;
}

/** The joiner's current membership of the joint (its generation), or undefined; `forUpdate` under the J lock. */
async function memberGeneration(tx: DatabaseExecutor, jointChannelId: string, userId: string, forUpdate: boolean): Promise<number | undefined> {
  const result = await tx.execute<{ generation: number }>(sql`SELECT generation FROM joint_channel_members
    WHERE joint_channel_id = ${jointChannelId}::uuid AND user_id = ${userId}::uuid ${forUpdate ? sql`FOR UPDATE` : sql``}`);
  return result.rows[0] ? Number(result.rows[0].generation) : undefined;
}

/** The joiner's membership counter (joint_membership_generations: survives leaving), 0 for none. */
async function membershipCounter(tx: DatabaseExecutor, jointChannelId: string, userId: string): Promise<number> {
  const result = await tx.execute<{ lastGeneration: number }>(sql`SELECT last_generation AS "lastGeneration" FROM joint_membership_generations
    WHERE joint_channel_id = ${jointChannelId}::uuid AND principal_kind = 'user' AND principal_id = ${userId}::uuid`);
  return result.rows[0] ? Number(result.rows[0].lastGeneration) : 0;
}

/**
 * What this connection does with the joiner's membership, decided under the
 * J lock before the accept (refused: nothing written).
 * - `first_join`: the accept admits them (and records this server as its
 *   source); the invite becomes joined at that generation.
 * - `record`: they are the member this operation made or started from; this
 *   server is one more source of that membership.
 * - `none`: they are a member another way; the accept adds no member and
 *   this records no source (`toNoSources`: the invite stops waiting to join).
 */
type SourcePlan =
  | { kind: "first_join" }
  | { kind: "record"; generation: number }
  | { kind: "none"; toNoSources: boolean };

async function planInviteSources(tx: DatabaseTransaction, input: { invite: Invite; jointChannelId: string; joinerUserId: string }): Promise<SourcePlan | null> {
  const { invite } = input;
  // A self_connect operation is by a member, of exactly the membership it
  // started from (member_at_start, bound at its start or by the conversion
  // that made the joint): anything else (unresolved, a first join, no source)
  // is refused, never a join (design v3 §4).
  if (inviteFlow(invite.origin) === "self_connect" && invite.sourceState !== "member_at_start") throw membershipChanged();
  if (invite.sourceState === null) return null;
  const generation = await memberGeneration(tx, input.jointChannelId, input.joinerUserId, true);
  switch (invite.sourceState) {
    case "awaiting_joint_creation":
    case "awaiting_first_join": {
      if (generation !== undefined) return { kind: "none", toNoSources: true };
      // Unresolved creation: the joint was made by another conversion, after
      // this operation started on a channel with no joint (counter 0).
      const start = invite.sourceState === "awaiting_first_join" ? invite.sourceStartGeneration : 0;
      // They joined and left again since the start: not this operation's to re-add.
      if (await membershipCounter(tx, input.jointChannelId, input.joinerUserId) !== start) throw membershipChanged();
      return { kind: "first_join" };
    }
    case "joined":
    case "member_at_start":
      // Left, or left and came back another way (a new membership): no source of it is this operation's.
      if (generation === undefined || generation !== invite.sourceGeneration) throw membershipChanged();
      return { kind: "record", generation };
    case "no_sources":
      // An old operation never re-adds somebody who left.
      if (generation === undefined) throw membershipChanged();
      return { kind: "none", toNoSources: false };
  }
}

/**
 * After the accept, under the same locks: the source this connection records
 * and the invite's source state from now on (merged into its write). Only
 * the joiner's own membership; a source already there (even ended) is kept
 * as it is. The joiner is a current non-guest member of the server
 * (lockAndCheckParties) and the joint open (the accept's lifecycle check).
 */
async function recordInviteSource(
  tx: DatabaseTransaction,
  plan: SourcePlan,
  input: {
    jointChannelId: string;
    parties: ConnectionParties;
    /** An operation whose `record` may reopen the joiner's own ended source (existingMemberIsSource; reopenEndedOwnSource). */
    reopenOwnEnded: { hostServerId: string; hostChannelId: string } | null;
  },
): Promise<Partial<SourceColumns>> {
  const { parties } = input;
  if (plan.kind === "first_join") {
    // The accept's join wrote this server's source (admitted_by the authorizer).
    const generation = await memberGeneration(tx, input.jointChannelId, parties.joinerUserId, false);
    if (generation === undefined) throw new Error("Joint member not created by the accept");
    return { sourceState: "joined", sourceStartGeneration: null, sourceGeneration: generation };
  }
  if (plan.kind === "record") {
    await recordOrdinaryJointAdmissions(tx, sql`SELECT ${input.jointChannelId}::uuid AS joint_channel_id, ${parties.joinerUserId}::uuid AS user_id,
      ${parties.targetServerId}::uuid AS server_id, ${plan.generation}::integer AS generation, now() AS admitted_at, ${parties.authorizerUserId}::uuid AS admitted_by`);
    if (input.reopenOwnEnded) await reopenEndedOwnSource(tx, { ...input.reopenOwnEnded, jointChannelId: input.jointChannelId, parties, generation: plan.generation });
    return {};
  }
  return plan.toNoSources ? { sourceState: "no_sources", sourceStartGeneration: null, sourceGeneration: null } : {};
}

/**
 * The person connects their own server again (host_direct; self_connect
 * will too) after its source of their current membership ended (the server
 * disconnected, they stayed in the joint another way): recordOrdinaryJointAdmissions
 * keeps an ended row, so the server would be connected with no live source.
 * Only here, under the J lock and after planInviteSources checked the
 * generation, exactly that one row (joint, person, this generation, this
 * server) is reopened as an ordinary admission by them now (Tenny 627d2ea6),
 * with one `channel.source_readmitted` event on the host carrying the row as
 * it was. Nobody else's row, and no other server's, is touched; every other
 * caller of recordOrdinaryJointAdmissions keeps ended rows ended. The audit
 * row's server_id FK is the host's row, KEY SHARE-locked before J by the caller.
 * Host only: the joint's membership is the host's record, and no other
 * source change writes an event on a participant server.
 */
async function reopenEndedOwnSource(tx: DatabaseTransaction, input: {
  jointChannelId: string;
  hostServerId: string;
  hostChannelId: string;
  parties: ConnectionParties;
  generation: number;
}): Promise<void> {
  const { parties } = input;
  if (parties.joinerUserId !== parties.authorizerUserId) return;
  const key = sql`joint_channel_id = ${input.jointChannelId}::uuid AND user_id = ${parties.joinerUserId}::uuid
    AND generation = ${input.generation}::integer AND server_id = ${parties.targetServerId}::uuid`;
  const [ended] = (await tx.execute<{ endedAt: string; admittedBy: string | null; admittedAt: string; kind: string }>(sql`SELECT
      to_json(ended_at) #>> '{}' AS "endedAt", admitted_by AS "admittedBy", to_json(admitted_at) #>> '{}' AS "admittedAt", kind
    FROM joint_channel_admissions WHERE ${key} AND ended_at IS NOT NULL FOR UPDATE`)).rows;
  if (!ended) return;
  await tx.execute(sql`UPDATE joint_channel_admissions SET ended_at = NULL, admitted_by = ${parties.joinerUserId}::uuid, admitted_at = now(), kind = 'admission'
    WHERE ${key}`);
  await recordIntegrationAuditEvent({
    serverId: input.hostServerId,
    eventType: "channel.source_readmitted",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: parties.joinerUserId },
    target: { type: "user", id: parties.joinerUserId },
    metadata: {
      jointChannelId: input.jointChannelId,
      hostServerId: input.hostServerId,
      channelId: input.hostChannelId,
      sourceServerId: parties.targetServerId,
      userId: parties.joinerUserId,
      generation: input.generation,
      previousEndedAt: ended.endedAt,
      previousAdmittedBy: ended.admittedBy,
      previousAdmittedAt: ended.admittedAt,
      previousKind: ended.kind,
      ...serverAuditContextMetadata({ operationId: newAuditOperationId() }),
    },
  }, tx);
}

function sameSourceState(a: SourceColumns, b: SourceColumns): boolean {
  return a.sourceState === b.sourceState && a.sourceStartGeneration === b.sourceStartGeneration && a.sourceGeneration === b.sourceGeneration;
}

export interface ExternalConnectionEffects {
  io: SocketServer | null | undefined;
  orchestrator: AgentOrchestrator | null | undefined;
}

/** What the channel says when a server connects (#wg-rbac:#40), from the channel's point of view. */
export function serverConnectedSystemMessageText(serverName: string): string {
  return `${serverName} connected to this channel.`;
}

/**
 * Post-commit, once for each connection the caller's own call committed (a
 * replay or retry of a connection already made commits none, and so publishes
 * none): every projection's metadata, the new channel to the joiner on the
 * connected server, then the channel's system message.
 */
export async function publishExternalConnection(effects: ExternalConnectionEffects, connection: ExternalConnection): Promise<void> {
  const { io, orchestrator } = effects;
  if (!io) return;
  await emitJointProjectionUpdates(io, connection.localChannelId);
  const local = await getChannel(connection.localChannelId);
  if (!local) return;
  const [withMetadata] = await attachJointChannelMetadata([{ ...local, joined: true }]);
  io.to(socketUserServerRoom(connection.joinerUserId, connection.targetServerId)).emit("channel:updated", { channel: withMetadata });
  if (!orchestrator) return;
  await announceExternalConnection(io, orchestrator, connection).catch((err: unknown) => {
    console.error("[ExternalConnect] failed to post the server-connected system message:", { channelId: connection.localChannelId, err });
  });
}

/**
 * The channel's system message for one connected server, as a host's
 * disconnect posts its own (routes/channels.ts): stored once on the canonical
 * channel and shown on every connected server's copy, the new one included
 * (broadcastSystemMessageToLocalSurfaces). Read for the person who connected it.
 */
async function announceExternalConnection(io: SocketServer, orchestrator: AgentOrchestrator, connection: ExternalConnection): Promise<void> {
  const [server] = await getDb().select({ name: servers.name }).from(servers).where(eq(servers.id, connection.targetServerId));
  await broadcastSystemMessageToLocalSurfaces(io, orchestrator, connection.localChannelId, serverConnectedSystemMessageText(server?.name ?? "A server"), {
    inboxFactPolicy: {
      mode: "record",
      producer: "channel.joint_connect",
      reason: "a server connecting to a joint channel is shared channel activity",
      causalActor: { type: "user", id: connection.actorUserId },
    },
  });
}

/** What the invitee is told when the protected boundary refused: the neutral 404 for an invite no longer usable (an expired one is marked so). */
async function inviteeRefusal(err: unknown, inviteId: string): Promise<unknown> {
  if (err instanceof InviteLapsedError) {
    await markLapsed(inviteId);
    return invalidInvite();
  }
  // The joiner's account retired or being deleted meanwhile (lockJointUsersFirst): the same neutral answer.
  if (err instanceof StaleInviteError || err instanceof ExternalChannelsOffError || err instanceof JointActorUnavailableError) return invalidInvite();
  return err;
}

/**
 * A self_connect's refusal of one server, as its route answers it: the
 * operation itself gone or the feature off under the locks is
 * connect_unavailable (there is no invite link to call invalid).
 */
function selfConnectRefusal(err: unknown): unknown {
  if (err instanceof JointActorUnavailableError || err instanceof StaleInviteError || err instanceof ExternalChannelsOffError || err instanceof SelfConnectUnavailableError || err instanceof InviteLapsedError) {
    return new ExternalConnectError("connect_unavailable", "This server can't be connected to the channel right now.");
  }
  return err;
}

/** Translates the joint accept's refusal of a person into this surface's answer. */
function partyRefusal(err: JointInviteAccepterError, approving: boolean): ExternalConnectError {
  if (err.code === "authorizer_not_admin") {
    return approving
      ? new ExternalConnectError("approver_lost_role", "You can no longer approve this request")
      : new ExternalConnectError("server_admin_required", "Only an owner or admin of the server can connect it");
  }
  return approving
    ? new ExternalConnectError("requester_left", "The person who asked is no longer a member of this server")
    : new ExternalConnectError("server_membership_required", "You're no longer a member of this server");
}

/**
 * POST /api/external-invites/:token/connect: the invitee connects a server
 * they own or administer (re-checked under the locks).
 */
export async function connectServerWithInvite(token: string, userId: string, serverId: unknown, deps: ExternalConnectDeps = {}): Promise<ExternalConnectResult> {
  const { invite, channel } = await resolvePendingInvite(token, userId);
  const target = await assertConnectableServer(serverId, invite.hostServerId, userId);
  if (!isAdminRole(target.role)) throw new ExternalConnectError("server_admin_required", "Only an owner or admin of the server can connect it");
  await initializeInviteSources(invite.id, userId, "external");
  return connectDirectly({ invite, channel, targetServerId: target.id, userId, deps, outcome: "server" });
}

/** The invite as /connect and /connect-new-server start from: open and not held by an approval or a connection, its channel not archived. */
async function resolvePendingInvite(token: string, userId: string): Promise<{ invite: Invite; channel: Channel }> {
  const { invite, channel } = await resolveInviteForInvitee(token, userId);
  if (invite.status === "awaiting_approval") {
    throw new ExternalConnectError("approval_in_progress", "A request to connect a server with this invite is waiting for approval.");
  }
  if (invite.status === "connecting") throw connectInProgress();
  if (channel.archivedAt) throw new ExternalConnectError("channel_archived", "This channel is archived.");
  return { invite, channel };
}

/** The caller, an owner or admin of the target (re-checked under the locks), connects it: joiner and authorizer both. */
async function connectDirectly(input: { invite: Invite; channel: Channel; targetServerId: string; userId: string; deps: ExternalConnectDeps; outcome: ConnectOutcome }): Promise<ExternalConnectResult> {
  const { invite, userId } = input;
  try {
    return await connectOrReserve({
      invite,
      channel: input.channel,
      parties: { targetServerId: input.targetServerId, joinerUserId: userId, authorizerUserId: userId },
      from: FROM_PENDING,
      requestId: null,
      deps: input.deps,
      outcome: input.outcome,
    });
  } catch (err) {
    if (err instanceof JointInviteAccepterError) throw partyRefusal(err, false);
    throw attributeJointLimit(await inviteeRefusal(err, invite.id), { hostServerId: invite.hostServerId, connectingServerId: input.targetServerId });
  }
}

// ── A new server ──

/** The new server was created, but connecting it was refused: the caller keeps the (empty) server; `cause` is the refusal. */
export class NewServerNotConnectedError extends Error {
  constructor(readonly serverId: string, override readonly cause: unknown) {
    super("The new server was created but could not be connected");
    this.name = "NewServerNotConnectedError";
  }
}

/**
 * The refusals a connection of a brand-new server could meet, answered before
 * it is created so the common ones leave no empty server behind. Lock-free
 * reads, the same checks the connect makes under its locks (which stay the
 * authority): no Guest bound to the channel, no other connection or conversion
 * under way, the host's limits, and the joint accept's admission rules (total
 * and free-server caps,
 * the host's hosting slot) with the new server counted as a free one
 * (newFreeServer, never looked up). The new server's own external-channel limit cannot refuse:
 * a new free server is in no external channel yet, and this is its first.
 */
async function preflightNewServerConnect(invite: Invite, channel: Channel, userId: string): Promise<void> {
  const db = getDb();
  if (await boundGuestsBlockJoint(db, channel)) throw guestsPresent();
  if (await channelHasConnectingInvite(db, channel.id, invite.id)) throw connectInProgress();
  const now = new Date();
  if (channel.type === "private") {
    // As reserveConnection's check: another conversion under way (a rolled-back one is restarted).
    const active = await db.select({ status: channelConversionJobs.status, progress: channelConversionJobs.progress }).from(channelConversionJobs)
      .where(and(eq(channelConversionJobs.sourceChannelId, channel.id), inArray(channelConversionJobs.status, ["pending", "running", "failed"])));
    if (active.some((job) => !(job.status === "failed" && (job.progress as { rollbackState?: unknown }).rollbackState === "restored"))) {
      throw connectInProgress();
    }
    // The invitee is outside the host: its plan and other channels are not told.
    await preflightFreeHostJointCapacity(channel.serverId, now, { audience: "outsider", resumingConversionOfChannelId: channel.id });
    // After the conversion the joint has the host alone; the new server's
    // admission then counts exactly these two.
    await checkJointAdmission(db, null, { kind: "convert", hostServerId: channel.serverId }, now, { newFreeServer: true });
  } else {
    const jointChannelId = await hostJointOf(db, channel);
    if (!jointChannelId) throw invalidInvite();
    // The joint accept's two limit checks (acceptJointChannelInviteInCallerTransaction),
    // read without their locks, for a free server not yet created.
    await refreshJointEntitlementsBeforeAdmission(jointChannelId, [], now);
    const parentJointId = await resolveParentJointId(db, jointChannelId);
    await checkFreeHostCanConnectFirstServer(db, parentJointId ?? jointChannelId, { newServer: true }, now);
    await checkJointAdmission(db, parentJointId, { kind: "accept" }, now, { newFreeServer: true });
  }
  await assertHostCanConnectExternalServer(db, { hostServerId: channel.serverId, hostChannelId: channel.id, now });
}

/**
 * POST /api/external-invites/:token/connect-new-server: the invitee creates a
 * server (`create`: exactly POST /api/servers' create, the caller its owner)
 * and connects it with the invite as a direct connect (they own it), the
 * invite ending as new_server. The invite is resolved and the connection
 * preflighted first: an invite they cannot use, or a connection the host side
 * would refuse now, creates nothing. Creation commits in its own transaction
 * (its post-commit work, the hosted Cindy, cannot roll back), then the connect
 * runs in its own, in the direct connect's lock order; the new server's rows
 * are its own, so nothing is held across the two. A refusal after creation
 * (a race with the preflight) leaves the caller the new empty server:
 * NewServerNotConnectedError names it.
 */
export async function connectNewServerWithInvite(
  token: string,
  userId: string,
  create: () => Promise<{ id: string }>,
  deps: ExternalConnectDeps = {},
): Promise<{ serverId: string; result: ExternalConnectResult }> {
  const { invite, channel } = await resolvePendingInvite(token, userId);
  // The server is not created yet: a refusal of its side names no server.
  await preflightNewServerConnect(invite, channel, userId).catch((err: unknown) => {
    throw attributeJointLimit(err, { hostServerId: invite.hostServerId, connectingServerId: null });
  });
  // Before the server exists: the joiner's membership as they chose to connect.
  await initializeInviteSources(invite.id, userId, "external");
  const server = await create();
  try {
    const result = await connectDirectly({ invite, channel, targetServerId: server.id, userId, deps, outcome: "new_server" });
    return { serverId: server.id, result };
  } catch (err) {
    throw new NewServerNotConnectedError(server.id, err);
  }
}

// ── Several servers at once ──

/** At most this many servers in one choice: every other server a joint channel can take. */
export const MAX_SERVERS_PER_CONNECT = MAX_JOINT_CHANNEL_SERVERS - 1;

/** A server chosen to connect; `approverUserId` the owner or admin asked, for one the chooser doesn't own or administer. */
export interface ServerSelection {
  serverId: string;
  approverUserId?: string;
}

/**
 * Where one chosen server stands once the choice was made: connected (its
 * projection), being connected (the channel's conversion first, or queued
 * behind another server), waiting for its approver, or refused (`error`: the
 * same refusal a connection of that server alone would have met).
 */
export type ServerConnectOutcome =
  | { serverId: string; state: "connected"; channelId: string }
  | { serverId: string; state: "connecting" }
  | { serverId: string; state: "awaiting_approval"; requestId: string }
  /** `askedApproval`: refused on the way to its approver (the chooser only belongs to it), not as a connect of theirs. */
  | { serverId: string; state: "refused"; error: unknown; askedApproval?: true };

export interface MultiConnectResult {
  /** One per chosen server, in the order chosen. */
  servers: ServerConnectOutcome[];
  /** The connections that committed, for the publish (publishExternalConnection). */
  connections: ExternalConnection[];
}

const invalidServer = () => new ExternalConnectError("invalid_server", "Choose a server you belong to");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 1 to MAX_SERVERS_PER_CONNECT distinct servers, each a uuid (and an approver's uuid when given); anything else is invalid_server. */
export function parseServerSelections(raw: unknown): ServerSelection[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SERVERS_PER_CONNECT) throw invalidServer();
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    const { serverId, approverUserId } = (typeof entry === "string" ? { serverId: entry } : entry ?? {}) as { serverId?: unknown; approverUserId?: unknown };
    if (typeof serverId !== "string" || !UUID.test(serverId) || seen.has(serverId.toLowerCase())) throw invalidServer();
    if (approverUserId !== undefined && approverUserId !== null && (typeof approverUserId !== "string" || !UUID.test(approverUserId))) throw invalidServer();
    seen.add(serverId.toLowerCase());
    return typeof approverUserId === "string" ? { serverId, approverUserId } : { serverId };
  });
}

/**
 * The one multi-connect both surfaces share: the invite page's chosen
 * servers (the invitee's), and a host owner/admin's own servers
 * (`directOnly`: theirs to connect, no approval). Each server is decided on
 * its own and one refused doesn't stop the others:
 *
 * - Only a server the chooser is offered (listConnectableServers: one they
 *   belong to other than as a Guest, an ordinary server, not the host, not
 *   connected already) is taken, whatever the client sent; one at the free
 *   plan's limit is refused as the list says it would be.
 * - Owner or admin: connected now (re-checked under the locks); on a private
 *   channel the first starts the conversion and the others queue behind it.
 * - Member only: a request to the approver chosen for it, one of its owners
 *   or admins (re-checked under the locks), emailed after its commit.
 *
 * Every request in one transaction first (createApprovalRequests), so the
 * invite waits on them before any connection rests it; then the direct
 * connects; only then the approvers' emails (an approver acts only from that
 * link, so no approval lands before the invitee's own servers are in or
 * queued, nor before the other requests exist); then the invite rests on
 * what is left (settleAfterChoice).
 */
async function connectSelectedServers(input: {
  invite: Invite;
  channel: Channel;
  userId: string;
  selections: readonly ServerSelection[];
  deps: ExternalConnectDeps;
  directOnly: boolean;
  /** ConnectInput.actingAsHostAdmin. */
  actingAsHostAdmin?: boolean;
}): Promise<MultiConnectResult> {
  const { invite, userId } = input;
  const offered = new Map((await listConnectableServers(input.channel, userId)).map((server) => [server.id, server]));
  const outcomes = new Map<string, ServerConnectOutcome>();
  const refuse = (serverId: string, error: unknown, askedApproval = false) =>
    outcomes.set(serverId, { serverId, state: "refused", error, ...(askedApproval ? { askedApproval: true as const } : {}) });
  const direct: string[] = [];
  const approvals: Array<{ serverId: string; approverUserId: string }> = [];
  for (const selection of input.selections) {
    const server = offered.get(selection.serverId);
    if (!server) refuse(selection.serverId, invalidServer());
    else if (server.atLimit) {
      refuse(server.id, new ExternalChannelLimitError("free_external_limit", "This server is already in a channel shared with another server or guests. Upgrade it to connect it to more.", "connecting", server.id), !server.canConnectDirectly && !input.directOnly);
    } else if (server.canConnectDirectly) direct.push(server.id);
    else if (input.directOnly) refuse(server.id, new ExternalConnectError("server_admin_required", "Only an owner or admin of the server can connect it"));
    else if (!selection.approverUserId || !server.approvers.some((approver) => approver.id === selection.approverUserId)) refuse(server.id, invalidApprover(), true);
    else approvals.push({ serverId: server.id, approverUserId: selection.approverUserId });
  }
  // Every request at once, before the direct connects (a private channel's
  // conversion fences writes to it once started), but nobody is emailed until
  // those are in or queued: an approver acts only from the emailed link, so
  // no approval can take the conversion, or end the invite, before them.
  const requested = approvals.length === 0 ? [] : await createApprovalRequests({
    invite,
    channel: input.channel,
    userId,
    requests: approvals.map((approval) => ({ targetServerId: approval.serverId, approverUserId: approval.approverUserId })),
    from: FROM_CHOOSING,
    notify: false,
  });
  for (const result of requested) {
    if ("requestId" in result) outcomes.set(result.targetServerId, { serverId: result.targetServerId, state: "awaiting_approval", requestId: result.requestId });
    else refuse(result.targetServerId, result.error, true);
  }
  const connections = await connectDirectServers({ ...input, servers: direct, outcomes });
  for (const result of requested) if ("requestId" in result) await emailApprover(result.requestId);
  await settleAfterChoice(invite.id);
  return { servers: input.selections.map((selection) => outcomes.get(selection.serverId)!), connections };
}

/**
 * The chosen servers the chooser owns or administers, in turn, as
 * connectDirectly connects one (its refusals translated the same way). A
 * private channel: the first that can start the conversion reserves the
 * invite, the rest queued behind it (all connecting); one refused there
 * hands the reservation to the next. A joint channel: one transaction each,
 * the invite held open until the last.
 */
async function connectDirectServers(input: {
  invite: Invite;
  channel: Channel;
  userId: string;
  servers: readonly string[];
  deps: ExternalConnectDeps;
  outcomes: Map<string, ServerConnectOutcome>;
  actingAsHostAdmin?: boolean;
}): Promise<ExternalConnection[]> {
  const { invite, userId, outcomes } = input;
  const connections: ExternalConnection[] = [];
  let channel = input.channel;
  let remaining = [...input.servers];
  while (remaining.length > 0) {
    const [head, ...rest] = remaining as [string, ...string[]];
    const parties = { targetServerId: head, joinerUserId: userId, authorizerUserId: userId };
    try {
      if (channel.type === "private") {
        const reserved = await reserveConnection({ invite, channel, parties, from: FROM_CHOOSING, requestId: null, deps: input.deps, outcome: "server", queue: rest, actingAsHostAdmin: input.actingAsHostAdmin });
        if (reserved) {
          for (const serverId of remaining) outcomes.set(serverId, { serverId, state: "connecting" });
          return connections;
        }
        // It turned joint meanwhile: connect each to the joint instead.
        channel = (await getChannel(channel.id)) ?? channel;
        if (channel.type === "private") throw new StaleInviteError();
        continue;
      }
      const connection = inviteFlow(invite.origin) === "self_connect"
        ? await connectSelfJointChannel({ invite, channel, parties, from: FROM_CHOOSING, holdOpen: rest.length > 0 })
        : await connectJointChannel({ invite, channel, parties, from: FROM_CHOOSING, requestId: null, outcome: "server", holdOpen: rest.length > 0 });
      connections.push(connection);
      outcomes.set(head, { serverId: head, state: "connected", channelId: connection.localChannelId });
    } catch (err) {
      outcomes.set(head, {
        serverId: head,
        state: "refused",
        error: err instanceof JointInviteAccepterError
          ? partyRefusal(err, false)
          : attributeJointLimit(inviteFlow(invite.origin) === "self_connect" ? selfConnectRefusal(err) : await inviteeRefusal(err, invite.id), { hostServerId: invite.hostServerId, connectingServerId: head }),
      });
    }
    remaining = rest;
  }
  return connections;
}

/** Once a choice is through: an invite left open with nothing being connected rests (restingInviteState) under its row lock. */
async function settleAfterChoice(inviteId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId)).for("update");
    if (!locked || (locked.status !== "pending" && locked.status !== "awaiting_approval")) return;
    const now = new Date();
    if (locked.expiresAt <= now) {
      await lapseInvite(tx, locked, now);
      return;
    }
    await tx.update(channelExternalInvites).set(await restingInviteState(tx, locked, now)).where(eq(channelExternalInvites.id, locked.id));
  });
}

/**
 * POST /api/external-invites/:token/connect-servers: the invitee's chosen
 * servers (connectSelectedServers), with the invite open and nothing under
 * way with it (as /connect); its channel not archived.
 */
export async function connectServersWithInvite(token: string, userId: string, rawSelections: unknown, deps: ExternalConnectDeps = {}): Promise<MultiConnectResult> {
  const selections = parseServerSelections(rawSelections);
  const { invite, channel } = await resolvePendingInvite(token, userId);
  await initializeInviteSources(invite.id, userId, "external");
  return connectSelectedServers({ invite, channel, userId, selections, deps, directOnly: false });
}

/**
 * POST /api/channels/:id/external-connect-servers: a host owner or admin
 * connects servers of theirs they own or administer to a channel of the
 * host, as Create Joint Channel's direct connect did (no email, no
 * approval). The channel is checked and made private as a send does, and the
 * connection runs on an invite to their own address
 * (createDirectConnectInvite) through connectSelectedServers, `directOnly`:
 * a server they are only a member of is refused. An invite that connected
 * nothing and has nothing under way is withdrawn again.
 */
export async function connectOwnServersToChannel(
  channelId: string,
  actorUserId: string,
  rawServerIds: unknown,
  options: { makePrivate?: boolean },
  deps: ExternalConnectDeps = {},
): Promise<MultiConnectResult & { madePrivate: Channel | null; replacedInviteId: string | null }> {
  const selections = parseServerSelections(rawServerIds);
  const unlocked = await getChannel(channelId);
  // Outside the transactions: the refresh may call the billing provider.
  if (unlocked) await refreshSubscriptionForServerIfStale(unlocked.serverId);
  // An open emailed or legacy invite to their own address is revoked here (replacedInviteId), never used.
  const { invite, channel, madePrivate, replaced } = await createDirectConnectInvite(channelId, actorUserId, options);
  try {
    await initializeInviteSources(invite.id, actorUserId, "direct");
    return { ...await connectSelectedServers({ invite, channel, userId: actorUserId, selections, deps, directOnly: true, actingAsHostAdmin: true }), madePrivate, replacedInviteId: replaced };
  } finally {
    await withdrawUnusedDirectConnectInvite(invite.id, actorUserId);
  }
}

/**
 * POST /api/channels/:id/connect-my-servers (jointMemberConnectService): a
 * channel member connects servers they own or administer to the channel
 * whose host copy is `hostChannel`, no approval. The servers offered are
 * Your servers' (listConnectableServers, `directOnly`: one they only belong
 * to is refused server_admin_required). It runs on a self_connect operation
 * (createSelfConnectInvite): on a joint channel each server connects in its
 * own transaction (connectSelfJointChannel); on a private one the first
 * reserves the channel's conversion (self_connecting) and the rest queue
 * behind it, the worker connecting each once the channel is joint. An
 * operation that connected nothing and has nothing under way ends.
 */
export async function connectMemberServers(input: {
  hostChannel: Channel;
  actorUserId: string;
  /** The membership the operation starts from, on a joint channel; null on a private one (its reservation binds it). */
  jointGeneration: number | null;
  rawServerIds: unknown;
  deps?: ExternalConnectDeps;
}): Promise<MultiConnectResult> {
  const selections = parseServerSelections(input.rawServerIds);
  // Outside the transactions: the refresh may call the billing provider.
  await refreshSubscriptionForServerIfStale(input.hostChannel.serverId);
  const invite = await createSelfConnectInvite(input.hostChannel.id, input.actorUserId, input.jointGeneration);
  try {
    const channel = (await getChannel(input.hostChannel.id)) ?? input.hostChannel;
    return await connectSelectedServers({ invite, channel, userId: input.actorUserId, selections, deps: input.deps ?? {}, directOnly: true });
  } finally {
    await withdrawUnusedDirectConnectInvite(invite.id, input.actorUserId);
  }
}

/**
 * The actor's own connect invite, once it connected nothing and nothing is
 * under way with it: revoked, its slot free. Decided under its row lock: two
 * of their calls may share it (createDirectConnectInvite reuses a pending
 * one), so one that connected nothing never withdraws it from under the
 * other's server already connected (accepted_server_id), reserved (status,
 * queue) or waiting (a pending request). True when it did.
 */
export async function withdrawUnusedDirectConnectInvite(inviteId: string, actorUserId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId)).for("update");
    if (!locked || locked.status !== "pending" || locked.acceptedServerId || locked.connectedServerIds.length > 0 || locked.connectQueuedServerIds.length > 0) {
      return false;
    }
    // Another release's row is never written here.
    if (inviteFlow(locked.origin) === null) return false;
    const [waiting] = await tx.select({ id: channelServerConnectRequests.id }).from(channelServerConnectRequests)
      .where(and(eq(channelServerConnectRequests.inviteId, inviteId), eq(channelServerConnectRequests.status, "pending")))
      .limit(1);
    if (waiting) return false;
    await tx.update(channelExternalInvites)
      .set({ ...CLEARED_CONNECT_STATE, status: "revoked", decidedAt: new Date(), revokedByUserId: actorUserId })
      .where(eq(channelExternalInvites.id, inviteId));
    return true;
  });
}

// ── Approval ──

/**
 * POST /api/external-invites/:token/request-approval: the invitee, a member
 * of `serverId`, asks one of its owners/admins to connect it. Under the
 * channel row (the Guest-accept side's lock too): no Guest bound to it and no
 * connection under way; then the server and the two members' rows, then the
 * invite row. The approver is emailed after the commit.
 */
export async function requestServerConnectApproval(token: string, userId: string, serverId: unknown, approverUserId: unknown): Promise<{ requestId: string }> {
  const { invite, channel } = await resolveInviteForInvitee(token, userId);
  if (invite.status === "awaiting_approval") {
    throw new ExternalConnectError("approval_in_progress", "A request to connect a server with this invite is waiting for approval.");
  }
  if (invite.status === "connecting") throw connectInProgress();
  if (channel.archivedAt) throw new ExternalConnectError("channel_archived", "This channel is archived.");
  const target = await assertConnectableServer(serverId, invite.hostServerId, userId);
  await initializeInviteSources(invite.id, userId, "external");
  return createApprovalRequest({ invite, channel, userId, targetServerId: target.id, approverUserId, from: FROM_PENDING });
}

const invalidApprover = () => new ExternalConnectError("invalid_approver", "Choose an owner or admin of the server to approve");

/** Postgres' unique_violation, as node-postgres reports it (drizzle wraps it in `cause`). */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

/** One request for `targetServerId` (createApprovalRequests); its refusal thrown. */
async function createApprovalRequest(input: {
  invite: Invite;
  channel: Channel;
  userId: string;
  targetServerId: string;
  approverUserId: unknown;
  from: OpenExpectation;
}): Promise<{ requestId: string }> {
  const [result] = await createApprovalRequests({ ...input, requests: [{ targetServerId: input.targetServerId, approverUserId: input.approverUserId }] });
  if (!result || "error" in result) throw result?.error;
  return { requestId: result.requestId };
}

type ApprovalResult = { targetServerId: string; requestId: string } | { targetServerId: string; error: unknown };

/**
 * The requests for these servers (each one the invitee belongs to), each to
 * an approver who owns or administers it other than them, all in one
 * transaction: no approver can act on one before the others exist, so an
 * approval never finds the invite with nothing else waiting while the rest
 * are still being asked (connectSelectedServers). Each server is decided on
 * its own: the approver, a server already connected, the parties under the
 * lock, a request already waiting for it (approval_in_progress). The invite
 * is awaiting_approval from then on, unless a connection of it is under way
 * (it rests on these once done). Lock order as one request: the users rows
 * of the requester and every approver asked (lockJointUsersFirst), the channel row
 * (the Guest-accept side's lock too: no Guest bound, no other invite's
 * connection under way), each server and its two members' rows (server-id
 * order), the invite row, the referenced rows. Approvers are emailed after
 * the commit (unless `notify` is false).
 */
async function createApprovalRequests(input: {
  invite: Invite;
  channel: Channel;
  userId: string;
  requests: ReadonlyArray<{ targetServerId: string; approverUserId: unknown }>;
  from: OpenExpectation;
  /** False: the caller emails the approvers itself, later (connectSelectedServers). */
  notify?: boolean;
}): Promise<ApprovalResult[]> {
  const { invite, channel, userId } = input;
  const results = new Map<string, ApprovalResult>();
  const refuse = (targetServerId: string, error: unknown) => results.set(targetServerId, { targetServerId, error });
  const jointChannelId = channel.type === "joint" ? await hostJointOf(getDb(), channel) : null;
  const asked: Array<ConnectionParties & { authorizerUserId: string }> = [];
  for (const request of input.requests) {
    const approverUserId = request.approverUserId;
    if (typeof approverUserId !== "string" || approverUserId === userId
      || !isAdminRole((await rolesOn(getDb(), request.targetServerId, [approverUserId])).get(approverUserId))) {
      refuse(request.targetServerId, invalidApprover());
    } else if (jointChannelId && await isConnectedTo(getDb(), jointChannelId, request.targetServerId)) {
      refuse(request.targetServerId, new ExternalConnectError("already_connected", "This server is already connected to the channel. Ask one of its admins to add you."));
    } else {
      asked.push({ targetServerId: request.targetServerId, joinerUserId: userId, authorizerUserId: approverUserId });
    }
  }
  asked.sort((a, b) => a.targetServerId.localeCompare(b.targetServerId));
  if (asked.length > 0) {
    try {
      const created = await withChannelWriterFence(channel.id, async (tx) => {
        // Every users row the requests can name, first (lockJointUsersFirst):
        // the requester (the actor: refused when retired or being deleted) and
        // every approver asked, only locked. The approvers come from the
        // caller, read before any lock; the locks below can only drop one
        // (parties is a subset of asked), so no users row is ever taken after
        // a server row: an approver owning the target server whose account is
        // being deleted (users, then servers FOR UPDATE) closes no cycle.
        await lockJointUsersFirst(tx, { actorUserId: userId, userIds: asked.map((party) => party.authorizerUserId) });
        const [locked] = await tx.select().from(channels).where(eq(channels.id, channel.id)).for("update");
        if (!isInvitableChannelOf(locked, invite.hostServerId)) throw new StaleInviteError();
        if (locked.archivedAt) throw new ExternalConnectError("channel_archived", "This channel is archived.");
        if (await boundGuestsBlockJoint(tx, locked)) throw guestsPresent();
        if (await channelHasConnectingInvite(tx, locked.id, invite.id)) throw connectInProgress();
        const parties: typeof asked = [];
        for (const party of asked) {
          try {
            await lockAndCheckParties(tx, party);
            parties.push(party);
          } catch (err) {
            // A refusal of the people (no database error): this server only.
            if (!(err instanceof JointInviteAccepterError) && !(err instanceof ExternalConnectError)) throw err;
            refuse(party.targetServerId, err instanceof JointInviteAccepterError
              ? (err.code === "authorizer_not_admin" ? invalidApprover() : partyRefusal(err, false))
              : err);
          }
        }
        const current = await lockInviteFrom(tx, invite.id, input.from, parties[0] ?? asked[0]!);
        // Already held (above): re-taken without waiting. The host's server row is new here (KEY SHARE).
        await lockReferencedRows(tx, { serverIds: [current.hostServerId], userIds: [userId, ...parties.map((party) => party.authorizerUserId)] });
        await revalidateUnderLocks(tx, { invite: current, joinerUserId: userId });
        // Read under the invite row lock: one already waiting for a server stays the one.
        const waiting = new Set((await tx.select({ targetServerId: channelServerConnectRequests.targetServerId }).from(channelServerConnectRequests)
          .where(and(eq(channelServerConnectRequests.inviteId, current.id), eq(channelServerConnectRequests.status, "pending"))))
          .map((row) => row.targetServerId));
        const toInsert = parties.filter((party) => {
          if (!waiting.has(party.targetServerId)) return true;
          refuse(party.targetServerId, new ExternalConnectError("approval_in_progress", "A request to connect this server with this invite is waiting for approval."));
          return false;
        });
        if (toInsert.length === 0) return [];
        const rows = await tx.insert(channelServerConnectRequests).values(toInsert.map((party) => ({
          inviteId: current.id,
          channelId: locked.id,
          hostServerId: current.hostServerId,
          targetServerId: party.targetServerId,
          requesterUserId: userId,
          approverUserId: party.authorizerUserId,
          expiresAt: current.expiresAt,
        }))).returning({ id: channelServerConnectRequests.id, targetServerId: channelServerConnectRequests.targetServerId });
        // A connection under way stays the invite's status; it rests on these once done.
        if (current.status !== "connecting") {
          await tx.update(channelExternalInvites).set({ status: "awaiting_approval" }).where(eq(channelExternalInvites.id, current.id));
        }
        return rows;
      });
      for (const row of created) results.set(row.targetServerId, { targetServerId: row.targetServerId, requestId: row.id });
    } catch (err) {
      // The whole request refused (the invite, the channel, the flag): every server not decided yet.
      const refusal = isUniqueViolation(err)
        ? new ExternalConnectError("approval_in_progress", "A request to connect this server with this invite is waiting for approval.")
        : await inviteeRefusal(err, invite.id);
      for (const party of asked) {
        if (!results.has(party.targetServerId)) {
          refuse(party.targetServerId, attributeJointLimit(refusal, { hostServerId: invite.hostServerId, connectingServerId: party.targetServerId }));
        }
      }
    }
  }
  const ordered = input.requests.map((request) => results.get(request.targetServerId)!);
  if (input.notify !== false) for (const result of ordered) if ("requestId" in result) await emailApprover(result.requestId);
  return ordered;
}

export interface ServerConnectRequestView {
  id: string;
  status: Request["status"];
  channelName: string;
  hostServerName: string;
  targetServer: {
    id: string;
    name: string;
    /**
     * Pending only (false otherwise): the approver's server is free and
     * already in an external channel, so approving now would be refused
     * free_external_limit (the connecting server's half of
     * assertCanConnectExternalServer; as the invite page's `atLimit`).
     */
    atLimit: boolean;
    /** At its limit, and the approver may pay for it (manageBilling: an owner). */
    canUpgrade: boolean;
    /** At its limit: its owners (manageBilling), for "An owner of it needs to upgrade"; else empty. */
    owners: ServerBillingOwner[];
  };
  requester: { id: string; name: string };
  expiresAt: Date;
  /** The channel on the approver's server once that server is connected to it (its projection), for "Open #channel"; else null. */
  targetChannelId: string | null;
  /**
   * Pending (not expired) and the approver is still an owner or admin of
   * the server (the role approve re-checks under its locks). Says nothing
   * about the limit: at it, approving still needs the upgrade (`targetServer.atLimit`).
   */
  canApprove: boolean;
}

/** A request, to its named approver only (404 to anyone else). A pending one past its expiry reads as expired. */
/**
 * What an approver's decision learned of its request, for the caller's record
 * of it (external_channel_connect_finished): the servers, once the request is
 * known to be the caller's to decide. Never answered to anyone.
 */
export type ServerConnectRequestObserver = (request: { hostServerId: string; targetServerId: string }) => void;

async function loadRequestForApprover(requestId: string, userId: string, observe?: ServerConnectRequestObserver): Promise<Request> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new ExternalConnectError("request_not_found", "Request not found");
  const [request] = await getDb().select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, requestId));
  if (!request || request.approverUserId !== userId) throw new ExternalConnectError("request_not_found", "Request not found");
  if (!await externalChannelsEnabled(request.hostServerId, userId)) throw new ExternalConnectError("request_not_found", "Request not found");
  // Requests come only from an invitee's link: another release's invite (or a self_connect one, which has none) is not acted on.
  const [invite] = await getDb().select({ origin: channelExternalInvites.origin }).from(channelExternalInvites).where(eq(channelExternalInvites.id, request.inviteId));
  if (!invite || !isTokenUsable(invite.origin)) throw new ExternalConnectError("request_not_found", "Request not found");
  observe?.({ hostServerId: request.hostServerId, targetServerId: request.targetServerId });
  return request;
}

export async function getServerConnectRequest(requestId: string, userId: string): Promise<ServerConnectRequestView> {
  const request = await loadRequestForApprover(requestId, userId);
  const db = getDb();
  const [channel] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, request.channelId));
  const [host] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, request.hostServerId));
  const [target] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, request.targetServerId));
  const [requester] = await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, request.requesterUserId));
  const jointChannelId = await hostJointOf(db, { id: request.channelId, serverId: request.hostServerId });
  const [projection] = jointChannelId
    ? await db.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, jointChannelId), eq(jointChannelServers.serverId, request.targetServerId), eq(jointChannelServers.status, "active")))
    : [];
  const status = request.status === "pending" && request.expiresAt <= new Date() ? "expired" : request.status;
  // The approver's own server, and only while there is something to approve.
  const approverRole = status === "pending" ? (await rolesOn(db, request.targetServerId, [userId])).get(userId) : undefined;
  const atLimit = isMemberRole(approverRole) && (await serversAtExternalLimit(db, [request.targetServerId])).has(request.targetServerId);
  const owners = atLimit ? (await billingOwnersOf(db, [request.targetServerId])).get(request.targetServerId) ?? [] : [];
  return {
    id: request.id,
    status,
    channelName: channel?.name ?? "",
    hostServerName: host?.name ?? "",
    targetServer: {
      id: request.targetServerId,
      name: target?.name ?? "",
      atLimit,
      canUpgrade: atLimit && actorRoleHasServerCapability(approverRole, "manageBilling"),
      owners,
    },
    requester: { id: request.requesterUserId, name: requester?.displayName || requester?.name || "" },
    expiresAt: request.expiresAt,
    targetChannelId: projection?.localChannelId ?? null,
    canApprove: isAdminRole(approverRole),
  };
}

/**
 * Ends a pending request without connecting (`rejected` by the approver, or
 * `cancelled` because a person no longer qualifies): the invite goes back to
 * pending for the invitee to choose again. Invite row, then request row.
 * True when this call ended it.
 */
async function endRequest(tx: DatabaseTransaction, request: Request, status: "rejected" | "cancelled", cancelReason: Request["cancelReason"]): Promise<boolean | "expired"> {
  const [invite] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, request.inviteId)).for("update");
  const [locked] = await tx.select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, request.id)).for("update");
  if (!invite || locked?.status !== "pending") return false;
  // Time after the locks: a request that ran out while this waited is expired, not decided.
  const now = new Date();
  if (locked.expiresAt <= now || invite.expiresAt <= now) {
    await tx.update(channelServerConnectRequests).set({ status: "expired", decidedAt: now }).where(eq(channelServerConnectRequests.id, request.id));
    await restAfterRequest(tx, invite, now);
    return "expired";
  }
  await tx.update(channelServerConnectRequests)
    .set({ status, cancelReason: status === "cancelled" ? cancelReason : null, decidedAt: now })
    .where(eq(channelServerConnectRequests.id, request.id));
  await restAfterRequest(tx, invite, now);
  return true;
}

/**
 * After one of its requests ended (its row written, the invite row locked):
 * an invite that ran out lapses (lapseInvite); one waiting only on requests
 * rests on those left (restingInviteState: still awaiting_approval, accepted
 * once a server was connected with it, or pending to choose again). A
 * connection under way is left to settle it (the worker), expired or not.
 */
async function restAfterRequest(tx: DatabaseTransaction, invite: Invite, now: Date): Promise<void> {
  // The worker ends a reservation (a running conversion cannot be cut short), expired or not.
  if (invite.status !== "pending" && invite.status !== "awaiting_approval") return;
  if (invite.expiresAt <= now) {
    await lapseInvite(tx, invite, now);
    return;
  }
  if (invite.status !== "awaiting_approval") return;
  await tx.update(channelExternalInvites).set(await restingInviteState(tx, invite, now)).where(eq(channelExternalInvites.id, invite.id));
}

/**
 * An approval's first lock, in one statement: every users row its decision
 * and cancel name (lockJointUsersFirst, sorted): the approver, the requester
 * and the invite's sender. All three are fixed on rows that never change
 * them (request.approver_user_id, request.requester_user_id,
 * invite.invited_by_user_id), so the unlocked read is the set. Then, under
 * it, the approver's account: retired or being deleted is
 * AuthorizerUnavailableError, before any write, so no cancel and no email
 * follows (Tenny: refused neutrally, the request kept pending).
 */
async function lockApprovalParties(tx: DatabaseTransaction, request: Request, invite: Pick<Invite, "invitedByUserId">): Promise<void> {
  await lockJointUsersFirst(tx, { userIds: [request.approverUserId, request.requesterUserId, invite.invitedByUserId] });
  if (await jointUserUnavailable(tx, request.approverUserId)) throw new AuthorizerUnavailableError();
}

/** An approval's cancel: under lockApprovalParties (an approver being deleted cancels nothing); the invitee emailed after commit when this ended it. */
async function cancelRequest(request: Request, invite: Pick<Invite, "invitedByUserId">, reason: NonNullable<Request["cancelReason"]>): Promise<void> {
  const ended = await getDb().transaction(async (tx) => {
    await lockApprovalParties(tx, request, invite);
    return endRequest(tx, request, "cancelled", reason);
  });
  if (ended === true) await emailInvitee(request.inviteId, request.targetServerId, "cancelled");
}

/** A request whose invite ran out ends with it; the invite lapses (lapseInvite: accepted when it connected a server, else expired). */
async function expireRequest(request: Request): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [invite] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, request.inviteId)).for("update");
    const now = new Date();
    await tx.update(channelServerConnectRequests).set({ status: "expired", decidedAt: now })
      .where(and(eq(channelServerConnectRequests.id, request.id), eq(channelServerConnectRequests.status, "pending")));
    if (invite && invite.expiresAt <= now) await restAfterRequest(tx, invite, now);
  });
}

/** The pending request and its invite as an approver may act on them now, or the answer they get. */
async function loadActionableRequest(requestId: string, userId: string, observe?: ServerConnectRequestObserver): Promise<{ request: Request; invite: Invite; channel: Channel }> {
  const request = await loadRequestForApprover(requestId, userId, observe);
  if (request.status !== "pending") throw new ExternalConnectError("request_not_pending", "This request has already been decided");
  const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, request.inviteId));
  if (!invite) throw new ExternalConnectError("request_not_found", "Request not found");
  if (request.expiresAt <= new Date() || invite.expiresAt <= new Date()) {
    await expireRequest(request);
    throw new ExternalConnectError("request_expired", "This request has expired");
  }
  // A connection of this invite's other servers may be under way (connecting): this request still waits.
  if (invite.status !== "awaiting_approval" && invite.status !== "connecting") {
    throw new ExternalConnectError("request_not_pending", "This request has already been decided");
  }
  const channel = await getChannel(invite.channelId);
  if (!isInvitableChannelOf(channel, invite.hostServerId)) throw new ExternalConnectError("request_not_found", "Request not found");
  return { request, invite, channel };
}

/**
 * POST /api/server-connect-requests/:id/approve. The approver must still own
 * or administer the server and the requester still belong to it, both checked
 * now (cindyz a8bac9ef: never watched in between) and again under the locks.
 * An approver who lost the role is told so, and the request is cancelled with
 * the invitee emailed to choose again; likewise when the requester left.
 */
export async function approveServerConnectRequest(
  requestId: string,
  userId: string,
  deps: ExternalConnectDeps = {},
  observe?: ServerConnectRequestObserver,
): Promise<ExternalConnectResult> {
  try {
    return await approveAsAvailableApprover(requestId, userId, deps, observe);
  } catch (err) {
    // The approver's own account retired or being deleted (read under their
    // users row, before any cancel): the neutral answer anyone but the named
    // approver gets; the request stays pending (account deletion's cleanup ends it).
    if (err instanceof AuthorizerUnavailableError) throw new ExternalConnectError("request_not_found", "Request not found");
    throw err;
  }
}

async function approveAsAvailableApprover(requestId: string, userId: string, deps: ExternalConnectDeps, observe?: ServerConnectRequestObserver): Promise<ExternalConnectResult> {
  const { request, invite, channel } = await loadActionableRequest(requestId, userId, observe);
  if (channel.archivedAt) throw new ExternalConnectError("channel_archived", "This channel is archived.");
  // One transaction: the users rows first (lockApprovalParties, which refuses
  // a deleting approver before anything is written), then the roles and a
  // lost role's cancel; the email after its commit.
  const lost = await getDb().transaction(async (tx) => {
    await lockApprovalParties(tx, request, invite);
    const roles = await rolesOn(tx, request.targetServerId, [userId, request.requesterUserId]);
    const reason = !isAdminRole(roles.get(userId)) ? "approver_lost_role" as const
      : !isMemberRole(roles.get(request.requesterUserId)) ? "requester_left" as const : null;
    return reason ? { reason, ended: await endRequest(tx, request, "cancelled", reason) } : null;
  });
  if (lost) {
    if (lost.ended === true) await emailInvitee(request.inviteId, request.targetServerId, "cancelled");
    if (lost.reason === "approver_lost_role") throw new ExternalConnectError("approver_lost_role", "You can no longer approve this request");
    throw new ExternalConnectError("requester_left", "The person who asked is no longer a member of this server");
  }
  // The invite's other servers are being connected while the channel is
  // converted: this one connects once the channel is joint.
  if (invite.status === "connecting" && channel.type !== "joint") throw connectInProgress();
  let result: ExternalConnectResult;
  try {
    result = await connectOrReserve({
      invite,
      channel,
      parties: { targetServerId: request.targetServerId, joinerUserId: request.requesterUserId, authorizerUserId: userId },
      from: FROM_APPROVAL,
      requestId: request.id,
      deps,
      outcome: "server",
      refuseUnavailableAuthorizer: true,
    });
  } catch (err) {
    // The approver retired or being deleted (under their users row): answered by approveServerConnectRequest.
    if (err instanceof AuthorizerUnavailableError) throw err;
    if (err instanceof JointInviteAccepterError) {
      await cancelRequest(request, invite, err.code === "authorizer_not_admin" ? "approver_lost_role" : "requester_left");
      throw partyRefusal(err, true);
    }
    // The requester's account retired or being deleted meanwhile (lockJointUsersFirst): as a requester who left.
    if (err instanceof JointActorUnavailableError) {
      await cancelRequest(request, invite, "requester_left");
      throw partyRefusal(new JointInviteAccepterError("joiner_not_member", "The person joining is no longer a member of the target server"), true);
    }
    if (err instanceof StaleInviteError) throw new ExternalConnectError("request_not_pending", "This request has already been decided");
    if (err instanceof InviteLapsedError) {
      await markLapsed(invite.id);
      throw new ExternalConnectError("request_expired", "This request has expired");
    }
    if (err instanceof ExternalChannelsOffError) throw new ExternalConnectError("request_not_found", "Request not found");
    throw attributeJointLimit(err, { hostServerId: invite.hostServerId, connectingServerId: request.targetServerId });
  }
  await emailInvitee(invite.id, request.targetServerId, "approved");
  return result;
}

/** POST /api/server-connect-requests/:id/reject: the invite goes back to pending; the invitee is emailed. */
export async function rejectServerConnectRequest(requestId: string, userId: string, observe?: ServerConnectRequestObserver): Promise<void> {
  const { request } = await loadActionableRequest(requestId, userId, observe);
  const outcome = await getDb().transaction(async (tx) => {
    await lockJointHumanAdmissionSource(tx, request.targetServerId, [userId]);
    const lostRole = !isAdminRole((await rolesOn(tx, request.targetServerId, [userId])).get(userId));
    const ended = await endRequest(tx, request, lostRole ? "cancelled" : "rejected", lostRole ? "approver_lost_role" : null);
    if (ended === "expired") return "expired";
    if (!ended) return "stale";
    return lostRole ? "cancelled" : "rejected";
  });
  if (outcome === "stale") throw new ExternalConnectError("request_not_pending", "This request has already been decided");
  if (outcome === "expired") throw new ExternalConnectError("request_expired", "This request has expired");
  await emailInvitee(request.inviteId, request.targetServerId, outcome);
  if (outcome === "cancelled") throw new ExternalConnectError("approver_lost_role", "You can no longer approve this request");
}

/**
 * POST /api/external-invites/:token/cancel-request: the invitee withdraws
 * their own pending request (`requestId`; without one, every one of theirs
 * this invite waits on, as an older page had only one): cancelled,
 * requester_cancelled, and the invite rests on what is left (restAfterRequest).
 * Nobody is emailed: they did it, and the approver's request page reads it as
 * cancelled. The neutral 404 for an invite they cannot use or a request that
 * is not theirs; 409 when they have none pending. Lock order as endRequest:
 * invite row, then request row.
 */
export async function cancelServerConnectRequestByRequester(token: string, userId: string, requestId?: unknown): Promise<void> {
  const { invite } = await resolveInviteForInvitee(token, userId);
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId))) {
    throw new ExternalConnectError("request_not_pending", "This request has already been decided");
  }
  const pending = await getDb().select().from(channelServerConnectRequests)
    .where(and(
      eq(channelServerConnectRequests.inviteId, invite.id),
      eq(channelServerConnectRequests.status, "pending"),
      ...(typeof requestId === "string" ? [eq(channelServerConnectRequests.id, requestId)] : []),
    ))
    .orderBy(channelServerConnectRequests.id);
  if (pending.length === 0) throw new ExternalConnectError("request_not_pending", "This request has already been decided");
  if (pending.some((request) => request.requesterUserId !== userId)) throw invalidInvite();
  let ended = 0;
  for (const request of pending) {
    const result = await getDb().transaction((tx) => endRequest(tx, request, "cancelled", "requester_cancelled"));
    if (result === "expired") throw invalidInvite();
    if (result) ended += 1;
  }
  if (ended === 0) throw new ExternalConnectError("request_not_pending", "This request has already been decided");
}

// ── The worker: finishing a connection after the conversion ──

/**
 * One pass over invites that are connecting (due now): a conversion rolled
 * back or cancelled returns its invite to pending; a committed one connects
 * the server. Called from the channel conversion worker after its jobs, so a
 * connection whose conversion committed right before a crash completes on the
 * next pass. Idempotent: connecting re-reads the invite under its lock and
 * accepts it in the same commit, so a re-run never connects twice.
 */
export async function runExternalConnectWorkerPass(onConnected?: (connection: ExternalConnection) => Promise<void>): Promise<number> {
  const now = new Date();
  const due = await getDb().select({ id: channelExternalInvites.id }).from(channelExternalInvites)
    .where(and(
      // Both reservation statuses: an older release's worker scans connecting only, so it never sees a self_connect one.
      inArray(channelExternalInvites.status, RESERVATION_STATUSES),
      or(isNull(channelExternalInvites.connectNextAttemptAt), lte(channelExternalInvites.connectNextAttemptAt, now)),
    ))
    .orderBy(sql`${channelExternalInvites.connectNextAttemptAt} ASC NULLS FIRST`, asc(channelExternalInvites.createdAt))
    .limit(8);
  for (const row of due) {
    try {
      // A reservation with queued servers moves on to the next as soon as one connects.
      let connection = await advanceExternalConnect(row.id);
      for (let step = 0; connection && step < MAX_JOINT_CHANNEL_SERVERS; step += 1) {
        await onConnected?.(connection);
        connection = await advanceExternalConnect(row.id);
      }
    } catch (error) {
      console.error("[ExternalConnect] worker step failed", { inviteId: row.id, error });
    }
  }
  return due.length;
}

/** Moves one connecting invite on; the connection when this call made it. */
export async function advanceExternalConnect(inviteId: string): Promise<ExternalConnection | null> {
  const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, inviteId));
  if (!invite || !isReservationStatus(invite.status)) return null;
  // An origin this release does not connect (a newer node's, during a rolling
  // deploy or after a rollback), or a reservation in the other flow's status:
  // never connected, settled or expired here; only its next attempt is put
  // off, so it does not hold up the others.
  const flow = inviteFlow(invite.origin);
  if (flow === null || reservationStatusOf(flow) !== invite.status) {
    console.error("[ExternalConnect] refused a connecting invite of an origin this release does not connect", { inviteId, origin: invite.origin, status: invite.status });
    await scheduleRetry(invite, MAX_RETRY_DELAY_MS, `unknown origin: ${String(invite.origin)}`);
    return null;
  }
  if (invite.expiresAt <= new Date()) {
    if (await settleConnecting(invite, "expired")) recordSettlement(invite, [invite.connectServerId, ...invite.connectQueuedServerIds], { result: "expired" });
    return null;
  }
  if (invite.connectPhase === "conversion") {
    const job = invite.connectConversionJobId ? await getChannelConversionJob(invite.connectConversionJobId) : null;
    const rolledBack = !job || job.status === "canceled"
      || (job.status === "failed" && (job.progress as { rollbackState?: unknown }).rollbackState === "restored");
    if (rolledBack) {
      // The servers queued behind it needed the conversion too: none of them connects.
      if (await settleConnecting(invite, "rolledBack")) {
        // Cancelled: not this attempt's rule (other); failed or gone: an error.
        recordSettlement(invite, [invite.connectServerId, ...invite.connectQueuedServerIds], job?.status === "canceled" ? refusedOutcome("other") : { result: "error" });
        if (flow !== "self_connect") {
          for (const serverId of [invite.connectServerId, ...invite.connectQueuedServerIds]) await emailInvitee(invite.id, serverId, "failed");
        }
      }
    } else if (flow === "self_connect" && job.status === "done") {
      // The conversion committed but its finalize did not move this
      // reservation on: an older release's finalize, which moves `connecting`
      // ones only (design v3 §10 1b). Done here, under the invite row, from
      // what that conversion wrote; never presumed.
      await recoverSelfConnectFinalize(invite);
    } else {
      await scheduleRetry(invite, CONVERSION_POLL_MS, null);
    }
    return null;
  }
  return completeConnection(invite);
}

async function completeConnection(invite: Invite): Promise<ExternalConnection | null> {
  const { connectServerId: targetServerId, connectJoinerUserId: joinerUserId, connectAuthorizerUserId: authorizerUserId } = invite;
  if (!targetServerId || !joinerUserId || !authorizerUserId) {
    if (await settleConnecting(invite, "refused")) {
      recordSettlement(invite, [targetServerId], refusedOutcome("other"));
      if (inviteFlow(invite.origin) !== "self_connect") await emailInvitee(invite.id, targetServerId, "failed");
    }
    return null;
  }
  // Flag off or the channel gone: never connect, and wait (until the invite expires).
  const channel = await getChannel(invite.channelId);
  if (!await externalChannelsEnabled(invite.hostServerId, joinerUserId) || !isInvitableChannelOf(channel, invite.hostServerId) || channel.type !== "joint") {
    await scheduleRetry(invite, MAX_RETRY_DELAY_MS, "external invite or channel not usable");
    return null;
  }
  const parties = { targetServerId, joinerUserId, authorizerUserId, generation: invite.connectGeneration };
  try {
    const connection = inviteFlow(invite.origin) === "self_connect"
      ? await connectSelfJointChannel({ invite, channel, parties, from: "reservation" })
      : await connectJointChannel({
        invite,
        channel,
        parties,
        from: "reservation",
        requestId: null,
        outcome: invite.connectOutcome ?? "server",
      });
    recordSettlement(invite, [targetServerId], { result: "connected" });
    return connection;
  } catch (err) {
    if (err instanceof StaleInviteError) return null;
    if (err instanceof InviteLapsedError) {
      if (await settleConnecting(invite, "expired")) recordSettlement(invite, [targetServerId, ...invite.connectQueuedServerIds], { result: "expired" });
      return null;
    }
    // The flag went off while this waited: nothing was written; a later pass stops or resumes cleanly.
    if (err instanceof ExternalChannelsOffError || err instanceof SelfConnectUnavailableError) {
      await scheduleRetry(invite, MAX_RETRY_DELAY_MS, "external channels off for the host");
      return null;
    }
    if (err instanceof JointInviteAccepterError || err instanceof JointChannelLimitError || err instanceof ExternalChannelLimitError || err instanceof ExternalConnectError
      || err instanceof JointActorUnavailableError) {
      // The people or the limits refuse it: the channel stays joint; the next
      // queued server is tried, or the invite rests (the invitee may choose
      // again; a self_connect operation ends, its actor's Guest seat kept).
      if (await settleConnecting(invite, "refused")) {
        recordSettlement(invite, [targetServerId], workerRefusal(err, invite, targetServerId));
        if (inviteFlow(invite.origin) !== "self_connect") await emailInvitee(invite.id, targetServerId, "failed");
      }
      return null;
    }
    // Anything else is retried: the conversion is never repeated.
    console.error("[ExternalConnect] connection attempt failed; retrying", { inviteId: invite.id, err });
    await scheduleRetry(invite, Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** invite.connectAttempts), err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The path a reservation was started by, as external_channel_connect_finished
 * names it (the invite row keeps no path): its origin's flow, a new server's
 * outcome, and an approval (the authorizer is not the joiner) apart from a
 * direct connect.
 */
function reservationPath(invite: Invite) {
  switch (inviteFlow(invite.origin)) {
    case "host_direct": return "host_direct" as const;
    case "self_connect": return "self_connect" as const;
    default:
      if (invite.connectOutcome === "new_server") return "new_server" as const;
      return invite.connectAuthorizerUserId && invite.connectAuthorizerUserId !== invite.connectJoinerUserId ? "approve" as const : "connect" as const;
  }
}

/**
 * The worker's rows for the servers this settlement finished (the joiner's):
 * `async`, `multi` when servers were queued with it (this reservation still
 * has some, or is itself one moved on from the queue: no conversion job of
 * its own). The row's server (kept only for the joiner's full seat on it):
 * the host for host_direct, none for self_connect (the request's server is
 * not kept), else the connecting server. Nothing when the host's product
 * analytics is off, as every row of an attempt on its channel.
 */
function recordSettlement(invite: Invite, serverIds: ReadonlyArray<string | null>, outcome: ConnectFinishedOutcome): void {
  const path = reservationPath(invite);
  const multi = invite.connectQueuedServerIds.length > 0 || (invite.connectPhase === "connection" && invite.connectConversionJobId === null);
  recordWorkerConnectFinished(invite.connectJoinerUserId, serverIds.map((serverId) => ({
    path,
    outcome,
    async: true,
    multi,
    server: path === "host_direct" ? invite.hostServerId : path === "self_connect" ? null : serverId,
    host: { hostServerId: invite.hostServerId },
  })));
}

/** A refusal the worker settled, by the code its request would have answered (partyRefusal, attributeJointLimit). */
function workerRefusal(err: unknown, invite: Invite, targetServerId: string): ConnectFinishedOutcome {
  const refusal = err instanceof JointInviteAccepterError
    ? partyRefusal(err, reservationPath(invite) === "approve")
    : attributeJointLimit(err, { hostServerId: invite.hostServerId, connectingServerId: targetServerId });
  if (refusal instanceof ExternalConnectError) return refusedOutcome(refusal.code);
  if (refusal instanceof ExternalChannelLimitError || refusal instanceof AttributedJointChannelLimitError) return refusedOutcome(refusal.code, refusal.limitSide);
  return refusedOutcome("other");
}

/**
 * Ends this reservation's current server (only if it is still the one read),
 * under the invite row lock: `refused` moves on to the next queued server (a
 * fresh generation) or rests the invite (restingInviteState); `rolledBack`
 * drops the queue too (no conversion, no connection) and rests it; `expired`
 * (or an invite that ran out meanwhile) lapses it (lapseInvite). True when it did.
 */
async function settleConnecting(invite: Invite, to: "refused" | "rolledBack" | "expired"): Promise<boolean> {
  await settleBarrierForTests?.(invite.id);
  return getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, invite.id)).for("update");
    if (!locked || locked.status !== invite.status || locked.connectPhase !== invite.connectPhase || locked.connectGeneration !== invite.connectGeneration) {
      return false;
    }
    const now = new Date();
    if (to === "expired" || locked.expiresAt <= now) {
      await lapseInvite(tx, locked, now);
      return true;
    }
    const [next, ...rest] = to === "refused" ? locked.connectQueuedServerIds : [];
    const state = next ? nextQueuedServer(next, rest) : await restingInviteState(tx, locked, now, locked.connectOutcome ?? "server");
    await tx.update(channelExternalInvites).set(state).where(eq(channelExternalInvites.id, locked.id));
    return true;
  });
}

async function scheduleRetry(invite: Invite, delayMs: number, error: string | null): Promise<void> {
  await getDb().update(channelExternalInvites)
    .set({
      connectNextAttemptAt: new Date(Date.now() + delayMs),
      ...(error === null ? {} : { connectAttempts: invite.connectAttempts + 1, connectLastError: error.slice(0, 500) }),
    })
    .where(and(
      eq(channelExternalInvites.id, invite.id),
      eq(channelExternalInvites.status, invite.status),
      eq(channelExternalInvites.connectPhase, invite.connectPhase!),
      eq(channelExternalInvites.connectGeneration, invite.connectGeneration!),
    ));
}

let settleBarrierForTests: ((inviteId: string) => Promise<void>) | null = null;
/** Tests only: awaited by the worker right before it settles a reservation (a deterministic pause for stale-worker races). */
export function __setExternalConnectSettleBarrierForTests(barrier: ((inviteId: string) => Promise<void>) | null): void {
  settleBarrierForTests = barrier;
}

// ── Emails (after commit; a failed delivery is logged, never rolled back) ──

async function connectContext(inviteId: string, targetServerId: string | null) {
  const db = getDb();
  const [row] = await db.select({ email: channelExternalInvites.email, channelName: channels.name, hostServerName: servers.name })
    .from(channelExternalInvites)
    .innerJoin(channels, eq(channels.id, channelExternalInvites.channelId))
    .innerJoin(servers, eq(servers.id, channelExternalInvites.hostServerId))
    .where(eq(channelExternalInvites.id, inviteId));
  const [target] = targetServerId ? await db.select({ name: servers.name }).from(servers).where(eq(servers.id, targetServerId)) : [];
  return row ? { ...row, targetServerName: target?.name ?? "your server" } : null;
}

async function emailInvitee(inviteId: string, targetServerId: string | null, outcome: ExternalConnectOutcome): Promise<void> {
  try {
    const context = await connectContext(inviteId, targetServerId);
    if (!context) return;
    await sendExternalConnectResultEmail(context.email, { outcome, ...context });
  } catch (error) {
    console.error("[ExternalConnect] failed to email the invitee:", error);
  }
}

async function emailApprover(requestId: string): Promise<void> {
  try {
    const db = getDb();
    const [request] = await db.select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, requestId));
    if (!request) return;
    const context = await connectContext(request.inviteId, request.targetServerId);
    const [approver] = await db.select({ email: users.email, name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, request.approverUserId));
    const [requester] = await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, request.requesterUserId));
    if (!context || !approver) return;
    await sendServerConnectApprovalEmail(approver.email, {
      approverName: approver.displayName || approver.name,
      requesterName: requester?.displayName || requester?.name || "Someone",
      targetServerName: context.targetServerName,
      channelName: context.channelName,
      hostServerName: context.hostServerName,
      requestId,
      expiresAt: request.expiresAt,
    });
  } catch (error) {
    console.error("[ExternalConnect] failed to email the approver:", error);
  }
}
