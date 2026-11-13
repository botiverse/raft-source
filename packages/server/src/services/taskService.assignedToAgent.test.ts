import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { channelConversionJobs, jointChannels, jointChannelServers, tasks, users } from "../db/schema";
import { conversionReadChannelPredicate } from "./channelConversionReadScope";
import * as channelService from "./channelService";
import { createServer } from "./serverService";
import * as taskService from "./taskService";

/**
 * listTasksAssignedToAgent used to test storage equivalence per task row and
 * caller-supplied id (a correlated lateral), which timed out for agents in
 * 100+ channels. It now expands each supplied id once and joins on
 * channel_id. The result must not change: the earliest supplied id that
 * matches a task stays its surface, and nothing outside the supplied ids'
 * equivalence sets is returned.
 */

/** The pre-expansion lateral query, kept here as the equivalence oracle. */
async function lateralOracle(visibleChannelIds: string[], agentId: string, statusFilter?: "all") {
  const db = getDb();
  if (visibleChannelIds.length === 0) return [];
  const readSurface = db.select({
    channelId: sql<string>`requested.id`.as("read_channel_id"),
  }).from(sql`unnest(ARRAY[${sql.join(visibleChannelIds.map(id => sql`${id}::uuid`), sql`, `)}]) WITH ORDINALITY AS requested(id, position)`)
    .where(conversionReadChannelPredicate(tasks.channelId, sql`requested.id`))
    .orderBy(sql`requested.position`).limit(1).as("authorized_task_surface");
  const conditions: SQL[] = [eq(tasks.claimedByType, "agent"), eq(tasks.claimedById, agentId)];
  if (!statusFilter) conditions.push(inArray(tasks.status, ["todo", "in_progress", "in_review"]));
  const rows = await db
    .select({ id: tasks.id, readChannelId: readSurface.channelId })
    .from(tasks)
    .innerJoinLateral(readSurface, sql`true`)
    .where(and(...conditions))
    .orderBy(asc(tasks.channelId), asc(tasks.taskNumber), asc(tasks.id));
  return rows.map(row => ({ id: row.id, channelId: row.readChannelId }));
}

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function buildFixture() {
  const db = getDb();
  const agentId = randomUUID();
  const owner = await seedUser(`assigned-owner-${randomUUID().slice(0, 8)}`);
  const peerOwner = await seedUser(`assigned-peer-${randomUUID().slice(0, 8)}`);
  const host = await createServer("Assigned Host", `assigned-host-${randomUUID().slice(0, 8)}`, owner.id);
  const peer = await createServer("Assigned Peer", `assigned-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);

  const open = await channelService.createChannel(host.id, "a-open");
  const other = await channelService.createChannel(host.id, "b-other");
  const hidden = await channelService.createChannel(host.id, "c-hidden");
  // Converted joint: tasks live in canonical storage; the host projection is
  // the conversion source, so the two are one equivalence set.
  const canonical = await channelService.createChannel(host.id, "d-joint-storage");
  const hostJoint = await channelService.createChannel(host.id, "e-joint", undefined, "joint");
  const peerJoint = await channelService.createChannel(peer.id, "e-joint", undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: host.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostJoint.id, role: "host", joinedByUserId: owner.id },
    { jointChannelId: joint!.id, serverId: peer.id, localChannelId: peerJoint.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await channelService.addHuman(hostJoint.id, owner.id);
  await db.insert(channelConversionJobs).values({
    serverId: host.id,
    sourceChannelId: hostJoint.id,
    sourceChannelType: "channel",
    status: "done",
    phase: "done",
    state: "succeeded",
    canonicalChannelId: canonical.id,
    jointChannelId: joint!.id,
    createdByUserId: owner.id,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    completedAt: new Date("2026-08-20T00:01:00.000Z"),
  });

  const created = async (channelId: string, titles: string[]) =>
    (await taskService.createTasks(channelId, "user", owner.id, titles.map(title => ({ title })))).tasks;
  const [openTask, openDone] = await created(open.id, ["open-1", "open-done"]);
  const [otherTask] = await created(other.id, ["other-1"]);
  const [hiddenTask] = await created(hidden.id, ["hidden-1"]);
  const [jointTask] = await created(canonical.id, ["joint-1"]);
  const [sourceTask] = await created(hostJoint.id, ["pre-conversion source row"]);
  await db.update(tasks).set({ taskNumber: 100 }).where(eq(tasks.id, sourceTask!.id));
  const [notMine] = await created(open.id, ["someone else"]);

  const mine = [openTask, openDone, otherTask, hiddenTask, jointTask, sourceTask].map(task => task!.id);
  await db.update(tasks).set({ claimedByType: "agent", claimedById: agentId }).where(inArray(tasks.id, mine));
  await db.update(tasks).set({ claimedByType: "agent", claimedById: randomUUID() }).where(eq(tasks.id, notMine!.id));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, openDone!.id));

  return { agentId, open, other, hidden, canonical, hostJoint, peerJoint, openTask, openDone, otherTask, hiddenTask, jointTask, sourceTask };
}

async function surfaces(visibleChannelIds: string[], agentId: string, statusFilter?: "all") {
  const rows = await taskService.listTasksAssignedToAgent(visibleChannelIds, agentId, statusFilter);
  return rows.map(row => ({ id: row.id, channelId: row.channelId }));
}

test("assigned-task surfaces equal the lateral algorithm for every input order", async ({ db: _db }) => {
  const f = await buildFixture();
  const inputs: string[][] = [
    [f.open.id, f.other.id, f.hostJoint.id, f.canonical.id],
    [f.canonical.id, f.hostJoint.id, f.other.id, f.open.id],
    [f.hostJoint.id, f.open.id],
    [f.canonical.id],
    [f.peerJoint.id, f.open.id],
    [f.open.id, f.open.id],
  ];
  for (const input of inputs) {
    for (const status of [undefined, "all"] as const) {
      assert.deepEqual(await surfaces(input, f.agentId, status), await lateralOracle(input, f.agentId, status), `${input.length} ids ${status}`);
    }
  }
});

test("a task matching several supplied ids takes the earliest one as its surface", async ({ db: _db }) => {
  const f = await buildFixture();
  const surfaceOf = async (input: string[], taskId: string) =>
    (await surfaces(input, f.agentId)).find(row => row.id === taskId)?.channelId;

  // Canonical storage and its conversion source are one equivalence set, so
  // both supplied ids match both rows; input order alone decides the surface.
  assert.equal(await surfaceOf([f.hostJoint.id, f.canonical.id], f.jointTask!.id), f.hostJoint.id);
  assert.equal(await surfaceOf([f.canonical.id, f.hostJoint.id], f.jointTask!.id), f.canonical.id);
  assert.equal(await surfaceOf([f.hostJoint.id, f.canonical.id], f.sourceTask!.id), f.hostJoint.id);
  assert.equal(await surfaceOf([f.canonical.id, f.hostJoint.id], f.sourceTask!.id), f.canonical.id);
  // Each task appears once even when several supplied ids match it.
  const both = await surfaces([f.hostJoint.id, f.canonical.id, f.hostJoint.id], f.agentId);
  assert.equal(both.length, new Set(both.map(row => row.id)).size);
});

test("equivalence expansion never reaches channels outside the supplied ids", async ({ db: _db }) => {
  const f = await buildFixture();

  const openOnly = await surfaces([f.open.id], f.agentId, "all");
  assert.deepEqual(openOnly.map(row => row.id).sort(), [f.openTask!.id, f.openDone!.id].sort());

  // The participant projection of the joint is not part of the host's
  // storage equivalence, so supplying it exposes neither the canonical
  // storage nor the host-side source rows.
  assert.deepEqual(await surfaces([f.peerJoint.id], f.agentId, "all"), []);

  const ids = (await surfaces([f.open.id, f.other.id, f.hostJoint.id], f.agentId, "all")).map(row => row.id);
  assert.ok(!ids.includes(f.hiddenTask!.id), "a channel not supplied must not leak in");
  assert.deepEqual(await surfaces([randomUUID()], f.agentId, "all"), []);
  assert.deepEqual(await surfaces([], f.agentId, "all"), []);
});
