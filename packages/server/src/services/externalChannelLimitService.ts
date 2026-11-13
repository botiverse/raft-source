/**
 * Limits on a channel's outside parties (#wg-rbac:#16, P2a-2), checked when a
 * Guest is admitted through an external invite:
 *
 * - Slots: a channel holds at most EXTERNAL_CHANNEL_MAX_SLOTS outside parties,
 *   the host counting as one, each bound Guest as one and, for a joint
 *   channel, each other server active in it as one (P3: one counter for
 *   servers and Guests, also the joint server cap's, checkJointAdmission).
 * - Free plan: a free host Server is in at most one external channel. Only a
 *   channel turning external is refused (its first Guest); one that already
 *   is keeps admitting, and channels over the limit from before (a downgrade)
 *   are left alone.
 *
 * A channel is external while it has a bound Guest or is an active joint
 * channel another Server has joined, and is not archived or deleted
 * (externalChannelsOfServerSql, shared with the free plan's freeze in
 * externalChannelFreezeService). Open invites do not make a channel
 * external: otherwise two invites to a new channel would let its first
 * acceptor past the free-plan rule.
 *
 * Connecting a server with an external invite (P2a-3) applies the same rule
 * to the host and to the connecting server (assertCanConnectExternalServer):
 * for the host only when the channel is not external yet; for the connecting
 * server always, the channel being new to it.
 *
 * An ordinary joint invite accept into a joint whose host has
 * external_channels_v1 on applies the connecting server's half too
 * (assertJointParticipantCanConnect); the host's side of such a joint stays
 * the joint hosting limit (jointChannelLimitService).
 *
 * Callers hold the SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE lock of every
 * server they check, taken first (ADMISSION_LOCK_ORDER in planService), which
 * serializes these counts across Guest accepts, external connects and joint
 * invite accepts.
 */
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import { and, count, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { channelExternalInvites, channels, jointChannelServers, serverMembers, servers } from "../db/schema";
import { externalChannelsFlagOnFor, externalChannelsOfServerSql } from "./externalChannelFreezeState";
import {
  freeServerIds,
  jointHostServerId,
  jointHostUsesExternalChannelRules,
  HOST_LIMIT_OUTSIDER_MESSAGE,
  JointChannelLimitError,
  type JointChannelLimitErrorCode,
} from "./jointChannelLimitService";

/** One cap for a channel's outside parties, Guests and joint servers alike. */
export const EXTERNAL_CHANNEL_MAX_SLOTS = MAX_JOINT_CHANNEL_SERVERS;

export type ExternalChannelLimitCode = "channel_full" | "free_external_limit";

type ExternalInviteStatus = typeof channelExternalInvites.$inferSelect.status;
/**
 * Statuses of an external invite that is still open (holding its slot until
 * it is accepted or ends), as the open-address unique index lists them:
 * self_connecting (a self_connect operation's reservation) is open like
 * connecting. Counting (countOpenInvites, hasOtherInvitedChannel) takes
 * every row in them whatever its origin: an unknown origin's row still holds
 * its slot, so it only ever refuses more.
 */
export const OPEN_EXTERNAL_INVITE_STATUSES: readonly ExternalInviteStatus[] = ["pending", "awaiting_approval", "connecting", "self_connecting"];

/** A reservation under way (a server being connected after the channel's conversion): connecting, or a self_connect operation's self_connecting. */
export const RESERVATION_STATUSES: readonly ExternalInviteStatus[] = ["connecting", "self_connecting"];

export function isReservationStatus(status: ExternalInviteStatus): boolean {
  return status === "connecting" || status === "self_connecting";
}

/**
 * Whose limit refused an external invite's Guest accept or connection: the
 * host's (the channel's server), or the connecting server's. Only the
 * connecting server's limit is the invitee's (or approver's) to lift.
 */
export type ExternalLimitSide = "host" | "connecting";

/** Whose limit refused, as the invitee's and approver's 409 bodies name it. */
export interface ExternalLimitAttribution {
  limitSide: ExternalLimitSide;
  /** That server; null for a connecting server not created yet (connect-new-server's preflight). */
  limitServerId: string | null;
}

export class ExternalChannelLimitError extends Error implements ExternalLimitAttribution {
  constructor(
    readonly code: ExternalChannelLimitCode,
    message: string,
    readonly limitSide: ExternalLimitSide,
    readonly limitServerId: string,
  ) {
    super(message);
    this.name = "ExternalChannelLimitError";
  }
}

/** A joint limit's refusal of an external invite's connection, naming whose limit it is (attributeJointLimit). */
export class AttributedJointChannelLimitError extends JointChannelLimitError implements ExternalLimitAttribution {
  constructor(source: JointChannelLimitError, readonly limitSide: ExternalLimitSide, readonly limitServerId: string | null) {
    super(source.message, source.code, source.details);
  }
}

/**
 * Names whose limit a joint limit's refusal of an external connection is (any
 * other error is returned as is; ExternalChannelLimitError names it where it
 * is thrown). A joint's free-server cap refuses only a free server being
 * added: the connecting one (upgrading it lifts the refusal). Its hosting
 * limits and its total server cap are the host channel's.
 */
export function attributeJointLimit(err: unknown, servers: { hostServerId: string; connectingServerId: string | null }): unknown {
  if (!(err instanceof JointChannelLimitError) || err instanceof AttributedJointChannelLimitError) return err;
  const code: JointChannelLimitErrorCode = err.code;
  return code === "joint_free_server_limit"
    ? new AttributedJointChannelLimitError(err, "connecting", servers.connectingServerId)
    : new AttributedJointChannelLimitError(err, "host", servers.hostServerId);
}

async function countBoundGuests(executor: DatabaseExecutor, serverId: string, channelId: string): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.role, "guest"),
      eq(serverMembers.guestChannelId, channelId),
    ));
  return row?.n ?? 0;
}

/**
 * Whether the server has an external channel other than `exceptChannelId`
 * (the module comment; the one definition is externalChannelsOfServerSql,
 * which the free plan's freeze counts too).
 */
export async function hasOtherExternalChannel(
  executor: DatabaseExecutor,
  serverId: string,
  exceptChannelId: string,
): Promise<boolean> {
  const result = await executor.execute<{ external: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM (${externalChannelsOfServerSql(serverId)}) external_channels
      WHERE channel_id <> ${exceptChannelId}::uuid
    ) AS external
  `);
  return result.rows[0]?.external === true;
}

/**
 * Refuses admitting one more Guest to `channelId` of `serverId` when it would
 * break a limit. Reads the database only; refresh the host's subscription
 * before the transaction.
 */
export async function assertCanAdmitExternalGuest(
  executor: DatabaseExecutor,
  input: { serverId: string; channelId: string; now: Date },
): Promise<void> {
  const [channel] = await executor.select({ type: channels.type }).from(channels).where(eq(channels.id, input.channelId));
  // The channel's parties now (the host, its Guests and, for a joint, every
  // other server active in it: P3 one counter), plus the new Guest.
  const parties = await countChannelParties(executor, { id: input.channelId, serverId: input.serverId, type: channel?.type ?? "private" });
  if (parties + 1 > EXTERNAL_CHANNEL_MAX_SLOTS) {
    throw new ExternalChannelLimitError("channel_full", "This channel has no room for more people outside the server.", "host", input.serverId);
  }
  // Already external (a Guest, or another server in the joint): it keeps admitting.
  if (parties > 1) return;
  const free = await freeServerIds(executor, [input.serverId], input.now);
  if (!free.has(input.serverId)) return;
  if (await hasOtherExternalChannel(executor, input.serverId, input.channelId)) {
    // Shown to the invitee: the host's plan is not theirs to know.
    throw new ExternalChannelLimitError("free_external_limit", "This server can't add people from outside to another channel right now. Ask the person who invited you.", "host", input.serverId);
  }
}

/** A bound Guest, or an active joint channel another server has joined (see the module comment). */
async function isExternalChannel(executor: DatabaseExecutor, serverId: string, channelId: string): Promise<boolean> {
  const result = await executor.execute<{ external: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM (${externalChannelsOfServerSql(serverId)}) external_channels
      WHERE channel_id = ${channelId}::uuid
    ) AS external
  `);
  return result.rows[0]?.external === true;
}

export const NO_CHANNEL = "00000000-0000-0000-0000-000000000000";

/**
 * Refuses connecting `targetServerId` to the host's `hostChannelId` with an
 * external invite when it would make a new external channel for a free
 * server that already has one: the host (unless this channel is already
 * external: adding servers to it stays allowed) or the connecting server
 * (always new to it). Reads the database only; refresh both subscriptions
 * before the transaction, and hold both servers' admission locks.
 */
export async function assertCanConnectExternalServer(
  executor: DatabaseExecutor,
  input: { hostServerId: string; hostChannelId: string; targetServerId: string; now: Date },
): Promise<void> {
  const free = await freeServerIds(executor, [input.hostServerId, input.targetServerId], input.now);
  await assertHostRule(executor, input, free);
  await assertConnectingRule(executor, input.targetServerId, NO_CHANNEL, free);
}

/** The connecting server's half: a free server already in an external channel (other than `exceptChannelId`) connects to no other. */
async function assertConnectingRule(executor: DatabaseExecutor, targetServerId: string, exceptChannelId: string, free: ReadonlySet<string>): Promise<void> {
  if (free.has(targetServerId) && await hasOtherExternalChannel(executor, targetServerId, exceptChannelId)) {
    throw new ExternalChannelLimitError("free_external_limit", "This server is already in a channel shared with another server or guests. Upgrade it to connect it to more.", "connecting", targetServerId);
  }
}

/**
 * The connecting server's half of the rule for an ordinary joint invite
 * accept: `targetServerId` is about to get a new active projection on the
 * top-level joint `parentJointId` (not a re-accept into a projection it
 * already has). Applies only when the joint's host has external_channels_v1
 * on; flag off keeps the joint free-server cap instead. `priorLocalChannelId`
 * is the server's earlier (disconnected) projection of this joint, if any:
 * not another channel. Reads the database only; the caller holds the
 * target's admission lock (taken first) and has refreshed its subscription.
 */
export async function assertJointParticipantCanConnect(
  executor: DatabaseExecutor,
  input: { parentJointId: string; targetServerId: string; priorLocalChannelId?: string | null; now: Date },
): Promise<void> {
  const free = await freeServerIds(executor, [input.targetServerId], input.now);
  if (!free.has(input.targetServerId)) return;
  const hostServerId = await jointHostServerId(executor, input.parentJointId);
  if (!hostServerId || !await jointHostUsesExternalChannelRules(executor, hostServerId, { pin: true })) return;
  await assertConnectingRule(executor, input.targetServerId, input.priorLocalChannelId ?? NO_CHANNEL, free);
}

/**
 * The host's half of assertCanConnectExternalServer, for a check before the
 * connecting server exists (an invitee creating one to connect: a new server
 * is in no external channel, so only the host can refuse). A lock-free early
 * answer; the connect itself is the authoritative check.
 */
export async function assertHostCanConnectExternalServer(
  executor: DatabaseExecutor,
  input: { hostServerId: string; hostChannelId: string; now: Date },
): Promise<void> {
  await assertHostRule(executor, input, await freeServerIds(executor, [input.hostServerId], input.now));
}

async function assertHostRule(executor: DatabaseExecutor, input: { hostServerId: string; hostChannelId: string }, free: ReadonlySet<string>): Promise<void> {
  if (free.has(input.hostServerId)
    && !await isExternalChannel(executor, input.hostServerId, input.hostChannelId)
    && await hasOtherExternalChannel(executor, input.hostServerId, input.hostChannelId)) {
    throw new ExternalChannelLimitError("free_external_limit", HOST_LIMIT_OUTSIDER_MESSAGE, "host", input.hostServerId);
  }
}

/**
 * Unarchiving a channel makes it external again when it has a bound Guest or
 * is a joint another server is active in, so it is held to the same rule as
 * an admission (an unarchive must not get a free server past one external
 * channel and into the freeze). Refuses with free_external_limit when a free
 * server whose count would grow already has another external channel: the
 * channel's server for a Guest channel (its flag), every free server active
 * in the joint for a joint (the host's flag). Archived channels do not count,
 * so the channel itself is not among the others. Reads the database only;
 * the caller holds the admission locks of those servers (taken first,
 * ADMISSION_LOCK_ORDER) and the joint's lifecycle lock.
 */
export async function assertCanUnarchiveExternalChannel(
  executor: DatabaseExecutor,
  input: { channel: { id: string; serverId: string; type: string }; projections: ReadonlyArray<{ serverId: string; localChannelId: string; jointChannelId: string }>; now: Date },
): Promise<void> {
  const { channel } = input;
  if (channel.type !== "joint") {
    if (await countBoundGuests(executor, channel.serverId, channel.id) === 0) return;
    if (!(await externalChannelsFlagOnFor(executor, [channel.serverId])).has(channel.serverId)) return;
    const free = await freeServerIds(executor, [channel.serverId], input.now);
    if (free.has(channel.serverId) && await hasOtherExternalChannel(executor, channel.serverId, channel.id)) {
      throw new ExternalChannelLimitError("free_external_limit", UNARCHIVE_OWN_LIMIT_MESSAGE, "host", channel.serverId);
    }
    return;
  }
  const active = await activeServerIds(executor, input.projections.map((projection) => projection.serverId));
  if (active.size < 2) return;
  const jointChannelId = input.projections[0]?.jointChannelId;
  const hostServerId = jointChannelId ? await jointHostServerId(executor, jointChannelId) : null;
  if (!hostServerId || !await jointHostUsesExternalChannelRules(executor, hostServerId)) return;
  const free = await freeServerIds(executor, [...active], input.now);
  // The unarchiving server first, so its own limit is the one named when both refuse.
  const ordered = [...input.projections].sort((a, b) => Number(b.serverId === channel.serverId) - Number(a.serverId === channel.serverId) || a.serverId.localeCompare(b.serverId));
  for (const projection of ordered) {
    if (!active.has(projection.serverId) || !free.has(projection.serverId)) continue;
    if (!await hasOtherExternalChannel(executor, projection.serverId, projection.localChannelId)) continue;
    throw new ExternalChannelLimitError(
      "free_external_limit",
      // Another organisation's server: its plan is not the unarchiving side's to know (#wg-rbac:#61).
      projection.serverId === channel.serverId ? UNARCHIVE_OWN_LIMIT_MESSAGE : UNARCHIVE_OTHER_SERVER_LIMIT_MESSAGE,
      projection.serverId === hostServerId ? "host" : "connecting",
      projection.serverId,
    );
  }
}

const UNARCHIVE_OTHER_SERVER_LIMIT_MESSAGE = "This channel can't be unarchived right now: one of the servers connected to it can't be in another shared channel. Ask that server's admins, or disconnect it from this channel first.";

const UNARCHIVE_OWN_LIMIT_MESSAGE = "This server is on the Free plan and already shares a channel with people outside it. Upgrade it, or leave or disconnect that channel, to unarchive this one.";

/** The non-deleted servers among these. */
async function activeServerIds(executor: DatabaseExecutor, serverIds: readonly string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const rows = await executor.select({ id: servers.id }).from(servers).where(and(inArray(servers.id, [...new Set(serverIds)]), isNull(servers.deletedAt)));
  return new Set(rows.map((row) => row.id));
}

// ── At send time (plan §5: "pending invites count at send time, final check at accept") ──
// Sending an external invite is checked against the same two limits, with the
// channel's open invites counted as if accepted. These are early answers for
// the host's owner/admin; accepting (assertCanAdmitExternalGuest,
// assertCanConnectExternalServer) stays the authoritative check.

/**
 * The channel's outside parties now (the module comment): the host, the
 * Guests bound to it and, for a joint, every other server active in it.
 */
export async function countChannelParties(
  executor: DatabaseExecutor,
  channel: { id: string; serverId: string; type: string },
): Promise<number> {
  const guests = await countBoundGuests(executor, channel.serverId, channel.id);
  if (channel.type !== "joint") return guests + 1;
  const [row] = await executor
    .select({ n: count() })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.status, "active"),
      sql`${jointChannelServers.jointChannelId} IN (
        SELECT ${jointChannelServers.jointChannelId} FROM ${jointChannelServers}
        WHERE ${jointChannelServers.localChannelId} = ${channel.id} AND ${jointChannelServers.serverId} = ${channel.serverId}
      )`,
    ));
  return guests + Math.max(1, row?.n ?? 0);
}

/** The channel's open, unexpired external invites. */
async function countOpenInvites(executor: DatabaseExecutor, channelId: string, now: Date): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(channelExternalInvites)
    .where(and(
      eq(channelExternalInvites.channelId, channelId),
      inArray(channelExternalInvites.status, OPEN_EXTERNAL_INVITE_STATUSES),
      gt(channelExternalInvites.expiresAt, now),
    ));
  return row?.n ?? 0;
}

/** Whether a live channel of the server other than `exceptChannelId` holds an open, unexpired external invite. */
async function hasOtherInvitedChannel(executor: DatabaseExecutor, serverId: string, exceptChannelId: string, now: Date): Promise<boolean> {
  const [row] = await executor
    .select({ id: channelExternalInvites.id })
    .from(channelExternalInvites)
    .innerJoin(channels, eq(channels.id, channelExternalInvites.channelId))
    .where(and(
      eq(channelExternalInvites.hostServerId, serverId),
      eq(channels.serverId, serverId),
      ne(channelExternalInvites.channelId, exceptChannelId),
      inArray(channelExternalInvites.status, OPEN_EXTERNAL_INVITE_STATUSES),
      gt(channelExternalInvites.expiresAt, now),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return !!row;
}

/**
 * Whether the free plan's one external channel keeps `serverId` from
 * inviting people outside it to `channelId` (NO_CHANNEL: a channel not
 * created yet). Only a free server, and only for a channel that is not
 * external yet (one that already is keeps inviting, as it keeps admitting),
 * when another of its channels is external or has an open invite: an invite
 * sent counts as the channel it would make external.
 */
export async function externalInviteFreeLimitReached(
  executor: DatabaseExecutor,
  input: { serverId: string; channelId: string; now: Date },
): Promise<boolean> {
  const free = await freeServerIds(executor, [input.serverId], input.now);
  if (!free.has(input.serverId)) return false;
  if (input.channelId !== NO_CHANNEL && await isExternalChannel(executor, input.serverId, input.channelId)) return false;
  return await hasOtherExternalChannel(executor, input.serverId, input.channelId)
    || await hasOtherInvitedChannel(executor, input.serverId, input.channelId, input.now);
}

/**
 * How many more people the channel can be sent external invites for: its
 * EXTERNAL_CHANNEL_MAX_SLOTS less its parties now (countChannelParties) and
 * its open invites, each of which would take a slot once accepted. Never
 * below 0 (a channel over the cap from before stays as it is). `ownInvites`
 * open invites are the asker's to fill (the invitee's own invite), so they
 * are given back before the floor, not after it.
 */
export async function externalInviteSlotsLeft(
  executor: DatabaseExecutor,
  channel: { id: string; serverId: string; type: string },
  now: Date,
  ownInvites = 0,
): Promise<number> {
  const taken = await countChannelParties(executor, channel) + await countOpenInvites(executor, channel.id, now) - ownInvites;
  return Math.max(0, EXTERNAL_CHANNEL_MAX_SLOTS - taken);
}

/**
 * Refuses sending `adding` external invites to the channel when the free
 * plan's one external channel or the slots would be passed; answers the
 * slots left before them. The host's owner/admin is told: the free-plan
 * refusal says so, for the upgrade it offers.
 */
export async function assertCanSendExternalInvites(
  executor: DatabaseExecutor,
  input: { channel: { id: string; serverId: string; type: string }; adding: number; now: Date },
): Promise<number> {
  const { channel } = input;
  if (input.adding > 0 && await externalInviteFreeLimitReached(executor, { serverId: channel.serverId, channelId: channel.id, now: input.now })) {
    throw new ExternalChannelLimitError("free_external_limit", FREE_SEND_LIMIT_MESSAGE, "host", channel.serverId);
  }
  const slotsLeft = await externalInviteSlotsLeft(executor, channel, input.now);
  if (input.adding > slotsLeft) {
    throw new ExternalChannelLimitError("channel_full", `This channel has room for ${slotsLeft} more people outside the server.`, "host", channel.serverId);
  }
  return slotsLeft;
}

export const FREE_SEND_LIMIT_MESSAGE = "On the Free plan, a server can share one channel with people outside it, and this server already does or has invited people to one. Upgrade to invite people to another channel.";
