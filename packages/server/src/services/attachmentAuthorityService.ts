import { and, eq, isNull } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { attachmentObjects, attachments, channels, messages } from "../db/schema.js";
import * as channelService from "./channelService.js";

export type AttachmentAuthorityPrincipal =
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "machine"; id: string };

export type BoundAttachmentProjection = typeof attachments.$inferSelect & {
  objectId: string;
  messageId: string;
  pendingChannelId: null;
  revokedAt: null;
};

export type ActiveAttachmentObject = typeof attachmentObjects.$inferSelect & {
  lifecycleState: "active";
};

export type AttachmentAuthorityContext = {
  projection: BoundAttachmentProjection;
  object: ActiveAttachmentObject;
  canonicalMessage: typeof messages.$inferSelect;
  localHostChannel: typeof channels.$inferSelect;
  requestServerId: ServerId;
  principal: AttachmentAuthorityPrincipal;
};

async function resolveLocalHostChannel(
  canonicalChannelId: string,
  requestServerId: ServerId,
): Promise<typeof channels.$inferSelect | null> {
  const jointThreadProjections = await channelService
    .getActiveJointThreadProjectionsByCanonicalThread(canonicalChannelId);
  const jointThreadProjection = jointThreadProjections.find(
    (projection) => projection.localServerId === requestServerId,
  );
  if (jointThreadProjection) {
    const localThread = await channelService.getChannel(jointThreadProjection.localThreadChannelId);
    return localThread?.serverId === requestServerId ? localThread : null;
  }
  if (jointThreadProjections.length > 0) return null;

  const jointChannelProjections = await channelService
    .getActiveJointChannelProjectionsByLocalChannel(canonicalChannelId);
  const jointChannelProjection = jointChannelProjections.find(
    (projection) => projection.serverId === requestServerId,
  );
  if (jointChannelProjection) {
    return jointChannelProjection.channel.serverId === requestServerId
      ? jointChannelProjection.channel
      : null;
  }
  if (jointChannelProjections.length > 0) return null;

  const ordinaryChannel = await channelService.getChannel(canonicalChannelId);
  return ordinaryChannel?.serverId === requestServerId ? ordinaryChannel : null;
}

/**
 * Resolve one public projection ID to the complete message-owned authority
 * context from RFC 049. This is deliberately not wired into production reads
 * during the additive phase: legacy readers stay authoritative until the
 * dual-write/backfill parity gates close.
 */
export async function resolveBoundAttachmentAuthorityContext(input: {
  projectionId: string;
  requestServerId: ServerId;
  principal: AttachmentAuthorityPrincipal;
}): Promise<AttachmentAuthorityContext | null> {
  const db = getDb();
  const [row] = await db
    .select({
      projection: attachments,
      object: attachmentObjects,
      canonicalMessage: messages,
    })
    .from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(
      eq(attachments.id, input.projectionId),
      isNull(attachments.revokedAt),
      eq(attachmentObjects.lifecycleState, "active"),
    ))
    .limit(1);

  if (
    !row
    || !row.projection.objectId
    || !row.projection.messageId
    || row.projection.pendingChannelId !== null
    || row.projection.revokedAt !== null
    || row.object.lifecycleState !== "active"
  ) {
    return null;
  }

  const localHostChannel = await resolveLocalHostChannel(
    row.canonicalMessage.channelId,
    input.requestServerId,
  );
  if (!localHostChannel) return null;

  return {
    projection: row.projection as BoundAttachmentProjection,
    object: row.object as ActiveAttachmentObject,
    canonicalMessage: row.canonicalMessage,
    localHostChannel,
    requestServerId: input.requestServerId,
    principal: input.principal,
  };
}

export async function canReadAttachmentAuthorityContext(
  context: AttachmentAuthorityContext,
): Promise<boolean> {
  if (context.localHostChannel.serverId !== context.requestServerId) return false;

  switch (context.principal.type) {
    case "user":
      return channelService.canUserAccessChannel(
        context.localHostChannel.id,
        context.principal.id,
        context.requestServerId,
      );
    case "agent":
      return channelService.canAgentAccessChannel(
        context.localHostChannel.id,
        context.principal.id,
      );
    case "machine":
      // Machine authentication is already server-scoped by middleware. A
      // machine never acquires human/agent channel membership; it may consume
      // only a host-message face resolved into its authenticated server.
      return true;
  }
}

export async function resolveReadableAttachmentAuthorityContext(input: {
  projectionId: string;
  requestServerId: ServerId;
  principal: AttachmentAuthorityPrincipal;
}): Promise<AttachmentAuthorityContext | null> {
  const context = await resolveBoundAttachmentAuthorityContext(input);
  return context && await canReadAttachmentAuthorityContext(context) ? context : null;
}
