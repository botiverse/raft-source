/**
 * A channel member connects a server they own or administer to the channel,
 * with no host approval (#wg-rbac:#37, design "joint-member-connect-impl" v3;
 * cindyz fb29b618, 2d3e18d5, 60f86101, 38086073):
 * POST /api/channels/:id/connect-my-servers.
 *
 * Who: a person (never an agent) currently in the channel: a current member
 * of its joint (not queued for removal, entering through the copy they ask
 * from), or, on the host's private channel, a member of it; a Guest of the
 * host bound to the channel too, whose Guest seat ends once their server is
 * connected (they then enter through it). What: a server they own or
 * administer, as Your servers offers one (listConnectableServers). Where: the
 * host's external_channels_v1 on; otherwise, and for anyone not in the
 * channel, the route answers as an unknown channel.
 * A public channel takes none (channel_not_invitable).
 *
 * The connection itself is externalInviteConnectService's (connectMemberServers,
 * connectSelfJointChannel): this module resolves the request's copy to the
 * host's (`:id` is the caller's own server's copy) and checks the actor
 * before anything starts; the connection checks it all again under its locks.
 */
import { and, eq, sql } from "drizzle-orm";
import { asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channelHumans, channels, jointChannelServers, serverMembers } from "../db/schema";
import { connectMemberServers, type ExternalConnectDeps, type MultiConnectResult } from "./externalInviteConnectService";
import { listConnectableServers, type ConnectableServer } from "./externalInviteService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { isAllSystemChannel } from "./channelService";
import {
  filterJointHumanMemberEntries,
  resolveJointHumanMembershipScopes,
} from "./jointHumanMembershipAccess";
import { countLiveComputersAttachedBy } from "./serverService";

type Channel = typeof channels.$inferSelect;

/** The host side of a member's request: where the operation runs and from which membership. */
export interface MemberConnectEntry {
  /** The host's copy (a joint's host projection) or the host's private channel. */
  hostChannel: Channel;
  /** The joint, when the channel is joint already. */
  jointChannelId: string | null;
  /** Their current joint membership (its generation); null on a private channel. */
  jointGeneration: number | null;
  /** They are a Guest of the host bound to `hostChannel`: the seat ends with their first connected server. */
  guest: boolean;
}

/** A refusal of the whole request after the actor check (the route answers it with refuse()). */
export class MemberConnectRefusal extends Error {
  constructor(readonly status: 400 | 409, readonly code: "channel_not_invitable" | "guest_has_computer", message: string) {
    super(message);
    this.name = "MemberConnectRefusal";
  }
}

/** The host server of a copy: a joint's host, else the channel's own server. Null for a joint copy that is not active. */
export async function memberConnectHostServerId(channel: Pick<Channel, "id" | "serverId" | "type">, executor: DatabaseExecutor = getDb()): Promise<string | null> {
  if (channel.type !== "joint") return channel.serverId;
  const scope = (await resolveJointHumanMembershipScopes({ serverId: asServerId(channel.serverId), localChannelIds: [channel.id] }, executor)).get(channel.id);
  return scope?.hostServerId ?? null;
}

/** external_channels_v1 on for the host: the one gate (#wg-rbac:#55; no flag of its own). */
export async function memberConnectEnabled(hostServerId: string, userId: string): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, serverId: hostServerId, userId })).enabled;
}

/**
 * assertChannelMemberActor: the request's copy `channel` (on the caller's
 * server) as a member may connect a server to it, or null for anyone who is
 * not one (the hidden 404). A joint copy: a current joint member entering
 * through it (filterJointHumanMemberEntries: an identity on this copy's
 * server, not queued for removal, a live source with source exit on; a bound
 * host Guest through the host copy). The host's private channel: a member of
 * it (channel_humans) who is a member of the host or its Guest bound to it. Any
 * other channel type: channel_not_invitable (MemberConnectRefusal) for a
 * public channel or another channel they can see.
 */
export async function resolveMemberConnectEntry(channel: Channel, userId: string, executor: DatabaseExecutor = getDb()): Promise<MemberConnectEntry | null> {
  if (channel.deletedAt) return null;
  if (channel.type === "joint") return resolveJointEntry(channel, userId, executor);
  if (channel.type !== "private" || isAllSystemChannel(channel)) {
    throw new MemberConnectRefusal(400, "channel_not_invitable", "Only private channels and channels shared with other servers can take a server from their members");
  }
  const [row] = await executor
    .select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
    .from(channelHumans)
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, channelHumans.userId)))
    .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, userId)));
  if (!row) return null;
  const guest = row.role === "guest";
  if (guest && row.guestChannelId !== channel.id) return null;
  return { hostChannel: channel, jointChannelId: null, jointGeneration: null, guest };
}

async function resolveJointEntry(channel: Channel, userId: string, executor: DatabaseExecutor): Promise<MemberConnectEntry | null> {
  const scope = (await resolveJointHumanMembershipScopes({ serverId: asServerId(channel.serverId), localChannelIds: [channel.id] }, executor)).get(channel.id);
  if (!scope) return null;
  if (!(await filterJointHumanMemberEntries([scope], userId, executor)).has(channel.id)) return null;
  const [member] = (await executor.execute<{ generation: number }>(
    sqlMemberGeneration(scope.jointId, userId),
  )).rows;
  if (!member) return null;
  const [host] = await executor.select().from(channels)
    .innerJoin(jointChannelServers, eq(jointChannelServers.localChannelId, channels.id))
    .where(and(
      eq(jointChannelServers.jointChannelId, scope.jointId),
      eq(jointChannelServers.serverId, scope.hostServerId),
      eq(jointChannelServers.role, "host"),
      eq(jointChannelServers.status, "active"),
    ));
  if (!host || host.channels.deletedAt) return null;
  const [seat] = await executor.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, scope.hostServerId), eq(serverMembers.userId, userId)));
  return {
    hostChannel: host.channels,
    jointChannelId: scope.jointId,
    jointGeneration: Number(member.generation),
    guest: seat?.role === "guest" && seat.guestChannelId === host.channels.id,
  };
}

function sqlMemberGeneration(jointChannelId: string, userId: string) {
  return sql`SELECT generation FROM joint_channel_members WHERE joint_channel_id = ${jointChannelId}::uuid AND user_id = ${userId}::uuid`;
}

/**
 * The connection, for an actor resolveMemberConnectEntry admitted: a Guest
 * with a Computer attached on the host is told to disconnect it first (an
 * early answer; each connection checks it again under the member row a
 * Computer's attach shares). Each server answered on its own.
 */
/**
 * Connect your servers, on opening: the servers the member could connect to
 * the channel now (they own or administer it, it is not in the channel yet;
 * listConnectableServers, as Your servers offers them), each with its own
 * limit (`atLimit`, `canUpgrade` for an owner, `owners`). Their own servers
 * only; the host's limit is not told.
 */
export async function listMemberConnectableServers(entry: MemberConnectEntry, actorUserId: string): Promise<ConnectableServer[]> {
  return (await listConnectableServers(entry.hostChannel, actorUserId)).filter((server) => server.canConnectDirectly);
}

export async function connectMyServersToChannel(
  entry: MemberConnectEntry,
  actorUserId: string,
  rawServerIds: unknown,
  deps: ExternalConnectDeps = {},
): Promise<MultiConnectResult> {
  if (entry.guest && await countLiveComputersAttachedBy(getDb(), entry.hostChannel.serverId, actorUserId) > 0) {
    throw new MemberConnectRefusal(409, "guest_has_computer", "You have a computer attached to this channel's host server. Disconnect it there first, then connect your server.");
  }
  return connectMemberServers({ hostChannel: entry.hostChannel, actorUserId, jointGeneration: entry.jointGeneration, rawServerIds, deps });
}
