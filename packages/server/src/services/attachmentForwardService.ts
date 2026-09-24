import { randomUUID, createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  userChannelInboxStates,
} from "../db/schema.js";
import { buildSearchText } from "./searchService.js";

type InternalForwardAttachmentSnapshot = {
  sourceProjectionId: string;
  filename: string;
  mimeType?: string | null;
};

type InternalForwardItem = Record<string, unknown> & {
  sourceHostMessageId: string;
  attachmentSnapshots?: InternalForwardAttachmentSnapshot[];
};

export type InternalForwardBundleMetadata = Record<string, unknown> & {
  kind: "forwarded-bundle";
  forwardedItems: InternalForwardItem[];
  sourceAuthorityChannelIds: string[];
};

export class ForwardPersistenceError extends Error {
  constructor(readonly code: "authority_changed" | "source_attachment_changed" | "idempotency_conflict") {
    super(code === "authority_changed"
      ? "Source or destination access changed before the forward committed"
      : code === "source_attachment_changed"
        ? "One or more source messages or attachments changed before the forward committed"
        : "This forward request id was already used for different content");
    this.name = "ForwardPersistenceError";
  }
}

function fingerprintForward(input: {
  destinationChannelId: string;
  sourceMessageIds: string[];
  content: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function metadataFingerprint(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const fingerprint = (value as { forwardRequestFingerprint?: unknown }).forwardRequestFingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

/**
 * Phase E forward persistence boundary.
 *
 * The destination message, its destination-owned projections, and the user
 * random-id idempotency record commit in one transaction. Source projections
 * and immutable objects are locked and revalidated immediately before the
 * destination rows are inserted; a revoked, rebound, missing, or non-active
 * source fails the whole transaction. Projection-only forwarding never writes
 * an attachment_object_charge row.
 */
export async function persistForwardBundle(input: {
  destinationStorageChannelId: string;
  destinationRequestChannelId: string;
  senderId: string;
  content: string;
  randomId: string;
  sourceMessageIds: string[];
  requestServerId: string;
  metadata: InternalForwardBundleMetadata;
}): Promise<{ message: typeof messages.$inferSelect; replayed: boolean }> {
  const fingerprint = fingerprintForward({
    destinationChannelId: input.destinationRequestChannelId,
    sourceMessageIds: input.sourceMessageIds,
    content: input.content,
  });

  return getDb().transaction(async (tx) => {
    const [existing] = await tx.select().from(messages).where(and(
      eq(messages.senderType, "user"),
      eq(messages.senderId, input.senderId),
      eq(messages.randomId, input.randomId),
    )).limit(1).for("update");
    if (existing) {
      if (
        existing.channelId !== input.destinationStorageChannelId
        || existing.content !== input.content
        || metadataFingerprint(existing.actionMetadata) !== fingerprint
      ) {
        throw new ForwardPersistenceError("idempotency_conflict");
      }
      return { message: existing, replayed: true };
    }

    const authorityChannelIds = [...new Set([
      ...input.metadata.sourceAuthorityChannelIds,
      input.destinationRequestChannelId,
    ])];
    const authorityChannels = await tx.select().from(channels)
      .where(inArray(channels.id, authorityChannelIds))
      .for("update");
    const channelById = new Map(authorityChannels.map((channel) => [channel.id, channel]));
    const jointAuthorityChannelIds = authorityChannels
      .filter((channel) => channel.type === "joint")
      .map((channel) => channel.id);
    const activeJointRows = jointAuthorityChannelIds.length === 0 ? [] : await tx
      .select({
        localChannelId: jointChannelServers.localChannelId,
        canonicalChannelId: jointChannels.canonicalChannelId,
      })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(and(
        inArray(jointChannelServers.localChannelId, jointAuthorityChannelIds),
        eq(jointChannelServers.serverId, input.requestServerId),
        eq(jointChannelServers.status, "active"),
        eq(jointChannels.status, "active"),
      ))
      .for("update");
    const activeJointByLocalId = new Map(activeJointRows.map((row) => [row.localChannelId, row]));
    const serverMember = await tx.select({ userId: serverMembers.userId }).from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, input.requestServerId),
        eq(serverMembers.userId, input.senderId),
      )).limit(1).for("update");
    if (serverMember.length !== 1) {
      throw new ForwardPersistenceError("authority_changed");
    }
    const memberships = await tx.select().from(channelHumans).where(and(
      eq(channelHumans.userId, input.senderId),
      inArray(channelHumans.channelId, authorityChannelIds),
    )).for("update");
    const joinedChannelIds = new Set(memberships.map((membership) => membership.channelId));
    for (const sourceChannelId of input.metadata.sourceAuthorityChannelIds) {
      const channel = channelById.get(sourceChannelId);
      if (
        !channel
        || channel.serverId !== input.requestServerId
        || channel.deletedAt
        || (channel.type !== "channel" && !joinedChannelIds.has(channel.id))
        || (channel.type === "joint" && !activeJointByLocalId.has(channel.id))
        || (channel.name === "all" && channel.type !== "channel")
      ) {
        throw new ForwardPersistenceError("authority_changed");
      }
    }
    const destination = channelById.get(input.destinationRequestChannelId);
    if (
      !destination
      || destination.serverId !== input.requestServerId
      || destination.deletedAt
      || destination.archivedAt
      || (destination.name !== "all" && !joinedChannelIds.has(destination.id))
      || (destination.name === "all" && destination.type !== "channel")
      || (destination.type === "joint"
        && activeJointByLocalId.get(destination.id)?.canonicalChannelId !== input.destinationStorageChannelId)
    ) {
      throw new ForwardPersistenceError("authority_changed");
    }

    const sourceProjectionIds = input.metadata.forwardedItems.flatMap((item) =>
      (item.attachmentSnapshots ?? []).map((snapshot) => snapshot.sourceProjectionId)
    );
    const uniqueProjectionIds = [...new Set(sourceProjectionIds)];
    if (uniqueProjectionIds.length !== sourceProjectionIds.length) {
      throw new ForwardPersistenceError("source_attachment_changed");
    }

    const sourceHostMessageIds = input.metadata.forwardedItems.map((item) => item.sourceHostMessageId);
    if (new Set(sourceHostMessageIds).size !== sourceHostMessageIds.length) {
      throw new ForwardPersistenceError("source_attachment_changed");
    }
    const lockedSourceMessages = await tx.select().from(messages)
      .where(inArray(messages.id, sourceHostMessageIds))
      .for("update");
    const sourceMessageById = new Map(lockedSourceMessages.map((message) => [message.id, message]));
    for (const item of input.metadata.forwardedItems) {
      const message = sourceMessageById.get(item.sourceHostMessageId);
      if (
        !message
        || message.messageType !== "chat"
        || message.content !== item.contentSnapshot
        || message.createdAt.toISOString() !== item.sourceCreatedAt
      ) {
        throw new ForwardPersistenceError("source_attachment_changed");
      }
    }

    const sourceMappings = uniqueProjectionIds.length === 0 ? [] : await tx
      .select({ id: attachments.id, objectId: attachments.objectId })
      .from(attachments)
      .where(inArray(attachments.id, uniqueProjectionIds));
    const objectIds = [...new Set(
      sourceMappings.map((projection) => projection.objectId).filter((id): id is string => !!id),
    )].sort();
    const objects = objectIds.length === 0 ? [] : await tx
      .select()
      .from(attachmentObjects)
      .where(inArray(attachmentObjects.id, objectIds))
      .orderBy(asc(attachmentObjects.id))
      .for("update");
    const objectById = new Map(objects.map((object) => [object.id, object]));
    const sourceProjections = uniqueProjectionIds.length === 0 ? [] : await tx
      .select()
      .from(attachments)
      .where(inArray(attachments.id, uniqueProjectionIds))
      .orderBy(asc(attachments.id))
      .for("update");
    const sourceById = new Map(sourceProjections.map((projection) => [projection.id, projection]));

    const destinationProjectionRows: Array<typeof attachments.$inferInsert> = [];
    let messagePosition = 0;
    const forwardedItems = input.metadata.forwardedItems.map((item) => {
      const { sourceHostMessageId, ...publicItem } = item;
      const attachmentSnapshots = (item.attachmentSnapshots ?? []).map((snapshot) => {
        const source = sourceById.get(snapshot.sourceProjectionId);
        const object = source?.objectId ? objectById.get(source.objectId) : null;
        if (
          !source
          || !source.messageId
          || source.revokedAt
          || source.pendingChannelId
          || !object
          || object.lifecycleState !== "active"
          || source.messageId !== sourceHostMessageId
        ) {
          throw new ForwardPersistenceError("source_attachment_changed");
        }
        const projectionId = randomUUID();
        destinationProjectionRows.push({
          id: projectionId,
          objectId: object.id,
          messageId: null,
          pendingChannelId: input.destinationStorageChannelId,
          createdById: input.senderId,
          createdByType: "user",
          messagePosition: messagePosition++,
          channelId: input.destinationStorageChannelId,
          uploaderId: object.uploaderId,
          uploaderType: object.uploaderType,
          filename: snapshot.filename,
          mimeType: object.mimeType,
          sizeBytes: object.sizeBytes,
          storageKey: object.storageKey,
          thumbnailKey: object.thumbnailKey,
          contentHash: object.contentHash,
          width: object.width,
          height: object.height,
        });
        return {
          id: projectionId,
          filename: snapshot.filename,
          mimeType: object.mimeType,
          sizeBytes: object.sizeBytes,
          width: object.width,
          height: object.height,
        };
      });
      return {
        ...publicItem,
        attachmentSnapshots,
        attachmentPolicy: attachmentSnapshots.length > 0 ? "projected" : "excluded",
      };
    });
    const { sourceAuthorityChannelIds: _sourceAuthorityChannelIds, ...metadataWithoutAuthorityInputs } = input.metadata;
    const publicMetadata = {
      ...metadataWithoutAuthorityInputs,
      forwardedItems,
      forwardRequestFingerprint: fingerprint,
    };

    const insertRows = await tx.insert(messages).values({
      channelId: input.destinationStorageChannelId,
      senderType: "user",
      senderId: input.senderId,
      randomId: input.randomId,
      content: input.content,
      messageType: "chat",
      searchText: buildSearchText(input.content),
      actionMetadata: publicMetadata,
    }).onConflictDoNothing().returning();
    const [message] = insertRows;
    if (!message) {
      throw new ForwardPersistenceError("idempotency_conflict");
    }

    if (destinationProjectionRows.length > 0) {
      await tx.insert(attachments).values(destinationProjectionRows.map((projection) => ({
        ...projection,
        messageId: message.id,
        pendingChannelId: null,
      })));
    }
    await tx.update(userChannelInboxStates)
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.channelId, input.destinationStorageChannelId),
        isNotNull(userChannelInboxStates.doneAt),
      ));
    return { message, replayed: false };
  });
}
