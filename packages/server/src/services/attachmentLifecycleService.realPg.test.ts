import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  attachmentObjects,
  attachmentUploadReservations,
  channels,
  messages,
  servers,
  users,
} from "../db/schema.js";
import { expireAttachmentReservation } from "./attachmentLifecycleService.js";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";
import { AttachmentLinkError, linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";

const REAL_PG_URL_ENV = "ATTACHMENT_LIFECYCLE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ATTACHMENT_LIFECYCLE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const COMPLETED_AT = new Date("2026-08-12T00:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-08-12T02:00:00.000Z");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  return null;
}

test(
  "real PostgreSQL serializes send and expiry on the object-first lifecycle fence",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task112_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "task112-admin" });
    let setupPool: pg.Pool | undefined;
    let initialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "task112-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await initDatabase(testUrl);
      initialized = true;
      const db = getDb();
      const [owner] = await db.insert(users).values({
        email: `task112-${randomUUID()}@slock.test`,
        name: `task112-${randomUUID()}`,
        passwordHash: "test",
      }).returning();
      const [server] = await db.insert(servers).values({
        name: "Task 112",
        slug: `task112-${randomBytes(4).toString("hex")}`,
        ownerId: owner.id,
      }).returning();
      const [channel] = await db.insert(channels).values({
        serverId: server.id,
        name: "lifecycle",
      }).returning();

      const createCase = async (label: string) => {
        const [message] = await db.insert(messages).values({
          channelId: channel.id,
          senderType: "user",
          senderId: owner.id,
          content: label,
        }).returning();
        const attachmentId = randomUUID();
        const objectId = randomUUID();
        const transferIntentId = randomUUID();
        const storageKey = `${server.id}/${attachmentId}`;
        await createAttachmentTransferIntent({
          id: transferIntentId,
          reservationId: attachmentId,
          objectId,
          serverId: server.id,
          channelId: channel.id,
          uploaderId: owner.id,
          uploaderType: "user",
          filename: `${label}.txt`,
          mimeType: "text/plain",
          declaredSizeBytes: 1,
          expiresAt: new Date(COMPLETED_AT.getTime() + 15 * 60 * 1000),
          artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: "text/plain" }),
        }, db, COMPLETED_AT);
        const projection = await db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, {
          id: attachmentId,
          objectId,
          transferIntentId,
          serverId: server.id,
          channelId: channel.id,
          uploaderId: owner.id,
          uploaderType: "user",
          filename: `${label}.txt`,
          mimeType: "text/plain",
          sizeBytes: 1,
          storageKey,
        }, COMPLETED_AT));
        return { attachmentId, messageId: message.id, objectId: projection.objectId! };
      };

      const assertSendRequiresLock = async (
        label: string,
        target: "object" | "reservation",
      ) => {
        const candidate = await createCase(label);
        const rowLocked = deferred();
        const releaseRow = deferred();
        const blocker = db.transaction(async (tx) => {
          const rows = target === "object"
            ? await tx.select({ id: attachmentObjects.id }).from(attachmentObjects)
              .where(eq(attachmentObjects.id, candidate.objectId))
              .for("update")
            : await tx.select({ id: attachmentUploadReservations.id }).from(attachmentUploadReservations)
              .where(eq(attachmentUploadReservations.id, candidate.attachmentId))
              .for("update");
          assert.equal(rows.length, 1);
          rowLocked.resolve();
          await releaseRow.promise;
        });
        await rowLocked.promise;

        let passedCanonicalFence = false;
        const outcome = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
          await linkAttachmentsToMessageWithExecutor(
            tx,
            [candidate.attachmentId],
            candidate.messageId,
            owner.id,
            "new",
            new Date("2026-08-12T00:30:00.000Z"),
            {
              afterObjectAndReservationLocks: async () => {
                passedCanonicalFence = true;
              },
            },
          );
        }).then(
          () => ({ status: "committed" as const, code: null }),
          (error: unknown) => ({
            status: "rejected" as const,
            code: postgresErrorCode(error),
          }),
        );
        releaseRow.resolve();
        await blocker;

        assert.deepEqual(
          { ...outcome, passedCanonicalFence },
          { status: "rejected", code: "55P03", passedCanonicalFence: false },
          `send must wait on the canonical ${target} row lock instead of committing through it`,
        );
        await db.transaction((tx) => linkAttachmentsToMessageWithExecutor(
          tx,
          [candidate.attachmentId],
          candidate.messageId,
          owner.id,
          "new",
          new Date("2026-08-12T00:30:00.000Z"),
        ));
      };

      await assertSendRequiresLock("object-lock-witness", "object");
      await assertSendRequiresLock("reservation-lock-witness", "reservation");

      const expiryWins = await createCase("expiry-wins");
      const expiryLocked = deferred();
      const releaseExpiry = deferred();
      const expiry = expireAttachmentReservation(
        expiryWins.attachmentId,
        AFTER_EXPIRY,
        db,
        {
          afterObjectAndReservationLock: async () => {
            expiryLocked.resolve();
            await releaseExpiry.promise;
          },
        },
      );
      await expiryLocked.promise;
      const blockedSend = db.transaction((tx) => linkAttachmentsToMessageWithExecutor(
        tx,
        [expiryWins.attachmentId],
        expiryWins.messageId,
        owner.id,
        "new",
        AFTER_EXPIRY,
      )).then(() => null, (error: unknown) => error);
      releaseExpiry.resolve();
      assert.equal((await expiry)?.state, "expired");
      const sendError = await blockedSend;
      assert.ok(sendError instanceof AttachmentLinkError);
      assert.equal(sendError.code, "attachment_expired");

      const sendWins = await createCase("send-wins");
      const sendLocked = deferred();
      const releaseSend = deferred();
      const send = db.transaction((tx) => linkAttachmentsToMessageWithExecutor(
        tx,
        [sendWins.attachmentId],
        sendWins.messageId,
        owner.id,
        "new",
        new Date("2026-08-12T00:30:00.000Z"),
        {
          afterObjectAndReservationLocks: async () => {
            sendLocked.resolve();
            await releaseSend.promise;
          },
        },
      ));
      await sendLocked.promise;
      const blockedExpiry = expireAttachmentReservation(sendWins.attachmentId, AFTER_EXPIRY, db);
      releaseSend.resolve();
      await send;
      assert.equal((await blockedExpiry)?.state, "consumed");

      const reservations = await db.select().from(attachmentUploadReservations);
      assert.deepEqual(
        reservations.map((row) => row.state).sort(),
        ["consumed", "consumed", "consumed", "expired"],
      );
    } finally {
      if (initialized) await closeDatabase();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
