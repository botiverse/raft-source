import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asServerId } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  attachmentObjectHolds,
  attachmentObjects,
  attachmentProjectionRevocations,
  attachments,
  channels,
  messages,
  users,
} from "../db/schema";
import { createServer } from "./serverService";
import {
  AttachmentProjectionRevocationError,
  revokeAttachmentProjection,
} from "./attachmentProjectionRevocationService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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
    },
  ]).returning();

  // Both linked projections hold the shared bytes (as the holds backfill writes them).
  await db.insert(attachmentObjectHolds).values([projection, sibling].map((row) => ({
    holderType: "attachment" as const,
    holderId: row.id,
    objectId: object.id,
  })));
  const holders = async () => (await db.select({ holderId: attachmentObjectHolds.holderId })
    .from(attachmentObjectHolds)
    .where(eq(attachmentObjectHolds.objectId, object.id))).map((row) => row.holderId).sort();

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
  assert.deepEqual(await holders(), [sibling.id], "the revoked projection released its hold; the sibling keeps the bytes");
  assert.equal(liveObject?.unheldSince, null);

  const replay = await revokeAttachmentProjection({
    projectionId: projection.id,
    requestServerId: asServerId(server.id),
    actor: { type: "user", id: owner.id },
    reason: "remove destination grant",
    authorize,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revokedAt.toISOString(), first.revokedAt.toISOString());
  assert.deepEqual(await holders(), [sibling.id], "a replay changes no hold");

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

  const siblingRevoke = await revokeAttachmentProjection({
    projectionId: sibling.id,
    requestServerId: asServerId(server.id),
    actor: { type: "user", id: owner.id },
    authorize,
  });
  assert.deepEqual(await holders(), []);
  const [unheld] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, object.id));
  assert.equal(unheld?.lifecycleState, "active", "nothing deletes unheld bytes in this release");
  assert.equal(unheld?.unheldSince?.toISOString(), siblingRevoke.revokedAt.toISOString());
});
