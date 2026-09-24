import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DatabaseExecutor } from "../db/index.js";
import {
  channels,
  jointChannels,
  jointChannelServers,
  messages,
} from "../db/schema.js";

export type ExternalConversationTarget =
  | {
      kind: "ordinary";
      authorityChannelId: string;
      storageChannelId: string;
      bindingChannelId: string;
      level: "top_level" | "thread";
      canonicalRootMessageId: string | null;
      serverId: string;
    }
  | {
      kind: "joint";
      authorityChannelId: string;
      storageChannelId: string;
      bindingChannelId: string;
      level: "top_level" | "thread";
      canonicalRootMessageId: string | null;
      serverId: string;
      jointChannelId: string;
      role: "host" | "participant";
    };

/**
 * Resolves one permission-facing Raft channel into the provider-neutral
 * conversation target used by external bridges.
 *
 * The caller must always present the local projection. A Joint canonical
 * channel is storage-only and never grants bridge authority by itself.
 */
export async function resolveExternalConversationTarget(input: {
  executor: DatabaseExecutor;
  authorityChannelId: string;
  expectedStorageChannelId?: string;
}): Promise<ExternalConversationTarget | null> {
  const [local] = await input.executor.select().from(channels)
    .where(eq(channels.id, input.authorityChannelId)).limit(1);
  if (!local || local.deletedAt || local.archivedAt) return null;

  const canonicalChannel = alias(channels, "external_conversation_canonical_channel");
  const [projection] = await input.executor.select({
    jointChannelId: jointChannelServers.jointChannelId,
    serverId: jointChannelServers.serverId,
    role: jointChannelServers.role,
    storageChannelId: jointChannels.canonicalChannelId,
    jointStatus: jointChannels.status,
    storageType: canonicalChannel.type,
    storageParentMessageId: canonicalChannel.parentMessageId,
    storageDeletedAt: canonicalChannel.deletedAt,
    storageArchivedAt: canonicalChannel.archivedAt,
  }).from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(canonicalChannel, eq(canonicalChannel.id, jointChannels.canonicalChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, local.id),
      eq(jointChannelServers.serverId, local.serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    )).limit(2);

  if (!projection) {
    if (local.type === "joint") return null;
    const [storageOnly] = await input.executor.select({ id: jointChannels.id })
      .from(jointChannels).where(and(
        eq(jointChannels.canonicalChannelId, local.id),
        eq(jointChannels.status, "active"),
      )).limit(1);
    if (storageOnly) return null;
    if (input.expectedStorageChannelId && input.expectedStorageChannelId !== local.id) return null;
    if (local.type !== "channel" && local.type !== "private" && local.type !== "thread") return null;
    if (local.type !== "thread") {
      return {
        kind: "ordinary",
        authorityChannelId: local.id,
        storageChannelId: local.id,
        bindingChannelId: local.id,
        level: "top_level",
        canonicalRootMessageId: null,
        serverId: local.serverId,
      };
    }
    if (!local.parentMessageId) return null;
    const [root] = await input.executor.select({
      id: messages.id,
      channelId: messages.channelId,
      threadId: messages.threadId,
    }).from(messages).where(eq(messages.id, local.parentMessageId)).limit(2);
    if (!root || root.threadId !== local.id) return null;
    if (input.expectedStorageChannelId && input.expectedStorageChannelId !== local.id) return null;
    return {
      kind: "ordinary",
      authorityChannelId: local.id,
      storageChannelId: local.id,
      bindingChannelId: root.channelId,
      level: "thread",
      canonicalRootMessageId: root.id,
      serverId: local.serverId,
    };
  }

  if (
    projection.jointStatus !== "active"
    || projection.storageDeletedAt
    || projection.storageArchivedAt
    || (input.expectedStorageChannelId
      && input.expectedStorageChannelId !== projection.storageChannelId)
  ) return null;

  if (projection.storageType !== "thread") {
    if (local.type !== "joint" || projection.storageType !== "channel") return null;
    return {
      kind: "joint",
      authorityChannelId: local.id,
      storageChannelId: projection.storageChannelId,
      bindingChannelId: local.id,
      level: "top_level",
      canonicalRootMessageId: null,
      serverId: projection.serverId,
      jointChannelId: projection.jointChannelId,
      role: projection.role,
    };
  }

  if (local.type !== "thread" || !projection.storageParentMessageId) return null;
  const [root] = await input.executor.select({
    id: messages.id,
    channelId: messages.channelId,
    threadId: messages.threadId,
  }).from(messages).where(eq(messages.id, projection.storageParentMessageId)).limit(2);
  if (!root || root.threadId !== projection.storageChannelId) return null;

  const [parentProjection] = await input.executor.select({
    localChannelId: jointChannelServers.localChannelId,
    role: jointChannelServers.role,
  }).from(jointChannels)
    .innerJoin(jointChannelServers, eq(jointChannelServers.jointChannelId, jointChannels.id))
    .where(and(
      eq(jointChannels.canonicalChannelId, root.channelId),
      eq(jointChannels.status, "active"),
      eq(jointChannelServers.serverId, projection.serverId),
      eq(jointChannelServers.status, "active"),
    )).limit(2);
  if (!parentProjection || parentProjection.role !== projection.role) return null;

  return {
    kind: "joint",
    authorityChannelId: local.id,
    storageChannelId: projection.storageChannelId,
    bindingChannelId: parentProjection.localChannelId,
    level: "thread",
    canonicalRootMessageId: root.id,
    serverId: projection.serverId,
    jointChannelId: projection.jointChannelId,
    role: projection.role,
  };
}
