// Real PostgreSQL teeth for single-use private share links (#proj-apps:769a57d4).
// PGlite serializes transactions on one connection, so shareLinkTarget.api.test.ts
// can only line two installs up one after the other; here they run on separate
// connections and really race:
// - a blocker holds the App row FOR UPDATE, so both installs read the link as
//   active and then wait inside their transactions (on the App row they read
//   FOR SHARE); releasing it lets them run together;
// - the install transaction locks the link row FOR UPDATE and rechecks it is
//   still active, so exactly one installs and spends the link; the other gets
//   the bad-token answer (404 private_app_invite_invalid) and records nothing.
// Without that lock both would answer 200 for one single-use link.
//
// Default-skipped. Run it with a server you can create tables in:
//   SHARE_LINK_TARGET_REAL_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//     pnpm --filter @botiverse/raft-server test:share-link-target-real-pg
// CI: `probe-concurrency-real-pg`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClientInstalls, oauthClientShareLinks, users } from "../db/schema";
import { accessTokenForTest } from "../test/integration/credentials";
import { createOAuthClient, createOAuthClientShareLink } from "../services/oauthService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { expectedAppPermissionsBody } from "../test/integration/appPermissions";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";

const test = createApiTest();

const REAL_PG_URL = process.env.SHARE_LINK_TARGET_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.SHARE_LINK_TARGET_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };

const INVALID_INVITE = { error: "This private app invite is invalid or has expired", code: "private_app_invite_invalid" };

/** Polls until `count` backends of this database wait on a heavyweight lock. */
async function waitForLockWaiters(count: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(rows[0]!.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s)`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("real PG: two installs racing on one link: exactly one installs, the other gets the invalid answer, the link is spent once", REAL_PG_TEST, async () => {
  assert.ok(REAL_PG_URL, "SHARE_LINK_TARGET_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, { skipAuthRateLimit: true });
  const blocker = new pg.Client({ connectionString: REAL_PG_URL });
  blocker.on("error", () => {});
  await blocker.connect();
  try {
    const suffix = randomUUID().slice(0, 8);
    const [owner, installer] = await getDb().insert(users).values([
      { name: `share-owner-${suffix}`, email: `share-owner-${suffix}@raft.test`, passwordHash: "fixture-value-not-a-credential", emailVerified: true, profileSetupCompletedAt: new Date() },
      { name: `share-installer-${suffix}`, email: `share-installer-${suffix}@raft.test`, passwordHash: "fixture-value-not-a-credential", emailVerified: true, profileSetupCompletedAt: new Date() },
    ]).returning();
    const source = await createServer("Share Source", `share-source-${suffix}`, owner!.id);
    const target = await createServer("Share Target", `share-target-${suffix}`, installer!.id);
    const { client } = await createOAuthClient({
      serverId: source.id,
      createdByUserId: owner!.id,
      clientId: `share-race-${suffix}`,
      name: "Race App",
      allowedScopes: ["openid", "profile"],
    });
    const share = await createOAuthClientShareLink({
      serverId: source.id,
      clientId: client.id,
      targetServerSlug: target.slug,
      createdByUserId: owner!.id,
    });
    assert.ok(share);
    const body = JSON.stringify({ serverId: target.id, ...await expectedAppPermissionsBody(client.id) });
    const install = async () => {
      const res = await fetch(`${app.baseUrl}/api/integration-invites/${share.token}/install`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessTokenForTest(installer!.id)}`, "Content-Type": "application/json" },
        body,
      });
      return { status: res.status, json: await res.json() as unknown };
    };

    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM oauth_clients WHERE id = $1 FOR UPDATE", [client.id]);
    const racing = [install(), install()];
    // Both have read the link as active and now wait inside their transactions.
    await waitForLockWaiters(2);
    await blocker.query("COMMIT");
    const results = await Promise.all(racing);

    assert.deepEqual(results.map((result) => result.status).sort(), [200, 404], JSON.stringify(results));
    assert.deepEqual(results.find((result) => result.status === 404)!.json, INVALID_INVITE);
    const [link] = await getDb().select().from(oauthClientShareLinks).where(eq(oauthClientShareLinks.id, share.link.id));
    assert.ok(link?.consumedAt, "the link is spent");
    assert.ok(link?.revokedAt);
    const installs = await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
      .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, target.id)));
    assert.equal(installs.length, 1);
    const installed = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "private_share.installed")));
    assert.equal(installed.length, 1, "one redemption recorded");

    // And afterwards the link stays spent.
    const again = await install();
    assert.equal(again.status, 404);
    assert.deepEqual(again.json, INVALID_INVITE);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end().catch(() => {});
    await app.close();
  }
});
