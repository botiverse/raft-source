import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { type ServerId, type TaskStatus } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import {
  channelConversionJobs,
  channels,
  jointChannels,
  jointChannelServers,
  serverMembers,
  tasks,
  users,
} from "../db/schema";
import * as channelService from "./channelService";
import { createServer } from "./serverService";
import { resolveTaskChannelSurface } from "./taskChannelSurface";
import * as taskService from "./taskService";
import { seedBoundGuest } from "../test/guestFixture";

/**
 * GET /api/tasks/server used to fan out per channel (access check, surface
 * resolution, tasks query and enrichment for EVERY channel), so a server with
 * hundreds of channels issued >1000 statements per request. The batched read
 * must (a) issue a statement count independent of the channel count and
 * (b) return exactly what the per-channel algorithm returned, across
 * public / private / archived / deleted / joint host / joint participant /
 * hidden joint / canonical-storage / converted-source shapes.
 */

type PgliteLike = {
  query: (...args: unknown[]) => Promise<unknown>;
};

function queryCounter() {
  const client = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = client.query.bind(client);
  const counter = { count: 0 };
  client.query = ((...args: unknown[]) => {
    counter.count += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  return { counter, restore: () => { client.query = originalQuery; } };
}

async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const { counter, restore } = queryCounter();
  try {
    await fn();
    return counter.count;
  } finally {
    restore();
  }
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

/**
 * The pre-batch per-channel algorithm, kept here as the equivalence oracle.
 * The board's candidates are public, private and joint channels (private
 * joined the board with the visibility entry; DMs stay off it), the same for
 * guests.
 */
async function perChannelOracle(serverId: string, statusFilter: TaskStatus | undefined, userId: string) {
  const serverChannels = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      or(eq(channels.type, "channel"), eq(channels.type, "private"), eq(channels.type, "joint")),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.name), asc(channels.id));
  const out: unknown[] = [];
  for (const channel of serverChannels) {
    if (!await channelService.canUserAccessChannel(channel.id, userId, serverId as ServerId)) continue;
    const surface = await resolveTaskChannelSurface(serverId, channel.id);
    if (!surface) continue;
    const rows = await taskService.listTasks(surface.storageChannelId, statusFilter);
    for (const row of taskService.projectTasksToChannel(rows, surface.localChannel)) {
      // The server-wide list intentionally drops the duplicate current-text projection.
      const { taskCurrentProjection: _dropped, ...rest } = row;
      out.push(rest);
    }
  }
  return JSON.parse(JSON.stringify(out)) as Array<{ id: string; channelId: string; taskNumber: number }>;
}

async function walkPages(serverId: string, statusFilter: TaskStatus | undefined, userId: string, limit: number) {
  const items: unknown[] = [];
  let cursor: taskService.ServerTasksPageCursor | taskService.ServerTasksSortedCursor | null = null;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 100, "pagination did not terminate");
    const page = await taskService.listServerTasksPage(serverId, statusFilter, userId, { limit, cursor, detail: "full" });
    assert.notEqual(page, "invalid cursor");
    if (page === "invalid cursor") throw new Error("unreachable");
    items.push(...page.tasks);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return JSON.parse(JSON.stringify(items));
}

async function buildFixture() {
  const db = getDb();
  const owner = await seedUser(`batch-owner-${randomUUID().slice(0, 8)}`);
  const peerOwner = await seedUser(`batch-peer-${randomUUID().slice(0, 8)}`);
  const reader = await seedUser(`batch-reader-${randomUUID().slice(0, 8)}`);
  const guest = await seedUser(`batch-guest-${randomUUID().slice(0, 8)}`);
  const host = await createServer("Batch Host", `batch-host-${randomUUID().slice(0, 8)}`, owner.id);
  const peer = await createServer("Batch Peer", `batch-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  await db.insert(serverMembers).values([
    { serverId: host.id, userId: reader.id, role: "member" },
    { serverId: peer.id, userId: reader.id, role: "member" },
  ]).onConflictDoNothing();
  const create = async (serverId: string, name: string, type: "channel" | "private" | "joint" = "channel") =>
    channelService.createChannel(serverId, name, undefined, type);
  const open = await create(host.id, "b-open");
  const guestOpen = await create(host.id, "a-guest-open");
  await channelService.updateChannel(guestOpen.id, { guestVisible: true });
  const priv = await create(host.id, "c-private", "private");
  const archived = await create(host.id, "d-archived");
  const deleted = await create(host.id, "e-deleted");
  for (const channel of [open, guestOpen, priv, archived, deleted]) await channelService.addHuman(channel.id, owner.id);
  // A guest of a private channel, its one channel (#wg-rbac:#15): its tasks are on the guest's board, as canView allows.
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: priv.id });
  // A guest in a guest-visible public channel that is not its own: nothing of it on its board.
  await channelService.addHuman(guestOpen.id, guest.id);

  // Joint: canonical storage row on the host server (itself a `channel`, so
  // it is a candidate that must be excluded), host + participant projections,
  // a done conversion whose source is the host projection (equivalence set).
  const canonical = await create(host.id, "f-joint-storage");
  const hostJoint = await create(host.id, "g-joint", "joint");
  const peerJoint = await create(peer.id, "g-joint", "joint");
  await channelService.addHuman(hostJoint.id, owner.id);
  await channelService.addHuman(peerJoint.id, peerOwner.id);
  await channelService.addHuman(peerJoint.id, reader.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: host.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostJoint.id, role: "host", joinedByUserId: owner.id },
    { jointChannelId: joint!.id, serverId: peer.id, localChannelId: peerJoint.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
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
  // A joint on the host server nobody but the owner joined: hidden for reader.
  const hiddenJoint = await create(host.id, "h-hidden-joint", "joint");

  await taskService.createTasks(open.id, "user", owner.id, [{ title: "open-1" }, { title: "open-2", description: "body" }, { title: "open-3" }]);
  const { tasks: [guestTask] } = await taskService.createTasks(guestOpen.id, "user", guest.id, [{ title: "guest-1" }]);
  await taskService.createTasks(priv.id, "user", owner.id, [{ title: "private-1" }]);
  await taskService.createTasks(archived.id, "user", owner.id, [{ title: "archived-1" }]);
  await taskService.createTasks(deleted.id, "user", owner.id, [{ title: "deleted-1" }]);
  const { tasks: jointTasks } = await taskService.createTasks(canonical.id, "user", owner.id, [{ title: "joint-historical" }, { title: "joint-fresh" }]);
  const { tasks: [sourceTask] } = await taskService.createTasks(hostJoint.id, "user", owner.id, [{ title: "pre-conversion source row" }]);
  // Keep taskNumbers unique inside one equivalence set so order is total.
  await db.update(tasks).set({ taskNumber: 100 }).where(eq(tasks.id, sourceTask!.id));
  await db.update(tasks).set({ createdAt: new Date("2026-08-19T00:00:00.000Z") }).where(eq(tasks.id, jointTasks[0]!.id));
  await db.update(tasks).set({ createdAt: new Date("2026-08-21T00:00:00.000Z") }).where(eq(tasks.id, jointTasks[1]!.id));

  await db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, guestTask!.id));
  await db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, jointTasks[1]!.id));
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted.id));

  return { owner, peerOwner, reader, guest, host, peer, open, hiddenJoint, hostJoint, peerJoint };
}

test("server task lists equal the per-channel algorithm across channel shapes, legacy and paginated", async ({ db: _db }) => {
  const f = await buildFixture();
  const cases: Array<[string, string]> = [
    [f.host.id, f.owner.id],
    [f.host.id, f.reader.id],
    [f.host.id, f.guest.id],
    [f.peer.id, f.peerOwner.id],
    [f.peer.id, f.reader.id],
  ];
  let sawParticipantReadOnly = false;
  let sawJointProjection = false;
  for (const [serverId, userId] of cases) {
    for (const status of [undefined, "todo", "in_progress"] as const) {
      const expected = await perChannelOracle(serverId, status, userId);
      const actual = JSON.parse(JSON.stringify(await taskService.listServerTasks(serverId, status, userId)));
      assert.deepEqual(actual, expected, `legacy ${serverId === f.host.id ? "host" : "peer"} ${userId} ${status}`);
      for (const limit of [1, 2, 50]) {
        assert.deepEqual(await walkPages(serverId, status, userId, limit), expected, `pages limit=${limit} ${status}`);
      }
      sawParticipantReadOnly ||= expected.some((task) => (task as { readOnlyReason?: string | null }).readOnlyReason === "historical_joint_task");
      sawJointProjection ||= expected.some((task) => task.channelId === f.peerJoint.id);
    }
  }
  assert.ok(sawParticipantReadOnly, "fixture must exercise the participant historical cutoff");
  assert.ok(sawJointProjection, "fixture must exercise joint projection to the local channel");
  const otherPrivate = await channelService.createChannel(f.host.id, "z-private-no-guest", undefined, "private");
  await channelService.addHuman(otherPrivate.id, f.owner.id);
  await taskService.createTasks(otherPrivate.id, "user", f.owner.id, [{ title: "private-no-guest-1" }]);
  const guestTitles = (await taskService.listServerTasks(f.host.id, undefined, f.guest.id)).map((task) => task.title);
  assert.deepEqual(guestTitles, ["private-1"], "a guest's board lists only the tasks of its one channel, not of a guest-visible one it is in nor of a private channel it is not in");

  // Cursor semantics: a hidden joint is not a valid position; a visible one is.
  const hidden = await taskService.listServerTasksPage(f.host.id, undefined, f.reader.id, {
    limit: 1, cursor: { channelId: f.hiddenJoint.id, taskNumber: 1 }, detail: "summary",
  });
  assert.equal(hidden, "invalid cursor");
  const unknown = await taskService.listServerTasksPage(f.host.id, undefined, f.reader.id, {
    limit: 1, cursor: { channelId: randomUUID(), taskNumber: 1 }, detail: "summary",
  });
  assert.equal(unknown, "invalid cursor");
  const resumed = await taskService.listServerTasksPage(f.host.id, undefined, f.reader.id, {
    limit: 1, cursor: { channelId: f.open.id, taskNumber: 1 }, detail: "summary",
  });
  assert.notEqual(resumed, "invalid cursor");
  if (resumed !== "invalid cursor") assert.equal(resumed.tasks[0]?.title, "open-2");
});

test("server task lists issue a statement count independent of the channel count", async ({ db: _db }) => {
  const f = await buildFixture();
  const measure = async () => ({
    legacy: await countQueries(() => taskService.listServerTasks(f.host.id, undefined, f.owner.id)),
    page: await countQueries(() => taskService.listServerTasksPage(f.host.id, "todo", f.owner.id, { limit: 50, cursor: null, detail: "summary" })),
    // The sorted walk merges every channel's top rows in one statement too.
    sorted: await countQueries(() => taskService.listServerTasksPage(f.host.id, "todo", f.owner.id, { limit: 50, cursor: null, detail: "summary", sort: "activity" })),
  });
  const before = await measure();
  assert.ok(before.legacy > 0, "the counting seam must observe queries");

  for (let i = 0; i < 12; i++) {
    const channel = await channelService.createChannel(f.host.id, `z-extra-${i}`);
    await channelService.addHuman(channel.id, f.owner.id);
    await taskService.createTasks(channel.id, "user", f.owner.id, [{ title: `extra-${i}` }]);
    const joint = await channelService.createChannel(f.host.id, `z-extra-joint-${i}`, undefined, "joint");
    await channelService.addHuman(joint.id, f.owner.id);
  }
  const after = await measure();
  assert.deepEqual(after, before, "adding channels must not add statements");
});
