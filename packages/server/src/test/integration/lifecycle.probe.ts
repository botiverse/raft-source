// Executed only by lifecycle.contract.test.ts with its own Vitest config.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { apiTest } from "./apiTest.js";
import { isDatabaseInitialized, registerDatabaseCloseHookForTests } from "../../db/index.js";
import { openTestDatabase } from "./database.js";

const mode = process.env.INTEGRATION_PROBE;
let previousApp: { server: { listening: boolean } } | undefined;
let laterResourceClosed = false;

const probe = apiTest.extend<{ setupFailure: void }>({
  setupFailure: async ({ app }, use) => {
    previousApp = app;
    if (mode === "setup") throw new Error("probe setup failed");
    await use();
  },
});

afterEach(({ task }) => {
  if (task.name === "predecessor" && mode === "afterEach") throw new Error("probe afterEach failed");
});

probe("predecessor", async ({ app, db, lifecycle, setupFailure, skip }) => {
  void setupFailure;
  previousApp = app;
  await db.execute(sql`CREATE TABLE integration_late_write (id integer)`);
  if (mode === "skip") skip();
  if (mode === "cleanup") {
    lifecycle.own(async () => { laterResourceClosed = true; });
    lifecycle.own(async () => { throw new Error("probe cleanup failed"); });
  } else if (mode === "background") {
    const unregister = registerDatabaseCloseHookForTests(async () => {
      unregister();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(app.server.listening, false, "stop HTTP before joining late SQL work");
      await db.execute(sql`INSERT INTO integration_late_write VALUES (1)`);
      laterResourceClosed = true;
    });
  } else if (mode !== "afterEach") {
    assert.fail("probe assertion failed");
  }
});

apiTest("successor", async ({ db }) => {
  assert.equal(previousApp?.server.listening, false);
  assert.deepEqual((await db.execute(sql`SELECT to_regclass('integration_late_write') AS residue`)).rows, [{ residue: null }]);
  if (mode === "background") assert.equal(laterResourceClosed, true);
  await assert.rejects(openTestDatabase(), /Close the current/);
});

// Uses ordinary Vitest afterAll because a poisoned integration scope refuses entry.
import { afterAll } from "vitest";
afterAll(() => {
  assert.equal(isDatabaseInitialized(), false);
  assert.equal(previousApp?.server.listening, false);
  if (mode === "cleanup") assert.equal(laterResourceClosed, true, "continue cleanup after an earlier closer fails");
  assert.ok(process.env.INTEGRATION_WITNESS);
  writeFileSync(process.env.INTEGRATION_WITNESS, "closed");
});
