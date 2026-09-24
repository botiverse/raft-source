import assert from "node:assert/strict";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import { attachmentObjects, attachments, channels, messages, servers, users } from "../db/schema.js";
import {
  AttachmentLinkError,
  getAttachmentsForMessagesWithExecutor,
  linkAttachmentsToMessageWithExecutor,
} from "./attachmentLinkingService.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_A_ID = "55555555-5555-4555-8555-555555555555";
const MESSAGE_B_ID = "66666666-6666-4666-8666-666666666666";

async function createFixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values([
    { id: OWNER_ID, email: "attachment-owner@slock.test", name: "attachment-owner", passwordHash: "test" },
    { id: OTHER_ID, email: "attachment-other@slock.test", name: "attachment-other", passwordHash: "test" },
  ]);
  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Attachment order fixture",
    slug: "attachment-order-fixture",
    ownerId: OWNER_ID,
  });
  await db.insert(channels).values({
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    name: "attachment-order",
  });
  await db.insert(messages).values([
    {
      id: MESSAGE_A_ID,
      channelId: CHANNEL_ID,
      senderType: "user",
      senderId: OWNER_ID,
      content: "message-a",
    },
    {
      id: MESSAGE_B_ID,
      channelId: CHANNEL_ID,
      senderType: "user",
      senderId: OWNER_ID,
      content: "message-b",
    },
  ]);
  return { client, db };
}

function attachmentValue(
  id: string,
  uploaderId: string,
  filename: string,
  createdAt: Date,
) {
  return {
    id,
    channelId: CHANNEL_ID,
    uploaderId,
    uploaderType: "user" as const,
    filename,
    mimeType: "image/png",
    sizeBytes: 100,
    storageKey: `attachment-order/${id}.png`,
    createdAt,
  };
}

function hasCode(code: AttachmentLinkError["code"]) {
  return (error: unknown) => error instanceof AttachmentLinkError && error.code === code;
}

test("ordered attachment helper persists request ordinals and isolates batch reads", async () => {
  const { client, db } = await createFixture();
  try {
    const a1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const a2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const b1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const b2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    await db.insert(attachments).values([
      attachmentValue(a1, OWNER_ID, "a1.png", new Date("2026-07-24T00:00:00.000Z")),
      attachmentValue(a2, OWNER_ID, "a2.png", new Date("2026-07-24T00:00:01.000Z")),
      attachmentValue(b1, OWNER_ID, "b1.png", new Date("2026-07-24T00:00:02.000Z")),
      attachmentValue(b2, OWNER_ID, "b2.png", new Date("2026-07-24T00:00:03.000Z")),
    ]);

    const linkedA = await db.transaction((tx) =>
      linkAttachmentsToMessageWithExecutor(tx, [a2, a1], MESSAGE_A_ID, OWNER_ID)
    );
    const linkedB = await db.transaction((tx) =>
      linkAttachmentsToMessageWithExecutor(tx, [b2, b1], MESSAGE_B_ID, OWNER_ID)
    );
    assert.deepEqual(linkedA.map((row) => [row.id, row.messagePosition]), [[a2, 0], [a1, 1]]);
    assert.deepEqual(linkedB.map((row) => [row.id, row.messagePosition]), [[b2, 0], [b1, 1]]);

    const batch = await getAttachmentsForMessagesWithExecutor(db, [MESSAGE_B_ID, MESSAGE_A_ID]);
    assert.deepEqual(batch.get(MESSAGE_A_ID)?.map((row) => row.id), [a2, a1]);
    assert.deepEqual(batch.get(MESSAGE_B_ID)?.map((row) => row.id), [b2, b1]);
  } finally {
    await client.close();
  }
});

test("joined attachment reads use active object bytes and exclude revoked projections", async () => {
  const { client, db } = await createFixture();
  try {
    const objectId = "77777777-7777-4777-8777-777777777777";
    const liveId = "88888888-8888-4888-8888-888888888888";
    const revokedId = "99999999-9999-4999-8999-999999999999";
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: SERVER_ID,
      uploaderId: OWNER_ID,
      uploaderType: "user",
      storageKey: "object/authoritative.bin",
      mimeType: "application/pdf",
      sizeBytes: 321,
    });
    await db.insert(attachments).values([
      {
        ...attachmentValue(liveId, OWNER_ID, "projection-name.pdf", new Date()),
        objectId,
        messageId: MESSAGE_A_ID,
        storageKey: "legacy/stale.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      },
      {
        ...attachmentValue(revokedId, OWNER_ID, "revoked.pdf", new Date()),
        objectId,
        messageId: MESSAGE_A_ID,
        revokedAt: new Date(),
        revokedById: OWNER_ID,
        revokedByType: "user",
      },
    ]);

    const rows = (await getAttachmentsForMessagesWithExecutor(db, [MESSAGE_A_ID])).get(MESSAGE_A_ID) ?? [];
    assert.deepEqual(rows.map((row) => row.id), [liveId]);
    assert.equal(rows[0]?.filename, "projection-name.pdf", "filename remains projection-local");
    assert.equal(rows[0]?.storageKey, "object/authoritative.bin");
    assert.equal(rows[0]?.mimeType, "application/pdf");
    assert.equal(rows[0]?.sizeBytes, 321);
  } finally {
    await client.close();
  }
});

test("ordered attachment helper rejects duplicate, missing, and foreign sets with zero writes", async () => {
  const { client, db } = await createFixture();
  try {
    const duplicate = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    const valid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    const foreign = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
    const missing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
    await db.insert(attachments).values([
      attachmentValue(duplicate, OWNER_ID, "duplicate.png", new Date("2026-07-24T00:00:00.000Z")),
      attachmentValue(valid, OWNER_ID, "valid.png", new Date("2026-07-24T00:00:01.000Z")),
      attachmentValue(foreign, OTHER_ID, "foreign.png", new Date("2026-07-24T00:00:02.000Z")),
    ]);

    await assert.rejects(
      db.transaction((tx) =>
        linkAttachmentsToMessageWithExecutor(tx, [duplicate, duplicate], MESSAGE_A_ID, OWNER_ID)
      ),
      hasCode("attachment_duplicate"),
    );
    await assert.rejects(
      db.transaction((tx) =>
        linkAttachmentsToMessageWithExecutor(tx, [valid, missing], MESSAGE_A_ID, OWNER_ID)
      ),
      hasCode("attachment_not_found"),
    );
    await assert.rejects(
      db.transaction((tx) =>
        linkAttachmentsToMessageWithExecutor(tx, [valid, foreign], MESSAGE_A_ID, OWNER_ID)
      ),
      hasCode("attachment_not_found"),
    );

    const linkedRows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(
        inArray(attachments.id, [duplicate, valid, foreign]),
        isNull(attachments.messageId),
        isNull(attachments.messagePosition),
      ));
    assert.equal(linkedRows.length, 3, "every rejected set must leave every attachment unlinked");
  } finally {
    await client.close();
  }
});

test("ordered attachment replay is exact and cross-message or reordered reuse is zero-write conflict", async () => {
  const { client, db } = await createFixture();
  try {
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7";
    const second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
    await db.insert(attachments).values([
      attachmentValue(first, OWNER_ID, "first.png", new Date("2026-07-24T00:00:00.000Z")),
      attachmentValue(second, OWNER_ID, "second.png", new Date("2026-07-24T00:00:01.000Z")),
    ]);
    await db.transaction((tx) =>
      linkAttachmentsToMessageWithExecutor(tx, [second, first], MESSAGE_A_ID, OWNER_ID)
    );

    const replay = await db.transaction((tx) =>
      linkAttachmentsToMessageWithExecutor(tx, [second, first], MESSAGE_A_ID, OWNER_ID, "replay")
    );
    assert.deepEqual(replay.map((row) => row.id), [second, first]);

    await assert.rejects(
      db.transaction((tx) =>
        linkAttachmentsToMessageWithExecutor(tx, [first, second], MESSAGE_A_ID, OWNER_ID, "replay")
      ),
      hasCode("attachment_replay_conflict"),
    );
    await assert.rejects(
      db.transaction((tx) =>
        linkAttachmentsToMessageWithExecutor(tx, [second, first], MESSAGE_B_ID, OWNER_ID)
      ),
      hasCode("attachment_already_linked"),
    );

    const persisted = await db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        messagePosition: attachments.messagePosition,
      })
      .from(attachments)
      .where(inArray(attachments.id, [first, second]));
    assert.deepEqual(
      persisted.sort((left, right) => (left.messagePosition ?? -1) - (right.messagePosition ?? -1)),
      [
        { id: second, messageId: MESSAGE_A_ID, messagePosition: 0 },
        { id: first, messageId: MESSAGE_A_ID, messagePosition: 1 },
      ],
    );
    assert.equal(
      await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.messageId, MESSAGE_B_ID)).then((rows) => rows.length),
      0,
    );
  } finally {
    await client.close();
  }
});
