import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { dbTest } from "./dbTest.js";
import { apiTest } from "./apiTest.js";
import { getDb, isDatabaseInitialized } from "../../db/index.js";
import { featureFlags, users } from "../../db/schema.js";
import { ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY } from "../../services/featureFlagService.js";
import { eq } from "drizzle-orm";

// Expected assertion failure deliberately exercises the real runner's teardown.
// The next case is the witness: a green body alone cannot prove isolation.
apiTest.fails("a failed case leaves rows, DDL, session state and flags behind", async ({ db, app, seed }) => {
  assert.equal(app.server.listening, true);
  assert.equal((await db.select().from(featureFlags).where(eq(featureFlags.key, ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY)))[0].defaultEnabled, true);
  await seed.human();
  await db.execute(sql`CREATE TABLE integration_case_residue (id serial PRIMARY KEY)`);
  await db.execute(sql`INSERT INTO integration_case_residue DEFAULT VALUES`);
  await db.execute(sql`CREATE TEMP TABLE integration_temp_residue (id integer)`);
  await db.execute(sql`SET application_name = 'previous-case'`);
  await db.update(featureFlags).set({ defaultEnabled: false });
  assert.fail("deliberate predecessor failure");
});

dbTest("the next case restores the migrated baseline, including unknown tables and session state", async ({ db }) => {
  assert.deepEqual(await db.select().from(users), []);
  assert.equal((await db.select().from(featureFlags).where(eq(featureFlags.key, ONBOARDING_OPENER_V2_FEATURE_FLAG_KEY)))[0].defaultEnabled, true);
  const result = await db.execute(sql`SELECT to_regclass('integration_case_residue') AS permanent,
    to_regclass('integration_temp_residue') AS temporary, current_setting('application_name') AS application`);
  assert.deepEqual(result.rows, [{ permanent: null, temporary: null, application: "" }]);
  // A new serial sequence starts at its declared value, never the predecessor's.
  await db.execute(sql`CREATE TABLE integration_case_residue (id serial PRIMARY KEY)`);
  assert.deepEqual((await db.execute(sql`INSERT INTO integration_case_residue DEFAULT VALUES RETURNING id`)).rows, [{ id: 1 }]);
});

dbTest("ordinary commits persist and a real inner transaction rolls back only its writes", async ({ db }) => {
  await db.execute(sql`CREATE TABLE integration_commit_probe (id integer PRIMARY KEY)`);
  await db.execute(sql`INSERT INTO integration_commit_probe VALUES (1)`);
  await assert.rejects(db.transaction(async tx => {
    await tx.execute(sql`INSERT INTO integration_commit_probe VALUES (2)`);
    throw new Error("abort transaction");
  }), /abort transaction/);
  assert.deepEqual((await db.execute(sql`SELECT id FROM integration_commit_probe`)).rows, [{ id: 1 }]);
});

dbTest("DB-only cases do not acquire an app or a database unless requested", async () => {
  assert.equal(isDatabaseInitialized(), false);
  assert.throws(getDb, /not initialized/);
});
