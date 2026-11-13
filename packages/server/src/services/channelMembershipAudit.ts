import type { ServerRole } from "@botiverse/raft-shared";
import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import type { ChannelActorContext } from "../lib/channelActorPermissions";
import { recordIntegrationAuditEvents, serverAuditContextMetadata, type IntegrationAuditSource } from "./integrationAuditService";

/**
 * Why a person's channel membership ended (`channel.member_left` /
 * `channel.member_removed`, metadata `reason`). An enum only: never free text.
 * - `self_leave`: they left (or removed themselves) through a channel route.
 * - `removed_by_admin`: a person holding the server's owner/admin role removed them.
 * - `removed_by_channel_admin`: a person without that role, on channel authority.
 * - `agent_api`: an agent removed them through the agent API.
 * - `server_departure`: they left or were removed from the server.
 * - `guest_unbind`: a Guest left or was removed from its one channel, which
 *   ends its server membership too (channelService.removeHuman).
 * - `guest_converted`: a Guest connected a server of theirs to its joint
 *   channel (jointMemberConnectService): its Guest seat and its entry through
 *   the host's copy end, it stays in the channel through that server.
 */
export const CHANNEL_MEMBERSHIP_END_REASONS = [
  "self_leave",
  "removed_by_admin",
  "removed_by_channel_admin",
  "agent_api",
  "server_departure",
  "guest_unbind",
  "guest_converted",
] as const;
export type ChannelMembershipEndReason = (typeof CHANNEL_MEMBERSHIP_END_REASONS)[number];

export type ChannelMembershipAuditActor = { type: "human" | "agent"; id: string } | { type: "system" };

/** Who ended a channel membership and why, as one audit write records it. */
export interface ChannelMembershipEndAudit {
  reason: ChannelMembershipEndReason;
  actor: ChannelMembershipAuditActor;
  /** The acting person's or agent's server role, as the permission check loaded it. */
  actorRole?: ServerRole | null;
  operationId?: string;
}

/** One channel (or, for a joint channel, one joint) a person lost. */
export interface EndedChannelMembership {
  /** The server whose copy the membership ended through (the event's server). */
  serverId: string;
  channelId: string;
  channelType: string;
  joint?: { jointChannelId: string; hostServerId: string } | null;
}

/**
 * Who ends a person's channel membership through channelService.removeHuman.
 * Always explicit: there is no default.
 * - `{ self: true }`: the person ends their own membership (leave, a DM
 *   participant removing themselves).
 * - a channel actor context: the person or agent the route's permission check
 *   resolved; its capability is re-checked under the removal's locks.
 * - `{ system: true, reason }`: no person or agent acts (a reason that names
 *   none).
 */
export type ChannelRemovalActor =
  | { self: true }
  | ChannelActorContext
  | { system: true; reason: Extract<ChannelMembershipEndReason, "server_departure" | "guest_unbind"> };

/** The channel actor context of a removal, when a person or agent acts on channel authority. */
export function removalActorContext(actor: ChannelRemovalActor): ChannelActorContext | undefined {
  return "actorType" in actor ? actor : undefined;
}

/**
 * The person a removal is attributed to, as a user id (joint disconnect and
 * departure records): the person leaving, or the person removing them. An
 * agent or the system has none.
 */
export function removalActorUserId(targetUserId: string, actor: ChannelRemovalActor): string | undefined {
  if ("self" in actor) return targetUserId;
  if ("system" in actor) return undefined;
  return actor.actorType === "user" ? actor.actorId : undefined;
}

/**
 * The reason and actor of a removeHuman call. A person removing themselves is
 * a leave whichever way they came. A person's server owner/admin role is the
 * inherited authority the route's check grants (channelActorHasCapability);
 * anyone else removed on channel authority.
 */
export function channelRemovalAudit(targetUserId: string, actor: ChannelRemovalActor): ChannelMembershipEndAudit {
  if ("self" in actor) return { reason: "self_leave", actor: { type: "human", id: targetUserId } };
  if ("system" in actor) return { reason: actor.reason, actor: { type: "system" } };
  if (actor.actorType === "agent") return { reason: "agent_api", actor: { type: "agent", id: actor.actorId }, actorRole: actor.serverRole };
  if (actor.actorId === targetUserId) return { reason: "self_leave", actor: { type: "human", id: targetUserId }, actorRole: actor.serverRole };
  const inherited = actor.serverRole === "owner" || actor.serverRole === "admin";
  return {
    reason: inherited ? "removed_by_admin" : "removed_by_channel_admin",
    actor: { type: "human", id: actor.actorId },
    actorRole: actor.serverRole,
  };
}

/** The joint a local copy projects, with its host; null for an ordinary channel. */
export async function jointOfLocalChannel(db: DatabaseExecutor, localChannelId: string): Promise<{ jointChannelId: string; hostServerId: string } | null> {
  const result = await db.execute<{ jointChannelId: string; hostServerId: string }>(sql`
    SELECT p.joint_channel_id AS "jointChannelId", j.created_by_server_id AS "hostServerId"
    FROM joint_channel_servers p
    JOIN joint_channels j ON j.id = p.joint_channel_id
    WHERE p.local_channel_id = ${localChannelId}::uuid`);
  return result.rows[0] ?? null;
}

/** Whether the person is a current member of the joint (joint_channel_members). */
export async function isJointMember(db: DatabaseExecutor, jointChannelId: string, userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM joint_channel_members
    WHERE joint_channel_id = ${jointChannelId}::uuid AND user_id = ${userId}::uuid`);
  return result.rows.length > 0;
}

function auditSource(actor: ChannelMembershipAuditActor): IntegrationAuditSource {
  if (actor.type === "agent") return "api";
  return actor.type === "human" ? "web" : "system";
}

/**
 * One audit event per ended membership, in one INSERT inside the caller's
 * transaction: a failed write fails the removal. Ids and an enum reason only.
 */
export async function recordChannelMembershipsEnded(
  tx: DatabaseExecutor,
  input: ChannelMembershipEndAudit & { targetUserId: string; memberships: readonly EndedChannelMembership[] },
): Promise<void> {
  const { actor, targetUserId } = input;
  const eventType = actor.type === "human" && actor.id === targetUserId ? "channel.member_left" as const : "channel.member_removed" as const;
  const context = serverAuditContextMetadata({ actorRole: input.actorRole ?? null, operationId: input.operationId });
  await recordIntegrationAuditEvents(input.memberships.map((membership) => ({
    serverId: membership.serverId,
    eventType,
    outcome: "success" as const,
    source: auditSource(actor),
    actor: actor.type === "system" ? { type: "system" as const } : { type: actor.type, id: actor.id },
    target: { type: "human", id: targetUserId },
    metadata: {
      reason: input.reason,
      channelId: membership.channelId,
      channelType: membership.channelType,
      ...(membership.joint ? {
        jointChannelId: membership.joint.jointChannelId,
        initiatingServerId: membership.serverId,
        hostServerId: membership.joint.hostServerId,
      } : {}),
      ...context,
    },
  })), tx);
}
