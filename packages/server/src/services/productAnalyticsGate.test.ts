import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { userAnalyticsIds, users } from "../db/schema";
import {
  decideProductAnalyticsGate,
  loadProductAnalyticsGateBatch,
  resolveProductAnalyticsGate,
  setProductAnalyticsOptOut,
  type ProductAnalyticsFacts,
} from "./productAnalyticsGate";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_ID = asServerId("33333333-3333-4333-8333-333333333333");
const ANALYTICS_ID = "44444444-4444-4444-8444-444444444444";

const GATE_CASES: Array<[string, ProductAnalyticsFacts, ReturnType<typeof decideProductAnalyticsGate>]> = [
  [
    "usage data not chosen: the default (on) applies",
    { analyticsId: ANALYTICS_ID, shareUsageData: null, workspaceEnabled: true },
    { recordAllowed: true, analyticsId: ANALYTICS_ID as never, clientEventsAllowed: true },
  ],
  [
    "usage data turned off: workspace counts only, nothing linked to the user",
    { analyticsId: ANALYTICS_ID, shareUsageData: false, workspaceEnabled: true },
    { recordAllowed: true, analyticsId: null, clientEventsAllowed: false },
  ],
  [
    "mapped user who shares usage data",
    { analyticsId: ANALYTICS_ID, shareUsageData: true, workspaceEnabled: true },
    { recordAllowed: true, analyticsId: ANALYTICS_ID as never, clientEventsAllowed: true },
  ],
  [
    "no server context",
    { analyticsId: ANALYTICS_ID, shareUsageData: true, workspaceEnabled: null },
    { recordAllowed: true, analyticsId: ANALYTICS_ID as never, clientEventsAllowed: true },
  ],
  [
    "opted out: counts toward the workspace, never linked, no client events",
    { analyticsId: null, shareUsageData: true, workspaceEnabled: true },
    { recordAllowed: true, analyticsId: null, clientEventsAllowed: false },
  ],
  [
    "workspace turned off: nothing recorded (pending §9.5)",
    { analyticsId: ANALYTICS_ID, shareUsageData: true, workspaceEnabled: false },
    { recordAllowed: false, analyticsId: null, clientEventsAllowed: false },
  ],
];

for (const [name, facts, expected] of GATE_CASES) {
  test(`decideProductAnalyticsGate: ${name}`, () => {
    assert.deepEqual(decideProductAnalyticsGate(facts), expected);
  });
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await client.exec(`
    INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
      ('${USER_ID}', 'analytics-gate-user@slock.test', 'analytics-gate-user', 'test'),
      ('${OWNER_ID}', 'analytics-gate-owner@slock.test', 'analytics-gate-owner', 'test');
    INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('${SERVER_ID}', 'Analytics Gate', 'analytics-gate', '${OWNER_ID}');
  `);
  return { client, db };
}

async function mappingOf(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ analyticsId: userAnalyticsIds.analyticsId })
    .from(userAnalyticsIds)
    .where(eq(userAnalyticsIds.userId, userId));
  return row?.analyticsId ?? null;
}

test("every new user gets a random analytics id that is not their user id", async () => {
  const { client, db } = await fixture();
  try {
    const userMapping = await mappingOf(db, USER_ID);
    const ownerMapping = await mappingOf(db, OWNER_ID);
    assert.ok(userMapping);
    assert.ok(ownerMapping);
    assert.notEqual(userMapping, USER_ID);
    assert.notEqual(userMapping, ownerMapping);

    const notChosen = await resolveProductAnalyticsGate(db, { userId: USER_ID, serverId: SERVER_ID });
    assert.deepEqual(notChosen, { recordAllowed: true, analyticsId: userMapping, clientEventsAllowed: true });
    await db.update(users).set({ shareUsageData: false }).where(eq(users.id, USER_ID));
    const notSharing = await resolveProductAnalyticsGate(db, { userId: USER_ID, serverId: SERVER_ID });
    assert.deepEqual(notSharing, { recordAllowed: true, analyticsId: null, clientEventsAllowed: false });
  } finally {
    await client.close();
  }
});

test("opting out deletes the mapping; opting back in mints a different id", async () => {
  const { client, db } = await fixture();
  try {
    const before = await mappingOf(db, USER_ID);

    await setProductAnalyticsOptOut(db, USER_ID, true);
    assert.equal(await mappingOf(db, USER_ID), null);
    const [optedOut] = await db.select({ at: users.analyticsOptedOutAt }).from(users).where(eq(users.id, USER_ID));
    assert.ok(optedOut?.at);
    assert.equal((await resolveProductAnalyticsGate(db, { userId: USER_ID, serverId: SERVER_ID })).analyticsId, null);

    await setProductAnalyticsOptOut(db, USER_ID, false);
    const after = await mappingOf(db, USER_ID);
    assert.ok(after);
    assert.notEqual(after, before, "re-opting in must not relink the opted-out history");

    // Opting in while already in keeps the current id.
    await setProductAnalyticsOptOut(db, USER_ID, false);
    assert.equal(await mappingOf(db, USER_ID), after);
  } finally {
    await client.close();
  }
});

test("the workspace switch and the usage-data setting reach the gate", async () => {
  const { client, db } = await fixture();
  try {
    await db.update(users).set({ shareUsageData: true }).where(eq(users.id, USER_ID));
    const on = await resolveProductAnalyticsGate(db, { userId: USER_ID, serverId: SERVER_ID });
    assert.equal(on.clientEventsAllowed, true);

    await client.exec(`UPDATE "servers" SET "product_analytics_enabled" = false WHERE "id" = '${SERVER_ID}'`);
    const off = await resolveProductAnalyticsGate(db, { userId: USER_ID, serverId: SERVER_ID });
    assert.deepEqual(off, { recordAllowed: false, analyticsId: null, clientEventsAllowed: false });
  } finally {
    await client.close();
  }
});

test("a batch decides many (user, server) pairs from one load", async () => {
  const { client, db } = await fixture();
  try {
    const OFF_SERVER = asServerId("55555555-5555-4555-8555-555555555555");
    await client.exec(`
      INSERT INTO "servers" ("id", "name", "slug", "owner_id", "product_analytics_enabled")
      VALUES ('${OFF_SERVER}', 'Analytics Off', 'analytics-off', '${OWNER_ID}', false);
    `);
    await setProductAnalyticsOptOut(db, OWNER_ID, true);
    await db.update(users).set({ shareUsageData: true }).where(eq(users.id, USER_ID));
    const batch = await loadProductAnalyticsGateBatch(db, {
      userIds: [USER_ID, OWNER_ID, USER_ID],
      serverIds: [SERVER_ID, OFF_SERVER],
    });
    const userMapping = await mappingOf(db, USER_ID);

    assert.equal(batch.gate(USER_ID, SERVER_ID).analyticsId, userMapping);
    assert.deepEqual(batch.gate(OWNER_ID, SERVER_ID), { recordAllowed: true, analyticsId: null, clientEventsAllowed: false });
    assert.deepEqual(batch.gate(USER_ID, OFF_SERVER), { recordAllowed: false, analyticsId: null, clientEventsAllowed: false });
    // An agent's action: no human key, still counted for an enabled workspace.
    assert.deepEqual(batch.gate(null, SERVER_ID), { recordAllowed: true, analyticsId: null, clientEventsAllowed: false });
    assert.equal(batch.gate(null, OFF_SERVER).recordAllowed, false);
  } finally {
    await client.close();
  }
});

test("deleting a user deletes their mapping", async () => {
  const { client, db } = await fixture();
  try {
    await client.exec(`DELETE FROM "users" WHERE "id" = '${USER_ID}'`);
    assert.equal(await mappingOf(db, USER_ID), null);
  } finally {
    await client.close();
  }
});

test("0321 gives every existing user an analytics id", async () => {
  // Migrate to just before 0321, add users, then apply 0321.
  const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const journal = JSON.parse(await readFile(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const target = journal.entries.findIndex((entry) => entry.tag === "0321_product_analytics_gate");
  assert.ok(target > 0);
  const partialDir = await mkdtemp(path.join(tmpdir(), "drizzle-0321-"));
  const client = new PGlite();
  try {
    await cp(drizzleDir, partialDir, { recursive: true });
    await writeFile(
      path.join(partialDir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, target) }),
    );
    await migratePglite(client, partialDir);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
        ('${USER_ID}', 'analytics-backfill-a@slock.test', 'analytics-backfill-a', 'test'),
        ('${OWNER_ID}', 'analytics-backfill-b@slock.test', 'analytics-backfill-b', 'test');
    `);

    await writeFile(path.join(partialDir, "meta", "_journal.json"), JSON.stringify(journal));
    await migratePglite(client, partialDir);

    const mapped = await client.query<{ user_id: string; analytics_id: string }>(
      `SELECT "user_id", "analytics_id" FROM "user_analytics_ids" ORDER BY "user_id"`,
    );
    assert.deepEqual(mapped.rows.map((row) => row.user_id), [USER_ID, OWNER_ID]);
    assert.equal(new Set(mapped.rows.map((row) => row.analytics_id)).size, 2);
    for (const row of mapped.rows) assert.notEqual(row.analytics_id, row.user_id);
  } finally {
    await client.close();
    await rm(partialDir, { recursive: true, force: true });
  }
});
