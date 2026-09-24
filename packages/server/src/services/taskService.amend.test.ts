import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  InMemoryFailpointRegistry,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  jointChannels,
  jointChannelServers,
  serverMembers,
  taskEvents,
  tasks,
  users,
} from "../db/schema.js";
import { addHuman, createChannel } from "./channelService.js";
import { withProjectedTaskFacts } from "./messageTaskProjection.js";
import { createServer } from "./serverService.js";
import * as taskService from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID()}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

test("task amendment updates the queryable projection and appends an immutable before/after event", async ({ app }) => {
  const creator = await seedUser("task-amend-creator");
  const server = await createServer("Task Amend", `task-amend-${randomUUID()}`, creator.id);
  const channel = await createChannel(server.id, "task-amend");
  await addHuman(channel.id, creator.id);
  const { tasks: [created], hostMessages: [hostMessage] } = await taskService.createTasks(
    channel.id,
    "user",
    creator.id,
    [{ title: "owner pending", description: "initial acceptance" }],
  );
  const [initialProjection] = await withProjectedTaskFacts([hostMessage]);
  assert.equal(initialProjection.taskCurrentProjection?.superseded, false);
  assert.equal(initialProjection.taskCurrentProjection?.title, "owner pending");
  const [initialBoardTask] = await taskService.listTasks(channel.id);
  assert.equal(initialBoardTask.taskCurrentProjection?.superseded, false);

  const claim = await taskService.claimTask(created.id, "user", creator.id);
  assert.notEqual(typeof claim, "string", String(claim));
  if (typeof claim === "string") return;
  const [claimedBoardTask] = await taskService.listTasks(channel.id);
  assert.ok(claimedBoardTask.revision > created.revision);
  assert.equal(
    claimedBoardTask.taskCurrentProjection?.superseded,
    false,
    "claim/status revision bumps must not pretend task text was amended",
  );

  const amendment = await taskService.amendTask(created.id, {
    title: "spec=@Maggie / impl=@Huaihuai",
    description: "field + rendering assertions; two opposing mutation teeth",
  }, "user", creator.id);
  assert.notEqual(typeof amendment, "string", String(amendment));
  if (typeof amendment === "string") return;

  assert.equal(amendment.row.title, "spec=@Maggie / impl=@Huaihuai");
  assert.equal(amendment.row.description, "field + rendering assertions; two opposing mutation teeth");
  assert.equal(amendment.row.revision, claim.row.revision + 1);
  assert.equal(amendment.event.eventType, "amended");
  assert.deepEqual(amendment.event.payload, {
    revision: claim.row.revision + 1,
    changes: {
      title: { from: "owner pending", to: "spec=@Maggie / impl=@Huaihuai" },
      description: {
        from: "initial acceptance",
        to: "field + rendering assertions; two opposing mutation teeth",
      },
    },
  });

  const history = await taskService.listTaskHistory(created.id);
  assert.notEqual(typeof history, "string", String(history));
  if (typeof history === "string") return;
  assert.deepEqual(history.map((event) => event.eventType), [
    "created",
    "assignee_changed",
    "status_changed",
    "amended",
  ]);
  assert.ok(history[0]!.seq < history.at(-1)!.seq, "event seq must provide a stable append order");
  assert.equal(history.at(-1)!.actorName, creator.name);

  const board = await taskService.listTasks(channel.id);
  assert.equal(board.length, 1);
  assert.equal(board[0]!.title, amendment.row.title);
  assert.equal(board[0]!.description, amendment.row.description);
  assert.equal(board[0]!.revision, amendment.row.revision);
  assert.deepEqual(board[0]!.taskCurrentProjection, {
    title: amendment.row.title,
    description: amendment.row.description,
    revision: amendment.row.revision,
    superseded: true,
    amendedAt: amendment.event.createdAt,
    amendedByType: "user",
    amendedByName: creator.name,
    source: "tasks_current_projection",
  });

  const secondAmendment = await taskService.amendTask(created.id, {
    title: "final current title after a second supersede",
  }, "user", creator.id);
  assert.notEqual(typeof secondAmendment, "string", String(secondAmendment));
  if (typeof secondAmendment === "string") return;

  const [projected] = await withProjectedTaskFacts([hostMessage]);
  assert.equal(projected.content, "owner pending", "immutable host message bytes must remain original");
  assert.deepEqual(projected.taskCurrentProjection, {
    title: "final current title after a second supersede",
    description: "field + rendering assertions; two opposing mutation teeth",
    revision: secondAmendment.row.revision,
    superseded: true,
    amendedAt: secondAmendment.event.createdAt,
    amendedByType: "user",
    amendedByName: creator.name,
    source: "tasks_current_projection",
  });
  const [boardAfterSecondAmendment] = await taskService.listTasks(channel.id);
  assert.deepEqual(boardAfterSecondAmendment.taskCurrentProjection, projected.taskCurrentProjection);

  const [persisted] = await getDb().select().from(tasks).where(eq(tasks.id, created.id));
  assert.equal(persisted.title, secondAmendment.row.title);
  assert.equal(persisted.description, secondAmendment.row.description);
  const amendedEvents = await getDb().select().from(taskEvents)
    .where(eq(taskEvents.taskId, created.id));
  assert.equal(amendedEvents.filter((event) => event.eventType === "amended").length, 2);
});

test("joint task amendments authorize members through live local projections while updating the canonical board", async ({ app }) => {
  const host = await seedUser("task-amend-joint-host");
  const peer = await seedUser("task-amend-joint-peer");
  const outsider = await seedUser("task-amend-joint-outsider");
  const hostServer = await createServer("Task Amend Joint Host", `task-amend-joint-host-${randomUUID()}`, host.id);
  const peerServer = await createServer("Task Amend Joint Peer", `task-amend-joint-peer-${randomUUID()}`, peer.id);
  const canonical = await createChannel(hostServer.id, "task-amend-joint-storage");
  const hostProjection = await createChannel(hostServer.id, "task-amend-joint", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "task-amend-joint", undefined, "joint");
  await addHuman(hostProjection.id, host.id);
  await addHuman(peerProjection.id, peer.id);
  await getDb().insert(serverMembers).values({
    serverId: hostServer.id,
    userId: outsider.id,
    role: "admin",
  });
  const [joint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: host.id,
  }).returning();
  await getDb().insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: host.id,
    },
    {
      jointChannelId: joint.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peer.id,
    },
  ]);
  const { tasks: [created] } = await taskService.createTasks(
    canonical.id,
    "user",
    host.id,
    [{ title: "narrow parent contract", description: "phase one only" }],
  );

  const amendment = await taskService.amendTask(
    created.id,
    { title: "all bounded phases", description: "phase one + phase two" },
    "user",
    peer.id,
  );
  assert.notEqual(typeof amendment, "string", String(amendment));
  assert.equal(
    await taskService.amendTask(created.id, { title: "server-admin bypass" }, "user", outsider.id),
    "only current channel members with post access can amend the card",
  );

  const board = await taskService.listTasks(canonical.id);
  assert.equal(board.length, 1);
  assert.equal(board[0]!.title, "all bounded phases");
  assert.equal(board[0]!.description, "phase one + phase two");
  assert.equal(board[0]!.revision, created.revision + 1);
});

test("task amendment authority follows live channel membership and races fail closed without false audit events", async ({ app }) => {

  try {
    const creator = await seedUser("task-amend-authority-creator");
    const assignee = await seedUser("task-amend-authority-assignee");
    const criteriaAuthor = await seedUser("task-amend-authority-criteria-author");
    const departingMember = await seedUser("task-amend-authority-departing-member");
    const outsider = await seedUser("task-amend-authority-outsider");
    const server = await createServer("Task Amend Authority", `task-amend-authority-${randomUUID()}`, creator.id);
    const channel = await createChannel(server.id, "task-amend-authority");
    await getDb().insert(serverMembers).values([
      { serverId: server.id, userId: assignee.id, role: "member" },
      { serverId: server.id, userId: criteriaAuthor.id, role: "member" },
      { serverId: server.id, userId: departingMember.id, role: "member" },
      { serverId: server.id, userId: outsider.id, role: "admin" },
    ]);
    for (const user of [creator, assignee, criteriaAuthor, departingMember]) await addHuman(channel.id, user.id);
    const { tasks: [created] } = await taskService.createTasks(
      channel.id,
      "user",
      creator.id,
      [{ title: "original" }],
    );

    assert.equal(
      await taskService.amendTask(created.id, { title: "outsider rewrite" }, "user", outsider.id),
      "only current channel members with post access can amend the card",
    );

    const criteriaAmend = await taskService.amendTask(
      created.id,
      { description: "reviewer-authored acceptance criteria" },
      "user",
      criteriaAuthor.id,
    );
    assert.notEqual(typeof criteriaAmend, "string", String(criteriaAmend));

    assert.notEqual(typeof await taskService.claimTask(created.id, "user", assignee.id), "string");
    const assigneeAmend = await taskService.amendTask(created.id, { title: "assignee current title" }, "user", assignee.id);
    assert.notEqual(typeof assigneeAmend, "string", String(assigneeAmend));

    const membershipRegistry = new InMemoryFailpointRegistry({
      sleep: async () => {
        await getDb().delete(channelHumans).where(and(
          eq(channelHumans.channelId, channel.id),
          eq(channelHumans.userId, departingMember.id),
        ));
      },
    });
    membershipRegistry.configure("server.task.amend.afterAuthorizationRead", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(membershipRegistry);
    let membershipRaced: Awaited<ReturnType<typeof taskService.amendTask>>;
    try {
      membershipRaced = await taskService.amendTask(
        created.id,
        { title: "departed member overwrite" },
        "user",
        departingMember.id,
      );
    } finally {
      __resetFailpointsForTests();
    }
    assert.equal(membershipRaced, "only current channel members with post access can amend the card");

    const registry = new InMemoryFailpointRegistry({
      sleep: async () => {
        await getDb().update(tasks).set({
          title: "concurrent current title",
          revision: sql`${tasks.revision} + 1`,
        }).where(eq(tasks.id, created.id));
      },
    });
    registry.configure("server.task.amend.afterAuthorizationRead", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(registry);
    let raced: Awaited<ReturnType<typeof taskService.amendTask>>;
    try {
      raced = await taskService.amendTask(created.id, { title: "stale creator overwrite" }, "user", creator.id);
    } finally {
      __resetFailpointsForTests();
    }
    assert.equal(raced, "task changed concurrently; read the current card and retry");

    const [persisted] = await getDb().select().from(tasks).where(eq(tasks.id, created.id));
    assert.equal(persisted.title, "concurrent current title");
    const events = await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, created.id));
    assert.equal(events.filter((event) => event.eventType === "amended").length, 2);
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});
