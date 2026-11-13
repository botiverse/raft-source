import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import * as schema from "../db/schema";
import { openTestApp } from "../test/integration/app";
import {
  assertNoChannelsCapabilityParity,
  assertUserChannelsParity,
  seedUserChannelsScenario,
  userChannelsCases,
} from "./internalAgentApi.userChannels.testkit";

const REAL_PG_URL_ENV = "USER_CHANNELS_REAL_PG_URL";
const DATABASE_URL = process.env[REAL_PG_URL_ENV];
const REQUIRED = process.env.USER_CHANNELS_REAL_PG_REQUIRED === "1";
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

test(
  "real PG: users.info over GET /users/:name/channels equals server.info + one roster per channel but for Q3, Q1, Q2 (every caller, subject, window)",
  {
    skip: !(DATABASE_URL || REQUIRED),
    timeout: 1_200_000,
  },
  async () => {
    assert.ok(DATABASE_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_user_channels_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: DATABASE_URL,
      application_name: "user-channels-real-pg-admin",
    });
    let setupPool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(DATABASE_URL, databaseName);
      setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "user-channels-real-pg-setup",
        max: 2,
      });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;

      app = await openTestApp(testUrl, 0, {
        humanActivityMuteFlagDefaultEnabled: true,
        skipAuthRateLimit: true,
      });
      const scenario = await seedUserChannelsScenario();

      const visible = await assertUserChannelsParity(app.baseUrl, scenario, "real PG visible directory");
      assert.ok(visible.memberships >= 30, `memberships ${visible.memberships}`);
      assert.ok(visible.skipped > 0 && visible.notFound > 0);
      // Q3 is exercised: namesake-only joints dropped (agents; human names are
      // unique), own joints listed for both kinds.
      assert.equal(visible.jointNamesakeOnly.human, 0);
      assert.ok(visible.jointNamesakeOnly.agent > 0, JSON.stringify(visible.jointNamesakeOnly));
      assert.ok(visible.jointSelfMember.agent > 0 && visible.jointSelfMember.human > 0, JSON.stringify(visible.jointSelfMember));
      // Q1: every listed row lost the caller's fields; the subjects' own roles
      // (member and admin) are reported. Q2: the built-in conversations
      // `#system.canary` decided by the regular twin's roster are dropped.
      assert.equal(visible.callerFieldRows, visible.memberships);
      assert.ok(visible.subjectRoles.admin > 0 && visible.subjectRoles.member > 0, JSON.stringify(visible.subjectRoles));
      assert.ok(visible.builtInListed > 0, `builtInListed ${visible.builtInListed}`);
      assert.equal(await assertNoChannelsCapabilityParity(app.baseUrl, scenario, "real PG visible directory"), 3);

      // A hidden directory changes who is visible (humans) and who a roster lists.
      await scenario.setHumanDirectoryHidden(true);
      const hidden = await assertUserChannelsParity(app.baseUrl, scenario, "real PG hidden directory", userChannelsCases(scenario, "humans"));
      assert.ok(hidden.notFound > 0);
      await assertNoChannelsCapabilityParity(app.baseUrl, scenario, "real PG hidden directory");

      // A hidden #all (private "all") the admin agent is in never resolves as a roster.
      await scenario.setHumanDirectoryHidden(false);
      await scenario.hideAllChannelForAdmin();
      const hiddenAll = await assertUserChannelsParity(app.baseUrl, scenario, "real PG hidden #all", [
        { subjects: ["Scout", "alice"], windows: [{ offset: 0, limit: 3 }] },
      ], [scenario.callers[0]]);
      assert.ok(hiddenAll.skipped >= 2);

      // Q2: without the twin, `#system.canary` resolves nothing; the old
      // algorithm skipped every built-in conversation, the route inspects it.
      await scenario.removeAppTwin();
      const noTwin = await assertUserChannelsParity(app.baseUrl, scenario, "real PG no app twin", userChannelsCases(scenario));
      assert.ok(noTwin.builtInSkipped > 0, `builtInSkipped ${noTwin.builtInSkipped}`);
      assert.ok(noTwin.skipped > 0);
      assert.equal(await assertNoChannelsCapabilityParity(app.baseUrl, scenario, "real PG no app twin"), 3);
    } finally {
      await app?.close();
      await setupPool?.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
