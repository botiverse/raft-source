import { dbTest as test } from "../test/integration/dbTest";
/**
 * Plans of the Tasks page's sorted board walks (GET /api/tasks/server?sort=),
 * on the statement the walk really runs (taskService.sortedServerTaskPageQuery):
 *  - per channel, sort=activity (and activity_asc, backward) reads
 *    idx_tasks_channel_activity and
 *    sort=created idx_tasks_channel_created in order, first page and resumed
 *    page alike: the ORDER BY and the keyset bound use exactly the indexes'
 *    key expressions (COALESCE(last_activity_at, updated_at) for activity);
 *  - an assigned_to_me / created_by_me lane reads the person's rows through
 *    idx_tasks_claimed_by / idx_tasks_created_by instead of every channel.
 * Sorts are priced out (enable_sort = off) so a plan that would sort a
 * channel's rows instead of reading the index in order loses; sequential
 * scans likewise. On these tiny tables that is how the test tells "the index
 * can serve this statement" from "the planner happened to prefer it".
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import * as channelService from "./channelService";
import { createServer } from "./serverService";
import { resolveTaskChannelSurface, type TaskChannelSurface } from "./taskChannelSurface";
import * as taskService from "./taskService";

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function buildBoard() {
  const me = await seedUser("plan-me");
  const server = await createServer("Sorted Walk Plans", `sorted-walk-plans-${randomUUID().slice(0, 8)}`, me.id);
  const surfaces: TaskChannelSurface[] = [];
  for (const name of ["plan-alpha", "plan-beta"]) {
    const channel = await channelService.createChannel(server.id, name);
    await channelService.addHuman(channel.id, me.id);
    await taskService.createTasks(channel.id, "user", me.id, [{ title: `${name} 1` }, { title: `${name} 2` }, { title: `${name} 3` }]);
    const surface = await resolveTaskChannelSurface(server.id, channel.id);
    assert.ok(surface, name);
    surfaces.push(surface);
  }
  return { me, surfaces };
}

/** EXPLAIN `query` with sorts and sequential scans priced out, after `prepare`; everything rolled back. */
async function plan(query: SQL, prepare: string[] = []): Promise<string> {
  let text = "";
  await getDb().transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
    await tx.execute(sql.raw("SET LOCAL enable_sort = off"));
    for (const statement of prepare) await tx.execute(sql.raw(statement));
    const result = await tx.execute(sql`EXPLAIN ${query}`);
    text = result.rows.map((row) => Object.values(row as Record<string, unknown>)[0]).join("\n");
    tx.rollback();
  }).catch((error: unknown) => {
    if (!(error instanceof TransactionRollbackError)) throw error;
  });
  return text;
}

test("sort=activity, activity_asc and created read each channel's sort index in order, first and resumed pages", async ({ db: _db }) => {
  const { me, surfaces } = await buildBoard();
  const after = (sort: "activity" | "activity_asc" | "created"): taskService.ServerTasksSortedCursor => ({
    sort,
    key: "2026-11-09T10:00:00.123456Z",
    taskId: randomUUID(),
    channelId: surfaces[0]!.localChannel.id,
  });
  for (const [sort, index] of [["activity", "idx_tasks_channel_activity"], ["activity_asc", "idx_tasks_channel_activity"], ["created", "idx_tasks_channel_created"]] as const) {
    for (const cursor of [null, after(sort)]) {
      const query = taskService.sortedServerTaskPageQuery(surfaces, undefined, { statuses: ["todo", "in_progress"] }, me.id, sort, { after: cursor, limit: 51 });
      const text = await plan(query);
      // activity_asc reads the same index, the other way.
      assert.match(text, new RegExp(`Index Scan (?:Backward )?using ${index} on tasks`), `${sort}${cursor ? " resumed" : ""}:\n${text}`);
    }
  }
});

test("an assigned_to_me / created_by_me lane reads the person's rows through the claimer / creator index", async ({ db: _db }) => {
  const { me, surfaces } = await buildBoard();
  // Without the channel-leading indexes the only cheap way to the rows is the
  // person's index, which the relation predicate must be able to use (no
  // COALESCE around the claimer match). Dropped in the rolled-back transaction.
  const dropChannelIndexes = [
    "idx_tasks_channel_activity",
    "idx_tasks_channel_created",
    "idx_tasks_channel_number",
    "idx_tasks_channel_status",
  ].map((name) => `DROP INDEX "${name}"`);
  for (const [relation, index] of [["assigned_to_me", "idx_tasks_claimed_by"], ["created_by_me", "idx_tasks_created_by"]] as const) {
    const query = taskService.sortedServerTaskPageQuery(surfaces, undefined, { relation }, me.id, "activity", { limit: 51 });
    // One join, not a LATERAL per channel.
    assert.doesNotMatch(new PgDialect().sqlToQuery(query).sql, /LATERAL \(\s*SELECT "tasks"/, relation);
    const text = await plan(query, dropChannelIndexes);
    assert.match(text, new RegExp(index), `${relation}:\n${text}`);
  }
});
