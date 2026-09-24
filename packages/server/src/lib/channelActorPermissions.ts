import {
  canAddChannelMembers,
  getChannelAdminBasis,
  hasEffectiveChannelCapability,
  type ChannelAdminBasis,
  type ChannelActorAdmissionClass,
  type ChannelRole,
  type ServerCapability,
  type ServerRole,
} from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { channelAgents, channelHumans, channels } from "../db/schema.js";
import { resolveActorContext, type ActorContextType } from "./actorPermissions.js";

export interface ChannelActorContext {
  actorType: ActorContextType;
  actorId: string;
  serverId: string;
  channelId: string;
  channelType: string;
  channelName: string;
  channelArchivedAt: Date | null;
  channelDeletedAt: Date | null;
  serverRole: ServerRole | null;
  channelRole: ChannelRole | null;
  channelAuthorityRevision: number | null;
  isChannelMember: boolean;
  canAccessChannel: boolean;
  supportsChannelRoles: boolean;
  admissionClass: ChannelActorAdmissionClass;
  channelAdminBasis: ChannelAdminBasis;
}

export async function resolveChannelActorContext(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ChannelActorContext | null> {
  const db = executor;
  const channel = await db.select({
    id: channels.id,
    serverId: channels.serverId,
    name: channels.name,
    type: channels.type,
    archivedAt: channels.archivedAt,
    deletedAt: channels.deletedAt,
  }).from(channels).where(and(eq(channels.id, channelId), eq(channels.serverId, serverId))).then((rows) => rows[0]);
  const actor = await resolveActorContext(serverId, actorType, actorId, executor);
  if (!channel || !actor.serverRole) return null;

  const membership = actorType === "agent"
    ? await db.select({ role: channelAgents.role, authorityRevision: channelAgents.authorityRevision })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, actorId)))
      .then((rows) => rows[0])
    : await db.select({ role: channelHumans.role, authorityRevision: channelHumans.authorityRevision })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, actorId)))
      .then((rows) => rows[0]);

  const isChannelMember = Boolean(membership);
  const supportsChannelRoles = (channel.type === "channel" || channel.type === "private")
    && channel.name !== "all";
  const canAccessChannel = channel.type === "channel"
    ? true
    : channel.type === "private" || channel.type === "joint"
      ? isChannelMember
      : false;
  const channelRole = membership?.role ?? null;

  return {
    actorType,
    actorId,
    serverId,
    channelId,
    channelType: channel.type,
    channelName: channel.name,
    channelArchivedAt: channel.archivedAt,
    channelDeletedAt: channel.deletedAt,
    serverRole: actor.serverRole,
    channelRole,
    channelAuthorityRevision: membership?.authorityRevision ?? null,
    isChannelMember,
    canAccessChannel,
    supportsChannelRoles,
    admissionClass: actor.serverRole === "guest" ? "guest" : "current_member",
    channelAdminBasis: getChannelAdminBasis({
      serverRole: actor.serverRole,
      channelRole,
      isChannelMember,
      supportsChannelRoles,
    }),
  };
}

export function channelActorHasCapability(
  context: ChannelActorContext,
  capability: ServerCapability,
): boolean {
  if (capability === "addChannelMembers") {
    return canAddChannelMembers({
      serverRole: context.serverRole,
      admissionClass: context.admissionClass,
      isChannelMember: context.isChannelMember,
      channelType: context.channelType,
      channelName: context.channelName,
      archived: context.channelArchivedAt !== null,
      deleted: context.channelDeletedAt !== null,
    });
  }
  return context.canAccessChannel && hasEffectiveChannelCapability({
    serverRole: context.serverRole,
    channelRole: context.channelRole,
    isChannelMember: context.isChannelMember,
    supportsChannelRoles: context.supportsChannelRoles,
    capability,
  });
}

export async function actorHasChannelCapability(
  serverId: string,
  channelId: string,
  actorType: ActorContextType,
  actorId: string,
  capability: ServerCapability,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const context = await resolveChannelActorContext(
    serverId,
    channelId,
    actorType,
    actorId,
    executor,
  );
  return context ? channelActorHasCapability(context, capability) : false;
}

export async function withLockedChannelActorCapability<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capability: ServerCapability;
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext) => Promise<T>,
): Promise<T> {
  return withLockedChannelActorCapabilities({
    ...input,
    capabilities: [input.capability],
  }, callback);
}

export async function withLockedChannelActorCapabilities<T>(
  input: {
    serverId: string;
    channelId: string;
    actorType: ActorContextType;
    actorId: string;
    capabilities: readonly ServerCapability[];
  },
  callback: (executor: DatabaseExecutor, context: ChannelActorContext) => Promise<T>,
): Promise<T> {
  return getDb().transaction(async (tx) => {
    const [lockedChannel] = await tx.select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, input.serverId)))
      .for("update")
      .limit(1);
    if (!lockedChannel) throw new Error("Channel not found");

    const context = await resolveChannelActorContext(
      input.serverId,
      input.channelId,
      input.actorType,
      input.actorId,
      tx,
    );
    if (!context || !input.capabilities.every((capability) => channelActorHasCapability(context, capability))) {
      throw new Error("Channel capability required");
    }
    return callback(tx, context);
  });
}
