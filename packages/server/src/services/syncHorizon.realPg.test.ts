import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index";
import * as schema from "../db/schema";
import { users } from "../db/schema";
import { CREATE_INSERT_XID_INDEX_SQL } from "../../scripts/messages-insert-xid-index";
import { addHuman, createChannel } from "./channelService";
import { createMessage, syncMessagesWithHorizon } from "./messageService";
import { createServer } from "./serverService";
import { readSyncHorizon, type SyncHorizon } from "./syncHorizon";

// The skip bug and its fix with two real connections (PGlite runs one
// transaction at a time, so it cannot hold a transaction open across a read).
// messages.seq is allocated at INSERT; transactions commit in another order.
// The horizon is the snapshot xmin, which is cluster-wide: run this alone on
// its PostgreSQL (CI runs the real-PG steps one after another), or another
// database's open transaction holds the horizon below what this test expects.

const REAL_PG_URL_ENV = "SYNC_HORIZON_REAL_PG_URL";
const DATABASE_URL = process.env[REAL_PG_URL_ENV];
const REQUIRED = process.env.SYNC_HORIZON_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

type Inserted = { id: string; seq: number; insertXid: string };

async function insertMessage(client: pg.Client, channelId: string, senderId: string, content: string, insertXid?: string | null): Promise<Inserted> {
  const supplied = insertXid !== undefined;
  const result = await client.query<{ id: string; seq: string; insert_xid: string }>(
    `INSERT INTO messages (id, channel_id, sender_type, sender_id, content${supplied ? ", insert_xid" : ""})
     VALUES ($1, $2, 'user', $3, $4${supplied ? ", $5::xid8" : ""})
     RETURNING id, seq::text AS seq, insert_xid::text AS insert_xid`,
    supplied ? [randomUUID(), channelId, senderId, content, insertXid] : [randomUUID(), channelId, senderId, content],
  );
  const row = result.rows[0]!;
  return { id: row.id, seq: Number(row.seq), insertXid: row.insert_xid };
}

async function currentXid(client: pg.Client): Promise<string> {
  const result = await client.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
  return result.rows[0]!.xid;
}

test(
  "real PG: a message committed after a later-seq one is returned as late with since_horizon; old requests miss it",
  { skip: !(DATABASE_URL || REQUIRED), timeout: 180_000 },
  async () => {
    assert.ok(DATABASE_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_sync_horizon_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: DATABASE_URL, application_name: "sync-horizon-real-pg-admin" });
    const writers: pg.Client[] = [];
    let databaseOpen = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(DATABASE_URL, databaseName);
      const setupPool = new pg.Pool({ connectionString: testUrl, application_name: "sync-horizon-real-pg-setup", max: 1 });
      try {
        await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
        // As every deploy does after the migrations (db:create-messages-insert-xid-index).
        await setupPool.query(CREATE_INSERT_XID_INDEX_SQL);
      } finally {
        await setupPool.end();
      }

      await initDatabase(testUrl);
      databaseOpen = true;
      const db = getDb();
      const suffix = randomUUID().slice(0, 8);
      const [owner] = await db.insert(users).values({
        email: `sync-horizon-${suffix}@slock.test`,
        name: `sync-horizon-${suffix}`,
        displayName: "Sync Horizon Owner",
        passwordHash: "x",
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      }).returning();
      const server = await createServer("Sync Horizon", `sync-horizon-${suffix}`, owner!.id);
      const channel = await createChannel(server.id, `sync-horizon-${suffix}`);
      await addHuman(channel.id, owner!.id);
      const read = (sinceSeq: number, sinceHorizon?: SyncHorizon) => syncMessagesWithHorizon(
        sinceSeq, channel.id, 200, server.id, undefined, owner!.id, server.id, { sinceHorizon },
      );

      for (let i = 0; i < 2; i += 1) {
        const client = new pg.Client({ connectionString: testUrl, application_name: `sync-horizon-real-pg-writer-${i}` });
        await client.connect();
        writers.push(client);
      }
      const [txA, txB] = writers as [pg.Client, pg.Client];

      // The trigger records the inserting transaction, whatever the writer supplied.
      await txA.query("BEGIN");
      const xid = await currentXid(txA);
      for (const supplied of ["1", null, undefined]) {
        const row = await insertMessage(txA, channel.id, owner!.id, `trigger ${String(supplied)}`, supplied);
        assert.equal(row.insertXid, xid, `supplied ${String(supplied)}`);
      }
      await txA.query("ROLLBACK");

      const m0 = await createMessage(channel.id, "user", owner!.id, "m0");
      const start = await read(0);
      assert.deepEqual(start.messages.map((m) => m.id), [m0.id]);

      // --- Scenario 1: A takes the smaller seq and stays open; B (an older
      // transaction id) takes a larger seq and commits.
      await txB.query("BEGIN");
      const xidB = await currentXid(txB);
      await txA.query("BEGIN");
      const a = await insertMessage(txA, channel.id, owner!.id, "A (commits late)");
      const b = await insertMessage(txB, channel.id, owner!.id, "B");
      await txB.query("COMMIT");
      assert.ok(a.seq < b.seq, "A holds the smaller seq");
      assert.ok(BigInt(xidB) < BigInt(a.insertXid));

      const round1 = await read(m0.seq, start.horizon);
      assert.deepEqual(round1.messages.map((m) => m.id), [b.id], "B is visible and finished; A is in flight");
      assert.ok(BigInt(round1.horizon) <= BigInt(a.insertXid), "the horizon stays at or below the in-flight A");
      assert.equal(round1.lateCount, 0);
      assert.equal(round1.horizonReset, false);
      // Telemetry only (checked at the end, so the late-row rounds below always run).
      const round1Span = round1.snapshotXidSpan;
      // Old-style request: same rows today.
      const old1 = await read(m0.seq);
      assert.deepEqual(old1.messages.map((m) => m.id), [b.id]);

      await txA.query("COMMIT");

      // Round 2 from the client's cursor (B.seq) with round 1's horizon: A is late.
      const round2 = await read(b.seq, round1.horizon);
      assert.deepEqual(round2.messages.map((m) => m.id), [a.id]);
      assert.equal(round2.lateCount, 1);
      assert.ok(BigInt(round2.horizon) > BigInt(a.insertXid));
      // Known old-client behaviour (what this fixes): without since_horizon, A is never fetched.
      const old2 = await read(b.seq);
      assert.deepEqual(old2.messages, []);
      // The next round's horizon finds nothing more.
      const round3 = await read(b.seq, round2.horizon);
      assert.deepEqual(round3.messages, []);

      // --- Scenario 2: transaction ids in seq order. A2 (smaller seq) stays
      // open, B2 (larger seq, newer transaction) commits.
      await txA.query("BEGIN");
      const a2 = await insertMessage(txA, channel.id, owner!.id, "A2 (commits late)");
      await txB.query("BEGIN");
      const b2 = await insertMessage(txB, channel.id, owner!.id, "B2");
      await txB.query("COMMIT");
      assert.ok(a2.seq < b2.seq && BigInt(a2.insertXid) < BigInt(b2.insertXid));

      // With a since-horizon B2 is held back (its transaction id is not below the horizon) ...
      const round4 = await read(b.seq, round3.horizon);
      assert.deepEqual(round4.messages, [], "B2 finished after an in-flight A2: held back, so the cursor does not pass A2");
      // ... an old-style request returns it, and its cursor passes the in-flight A2 (today's behaviour).
      const old4 = await read(b.seq);
      assert.deepEqual(old4.messages.map((m) => m.id), [b2.id]);

      await txA.query("COMMIT");
      const round5 = await read(b.seq, round4.horizon);
      assert.deepEqual(round5.messages.map((m) => m.id), [a2.id, b2.id]);
      assert.equal(round5.lateCount, 0, "both arrive on the page: the cursor never passed them");

      // The standalone horizon (socket sync:horizon) sees no transaction in flight now.
      const current = await readSyncHorizon();
      assert.ok(BigInt(current.horizon) > BigInt(b2.insertXid));
      // Telemetry: snapshotXidSpan = xmax - xmin of the read's snapshot. pg_snapshot_xmax is
      // latestCompletedXid + 1, not the next xid to be assigned, so with A the newest
      // transaction still in flight (B completed just before it) xmax == A == xmin and the
      // span is 0. The contract is only that it is a non-negative number while A is in flight.
      assert.ok(
        typeof round1Span === "number" && round1Span >= 0,
        `snapshot span is a non-negative number: span=${String(round1Span)} (${typeof round1Span}), horizon=${round1.horizon}, A=${a.insertXid}`,
      );
    } finally {
      for (const client of writers) {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end().catch(() => undefined);
      }
      if (databaseOpen) await closeDatabase();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  },
);
