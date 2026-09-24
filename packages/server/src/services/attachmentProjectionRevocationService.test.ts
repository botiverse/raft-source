import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asServerId } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  attachmentObjects,
  attachmentProjectionRevocations,
  attachments,
  channels,
  messages,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  AttachmentProjectionRevocationError,
  revokeAttachmentProjection,
} from "./attachmentProjectionRevocationService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("projection revoke is atomic, idempotent, audited, and sibling-local", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `projection-revoke-${randomUUID()}@slock.test`,
    name: `projection-revoke-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Projection Revoke", `projection-revoke-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `projection-revoke-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [hostMessage, siblingMessage] = await db.insert(messages).values([
    { channelId: channel.id, senderType: "user", senderId: owner.id, content: "host" },
    { channelId: channel.id, senderType: "user", senderId: owner.id, content: "sibling" },
  ]).returning();
  const [object] = await db.insert(attachmentObjects).values({
    originServerId: server.id,
    uploaderId: owner.id,
    uploaderType: "user",
    storageKey: `projection-revoke/${randomUUID()}`,
    mimeType: "text/plain",
    sizeBytes: 12,
  }).returning();
  const [projection, sibling] = await db.insert(attachments).values([
    {
      objectId: object.id,
      messageId: hostMessage.id,
      channelId: channel.id,
      createdById: owner.id,
      createdByType: "user",
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "host.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: object.storageKey,
    },
    {
      objectId: object.id,
      messageId: siblingMessage.id,
      channelId: channel.id,
      createdById: owner.id,
      createdByType: "user",
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "sibling.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: object.storageKey,
    },
  ]).returning();

  const authorize = async ({ message }: { message: typeof messages.$inferSelect }) =>
    message.senderType === "user" && message.senderId === owner.id;
  const first = await revokeAttachmentProjection({
    projectionId: projection.id,
    requestServerId: asServerId(server.id),
    actor: { type: "user", id: owner.id },
    reason: "remove destination grant",
    authorize,
  });
  assert.equal(first.replayed, false);

  const [revoked, liveSibling, liveObject, audit] = await Promise.all([
    db.select().from(attachments).where(eq(attachments.id, projection.id)).then((rows) => rows[0]),
    db.select().from(attachments).where(eq(attachments.id, sibling.id)).then((rows) => rows[0]),
    db.select().from(attachmentObjects).where(eq(attachmentObjects.id, object.id)).then((rows) => rows[0]),
    db.select().from(attachmentProjectionRevocations)
      .where(eq(attachmentProjectionRevocations.projectionId, projection.id)).then((rows) => rows[0]),
  ]);
  assert.ok(revoked?.revokedAt);
  assert.equal(liveSibling?.revokedAt, null);
  assert.equal(liveObject?.lifecycleState, "active");
  assert.equal(audit?.objectId, object.id);
  assert.equal(audit?.hostMessageId, hostMessage.id);
  assert.equal(audit?.reason, "remove destination grant");

  const replay = await revokeAttachmentProjection({
    projectionId: projection.id,
    requestServerId: asServerId(server.id),
    actor: { type: "user", id: owner.id },
    reason: "remove destination grant",
    authorize,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revokedAt.toISOString(), first.revokedAt.toISOString());

  await assert.rejects(
    revokeAttachmentProjection({
      projectionId: projection.id,
      requestServerId: asServerId(server.id),
      actor: { type: "user", id: owner.id },
      reason: "different reason",
      authorize,
    }),
    (error: unknown) => error instanceof AttachmentProjectionRevocationError && error.code === "conflict",
  );
});
