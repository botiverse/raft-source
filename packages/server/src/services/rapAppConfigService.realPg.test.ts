import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { getRapAppConfig, patchRapAppConfig, RapAppConfigError } from "./rapAppConfigService.js";

const REAL_PG_URL_ENV = "RAP_APP_CONFIG_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.RAP_APP_CONFIG_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForTwoBlockedWriters(observer: pg.Client): Promise<number[]> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await observer.query<{ pid: number }>(`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'rap-app-config-service'
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%rap_app_configs%'
      ORDER BY pid
    `);
    if (result.rows.length === 2) return result.rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("two independent config writers did not reach the database lock concurrently");
}

test(
  "two real PostgreSQL connections racing revision zero commit exactly one config revision",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `rap_config_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "rap-app-config-admin" });
    await admin.connect();

    let blocker: pg.Client | undefined;
    let observer: pg.Client | undefined;
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "rap-app-config-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 1 });
      await migrate(drizzle(migrationPool), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();

      const serviceUrl = databaseUrlFor(REAL_PG_URL, databaseName, "rap-app-config-service");
      await initDatabase(serviceUrl);
      const db = getDb();
      const ownerId = randomUUID();
      const serverId = randomUUID();
      const agentId = randomUUID();
      await db.insert(users).values({
        id: ownerId,
        email: `${ownerId}@config.test`,
        name: `owner-${ownerId}`,
        passwordHash: "hash",
        emailVerified: true,
      });
      await db.insert(servers).values({ id: serverId, name: "Config", slug: `config-${serverId}`, ownerId });
      await db.insert(agents).values({ id: agentId, serverId, name: `agent-${agentId}`, runtime: "codex" });

      const blockerUrl = databaseUrlFor(REAL_PG_URL, databaseName, "rap-app-config-blocker");
      blocker = new pg.Client({ connectionString: blockerUrl });
      observer = new pg.Client({ connectionString: blockerUrl.replace("rap-app-config-blocker", "rap-app-config-observer") });
      await blocker.connect();
      await observer.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE rap_app_configs IN ACCESS EXCLUSIVE MODE");

      const writes = [131_072, 262_144].map((thresholdBytes) => patchRapAppConfig({
        serverId,
        subjectAgentId: agentId,
        appId: "system.cleaner",
        expectedRevision: 0,
        set: { threshold_bytes: thresholdBytes },
        unset: [],
      }));
      const blockedPids = await waitForTwoBlockedWriters(observer);
      assert.equal(new Set(blockedPids).size, 2, "writers must occupy two distinct PostgreSQL backends");

      await blocker.query("COMMIT");
      const results = await Promise.allSettled(writes);
      const committed = results.filter((result) => result.status === "fulfilled");
      const stale = results.filter((result) => result.status === "rejected");
      assert.equal(committed.length, 1);
      assert.equal(stale.length, 1);
      assert.ok(
        stale[0].status === "rejected"
          && stale[0].reason instanceof RapAppConfigError
          && stale[0].reason.code === "RAP_APP_CONFIG_REVISION_STALE"
          && stale[0].reason.currentRevision === 1,
      );
      const stored = await getRapAppConfig({ serverId, subjectAgentId: agentId, appId: "system.cleaner" });
      assert.equal(stored.revision, 1);
      assert.ok(stored.effective.threshold_bytes === 131_072 || stored.effective.threshold_bytes === 262_144);
    } finally {
      await blocker?.query("ROLLBACK").catch(() => {});
      await blocker?.end().catch(() => {});
      await observer?.end().catch(() => {});
      await closeDatabase().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);
