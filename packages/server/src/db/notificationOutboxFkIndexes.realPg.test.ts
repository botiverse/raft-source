// db:create-notification-outbox-fk-indexes against a real PostgreSQL (unified
// notifications, contract step 2). The script runs CREATE / DROP INDEX
// CONCURRENTLY, which PGlite cannot exercise, so its flow is pinned here:
// - both FK indexes are built and verified BEFORE the old unique key goes;
// - a rerun changes nothing;
// - an invalid leftover of an interrupted build is dropped and rebuilt;
// - a copy of the old key under another name stops the script after the new
//   indexes are built, and is left in place;
// - a database without notification_outbox is skipped.
//
// Each case gets its own database with just the columns the script touches.
//
// Own gate:
//   NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_URL      admin DSN of a disposable PostgreSQL
//   NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_REQUIRED "1" in CI: a missing URL then fails, no skip
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { NOTIFICATION_OUTBOX_FK_INDEXES, NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX } from "./notificationOutboxIndexContract";

const ADMIN_URL = process.env.NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_URL;
const REQUIRED = process.env.NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_REQUIRED === "1";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = "scripts/create-notification-outbox-fk-indexes.ts";
const LEGACY = NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX.name;
const [SOURCE_CHANNEL, RECEIVER] = NOTIFICATION_OUTBOX_FK_INDEXES.map((spec) => spec.name) as [string, string];

const OUTBOX = `
  CREATE TABLE "notification_outbox" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "receiver_type" text NOT NULL,
    "receiver_id" uuid NOT NULL,
    "source_channel_id" uuid,
    "message_id" uuid
  );
  CREATE UNIQUE INDEX "${LEGACY}" ON "notification_outbox" ("receiver_type", "receiver_id", "source_channel_id", "message_id");
  INSERT INTO "notification_outbox" ("receiver_type", "receiver_id", "source_channel_id", "message_id")
    SELECT 'user', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() FROM generate_series(1, 500);
`;

type Db = { client: pg.Client; url: string };

async function database(t: { skip: () => void; onTestFinished: (fn: () => Promise<void>) => void }, setup: string): Promise<Db | null> {
  if (!ADMIN_URL) {
    if (REQUIRED) throw new Error("NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_REQUIRED=1 but NOTIFICATION_OUTBOX_FK_INDEXES_REAL_PG_URL is missing");
    t.skip();
    return null;
  }
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const name = `outbox_fk_idx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(ADMIN_URL);
  target.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  t.onTestFinished(async () => {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  if (setup) await client.query(setup);
  return { client, url: target.toString() };
}

function runScript(url: string): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", SCRIPT], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: url },
    timeout: 120_000,
  });
  return { status: child.status, output: `${child.stdout}\n${child.stderr}` };
}

async function indexes(client: pg.Client): Promise<Map<string, { valid: boolean; unique: boolean }>> {
  const rows = (await client.query<{ name: string; valid: boolean; unique: boolean }>(`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.notification_outbox'::regclass
  `)).rows;
  return new Map(rows.map((row) => [row.name, { valid: row.valid, unique: row.unique }]));
}

test("builds both FK indexes concurrently, only then drops the old key; a rerun changes nothing", async (t) => {
  const db = await database(t, OUTBOX);
  if (!db) return;

  const first = runScript(db.url);
  assert.equal(first.status, 0, first.output);
  const order = [first.output.indexOf(`Creating ${SOURCE_CHANNEL}`), first.output.indexOf(`Creating ${RECEIVER}`), first.output.indexOf(`Dropping ${LEGACY}`)];
  assert.ok(order.every((at) => at >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, first.output);
  let after = await indexes(db.client);
  for (const name of [SOURCE_CHANNEL, RECEIVER]) assert.deepEqual(after.get(name), { valid: true, unique: false }, name);
  assert.equal(after.has(LEGACY), false);

  const second = runScript(db.url);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, new RegExp(`${SOURCE_CHANNEL} already exists; no action needed`));
  assert.match(second.output, new RegExp(`${RECEIVER} already exists; no action needed`));
  assert.match(second.output, /\[NOTIFICATION_OUTBOX_LEGACY_INDEX_ABSENT\]/);
  after = await indexes(db.client);
  assert.deepEqual([...after.keys()].sort(), ["notification_outbox_pkey", RECEIVER, SOURCE_CHANNEL].sort());
});

test("an invalid leftover of an interrupted build is dropped and rebuilt before the old key goes", async (t) => {
  const db = await database(t, OUTBOX);
  if (!db) return;
  // A failed CREATE INDEX CONCURRENTLY leaves an invalid index behind: build
  // the receiver index as UNIQUE over duplicate receivers so it fails.
  await db.client.query(`INSERT INTO "notification_outbox" ("receiver_type", "receiver_id") VALUES ('user', '11111111-1111-4111-8111-111111111111'), ('agent', '11111111-1111-4111-8111-111111111111')`);
  await assert.rejects(db.client.query(`CREATE UNIQUE INDEX CONCURRENTLY "${RECEIVER}" ON "notification_outbox" ("receiver_id")`));
  assert.equal((await indexes(db.client)).get(RECEIVER)?.valid, false, "the failed build left an invalid index");

  const run = runScript(db.url);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, new RegExp(`${RECEIVER} is invalid; dropping it concurrently to rebuild it`));
  const after = await indexes(db.client);
  assert.deepEqual(after.get(RECEIVER), { valid: true, unique: false });
  assert.deepEqual(after.get(SOURCE_CHANNEL), { valid: true, unique: false });
  assert.equal(after.has(LEGACY), false);
});

test("a copy of the old key under another name stops the script after the new indexes exist, and is kept", async (t) => {
  const db = await database(t, OUTBOX);
  if (!db) return;
  await db.client.query(`ALTER INDEX "${LEGACY}" RENAME TO "notification_outbox_unique_fact_rebuilt"`);

  const run = runScript(db.url);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /under another name: notification_outbox_unique_fact_rebuilt/);
  const after = await indexes(db.client);
  assert.deepEqual(after.get("notification_outbox_unique_fact_rebuilt"), { valid: true, unique: true }, "never dropped silently");
  for (const name of [SOURCE_CHANNEL, RECEIVER]) assert.deepEqual(after.get(name), { valid: true, unique: false }, name);
});

test("a database without notification_outbox is skipped", async (t) => {
  const db = await database(t, "");
  if (!db) return;
  const run = runScript(db.url);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /\[NOTIFICATION_OUTBOX_FK_INDEXES_SKIPPED\]/);
});
