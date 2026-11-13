/**
 * A person joining a channel themself: the web's `POST /channels/:id/join`
 * (the forward composer's "Join" too) and a personal assistant forwarding as
 * its owner with `join: true` (RFC 077 forwardAsOwner). `planSelfJoin` runs
 * every rule and writes nothing (an assistant's dry run stops there);
 * `joinChannelAsUser` plans, then joins.
 */
import type { Server as SocketServer } from "socket.io";
import { isSubConversationType } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer } from "../lib/actorPermissions";

export type SelfJoinRefusal = { status: 400 | 403 | 404 | 409; code: string; error: string };

export type SelfJoinPlan =
  | { ok: true; action: "member" | "join" }
  | ({ ok: false } & SelfJoinRefusal);

type JoinableChannel = NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;

export async function planSelfJoin(serverId: string, userId: string, channel: JoinableChannel | null): Promise<SelfJoinPlan> {
  if (!channel || channel.serverId !== serverId) return { ok: false, status: 404, code: "channel_not_found", error: "Channel not found" };
  if (isSubConversationType(channel.type)) {
    return { ok: false, status: 400, code: "thread_membership", error: "Thread membership is managed via follow/unfollow" };
  }
  if (channel.type === "dm") return { ok: false, status: 403, code: "dm_not_joinable", error: "Cannot join DM channels" };
  if (channel.type === "private") return { ok: false, status: 403, code: "private_requires_invitation", error: "Private channels require an invitation" };
  if (channel.type === "joint") return { ok: false, status: 403, code: "joint_requires_invitation", error: "You can't join this channel yourself. Ask someone from your server who's in it to add you." };
  if (channel.archivedAt) return { ok: false, status: 409, code: "channel_archived", error: "This channel is archived" };
  const isGuest = await getActorServerRoleInServer(serverId, "user", userId) === "guest";
  const alreadyMember = (!isGuest && channelService.isEnabledAllChannel(channel))
    || await channelService.isChannelHuman(channel.id, userId);
  if (alreadyMember) return { ok: true, action: "member" };
  // A Guest never joins a channel itself: it is bound to one channel by
  // accepting an external invite (#wg-rbac:#15); guest_joinable is retired (#wg-rbac:#47).
  if (isGuest) return { ok: false, status: 403, code: "guest_join_not_allowed", error: "Guests cannot join channels" };
  if (!(await actorHasServerCapabilityInServer(serverId, "user", userId, "joinPublicChannels"))) {
    return { ok: false, status: 403, code: "join_not_allowed", error: "Server role cannot join public channels" };
  }
  return { ok: true, action: "join" };
}

/** Join as `userId`; `joined` is false when they already were a member. */
export async function joinChannelAsUser(
  io: SocketServer | null | undefined,
  serverId: string,
  userId: string,
  channel: JoinableChannel | null,
): Promise<{ ok: true; joined: boolean } | ({ ok: false } & SelfJoinRefusal)> {
  const plan = await planSelfJoin(serverId, userId, channel);
  if (!plan.ok) return plan;
  if (plan.action === "member") return { ok: true, joined: false };
  await channelService.addHuman(channel!.id, userId);
  io?.to(`server:${serverId}`).emit("channel:members-updated", { channelId: channel!.id });
  return { ok: true, joined: true };
}
