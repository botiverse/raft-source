// Core's per-app search timeout on a real PostgreSQL (PGlite runs no
// statement timer, so search.api.test.ts can only raise the error Postgres
// raises): an app's statement that runs past APP_SEARCH_STATEMENT_TIMEOUT_MS
// is cut off by Postgres and answers `{ error: "timeout" }`, through the
// executor core hands the app and through getDb() inside it alike (the
// ambient transaction); another app's search, run at the same time, answers
// at once; the timeout is SET LOCAL, so the pool's connections keep their own.
//
// Runs when APP_SEARCH_REAL_PG_URL is set (an admin URL; a database is
// created and dropped), and fails without it when
// APP_SEARCH_REAL_PG_REQUIRED=1.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { asServerId } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import type { AppSearchInput, FirstPartyApp } from "../platform/apps";
import { APP_SEARCH_STATEMENT_TIMEOUT_MS, searchApp } from "./search";

const REAL_PG_URL_ENV = "APP_SEARCH_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.APP_SEARCH_REAL_PG_REQUIRED === "1";

const testApp = (id: string, search: NonNullable<FirstPartyApp["search"]>): { app: FirstPartyApp; search: NonNullable<FirstPartyApp["search"]> } =>
  ({ app: { id, flag: "unused", objectKinds: [], systemApp: `system.${id}`, search }, search });

const input: Omit<AppSearchInput, "executor"> = {
  viewer: { userId: "00000000-0000-0000-0000-000000000001", serverId: asServerId("00000000-0000-0000-0000-000000000002") },
  q: "plans",
  cursor: null,
  limit: 20,
  visibleHomesSql: () => sql`FALSE`,
};

test(
  "real PostgreSQL: a search statement past the timeout is cut off and its group is a timeout; the other app answers at once",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 60_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_app_search_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "app-search-admin" });
    let initialized = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(REAL_PG_URL);
      url.pathname = `/${databaseName}`;
      await initDatabase(url.toString(), undefined, { log: () => {} });
      initialized = true;

      const sleeper = testApp("sleeper", async ({ executor }) => {
        await executor.execute(sql`SELECT pg_sleep(30)`);
        return { kind: "page", items: [], nextCursor: null };
      });
      const ambient = testApp("ambient", async () => {
        await getDb().execute(sql`SELECT pg_sleep(30)`);
        return { kind: "page", items: [], nextCursor: null };
      });
      let quickAt = 0;
      const quick = testApp("quick", async ({ executor }) => {
        const [row] = (await executor.execute(sql`SELECT current_setting('statement_timeout') AS timeout`)).rows as Array<{ timeout: string }>;
        assert.equal(row!.timeout, `${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms`);
        quickAt = Date.now();
        return { kind: "page", items: [], nextCursor: null };
      });

      const started = Date.now();
      const [slow, viaAmbient, fast] = await Promise.all([sleeper, ambient, quick].map(({ app, search }) => searchApp(app, search, input).then((answer) => ({ answer, at: Date.now() }))));
      assert.deepEqual(slow!.answer, { kind: "error", error: "timeout" });
      assert.deepEqual(viaAmbient!.answer, { kind: "error", error: "timeout" });
      assert.deepEqual(fast!.answer, { kind: "page", items: [], nextCursor: null });
      for (const cut of [slow!, viaAmbient!]) {
        const took = cut.at - started;
        assert.ok(took >= APP_SEARCH_STATEMENT_TIMEOUT_MS - 50 && took < APP_SEARCH_STATEMENT_TIMEOUT_MS + 3_000, `cut off after ${took} ms`);
      }
      assert.ok(quickAt - started < APP_SEARCH_STATEMENT_TIMEOUT_MS, "the quick app was not held by the slow ones");

      // SET LOCAL: no connection of the pool keeps the search's timeout.
      const settings = await Promise.all([0, 1, 2, 3].map(() => getDb().execute(sql`SELECT current_setting('statement_timeout') AS timeout`)));
      for (const result of settings) assert.notEqual((result.rows[0] as { timeout: string }).timeout, `${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms`);
    } finally {
      if (initialized) await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
