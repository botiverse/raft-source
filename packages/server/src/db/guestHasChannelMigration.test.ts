import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { channels, serverMembers, servers, users } from "./schema";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { seedBoundGuest } from "../test/guestFixture";

// Every Guest has its channel (#wg-rbac:#48), steps 1 and 2: the CHECK
// server_members_guest_has_channel is added NOT VALID; a later release
// validates it. server_members is a hot table: a 2 s lock wait, nothing else
// in the transaction, no CASCADE.
afterEach(closeTestDatabase);

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(suffix = "_guest_has_channel"): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

const ADD = `ALTER TABLE "server_members" ADD CONSTRAINT "server_members_guest_has_channel" CHECK ("server_members"."role" <> 'guest' OR "server_members"."guest_channel_id" IS NOT NULL) NOT VALID;`;

test("adds the CHECK NOT VALID and nothing else, under a 2 s lock wait", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "server_members is hot", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '5s';");
  assert.deepEqual(steps.slice(2), [ADD]);
  assert.ok(!steps.some((step) => /VALIDATE CONSTRAINT|CASCADE/i.test(step)), "no validating scan, no CASCADE (step 2 validates)");
});

test("a historical unbound Guest survives; any new or updated unbound Guest is refused; bound Guests and non-Guests are untouched", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "server_members" (
        "server_id" uuid NOT NULL, "user_id" uuid NOT NULL,
        "role" text NOT NULL DEFAULT 'member', "guest_channel_id" uuid,
        PRIMARY KEY ("server_id", "user_id"));
      INSERT INTO server_members (server_id, user_id, role) VALUES
        ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-000000000001', 'guest'),
        ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-000000000002', 'member');`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");

    // NOT VALID: the old row is not scanned (step 2 validates it).
    assert.equal((await db.query(`SELECT 1 FROM server_members WHERE role = 'guest'`)).rows.length, 1);
    const constraint = await db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'server_members_guest_has_channel'`);
    assert.deepEqual(constraint.rows, [{ convalidated: false }]);

    const S = "11111111-1111-4111-8111-111111111111";
    const CH = "22222222-2222-4222-8222-222222222222";
    await assert.rejects(
      db.query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, '11111111-1111-4111-8111-000000000003', 'guest')`, [S]),
      /server_members_guest_has_channel/,
    );
    await assert.rejects(
      db.query(`UPDATE server_members SET role = 'guest' WHERE user_id = '11111111-1111-4111-8111-000000000002'`),
      /server_members_guest_has_channel/,
      "a Member made a Guest without a channel",
    );
    await db.query(`INSERT INTO server_members (server_id, user_id, role, guest_channel_id) VALUES ($1, '11111111-1111-4111-8111-000000000004', 'guest', $2)`, [S, CH]);
    await assert.rejects(
      db.query(`UPDATE server_members SET guest_channel_id = NULL WHERE user_id = '11111111-1111-4111-8111-000000000004'`),
      /server_members_guest_has_channel/,
      "a bound Guest unbound in place",
    );
    await db.query(`INSERT INTO server_members (server_id, user_id) VALUES ($1, '11111111-1111-4111-8111-000000000005')`, [S]);
  } finally {
    await db.close();
  }
});

test("the migrated schema refuses an unbound Guest; seedBoundGuest seeds one bound to a channel of its server", async ({ db }) => {
  const [owner, guest] = await db.insert(users).values([
    { email: "ghc-owner@test.invalid", name: "ghc-owner", displayName: "Owner", passwordHash: "test" },
    { email: "ghc-guest@test.invalid", name: "ghc-guest", displayName: "Guest", passwordHash: "test" },
  ]).returning();
  const [server] = await db.insert(servers).values({ name: "GHC", slug: "guest-has-channel", ownerId: owner!.id }).returning();

  await assert.rejects(
    db.insert(serverMembers).values({ serverId: server!.id, userId: guest!.id, role: "guest" }),
    (err: unknown) => /server_members_guest_has_channel/.test(String((err as { cause?: unknown }).cause ?? err)),
  );

  const channelId = await seedBoundGuest({ serverId: server!.id, userId: guest!.id }, db);
  const [row] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server!.id), eq(serverMembers.userId, guest!.id)));
  assert.deepEqual(row, { role: "guest", guestChannelId: channelId });
  const [channel] = await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId));
  assert.equal(channel?.serverId, server!.id, "bound to a channel of its own server");
});

// Step 2 of 2: a later release validates the CHECK (SHARE UPDATE EXCLUSIVE,
// writes keep going), in a migration of its own.
const VALIDATE = `ALTER TABLE "server_members" VALIDATE CONSTRAINT "server_members_guest_has_channel";`;

test("step 2 validates the CHECK and nothing else, under a 2 s lock wait", async () => {
  const steps = await migration("_guest_has_channel_validate");
  assertBoundedLockTimeout(steps[0], "server_members is hot", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '60s';");
  assert.deepEqual(steps.slice(2), [VALIDATE]);
});

test("step 2 marks the CHECK valid when no unbound Guest is left, and fails (changing nothing) when one is", async () => {
  const setUp = async (db: PGlite, unboundGuest: boolean) => {
    await db.exec(`CREATE TABLE "server_members" (
        "server_id" uuid NOT NULL, "user_id" uuid NOT NULL,
        "role" text NOT NULL DEFAULT 'member', "guest_channel_id" uuid,
        PRIMARY KEY ("server_id", "user_id"));
      INSERT INTO server_members (server_id, user_id, role, guest_channel_id) VALUES
        ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-000000000001', 'guest', '22222222-2222-4222-8222-222222222222'),
        ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-000000000002', 'member', NULL)
        ${unboundGuest ? ", ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-000000000003', 'guest', NULL)" : ""};`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
  };
  const validate = async (db: PGlite) => {
    await db.exec("BEGIN");
    try {
      for (const step of await migration("_guest_has_channel_validate")) await db.exec(step);
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  };
  const validated = async (db: PGlite) =>
    (await db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'server_members_guest_has_channel'`)).rows;

  const clean = new PGlite();
  try {
    await setUp(clean, false);
    await validate(clean);
    assert.deepEqual(await validated(clean), [{ convalidated: true }]);
  } finally {
    await clean.close();
  }

  const dirty = new PGlite();
  try {
    await setUp(dirty, true);
    await assert.rejects(validate(dirty), /server_members_guest_has_channel/);
    assert.deepEqual(await validated(dirty), [{ convalidated: false }], "a failed validation leaves the CHECK NOT VALID");
  } finally {
    await dirty.close();
  }
});
