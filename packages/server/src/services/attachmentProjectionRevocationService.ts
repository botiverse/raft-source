import { and, eq, isNull } from "drizzle-orm";
import { currentDate, type ServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseTransaction } from "../db/index.js";
import {
  attachmentObjects,
  attachmentProjectionRevocations,
  attachments,
  messages,
} from "../db/schema.js";

export type AttachmentProjectionRevocationActor = {
  type: "user" | "agent" | "machine" | "system";
  id: string;
};

export class AttachmentProjectionRevocationError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "conflict") {
    super(code === "not_found"
      ? "Attachment projection not found"
      : code === "forbidden"
        ? "Attachment projection cannot be revoked by this actor"
        : "Attachment projection was already revoked with a different request");
    this.name = "AttachmentProjectionRevocationError";
  }
}

export async function revokeAttachmentProjection(input: {
  projectionId: string;
  requestServerId: ServerId;
  actor: AttachmentProjectionRevocationActor;
  reason?: string | null;
  authorize: (context: {
    projection: typeof attachments.$inferSelect & { objectId: string; messageId: string };
    object: typeof attachmentObjects.$inferSelect;
    message: typeof messages.$inferSelect;
    executor: DatabaseTransaction;
  }) => Promise<boolean>;
}): Promise<{ revokedAt: Date; replayed: boolean }> {
  const reason = input.reason?.trim() || null;
  return getDb().transaction(async (tx) => {
    const [projection] = await tx.select().from(attachments)
      .where(eq(attachments.id, input.projectionId))
      .limit(1)
      .for("update");
    if (!projection?.objectId || !projection.messageId || projection.pendingChannelId) {
      throw new AttachmentProjectionRevocationError("not_found");
    }

    if (projection.revokedAt) {
      const [audit] = await tx.select().from(attachmentProjectionRevocations)
        .where(eq(attachmentProjectionRevocations.projectionId, projection.id))
        .limit(1);
      if (
        audit
        && audit.objectId === projection.objectId
        && audit.hostMessageId === projection.messageId
        && audit.requestServerId === input.requestServerId
        && audit.revokedByType === input.actor.type
        && audit.revokedById === input.actor.id
        && audit.reason === reason
      ) {
        return { revokedAt: audit.revokedAt, replayed: true };
      }
      throw new AttachmentProjectionRevocationError("conflict");
    }

    const [[object], [message]] = await Promise.all([
      tx.select().from(attachmentObjects)
        .where(eq(attachmentObjects.id, projection.objectId)).limit(1).for("update"),
      tx.select().from(messages)
        .where(eq(messages.id, projection.messageId)).limit(1).for("update"),
    ]);
    if (!object || object.lifecycleState !== "active" || !message) {
      throw new AttachmentProjectionRevocationError("not_found");
    }
    const boundProjection = projection as typeof projection & { objectId: string; messageId: string };
    if (!await input.authorize({ projection: boundProjection, object, message, executor: tx })) {
      throw new AttachmentProjectionRevocationError("forbidden");
    }

    const revokedAt = currentDate();
    const updated = await tx.update(attachments).set({
      revokedAt,
      revokedById: input.actor.id,
      revokedByType: input.actor.type,
      revokeReason: reason,
    }).where(and(
      eq(attachments.id, projection.id),
      isNull(attachments.revokedAt),
    )).returning({ id: attachments.id });
    if (updated.length !== 1) {
      throw new AttachmentProjectionRevocationError("conflict");
    }
    await tx.insert(attachmentProjectionRevocations).values({
      projectionId: projection.id,
      objectId: projection.objectId,
      hostMessageId: projection.messageId,
      requestServerId: input.requestServerId,
      revokedById: input.actor.id,
      revokedByType: input.actor.type,
      reason,
      revokedAt,
    });
    return { revokedAt, replayed: false };
  });
}
