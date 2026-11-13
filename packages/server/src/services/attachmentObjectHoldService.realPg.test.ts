import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase, type Database } from "../db/index";
import * as schema from "../db/schema";
import { attachmentObjectHolds, attachmentObjects, channels, servers, users } from "../db/schema";
import { expireAttachmentReservation, runAttachmentLifecycleSweep } from "./attachmentLifecycleService";
import { AttachmentObjectHoldError, addAttachmentObjectHoldWithExecutor } from "./attachmentObjectHoldService";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService";
import type { StorageBackend } from "./storageService";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService";

// Same opt-in as attachmentLifecycleService.realPg.test.ts: PGlite has one
// connection, so only a real server can interleave two transactions.
const REAL_PG_URL_ENV = "ATTACHMENT_LIFECYCLE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ATTACHMENT_LIFECYCLE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const COMPLETED_AT = new Date("2026-08-12T00:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-08-12T02:00:00.000Z");

class FakeStorage implements StorageBackend {
  async put(): Promise<void> {}
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(): Promise<void> {}
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
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

type Outcome = "held_and_kept" | "refused_and_collected";

test(
  "real PostgreSQL: add-hold racing the reservation cleanup either keeps a held object or refuses the hold",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED) },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_holds_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "holds-admin" });
    let setupPool: pg.Pool | undefined;
    let initialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "holds-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await initDatabase(testUrl);
      initialized = true;
      const db: Database = getDb();
      const [owner] = await db.insert(users).values({
        email: `holds-${randomUUID()}@slock.test`,
        name: `holds-${randomUUID()}`,
        passwordHash: "test",
      }).returning();
      const [server] = await db.insert(servers).values({
        name: "Holds race",
        slug: `holds-${randomBytes(4).toString("hex")}`,
        ownerId: owner!.id,
      }).returning();
      const [channel] = await db.insert(channels).values({ serverId: server!.id, name: "holds" }).returning();

      const uploadCase = async (label: string) => {
        const attachmentId = randomUUID();
        const objectId = randomUUID();
        const transferIntentId = randomUUID();
        const storageKey = `${server!.id}/${attachmentId}`;
        await createAttachmentTransferIntent({
          id: transferIntentId,
          reservationId: attachmentId,
          objectId,
          serverId: server!.id,
          channelId: channel!.id,
          uploaderId: owner!.id,
          uploaderType: "user",
          filename: `${label}.txt`,
          mimeType: "text/plain",
          declaredSizeBytes: 1,
          expiresAt: new Date(COMPLETED_AT.getTime() + 15 * 60 * 1000),
          artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: "text/plain" }),
        }, db, COMPLETED_AT);
        await db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, {
          id: attachmentId,
          objectId,
          transferIntentId,
          serverId: server!.id,
          channelId: channel!.id,
          uploaderId: owner!.id,
          uploaderType: "user",
          filename: `${label}.txt`,
          mimeType: "text/plain",
          sizeBytes: 1,
          storageKey,
        }, COMPLETED_AT));
        return { attachmentId, objectId };
      };

      const addHold = (objectId: string, beforeCommit?: () => Promise<void>) =>
        db.transaction(async (tx) => {
          await addAttachmentObjectHoldWithExecutor(tx, {
            holderType: "attachment",
            holderId: randomUUID(),
            objectId,
          });
          await beforeCommit?.();
        }).then(() => true, (error: unknown) => {
          if (error instanceof AttachmentObjectHoldError) return false;
          throw error;
        });

      const outcomeOf = async (objectId: string, holdCommitted: boolean): Promise<Outcome> => {
        const [object] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, objectId));
        const holds = await db.select().from(attachmentObjectHolds).where(eq(attachmentObjectHolds.objectId, objectId));
        if (holdCommitted) {
          assert.equal(object?.lifecycleState, "active", "a committed hold keeps the object");
          assert.equal(holds.length, 1);
          return "held_and_kept";
        }
        assert.equal(object?.lifecycleState, "gc_pending", "a refused hold means the cleanup won");
        assert.equal(holds.length, 0);
        return "refused_and_collected";
      };

      // Cleanup locks first: the add waits on its object lock, then finds gc_pending.
      {
        const candidate = await uploadCase("cleanup-first");
        const locked = deferred();
        const release = deferred();
        const expiry = expireAttachmentReservation(candidate.attachmentId, AFTER_EXPIRY, db, {
          afterObjectAndReservationLock: async () => {
            locked.resolve();
            await release.promise;
          },
        });
        await locked.promise;
        const add = addHold(candidate.objectId);
        release.resolve();
        assert.equal((await expiry)?.state, "expired");
        assert.equal(await outcomeOf(candidate.objectId, await add), "refused_and_collected");
      }

      // Hold locks first: the cleanup waits on FOR UPDATE, then sees the hold.
      {
        const candidate = await uploadCase("hold-first");
        const holding = deferred();
        const release = deferred();
        const add = addHold(candidate.objectId, async () => {
          holding.resolve();
          await release.promise;
        });
        await holding.promise;
        const expiry = expireAttachmentReservation(candidate.attachmentId, AFTER_EXPIRY, db);
        release.resolve();
        assert.equal(await add, true);
        assert.equal((await expiry)?.state, "expired");
        assert.equal(await outcomeOf(candidate.objectId, true), "held_and_kept");
      }

      // Unordered races: only the two allowed outcomes ever appear.
      const seen = new Set<Outcome>();
      for (let round = 0; round < 24; round += 1) {
        const candidate = await uploadCase(`race-${round}`);
        const [holdCommitted, expired] = await Promise.all([
          addHold(candidate.objectId),
          expireAttachmentReservation(candidate.attachmentId, AFTER_EXPIRY, db),
        ]);
        assert.equal(expired?.state, "expired");
        seen.add(await outcomeOf(candidate.objectId, holdCommitted));
      }
      assert.ok(seen.size >= 1);

      // Adders on an object that lost its last hold clear unheld_since. They
      // lock the object up front instead of upgrading a shared lock, so
      // concurrent adds (e.g. a send whose attachment has no reservation)
      // queue instead of deadlocking.
      for (let round = 0; round < 8; round += 1) {
        const objectId = randomUUID();
        await db.insert(attachmentObjects).values({
          id: objectId,
          originServerId: server!.id,
          uploaderId: owner!.id,
          uploaderType: "user",
          storageKey: `${server!.id}/unheld-${objectId}`,
          mimeType: "text/plain",
          sizeBytes: 1,
          unheldSince: COMPLETED_AT,
        });
        const added = await Promise.all(Array.from({ length: 4 }, () => addHold(objectId)));
        assert.deepEqual(added, [true, true, true, true]);
        const [object] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, objectId));
        assert.equal(object?.unheldSince, null);
        const holds = await db.select().from(attachmentObjectHolds).where(eq(attachmentObjectHolds.objectId, objectId));
        assert.equal(holds.length, 4);
      }

      // Finishing the collection never leaves a hold on a non-active object.
      await runAttachmentLifecycleSweep({ db, now: AFTER_EXPIRY, storage: new FakeStorage(), cdnStorage: null, metrics: null });
      const violations = await db.execute(sql`
        SELECT count(*)::int AS count
          FROM attachment_object_holds hold
          JOIN attachment_objects object ON object.id = hold.object_id
         WHERE object.lifecycle_state <> 'active'
      `);
      assert.equal(Number((violations.rows[0] as { count: number }).count), 0);
      const deleted = await db.execute(sql`
        SELECT count(*)::int AS count FROM attachment_objects WHERE lifecycle_state = 'deleted'
      `);
      assert.ok(Number((deleted.rows[0] as { count: number }).count) >= 1, "the cleanup still collects unheld bytes");
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
