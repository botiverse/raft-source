// Real-PostgreSQL teeth for the owner's public search switch (PATCH /api/servers/:id/public-search,
// public server SEO step 1). The request-level owner check runs before the write, so a second owner
// demoted in between must not be able to re-enable indexing: the write re-authorizes under the actor
// membership fence. PGlite runs one transaction at a time, so the demotion is held uncommitted in a
// second session while the real HTTP request runs; waiting is proven from pg_stat_activity, not timing.
//
// CI: `pnpm --filter @botiverse/raft-server test:actor-membership-fence-real-pg`, with
// ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { getDb } from "../db/index";
import { featureFlags, serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: TEST_TIMEOUT_MS };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;

async function withRealPgApp(run: (app: TestApp, observer: pg.Pool) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is required");
  const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  try {
    await migrateRealPgTestDatabase(observer, MIGRATIONS_FOLDER);
    const app = await openTestApp(REAL_PG_URL, 0, {
      humanActivityMuteFlagDefaultEnabled: true,
      skipAuthRateLimit: true,
    });
    try {
      await run(app, observer);
    } finally {
      await app.close();
    }
  } finally {
    await observer.end();
  }
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `public-search-fence-${label}-${suffix}@slock.test`,
    name: `public-search-fence-${label}-${suffix}`,
    displayName: `public-search-fence-${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A public server with search turned off and two owners; the second one is the actor. */
async function seed() {
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
  const creator = await seedUser("creator");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const server = await createServer(`Public Search Fence ${suffix}`, `public-search-fence-${suffix}`, creator.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: actor.id, role: "owner" });
  await getDb().update(servers).set({ publiclyVisible: true, publicSearchEnabled: false }).where(eq(servers.id, server.id));
  return { server, actor, token: await tokenForHuman(actor.email) };
}

async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

/** Holds `role` on the actor's member row uncommitted, sends the PATCH, requires it to wait in the fence, commits. */
async function patchDuringRoleChange(app: TestApp, observer: pg.Pool, seeded: Awaited<ReturnType<typeof seed>>, role: string) {
  const session = await observer.connect();
  let response: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
  const state = { settled: false };
  try {
    await session.query("BEGIN");
    const { rows: [holder] } = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await session.query("UPDATE server_members SET role = $3 WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.actor.id, role]);
    response = fetch(`${app.baseUrl}/api/servers/${seeded.server.id}/public-search`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${seeded.token}`, "X-Server-Id": seeded.server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ publicSearchEnabled: true }),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }));
    response.then(() => { state.settled = true; }, () => { state.settled = true; });
    await waitForLockWaiter(observer, "%from server_members%for share%", holder!.pid);
    assert.equal(state.settled, false, "the write must wait in the membership fence for the uncommitted role change");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  return await response!;
}

async function searchEnabled(serverId: string) {
  const [row] = await getDb().select({ on: servers.publicSearchEnabled }).from(servers).where(eq(servers.id, serverId));
  return row?.on;
}

test("real PG route: an owner demoted while PATCH public-search is in flight is refused and indexing stays off", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const res = await patchDuringRoleChange(app, observer, seeded, "admin");
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(await searchEnabled(seeded.server.id), false, "the demoted owner could not re-enable indexing");
  });
});

test("real PG route: an owner whose row is only re-written while PATCH public-search is in flight still succeeds", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seed();
    const res = await patchDuringRoleChange(app, observer, seeded, "owner");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await searchEnabled(seeded.server.id), true);
  });
});
